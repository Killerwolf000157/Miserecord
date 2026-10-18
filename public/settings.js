// Miserecord settings: devices, audio and video quality, codecs, theme, network.
// Settings live in localStorage. Changes apply right away, mid-call included,
// except the codec, which is renegotiated with your friend.
'use strict';

const SETTINGS_DEFAULTS = {
  theme: 'system',
  micId: '',
  speakerId: '',
  echo: true,
  noise: true,
  agc: true,
  voice: 'high',
  streamAudio: '256',
  shareRes: 'native',
  shareFps: '30',
  videoQuality: 'high',
  motion: 'auto',
  codec: 'auto',
};

const VOICE_BITRATE = { standard: 32000, high: 64000, veryhigh: 128000, hifi: 256000 };
const VIDEO_BITRATE = { auto: null, high: 8e6, veryhigh: 20e6, max: 50e6 };
const SHARE_SIZE = { native: null, 2160: [3840, 2160], 1440: [2560, 1440], 1080: [1920, 1080], 720: [1280, 720] };
const CODEC_NAMES = { 'video/AV1': 'AV1, best quality', 'video/VP9': 'VP9', 'video/H264': 'H.264, uses less power', 'video/VP8': 'VP8, most compatible' };

const settings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('miserecord.settings')) || {}; } catch { /* storage off */ }
  return { ...SETTINGS_DEFAULTS, ...saved };
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
    noiseSuppression: hifi ? false : settings.noise,
    autoGainControl: hifi ? false : settings.agc,
    sampleRate: { ideal: 48000 },
  };
  if (hifi) audio.channelCount = { ideal: 2 };
  if (withDevice && settings.micId) audio.deviceId = { exact: settings.micId };
  return { audio };
}

// Falls back to the default mic if the saved one was unplugged.
async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(true));
  } catch (err) {
    if (settings.micId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      return navigator.mediaDevices.getUserMedia(micConstraints(false));
    }
    throw err;
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
    // Shared audio is music or game sound: no voice processing.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
  };
}

// ------------------------------------------------------------------ applying to the call

function senderKind(sender) {
  if (state.screen && state.screen.senders.includes(sender)) return 'screen';
  if (state.media && state.media.senders.includes(sender)) return 'media';
  return 'mic';
}

function motionFor(kind) {
  if (settings.motion !== 'auto') return settings.motion;
  return kind === 'media' ? 'smooth' : 'sharp';
}

// Bitrate caps and how video degrades are set per sender, live.
async function applySendParams() {
  const pc = state.pc;
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    const track = sender.track;
    if (!track) continue;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) continue; // not negotiated yet
    const kind = senderKind(sender);
    const enc0 = params.encodings[0];
    if (track.kind === 'audio') {
      enc0.maxBitrate = kind === 'mic' ? VOICE_BITRATE[settings.voice] : Number(settings.streamAudio) * 1000;
      if (kind !== 'mic' && 'contentHint' in track) track.contentHint = 'music';
    } else {
      const bitrate = VIDEO_BITRATE[settings.videoQuality];
      if (bitrate) enc0.maxBitrate = bitrate;
      else delete enc0.maxBitrate;
      if (kind === 'screen') enc0.maxFramerate = Number(settings.shareFps);
      const motion = motionFor(kind);
      if ('contentHint' in track) track.contentHint = motion === 'sharp' ? 'detail' : 'motion';
      params.degradationPreference = motion === 'sharp' ? 'maintain-resolution' : 'maintain-framerate';
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

// Ask for stereo Opus up to 510 kbps; the actual rate is capped by applySendParams().
function mungeSdp(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const line = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  const extra = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000' };
  if (!line.test(sdp)) return sdp;
  return sdp.replace(line, (_, params) => {
    const map = new Map(params.split(';').map((p) => p.trim()).filter(Boolean).map((p) => p.split('=')));
    for (const [k, v] of Object.entries(extra)) map.set(k, v);
    return `a=fmtp:${pt} ${[...map].map(([k, v]) => `${k}=${v}`).join(';')}`;
  });
}

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
  const want = settings.codec === 'auto' ? null : settings.codec;
  const ordered = want
    ? [...caps.codecs.filter((c) => c.mimeType === want), ...caps.codecs.filter((c) => c.mimeType !== want)]
    : [];
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
      Log.warn('pc', 'browser rejected the stereo audio tweak, using its own description', err);
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
  for (const entry of state.remote.values()) {
    if (entry.audio) els.push(entry.audio);
    if (entry.tile) els.push(entry.tile.video);
  }
  return els;
}

