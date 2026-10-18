// Miserecord desktop app (Electron main process).
//
// - Serves the web app from app://miserecord/ so it has one fixed origin:
//   your name, settings and saved friends persist across restarts and updates.
// - Grants microphone and screen-capture permissions to the app itself.
// - Replaces the browser's screen picker with an in-app picker, including
//   full system audio on Windows.
// - Checks GitHub Releases for updates, downloads them in the background and
//   installs on restart.
'use strict';

const { app, BrowserWindow, Notification, desktopCapturer, ipcMain, nativeTheme, net, protocol, session, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_ORIGIN = 'app://miserecord';
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
// Only the app's own files run; the network is limited to relays (wss).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// One window only: opening the app again focuses the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start);
}

app.on('window-all-closed', () => app.quit());

let mainWindow = null;

function start() {
  app.setAppUserModelId('com.killerwolf000157.miserecord');

  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });

  setupPermissions(session.defaultSession);
  setupScreenPicker(session.defaultSession);
  createWindow();
  setupUpdates();

  ipcMain.handle('app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
  ipcMain.on('incoming-call', (_e, name) => notifyIncoming(String(name || 'Your friend').slice(0, 32)));
  ipcMain.on('call-answered', () => { if (mainWindow) mainWindow.flashFrame(false); });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: 'Miserecord',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#F5F5F7',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // Calls keep working while the window is in the background.
      backgroundThrottling: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`${APP_ORIGIN}/`);
  mainWindow.on('closed', () => { mainWindow = null; });

  // Links open in the real browser; the app never navigates away from itself.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
  });
}

function fromApp(webContentsOrOrigin) {
  const origin = typeof webContentsOrOrigin === 'string' ? webContentsOrOrigin : webContentsOrOrigin && webContentsOrOrigin.getURL();
  return !!origin && origin.startsWith(APP_ORIGIN);
}

function setupPermissions(ses) {
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'clipboard-read', 'notifications', 'fullscreen', 'speaker-selection']);
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(fromApp(wc) && allowed.has(permission)));
  ses.setPermissionCheckHandler((wc, permission, origin) => fromApp(origin || wc) && allowed.has(permission));
  ses.setDevicePermissionHandler(() => false);
}

// ---------------------------------------------------------------- screen picker
let pickerSeq = 0;

function setupScreenPicker(ses) {
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });
      const id = ++pickerSeq;
      const list = sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
      }));
      mainWindow.webContents.send('pick-source', { id, sources: list, canShareAudio: process.platform === 'win32' });
      ipcMain.once(`source-picked-${id}`, (_e, choice) => {
        const source = choice && sources.find((s) => s.id === choice.sourceId);
        if (!source) return callback({});
        // On Windows, "loopback" captures everything you hear: games, music, videos.
        callback(choice.audio && process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
      });
    } catch (err) {
      console.error('screen picker failed', err);
      callback({});
    }
  });
}

// ---------------------------------------------------------------- incoming calls
let callNotification = null;

function notifyIncoming(name) {
  if (!mainWindow) return;
  if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
  if (mainWindow.isFocused() || !Notification.isSupported()) return;
  if (callNotification) callNotification.close();
  callNotification = new Notification({ title: `${name} is calling`, body: 'Click to open Miserecord and answer.', silent: true });
  callNotification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  callNotification.show();
}

// ---------------------------------------------------------------- updates
function setupUpdates() {
  if (!app.isPackaged) return; // updates only make sense for the installed app
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (status, extra = {}) => { if (mainWindow) mainWindow.webContents.send('update-status', { status, ...extra }); };
  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => send('downloading', { version: info.version }));
  autoUpdater.on('update-not-available', () => send('current'));
  autoUpdater.on('download-progress', (p) => send('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('ready', { version: info.version }));
  autoUpdater.on('error', (err) => send('error', { message: err ? String(err.message).split('\n')[0].slice(0, 200) : 'unknown error' }));

  ipcMain.on('check-for-updates', () => autoUpdater.checkForUpdates().catch(() => {}));
  ipcMain.on('install-update', () => autoUpdater.quitAndInstall(false, true));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, UPDATE_CHECK_MS);
}
