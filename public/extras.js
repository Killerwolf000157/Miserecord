// Volume, ringtone, push to talk and hotkeys.
// Loaded after settings.js and before app.js; uses the shared `settings` object.
'use strict';

Object.assign(SETTINGS_DEFAULTS, {
  voiceVolume: 100,
  streamVolume: 100,
  ringtone: false,
  ringVolume: 30,
  ptt: false,
  pttKey: null,
  muteKey: null,
  leaveKey: null,
});
for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) if (!(k in settings)) settings[k] = v;

// ------------------------------------------------------------------ volume

function applyVolumes() {
  for (const entry of state.remote.values()) {
    if (entry.audio) entry.audio.volume = settings.voiceVolume / 100;
    if (entry.tile) entry.tile.video.volume = settings.streamVolume / 100;
  }
  syncSlider($('#peerVol'), settings.voiceVolume);
  for (const s of document.querySelectorAll('.tile.remote .tile-vol .slider')) syncSlider(s, settings.streamVolume);
}

// The filled part of a slider's track follows its value.
function syncSlider(input, value) {
  if (!input) return;
  if (value !== undefined && document.activeElement !== input) input.value = value;
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill-pct', `${pct}%`);
}

// A volume slider for a remote stream tile.
function addTileVolume(tile) {
  const wrap = document.createElement('label');
  wrap.className = 'tile-vol';
  wrap.title = 'Stream volume';
  wrap.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg><input type="range" class="slider" min="0" max="100" step="1" aria-label="Stream volume">';
  const input = wrap.querySelector('input');
  input.oninput = () => {
    setSetting('streamVolume', Number(input.value));
    syncSlider(input);
    applyVolumes();
  };
  syncSlider(input, settings.streamVolume);
  tile.el.querySelector('.actions').prepend(wrap);
  tile.video.volume = settings.streamVolume / 100;
}

// ------------------------------------------------------------------ ringtone
// A soft three-note chime made with Web Audio; nothing to download.
const Ringtone = {
  ctx: null,
  timer: null,

  start() {
    if (!settings.ringtone || this.timer) return;
    Log.info('call', 'ringtone on');
    this.playOnce();
    this.timer = setInterval(() => this.playOnce(), 3200);
  },

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  },

  playOnce(volume = settings.ringVolume / 100) {
    this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (typeof ctx.setSinkId === 'function') ctx.setSinkId(settings.speakerId || '').catch(() => {});
    scheduleChime(ctx, ctx.destination, ctx.currentTime + 0.05, volume);
  },
};

// Peak level stays low on purpose: about -23 dBFS at the default 30%, -12 dBFS at 100%.
function scheduleChime(ctx, destination, t0, volume) {
  const master = ctx.createGain();
  master.gain.value = 0.2 * Math.max(0, Math.min(1, volume));
  master.connect(destination);
  const notes = [[659.25, 0], [830.61, 0.16], [987.77, 0.32]]; // E5, G#5, B5
  for (const [freq, at] of notes) {
    const start = t0 + at;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(0.9, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);
    env.connect(master);
    for (const [mult, level] of [[1, 1], [2, 0.12], [3.01, 0.04]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      g.gain.value = level;
      osc.connect(g).connect(env);
      osc.start(start);
      osc.stop(start + 1.15);
    }
  }
}

// ------------------------------------------------------------------ push to talk & hotkeys

function applyMicEnabled() {
  const talking = !state.muted && (!settings.ptt || state.pttDown);
  if (state.mic) state.mic.getAudioTracks().forEach((t) => { t.enabled = talking; });
  const btn = $('#micBtn');
  btn.classList.toggle('ptt', settings.ptt && !state.muted);
  btn.classList.toggle('talking', settings.ptt && talking);
  if (settings.ptt && !state.muted) label(btn, `Push to talk: hold ${keyLabel(settings.pttKey) || 'your talk key'}. Click to mute.`);
  else label(btn, state.muted ? 'Unmute' : 'Mute');
}

function setPtt(down) {
  clearTimeout(state.pttRelease);
  if (down) {
    state.pttDown = true;
    applyMicEnabled();
  } else {
    // A short release delay keeps the end of your last word.
    state.pttRelease = setTimeout(() => { state.pttDown = false; applyMicEnabled(); }, 200);
  }
}

function onHotkey({ name, down }) {
  if (name === 'ptt') return setPtt(down);
  if (!down) return;
  if (name === 'mute' && state.mic) toggleMute();
  if (name === 'leave' && (state.pc || state.session)) leave();
}

function keyLabel(b) {
  if (!b) return '';
  if (b.type === 'mouse') return { 1: 'Middle click', 3: 'Mouse 4', 4: 'Mouse 5' }[b.button] || `Mouse ${b.button + 1}`;
  const names = { Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', CapsLock: 'Caps Lock', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Win', MetaRight: 'Win' };
  let key = names[b.code] || b.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/^Arrow/, '');
  const mods = [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', b.meta && 'Win'].filter(Boolean);
  if (/^(Control|Shift|Alt|Meta)/.test(b.code)) return key;
  return [...mods, key].join('+');
}

const isModifierCode = (code) => /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code);

