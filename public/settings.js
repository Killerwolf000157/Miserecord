// Miserecord settings: devices, audio and video quality, codecs, theme, network.
// Settings live in localStorage. Changes apply right away, mid-call included,
// except the codec, which is renegotiated with your friend.
'use strict';

const SETTINGS_DEFAULTS = {
  theme: 'system',
  micId: '',
  speakerId: '',
  echo: true,
  // off | standard (the browser's) | ai (DeepFilterNet3: removes keyboards and noise,
  // keeps the whole voice)
  noise: 'ai',
  agc: true,
  // High by default. These are ceilings: WebRTC lowers the rate on its own when
  // a connection can't keep up, so a slow line still works.
  voice: 'veryhigh',    // 128 kbps; mono voice doesn't improve much beyond this
  streamAudio: '256',   // near-transparent stereo
  shareRes: '1440',     // sharp text without 4K's upload cost
  shareFps: '60',
  videoQuality: 'veryhigh', // up to 20 Mbps, enough for crisp 1440p60
  motion: 'auto',       // screen shares balanced, videos smooth
  // H.264 is the one codec encoded by the graphics card here (NVIDIA, AMD and Intel
  // through Windows); AV1, VP9 and VP8 run on the CPU, which can't keep up with a
  // game at 1440p60. If you pick AV1 and it can't keep up, the call drops to
  // H.264 by itself (see checkCodecLoad).
  codec: 'video/H264',
  language: 'auto',     // auto follows Windows; en | fr
  micGain: 100,         // your microphone volume for everyone, 0-200%
  adaptive: true,       // smart streaming: start where this computer can, step down when it struggles
  engine: true,         // native capture + hardware encoder for screen shares, when everyone can show it
  // While you share a whole screen, leave Miserecord's window out of the capture
  // (no endless mirror). Windows then also leaves it out of screenshots.
  hideFromShare: true,
};

// Earlier versions saved their (lower) defaults with every settings change.
// Values still equal to those old defaults were never picked by hand, so they
// move up to the new ones. Anything you chose yourself stays.
const SETTINGS_VERSION = 5;
// Versions 4 and 5 moved everyone's call quality to the best settings once each:
// AI noise suppression, H.264 on the graphics card, balanced streaming, 1440p60.
// Devices, volumes, keys, theme and language are kept.
const BEST_QUALITY_KEYS = ['noise', 'echo', 'agc', 'voice', 'streamAudio', 'shareRes', 'shareFps', 'videoQuality', 'motion', 'codec'];
const OLD_DEFAULTS = { voice: 'high', shareRes: 'native', shareFps: '30', videoQuality: 'high' };

const VOICE_BITRATE = { standard: 32000, high: 64000, veryhigh: 128000, hifi: 256000 };
const VIDEO_BITRATE = { auto: null, low: 2.5e6, high: 8e6, veryhigh: 20e6, max: 50e6 };
const SHARE_SIZE = { native: null, 2160: [3840, 2160], 1440: [2560, 1440], 1080: [1920, 1080], 720: [1280, 720] };
const CODEC_NAMES = { 'video/H264': 'H.264, on the graphics card (smoothest)', 'video/AV1': 'AV1, sharpest, heavy on the CPU', 'video/VP9': 'VP9, on the CPU', 'video/VP8': 'VP8, most compatible' };

const settings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('miserecord.settings')) || {}; } catch { /* storage off */ }
  if ((saved.version || 1) < 2) {
    for (const [key, old] of Object.entries(OLD_DEFAULTS)) {
      if (saved[key] === old) delete saved[key];
    }
  }
  if ((saved.version || 1) < 4) for (const key of BEST_QUALITY_KEYS) delete saved[key];
  // Version 5 (1.6.1) resets call quality to the best settings once more: AV1 ran
  // on the CPU and dropped game streams to a few fps, so it's H.264 on the
  // graphics card now, with motion-friendly screen shares.
  if ((saved.version || 1) < 5) for (const key of BEST_QUALITY_KEYS) delete saved[key];
  // The noise switch became a choice; on, and the earlier AI models, become the new AI.
  if (saved.noise === true || saved.noise === 'strong' || saved.noise === 'strongest') delete saved.noise;
  if (saved.noise === false) saved.noise = 'off';
  return { ...SETTINGS_DEFAULTS, ...saved, version: SETTINGS_VERSION };
})();

