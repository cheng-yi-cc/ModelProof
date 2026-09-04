// ModelProof renderer — all UI logic. Talks to main process exclusively via
// window.modelproof (contextBridge).
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const PROFILES = {
  quick: { langs: ['en'], reps: 10 },
  standard: { langs: ['en', 'ru', 'zh', 'ar'], reps: 12 },
  strict: { langs: ['en', 'ru', 'zh', 'ar'], reps: 25 },
};

/* ---------------- theme ---------------- */
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem('mp-theme'); } catch { /* noop */ }
  if (t !== 'light' && t !== 'dark') {
    t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = t;
  $('#theme-label').textContent = t === 'dark' ? '深色' : '浅色';
})();
$('#btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('mp-theme', next); } catch { /* noop */ }
  $('#theme-label').textContent = next === 'dark' ? '深色' : '浅色';
});

const state = {
  conn: null,
  models: [],
  selected: new Set(),
  items: [], // {key, model, state, progress, fingerprint, diagnostics, analysis, error}
  detailKey: null,
  pumping: false,
  lib: null, // {official:{meta,models}, user:{models}}
  libLoaded: false,
  libFilter: 'all',
  libSelected: null,
  libCollapsed: new Set(),
  collect: {
    key: null,
    models: [],
    model: null,
    provider: null,
    running: false,
    auditId: null,
  },
};

let itemSeq = 0;

function setSideStatus(main, sub) {
  $('#conn-state').textContent = main;
  $('#status-dot').classList.toggle('on', Boolean(state.conn));
  if (sub !== undefined) $('#status-sub').textContent = sub;
}

/* ---------------- tabs ---------------- */
$$('nav button').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('nav button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === 'library' && !state.libLoaded) loadLibrary();
  })
);
function gotoTab(name) {
  $$('nav button').find((b) => b.dataset.tab === name)?.click();
}

/* ---------------- shared helpers ---------------- */
function entropyBits(p) {
  let h = 0;
  for (const v of Object.values(p)) if (v > 0) h -= v * Math.log2(v);
  return h;
}

function top3Of(p) {
  return Object.entries(p)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([ans, pr]) => `${ans} ${(pr * 100).toFixed(0)}%`)
    .join(', ');
}

function renderCellsTable(fp, container) {
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = `各维度明细（${Object.keys(fp).length} 个维度，展开查看原始分布）`;
  det.appendChild(sum);
  const table = document.createElement('table');
  table.className = 'cells';
  const thead = document.createElement('tr');
  for (const th of ['维度 (任务|语言)', '样本数', '熵(bits)', '最高频答案 Top3']) {
    const el = document.createElement('th');
    el.textContent = th;
    thead.appendChild(el);
  }
  table.appendChild(thead);
  for (const key of Object.keys(fp).sort()) {
    const cell = fp[key];
    const tr = document.createElement('tr');
    for (const tdText of [key, String(cell.n), entropyBits(cell.p).toFixed(2), top3Of(cell.p)]) {
      const td = document.createElement('td');
      td.textContent = tdText;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  det.appendChild(table);
  container.appendChild(det);
}

/* ================= 检测页 ================= */
$('#btn-eye').addEventListener('click', () => {
  const inp = $('#api-key');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  $('#btn-eye').textContent = show ? '隐藏' : '显示';
});

$('#btn-connect').addEventListener('click', async () => {
  const baseUrl = $('#base-url').value.trim();
  const apiKey = $('#api-key').value.trim();
  const hint = $('#connect-hint');
  if (!baseUrl || !apiKey) {
    hint.textContent = '请先填写 API 地址和 API Key。';
    return;
  }
  hint.innerHTML = '<span class="spin"></span> 连接中…';
  let res;
  try {
    res = await window.modelproof.connect(baseUrl, apiKey);
  } catch (err) {
    state.conn = null;
    hint.textContent = `连接出错：${String(err?.message || err)}`;
    return;
  }
  if (!res.ok) {
    state.conn = null;
    setSideStatus('未连接', '连接失败，请检查地址与 Key');
    hint.textContent = `连接失败：${res.error}`;
    return;
  }
  state.conn = { baseUrl: res.base ?? baseUrl, apiKey };
  state.models = res.models;
  renderModelList();
  $('#model-panel').style.display = 'block';
  let host = '中转站';
  try { host = new URL(state.conn.baseUrl).host; } catch { /* keep */ }
  setSideStatus(`已连接 · ${res.models.length} 个模型`, host);
  hint.textContent = '';
});

function renderModelList() {
  const q = ($('#model-search')?.value ?? '').toLowerCase();
  const list = $('#model-list');
  list.innerHTML = '';
  for (const id of state.models) {
    if (q && !id.toLowerCase().includes(q)) continue;
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateSelCount();
    });
    const span = document.createElement('span');
    span.textContent = id;
    label.append(cb, span);
    list.appendChild(label);
  }
  updateSelCount();
}

function updateSelCount() {
  $('#sel-count').textContent = `已选 ${state.selected.size} 个`;
  $('#btn-start').disabled = state.selected.size === 0;
}
$('#model-search').addEventListener('input', renderModelList);
$('#btn-select-all').addEventListener('click', () => {
  const q = ($('#model-search').value ?? '').toLowerCase();
  for (const m of state.models) if (!q || m.toLowerCase().includes(q)) state.selected.add(m);
  renderModelList();
});
$('#btn-clear-sel').addEventListener('click', () => {
  state.selected.clear();
  renderModelList();
});

/* ---------------- probe plan ---------------- */
$$('#profile-row input[name=profile]').forEach((r) =>
  r.addEventListener('change', () => {
    const custom = r.value === 'custom' && r.checked;
    $('#custom-row').style.display = custom ? 'flex' : 'none';
    $$('.lang-cb').forEach((cb) => {
      cb.disabled = !custom;
      if (r.checked) {
        const p = PROFILES[r.value];
        if (p) cb.checked = p.langs.includes(cb.value);
      }
    });
  })
);
$('#concurrency').addEventListener('input', () => {
  $('#conc-val').textContent = $('#concurrency').value;
});

