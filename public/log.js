// Miserecord diagnostics log.
// Records what the app does while connecting and during a call, so problems can
// be traced afterwards. Kept per tab (sessionStorage), survives reloads, never
// sent anywhere. Copy or download it from Settings > General > Troubleshooting.
// IP addresses are never written in full: they are reduced to their kind
// (private, public, IPv6, mDNS).
'use strict';

const Log = (() => {
  const MAX_ENTRIES = 3000;
  const KEY = 'miserecord.log';
  const tabId = Math.random().toString(36).slice(2, 6);
  const listeners = new Set();
  let entries = [];
  let saveTimer = null;

  try {
    entries = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    if (entries.length) entries.push({ t: Date.now(), level: 'info', cat: 'app', msg: '---- page reloaded ----' });
  } catch { entries = []; }

  function clock(t) {
    const d = new Date(t);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function format(e) {
    const data = e.data === undefined ? '' : ` ${typeof e.data === 'string' ? e.data : safeJson(e.data)}`;
    const level = e.level === 'info' ? '' : ` ${e.level.toUpperCase()}`;
    return `${clock(e.t)}${level} [${e.cat}] ${e.msg}${data}`;
  }

  function safeJson(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  function add(level, cat, msg, data) {
    const e = { t: Date.now(), level, cat, msg: String(msg) };
    if (data !== undefined) e.data = data instanceof Error ? `${data.name}: ${data.message}` : data;
    entries.push(e);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    const line = format(e);
    (level === 'error' ? origError : level === 'warn' ? origWarn : origLog)(`[miserecord] ${line}`);
    for (const fn of listeners) { try { fn(e, line); } catch { /* listener failed */ } }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { sessionStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* storage full or off */ }
    }, 300);
  }

  // Keep existing console.warn/error calls in the log too.
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = (...args) => { origWarn(...args); addConsole('warn', args); };
  console.error = (...args) => { origError(...args); addConsole('error', args); };
  function addConsole(level, args) {
    if (typeof args[0] === 'string' && args[0].startsWith('[miserecord]')) return;
    const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'object' ? safeJson(a) : String(a))).join(' ');
    entries.push({ t: Date.now(), level, cat: 'console', msg: text });
  }

  window.addEventListener('error', (e) => add('error', 'page', e.message, `${e.filename || ''}:${e.lineno || ''}`));
  window.addEventListener('unhandledrejection', (e) => add('error', 'page', 'unhandled promise rejection', e.reason instanceof Error ? e.reason : String(e.reason)));

  // ---------------------------------------------------------------- helpers for callers

  function ipKind(addr) {
    if (!addr) return 'none';
    if (/\.local$/i.test(addr)) return 'mDNS';
    if (addr.includes(':')) return 'IPv6';
    const [a, b] = addr.split('.').map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private IPv4';
    if (a === 127) return 'loopback';
    if (a === 100 && b >= 64 && b <= 127) return 'carrier-NAT IPv4';
    return 'public IPv4';
  }

  // "srflx udp public IPv4" etc. from a candidate object or SDP line.
  function candidate(c) {
    if (!c) return 'end of candidates';
    const line = typeof c === 'string' ? c : c.candidate || '';
    const parts = line.replace(/^a=/, '').split(' ');
    const typ = parts[parts.indexOf('typ') + 1] || c.type || '?';
    const proto = (parts[2] || c.protocol || '?').toLowerCase();
    const addr = parts[4] || c.address;
    return `${typ} ${proto} ${ipKind(addr)}`;
  }

  // Short summary of an SDP: media sections and candidate kinds, no addresses.
  function sdp(desc) {
    if (!desc || !desc.sdp) return 'empty';
    const lines = desc.sdp.split(/\r?\n/);
    const media = lines.filter((l) => l.startsWith('m=')).map((l) => l.split(' ')[0].slice(2));
    const counts = {};
    for (const l of lines.filter((x) => x.startsWith('a=candidate'))) {
      const k = candidate(l);
      counts[k] = (counts[k] || 0) + 1;
    }
    const codecs = [...new Set(lines.filter((l) => l.startsWith('a=rtpmap')).map((l) => l.split(' ')[1].split('/')[0]))]
      .filter((c) => !/^(rtx|red|ulpfec|flexfec|CN|telephone-event)$/i.test(c));
    return { type: desc.type, bytes: desc.sdp.length, media, codecs, candidates: counts };
  }

  function environment() {
    const has = (o, k) => !!(o && k in o);
    return {
      url: location.protocol + '//' + (location.host || '(file)') + location.pathname.replace(/^.*\//, '/'),
      secure: window.isSecureContext,
      ua: navigator.userAgent,
      lang: navigator.language,
      online: navigator.onLine,
      features: {
        webrtc: typeof RTCPeerConnection === 'function',
        getDisplayMedia: has(navigator.mediaDevices, 'getDisplayMedia'),
        setSinkId: has(HTMLMediaElement.prototype, 'setSinkId'),
        setCodecPreferences: has(window.RTCRtpTransceiver && RTCRtpTransceiver.prototype, 'setCodecPreferences'),
        compressionStream: typeof CompressionStream === 'function',
        captureStream: has(HTMLMediaElement.prototype, 'captureStream') || has(HTMLMediaElement.prototype, 'mozCaptureStream'),
        webCrypto: !!(window.crypto && crypto.subtle),
      },
      tab: tabId,
    };
  }

  function text() {
    const head = [
      'Miserecord diagnostics log',
      `Exported ${new Date().toISOString()}`,
      `Environment ${safeJson(environment())}`,
      '',
    ];
    return head.concat(entries.map(format)).join('\n');
  }

  return {
    info: (cat, msg, data) => add('info', cat, msg, data),
    warn: (cat, msg, data) => add('warn', cat, msg, data),
    error: (cat, msg, data) => add('error', cat, msg, data),
    candidate,
    sdp,
    ipKind,
    environment,
    text,
    lines: (n) => entries.slice(-n).map(format),
    clear() {
      entries = [];
      try { sessionStorage.removeItem(KEY); } catch { /* storage off */ }
    },
    onEntry(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    tabId,
  };
})();

Log.info('app', 'started', Log.environment());
