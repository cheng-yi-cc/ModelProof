import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, writeFile, existsSync, renameSync } from 'node:fs';
import { RelayClient } from '../core/client.js';
import { AuditRunner } from '../core/audit.js';
import { analyze } from '../core/analyze.js';
import { FingerprintCollector, inferFamily } from '../core/collector.js';
import { AppUpdater } from './updater.js';

let mainWindow = null;
let updater = null;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const refDb = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'reference-fingerprints.json'), 'utf8'));
const distanceContext = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'distance-context.json'), 'utf8'));

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const runners = new Map(); // auditId -> AuditRunner
const collectors = new Map(); // collectId -> FingerprintCollector
let auditSeq = 0;
let collectSeq = 0;

/* ---------------- user fingerprint library (userData) ---------------- */

const userLibPath = () => path.join(app.getPath('userData'), 'user-fingerprints.json');

function loadUserDb() {
  try {
    const db = JSON.parse(readFileSync(userLibPath(), 'utf8'));
    if (db && typeof db === 'object' && db.models && typeof db.models === 'object') return db;
  } catch { /* first run / corrupted -> start fresh */ }
  return { version: 1, models: {} };
}

function persistUserDb(db) {
  const tmp = `${userLibPath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  renameSync(tmp, userLibPath());
}

function mergedRefDb() {
  const user = loadUserDb();
  const models = {};
  for (const [id, entry] of Object.entries(refDb.models)) {
    models[id] = { ...entry, source: 'official' };
  }
  // User-collected entries win on ID collisions: they were measured against
  // OpenRouter official routing and are the fresher evidence.
  for (const [id, entry] of Object.entries(user.models)) {
    models[id] = { ...entry, source: 'user' };
  }
  return { meta: { ...refDb.meta, n_models: Object.keys(models).length }, models };
}

/* ---------------- OpenRouter helpers ---------------- */

async function orFetch(apiKey, urlPath) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(`${OPENROUTER_BASE}${urlPath}`, {
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) {
      return { ok: false, status: r.status, error: j?.error?.message ?? text.slice(0, 300) };
    }
    return { ok: true, json: j };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '连接超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// Vendor-name → OpenRouter provider_name prefixes considered "official"
// (the vendor's own first-party endpoint).
const OFFICIAL_PROVIDER_KEYS = {
  openai: ['openai'],
  anthropic: ['anthropic'],
  google: ['google'],
  'meta-llama': ['meta'],
  mistralai: ['mistral'],
  deepseek: ['deepseek'],
  qwen: ['alibaba', 'qwen'],
  'z-ai': ['z.ai', 'zai'],
  'x-ai': ['xai'],
  moonshotai: ['moonshot'],
  minimax: ['minimax'],
  perplexity: ['perplexity'],
  cohere: ['cohere'],
  'amazon-nova': ['amazon', 'bedrock'],
  microsoft: ['azure', 'microsoft'],
  nvidia: ['nvidia'],
  liquid: ['liquid'],
  ai21: ['ai21'],
};

function isOfficialProvider(authorSlug, providerName) {
  const p = String(providerName ?? '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  if (!p) return false;
  const author = String(authorSlug ?? '').toLowerCase();
  let keys = OFFICIAL_PROVIDER_KEYS[author];
  if (!keys) {
    const seg = author.split(/[-_]/)[0];
    keys = seg.length >= 4 ? [seg] : []; // generic fallback, conservative
  }
  return keys.some((k) => p.startsWith(k) || p.includes(k));
}

function sender() {
  return BrowserWindow.getAllWindows()[0]?.webContents ?? null;
}

/* ---------------- window ---------------- */

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 660,
    title: 'ModelProof — 中转站模型身份辨认',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on('did-finish-load', () => {
    // 启动后延迟 1.5 秒开机自动检测更新，确保界面渲染平稳
    setTimeout(() => {
      updater?.checkForUpdates({ silent: true });
    }, 1500);
  });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  updater = new AppUpdater({
    currentVersion: app.getVersion(),
    getWindow: () => mainWindow,
  });

  ipcMain.handle('updater:check', () => updater.checkForUpdates({ silent: false }));
  ipcMain.handle('updater:install', () => updater.downloadAndInstall());
  ipcMain.handle('updater:status', () => updater.getState());
  ipcMain.handle('app:info', () => {
    const user = loadUserDb();
    return {
      versions: { electron: process.versions.electron, node: process.versions.node, app: app.getVersion() },
      refMeta: {
        ...refDb.meta,
        distances: undefined,
        impostorMedian: distanceContext.median,
        impostorP05: distanceContext.p05,
        nImpostorPairs: distanceContext.n_pairs,
      },
      userLibCount: Object.keys(user.models).length,
    };
  });

  /* ---- relay audit (unchanged flow, merged library) ---- */

  ipcMain.handle('relay:connect', async (_e, { baseUrl, apiKey }) => {
    try {
      const client = new RelayClient({ baseUrl, apiKey });
      return await client.listModels();
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('audit:start', (_e, cfg) => {
    const id = `audit-${++auditSeq}`;
    const db = mergedRefDb();
    const runner = new AuditRunner({
      ...cfg,
      onEvent: (evt) => {
        const s = sender();
        if (s && !s.isDestroyed()) s.send('audit:event', { id, ...evt });
      },
    });
    runners.set(id, runner);

    (async () => {
      let payload;
      try {
        const result = await runner.run();
        const analysis = result.cancelled
          ? null
          : analyze({
              fingerprint: result.fingerprint,
              refDb: db,
              context: distanceContext,
              claimedModel: cfg.model,
            });
        payload = {
          type: 'done',
          id,
          cancelled: result.cancelled,
          fingerprint: result.fingerprint,
          diagnostics: result.diagnostics,
          progress: result.progress,
          analysis,
        };
      } catch (err) {
        payload = { type: 'error', id, message: String(err?.message || err) };
      }
      runners.delete(id);
      const s = sender();
      if (s && !s.isDestroyed()) s.send('audit:event', { id, ...payload });
    })();

    return { ok: true, id };
  });

  ipcMain.handle('audit:cancel', (_e, { id }) => {
    runners.get(id)?.cancel();
    return { ok: true };
  });

  /* ---- OpenRouter: models + provider endpoints ---- */

  ipcMain.handle('or:models', async (_e, { apiKey }) => {
    const r = await orFetch(apiKey, '/models');
    if (!r.ok) return r;
    const arr = Array.isArray(r.json?.data) ? r.json.data : [];
    const models = arr
      .filter((m) => m?.id)
      .map((m) => ({ id: m.id, name: m.name ?? m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, models };
  });

  ipcMain.handle('or:endpoints', async (_e, { apiKey, model }) => {
    const r = await orFetch(apiKey, `/models/${encodeURIComponent(String(model).trim())}/endpoints`);
    if (!r.ok) return { ok: false, error: r.error, status: r.status };
    const data = r.json?.data ?? {};
    const rawList = Array.isArray(data.endpoints) ? data.endpoints : [];
    const author = String(model).split('/')[0];
    const endpoints = rawList
      .map((ep) => ({
        providerName: ep.provider_name ?? ep.name ?? 'unknown',
        quantization: ep.quantization ?? null,
        status: ep.status ?? null,
        uptime: ep.uptime_last_30m ?? ep.uptime ?? null,
        official: isOfficialProvider(author, ep.provider_name ?? ep.name),
      }))
      .sort((a, b) => Number(b.official) - Number(a.official) || (b.uptime ?? 0) - (a.uptime ?? 0));
    return { ok: true, canonicalSlug: data.canonical_slug ?? null, endpoints };
  });

  /* ---- fingerprint collection into the user library ---- */

  ipcMain.handle('collect:start', (_e, { apiKey, model, reps, concurrency, providerName }) => {
    const id = `collect-${++collectSeq}`;
    const client = new RelayClient({ baseUrl: OPENROUTER_BASE, apiKey, timeoutMs: 45000 });
    const collector = new FingerprintCollector({
      client,
      modelId: model,
      reps,
      concurrency,
      providerName: providerName || null,
    });
    collectors.set(id, collector);

    (async () => {
      let payload;
      try {
        const result = await collector.run((evt) => {
          const s = sender();
          if (s && !s.isDestroyed()) s.send('collect:event', { id, ...evt });
        });
        payload = { type: 'done', id, ...result };
        if (!result.cancelled && result.stats.totalValid > 0) {
          const user = loadUserDb();
          user.models[model] = {
            family: inferFamily(model),
            cells: result.fingerprint,
            source: 'user',
            meta: {
              totalValid: result.stats.totalValid,
              sufficientCells: result.stats.sufficientCells,
              reps: result.stats.reps,
              provider: providerName ?? null,
              totalRequests: result.stats.totalRequests,
              collected_utc: result.stats.finishedUtc,
            },
          };
          persistUserDb(user);
          payload.saved = true;
        }
      } catch (err) {
        payload = { type: 'error', id, message: String(err?.message || err) };
      }
      collectors.delete(id);
      const s = sender();
      if (s && !s.isDestroyed()) s.send('collect:event', { id, ...payload });
    })();

    return { ok: true, id };
  });

  ipcMain.handle('collect:cancel', (_e, { id }) => {
    collectors.get(id)?.cancel();
    return { ok: true };
  });

  /* ---- library access ---- */

  ipcMain.handle('library:all', () => {
    const user = loadUserDb();
    return {
      official: { meta: refDb.meta, models: refDb.models },
      user: { models: user.models },
    };
  });

  ipcMain.handle('library:user:delete', (_e, { id }) => {
    const user = loadUserDb();
    if (user.models[id]) {
      delete user.models[id];
      persistUserDb(user);
    }
    return { ok: true, count: Object.keys(user.models).length };
  });

  ipcMain.handle('report:save', async (_e, { defaultName, content }) => {
    const { dialog } = await import('electron');
    const win = BrowserWindow.getAllWindows()[0];
    const r = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
    });
    if (r.canceled || !r.filePath) return { ok: false };
    await new Promise((resolve, reject) =>
      writeFile(r.filePath, content, 'utf8', (err) => (err ? reject(err) : resolve()))
    );
    return { ok: true, path: r.filePath };
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const r of runners.values()) r.cancel();
  for (const c of collectors.values()) c.cancel();
  if (process.platform !== 'darwin') app.quit();
});
