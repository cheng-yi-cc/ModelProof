// AuditRunner — probes one claimed model on a relay endpoint with the PAMELA
// study-A battery and builds the empirical single-token answer fingerprint.
import { RelayClient } from './client.js';
import { buildCells, systemPrompt, taskById } from './protocol.js';
import { normalizeAnswer } from './normalize.js';

// Deterministic PRNG so an audit's request order is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seedStr) {
  const rand = mulberry32(
    [...seedStr].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761), 0x9e3779b9) >>> 0
  );
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function pool(items, limit, worker, shouldStop) {
  const queue = items.map((item, i) => ({ item, i }));
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (cursor < queue.length) {
      if (shouldStop()) return;
      const job = queue[cursor++];
      await worker(job.item, job.i);
    }
  });
  await Promise.all(runners);
}

export class AuditRunner {
  /**
   * @param opts {baseUrl, apiKey, model, reps=12, concurrency=6,
   *              langs?, taskIds?, seed?, reasoningPolicy='strict'|'allow',
   *              onEvent?(evt)}
   *  reasoningPolicy:
   *    'strict' — paper-faithful: any hidden-CoT response is not a direct
   *               single-pass sample and is excluded (may yield 样本不足).
   *    'allow'  — audit mode: keep answers whose final content is clean, but
   *               the traces stay visible in diagnostics.
   */
  constructor(opts) {
    this.opts = { reps: 12, concurrency: 6, seed: String(Date.now()), reasoningPolicy: 'strict', ...opts };
    this.client = new RelayClient({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
    this.cancelled = false;
    this.cells = buildCells({ langs: opts.langs, taskIds: opts.taskIds });
    const total = this.cells.length * this.opts.reps;
    this.progress = { done: 0, ok: 0, failed: 0, total };
    this.counts = new Map(); // cellKey -> Map(answer->count)
    this.diagnostics = {
      modelReportedMismatch: 0,
      cachedTokenResponses: 0,
      reasoningTraces: 0,
      truncatedAnswers: 0,
      answerClasses: { valid: 0, invalid: 0, refusal: 0, empty: 0 },
      latencies: [],
      errorSamples: [],
    };
  }

  cancel() { this.cancelled = true; }

  async run() {
    const { model, reps, concurrency, seed, onEvent } = this.opts;
    // Warm-up probe: lets the client latch protocol adaptations (mandatory
    // streaming, unknown-field drops, max_tokens minimums) so concurrent waves
    // don't burn a batch of paid requests on 400s.
    this.progress.total += 1;
    const task0 = taskById(this.cells[0].taskId);
    await this.#oneRequest(model, this.cells[0], { system: systemPrompt(this.cells[0].lang), user: task0.prompts[this.cells[0].lang] });

    const jobs = [];
    for (const cell of this.cells) {
      for (let rep = 0; rep < reps; rep++) jobs.push({ cell, rep });
    }
    const ordered = seededShuffle(jobs, `${seed}|${model}`);

    await pool(
      ordered,
      concurrency,
      async (job) => {
        if (this.cancelled) return;
        await this.#oneRequest(model, job.cell);
        this.progress.done++;
        onEvent?.({
          type: 'progress',
          done: this.progress.done,
          total: this.progress.total,
          ok: this.progress.ok,
          failed: this.progress.failed,
          classes: { ...this.diagnostics.answerClasses },
        });
      },
      () => this.cancelled
    );

    return {
      cancelled: this.cancelled,
      requestedModel: model,
      fingerprint: this.#fingerprint(),
      diagnostics: this.#diagnostics(),
      progress: this.progress,
    };
  }

  async #oneRequest(model, cell) {
    const task = taskById(cell.taskId);
    let r;
    try {
      r = await this.client.chat({
        model,
        system: systemPrompt(cell.lang),
        user: task.prompts[cell.lang],
      });
    } catch (e) {
      r = { ok: false, error: String(e.message || e), retryable: true };
    }
    const key = `${cell.taskId}|${cell.lang}`;
    const d = this.diagnostics;

    if (!r.ok) {
      this.progress.failed++;
      if (d.errorSamples.length < 8 && !d.errorSamples.includes(r.error)) d.errorSamples.push(r.error);
      return;
    }
    this.progress.ok++;
    d.latencies.push(r.latencyMs);

    if (r.modelReported && r.modelReported !== model) {
      d.modelReportedMismatch++;
      d.modelReportedSample ??= r.modelReported;
    }
    if ((r.usage?.cachedTokens ?? 0) > 0) d.cachedTokenResponses++;
    if (r.reasoningLen > 0) d.reasoningTraces++;
    if (r.finishReason === 'length') d.truncatedAnswers++;

    // Hidden-reasoning endpoints: under 'strict' the answer is not a direct
    // single-pass sample and must not enter the print (paper's screen). Under
    // 'allow' a clean final content still counts, traces stay in diagnostics.
    const allowReasoning = this.opts.reasoningPolicy === 'allow' && r.raw != null && String(r.raw).trim() !== '';
    const norm = r.reasoningLen > 0 && !allowReasoning
      ? { normalized: null, answerClass: 'post_reasoning' }
      : normalizeAnswer(r.raw, task, cell.lang);
    d.answerClasses[norm.answerClass] = (d.answerClasses[norm.answerClass] ?? 0) + 1;

    if (norm.answerClass === 'valid') {
      if (!this.counts.has(key)) this.counts.set(key, new Map());
      const m = this.counts.get(key);
      m.set(norm.normalized, (m.get(norm.normalized) ?? 0) + 1);
    }
  }

  #fingerprint() {
    const cells = {};
    for (const [key, m] of this.counts) {
      let n = 0;
      for (const v of m.values()) n += v;
      const p = {};
      for (const [ans, c] of m) p[ans] = c / n;
      cells[key] = { n, p };
    }
    return cells;
  }

  #diagnostics() {
    const d = this.diagnostics;
    const lats = [...d.latencies].sort((a, b) => a - b);
    // Cache/determinism screen: highest identical-answer share among cells with >=8 samples
    let maxModeShare = 0;
    let maxModeCell = null;
    for (const [key, m] of this.counts) {
      let n = 0;
      for (const v of m.values()) n += v;
      if (n < 8) continue;
      let mode = 0;
      for (const v of m.values()) mode = Math.max(mode, v);
      const share = mode / n;
      if (share > maxModeShare) { maxModeShare = share; maxModeCell = key; }
    }
    return {
      requestsOk: this.progress.ok,
      requestsFailed: this.progress.failed,
      answerClasses: { ...d.answerClasses },
      modelReportedMismatch: d.modelReportedMismatch,
      modelReportedSample: d.modelReportedSample ?? null,
      cachedTokenResponses: d.cachedTokenResponses,
      reasoningTraces: d.reasoningTraces,
      truncatedAnswers: d.truncatedAnswers,
      medianLatencyMs: lats.length ? lats[Math.floor(lats.length / 2)] : null,
      p95LatencyMs: lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] : null,
      cacheSuspect: maxModeShare >= 0.85 ? { cell: maxModeCell, share: +maxModeShare.toFixed(3) } : null,
      errorSamples: [...d.errorSamples],
    };
  }
}