function readPlan() {
  const profile = $$('#profile-row input[name=profile]').find((r) => r.checked)?.value ?? 'standard';
  let langs;
  let reps;
  if (profile === 'custom') {
    langs = $$('.lang-cb').filter((c) => c.checked).map((c) => c.value);
    reps = Math.max(5, Math.min(40, parseInt($('#reps-input').value, 10) || 12));
    if (!langs.length) langs = ['en'];
  } else {
    ({ langs, reps } = PROFILES[profile]);
  }
  return { langs, reps, concurrency: parseInt($('#concurrency').value, 10) || 6, reasoningPolicy: $('#allow-reasoning').checked ? 'allow' : 'strict' };
}

/* ---------------- audit queue ---------------- */
$('#btn-start').addEventListener('click', () => {
  if (!state.conn || !state.selected.size) return;
  const plan = readPlan();
  for (const model of state.selected) {
    state.items.push({
      key: `it-${++itemSeq}`,
      model,
      plan: { ...plan },
      state: 'pending',
      progress: null,
      fingerprint: null,
      diagnostics: null,
      analysis: null,
      error: null,
    });
  }
  gotoTab('reports');
  renderQueue();
  pump();
});

async function pump() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    for (;;) {
      const next = state.items.find((i) => i.state === 'pending');
      if (!next) break;
      await runItem(next);
    }
  } finally {
    state.pumping = false;
  }
}

function runItem(item) {
  return new Promise(async (resolve) => {
    item.state = 'running';
    item.progress = { done: 0, total: item.plan.langs.length * 10 * item.plan.reps };
    renderQueue();

    const { id } = await window.modelproof.startAudit({
      baseUrl: state.conn.baseUrl,
      apiKey: state.conn.apiKey,
      model: item.model,
      reps: item.plan.reps,
      concurrency: item.plan.concurrency,
      langs: item.plan.langs,
      reasoningPolicy: item.plan.reasoningPolicy,
    });
    item.auditId = id;

    const off = window.modelproof.onAuditEvent((evt) => {
      if (evt.id !== id) return;
      if (evt.type === 'progress') {
        item.progress = evt;
        renderQueueProgress(item);
      } else if (evt.type === 'done') {
        off();
        if (evt.cancelled) {
          item.state = 'cancelled';
        } else {
          item.state = 'done';
          item.fingerprint = evt.fingerprint;
          item.diagnostics = evt.diagnostics;
          item.analysis = evt.analysis;
        }
        renderQueue();
        if (state.detailKey === item.key) renderDetail();
        resolve();
      } else if (evt.type === 'error') {
        off();
        item.state = 'error';
        item.error = evt.message;
        renderQueue();
        resolve();
      }
    });
  });
}

/* ---------------- queue rendering ---------------- */
const STATE_BADGE = {
  pending: ['pending', '排队中'],
  running: ['running', '检测中'],
  done: null, // verdict badge
  cancelled: ['pending', '已取消'],
  error: ['mismatch', '出错'],
};
const LEVEL_CLASS = {
  match: 'match',
  uncertain: 'uncertain',
  mismatch: 'mismatch',
  'no-reference': 'no-reference',
  'insufficient-data': 'insufficient-data',
};

function badgeFor(item) {
  if (item.state === 'done' && item.analysis) {
    const v = item.analysis.verdict;
    return [LEVEL_CLASS[v.level] ?? 'pending', v.label];
  }
  const [cls, label] = STATE_BADGE[item.state] ?? ['pending', item.state];
  return [cls, label];
}

