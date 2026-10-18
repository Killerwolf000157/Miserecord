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

function applyVolumes() {
  for (const peer of state.peers.values()) {
    for (const entry of peer.remote.values()) {
      if (entry.audio) {
        entry.audio.volume = voiceVolumeFor(peer);
        entry.audio.muted = !!state.deafened;
      }
      if (entry.tile) {
        entry.tile.video.volume = settings.streamVolume / 100;
        entry.tile.video.muted = !!state.deafened;
      }
    }
  }
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

// ------------------------------------------------------------------ mute everyone else
// Silences every voice and stream you receive; your own mic is unaffected.
function toggleDeafen() {
  state.deafened = !state.deafened;
  const btn = $('#deafenBtn');
  btn.classList.toggle('muted', state.deafened);
  label(btn, state.deafened ? 'Hear everyone again' : 'Mute everyone else');
  applyVolumes();
  Log.info('media', state.deafened ? 'muted everyone else' : 'unmuted everyone else');
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
  if (name === 'leave' && state.mode) leave();
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
  for (const [id, key] of [['#sVoiceVol', 'voiceVolume'], ['#sStreamVol', 'streamVolume'], ['#sRingVol', 'ringVolume']]) {
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
      if (!p.canAutostart) $('#sBackgroundNote').textContent += ' Starting with Windows works in the installed app.';
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
