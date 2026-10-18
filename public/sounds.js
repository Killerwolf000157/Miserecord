// Soft interface sounds: mute, mute everyone else, streams, people joining and
// leaving, new messages. Short sine blips made with Web Audio (no files), kept
// quiet on purpose: the loudest peaks at about -26 dBFS at the default volume.
// Loaded after settings.js.
'use strict';

Object.assign(SETTINGS_DEFAULTS, { sfx: true, sfxVolume: 40 });
for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) if (!(k in settings)) settings[k] = v;

// Each sound is a few notes: [frequency in Hz, start in s, length in s, level 0..1]
const SFX = {
  mute:        [[660, 0, 0.09, 1], [494, 0.07, 0.12, 0.9]],
  unmute:      [[494, 0, 0.09, 0.9], [660, 0.07, 0.12, 1]],
  deafen:      [[392, 0, 0.1, 1], [294, 0.08, 0.16, 0.9]],
  undeafen:    [[294, 0, 0.1, 0.9], [392, 0.08, 0.16, 1]],
  streamStart: [[523, 0, 0.12, 0.8], [659, 0.07, 0.12, 0.85], [784, 0.14, 0.22, 1]],
  streamStop:  [[784, 0, 0.12, 0.9], [659, 0.07, 0.12, 0.85], [523, 0.14, 0.2, 0.8]],
  join:        [[587, 0, 0.16, 0.9], [880, 0.1, 0.3, 1]],
  leave:       [[880, 0, 0.16, 0.9], [587, 0.1, 0.3, 0.9]],
  message:     [[1047, 0, 0.08, 0.6], [1319, 0.05, 0.12, 0.5]],
  hangup:      [[440, 0, 0.14, 1], [330, 0.1, 0.26, 0.9]],
};

const Sfx = {
  ctx: null,
  last: new Map(),

  play(name, { force = false } = {}) {
    const notes = SFX[name];
    if (!notes || (!settings.sfx && !force)) return;
    // The same sound twice in a row (e.g. a key held down) plays once.
    const now = performance.now();
    if (now - (this.last.get(name) || 0) < 150) return;
    this.last.set(name, now);
    try {
      this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (typeof ctx.setSinkId === 'function' && ctx.sinkId !== (settings.speakerId || '')) {
        ctx.setSinkId(settings.speakerId || '').catch(() => {});
      }
      scheduleSfx(ctx, ctx.destination, ctx.currentTime + 0.01, notes, settings.sfxVolume / 100);
    } catch (err) {
      Log.warn('media', 'interface sound failed', err);
    }
  },
};

function scheduleSfx(ctx, destination, t0, notes, volume) {
  const master = ctx.createGain();
  master.gain.value = 0.12 * Math.max(0, Math.min(1, volume));
  master.connect(destination);
  for (const [freq, at, len, level] of notes) {
    const start = t0 + at;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(level, start + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, start + len);
    env.connect(master);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(env);
    osc.start(start);
    osc.stop(start + len + 0.02);
  }
}

function initSounds() {
  const sw = $('#sSfx');
  const vol = $('#sSfxVol');
  sw.checked = settings.sfx;
  syncSlider(vol, settings.sfxVolume);
  sw.onchange = () => setSetting('sfx', sw.checked);
  vol.oninput = () => { setSetting('sfxVolume', Number(vol.value)); syncSlider(vol); };
  // Preview only when you press it.
  $('#sSfxTest').onclick = () => Sfx.play('join', { force: true });
}
