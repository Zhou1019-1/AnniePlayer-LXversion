'use strict';
// SVLX 启动器 preload —— 仅暴露白名单 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('svlx', {
  launchAnnie: () => ipcRenderer.invoke('svlx:launch-annie'),
  launchLX: () => ipcRenderer.invoke('svlx:launch-lx'),
  lxStatus: () => ipcRenderer.invoke('svlx:lx-status'),
  version: () => ipcRenderer.invoke('svlx:version'),
  winMin: () => ipcRenderer.invoke('svlx:win-min'),
  winClose: () => ipcRenderer.invoke('svlx:win-close'),
  openThirdParty: () => ipcRenderer.invoke('svlx:open-thirdparty')
});
