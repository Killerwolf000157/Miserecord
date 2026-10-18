// Bridge between the Miserecord web app and the desktop shell.
// Exposes a small, fixed API; the page gets no Node.js access.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miserecordDesktop', {
  info: () => ipcRenderer.invoke('app-info'),

  // The window buttons are drawn over the page's own top bar.
  ownTitleBar: process.platform === 'win32', // same rule as OWN_TITLE_BAR in main.js
  setTitleBarTheme: (dark) => ipcRenderer.send('title-bar-theme', !!dark),
  setLanguage: (lang) => ipcRenderer.send('set-language', String(lang)),

  // Screen picker: the main process asks, the page answers with a source id.
  onPickSource(callback) {
    ipcRenderer.on('pick-source', (_e, request) => callback(request));
  },
  // The list of screens and windows, sent once without and once with thumbnails.
  onPickSources(callback) {
    ipcRenderer.on('pick-sources', (_e, update) => callback(update));
  },
  pickSource(requestId, sourceId, audio) {
    ipcRenderer.send(`source-picked-${Number(requestId)}`, sourceId ? { sourceId: String(sourceId), audio: !!audio } : null);
  },

  // Updates
  onUpdateStatus(callback) {
    ipcRenderer.on('update-status', (_e, status) => callback(status));
  },
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  uninstall: (deleteData) => ipcRenderer.invoke('uninstall', { deleteData: !!deleteData }),
  installUpdate: () => ipcRenderer.send('install-update'),

  // Calls
  incomingCall: (name) => ipcRenderer.send('incoming-call', String(name || '')),
  callAnswered: () => ipcRenderer.send('call-answered'),

  // Background mode and starting with Windows
  prefs: () => ipcRenderer.invoke('desktop-prefs'),
  setPref: (key, value) => ipcRenderer.invoke('set-desktop-pref', String(key), !!value),

  // Global hotkeys: bindings go to the main process, presses come back.
  setHotkeys: (bindings) => ipcRenderer.send('set-hotkeys', bindings),
  onHotkey(callback) {
    ipcRenderer.on('hotkey', (_e, event) => callback(event));
  },
});