function setSetting(key, value) {
  settings[key] = value;
  try { localStorage.setItem('miserecord.settings', JSON.stringify(settings)); } catch { /* storage off */ }
  onSettingChanged(key);
}

// ------------------------------------------------------------------ constraints

function isHifi() {
  return settings.voice === 'hifi';
}

function micConstraints(withDevice = true) {
  const hifi = isHifi();
  const audio = {
    echoCancellation: hifi ? false : settings.echo,
    // AI mode does its own noise removal; stacking both dulls the voice.
    noiseSuppression: hifi ? false : settings.noise === 'standard',
    // With AI on, its own leveller sets the volume after the noise is gone; the
    // browser's would turn the noise up first.
    autoGainControl: hifi ? false : settings.agc && settings.noise !== 'ai',
    sampleRate: { ideal: 48000 },
  };
  if (hifi) audio.channelCount = { ideal: 2 };
  if (withDevice && settings.micId) audio.deviceId = { exact: settings.micId };
  return { audio };
}

// Falls back to the default mic if the saved one was unplugged.
async function getRawMic() {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(true));
  } catch (err) {
    if (settings.micId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      return navigator.mediaDevices.getUserMedia(micConstraints(false));
    }
    throw err;
  }
}

// The microphone, through AI noise suppression when that's on and your
// microphone volume. If that can't start, the call still goes ahead with the
// plain microphone.
async function getMic() {
  const raw = await getRawMic();
  try {
    return await Denoise.wrap(raw, { ai: !isHifi() && settings.noise === 'ai', level: settings.agc, gain: settings.micGain / 100 });
  } catch (err) {
    Log.warn('media', 'microphone processing unavailable, using the plain microphone', err);
    return raw;
  }
}

// Change your microphone volume live, without restarting the microphone.
function applyMicGain() {
  for (const stream of [state.mic, state.testMic && state.testMic.stream]) {
    const track = stream && stream.getAudioTracks()[0];
    if (track && track.setGain) track.setGain(settings.micGain / 100);
  }
}

function shareVideoConstraints() {
  const fps = Number(settings.shareFps);
  const video = { frameRate: { ideal: fps, max: fps } };
  const size = SHARE_SIZE[settings.shareRes];
  if (size) {
    video.width = { ideal: size[0], max: size[0] };
    video.height = { ideal: size[1], max: size[1] };
  }
  return video;
}

function shareConstraints() {
  return {
    video: shareVideoConstraints(),
    // Shared audio is music or game sound: no voice processing. restrictOwnAudio
    // leaves Miserecord's own sound out of the system audio, so your friends
    // don't hear themselves (and the call) coming back through your stream.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true },
    systemAudio: 'include',
  };
}

// ------------------------------------------------------------------ applying to the call

function senderKind(peerId, sender) {
  if (state.screen && (state.screen.senders.get(peerId) || []).includes(sender)) return 'screen';
  if (state.media && (state.media.senders.get(peerId) || []).includes(sender)) return 'media';
  return 'mic';
}

// sharp keeps full resolution and drops frames when the line or computer can't
// keep up (text stays readable, but a game can fall to a few fps); smooth keeps
// the frame rate; balanced lowers both a little, which suits games and desktops.
function motionFor(kind) {
  if (settings.motion !== 'auto') return settings.motion;
  return kind === 'media' ? 'smooth' : 'balanced';
}

const DEGRADATION = { sharp: 'maintain-resolution', smooth: 'maintain-framerate', balanced: 'balanced' };

// Bitrate caps and how video degrades are set per sender, live.
async function applySendParams() {
  for (const peer of state.peers.values()) await applySendParamsTo(peer);
}

