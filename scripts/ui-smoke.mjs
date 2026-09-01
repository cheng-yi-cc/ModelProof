// UI smoke test: launches the real Electron window, drives it over CDP against
// a local mock relay, and asserts the rendered verdict.
//
//   node scripts/ui-smoke.mjs
import { spawn } from 'node:child_process';
import { createMockRelay } from './mock-relay.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DEBUG_PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WS 连接失败'));
  });
  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.text ?? 'exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args?.map((x) => x.value ?? x.description ?? '').join(' '));
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.value;
  };
  return { call, evalJs, consoleErrors, close: () => ws.close() };
}

async function waitFor(evalJs, expr, timeoutMs, desc) {
  const t0 = Date.now();
  for (;;) {
    const ok = await evalJs(expr).catch(() => false);
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${desc}`);
    await sleep(500);
  }
}

// ---- start mock relay (honest mode: serves what it claims) ----
const claimModel = 'openai/gpt-4o-mini';
const mock = await createMockRelay({ claimModel, serveModel: claimModel, latencyMs: 5 });

// ---- launch electron ----
const electron = spawn(ELECTRON_EXE, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderrBuf = '';
electron.stderr.on('data', (d) => { stderrBuf += d.toString(); });

let session = null;
try {
  // find page target
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      targets = list.filter((t) => t.type === 'page');
      if (targets.length) break;
    } catch { /* not up yet */ }
  }
  if (!targets?.length) throw new Error('未找到 Electron 页面调试目标');
  session = await cdp(targets[0].webSocketDebuggerUrl);

  // wait for DOM readiness before touching selectors
  await waitFor(
    session.evalJs,
    `document.readyState === 'complete' && !!document.querySelector('#base-url')`,
    20000,
    '页面加载'
  );

  // fill connection form and connect
  await session.evalJs(`
    document.querySelector('#base-url').value = ${JSON.stringify(mock.url)};
    document.querySelector('#api-key').value = 'sk-ui-smoke-test';
  `);
  await session.evalJs(`document.querySelector('#btn-connect').click()`);
  await waitFor(session.evalJs, `document.querySelectorAll('#model-list label').length > 0`, 15000, '模型列表渲染');
  const listed = await session.evalJs(
    `[...document.querySelectorAll('#model-list label span')].map(s=>s.textContent)`
  );
  if (!listed.includes(claimModel)) throw new Error(`模型列表缺少 ${claimModel}: ${listed}`);

  // select all models, pick quick profile, crank concurrency, start
  await session.evalJs(`document.querySelector('#btn-select-all').click()`);
  await session.evalJs(`document.querySelector('#profile-row input[value="quick"]').click()`);
  await session.evalJs(`
    const c = document.querySelector('#concurrency');
    c.value = '10';
    c.dispatchEvent(new Event('input'));
    document.querySelector('#btn-start').click();
  `);

  // wait until the queue item finishes (quick profile: 100 requests)
  await waitFor(
    session.evalJs,
    `[...document.querySelectorAll('.q-card .badge')].some(b => !['检测中','排队中'].includes(b.textContent.trim()))`,
    120000,
    '检测完成'
  );
  const badge = await session.evalJs(`document.querySelector('.q-card .badge').textContent.trim()`);
  const subText = await session.evalJs(`document.querySelector('.q-card .q-sub').textContent.trim()`);

  if (!badge.includes('相符')) {
    throw new Error(`期望判定「与声称型号相符」，实际:「${badge}」（${subText}）`);
  }

  // detail panel should render ranking + metrics
  await session.evalJs(`document.querySelector('.q-card').click()`);
  await waitFor(session.evalJs, `document.querySelectorAll('#detail .rank-row').length >= 1`, 10000, '报告详情渲染');
  const rankFirst = await session.evalJs(`document.querySelector('#detail .rank-row .rank-name').textContent`);

  console.log(`UI-SMOKE PASS`);
  console.log(`  判定徽章: ${badge}`);
  console.log(`  概要行: ${subText}`);
  console.log(`  排行第一: ${rankFirst.trim()}`);
} catch (err) {
  console.error('UI-SMOKE FAIL:', err.message);
  if (typeof session?.consoleErrors?.length === 'number' && session.consoleErrors.length) {
    console.error('页面控制台错误:');
    for (const e of session.consoleErrors) console.error('  -', e);
  }
  if (stderrBuf.trim()) console.error('--- electron stderr ---\n' + stderrBuf.slice(-2000));
  process.exitCode = 1;
} finally {
  electron.kill();
  await mock.close();
}
