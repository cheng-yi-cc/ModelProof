// Minimal OpenAI-compatible chat-completions client for relay auditing.
// Zero dependencies (Node >= 18 native fetch). Handles the messy reality of
// relays: alternate base paths, unknown-field rejections, tiny max_tokens
// limits, mandatory streaming ("Stream must be set to true"), 429/5xx backoff,
// hidden reasoning traces.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeBaseUrl(rawUrl) {
  let u = String(rawUrl).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  return u;
}

// Candidate API roots, in preference order.
export function apiBaseCandidates(rawUrl) {
  const u = normalizeBaseUrl(rawUrl);
  if (/\/v\d+$/.test(u)) return [u]; // user gave an explicit versioned root
  if (/\/v\d+\/chat\/completions$/.test(u)) {
    return [u.replace(/\/chat\/completions$/, '')];
  }
  return [`${u}/v1`, u];
}

function extractErrMessage(status, bodyText) {
  const head = bodyText.slice(0, 300);
  try {
    const j = JSON.parse(bodyText);
    if (j?.error?.message) return `HTTP ${status}: ${j.error.message}`;
  } catch { /* not json */ }
  return `HTTP ${status}: ${head}`;
}

export class RelayClient {
  constructor({ baseUrl, apiKey, timeoutMs = 60000 }) {
    this.bases = apiBaseCandidates(baseUrl); // first that works wins
    this.activeBase = null;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.forceStream = false; // latched once an endpoint demands streaming
  }

  headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async #raw(path, { method = 'GET', body } = {}) {
    const base = this.activeBase ?? this.bases[0];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(`${base}${path}`, {
        method,
        signal: ctrl.signal,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // GET /models — tries each candidate base until one answers.
  async listModels() {
    let lastErr = '';
    for (const base of this.bases) {
      this.activeBase = base;
      try {
        const r = await this.#raw('/models');
        const text = await r.text();
        if (r.ok) {
          const j = JSON.parse(text);
          const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
          return { ok: true, models: arr.map((m) => m.id).filter(Boolean), base };
        }
        lastErr = extractErrMessage(r.status, text);
      } catch (e) {
        lastErr = e.name === 'AbortError' ? '连接超时' : String(e.message || e);
      }
    }
    return { ok: false, error: lastErr };
  }

  // One probe completion. Retries transient failures; adapts body for strict
  // endpoints. Returns {ok, raw, finishReason, reasoningLen, modelReported,
  // usage, latencyMs} or {ok:false, error, retryable}.
  async chat({ model, system, user, maxTokens = 16 }) {
    const commonBody = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 1,
      max_tokens: maxTokens,
    };

    let override = {};
    let includeReasoningFlag = true;
    const t0 = Date.now();

    for (let attempt = 0; ; attempt++) {
      const withReasoning = includeReasoningFlag ? { reasoning: { enabled: false } } : {};
      const stream = this.forceStream;
      const body = { ...commonBody, ...withReasoning, ...override, ...(stream ? { stream: true } : {}) };

      let res;
      try {
        res = await this.#raw('/chat/completions', { method: 'POST', body });
      } catch (e) {
        if (attempt < 4) {
          await sleep(backoff(attempt));
          continue;
        }
        return { ok: false, error: e.name === 'AbortError' ? '请求超时' : String(e.message || e), retryable: true };
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const msg = extractErrMessage(res.status, errText);
        const lower = msg.toLowerCase();
        // Strict endpoints reject unknown fields -> drop the OpenRouter-only flag.
        if (includeReasoningFlag && res.status === 400 &&
            /(reasoning|unrecognized|unknown|unexpected|invalid.*(field|parameter)|额外|未知)/.test(lower)) {
          includeReasoningFlag = false;
          continue;
        }
        // Endpoint demands streaming -> latch and retry.
        if (!this.forceStream && /stream/i.test(msg) && /(must|require|only|需要|必须)/i.test(lower)) {
          this.forceStream = true;
          continue;
        }
        // Some endpoints enforce a higher minimum max_tokens.
        if (override.max_tokens === undefined && res.status === 400 &&
            /(max_tokens|max tokens|too small|at least|minimum)/.test(lower)) {
          override.max_tokens = 64;
          continue;
        }
        const retryable = res.status === 429 || res.status >= 500 || res.status === 408 || res.status === 402;
        if (retryable && attempt < 4) {
          await sleep(backoff(attempt));
          continue;
        }
        return { ok: false, error: msg, status: res.status, retryable };
      }

      let parsed;
      try {
        parsed = stream ? await parseSseCompletion(res) : JSON.parse(await res.text());
      } catch (e) {
        if (attempt < 4) { await sleep(backoff(attempt)); continue; }
        return { ok: false, error: `响应解析失败: ${String(e.message || e)}`, retryable: false };
      }

      if (parsed.error) {
        const code = parsed.error.code ?? res.status;
        const retryable = [429, 502, 503].includes(code);
        if (retryable && attempt < 4) { await sleep(backoff(attempt)); continue; }
        return { ok: false, error: String(parsed.error.message ?? JSON.stringify(parsed.error)).slice(0, 300), retryable };
      }

      const choice = parsed.choices?.[0];
      const message = choice?.message ?? null;
      // Streaming chunks carry deltas; parseSseCompletion merges them into a
      // message-shaped object, so both paths converge here.
      const content = message?.content ?? choice?.delta?.content ?? null;
      const reasoning = message?.reasoning ?? message?.reasoning_content ?? null;
      return {
        ok: true,
        raw: content,
        finishReason: choice?.finish_reason ?? 'stop',
        reasoningLen: reasoning ? String(reasoning).length : 0,
        modelReported: parsed.model ?? null,
        usage: parsed.usage
          ? {
              promptTokens: parsed.usage.prompt_tokens ?? null,
              completionTokens: parsed.usage.completion_tokens ?? null,
              cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? null,
            }
          : null,
        latencyMs: Date.now() - t0,
      };
    }
  }
}

// Aggregate an OpenAI-style SSE completion stream into a non-streaming-shaped
// response: {choices:[{message:{content},finish_reason}], model, usage}.
async function parseSseCompletion(res) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finish = null;
  let modelId = null;
  let usage = null;
  let sawData = false;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      sawData = true;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue; // tolerate malformed keepalives
      }
      if (ev.error) throw Object.assign(new Error('sse'), { parsedError: ev.error });
      if (ev.model) modelId = ev.model;
      if (ev.usage) usage = ev.usage;
      const ch = ev.choices?.[0];
      if (!ch) continue;
      const delta = ch.delta ?? {};
      if (typeof delta.content === 'string') content += delta.content;
      // side-channel CoT deltas (deepseek-style reasoning_content, OpenAI-style reasoning)
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  if (!sawData) throw new Error('空 SSE 流');

  return {
    model: modelId,
    choices: [{ message: { role: 'assistant', content, reasoning: reasoning || undefined }, finish_reason: finish }],
    usage,
  };
}

function backoff(attempt) {
  return Math.min(30000, 1500 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
}
