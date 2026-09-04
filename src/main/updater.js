import { app, BrowserWindow } from 'electron';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseSemver, compareSemver, findPlatformAsset } from '../core/updater-core.js';

const GITHUB_REPO = 'cheng-yi-cc/ModelProof';
const API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export { parseSemver, compareSemver, findPlatformAsset };

export class AppUpdater {
  constructor({ currentVersion = null, getWindow = null } = {}) {
    this.currentVersion = currentVersion || (app?.getVersion ? app.getVersion() : '0.1.0');
    this.getWindow = getWindow;
    this.state = 'idle'; // idle | checking | available | downloading | downloaded | error
    this.updateInfo = null; // { version, releaseNotes, asset, publishedAt }
    this.downloadedPath = null;
    this.abortController = null;
    this.lastProgressEmit = 0;
    this.autoInstallWhenReady = false;
  }

  emit(type, payload = {}) {
    const win = this.getWindow ? this.getWindow() : BrowserWindow.getAllWindows()[0];
    const s = win?.webContents;
    if (s && !s.isDestroyed()) {
      s.send('updater:event', { type, state: this.state, ...payload });
    }
  }

  getState() {
    return {
      state: this.state,
      currentVersion: this.currentVersion,
      updateInfo: this.updateInfo,
      downloadedPath: this.downloadedPath,
    };
  }

  async checkForUpdates({ silent = true } = {}) {
    if (this.state === 'downloading') return this.getState();

    this.state = 'checking';
    this.emit('checking');

    try {
      const resp = await fetch(API_URL, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': `ModelProof/${this.currentVersion}`,
        },
      });

      if (!resp.ok) {
        throw new Error(`GitHub API error HTTP ${resp.status}`);
      }

      const release = await resp.json();
      const remoteTag = release.tag_name || '';
      const remoteVersion = remoteTag.replace(/^[vV]/, '');

      if (compareSemver(remoteVersion, this.currentVersion) > 0) {
        const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
        const asset = findPlatformAsset(release.assets, process.platform, process.arch, isPortable);
        this.updateInfo = {
          version: remoteVersion,
          tag: remoteTag,
          releaseNotes: release.body || '',
          htmlUrl: release.html_url,
          publishedAt: release.published_at,
          asset: asset
            ? {
                name: asset.name,
                size: asset.size,
                downloadUrl: asset.browser_download_url,
              }
            : null,
        };
        this.state = 'available';
        this.emit('available', this.updateInfo);
        return this.getState();
      }

      this.state = 'idle';
      this.updateInfo = null;
      this.emit('not-available', { currentVersion: this.currentVersion });
      return this.getState();
    } catch (err) {
      this.state = 'error';
      const message = String(err?.message || err);
      if (!silent) console.error('[updater] check error:', message);
      this.emit('error', { message });
      return { state: 'error', message };
    }
  }

  async downloadAndInstall() {
    this.autoInstallWhenReady = true;

    if (this.state === 'downloaded' && this.downloadedPath) {
      return this.install();
    }

    if (this.state === 'downloading') {
      return { ok: true, message: 'downloading' };
    }

    if (!this.updateInfo?.asset?.downloadUrl) {
      const checkRes = await this.checkForUpdates({ silent: false });
      if (checkRes.state !== 'available' || !this.updateInfo?.asset?.downloadUrl) {
        return { ok: false, error: '没有检测到可用的更新安装包' };
      }
    }

    return this.downloadUpdate();
  }

  async downloadUpdate() {
    const asset = this.updateInfo?.asset;
    if (!asset?.downloadUrl) {
      return { ok: false, error: '无可下载的安装包' };
    }

    this.state = 'downloading';
    this.emit('downloading', { percent: 0, transferred: 0, total: asset.size });

    const tempDir = app?.getPath ? app.getPath('temp') : process.env.TEMP || '.';
    const targetFile = path.join(tempDir, asset.name || `ModelProof-Update-${this.updateInfo.version}.exe`);
    this.downloadedPath = targetFile;

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    try {
      const resp = await fetch(asset.downloadUrl, {
        signal,
        headers: {
          'User-Agent': `ModelProof/${this.currentVersion}`,
        },
      });

      if (!resp.ok) {
        throw new Error(`下载失败: HTTP ${resp.status}`);
      }

      const totalBytes = Number(resp.headers.get('content-length')) || asset.size || 0;
      let transferredBytes = 0;
      const fileStream = createWriteStream(targetFile);

      const reader = resp.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        fileStream.write(Buffer.from(value));
        transferredBytes += value.length;

        const now = Date.now();
        if (now - this.lastProgressEmit > 150 || transferredBytes === totalBytes) {
          this.lastProgressEmit = now;
          const percent = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0;
          this.emit('progress', { percent, transferred: transferredBytes, total: totalBytes });
        }
      }

      await new Promise((resolve, reject) => {
        fileStream.end((err) => (err ? reject(err) : resolve()));
      });

      this.state = 'downloaded';
      this.emit('downloaded', {
        version: this.updateInfo.version,
        path: targetFile,
      });

      if (this.autoInstallWhenReady) {
        return this.install();
      }

      return { ok: true, path: targetFile };
    } catch (err) {
      if (signal.aborted) {
        this.state = 'available';
        this.emit('available', this.updateInfo);
        return { ok: false, cancelled: true };
      }
      this.state = 'error';
      const message = String(err?.message || err);
      this.emit('error', { message });
      return { ok: false, error: message };
    }
  }

  install() {
    if (!this.downloadedPath || !existsSync(this.downloadedPath)) {
      this.state = 'error';
      const msg = '更新文件未就绪或已被移除';
      this.emit('error', { message: msg });
      return { ok: false, error: msg };
    }

    this.state = 'installing';
    this.emit('installing', { version: this.updateInfo?.version });

    const isPackaged = app?.isPackaged ?? false;

    if (!isPackaged) {
      console.log('[updater] 开发模式：已下载更新文件至', this.downloadedPath);
      this.emit('dev-mode-installed', {
        message: '开发模式下模拟更新完成：打包环境下将自动静默安装并重启',
        path: this.downloadedPath,
      });
      return { ok: true, devMode: true, path: this.downloadedPath };
    }

    if (process.platform === 'win32') {
      const appExe = process.execPath;
      const installer = this.downloadedPath;
      // PowerShell command: wait 1.5s for ModelProof to exit, run installer with /S, then relaunch ModelProof.exe
      const psCmd = `Start-Sleep -Milliseconds 1500; Start-Process -FilePath '${installer.replace(/'/g, "''")}' -ArgumentList '/S' -Wait; Start-Process -FilePath '${appExe.replace(/'/g, "''")}'`;

      try {
        const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psCmd], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        setTimeout(() => app.quit(), 300);
        return { ok: true, restarting: true };
      } catch (e) {
        // Fallback: spawn installer directly
        spawn(installer, ['/S'], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => app.quit(), 300);
        return { ok: true, restarting: true };
      }
    } else if (process.platform === 'darwin') {
      // macOS: open downloaded dmg / installer
      spawn('open', [this.downloadedPath], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, restarting: true };
    } else {
      // Linux AppImage / deb: execute
      spawn(this.downloadedPath, [], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, restarting: true };
    }
  }
}
