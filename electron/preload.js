// Bridge between the Miserecord web app and the desktop shell.
// Exposes a small, fixed API; the page gets no Node.js access.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miserecordDesktop', {
  info: () => ipcRenderer.invoke('app-info'),

  // Screen picker: the main process asks, the page answers with a source id.
  onPickSource(callback) {
    ipcRenderer.on('pick-source', (_e, request) => callback(request));
  },
  pickSource(requestId, sourceId, audio) {
    ipcRenderer.send(`source-picked-${Number(requestId)}`, sourceId ? { sourceId: String(sourceId), audio: !!audio } : null);
  },

  // Updates
  onUpdateStatus(callback) {
    ipcRenderer.on('update-status', (_e, status) => callback(status));
  },
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  installUpdate: () => ipcRenderer.send('install-update'),

  // Calls
  incomingCall: (name) => ipcRenderer.send('incoming-call', String(name || '')),
  callAnswered: () => ipcRenderer.send('call-answered'),
});
