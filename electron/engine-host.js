// Runs miserecord-capture (native/capture) for a screen share and hands its
// encoded frames to the page. The page decides when to use it; see
// public/engine.js and docs/native-engine.md.
'use strict';

const { app, screen } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const HEADER = 20;

let helper = null;
let lastPick = null; // the screen or window chosen in the picker
let probed = null;

function helperPath() {
  const packaged = path.join(process.resourcesPath || '', 'miserecord-capture.exe');
  const dev = path.join(__dirname, '..', 'native', 'capture', 'target', 'release', 'miserecord-capture.exe');
  const p = app.isPackaged ? packaged : dev;
  return fs.existsSync(p) ? p : null;
}

// Which codecs this computer's graphics card encodes in hardware (cached).
function probe() {
  if (probed) return probed;
  probed = new Promise((resolve) => {
    const exe = helperPath();
    if (!exe || process.platform !== 'win32') return resolve({ codecs: [], reason: 'no helper' });
    execFile(exe, ['--probe'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ codecs: [], reason: String(err.message).slice(0, 200) });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ codecs: [], reason: 'bad probe output' }); }
    });
  });
  return probed;
}

function setPick(source) {
  lastPick = source ? { id: source.id, displayId: source.display_id } : null;
}

// Helper arguments for what was picked: a window by its handle, a monitor by a
// point on it (physical pixels, as the helper is DPI aware).
function targetArgs() {
  if (!lastPick) return null;
  const m = /^window:(\d+):/.exec(lastPick.id);
  if (m) return ['--window', m[1]];
  if (lastPick.id.startsWith('screen:')) {
    const d = screen.getAllDisplays().find((x) => String(x.id) === String(lastPick.displayId)) || screen.getPrimaryDisplay();
    const centre = { x: Math.round(d.bounds.x + d.bounds.width / 2), y: Math.round(d.bounds.y + d.bounds.height / 2) };
    const p = screen.dipToScreenPoint ? screen.dipToScreenPoint(centre) : centre;
    return ['--point', `${Math.round(p.x)},${Math.round(p.y)}`];
  }
  return null;
}

function start(webContents, opts) {
  stop();
  const exe = helperPath();
  const target = targetArgs();
  if (!exe || !target) return { ok: false, reason: exe ? 'nothing picked' : 'no helper' };
  const args = [...target,
    '--codec', opts.codec === 'AV1' ? 'av1' : 'h264',
    '--width', String(opts.width | 0), '--height', String(opts.height | 0),
    '--fps', String(opts.fps | 0), '--bitrate', String(opts.bitrate | 0)];
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  helper = child;
  const send = (channel, payload) => { if (!webContents.isDestroyed()) webContents.send(channel, payload); };

  // stdout: framed encoded video. Pieces are only joined once a whole frame is
  // in (a keyframe arrives in many pipe reads; joining at each read copied it
  // over and over).
  let buf = Buffer.alloc(0);
  let pending = [];
  let pendingLen = 0;
  let need = HEADER;
  child.stdout.on('data', (chunk) => {
    pending.push(chunk);
    pendingLen += chunk.length;
    if (buf.length + pendingLen < need) return;
    buf = Buffer.concat(buf.length ? [buf, ...pending] : pending);
    pending = [];
    pendingLen = 0;
    while (buf.length >= HEADER) {
      const len = buf.readUInt32LE(0);
      need = HEADER + len;
      if (buf.length < need) break;
      need = HEADER;
      send('engine-frame', {
        key: buf[4] === 1,
        codec: buf[5] === 2 ? 'AV1' : 'H264',
        width: buf.readUInt16LE(6),
        height: buf.readUInt16LE(8),
        time: Number(buf.readBigUInt64LE(12)),
        layer: buf[10], // 0 = main, 1 = the small layer
        data: buf.subarray(HEADER, HEADER + len),
      });
      buf = buf.subarray(HEADER + len);
    }
  });
  // stderr: one JSON event per line
  let err = '';
  child.stderr.on('data', (chunk) => {
    err += chunk.toString();
    let i;
    while ((i = err.indexOf('\n')) >= 0) {
      const line = err.slice(0, i).trim();
      err = err.slice(i + 1);
      if (!line) continue;
      try { send('engine-event', JSON.parse(line)); } catch { /* not ours */ }
    }
  });
  child.on('exit', (code) => {
    if (helper === child) helper = null;
    send('engine-event', { event: 'exit', code });
  });
  child.on('error', (e) => send('engine-event', { event: 'error', message: String(e.message) }));
  return { ok: true };
}

function control(line) {
  if (helper && helper.stdin.writable) helper.stdin.write(`${String(line).replace(/[\r\n]/g, '')}\n`);
}

function stop() {
  const child = helper;
  helper = null;
  if (!child) return;
  try { child.stdin.write('quit\n'); child.stdin.end(); } catch { /* gone */ }
  setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 800);
}

module.exports = { probe, setPick, start, control, stop };