// Swap in a new microphone without dropping the call.
async function restartMic() {
  const inCall = !!state.pc || !$('#call').hidden || !$('#connect').hidden || !$('#ringing').hidden;
  if (!inCall) return;
  let stream;
  try {
    stream = await getMic();
  } catch (err) {
    toast(`Couldn't use that microphone: ${err.message}`, 'err');
    return;
  }
  const track = stream.getAudioTracks()[0];
  const old = state.mic;
  const sender = state.pc && old && state.pc.getSenders().find((s) => s.track && old.getAudioTracks().includes(s.track));
  if (sender) await sender.replaceTrack(track);
  else if (state.pc) state.pc.addTrack(track, stream);
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
      if (state.screen) {
        const v = state.screen.stream.getVideoTracks()[0];
        if (v) v.applyConstraints(shareVideoConstraints()).catch((err) => toast(`Couldn't change the shared screen: ${err.message}`, 'err'));
      }
      applySendParams();
      break;
    case 'speakerId':
      for (const el of allRemoteMediaElements()) applySpeaker(el);
      break;
    case 'codec':
      if (state.dc && state.dc.readyState === 'open') {
        sendDC({ type: 'codec', codec: settings.codec });
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
      sendDC({ type: 'name', name });
    }
  };
  for (const b of document.querySelectorAll('#sTheme button')) b.onclick = () => { setSetting('theme', b.dataset.value); syncTheme(); };
  $('#sForget').onclick = () => {
    const n = Rendezvous.friends().length;
    if (!n || !confirm(`Remove all ${n} saved friend${n === 1 ? '' : 's'}? You'll need to swap codes again to call them.`)) return;
    for (const f of Rendezvous.friends()) Rendezvous.removeFriend(f.id);
    startListening();
    syncGeneral();
  };

  // Audio
  const bindSelect = (id, key) => { $(id).onchange = () => setSetting(key, $(id).value); };
  const bindSwitch = (id, key) => { $(id).onchange = () => setSetting(key, $(id).checked); };
  bindSelect('#sMic', 'micId');
  bindSelect('#sSpeaker', 'speakerId');
  bindSelect('#sVoice', 'voice');
  bindSelect('#sStreamAudio', 'streamAudio');
  bindSwitch('#sEcho', 'echo');
  bindSwitch('#sNoise', 'noise');
  bindSwitch('#sAgc', 'agc');
  $('#sMicTest').onclick = () => (state.testMic ? stopMicTest() : startMicTest());

  // Video
  bindSelect('#sShareRes', 'shareRes');
  bindSelect('#sShareFps', 'shareFps');
  bindSelect('#sQuality', 'videoQuality');
  bindSelect('#sMotion', 'motion');
  bindSelect('#sCodec', 'codec');
  const codecs = supportedVideoCodecs();
  $('#sCodec').innerHTML = '';
  $('#sCodec').append(new Option('Automatic', 'auto'));
  for (const c of codecs) $('#sCodec').append(new Option(CODEC_NAMES[c], c));
  if (settings.codec !== 'auto' && !codecs.includes(settings.codec)) settings.codec = 'auto';

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }

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
  $('#sVoice').value = settings.voice;
  $('#sStreamAudio').value = settings.streamAudio;
  $('#sEcho').checked = settings.echo;
  $('#sNoise').checked = settings.noise;
  $('#sAgc').checked = settings.agc;
  syncProcessingSwitches();
  $('#sShareRes').value = settings.shareRes;
  $('#sShareFps').value = settings.shareFps;
  $('#sQuality').value = settings.videoQuality;
  $('#sMotion').value = settings.motion;
  $('#sCodec').value = settings.codec;
  syncExtras();
  const canPickSpeaker = typeof HTMLMediaElement.prototype.setSinkId === 'function';
  $('#sSpeaker').disabled = !canPickSpeaker;
  $('#sSpeakerNote').hidden = canPickSpeaker;
  refreshDevices();
  $('#settings').hidden = false;
  clearInterval(state.settingsTimer);
  state.settingsTimer = setInterval(updateSettingsLive, 1000);
  updateSettingsLive();
}

function closeSettings() {
  $('#settings').hidden = true;
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

function syncGeneral() {
  const n = Rendezvous.friends().length;
  $('#sFriendCount').textContent = n ? `${n} saved friend${n === 1 ? '' : 's'}` : 'No saved friends yet';
  $('#sForget').disabled = !n;
}

function syncProcessingSwitches() {
  const hifi = isHifi();
  for (const [id, key] of [['#sEcho', 'echo'], ['#sNoise', 'noise'], ['#sAgc', 'agc']]) {
    $(id).disabled = hifi;
    $(id).checked = hifi ? false : settings[key];
  }
  $('#sMicNote').textContent = hifi
    ? 'Hi-Fi voice is on, so these are off. Use headphones so your friend doesn\'t hear themselves.'
    : 'Echo cancellation stops your friend hearing themselves through your speakers. Turn it off only with headphones.';
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

// ---------- live stats in the video tab ----------
async function updateSettingsLive() {
  if (state.mic && !state.testMic && !$('[data-panel="audio"]').hidden) startMicTest();
  const pc = state.pc;
  if (!pc || pc.connectionState !== 'connected') {
    $('#sStatsOut').textContent = 'Not in a call';
    $('#sStatsIn').textContent = 'Not in a call';
    return;
  }
  const stats = await pc.getStats();
  const now = performance.now();
  const prev = state.statsPrev || {};
  const next = {};
  let out = null;
  let inn = null;
  stats.forEach((r) => {
    if (r.kind !== 'video') return;
    if (r.type === 'outbound-rtp' && r.frameWidth) out = r;
    if (r.type === 'inbound-rtp' && r.frameWidth) inn = r;
  });
  const describe = (r, bytesKey) => {
    if (!r) return 'No video';
    const codec = r.codecId && stats.get(r.codecId);
    const name = codec ? codec.mimeType.replace('video/', '') : '';
    const p = prev[r.id];
    next[r.id] = { bytes: r[bytesKey], t: now };
    const mbps = p ? ((r[bytesKey] - p.bytes) * 8) / ((now - p.t) / 1000) / 1e6 : null;
    const fps = r.framesPerSecond ? `${Math.round(r.framesPerSecond)} fps` : '';
    return [`${r.frameWidth}×${r.frameHeight}`, fps, mbps != null ? `${mbps.toFixed(1)} Mbps` : '', name].filter(Boolean).join('  ');
  };
  $('#sStatsOut').textContent = describe(out, 'bytesSent');
  $('#sStatsIn').textContent = describe(inn, 'bytesReceived');
  state.statsPrev = next;
}
