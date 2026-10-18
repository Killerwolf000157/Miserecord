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
  deafenKey: null,
});
for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) if (!(k in settings)) settings[k] = v;

// ------------------------------------------------------------------ volume
// Volumes go up to 200%. A media element stops at 100%, so friends' voices and
// streams play through Web Audio instead: element (muted, it only feeds the
// stream) -> gain -> limiter -> speakers. The limiter keeps a boosted voice from
// distorting when it gets loud.
const MAX_VOLUME = 200;

const Playback = {
  ctx: null,
  bus: null,

  context() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      limiter.connect(this.ctx.destination);
      this.bus = limiter;
      this.applySink();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  applySink() {
    if (this.ctx && typeof this.ctx.setSinkId === 'function') {
      this.ctx.setSinkId(settings.speakerId || '').catch(() => { if (settings.speakerId) this.ctx.setSinkId('').catch(() => {}); });
    }
  },

  // Play a remote stream's audio through a gain we control. The element stays
  // muted but playing: Chromium only delivers a remote stream's audio to Web
  // Audio while an element plays it.
  route(el, stream) {
    el.muted = true;
    const connect = () => {
      if (el._route || !stream.getAudioTracks().length) return;
      const ctx = this.context();
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.bus);
      el._route = { source, gain };
      applyVolumes();
    };
    connect();
    // A shared screen's sound can arrive after its picture.
    stream.addEventListener('addtrack', connect);
  },

  unroute(el) {
    if (!el || !el._route) return;
    el._route.source.disconnect();
    el._route.gain.disconnect();
    el._route = null;
  },

  set(el, volume) {
    if (!el || !el._route) return;
    const v = state.deafened ? 0 : Math.max(0, Math.min(MAX_VOLUME / 100, volume));
    el._route.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  },
};

