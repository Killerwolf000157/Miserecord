// Miserecord desktop app (Electron main process).
//
// - Serves the web app from app://miserecord/ so it has one fixed origin:
//   your name, settings and saved friends persist across restarts and updates.
// - Grants microphone and screen-capture permissions to the app itself.
// - Replaces the browser's screen picker with an in-app picker, including
//   full system audio on Windows.
// - Keeps running in the tray when the window is closed, so calls still reach
//   you, and can start hidden with Windows.
// - Global hotkeys and push-to-talk that work while other apps (games) are focused.
// - Checks GitHub Releases for updates, downloads them in the background and
//   installs on restart.
'use strict';

const {
  app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, ipcMain, nativeImage, nativeTheme, net, protocol, session, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Windows picks the right size (16–256 px) from the .ico for taskbar, title bar and tray.
const ICON = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const APP_ORIGIN = 'app://miserecord';
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
const START_HIDDEN = process.argv.includes('--hidden');
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

let mainWindow = null;
let tray = null;
let quitting = false;

// The development version (npm start) keeps its own data and its own
// single-instance lock, so it runs next to the installed app instead of just
// bringing that one to the front, and the two never share friends or settings.
if (!app.isPackaged) {
  // MISERECORD_PROFILE gives test runs their own data again, so they can run
  // while the dev window is open.
  const profile = process.env.MISERECORD_PROFILE ? `Miserecord ${process.env.MISERECORD_PROFILE}` : 'Miserecord Dev';
  app.setName(profile);
  app.setPath('userData', path.join(app.getPath('appData'), profile));
}

// One window only: opening the app again brings back the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- desktop preferences
// Kept in a file because the main process needs them before the page loads.
const PREFS_FILE = () => path.join(app.getPath('userData'), 'desktop-prefs.json');
const prefs = { background: true, autostart: false, askedAutostart: false, setupDone: false, toldAboutTray: false };

function loadPrefs() {
  try { Object.assign(prefs, JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8'))); } catch { /* first run */ }
}
function savePrefs() {
  try { fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs, null, 2)); } catch (err) { console.error('could not save prefs', err); }
}

function setAutostart(on) {
  prefs.autostart = !!on;
  savePrefs();
  // Only the installed app registers itself; a development run would register electron.exe.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: prefs.autostart, path: process.execPath, args: ['--hidden'] });
  refreshTray();
}

function setBackground(on) {
  prefs.background = !!on;
  savePrefs();
  refreshTray();
}

// ---------------------------------------------------------------- startup
function start() {
  // Windows caches the taskbar icon per app ID. Development runs use electron.exe
  // (the default atom icon), so they get their own ID and can't overwrite the
  // installed app's cached icon.
  app.setAppUserModelId(app.isPackaged ? 'com.killerwolf000157.miserecord' : 'com.killerwolf000157.miserecord.dev');
  loadPrefs();

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
  createTray();
  setupUpdates();
  setupHotkeys();

  ipcMain.handle('app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
  ipcMain.handle('desktop-prefs', () => ({
    background: prefs.background,
    autostart: prefs.autostart,
    canAutostart: app.isPackaged,
    askedAutostart: prefs.askedAutostart,
    setupDone: prefs.setupDone,
    globalHotkeys: hotkeys.available,
  }));
  ipcMain.handle('set-desktop-pref', (_e, key, value) => {
    if (key === 'background') setBackground(value);
    if (key === 'autostart') setAutostart(value);
    if (key === 'askedAutostart') { prefs.askedAutostart = !!value; savePrefs(); }
    if (key === 'setupDone') { prefs.setupDone = !!value; savePrefs(); }
    return true;
  });
  ipcMain.handle('uninstall', (_e, opts) => uninstall(!!(opts && opts.deleteData)));
  ipcMain.on('incoming-call', (_e, name) => notifyIncoming(String(name || 'Your friend').slice(0, 32)));
  ipcMain.on('call-answered', () => {
    if (mainWindow) mainWindow.flashFrame(false);
    if (callNotification) callNotification.close();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: 'Miserecord',
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#F5F5F7',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // Calls, ringing and hotkeys keep working while the window is hidden.
      backgroundThrottling: false,
      // The ringtone and your friend's voice can play without a click first.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWindow.removeMenu();
  // Tell the taskbar exactly which icon goes with this window and app ID, so
  // Windows doesn't fall back to an icon it cached for the ID earlier.
  if (process.platform === 'win32' && app.isPackaged) {
    mainWindow.setAppDetails({
      appId: 'com.killerwolf000157.miserecord',
      appIconPath: process.execPath,
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}"`,
      relaunchDisplayName: 'Miserecord',
    });
  }
  mainWindow.once('ready-to-show', () => { if (!START_HIDDEN) mainWindow.show(); });
  mainWindow.loadURL(`${APP_ORIGIN}/`);

  // Closing the window keeps Miserecord running in the tray, unless turned off.
  mainWindow.on('close', (e) => {
    if (quitting || !prefs.background) return;
    e.preventDefault();
    mainWindow.hide();
    if (!prefs.toldAboutTray && Notification.isSupported()) {
      prefs.toldAboutTray = true;
      savePrefs();
      new Notification({
        title: 'Miserecord is still running',
        body: 'Friends can still call you. Quit from the tray icon, or turn this off in Settings.',
        silent: true,
      }).show();
    }
  });
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

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------- uninstall
// Runs the installer's own uninstaller (the same one as in Windows Settings > Apps),
// then quits so it can remove the files. With deleteData, your friends, identity
// key, settings and logs are erased too: right away from the app's storage, and
// the leftover folder once the app has closed.
async function uninstall(deleteData) {
  if (!app.isPackaged) return { ok: false, reason: 'Uninstall works in the installed app.' };
  const dir = path.dirname(process.execPath);
  const uninstaller = fs.readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f));
  if (!uninstaller) return { ok: false, reason: "Couldn't find the uninstaller. Use Windows Settings > Apps instead." };
  // Don't leave a "start with Windows" entry pointing at a removed app.
  app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: ['--hidden'] });
  const { spawn } = require('child_process');
  if (deleteData) {
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    try { fs.unlinkSync(PREFS_FILE()); } catch { /* already gone */ }
    // Only ever remove the app's own data folder.
    const dataDir = app.getPath('userData');
    if (/[\\/]Miserecord$/i.test(dataDir)) {
      spawn('cmd.exe', ['/d', '/c', `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${dataDir}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  }
  spawn(path.join(dir, uninstaller), [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => { quitting = true; app.quit(); }, 300);
  return { ok: true };
}

// ---------------------------------------------------------------- tray
function createTray() {
  tray = new Tray(process.platform === 'win32' ? ICON : nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' }));
  tray.setToolTip('Miserecord');
  tray.on('click', showWindow);
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Miserecord', click: showWindow },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: prefs.autostart, enabled: app.isPackaged, click: (item) => setAutostart(item.checked) },
    { label: 'Keep running when closed', type: 'checkbox', checked: prefs.background, click: (item) => setBackground(item.checked) },
    { type: 'separator' },
    { label: 'Quit Miserecord', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------------------------------------------------------------- permissions
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
        // No arguments means cancelled; an empty object throws in recent Electron.
        if (!source) return callback();
        // On Windows, "loopback" captures everything you hear: games, music, videos.
        callback(choice.audio && process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
      });
    } catch (err) {
      console.error('screen picker failed', err);
      try { callback(); } catch { /* already answered */ }
    }
  });
}

// ---------------------------------------------------------------- incoming calls
let callNotification = null;

function notifyIncoming(name) {
  if (!mainWindow) return;
  const visible = mainWindow.isVisible() && mainWindow.isFocused();
  if (mainWindow.isVisible() && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  if (visible || !Notification.isSupported()) return;
  if (callNotification) callNotification.close();
  callNotification = new Notification({ title: `${name} is calling`, body: 'Click to open Miserecord and answer.', silent: true });
  callNotification.on('click', showWindow);
  callNotification.show();
}

// ---------------------------------------------------------------- global hotkeys
// A low-level hook sees keys while games or other apps are focused. It only
// runs while at least one hotkey is set, and only reports the bound keys.
const hotkeys = { available: false, hook: null, keys: null, bindings: {}, held: new Set(), running: false };

function setupHotkeys() {
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    hotkeys.hook = uIOhook;
    hotkeys.keys = UiohookKey;
    hotkeys.available = true;
  } catch (err) {
    console.error('global hotkeys unavailable', err);
    return;
  }
  const { hook } = hotkeys;
  hook.on('keydown', (e) => onHookInput('key', e.keycode, true, e));
  hook.on('keyup', (e) => onHookInput('key', e.keycode, false, e));
  hook.on('mousedown', (e) => onHookInput('mouse', e.button, true, e));
  hook.on('mouseup', (e) => onHookInput('mouse', e.button, false, e));
  ipcMain.on('set-hotkeys', (_e, bindings) => setHotkeys(bindings));
  app.on('will-quit', () => { if (hotkeys.running) hotkeys.hook.stop(); });
}

// DOM KeyboardEvent.code -> uiohook key name.
const CODE_ALIASES = {
  ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', ShiftLeft: 'Shift', ShiftRight: 'ShiftRight',
  AltLeft: 'Alt', AltRight: 'AltRight', MetaLeft: 'Meta', MetaRight: 'MetaRight',
};
// DOM mouse button -> uiohook mouse button (middle, back, forward).
const MOUSE_ALIASES = { 1: 3, 3: 4, 4: 5 };

function toHookBinding(b) {
  if (!b) return null;
  if (b.type === 'mouse') return MOUSE_ALIASES[b.button] ? { type: 'mouse', id: MOUSE_ALIASES[b.button] } : null;
  const name = CODE_ALIASES[b.code] || b.code.replace(/^Key/, '').replace(/^Digit/, '');
  const id = hotkeys.keys[name];
  if (id === undefined) return null;
  return { type: 'key', id, ctrl: !!b.ctrl, shift: !!b.shift, alt: !!b.alt, meta: !!b.meta };
}

function setHotkeys(bindings) {
  hotkeys.bindings = {};
  hotkeys.held.clear();
  for (const [name, b] of Object.entries(bindings || {})) {
    const hb = toHookBinding(b);
    if (hb) hotkeys.bindings[name] = hb;
  }
  const want = Object.keys(hotkeys.bindings).length > 0;
  if (want && !hotkeys.running) { hotkeys.hook.start(); hotkeys.running = true; }
  if (!want && hotkeys.running) { hotkeys.hook.stop(); hotkeys.running = false; }
}

function onHookInput(type, id, down, e) {
  for (const [name, b] of Object.entries(hotkeys.bindings)) {
    if (b.type !== type || b.id !== id) continue;
    if (name === 'ptt') {
      // Push-to-talk: the key alone counts, whatever else is held (e.g. Shift while running).
      if (down === hotkeys.held.has(name)) continue; // ignore key repeat
      if (down) hotkeys.held.add(name); else hotkeys.held.delete(name);
      send('hotkey', { name, down });
      continue;
    }
    // Other hotkeys fire once per press and need their exact modifiers.
    if (!down) { hotkeys.held.delete(name); continue; }
    if (hotkeys.held.has(name)) continue;
    if (type === 'key' && (b.ctrl !== !!e.ctrlKey || b.shift !== !!e.shiftKey || b.alt !== !!e.altKey || b.meta !== !!e.metaKey)) continue;
    hotkeys.held.add(name);
    send('hotkey', { name, down: true });
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- updates
function setupUpdates() {
  if (!app.isPackaged) return; // updates only make sense for the installed app
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const status = (s, extra = {}) => send('update-status', { status: s, ...extra });
  autoUpdater.on('checking-for-update', () => status('checking'));
  autoUpdater.on('update-available', (info) => status('downloading', { version: info.version }));
  autoUpdater.on('update-not-available', () => status('current'));
  autoUpdater.on('download-progress', (p) => status('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => status('ready', { version: info.version }));
  autoUpdater.on('error', (err) => status('error', { message: err ? String(err.message).split('\n')[0].slice(0, 200) : 'unknown error' }));

  ipcMain.on('check-for-updates', () => autoUpdater.checkForUpdates().catch(() => {}));
  ipcMain.on('install-update', () => { quitting = true; autoUpdater.quitAndInstall(false, true); });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, UPDATE_CHECK_MS);
}