async function applySendParamsTo(peer) {
  const pc = peer.pc;
  if (pc.signalingState === 'closed') return;
  for (const sender of pc.getSenders()) {
    const track = sender.track;
    if (!track) continue;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) continue; // not negotiated yet
    const kind = senderKind(peer.id, sender);
    const enc0 = params.encodings[0];
    if (track.kind === 'audio') {
      enc0.maxBitrate = kind === 'mic' ? VOICE_BITRATE[settings.voice] : Number(settings.streamAudio) * 1000;
      if (kind !== 'mic' && 'contentHint' in track) track.contentHint = 'music';
    } else {
      const bitrate = VIDEO_BITRATE[settings.videoQuality];
      if (bitrate) enc0.maxBitrate = bitrate;
      else delete enc0.maxBitrate;
      if (kind === 'screen') enc0.maxFramerate = Adapt.fps();
      const motion = motionFor(kind);
      // "detail" puts the encoder in its slides-and-text mode: sharp, but it drops
      // frames hard on fast motion (a game fell to 3 fps). Only "Keep it sharp" uses it.
      if ('contentHint' in track) track.contentHint = motion === 'sharp' ? 'detail' : 'motion';
      params.degradationPreference = DEGRADATION[motion] || 'balanced';
    }
    try {
      await sender.setParameters(params);
    } catch {
      // Older browsers reject degradationPreference; keep the bitrate at least.
      delete params.degradationPreference;
      try { await sender.setParameters(params); } catch (err) { console.warn('setParameters failed', err); }
    }
  }
}

// WebRTC starts video at a few hundred kbps and ramps up over many seconds, so a
// stream looks blurry at first. Start higher; it still backs off on a slow line.
const VIDEO_START_KBPS = 4000;

// Merge parameters into a payload type's fmtp line, adding the line if missing.
function setFmtp(sdp, pt, extra) {
  const line = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (line.test(sdp)) {
    return sdp.replace(line, (_, params) => {
      const map = new Map(params.split(';').map((p) => p.trim()).filter(Boolean).map((p) => p.split('=')));
      for (const [k, v] of Object.entries(extra)) map.set(k, v);
      return `a=fmtp:${pt} ${[...map].map(([k, v]) => `${k}=${v}`).join(';')}`;
    });
  }
  const rtpmap = new RegExp(`(a=rtpmap:${pt} [^\\r\\n]*)(\\r?\\n)`);
  return sdp.replace(rtpmap, (_, map, nl) => `${map}${nl}a=fmtp:${pt} ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(';')}${nl}`);
}

// Ask for stereo Opus up to 510 kbps (the actual rate is capped by applySendParams())
// and a higher starting rate for video.
function mungeSdp(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (m) sdp = setFmtp(sdp, m[1], { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000' });
  const cap = VIDEO_BITRATE[settings.videoQuality];
  const start = String(Math.round(Math.min(VIDEO_START_KBPS, cap ? cap / 1000 : VIDEO_START_KBPS)));
  for (const [, pt] of sdp.matchAll(/a=rtpmap:(\d+) (?:VP8|VP9|AV1|H264)\/90000/gi)) {
    sdp = setFmtp(sdp, pt, { 'x-google-start-bitrate': start });
  }
  return sdp;
}

// Codecs this computer can encode on the graphics card, best first. A software
// encoder struggles with 1440p60 and the stream turns blocky or choppy.
const hardwareCodecs = [];
(async () => {
  if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.encodingInfo) return;
  for (const type of ['video/AV1', 'video/VP9', 'video/H264']) {
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: { contentType: type, width: 2560, height: 1440, bitrate: 20e6, framerate: 60 },
      });
      if (info.supported && info.powerEfficient) hardwareCodecs.push(type);
    } catch { /* not supported here */ }
  }
  Log.info('media', 'hardware video encoders', hardwareCodecs.length ? hardwareCodecs.join(', ') : 'none');
})();

