// Fingerprint collector engine — single source of truth for building a
// reference-grade model fingerprint. Shared by the GUI collector page and
// scripts/collect-fingerprints.mjs, so both are guaranteed to follow the
// exact PAMELA Study-A protocol (paper: arXiv:2607.10252):
//   - byte-exact prompts (SHA-256 verified in protocol.js)
//   - temperature = 1, max_tokens = 16, one cheap single-token question
//   - 40 cells (10 tasks x 4 languages), shuffled request order,
//     per-cell answer distributions identical in shape to the reference db.
// Zero third-party dependencies.

import { buildCells, systemPrompt, taskById, TASKS, LANGS } from './protocol.js';
import { normalizeAnswer } from './normalize.js';

// Rough vendor grouping for library display; the model prefix on OpenRouter
// (author/slug) is the strongest signal.
export function inferFamily(modelId) {
  const m = String(modelId).toLowerCase();
  if (m.includes('gpt') || m.includes('openai') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'openai';
  if (m.includes('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.includes('gemini') || m.includes('gemma') || m.includes('google')) return 'google';
  if (m.includes('llama') || m.startsWith('meta')) return 'llama';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('glm') || m.includes('z-ai')) return 'glm';
  if (m.includes('mistral') || m.includes('ministral')) return 'mistral';
  if (m.includes('grok') || m.startsWith('x-ai')) return 'xai';
  if (m.includes('kimi') || m.includes('moonshot')) return 'moonshot';
  if (m.includes('minimax')) return 'minimax';
  if (m.includes('grok')) return 'xai';
  if (m.includes('perplexity') || m.includes('sonar')) return 'perplexity';
  if (m.includes('command') || m.includes('cohere')) return 'cohere';
  if (m.includes('granite') || m.includes('ibm')) return 'granite';
  return 'other';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FingerprintCollector {
  /**
   * @param {object} opts
   * @param {import('./client.js').RelayClient} opts.client
   * @param {string} opts.modelId  e.g. "openai/gpt-5.6-luna"
   * @param {number} opts.reps  samples per cell (>=5)
   * @param {number} opts.concurrency
   * @param {string|null} opts.providerName  OpenRouter provider to pin (order + no fallbacks)
   * @param {string[]|null} opts.langs  subset of LANGS (default all 4)
   */
  constructor({ client, modelId, reps = 30, concurrency = 6, providerName = null, langs = null }) {
    this.client = client;
    this.modelId = modelId;
    this.reps = Math.max(5, Math.min(60, reps | 0 || 30));
    this.concurrency = Math.max(1, Math.min(16, concurrency | 0 || 6));
    this.providerName = providerName || null;
    this.langs = langs && langs.length ? langs : LANGS;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  #buildRequests() {
    const cells = buildCells({ langs: this.langs });
    const requests = [];
    for (const cell of cells) {
      const task = taskById(cell.taskId);
      const system = systemPrompt(cell.lang);
      const user = task.prompts[cell.lang];
      for (let rep = 0; rep < this.reps; rep++) {
        requests.push({ taskId: cell.taskId, lang: cell.lang, cellKey: `${cell.taskId}|${cell.lang}`, task, system, user });
      }
    }
    // Fisher-Yates shuffle: spread load across tasks/langs evenly.
    for (let i = requests.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [requests[i], requests[j]] = [requests[j], requests[i]];
    }
    return { cells, requests };
  }

  /**
   * @param {(evt: object) => void} onEvent  progress callbacks, throttled by caller
   * @returns {Promise<{cancelled: boolean, fingerprint: object, stats: object}>}
   */
  async run(onEvent = () => {}) {
    const emit = (evt) => {
      if (!this.cancelled) onEvent(evt);
    };
    const { cells, requests } = this.#buildRequests();
    const total = requests.length;

    const cellResults = {};
    for (const c of cells) {
      cellResults[`${c.taskId}|${c.lang}`] = { valid: 0, invalid: 0, refusal: 0, empty: 0, failed: 0, counts: {} };
    }
    const snapshot = () => {
      const cellsOut = {};
      let valid = 0;
      for (const [k, r] of Object.entries(cellResults)) {
        cellsOut[k] = r.valid;
        valid += r.valid;
      }
      return { cells: cellsOut, valid };
    };

    const stats = { ok: 0, failed: 0, invalid: 0, refusal: 0, empty: 0, startedUtc: new Date().toISOString() };
    const startTime = Date.now();
    let done = 0;
    let cursor = 0;
    let active = 0;

    await new Promise((resolveAll) => {
      let cancelWatch = null;
      let timeoutWatch = null;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (cancelWatch) clearInterval(cancelWatch);
        if (timeoutWatch) clearTimeout(timeoutWatch);
        resolveAll();
      };

      const launch = () => {
        while (!this.cancelled && cursor < requests.length && active < this.concurrency) {
          const req = requests[cursor++];
          active++;
          this.client
            .chat({
              model: this.modelId,
              system: req.system,
              user: req.user,
              maxTokens: 16,
              provider: this.providerName ? { order: [this.providerName], allow_fallbacks: false } : undefined,
            })
            .then((res) => {
              const st = cellResults[req.cellKey];
              if (!res.ok) {
                stats.failed++;
                st.failed++;
                if (res.isQuotaExceeded) {
                  this.quotaExceeded = true;
                  this.quotaError = res.error;
                  this.cancel();
                }
              } else {
                stats.ok++;
                const norm = normalizeAnswer(res.raw, req.task, req.lang);
                if (norm.answerClass === 'valid' && norm.normalized != null) {
                  st.valid++;
                  st.counts[norm.normalized] = (st.counts[norm.normalized] || 0) + 1;
                } else if (norm.answerClass === 'refusal') {
                  stats.refusal++;
                  st.refusal++;
                } else if (norm.answerClass === 'invalid') {
                  stats.invalid++;
                  st.invalid++;
                } else {
                  stats.empty++;
                  st.empty++;
                }
              }
            })
            .catch(() => {
              stats.failed++;
              cellResults[req.cellKey].failed++;
            })
            .finally(() => {
              active--;
              done++;
              if (done % 10 === 0 || done === total || this.cancelled) {
                const s = snapshot();
                emit({ type: 'progress', done, total, ...stats, valid: s.valid, cellValid: s.cells });
              }
              if (this.cancelled) {
                if (active === 0) finish();
              } else if (cursor < requests.length) {
                launch();
              } else if (active === 0) {
                finish();
              }
            });
        }
        if (cursor >= requests.length && active === 0) finish();
      };
      launch();
      // allow cancel to resolve even with zero requests
      if (requests.length === 0) finish();
      cancelWatch = setInterval(() => {
        if (this.cancelled) {
          finish();
        }
      }, 250);
      cancelWatch.unref?.();
      timeoutWatch = setTimeout(() => finish(), 1000 * 60 * 60);
      timeoutWatch.unref?.();
    });

    // Build distributions in the exact reference-db shape.
    const fingerprint = {};
    let totalValid = 0;
    let sufficientCells = 0;
    for (const [cellKey, r] of Object.entries(cellResults)) {
      const n = r.valid;
      totalValid += n;
      if (n >= 10) sufficientCells++;
      const p = {};
      if (n > 0) {
        for (const [ans, count] of Object.entries(r.counts)) p[ans] = Math.round((count / n) * 10000) / 10000;
      }
      fingerprint[cellKey] = { n, p };
    }

    return {
      cancelled: this.cancelled,
      quotaExceeded: Boolean(this.quotaExceeded),
      quotaError: this.quotaError || null,
      fingerprint,
      stats: {
        ...stats,
        totalRequests: total,
        completedRequests: done,
        totalValid,
        sufficientCells,
        cellCount: cells.length,
        reps: this.reps,
        elapsedMs: Date.now() - startTime,
        finishedUtc: new Date().toISOString(),
      },
    };
  }
}