function renderQueue() {
  const q = $('#queue');
  q.innerHTML = '';
  $('#queue-empty').style.display = state.items.length ? 'none' : 'block';
  $('#report-count').textContent = state.items.length ? `(${state.items.length})` : '';

  for (const item of state.items) {
    const card = document.createElement('div');
    card.className = 'q-card' + (state.detailKey === item.key ? ' selected' : '');
    card.addEventListener('click', () => {
      state.detailKey = item.key;
      renderQueue();
      renderDetail();
    });

    const title = document.createElement('div');
    title.className = 'q-title';
    const name = document.createElement('div');
    name.className = 'q-model';
    name.textContent = item.model;
    const [cls, label] = badgeFor(item);
    const badge = document.createElement('span');
    badge.className = `badge ${cls}`;
    badge.textContent = label;
    title.append(name, badge);
    if (item.state === 'running') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ghost danger';
      cancelBtn.textContent = '取消';
      cancelBtn.style.padding = '2px 10px';
      cancelBtn.style.fontSize = '12px';
      cancelBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        cancelBtn.disabled = true;
        cancelBtn.textContent = '取消中…';
        await window.modelproof.cancelAudit(item.auditId);
      });
      title.appendChild(cancelBtn);
    }

    card.appendChild(title);

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.style.width = `${progressPct(item)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);

    const sub = document.createElement('div');
    sub.className = 'q-sub';
    if (item.state === 'running') {
      sub.innerHTML = `<span class="spin"></span> ${item.progress.done}/${item.progress.total} · 有效 ${
        item.progress.classes?.valid ?? 0
      } · 失败 ${item.progress.failed ?? 0}`;
    } else if (item.state === 'done' && item.analysis) {
      const d = item.analysis.distanceToClaimed;
      sub.textContent =
        d != null
          ? `平均 JSD ${d.toFixed(3)} · ${item.analysis.dataQuality.usableCells} 维度`
          : `${item.analysis.dataQuality.usableCells} 维度`;
    } else if (item.state === 'error') {
      sub.textContent = item.error?.slice(0, 120) ?? '';
    } else if (item.state === 'pending') {
      sub.textContent = '等待中…（点击可取消）';
      sub.style.cursor = 'pointer';
      sub.addEventListener('click', (e) => {
        e.stopPropagation();
        item.state = 'cancelled';
        renderQueue();
      });
    } else {
      sub.textContent = '';
    }
    card.appendChild(sub);
    q.appendChild(card);
  }

  // auto-select first finished item when nothing selected
  if (!state.detailKey) {
    const firstDone = state.items.find((i) => i.state === 'done');
    if (firstDone) {
      state.detailKey = firstDone.key;
      renderQueue();
      renderDetail();
    }
  }
}

function progressPct(item) {
  if (item.state === 'done') return 100;
  if (!item.progress) return 0;
  return Math.min(100, ((item.progress.done ?? 0) / Math.max(1, item.progress.total)) * 100);
}

let progressThrottle = new Map();
function renderQueueProgress(item) {
  const now = Date.now();
  const last = progressThrottle.get(item.key) ?? 0;
  if (now - last < 200) return;
  progressThrottle.set(item.key, now);
  const idx = state.items.indexOf(item);
  const card = $$('#queue .q-card')[idx];
  if (!card) return;
  card.querySelector('.bar > div').style.width = `${progressPct(item)}%`;
  const p = item.progress;
  card.querySelector('.q-sub').innerHTML = `<span class="spin"></span> ${p.done}/${p.total} · 有效 ${
    p.classes?.valid ?? 0
  } · 失败 ${p.failed ?? 0}`;
}

/* ---------------- detail rendering ---------------- */
function renderDetail() {
  const wrap = $('#detail');
  wrap.innerHTML = '';
  const item = state.items.find((i) => i.key === state.detailKey);
  if (!item || item.state !== 'done') return;

  const a = item.analysis;

  // verdict banner
  const banner = document.createElement('div');
  banner.className = `verdict-banner ${LEVEL_CLASS[a.verdict.level] ?? ''}`;
  const h3 = document.createElement('h3');
  h3.textContent = `${a.verdict.label} — ${item.model}`;
  const p = document.createElement('p');
  p.textContent = a.verdict.detail;
  banner.append(h3, p);
  wrap.appendChild(banner);

  // metrics
  const metrics = document.createElement('div');
  metrics.className = 'metric-grid';
  const addMetric = (v, k) => {
    const m = document.createElement('div');
    m.className = 'metric';
    const vv = document.createElement('div');
    vv.className = 'v';
    vv.textContent = v;
    const kk = document.createElement('div');
    kk.className = 'k';
    kk.textContent = k;
    m.append(vv, kk);
    metrics.appendChild(m);
  };
  addMetric(
    a.distanceToClaimed != null ? a.distanceToClaimed.toFixed(3) : '—',
    a.claimed.inReferenceDb ? '与声称型号的平均 JSD' : '参考库无此型号'
  );
  addMetric(a.dataQuality.usableCells + ' / 40', '可用指纹维度');
  addMetric(a.dataQuality.totalValidAnswers, '有效答案数');
  if (a.percentileOfClaimed != null) {
    addMetric(`${Math.round(a.percentileOfClaimed * 100)}%`, '比这更近的不同模型对占比');
  }
  if (a.claimedRank) addMetric(`#${a.claimedRank}`, '声称型号在相似度排行中的位次');
  wrap.appendChild(metrics);

  // diagnostics chips
  const d = item.diagnostics;
  if (d) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    const chip = (text, cls = '') => {
      const c = document.createElement('span');
      c.className = `chip ${cls}`;
      c.textContent = text;
      chips.appendChild(c);
    };
    const totalReq = d.requestsOk + d.requestsFailed;
    const validRate = totalReq ? Math.round(((d.answerClasses.valid ?? 0) / totalReq) * 100) : 0;
    chip(`有效率 ${validRate}%`, validRate < 70 ? 'warn' : '');
    chip(`请求失败 ${d.requestsFailed}`, d.requestsFailed > totalReq * 0.1 ? 'bad' : '');
    if (d.modelReportedMismatch > 0)
      chip(`响应回显型号不一致 ×${d.modelReportedMismatch}${d.modelReportedSample ? `（如 ${d.modelReportedSample}）` : ''}`, 'bad');
    if (d.reasoningTraces > 0 && item.plan.reasoningPolicy === 'allow')
      chip(`隐藏思维链 ×${d.reasoningTraces}（容忍模式，可靠性下降）`, 'warn');
    if ((d.answerClasses.post_reasoning ?? 0) > 0)
      chip(`思维链污染已排除 ×${d.answerClasses.post_reasoning}（可在检测页开启容忍模式）`, 'bad');
    if (d.cachedTokenResponses > 0) chip(`服务端缓存命中 ×${d.cachedTokenResponses}`, 'warn');
    if (d.truncatedAnswers > 0) chip(`回答被截断 ×${d.truncatedAnswers}`, 'warn');
    if (d.cacheSuspect) chip(`疑似缓存/确定性服务 (${d.cacheSuspect.cell} 模式占比 ${(d.cacheSuspect.share * 100).toFixed(0)}%)`, 'warn');
    if (d.medianLatencyMs != null) chip(`延迟中位数 ${d.medianLatencyMs}ms`);
    wrap.appendChild(chips);
  }

  // ranking
  const rankCard = document.createElement('div');
  rankCard.className = 'card';
  const rh = document.createElement('h2');
  rh.textContent = '行为最像的已知模型（平均 JSD，越小越像）';
  rankCard.appendChild(rh);
  const maxJsd = Math.max(0.05, ...a.top.map((t) => t.jsd));
  for (const [i, t] of a.top.entries()) {
    const row = document.createElement('div');
    row.className = 'rank-row' + (t.model === a.claimed.resolvedId ? ' claimed' : '');
    const name = document.createElement('div');
    name.className = 'rank-name';
    const nameText = document.createElement('span');
    nameText.textContent = `${i + 1}. ${t.model}`;
    name.appendChild(nameText);
    if (t.source === 'user') {
      const tag = document.createElement('span');
      tag.className = 'src-tag';
      tag.textContent = '自建';
      tag.title = '来自「我的」指纹库';
      name.appendChild(tag);
    }
    const track = document.createElement('div');
    track.className = 'rank-bar-track';
    const barEl = document.createElement('div');
    barEl.className = 'rank-bar';
    barEl.style.width = `${(t.jsd / maxJsd) * 100}%`;
    track.appendChild(barEl);
    const val = document.createElement('div');
    val.className = 'rank-val';
    val.textContent = t.jsd.toFixed(3);
    row.append(name, track, val);
    rankCard.appendChild(row);
  }
  wrap.appendChild(rankCard);

  // per-cell table
  const cellsCard = document.createElement('div');
  cellsCard.className = 'card';
  renderCellsTable(item.fingerprint ?? {}, cellsCard);
  wrap.appendChild(cellsCard);

  // exports
  const exportRow = document.createElement('div');
  exportRow.className = 'row';
  const btnHtml = document.createElement('button');
  btnHtml.className = 'ghost';
  btnHtml.textContent = '导出 HTML 报告';
  btnHtml.addEventListener('click', () => saveReport(item, 'html'));
  const btnJson = document.createElement('button');
  btnJson.className = 'ghost';
  btnJson.textContent = '导出 JSON';
  btnJson.addEventListener('click', () => saveReport(item, 'json'));
  exportRow.append(btnHtml, btnJson);
  wrap.appendChild(exportRow);
}