function supportedVideoCodecs() {
  const send = (window.RTCRtpSender && RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video')) || { codecs: [] };
  const recv = (window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video')) || { codecs: [] };
  const recvTypes = new Set(recv.codecs.map((c) => c.mimeType));
  return Object.keys(CODEC_NAMES).filter((t) => send.codecs.some((c) => c.mimeType === t) && recvTypes.has(t));
}

// Put the chosen codec first on every video transceiver before an offer or answer.
function applyCodecPrefs(pc) {
  if (!window.RTCRtpTransceiver || !('setCodecPreferences' in RTCRtpTransceiver.prototype)) return;
  const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
  if (!caps) return;
  // Automatic puts a hardware-encoded codec first when there is one.
  const codec = state.codecOverride || settings.codec;
  const want = codec === 'auto' ? hardwareCodecs.filter((t) => supportedVideoCodecs().includes(t)) : [codec];
  const rank = (c) => (want.includes(c.mimeType) ? want.indexOf(c.mimeType) : want.length);
  const ordered = want.length ? [...caps.codecs].sort((a, b) => rank(a) - rank(b)) : [];
  for (const t of pc.getTransceivers()) {
    if (t.stopped || !t.receiver.track || t.receiver.track.kind !== 'video') continue;
    try { t.setCodecPreferences(ordered); } catch (err) { Log.warn('pc', 'codec preference rejected', err); }
  }
}

// Create and set our offer or answer with codec preferences and stereo audio.
// Some browsers (e.g. Firefox) refuse edited descriptions; then use the browser's own.
async function setLocal(pc) {
  applyCodecPrefs(pc);
  const desc = pc.signalingState === 'have-remote-offer' ? await pc.createAnswer() : await pc.createOffer();
  const edited = mungeSdp(desc.sdp);
  if (edited !== desc.sdp && !state.mungeRejected) {
    try {
      await pc.setLocalDescription({ type: desc.type, sdp: edited });
      return;
    } catch (err) {
      state.mungeRejected = true;
      Log.warn('pc', 'the stereo audio and start bitrate tweaks were rejected, using the default description', err);
    }
  }
  await pc.setLocalDescription(desc);
}

function applySpeaker(el) {
  if (!el || typeof el.setSinkId !== 'function') return;
  el.setSinkId(settings.speakerId || '').catch(() => {
    if (settings.speakerId) el.setSinkId('').catch(() => {});
  });
}

function allRemoteMediaElements() {
  const els = [];
  for (const peer of state.peers.values()) {
    for (const entry of peer.remote.values()) {
      if (entry.audio) els.push(entry.audio);
      if (entry.tile) els.push(entry.tile.video);
    }
  }
  return els;
}

// Swap in a new microphone without dropping the call.
async function restartMic() {
  if (!state.mode) return; // applies to the next call
  let stream;
  try {
    stream = await getMic();
  } catch (err) {
    toast(`Couldn't use that microphone: ${err.message}`, 'err');
    return;
  }
  const track = stream.getAudioTracks()[0];
  const old = state.mic;
  for (const peer of state.peers.values()) {
    const sender = old && peer.pc.getSenders().find((s) => s.track && old.getAudioTracks().includes(s.track));
    if (sender) await sender.replaceTrack(track);
    else peer.pc.addTrack(track, stream);
  }
  if (old) old.getTracks().forEach((t) => t.stop());
  state.mic = stream;
  applyMicEnabled();
  $('#micBtn').disabled = false;
  attachMeter($('#meCard'), stream);
  applySendParams();
  refreshDevices();
}

function onSettingChanged(key) {
  switch (key) {
    case 'theme':
      applyTheme();
      break;
    case 'language':
      I18n.apply(settings.language);
      break;
    case 'hideFromShare':
      if (window.miserecordDesktop && window.miserecordDesktop.setHideFromShare) window.miserecordDesktop.setHideFromShare(settings.hideFromShare);
      break;
    case 'micId':
    case 'echo':
    case 'noise':
    case 'agc':
      restartMic();
      if (state.testMic) startMicTest(true);
      break;
    case 'voice':
      syncProcessingSwitches();
      restartMic();
      if (state.testMic) startMicTest(true);
      break;
    case 'streamAudio':
    case 'videoQuality':
    case 'motion':
      applySendParams();
      break;
    case 'shareRes':
    case 'shareFps':
    case 'adaptive':
      // Smart streaming starts again from your choice.
      if (state.screen) Adapt.reset();
      else applySendParams();
      break;
    case 'speakerId':
      for (const el of allRemoteMediaElements()) applySpeaker(el);
      Playback.applySink();
      break;
    case 'codec':
      if (state.peers.size) {
        broadcast({ type: 'codec', codec: settings.codec });
        renegotiate();
      }
      break;
  }
}

// Your friend picked a codec: use the same one so both directions agree.
function onPeerCodec(codec) {
  if (codec !== 'auto' && !supportedVideoCodecs().includes(codec)) return;
  settings.codec = codec;
  try { localStorage.setItem('miserecord.settings', JSON.stringify(settings)); } catch { /* storage off */ }
  if (!$('#settings').hidden) $('#sCodec').value = codec;
  toast(codec === 'auto' ? 'Your friend set the codec back to automatic' : `Your friend switched the codec to ${CODEC_NAMES[codec].split(',')[0]}`);
}

// ------------------------------------------------------------------ theme

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'system') {
    delete root.dataset.theme;
    try { localStorage.removeItem('miserecord.theme'); } catch { /* storage off */ }
  } else {
    root.dataset.theme = settings.theme;
    try { localStorage.setItem('miserecord.theme', settings.theme); } catch { /* storage off */ }
  }
}