function bindingFromKey(e, allowBareModifier) {
  if (isModifierCode(e.code) && !allowBareModifier) return null;
  return { type: 'key', code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
}

function matches(binding, e, isPtt) {
  if (!binding) return false;
  if (binding.type === 'mouse') return e.type.startsWith('mouse') && e.button === binding.button;
  if (!e.type.startsWith('key') || e.code !== binding.code) return false;
  if (isPtt) return true;
  return binding.ctrl === e.ctrlKey && binding.shift === e.shiftKey && binding.alt === e.altKey && binding.meta === e.metaKey;
}

// Send the bindings to the desktop app's global hook (if any).
function pushHotkeys() {
  if (window.miserecordDesktop) {
    window.miserecordDesktop.setHotkeys({
      ptt: settings.ptt ? settings.pttKey : null,
      mute: settings.muteKey,
      leave: settings.leaveKey,
    });
  }
  applyMicEnabled();
  renderKeycaps();
}

let capturing = null; // the setting key being recorded

function renderKeycaps() {
  for (const cap of document.querySelectorAll('.keycap')) {
    const key = cap.dataset.binding;
    const listening = capturing === key;
    const text = keyLabel(settings[key]);
    cap.classList.toggle('listening', listening);
    cap.classList.toggle('empty', !text && !listening);
    cap.textContent = listening ? 'Press a key' : text || 'Set key';
  }
  for (const x of document.querySelectorAll('.key-clear')) x.hidden = !settings[x.dataset.clear];
  if (!settings.pttKey && settings.ptt && capturing !== 'pttKey') $('#sPttKey').textContent = 'Set a talk key';
  $('#sKeysNote').textContent = state.globalHotkeys
    ? 'These work everywhere, even while a game or another app is in front.'
    : "In the browser these only work while Miserecord is the active window. The desktop app makes them work everywhere, even in games.";
}

function finishCapture(binding) {
  const key = capturing;
  capturing = null;
  if (binding) {
    setSetting(key, binding);
    Log.info('keys', `set ${key}`, keyLabel(binding));
  }
  pushHotkeys();
}

function initExtras() {
  // Volume
  for (const [id, key] of [['#sVoiceVol', 'voiceVolume'], ['#sStreamVol', 'streamVolume'], ['#sRingVol', 'ringVolume'], ['#peerVol', 'voiceVolume']]) {
    const input = $(id);
    syncSlider(input, settings[key]);
    input.oninput = () => {
      setSetting(key, Number(input.value));
      syncSlider(input);
      if (key !== 'ringVolume') applyVolumes();
      const text = $(`${id}Text`);
      if (text) text.textContent = `${input.value}%`;
    };
  }

  // Ringtone
  $('#sRing').onchange = () => {
    setSetting('ringtone', $('#sRing').checked);
    if (!settings.ringtone) Ringtone.stop();
  };
  $('#sRingTest').onclick = () => Ringtone.playOnce();

  // Push to talk & shortcuts
  $('#sPtt').onchange = () => {
    setSetting('ptt', $('#sPtt').checked);
    if (settings.ptt && !settings.pttKey) {
      capturing = 'pttKey';
      renderKeycaps();
    }
    pushHotkeys();
  };
  for (const cap of document.querySelectorAll('.keycap')) {
    cap.onclick = (e) => {
      if (e.detail === 0 && capturing) return; // keyboard "click" while recording
      capturing = capturing === cap.dataset.binding ? null : cap.dataset.binding;
      renderKeycaps();
    };
  }
  for (const x of document.querySelectorAll('.key-clear')) {
    x.onclick = () => { setSetting(x.dataset.clear, null); pushHotkeys(); };
  }

  // Recording a key: the next key or side/middle mouse button becomes the binding.
  window.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // the key that sets a binding doesn't also trigger it
    if (e.code === 'Escape') return finishCapture(null);
    const binding = bindingFromKey(e, capturing === 'pttKey');
    if (binding) finishCapture(binding);
  }, true);
  window.addEventListener('mousedown', (e) => {
    if (!capturing || ![1, 3, 4].includes(e.button)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    finishCapture({ type: 'mouse', button: e.button });
  }, true);

  // Without the desktop app's global hook, listen while the window is focused.
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
  const local = (e, down) => {
    if (capturing || state.globalHotkeys) return;
    if (matches(settings.pttKey, e, true) && settings.ptt) {
      if (e.type.startsWith('key') && typing(e)) return;
      if (e.repeat) return;
      setPtt(down);
      return;
    }
    if (!down || e.repeat) return;
    for (const name of ['mute', 'leave']) {
      if (matches(settings[`${name}Key`], e, false)) {
        if (typing(e) && !settings[`${name}Key`].ctrl && !settings[`${name}Key`].alt && !settings[`${name}Key`].meta) return;
        e.preventDefault();
        onHotkey({ name, down: true });
      }
    }
  };
  window.addEventListener('keydown', (e) => local(e, true));
  window.addEventListener('keyup', (e) => local(e, false));
  window.addEventListener('mousedown', (e) => local(e, true));
  window.addEventListener('mouseup', (e) => local(e, false));
  window.addEventListener('blur', () => { if (!state.globalHotkeys && state.pttDown) setPtt(false); });

  // Desktop app: global hook and background options.
  const desk = window.miserecordDesktop;
  if (desk) {
    desk.onHotkey(onHotkey);
    desk.prefs().then((p) => {
      state.globalHotkeys = !!p.globalHotkeys;
      Log.info('keys', state.globalHotkeys ? 'global hotkeys available' : 'global hotkeys unavailable, using window keys');
      $('#sBackground').checked = p.background;
      $('#sAutostart').checked = p.autostart;
      $('#sAutostart').disabled = !p.canAutostart;
      if (!p.canAutostart) $('#sBackgroundNote').textContent += ' Starting with Windows works in the installed app.';
      pushHotkeys();
    });
    $('#sBackground').onchange = () => desk.setPref('background', $('#sBackground').checked);
    $('#sAutostart').onchange = () => desk.setPref('autostart', $('#sAutostart').checked);
  } else {
    pushHotkeys();
  }
}

// Called when the settings sheet opens.
function syncExtras() {
  for (const [id, key] of [['#sVoiceVol', 'voiceVolume'], ['#sStreamVol', 'streamVolume'], ['#sRingVol', 'ringVolume']]) {
    syncSlider($(id), settings[key]);
    const text = $(`${id}Text`);
    if (text) text.textContent = `${settings[key]}%`;
  }
  $('#sRing').checked = settings.ringtone;
  $('#sPtt').checked = settings.ptt;
  capturing = null;
  renderKeycaps();
}
