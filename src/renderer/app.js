// ModelProof renderer — all UI logic. Talks to main process exclusively via
// window.modelproof (contextBridge).
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const LANG_LABEL = { en: '英语', ru: '俄语', zh: '中文', ar: '阿拉伯语' };
const PROFILES = {
  quick: { langs: ['en'], reps: 10 },
  standard: { langs: ['en', 'ru', 'zh', 'ar'], reps: 12 },
  strict: { langs: ['en', 'ru', 'zh', 'ar'], reps: 25 },
};

const state = {
  conn: null,
  models: [],
  selected: new Set(),
  items: [], // {key, model, state, progress, fingerprint, diagnostics, analysis, error}
  detailKey: null,
  pumping: false,
};

let itemSeq = 0;

/* ---------------- tabs ---------------- */
$$('nav button').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('nav button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
  })
);
function gotoTab(name) {
  $$('nav button').find((b) => b.dataset.tab === name)?.click();
}

/* ---------------- connect ---------------- */
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
    $('#conn-state').textContent = '未连接';
    hint.textContent = `连接失败：${res.error}`;
    return;
  }
  state.conn = { baseUrl: res.base ?? baseUrl, apiKey };
  state.models = res.models;
  renderModelList();
  $('#model-panel').style.display = 'block';
  $('#conn-state').textContent = `已连接 · ${res.models.length} 个模型`;
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
function entropyBits(p) {
  let h = 0;
  for (const v of Object.values(p)) if (v > 0) h -= v * Math.log2(v);
  return h;
}

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
    name.textContent = `${i + 1}. ${t.model}`;
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
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = '各维度明细（展开查看原始分布）';
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
  const fp = item.fingerprint ?? {};
  for (const key of Object.keys(fp).sort()) {
    const cell = fp[key];
    const top3 = Object.entries(cell.p)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([ans, pr]) => `${ans} ${(pr * 100).toFixed(0)}%`)
      .join(', ');
    const tr = document.createElement('tr');
    for (const tdText of [key, String(cell.n), entropyBits(cell.p).toFixed(2), top3]) {
      const td = document.createElement('td');
      td.textContent = tdText;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  det.appendChild(table);
  cellsCard.appendChild(det);
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
          t.model
        }</td><td>${t.jsd.toFixed(4)}</td><td>${t.usableCells}</td></tr>`
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
