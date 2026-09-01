// Live UI audit: drives the real Electron window against a REAL relay using
// credentials from environment variables.
//
//   $env:RELAY_KEY="sk-..."; $env:LIVE_BASE="https://host/v1"; $env:LIVE_MODEL="grok-4.6";
//   node scripts/ui-live.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DEBUG_PORT = 9225;
const BASE_URL = process.env.LIVE_BASE;
const API_KEY = process.env.RELAY_KEY;
const MODEL = process.env.LIVE_MODEL;

if (!BASE_URL || !API_KEY || !MODEL) {
  console.error('需要环境变量 LIVE_BASE / RELAY_KEY / LIVE_MODEL');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
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
    }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  };
  return { evalJs, consoleErrors, close: () => ws.close() };
}
async function waitFor(evalJs, expr, timeoutMs, desc) {
  const t0 = Date.now();
  for (;;) {
    if (await evalJs(expr).catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${desc}`);
    await sleep(700);
  }
}

console.log(`启动应用审计 ${MODEL} @ ${BASE_URL} ...`);
const electron = spawn(ELECTRON_EXE, ['.', `--remote-debugging-port=${DEBUG_PORT}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let session = null;
try {
  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const l = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      target = l.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* retry */ }
  }
  if (!target) throw new Error('未找到页面调试目标');
  session = await cdp(target.webSocketDebuggerUrl);
  await waitFor(session.evalJs, `document.readyState === 'complete' && !!document.querySelector('#base-url')`, 20000, '页面加载');

  await session.evalJs(`
    document.querySelector('#base-url').value = ${JSON.stringify(BASE_URL)};
    document.querySelector('#api-key').value = ${JSON.stringify(API_KEY)};
  `);
  await session.evalJs(`document.querySelector('#btn-connect').click()`);
  await waitFor(session.evalJs, `document.querySelectorAll('#model-list label').length > 0`, 30000, '模型列表');
  const listed = await session.evalJs(`[...document.querySelectorAll('#model-list label span')].map(s=>s.textContent)`);
  console.log(`端点返回 ${listed.length} 个模型:`, listed.join(', '));

  // select exactly the target model
  const picked = await session.evalJs(`(() => {
    const labels = [...document.querySelectorAll('#model-list label')];
    const hit = labels.find(l => l.querySelector('span').textContent === ${JSON.stringify(MODEL)});
    if (!hit) return false;
    hit.querySelector('input').click();
    return true;
  })()`);
  if (!picked) throw new Error(`模型列表中没有 ${MODEL}`);

  // custom profile: en+zh, reps 8, concurrency 6, allow-reasoning on
  await session.evalJs(`document.querySelector('#profile-row input[value="custom"]').click()`);
  await session.evalJs(`
    document.querySelector('#reps-input').value = '8';
    [...document.querySelectorAll('.lang-cb')].forEach(cb => { cb.checked = ['en','zh'].includes(cb.value); });
    document.querySelector('#allow-reasoning').checked = true;
  `);
  await session.evalJs(`document.querySelector('#btn-start').click()`);

  // jump to reports tab happens automatically; wait for completion badge
  await waitFor(
    session.evalJs,
    `[...document.querySelectorAll('.q-card .badge')].some(b => !['检测中','排队中'].includes(b.textContent.trim()))`,
    600000,
    '检测完成'
  );
  const badge = await session.evalJs(`document.querySelector('.q-card .badge').textContent.trim()`);
  const sub = await session.evalJs(`document.querySelector('.q-card .q-sub').textContent.trim()`);
  await session.evalJs(`document.querySelector('.q-card').click()`);
  await waitFor(session.evalJs, `document.querySelectorAll('#detail .rank-row').length >= 1 || document.querySelectorAll('#detail .metric').length >= 1`, 10000, '详情渲染');
  const banner = await session.evalJs(`document.querySelector('.verdict-banner h3')?.textContent ?? '(无横幅)'`);
  const top3 = await session.evalJs(`[...document.querySelectorAll('#detail .rank-row .rank-name')].slice(0,3).map(x=>x.textContent.trim())`);
  const chips = await session.evalJs(`[...document.querySelectorAll('#detail .chip')].map(x=>x.textContent)`);

  console.log('\n=== 真实 UI 审计结果 ===');
  console.log('卡片徽章:', badge);
  console.log('概要:', sub);
  console.log('判定横幅:', banner);
  console.log('Top3:', top3.join(' | '));
  console.log('信号徽章:', chips.join(' · '));
  if (session.consoleErrors.length) {
    console.log('⚠ 页面错误:');
    for (const e of session.consoleErrors) console.log(' -', e);
    process.exitCode = 2;
  }
} catch (err) {
  console.error('UI-LIVE FAIL:', err.message);
  process.exitCode = 1;
} finally {
  electron.kill();
}
