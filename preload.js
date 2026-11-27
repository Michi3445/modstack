const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  onStatus: (cb) => ipcRenderer.on('status', (_e, msg) => cb(msg)),
  onFriendChat: (cb) => ipcRenderer.on('friendChat', (_e, msg) => cb(msg)),
  onPackSyncChanged: (cb) => ipcRenderer.on('packSyncChanged', (_e, id) => cb(id)),
  onPlaytimeClose: (cb) => ipcRenderer.on('playtimeClose', () => cb()),
  onMinecraftPreparation: (cb) => ipcRenderer.on('minecraftPreparation', (_e, info) => cb(info)),
  pathForFile: (file) => webUtils.getPathForFile(file),
});
