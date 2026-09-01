import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFile } from 'node:fs';
import { RelayClient } from '../core/client.js';
import { AuditRunner } from '../core/audit.js';
import { analyze } from '../core/analyze.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const refDb = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'reference-fingerprints.json'), 'utf8'));
const distanceContext = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'distance-context.json'), 'utf8'));

const runners = new Map(); // auditId -> AuditRunner
let auditSeq = 0;

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'ModelProof — 中转站模型身份辨认',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('app:info', () => ({
    versions: { electron: process.versions.electron, node: process.versions.node },
    refMeta: {
      ...refDb.meta,
      distances: undefined,
      impostorMedian: distanceContext.median,
      impostorP05: distanceContext.p05,
      nImpostorPairs: distanceContext.n_pairs,
    },
  }));

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
    const sender = BrowserWindow.getAllWindows()[0]?.webContents;
    const runner = new AuditRunner({
      ...cfg,
      onEvent: (evt) => {
        if (sender && !sender.isDestroyed()) sender.send('audit:event', { id, ...evt });
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
              refDb,
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
      if (sender && !sender.isDestroyed()) sender.send('audit:event', { id, ...payload });
    })();

    return { ok: true, id };
  });

  ipcMain.handle('audit:cancel', (_e, { id }) => {
    runners.get(id)?.cancel();
    return { ok: true };
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
  if (process.platform !== 'darwin') app.quit();
});
