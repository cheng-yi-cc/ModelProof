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
});