// ------------------------------------------------------------------ the settings sheet

function initSettings() {
  // Older versions stored only the theme; carry it over.
  try {
    const t = localStorage.getItem('miserecord.theme');
    if (t && !localStorage.getItem('miserecord.settings')) settings.theme = t;
  } catch { /* storage off */ }
  applyTheme();

  for (const btn of document.querySelectorAll('.settings-btn')) btn.onclick = openSettings;
  for (const btn of document.querySelectorAll('.theme-btn')) {
    btn.onclick = () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      setSetting('theme', dark ? 'light' : 'dark');
      syncTheme();
    };
  }
  $('#closeSettings').onclick = closeSettings;
  $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settings').hidden) closeSettings(); });

  for (const tab of document.querySelectorAll('#settingsTabs button')) {
    tab.onclick = () => showTab(tab.dataset.tab);
  }

  // General
  $('#sName').onchange = () => {
    const name = $('#sName').value.trim().slice(0, 32);
    if (!name) return;
    $('#name').value = name;
    save('name', name);
    if (state.name) {
      state.name = name;
      $('#meCard .label').textContent = name;
      $('#meCard .initial').textContent = initial(name);
      broadcast({ type: 'name', name });
    }
  };
  for (const b of document.querySelectorAll('#sTheme button')) b.onclick = () => { setSetting('theme', b.dataset.value); syncTheme(); };
  $('#sForget').onclick = () => {
    const n = Rendezvous.friends().length;
    if (!n || !confirm(I18n.t(`Remove all ${n} saved friend${n === 1 ? '' : 's'}? You'll need to swap codes again to call them.`))) return;
    for (const f of Rendezvous.friends()) Rendezvous.removeFriend(f.id);
    startListening();
    syncGeneral();
  };

  // Audio
  const bindSelect = (id, key) => { $(id).onchange = () => setSetting(key, $(id).value); };
  const bindSwitch = (id, key) => { $(id).onchange = () => setSetting(key, $(id).checked); };
  bindSelect('#sLanguage', 'language');
  bindSelect('#sMic', 'micId');
  bindSelect('#sSpeaker', 'speakerId');
  bindSelect('#sVoice', 'voice');
  bindSelect('#sStreamAudio', 'streamAudio');
  bindSwitch('#sEcho', 'echo');
  bindSelect('#sNoise', 'noise');
  bindSwitch('#sAgc', 'agc');
  $('#sMicTest').onclick = () => (state.testMic ? stopMicTest() : startMicTest());

  // Video
  bindSelect('#sShareRes', 'shareRes');
  bindSelect('#sShareFps', 'shareFps');
  bindSelect('#sQuality', 'videoQuality');
  bindSelect('#sMotion', 'motion');
  bindSelect('#sCodec', 'codec');
  bindSwitch('#sAdaptive', 'adaptive');
  bindSwitch('#sEngine', 'engine');
  bindSwitch('#sHideFromShare', 'hideFromShare');
  const codecs = supportedVideoCodecs();
  $('#sCodec').innerHTML = '';
  $('#sCodec').append(new Option('Automatic', 'auto'));
  for (const c of codecs) $('#sCodec').append(new Option(CODEC_NAMES[c], c));
  if (settings.codec !== 'auto' && !codecs.includes(settings.codec)) settings.codec = 'auto';

  // Troubleshooting
  $('#sLogCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(Log.text());
      toast('Log copied');
    } catch {
      toast("Couldn't copy. Use Download instead.", 'err');
    }
  };
  $('#sLogSave').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([Log.text()], { type: 'text/plain' }));
    a.download = `miserecord-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${Log.tabId}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#sLogClear').onclick = () => { Log.clear(); toast('Log cleared'); };

  // "Show details" on the connecting screens: the last log lines, live.
  for (const btn of document.querySelectorAll('.details-toggle')) {
    btn.onclick = () => {
      const pre = $(`#${btn.dataset.details}`);
      pre.hidden = !pre.hidden;
      btn.textContent = pre.hidden ? 'Show details' : 'Hide details';
      if (!pre.hidden) {
        pre.textContent = Log.lines(40).join('\n');
        pre.scrollTop = pre.scrollHeight;
      }
    };
  }
  Log.onEntry((e, line) => {
    for (const pre of document.querySelectorAll('.live-log')) {
      if (pre.hidden) continue;
      pre.textContent = Log.lines(40).join('\n');
      pre.scrollTop = pre.scrollHeight;
    }
  });
}

