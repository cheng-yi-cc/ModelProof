// Sandboxed renderers require CommonJS preloads — hence .cjs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modelproof', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  connect: (baseUrl, apiKey) => ipcRenderer.invoke('relay:connect', { baseUrl, apiKey }),
  startAudit: (cfg) => ipcRenderer.invoke('audit:start', cfg),
  cancelAudit: (id) => ipcRenderer.invoke('audit:cancel', { id }),
  saveReport: (defaultName, content) => ipcRenderer.invoke('report:save', { defaultName, content }),
  onAuditEvent: (cb) => {
    const listener = (_e, evt) => cb(evt);
    ipcRenderer.on('audit:event', listener);
    return () => ipcRenderer.removeListener('audit:event', listener);
  },
  // OpenRouter fingerprint collection
  orModels: (apiKey) => ipcRenderer.invoke('or:models', { apiKey }),
  orEndpoints: (apiKey, model) => ipcRenderer.invoke('or:endpoints', { apiKey, model }),
  collectStart: (cfg) => ipcRenderer.invoke('collect:start', cfg),
  collectCancel: (id) => ipcRenderer.invoke('collect:cancel', { id }),
  onCollectEvent: (cb) => {
    const listener = (_e, evt) => cb(evt);
    ipcRenderer.on('collect:event', listener);
    return () => ipcRenderer.removeListener('collect:event', listener);
  },
  // Fingerprint library
  libraryAll: () => ipcRenderer.invoke('library:all'),
  libraryDelete: (id) => ipcRenderer.invoke('library:user:delete', { id }),
  // Auto-updater
  onUpdateEvent: (cb) => {
    const listener = (_e, evt) => cb(evt);
    ipcRenderer.on('updater:event', listener);
    return () => ipcRenderer.removeListener('updater:event', listener);
  },
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdateStatus: () => ipcRenderer.invoke('updater:status'),
});
