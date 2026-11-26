const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  onStatus: (cb) => ipcRenderer.on('status', (_e, msg) => cb(msg)),
  pathForFile: (file) => webUtils.getPathForFile(file),
});