function openSettings() {
  $('#sName').value = $('#name').value || state.name || '';
  syncTheme();
  syncGeneral();
  $('#sLanguage').value = settings.language;
  $('#sVoice').value = settings.voice;
  $('#sStreamAudio').value = settings.streamAudio;
  $('#sEcho').checked = settings.echo;
  $('#sAgc').checked = settings.agc;
  syncProcessingSwitches();
  $('#sShareRes').value = settings.shareRes;
  $('#sShareFps').value = settings.shareFps;
  $('#sQuality').value = settings.videoQuality;
  $('#sMotion').value = settings.motion;
  $('#sCodec').value = settings.codec;
  $('#sAdaptive').checked = settings.adaptive;
  $('#sEngine').checked = settings.engine;
  $('#sHideFromShare').checked = settings.hideFromShare;
  $('#sHideRow').hidden = !window.miserecordDesktop;
  $('#sEngine').closest('.row').hidden = !(Native.caps && (Native.caps.codecs || []).length);
  syncSpecs();
  syncExtras();
  const canPickSpeaker = typeof HTMLMediaElement.prototype.setSinkId === 'function';
  $('#sSpeaker').disabled = !canPickSpeaker;
  $('#sSpeakerNote').hidden = canPickSpeaker;
  refreshDevices();
  // Watching for plugged-in devices keeps the camera service running (about
  // 60 MB), so it only runs while the device lists are on screen.
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }
  $('#settings').hidden = false;
  clearInterval(state.settingsTimer);
  state.settingsTimer = setInterval(updateSettingsLive, 1000);
  updateSettingsLive();
}

function closeSettings() {
  $('#settings').hidden = true;
  if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
    navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
  }
  clearInterval(state.settingsTimer);
  stopMicTest();
}

function showTab(name) {
  for (const tab of document.querySelectorAll('#settingsTabs button')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll('.settings-body [data-panel]')) panel.hidden = panel.dataset.panel !== name;
  if (name !== 'audio') stopMicTest();
}

function syncTheme() {
  for (const b of document.querySelectorAll('#sTheme button')) b.classList.toggle('active', b.dataset.value === settings.theme);
}

// "This computer" in Settings > Video: what the specs scan found and where a share starts.
function syncSpecs() {
  const info = Specs.info;
  const el = $('#sSpecs');
  if (!info) { el.textContent = window.miserecordDesktop ? '…' : ''; el.closest('.row').hidden = !window.miserecordDesktop; return; }
  const gpu = Specs.discrete() || info.gpus.find((g) => g.active) || info.gpus[0];
  el.textContent = [gpu && gpu.name, `${info.threads} threads`, `${info.ramGB} GB`].filter(Boolean).join(' · ');
  el.title = I18n.t('Screen shares start at {0}', levelName(Math.max(ceilingLevel(), info.start)));
}

function syncGeneral() {
  const n = Rendezvous.friends().length;
  $('#sFriendCount').textContent = n ? `${n} saved friend${n === 1 ? '' : 's'}` : 'No saved friends yet';
  $('#sForget').disabled = !n;
}

