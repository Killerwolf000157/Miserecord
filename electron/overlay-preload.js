// The in-game overlay window's only bridge: it receives who's in the call.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onData(callback) {
    ipcRenderer.on('overlay-data', (_e, data) => callback(data));
  },
});