async function saveReport(item, fmt) {
  const safe = item.model.replace(/[^\w.-]+/g, '_');
  if (fmt === 'json') {
    await window.modelproof.saveReport(
      `modelproof-${safe}.json`,
      JSON.stringify({ model: item.model, analysis: item.analysis, diagnostics: item.diagnostics }, null, 2)
    );
    return;
  }
  const a = item.analysis;
  const rows = a.top
    .map(
      (t, i) =>
        `<tr class="${t.model === a.claimed.resolvedId ? 'claimed' : ''}"><td>${i + 1}</td><td>${
          escapeHtml(t.model)
        }${t.source === 'user' ? '（自建）' : ''}</td><td>${t.jsd.toFixed(4)}</td><td>${t.usableCells}</td></tr>`
    )
    .join('');
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>ModelProof 报告 — ${escapeHtml(item.model)}</title>
<style>
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;max-width:860px;margin:30px auto;padding:0 16px;color:#222;line-height:1.7}
.banner{border-radius:10px;padding:14px 18px;margin-bottom:16px;border:1px solid #ddd}
.v-match{background:#e8f7ef}.v-uncertain{background:#faf3df}.v-mismatch{background:#fdeceb}.v-other{background:#f2f3f5}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left}
tr.claimed td{color:#0a66c2;font-weight:600}.meta{color:#777;font-size:13px}
</style></head><body>
<div class="banner v-${LEVEL_CLASS[a.verdict.level] ?? 'other'}">
<h2>${escapeHtml(a.verdict.label)} — ${escapeHtml(item.model)}</h2>
<p>${escapeHtml(a.verdict.detail)}</p>
</div>
<p class="meta">生成时间 ${new Date().toLocaleString()} · 平均 JSD(声称型号) ${
    a.distanceToClaimed != null ? a.distanceToClaimed.toFixed(4) : '—'
  } · 可用维度 ${a.dataQuality.usableCells} · 有效答案 ${a.dataQuality.totalValidAnswers}</p>
<h3>行为最像的已知模型</h3>
<table><tr><th>#</th><th>模型</th><th>平均 JSD</th><th>维度数</th></tr>${rows}</table>
<p class="meta">方法：PAMELA 单token行为指纹（arXiv:2607.10252）；参考数据 doi:10.5281/zenodo.21278557。
阈值 ≤0.25 相符 / 0.25–0.35 存疑 / &gt;0.35 高概率不符。结果为行为学证据，非密码学证明。</p>
</body></html>`;
  await window.modelproof.saveReport(`modelproof-${safe}.html`, html);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= 指纹库页 ================= */
async function loadLibrary() {
  try {
    state.lib = await window.modelproof.libraryAll();
    state.libLoaded = true;
  } catch (err) {
    $('#lib-empty').textContent = `指纹库加载失败：${String(err?.message || err)}`;
    $('#lib-empty').style.display = 'block';
    return;
  }
  renderLibrary();
}

// Combined view: user entries override official ones on the same ID, mirroring
// what the audit engine actually compares against. Ordered by popular model
// family groups first, newest (highest version) within each group.
const FAMILY_GROUPS = [
  { authors: ['openai'], label: 'GPT · OpenAI' },
  { authors: ['google'], label: 'Gemini · Google', lines: [['gemini', 0], ['gemma', 1]] },
  { authors: ['x-ai', 'xai'], label: 'Grok · xAI' },
  { authors: ['anthropic'], label: 'Claude · Anthropic' },
  { authors: ['deepseek'], label: 'DeepSeek' },
  { authors: ['z-ai', 'zhipuai', 'zhipu-ai'], label: 'GLM · 智谱' },
  { authors: ['qwen'], label: 'Qwen · 阿里' },
  { authors: ['meta-llama', 'meta'], label: 'Llama · Meta' },
  { authors: ['moonshotai', 'moonshot'], label: 'Kimi · 月之暗面' },
  { authors: ['minimax'], label: 'MiniMax' },
  { authors: ['mistralai', 'mistral'], label: 'Mistral' },
];

function familyGroupOf(id) {
  const author = (id.split('/')[0] ?? '').toLowerCase();
  const idx = FAMILY_GROUPS.findIndex((g) => g.authors.includes(author));
  if (idx >= 0) {
    const g = FAMILY_GROUPS[idx];
    const slug = (id.split('/')[1] ?? id).toLowerCase();
    const line = g.lines?.find(([prefix]) => slug.startsWith(prefix));
    return { label: g.label, rank: idx, key: `k${idx}`, line: line ? line[1] : 99 };
  }
  return { label: author || '其他', rank: 100, key: author ? `u-${author}` : 'u-', line: 0 };
}

function cmpInts(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpVersion(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpInts(a[i] ?? 0, b[i] ?? 0);
    if (c) return c;
  }
  return 0;
}

// Snapshot-style numbers in slugs (0613 = MMDD, 2507 = YYMM, 2024 = year)
// are release dates, not versions — they never drive "newest first" on their
// own, only break ties within the same semantic version.
function dateFromToken(tok) {
  if (tok.length === 2) {
    const v = Number(tok);
    return v >= 1 && v <= 31 ? [2000, 0, v] : null; // bare day/month fragment
  }
  const a = Number(tok.slice(0, 2));
  const b = Number(tok.slice(2));
  if (tok.length === 4 && a >= 20 && a <= 26 && b >= 1 && b <= 12) return [2000 + a, b, 0]; // YYMM
  if (tok.length >= 3 && a >= 1 && a <= 12 && b >= 1 && b <= 31) return [2000, a, b]; // M(M)DD
  if (tok.length === 4 && a >= 2010 && a <= 2030) return [a, 0, 0]; // YYYY
  return null;
}

// Extract the most significant version / date signal from a model slug so
// "claude-opus-4.8" sorts above "claude-opus-4.7", "gpt-4o" below "gpt-5.6".
// Parameter-size tokens (70b, 405b, 128k, 8x22b, 1t) are ignored.
function modelVersionKey(id) {
  const slug = (id.split('/')[1] ?? id).toLowerCase();
  let working = slug;
  let date = null;
  const dm = slug.match(/20\d{2}-?\d{2}-?\d{2}/);
  if (dm) {
    date = dm[0].split('-').map(Number);
    working = slug.replace(dm[0], ' ');
  }
  let version = [0];
  const bumpDate = (d) => {
    if (!date || cmpVersion(d, date) > 0) date = d;
  };
  for (const m of working.matchAll(/\d+(?:\.\d+)*/g)) {
    const tok = m[0];
    const after = working[m.index + tok.length];
    if (after === 'b' || after === 'k' || after === 'x' || after === 't') continue; // params / context / MoE
    if (!tok.includes('.') && tok.length >= 2) {
      const d = dateFromToken(tok);
      if (d) { bumpDate(d); continue; }
    }
    const t = tok.split('.').map(Number);
    if (cmpVersion(t, version) > 0) version = t;
  }
  return { version, dated: date ? 1 : 0, date: date ?? [0, 0, 0], slug };
}

function libEntries() {
  const official = state.lib?.official?.models ?? {};
  const user = state.lib?.user?.models ?? {};
  const entries = [];
  for (const [id, e] of Object.entries(official)) {
    if (user[id]) continue;
    entries.push({ id, family: e.family, cells: e.cells, source: 'official' });
  }
  for (const [id, e] of Object.entries(user)) {
    entries.push({
      id,
      family: e.family,
      cells: e.cells,
      source: 'user',
      meta: e.meta ?? {},
    });
  }
  for (const e of entries) {
    const g = familyGroupOf(e.id);
    e.groupKey = g.key;
    e.groupLabel = g.label;
    e.groupRank = g.rank;
    e.line = g.line;
    const vk = modelVersionKey(e.id);
    e.version = vk.version;
    e.dated = vk.dated;
    e.date = vk.date;
  }
  entries.sort((a, b) => {
    if (a.groupRank !== b.groupRank) return a.groupRank - b.groupRank;
    if (a.groupRank >= 100 && a.groupLabel !== b.groupLabel) return a.groupLabel.localeCompare(b.groupLabel);
    if (a.line !== b.line) return a.line - b.line;
    let c = cmpVersion(b.version, a.version); // newest first
    if (c) return c;
    if (a.dated !== b.dated) return a.dated - b.dated; // rolling release before dated snapshots
    c = cmpVersion(b.date, a.date);
    if (c) return c;
    return a.id.localeCompare(b.id);
  });
  return entries;
}

function entryStats(e) {
  const cellKeys = Object.keys(e.cells ?? {});
  const totalValid = cellKeys.reduce((s, k) => s + (e.cells[k].n ?? 0), 0);
  const sufficient = cellKeys.filter((k) => (e.cells[k].n ?? 0) >= 10).length;
  return { cellCount: cellKeys.length, totalValid, sufficient };
}

$$('#lib-filter button').forEach((btn) =>
  btn.addEventListener('click', () => {
    state.libFilter = btn.dataset.filter;
    $$('#lib-filter button').forEach((b) => b.classList.toggle('active', b === btn));
    renderLibrary();
  })
);
$('#lib-search').addEventListener('input', renderLibrary);

function renderLibrary() {
  if (!state.lib) return;
  const grid = $('#lib-grid');
  const empty = $('#lib-empty');
  const q = ($('#lib-search').value ?? '').trim().toLowerCase();
  const all = libEntries();
  const officialCount = all.filter((e) => e.source === 'official').length;
  const userCount = all.length - officialCount;
  $('#lib-count').textContent = `官方 ${officialCount} · 我的 ${userCount}`;

  let list = all;
  if (state.libFilter === 'official') list = list.filter((e) => e.source === 'official');
  if (state.libFilter === 'user') list = list.filter((e) => e.source === 'user');
  if (q) list = list.filter((e) => e.id.toLowerCase().includes(q) || (e.family ?? '').toLowerCase().includes(q));

  grid.innerHTML = '';
  empty.style.display = list.length ? 'none' : 'block';
  empty.textContent = state.libFilter === 'user' && !q
    ? '「我的」库还是空的。到「采集指纹」页实测添加模型指纹。'
    : '没有匹配的模型。';

  let lastGroup = null;
  const groupCounts = {};
  for (const e of list) groupCounts[e.groupKey] = (groupCounts[e.groupKey] ?? 0) + 1;
  for (const e of list) {
    const collapsed = !q && state.libCollapsed.has(e.groupKey); // searching always expands
    if (e.groupKey !== lastGroup) {
      lastGroup = e.groupKey;
      const head = document.createElement('div');
      head.className = 'lib-group-head' + (collapsed ? ' collapsed' : '');
      head.title = collapsed ? '展开该厂商' : '收起该厂商';
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
      const label = document.createElement('span');
      label.textContent = e.groupLabel;
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = groupCounts[e.groupKey];
      head.append(chev, label, cnt);
      head.addEventListener('click', () => {
        if (state.libCollapsed.has(e.groupKey)) state.libCollapsed.delete(e.groupKey);
        else state.libCollapsed.add(e.groupKey);
        renderLibrary();
      });
      grid.appendChild(head);
    }
    if (collapsed) continue;

    const st = entryStats(e);
    const card = document.createElement('div');
    card.className = 'lib-card' + (state.libSelected === e.id + '|' + e.source ? ' selected' : '');
    card.addEventListener('click', () => {
      state.libSelected = e.id + '|' + e.source;
      showLibDetail(e, st);
      renderLibrary();
    });

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = e.id;
    card.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const mkTag = (text, cls) => {
      const t = document.createElement('span');
      t.className = `tag ${cls}`;
      t.textContent = text;
      meta.appendChild(t);
    };
    mkTag(e.source === 'official' ? '官方' : '我的', e.source);
    if (e.family) mkTag(e.family, 'family');
    mkTag(`${st.sufficient}/${st.cellCount} 维充足`, '');
    if (st.sufficient < 8) mkTag('质量不足', 'lowq');
    card.appendChild(meta);

    if (e.source === 'user') {
      const del = document.createElement('button');
      del.className = 'lib-del';
      del.textContent = '删除';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm(`确定从「我的」指纹库删除 ${e.id} 吗？检测比对将不再使用它。`)) return;
        await window.modelproof.libraryDelete(e.id);
        if (state.libSelected === e.id + '|' + e.source) {
          state.libSelected = null;
          $('#lib-detail').style.display = 'none';
          $('#lib-layout').classList.remove('detail-open');
        }
        state.lib = await window.modelproof.libraryAll();
        renderLibrary();
      });
      card.appendChild(del);
    }
    grid.appendChild(card);
  }
}

function showLibDetail(e, st) {
  const wrap = $('#lib-detail');
  wrap.style.display = 'block';
  wrap.scrollTop = 0;
  $('#lib-layout').classList.add('detail-open');
  $('#lib-detail-title').textContent = e.id;

  const chips = $('#lib-detail-chips');
  chips.innerHTML = '';
  const chip = (text) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = text;
    chips.appendChild(c);
  };
  chip(e.source === 'official' ? '官方' : '我的');
  if (e.family) chip(`家族 ${e.family}`);
  chip(`${st.sufficient}/${st.cellCount} 维充足（n≥10）`);
  chip(`有效答案 ${st.totalValid}`);
  if (e.source === 'user') {
    if (e.meta.provider) chip(`提供商 ${e.meta.provider}`);
    if (e.meta.reps) chip(`每维 ${e.meta.reps} 次`);
    if (e.meta.collected_utc) chip(`采集于 ${new Date(e.meta.collected_utc).toLocaleString()}`);
  } else {
    chip('来源：论文 Zenodo doi:10.5281/zenodo.21278557');
  }
  const body = $('#lib-detail-body');
  body.innerHTML = '';
  renderCellsTable(e.cells ?? {}, body);
}

$('#lib-detail-close').addEventListener('click', () => {
  $('#lib-detail').style.display = 'none';
  $('#lib-layout').classList.remove('detail-open');
  state.libSelected = null;
  renderLibrary();
});

/* ================= 采集指纹页 ================= */
$('#c-concurrency').addEventListener('input', () => {
  $('#c-conc-val').textContent = $('#c-concurrency').value;
});

$('#btn-or-connect').addEventListener('click', async () => {
  const key = $('#or-key').value.trim();
  const hint = $('#or-hint');
  if (!key) {
    hint.textContent = '请先填写 OpenRouter API Key。';
    return;
  }
  hint.innerHTML = '<span class="spin"></span> 正在获取模型列表…';
  let res;
  try {
    res = await window.modelproof.orModels(key);
  } catch (err) {
    hint.textContent = `连接出错：${String(err?.message || err)}`;
    return;
  }
  if (!res.ok) {
    hint.textContent = `获取失败：${res.error}`;
    return;
  }
  state.collect.key = key;
  state.collect.models = res.models;
  $('#collect-setup').style.display = 'block';
  hint.textContent = `已连接 OpenRouter，共 ${res.models.length} 个模型。选择要采集的模型。`;
  $('#cm-search').focus();
});

const CM_LIMIT = 60;
function cmMatches() {
  const q = ($('#cm-search').value ?? '').trim().toLowerCase();
  const models = state.collect.models;
  if (!q) return models.slice(0, CM_LIMIT);
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, CM_LIMIT);
}

function renderCmDropdown() {
  const dd = $('#cm-dropdown');
  const items = cmMatches();
  dd.innerHTML = '';
  if (!items.length) {
    dd.style.display = 'none';
    return;
  }
  for (const m of items) {
    const el = document.createElement('div');
    el.className = 'cm-item';
    el.textContent = m.id;
    if (m.name && m.name !== m.id) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = m.name;
      el.appendChild(sub);
    }
    el.addEventListener('click', () => {
      selectCmModel(m.id);
    });
    dd.appendChild(el);
  }
  dd.style.display = 'block';
}

$('#cm-search').addEventListener('input', () => {
  state.collect.model = null;
  state.collect.provider = null;
  $('#provider-panel').style.display = 'none';
  $('#collect-plan').style.display = 'none';
  $('#btn-collect').disabled = true;
  renderCmDropdown();
});
$('#cm-search').addEventListener('focus', renderCmDropdown);
document.addEventListener('click', (e) => {
  if (!e.target.closest('#cm-search') && !e.target.closest('#cm-dropdown')) {
    $('#cm-dropdown').style.display = 'none';
  }
});

async function selectCmModel(id) {
  $('#cm-search').value = id;
  $('#cm-dropdown').style.display = 'none';
  state.collect.model = id;
  state.collect.provider = null;
  $('#btn-collect').disabled = true;
  $('#provider-panel').style.display = 'block';
  const listEl = $('#provider-list');
  const phint = $('#provider-hint');
  listEl.innerHTML = '';
  phint.innerHTML = '<span class="spin"></span> 正在获取该模型的提供商列表…';

  let res;
  try {
    res = await window.modelproof.orEndpoints(state.collect.key, id);
  } catch (err) {
    res = { ok: false, error: String(err?.message || err) };
  }

  if (res.ok && res.endpoints?.length) {
    const radios = [];
    for (const ep of res.endpoints) {
      const label = document.createElement('label');
      label.className = 'provider-item';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'provider';
      input.value = ep.providerName;
      const txt = document.createElement('span');
      txt.textContent = ep.providerName;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const bits = [];
      if (ep.official) bits.push('官方直连');
      if (ep.quantization) bits.push(ep.quantization);
      if (ep.uptime != null) bits.push(`可用率 ${(ep.uptime * 100).toFixed(0)}%`);
      meta.textContent = bits.join(' · ');
      label.append(input, txt, meta);
      input.addEventListener('change', () => {
        $$('.provider-item').forEach((el) => el.classList.toggle('checked', el.querySelector('input').checked));
        state.collect.provider = input.checked ? ep.providerName : null;
      });
      listEl.appendChild(label);
      radios.push({ input, ep });
    }
    const firstOfficial = radios.find((r) => r.ep.official) ?? radios[0];
    firstOfficial.input.checked = true;
    firstOfficial.input.dispatchEvent(new Event('change'));
    const nOfficial = res.endpoints.filter((e) => e.official).length;
    phint.textContent = nOfficial
      ? `共 ${res.endpoints.length} 个提供商，其中 ${nOfficial} 个为官方直连（已默认选中）。请求会用 provider.order 钉定，不会静默回退到第三方。`
      : `该模型没有官方直连提供商，默认选择可用率最高的一家。`;
  } else {
    state.collect.provider = null;
    phint.textContent = res.ok
      ? '该模型未返回提供商列表，将使用 OpenRouter 默认路由（优先官方）。'
      : `获取提供商列表失败（${res.error ?? '未知错误'}），将使用 OpenRouter 默认路由（优先官方）。`;
  }
  $('#collect-plan').style.display = 'block';
  $('#btn-collect').disabled = false;
}

/* ---------------- collect run ---------------- */
$('#btn-collect').addEventListener('click', async () => {
  const model = $('#cm-search').value.trim();
  const reps = parseInt($$('#cprofile-row input[name=cprofile]').find((r) => r.checked)?.value, 10) || 30;
  const concurrency = parseInt($('#c-concurrency').value, 10) || 6;
  if (!state.collect.key || !model || state.collect.running) return;

  state.collect.running = true;
  $('#btn-collect').disabled = true;
  $('#collect-result').style.display = 'none';

  const progress = $('#collect-progress');
  progress.style.display = 'block';
  $('#cp-model').textContent = `采集进度 — ${model}${state.collect.provider ? `（${state.collect.provider}）` : ''}`;
  $('#cp-fill').style.width = '0%';
  $('#cp-stats').innerHTML = '<span class="chip"><span class="spin"></span> 准备中…</span>';
  $('#cp-grid').innerHTML = '';
  cpGridReps = reps;
  cpGridBuilt = false;

  const { id } = await window.modelproof.collectStart({
    apiKey: state.collect.key,
    model,
    reps,
    concurrency,
    providerName: state.collect.provider,
  });
  state.collect.auditId = id;

  const off = window.modelproof.onCollectEvent((evt) => {
    if (evt.id !== id) return;
    if (evt.type === 'progress') {
      renderCollectProgress(evt);
    } else if (evt.type === 'done') {
      off();
      state.collect.running = false;
      state.collect.auditId = null;
      showCollectResult(model, evt);
    } else if (evt.type === 'error') {
      off();
      state.collect.running = false;
      state.collect.auditId = null;
      $('#collect-progress').style.display = 'none';
      $('#collect-result').style.display = 'block';
      $('#cr-title').textContent = '采集失败';
      $('#cr-summary').textContent = evt.message ?? '未知错误';
      $('#cr-actions').innerHTML = '';
      $('#btn-collect').disabled = false;
    }
  });
});

$('#btn-collect-cancel').addEventListener('click', async () => {
  if (state.collect.auditId) {
    $('#btn-collect-cancel').disabled = true;
    $('#btn-collect-cancel').textContent = '取消中…';
    await window.modelproof.collectCancel(state.collect.auditId);
  }
});

let cpGridReps = 30;
let cpGridBuilt = false;
function renderCollectProgress(evt) {
  const pct = Math.min(100, (evt.done / Math.max(1, evt.total)) * 100);
  $('#cp-fill').style.width = `${pct}%`;

  const stats = $('#cp-stats');
  stats.innerHTML = '';
  const chip = (text, cls = '') => {
    const c = document.createElement('span');
    c.className = `chip ${cls}`;
    c.textContent = text;
    stats.appendChild(c);
  };
  chip(`${evt.done} / ${evt.total} 请求`);
  chip(`有效 ${evt.valid}`, '');
  chip(`失败 ${evt.failed}`, evt.failed > evt.total * 0.1 ? 'bad' : '');
  chip(`无效 ${evt.invalid ?? 0}`, '');
  chip(`拒绝 ${evt.refusal ?? 0}`, '');

  if (!cpGridBuilt && evt.cellValid) {
    const grid = $('#cp-grid');
    grid.innerHTML = '';
    for (const [cellKey, n] of Object.entries(evt.cellValid)) {
      const cell = document.createElement('div');
      cell.className = 'cp-cell';
      cell.dataset.cell = cellKey;
      cell.title = cellKey;
      const fill = document.createElement('div');
      fill.style.transform = 'scaleY(0)';
      const nLabel = document.createElement('span');
      nLabel.className = 'n';
      nLabel.textContent = '0';
      cell.append(fill, nLabel);
      grid.appendChild(cell);
    }
    cpGridBuilt = true;
  }
  if (evt.cellValid) {
    for (const [cellKey, n] of Object.entries(evt.cellValid)) {
      const cell = $(`#cp-grid .cp-cell[data-cell="${CSS.escape(cellKey)}"]`);
      if (!cell) continue;
      const ratio = Math.min(1, n / Math.max(1, cpGridReps));
      cell.querySelector('div').style.transform = `scaleY(${ratio})`;
      cell.querySelector('.n').textContent = String(n);
      cell.classList.toggle('done', ratio >= 1);
    }
  }
}

function showCollectResult(model, evt) {
  $('#collect-progress').style.display = 'none';
  $('#btn-collect-cancel').disabled = false;
  $('#btn-collect-cancel').textContent = '取消';
  $('#btn-collect').disabled = false;

  const res = $('#collect-result');
  res.style.display = 'block';
  const s = evt.stats ?? {};
  const title = $('#cr-title');
  const summary = $('#cr-summary');
  const actions = $('#cr-actions');
  actions.innerHTML = '';

  if (evt.cancelled) {
    title.textContent = '采集已取消';
    summary.textContent = '没有保存任何数据（采集完成前取消不会写入指纹库）。';
    return;
  }

  if (evt.saved) {
    state.libLoaded = false; // library page will refetch
    title.textContent = `已存入「我的」指纹库 — ${model}`;
  } else {
    title.textContent = '采集完成，但未能保存';
    summary.textContent = '有效答案为 0，未写入指纹库。请检查模型是否可用。';
    return;
  }

  const bits = [
    `有效答案 ${s.totalValid ?? 0}`,
    `充足维度 ${s.sufficientCells ?? 0}/40`,
    `请求成功 ${s.ok ?? 0} / 失败 ${s.failed ?? 0}`,
    `耗时 ${Math.round((s.elapsedMs ?? 0) / 1000)}s`,
  ];
  summary.textContent = bits.join(' · ');
  if ((s.sufficientCells ?? 0) < 8) {
    summary.textContent += '。注意：充足维度不足 8 个，该指纹用于检测比对时可靠性有限，建议用论文级档重采。';
  }

  const goBtn = document.createElement('button');
  goBtn.className = 'primary';
  goBtn.textContent = '前往「指纹库」查看';
  goBtn.addEventListener('click', () => {
    state.libFilter = 'user';
    $$('#lib-filter button').forEach((b) => b.classList.toggle('active', b.dataset.filter === 'user'));
    gotoTab('library'); // nav handler loads the library when stale/empty
    if (state.libLoaded) renderLibrary();
  });
  const againBtn = document.createElement('button');
  againBtn.className = 'ghost';
  againBtn.textContent = '再采集一个模型';
  againBtn.addEventListener('click', () => {
    res.style.display = 'none';
    $('#cm-search').value = '';
    state.collect.model = null;
    state.collect.provider = null;
    $('#provider-panel').style.display = 'none';
    $('#collect-plan').style.display = 'none';
    $('#btn-collect').disabled = true;
    $('#cm-search').focus();
  });
  actions.append(goBtn, againBtn);
}

/* ---------------- auto-updater ---------------- */
(function initUpdater() {
  const updateBtn = $('#update-action-btn');
  const updateText = $('#update-text');
  const progressBar = $('#update-progress-bar');
  if (!updateBtn || !window.modelproof?.onUpdateEvent) return;

  let updateInfo = null;
  let isDownloading = false;

  window.modelproof.onUpdateEvent((evt) => {
    if (evt.type === 'available') {
      updateInfo = evt;
      updateBtn.style.display = 'flex';
      updateBtn.className = 'update-action-btn';
      updateText.textContent = `升级至 v${evt.version}`;
      updateBtn.title = `发现新版本 v${evt.version}，点击自动安装更新并重启`;
    } else if (evt.type === 'downloading' || evt.type === 'progress') {
      isDownloading = true;
      updateBtn.style.display = 'flex';
      updateBtn.classList.add('downloading');
      const pct = evt.percent ?? 0;
      progressBar.style.width = `${pct}%`;
      updateText.textContent = `下载中 ${pct}%`;
      updateBtn.title = `正在下载更新 (${pct}%)，完成后将自动重启并完成安装`;
    } else if (evt.type === 'downloaded' || evt.type === 'installing') {
      isDownloading = false;
      updateBtn.classList.remove('downloading');
      updateBtn.classList.add('installing');
      progressBar.style.width = '100%';
      updateText.textContent = '正在安装并重启...';
      updateBtn.title = '更新安装包已就绪，正在静默安装并重启应用...';
    } else if (evt.type === 'dev-mode-installed') {
      isDownloading = false;
      updateBtn.classList.remove('downloading', 'installing');
      updateText.textContent = '已就绪 (开发模式)';
      alert(evt.message || '开发模式下已下载更新文件，在打包版本中会自动静默安装并重启。');
    } else if (evt.type === 'error') {
      isDownloading = false;
      updateBtn.classList.remove('downloading', 'installing');
      updateText.textContent = '更新重试';
      updateBtn.title = `更新失败: ${evt.message || '未知错误'}，点击重试`;
    }
  });

  updateBtn.addEventListener('click', async () => {
    if (isDownloading) return;
    updateText.textContent = '准备下载...';
    updateBtn.classList.add('downloading');
    progressBar.style.width = '0%';
    try {
      const res = await window.modelproof.startInstallUpdate();
      if (res && res.error) {
        alert(`自动更新失败: ${res.error}`);
        updateText.textContent = '更新重试';
        updateBtn.classList.remove('downloading');
      }
    } catch (err) {
      alert(`自动更新异常: ${err?.message || err}`);
      updateText.textContent = '更新重试';
      updateBtn.classList.remove('downloading');
    }
  });

  const appVerEl = $('#app-version');
  const btnCheck = $('#btn-manual-check');

  if (window.modelproof?.appInfo) {
    window.modelproof.appInfo().then((info) => {
      if (info?.versions?.app && appVerEl) {
        appVerEl.textContent = info.versions.app;
      }
    }).catch(() => {});
  }

  if (btnCheck) {
    btnCheck.addEventListener('click', async (e) => {
      e.preventDefault();
      btnCheck.textContent = '正在检查…';
      try {
        const res = await window.modelproof.checkForUpdates();
        if (res.state === 'available') {
          btnCheck.textContent = `发现新版本 v${res.updateInfo?.version || ''}`;
        } else if (res.state === 'idle') {
          btnCheck.textContent = '当前已是最新版本';
          setTimeout(() => { btnCheck.textContent = '立即检查更新'; }, 3000);
        } else if (res.state === 'error') {
          btnCheck.textContent = '检查失败，点击重试';
        }
      } catch {
        btnCheck.textContent = '检查异常，点击重试';
      }
    });
  }
})();