function syncProcessingSwitches() {
  const hifi = isHifi();
  for (const [id, key] of [['#sEcho', 'echo'], ['#sAgc', 'agc']]) {
    $(id).disabled = hifi;
    $(id).checked = hifi ? false : settings[key];
  }
  $('#sNoise').disabled = hifi;
  $('#sNoise').value = hifi ? 'off' : settings.noise;
  $('#sMicNote').textContent = hifi
    ? 'Hi-Fi voice is on, so these are off. Use headphones so your friend doesn\'t hear themselves.'
    : 'Echo cancellation stops your friend hearing themselves through your speakers. Turn it off only with headphones. AI noise suppression runs a small model on your computer that removes keyboards, fans and background noise and keeps your whole voice.';
}

async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (select, kind, current, fallbackName) => {
    select.innerHTML = '';
    select.append(new Option('System default', ''));
    let n = 0;
    for (const d of devices.filter((x) => x.kind === kind && x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications')) {
      n++;
      select.append(new Option(d.label || `${fallbackName} ${n}`, d.deviceId));
    }
    select.value = [...select.options].some((o) => o.value === current) ? current : '';
  };
  fill($('#sMic'), 'audioinput', settings.micId, 'Microphone');
  fill($('#sSpeaker'), 'audiooutput', settings.speakerId, 'Speaker');
}