// ------------------------------------------------------------------ sound panel
// The speaker button in the dock: your microphone, each person and the streams,
// each with its own slider, so it's clear what changes what.
function initSoundPanel() {
  const panel = $('#soundPanel');
  const btn = $('#soundBtn');
  btn.onclick = () => (panel.hidden ? openSoundPanel() : closeSoundPanel());
  document.addEventListener('mousedown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) closeSoundPanel();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closeSoundPanel(); });
  bindVolume($('#spMic'), $('#spMicPct'), 'micGain', applyMicGain);
  bindVolume($('#spStreams'), $('#spStreamsPct'), 'streamVolume', applyVolumes);
  $('#spMore').onclick = () => { closeSoundPanel(); openSettings(); showTab('audio'); };
}

function bindVolume(input, pct, key, apply) {
  input.oninput = () => {
    setSetting(key, Number(input.value));
    syncSlider(input);
    pct.textContent = `${input.value}%`;
    apply();
  };
}

function openSoundPanel() {
  for (const [id, key] of [['#spMic', 'micGain'], ['#spStreams', 'streamVolume']]) {
    syncSlider($(id), settings[key]);
    $(`${id}Pct`).textContent = `${settings[key]}%`;
  }
  renderSoundPeople();
  renderSoundStreams();
  $('#soundPanel').hidden = false;
  $('#soundBtn').setAttribute('aria-expanded', 'true');
  $('#soundBtn').classList.add('open');
}

function closeSoundPanel() {
  $('#soundPanel').hidden = true;
  $('#soundBtn').setAttribute('aria-expanded', 'false');
  $('#soundBtn').classList.remove('open');
}

// One row per person in the call; rebuilt when people come and go.
function renderSoundPeople() {
  const box = $('#spPeople');
  box.textContent = '';
  const peers = [...state.peers.values()];
  $('#spNobody').hidden = peers.length > 0;
  for (const peer of peers) {
    const row = document.createElement('label');
    row.className = 'sp-row';
    row.innerHTML = '<span class="sp-name" translate="no"></span><input type="range" class="slider" min="0" step="1"><span class="sp-pct"></span>';
    row.querySelector('.sp-name').textContent = peer.name || '…';
    const input = row.querySelector('input');
    input.max = MAX_VOLUME;
    input.setAttribute('aria-label', `${peer.name}'s volume`);
    syncSlider(input, peer.volume);
    row.querySelector('.sp-pct').textContent = `${peer.volume}%`;
    input.oninput = () => setPeerVolume(peer, Number(input.value), input);
    box.append(row);
  }
}

// One row per stream you're watching, under "Everything you watch".
function renderSoundStreams() {
  const box = $('#spStreamList');
  box.textContent = '';
  for (const peer of state.peers.values()) {
    for (const entry of peer.remote.values()) {
      if (!entry.tile) continue;
      const row = document.createElement('label');
      row.className = 'sp-row';
      row.innerHTML = '<span class="sp-name" translate="no"></span><input type="range" class="slider" min="0" step="1"><span class="sp-pct"></span>';
      row.querySelector('.sp-name').textContent = entry.tile.el.querySelector('.title').textContent;
      const input = row.querySelector('input');
      input.max = MAX_VOLUME;
      input._entry = entry;
      input.setAttribute('aria-label', 'Stream volume');
      syncSlider(input, entry.volume || 100);
      row.querySelector('.sp-pct').textContent = `${entry.volume || 100}%`;
      input.oninput = () => setStreamVolume(entry, Number(input.value), input);
      box.append(row);
    }
  }
}

// A person's voice volume, kept the same on their card and in the sound panel.
function setPeerVolume(peer, value, from) {
  peer.volume = value;
  const card = peer.card && peer.card.querySelector('.peer-vol input');
  const sliders = [card, ...[...$('#spPeople').querySelectorAll('input')].filter((i) => i.getAttribute('aria-label') === `${peer.name}'s volume`)];
  for (const s of sliders) {
    if (!s) continue;
    if (s !== from) s.value = value;
    syncSlider(s);
    const pct = s.parentElement.querySelector('.sp-pct, .peer-vol-pct');
    if (pct) { pct.textContent = `${value}%`; pct.classList.toggle('boost', value > 100); }
  }
  applyVolumes();
}

function applyVolumes() {
  for (const peer of state.peers.values()) {
    for (const entry of peer.remote.values()) {
      if (entry.audio) Playback.set(entry.audio, voiceVolumeFor(peer));
      if (entry.tile) Playback.set(entry.tile.video, (settings.streamVolume / 100) * ((entry.volume || 100) / 100));
    }
  }
}

// The filled part of a slider's track follows its value.
function syncSlider(input, value) {
  if (!input) return;
  if (value !== undefined && document.activeElement !== input) input.value = value;
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill-pct', `${pct}%`);
}

// A volume slider for a remote stream tile.
// This stream's own volume (0-200%), on top of "Everything you watch".
function addTileVolume(tile, entry) {
  entry.volume = entry.volume || 100;
  const wrap = document.createElement('label');
  wrap.className = 'tile-vol';
  wrap.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg><input type="range" class="slider" min="0" max="${MAX_VOLUME}" step="1" aria-label="Stream volume">`;
  const input = wrap.querySelector('input');
  input.oninput = () => setStreamVolume(entry, Number(input.value), input);
  entry.volumeInput = input;
  tile.el.querySelector('.actions').prepend(wrap);
  setStreamVolume(entry, entry.volume);
  // Right-click the stream for its volume.
  tile.el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const focused = tile.el.classList.contains('focused');
    showVolumeMenu(e, {
      title: tile.el.querySelector('.title').textContent,
      value: entry.volume,
      onChange: (v) => setStreamVolume(entry, v),
      actions: [
        { label: tile.el.querySelector('.stream-info') ? 'Hide stream info' : 'Stream info', run: () => toggleStreamInfo(tile.el) },
        { label: focused ? 'Exit full screen' : 'Full screen', run: () => (focused ? exitFocus() : enterFocus(tile.el)) },
      ],
    });
  });
}

function setStreamVolume(entry, value, from) {
  entry.volume = value;
  const input = entry.volumeInput;
  if (input) {
    if (input !== from) input.value = value;
    syncSlider(input);
    input.parentElement.title = `Stream volume ${value}%`;
  }
  for (const s of document.querySelectorAll('#spStreamList input')) {
    if (s._entry !== entry) continue;
    if (s !== from) { s.value = value; syncSlider(s); }
    s.nextElementSibling.textContent = `${value}%`;
  }
  applyVolumes();
}

// ------------------------------------------------------------------ right-click volume menu
// Right-click a person or a stream: its volume and a few actions, at the pointer.
let volumeMenu = null;

function showVolumeMenu(e, { title, value, onChange, actions = [] }) {
  closeVolumeMenu();
  const menu = document.createElement('div');
  menu.className = 'vol-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="vm-title" translate="no"></div>
    <div class="vm-row"><span class="vm-label">Volume</span><span class="vm-pct"></span></div>
    <input type="range" class="slider" min="0" max="${MAX_VOLUME}" step="1" aria-label="Volume">
    <div class="vm-presets"></div><div class="vm-actions"></div>`;
  menu.querySelector('.vm-title').textContent = title;
  // Your own stream has no volume here: only its actions.
  if (value == null) for (const el of menu.querySelectorAll('.vm-row, .slider, .vm-presets')) el.remove();
  const input = menu.querySelector('input');
  const pct = menu.querySelector('.vm-pct');
  const show = (v) => { input.value = v; syncSlider(input); pct.textContent = `${v}%`; pct.classList.toggle('boost', v > 100); };
  const set = (v) => { show(v); onChange(v); };
  if (input) input.oninput = () => set(Number(input.value));
  for (const v of value == null ? [] : [0, 50, 100, 150, 200]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vm-preset';
    b.textContent = `${v}%`;
    b.onclick = () => set(v);
    menu.querySelector('.vm-presets').append(b);
  }
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `vm-action${a.danger ? ' danger' : ''}`;
    b.textContent = a.label;
    b.onclick = () => { closeVolumeMenu(); a.run(); };
    menu.querySelector('.vm-actions').append(b);
  }
  if (value != null) show(value);
  // In full screen only the full-screen element is shown, so the menu goes inside it.
  (document.fullscreenElement || document.body).append(menu);
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8))}px`;
  volumeMenu = menu;
}

function closeVolumeMenu() {
  if (volumeMenu) volumeMenu.remove();
  volumeMenu = null;
}

document.addEventListener('mousedown', (e) => { if (volumeMenu && !volumeMenu.contains(e.target)) closeVolumeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVolumeMenu(); });
window.addEventListener('blur', closeVolumeMenu);

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

// ------------------------------------------------------------------ mute everyone else
// Silences every voice and stream you receive; your own mic is unaffected.
function toggleDeafen() {
  state.deafened = !state.deafened;
  const btn = $('#deafenBtn');
  btn.classList.toggle('muted', state.deafened);
  label(btn, state.deafened ? 'Hear everyone again' : 'Mute everyone else');
  applyVolumes();
  Log.info('media', state.deafened ? 'muted everyone else' : 'unmuted everyone else');
  Sfx.play(state.deafened ? 'deafen' : 'undeafen');
}

function resetDeafen() {
  if (state.deafened) toggleDeafen();
}

// ------------------------------------------------------------------ quick stream quality
// One switch on your own stream changes video and audio together. Settings > Video
// keeps the fine-grained options; a mix that matches no preset shows none selected.
const QUALITY_PRESETS = {
  low: { shareRes: '720', shareFps: '30', videoQuality: 'low', streamAudio: '128' },
  medium: { shareRes: '1080', shareFps: '60', videoQuality: 'high', streamAudio: '256' },
  high: { shareRes: '1440', shareFps: '60', videoQuality: 'veryhigh', streamAudio: '256' },
};
const QUALITY_HINTS = {
  low: '720p, 30 fps, up to 2.5 Mbps',
  medium: '1080p, 60 fps, up to 8 Mbps',
  high: '1440p, 60 fps, up to 20 Mbps',
};

function currentPreset() {
  return Object.keys(QUALITY_PRESETS).find((name) =>
    Object.entries(QUALITY_PRESETS[name]).every(([k, v]) => settings[k] === v)) || null;
}

function addQualityPicker(tileEl) {
  const pick = document.createElement('div');
  pick.className = 'seg mini quality-pick';
  pick.setAttribute('role', 'group');
  pick.setAttribute('aria-label', 'Stream quality');
  for (const [name, text] of [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.preset = name;
    b.textContent = text;
    b.title = QUALITY_HINTS[name];
    b.onclick = () => applyQualityPreset(name);
    pick.append(b);
  }
  tileEl.querySelector('.actions').prepend(pick);
  syncQualityPickers();
}

function applyQualityPreset(name) {
  Log.info('media', `stream quality ${name}`);
  for (const [k, v] of Object.entries(QUALITY_PRESETS[name])) {
    if (settings[k] !== v) setSetting(k, v);
  }
  syncQualityPickers();
}

function syncQualityPickers() {
  const current = currentPreset();
  for (const b of document.querySelectorAll('.quality-pick button')) {
    b.classList.toggle('active', b.dataset.preset === current);
  }
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
  if (name === 'leave' && state.mode) { Sfx.play('hangup'); leave(); }
  if (name === 'deafen' && state.mode) toggleDeafen();
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
      deafen: settings.deafenKey,
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
    : "Right now these only work while the Miserecord window is active. In the installed app they work everywhere, even in games.";
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
  for (const [id, key] of [['#sMicGain', 'micGain'], ['#sVoiceVol', 'voiceVolume'], ['#sStreamVol', 'streamVolume'], ['#sRingVol', 'ringVolume']]) {
    const input = $(id);
    syncSlider(input, settings[key]);
    input.oninput = () => {
      setSetting(key, Number(input.value));
      syncSlider(input);
      if (key === 'micGain') applyMicGain();
      else if (key !== 'ringVolume') applyVolumes();
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
    for (const name of ['mute', 'deafen', 'leave']) {
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
      if (!p.canAutostart) $('#sBackgroundNote').append(' ', Object.assign(document.createElement('span'), { textContent: 'Starting with Windows works in the installed app.' }));
      pushHotkeys();
      // First launch of the installed app: pick microphone and speaker, and
      // opt in to starting with Windows (off unless you choose it).
      if (p.canAutostart && !p.setupDone) showSetup(desk, p);
    });
    $('#sBackground').onchange = () => desk.setPref('background', $('#sBackground').checked);
    $('#sAutostart').onchange = () => desk.setPref('autostart', $('#sAutostart').checked);
  } else {
    pushHotkeys();
  }
}

// Called when the settings sheet opens.
function syncExtras() {
  for (const [id, key] of [['#sMicGain', 'micGain'], ['#sVoiceVol', 'voiceVolume'], ['#sStreamVol', 'streamVolume'], ['#sRingVol', 'ringVolume']]) {
    syncSlider($(id), settings[key]);
    const text = $(`${id}Text`);
    if (text) text.textContent = `${settings[key]}%`;
  }
  $('#sRing').checked = settings.ringtone;
  $('#sPtt').checked = settings.ptt;
  capturing = null;
  renderKeycaps();
}

// ------------------------------------------------------------------ first-launch setup (desktop app)
async function showSetup(desk, p) {
  Log.info('app', 'showing first-launch setup');
  $('#setupAutostart').checked = !!p.autostart;
  $('#setup').hidden = false;
  let stream = null;
  let ctx = null;

  const fill = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const put = (select, kind, current, fallback) => {
      select.innerHTML = '';
      select.append(new Option('System default', ''));
      let n = 0;
      for (const d of devices.filter((x) => x.kind === kind && x.deviceId && !['default', 'communications'].includes(x.deviceId))) {
        select.append(new Option(d.label || `${fallback} ${++n}`, d.deviceId));
      }
      select.value = [...select.options].some((o) => o.value === current) ? current : '';
    };
    put($('#setupMic'), 'audioinput', settings.micId, 'Microphone');
    put($('#setupSpeaker'), 'audiooutput', settings.speakerId, 'Speaker');
  };

  // Open the chosen mic so its level shows and device names become visible.
  const listen = async () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
    stream = null;
    ctx = null;
    try {
      stream = await getMic();
    } catch (err) {
      Log.warn('media', 'setup could not open the microphone', err);
      return;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const mine = ctx;
    const tick = () => {
      if (ctx !== mine || $('#setup').hidden) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += (v - 128) ** 2;
      $('#setupLevel').style.width = `${Math.min(100, (Math.sqrt(sum / data.length) / 128) * 600).toFixed(0)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  };

  await listen();
  await fill();
  $('#setupMic').onchange = async () => { settings.micId = $('#setupMic').value; await listen(); };
  $('#setupSpeaker').onchange = () => { settings.speakerId = $('#setupSpeaker').value; };
  $('#setupSpeaker').disabled = typeof HTMLMediaElement.prototype.setSinkId !== 'function';
  // Plays only when you press it, at a soft level, on the speaker you picked.
  $('#setupTest').onclick = () => Ringtone.playOnce(0.3);
  $('#setupDone').onclick = () => {
    setSetting('micId', $('#setupMic').value);
    setSetting('speakerId', $('#setupSpeaker').value);
    const autostart = $('#setupAutostart').checked;
    desk.setPref('autostart', autostart);
    desk.setPref('askedAutostart', true);
    desk.setPref('setupDone', true);
    $('#sAutostart').checked = autostart;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
    $('#setup').hidden = true;
    Log.info('app', 'setup done', { mic: settings.micId ? 'chosen' : 'default', speaker: settings.speakerId ? 'chosen' : 'default', autostart });
  };
}
