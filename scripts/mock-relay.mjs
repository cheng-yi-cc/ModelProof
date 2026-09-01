// Mock relay server — simulates an OpenAI-compatible 中转站 for offline demos
// and end-to-end tests. It "claims" one model but actually serves answers
// sampled from another model's published PAMELA reference fingerprint, i.e. a
// synthetic 注水 (model substitution) you can point the app at risk-free.
//
// CLI:
//   node scripts/mock-relay.mjs --port 8377 --claim openai/gpt-4o-mini --serve z-ai/glm-4.5-air
//   node scripts/mock-relay.mjs --honest openai/gpt-4o-mini     # serves what it claims
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refDb = JSON.parse(
  readFileSync(path.join(ROOT, 'assets', 'reference-fingerprints.json'), 'utf8')
);
const prompts = JSON.parse(
  readFileSync(path.join(ROOT, 'vendor', 'pamela', 'prompts.json'), 'utf8')
);

// prompt text -> {taskId, lang}
const cellByPrompt = new Map();
for (const task of prompts.tasks) {
  for (const [lang, text] of Object.entries(task.prompts)) {
    cellByPrompt.set(text.trim(), { taskId: task.id, lang });
  }
}

function sampleFrom(dist) {
  let r = Math.random();
  for (const [ans, p] of Object.entries(dist)) {
    r -= p;
    if (r <= 0) return ans;
  }
  return Object.keys(dist)[0];
}

export function createMockRelay({ port = 0, claimModel, serveModel, latencyMs = 25, requireStream = false, emitReasoning = false } = {}) {
  if (!refDb.models[serveModel]) throw new Error(`参考库中没有 ${serveModel}`);
  const server = createServer((req, res) => {
    const respond = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const finish = (code, obj) => setTimeout(() => respond(code, obj), latencyMs);

    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      return finish(200, { object: 'list', data: [{ id: claimModel, object: 'model' }] });
    }
    if (req.method === 'POST' && /\/chat\/completions$/.test(req.url)) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { return finish(400, { error: { message: 'bad json' } }); }
        const sys = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
        const usr = parsed.messages?.find((m) => m.role === 'user')?.content ?? '';

        // identify the cell by matching system+user against the protocol texts
        let lang = null;
        for (const [l, text] of Object.entries(prompts.system_prompts)) {
          if (String(sys).trim() === text.trim()) { lang = l; break; }
        }
        const cell = cellByPrompt.get(String(usr).trim());
        if (!lang || !cell) return finish(400, { error: { message: 'mock: unknown probe' } });

        const key = `${cell.taskId}|${lang}`;
        const ref = refDb.models[serveModel].cells[key];
        if (!ref) return finish(500, { error: { message: `mock: no reference cell ${key}` } });

        const answer = sampleFrom(ref.p);
        const id = `chatcmpl-mock-${Date.now()}`;
        const usage = { prompt_tokens: 75 + Math.floor(Math.random() * 20), completion_tokens: 1 };

        if (requireStream && !parsed.stream) {
          return finish(400, { error: { message: 'Stream must be set to true' } });
        }
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          // split the answer into two deltas to exercise aggregation
          const half = Math.max(1, Math.ceil(answer.length / 2));
          const parts = [answer.slice(0, half), answer.slice(half)];
          setTimeout(() => {
            if (emitReasoning) {
              send({ id, object: 'chat.completion.chunk', model: claimModel, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking...' }, finish_reason: null }] });
            }
            for (const part of parts) {
              if (!part) continue;
              send({ id, object: 'chat.completion.chunk', model: claimModel, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
            }
            send({ id, object: 'chat.completion.chunk', model: claimModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
            res.write('data: [DONE]\n\n');
            res.end();
          }, latencyMs);
          return;
        }

        return finish(200, {
          id,
          object: 'chat.completion',
          model: claimModel, // echoes the CLAIM — exactly like a lying relay
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: answer,
              ...(emitReasoning ? { reasoning_content: 'thinking...' } : {}),
            },
            finish_reason: 'stop',
          }],
          usage,
        });
      });
      return;
    }
    finish(404, { error: { message: 'not found' } });
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

if (process.argv[1] && process.argv[1].endsWith('mock-relay.mjs')) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : dflt;
  };
  const claim = arg('claim', null) ?? (arg('honest', null) ?? null);
  const serve = arg('serve', null) ?? claim;
  if (!claim || !refDb.models[claim]) {
    console.error('用法: node scripts/mock-relay.mjs --claim <模型ID> [--serve <实际服务的模型>] [--port 8377]');
    console.error('示例: node scripts/mock-relay.mjs --claim openai/gpt-4o-mini --serve z-ai/glm-4.5-air');
    process.exit(1);
  }
  const mock = await createMockRelay({ port: Number(arg('port', '8377')), claimModel: claim, serveModel: serve });
  console.log(`Mock 中转站已启动: ${mock.url}`);
  console.log(`  声称模型: ${claim}`);
  console.log(`  实际采样自: ${serve}${serve === claim ? '（诚实模式）' : '  ← 注水模拟'}`);
  console.log('在应用中填入该地址、任意 API Key、声称的模型名即可测试。Ctrl+C 退出。');
}