// ---------- mic level in settings ----------
async function startMicTest(restart = false) {
  if (restart) stopMicTest(true);
  let stream = state.mic;
  if (!stream) {
    try {
      stream = await getMic();
    } catch (err) {
      toast(`Couldn't open the microphone: ${err.message}`, 'err');
      return;
    }
    state.testMic = { stream, own: true };
  } else {
    state.testMic = { stream, own: false };
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  state.testMic.ctx = ctx;
  $('#sMicTest').textContent = 'Stop';
  const tick = () => {
    if (!state.testMic || state.testMic.ctx !== ctx) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += (v - 128) ** 2;
    const level = Math.min(1, (Math.sqrt(sum / data.length) / 128) * 6);
    $('#sMicLevel').style.width = `${(level * 100).toFixed(0)}%`;
    requestAnimationFrame(tick);
  };
  tick();
  refreshDevices(); // labels appear once the browser has mic permission
}

function stopMicTest(keepButton = false) {
  const t = state.testMic;
  if (!t) return;
  state.testMic = null;
  t.ctx.close();
  if (t.own) t.stream.getTracks().forEach((x) => x.stop());
  $('#sMicLevel').style.width = '0';
  if (!keepButton) $('#sMicTest').textContent = 'Test';
}

// ---------- AV1 too heavy: fall back to H.264 for this call ----------
// Every 2 s while you send video: if the encoder is AV1 and sends under half the
// frame rate while the capture itself keeps up, for 6 s in a row, everyone in the
// call switches to H.264 (encoded by the graphics card) until the call ends.
let codecStrain = 0;
async function checkCodecLoad() {
  if ((!state.screen && !state.media) || state.codecOverride) { codecStrain = 0; return; }
  let strained = false;
  for (const peer of state.peers.values()) {
    if (peer.pc.connectionState !== 'connected') continue;
    const stats = await peer.pc.getStats();
    stats.forEach((r) => {
      if (r.type !== 'outbound-rtp' || r.kind !== 'video' || !r.frameWidth) return;
      const codec = r.codecId && stats.get(r.codecId);
      const want = state.screen ? Number(settings.shareFps) : 30;
      const source = r.mediaSourceId && stats.get(r.mediaSourceId);
      const captured = source && source.framesPerSecond != null ? source.framesPerSecond : want;
      // A still screen sends few frames on purpose; only count it while frames keep coming in.
      if (codec && codec.mimeType === 'video/AV1' && captured >= want * 0.5 && (r.framesPerSecond || 0) < Math.min(want, captured) / 2) strained = true;
    });
  }
  codecStrain = strained ? codecStrain + 1 : 0;
  if (codecStrain < 3) return;
  codecStrain = 0;
  const fallback = ['video/H264', 'video/VP8'].find((c) => supportedVideoCodecs().includes(c));
  if (!fallback) return;
  Log.warn('media', 'AV1 is too heavy for this computer, switching the call to ' + fallback);
  state.codecOverride = fallback;
  broadcast({ type: 'codec-fallback', codec: fallback });
  renegotiate();
  toast('Switched to H.264 for this call: AV1 was too heavy for this computer.');
}

// Someone's computer couldn't keep up with AV1: use their fallback for this call.
function onPeerCodecFallback(codec) {
  if (!supportedVideoCodecs().includes(codec)) return;
  Log.info('media', 'a friend switched the call to ' + codec);
  state.codecOverride = codec;
}

// ---------- live stats in the video tab ----------
const LIMIT_NAMES = { cpu: 'limited by CPU', bandwidth: 'limited by bandwidth', other: 'limited' };

// While you share, write what the encoder actually does to the log every 10 s,
// so a blurry or choppy stream can be traced to CPU, bandwidth or the codec.
async function logVideoQuality() {
  if (!state.screen && !state.media) return;
  for (const peer of state.peers.values()) {
    if (peer.pc.connectionState !== 'connected') continue;
    const stats = await peer.pc.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
    stats.forEach((r) => {
      if (r.type !== 'outbound-rtp' || r.kind !== 'video' || !r.frameWidth) return;
      const codec = r.codecId && stats.get(r.codecId);
      // What Windows hands over (capture) against what goes out (fps): a low
      // capture rate means the capture is the problem, not the encoder or the line.
      const source = r.mediaSourceId && stats.get(r.mediaSourceId);
      Log.info('stats', 'sending video', {
        peer: peer.id.slice(0, 6),
        size: `${r.frameWidth}x${r.frameHeight}`,
        captureFps: source && source.framesPerSecond != null ? Math.round(source.framesPerSecond) : null,
        fps: r.framesPerSecond != null ? Math.round(r.framesPerSecond) : null,
        codec: codec ? codec.mimeType.replace('video/', '') : null,
        encoder: r.encoderImplementation || null,
        gpu: r.powerEfficientEncoder,
        limit: r.qualityLimitationReason,
        targetMbps: r.targetBitrate ? +(r.targetBitrate / 1e6).toFixed(1) : null,
        availableMbps: pair && pair.availableOutgoingBitrate ? +(pair.availableOutgoingBitrate / 1e6).toFixed(1) : null,
      });
    });
  }
}
async function updateSettingsLive() {
  if (state.mic && !state.testMic && !$('[data-panel="audio"]').hidden) startMicTest();
  const live = [...state.peers.values()].filter((p) => p.pc.connectionState === 'connected');
  if (!live.length) {
    $('#sStatsOut').textContent = 'Not in a call';
    $('#sStatsIn').textContent = 'Not in a call';
    return;
  }
  const now = performance.now();
  const prev = state.statsPrev || {};
  const next = {};
  let out = null;
  let inn = null;
  let outStats = null;
  let inStats = null;
  let sendingTo = 0;
  for (const peer of live) {
    const stats = await peer.pc.getStats();
    let sends = false;
    stats.forEach((r) => {
      if (r.kind !== 'video' || !r.frameWidth) return;
      const tagged = Object.assign(Object.create(r), { key: `${peer.id}:${r.id}` });
      if (r.type === 'outbound-rtp') { sends = true; if (!out) { out = tagged; outStats = stats; } }
      if (r.type === 'inbound-rtp' && !inn) { inn = tagged; inStats = stats; }
    });
    if (sends) sendingTo++;
  }
  const describe = (r, bytesKey, stats) => {
    if (!r) return 'No video';
    const codec = r.codecId && stats.get(r.codecId);
    const name = codec ? codec.mimeType.replace('video/', '') : '';
    const p = prev[r.key];
    next[r.key] = { bytes: r[bytesKey], t: now };
    const mbps = p ? ((r[bytesKey] - p.bytes) * 8) / ((now - p.t) / 1000) / 1e6 : null;
    const fps = r.framesPerSecond ? `${Math.round(r.framesPerSecond)} fps` : '';
    const hw = r.powerEfficientEncoder === true || r.powerEfficientDecoder === true ? ' (GPU)' : '';
    const limit = LIMIT_NAMES[r.qualityLimitationReason] || '';
    return [`${r.frameWidth}×${r.frameHeight}`, fps, mbps != null ? `${mbps.toFixed(1)} Mbps` : '', name + hw, limit].filter(Boolean).join('  ');
  };
  $('#sStatsOut').textContent = describe(out, 'bytesSent', outStats) + (sendingTo > 1 ? `  to each of ${sendingTo}` : '');
  $('#sStatsIn').textContent = describe(inn, 'bytesReceived', inStats);
  state.statsPrev = next;
}
