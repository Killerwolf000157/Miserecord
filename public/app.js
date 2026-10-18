// Miserecord client.
// Media and data travel over a direct WebRTC connection between the two
// browsers. There is no server: the first connection info is swapped by hand
// as two copy-paste codes, and once connected all further signaling
// (e.g. starting a screen share) goes over the direct connection itself.
'use strict';

const $ = (sel) => document.querySelector(sel);
const DEFAULT_STUN = 'stun:stun.l.google.com:19302\nstun:stun1.l.google.com:19302';
const FILE_BUFFER_HIGH = 4 * 1024 * 1024;
const FILE_BUFFER_LOW = 1024 * 1024;

const state = {
  name: '',
  // peer connection
  pc: null,
  dc: null,
  polite: false,
  makingOffer: false,
  ignoreOffer: false,
  settingAnswer: false,
  restartedIce: false,
  signalChain: Promise.resolve(),
  statsTimer: null,
  // local media
  mic: null,            // MediaStream
  muted: false,
  screen: null,         // { stream, senders, label }
  media: null,          // { stream, senders, label, el, url }
  // remote
  peerName: '',
  remote: new Map(),    // streamId -> { stream, tile? , audio? }
  remoteMeta: new Map(),// streamId -> { kind, label }
  // files
  fileChain: Promise.resolve(),
  incoming: null,
  // audio levels
  audioCtx: null,
  meters: new Map(),    // element -> analyser
};

// ===================================================================
// Join screen
// ===================================================================
function initJoin() {
  if (!window.isSecureContext) $('#insecure').hidden = false;
  $('#name').value = load('name') || '';
  $('#stun').value = load('stun') ?? DEFAULT_STUN;
  $('#relays').value = load('relays') ?? Rendezvous.DEFAULT_RELAYS.join('\n');
  $('#relays').onchange = () => { save('relays', $('#relays').value); startListening(); };
  $('#joinForm').onsubmit = (e) => e.preventDefault();
  $('#startBtn').onclick = () => join('host');
  $('#answerBtn').onclick = () => join('guest');
  $('#cancelRing').onclick = leave;
  $('#acceptBtn').onclick = () => state.ringIn && acceptCall(state.ringIn.friend, state.ringIn.sid);
  $('#declineBtn').onclick = declineCall;
  $('#name').focus();
  startListening();
}

// Shared setup before any call: name, microphone, your card.
async function prepare() {
  const name = $('#name').value.trim();
  if (!name) {
    $('#name').reportValidity();
    return false;
  }
  save('name', name);
  save('stun', $('#stun').value);
  state.name = name;
  $('#joinError').hidden = true;
  for (const b of document.querySelectorAll('#joinForm button')) b.disabled = true;

  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const askedAt = Date.now();
  Log.info('media', 'asking for microphone', { device: settings.micId ? 'chosen' : 'default', voice: settings.voice });
  // The browser waits silently while its permission prompt is open.
  const promptHint = setTimeout(() => {
    Log.warn('media', 'still waiting for microphone permission');
    toast('Waiting for microphone permission. Check the prompt near the address bar.');
  }, 3000);
  try {
    state.mic = await getMic();
    const t = state.mic.getAudioTracks()[0];
    Log.info('media', 'microphone ready', { ms: Date.now() - askedAt, label: t ? (t.label ? 'named device' : 'unnamed') : 'no track', settings: t && t.getSettings ? (({ sampleRate, channelCount, echoCancellation, noiseSuppression }) => ({ sampleRate, channelCount, echoCancellation, noiseSuppression }))(t.getSettings()) : null });
    attachMeter($('#meCard'), state.mic);
  } catch (err) {
    Log.warn('media', 'microphone unavailable', { ms: Date.now() - askedAt, error: `${err.name}: ${err.message}` });
    toast("No microphone access. You can still listen, chat and share.", 'err');
  } finally {
    clearTimeout(promptHint);
  }
  for (const b of document.querySelectorAll('#joinForm button')) b.disabled = false;

  $('#meCard .label').textContent = name;
  $('#meCard .initial').textContent = initial(name);
  $('#micBtn').disabled = !state.mic;
  return true;
}

// role: 'host' starts a call with codes, 'guest' answers with a code.
async function join(role) {
  if (!(await prepare())) return;
  // The code exchange comes first; the call screen opens once connected.
  showScreen('connect');
  startManual(role);
}

function showScreen(id) {
  for (const s of ['join', 'connect', 'ringing', 'call']) $(`#${s}`).hidden = s !== id;
}

// ===================================================================
// Saved friends: call again without codes, via encrypted relay messages
// ===================================================================
function relayUrls() {
  return $('#relays').value.split(/\s+/).filter((u) => /^wss:\/\/\S+$/.test(u));
}

function startListening() {
  if (state.pool) state.pool.close();
  state.pool = null;
  renderFriends();
  const count = Rendezvous.friends().length;
  if (!count) {
    Log.info('relay', 'no saved friends, not listening');
    return;
  }
  Log.info('relay', 'listening for calls', { friends: count, relays: relayUrls().length });
  state.pool = new Rendezvous.Pool(relayUrls(), onRelayMessage, onRelayStatus);
  state.pool.start();
}

function onRelayStatus(open) {
  $('#relayStatus').className = `status ${open ? 'ok' : 'wait'}`;
  $('#relayText').textContent = open ? 'Ready for calls' : 'Connecting to relays';
}

function renderFriends() {
  const list = Rendezvous.friends();
  const any = list.length > 0;
  $('#friendsSection').hidden = !any;
  $('#addTitle').hidden = !any;
  $('#startBtn').classList.toggle('primary', !any);
  $('#codesHint').textContent = any
    ? 'Swap two codes once with someone new. After that, they show up above.'
    : "You'll swap two codes with your friend over any chat app. After that first call they're saved here, so next time you just press Call.";
  const box = $('#friendList');
  box.textContent = '';
  for (const f of list) {
    const row = document.createElement('div');
    row.className = 'friend';
    row.innerHTML = `
      <div class="f-avatar"></div>
      <div class="f-text"><div class="f-name"></div><div class="f-sub"></div></div>
      <button type="button" class="icon-btn f-remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <button type="button" class="btn primary call-btn">
        <svg viewBox="0 0 24 24"><path d="M6.6 3.5h3l1.5 4-2 1.4a10 10 0 0 0 6 6l1.4-2 4 1.5v3a2 2 0 0 1-2.1 2A16.5 16.5 0 0 1 4.5 5.6a2 2 0 0 1 2.1-2.1z"/></svg>
        Call
      </button>`;
    row.querySelector('.f-avatar').textContent = initial(f.name);
    row.querySelector('.f-name').textContent = f.name;
    row.querySelector('.f-sub').textContent = `Last call ${sinceText(f.lastCall)}`;
    const remove = row.querySelector('.f-remove');
    remove.title = `Remove ${f.name}`;
    remove.setAttribute('aria-label', `Remove ${f.name}`);
    remove.onclick = () => {
      if (!confirm(`Remove ${f.name}? You'll need to swap codes again to call them.`)) return;
      Rendezvous.removeFriend(f.id);
      startListening();
    };
    row.querySelector('.call-btn').onclick = () => callFriend(f);
    box.append(row);
  }
}

function sinceText(t) {
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(t)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function callFriend(friend) {
  if (state.session || state.pc) {
    Log.warn('call', 'call pressed while already busy', { session: !!state.session, pc: !!state.pc });
    return;
  }
  if (!state.pool || !state.pool.connected()) {
    Log.warn('call', 'no relay connected, cannot call', { pool: !!state.pool });
    return toast("Can't reach the relays right now. Check your internet connection.", 'err');
  }
  if (!(await prepare())) return;
  const sid = randomId();
  Log.info('call', 'calling friend', { friend: friend.id.slice(0, 6), sid: sid.slice(0, 6), relays: state.pool.connected() });
  state.session = { friend, sid, role: 'caller' };
  showRinging(`Calling ${friend.name}`, `${friend.name} needs Miserecord open to pick up.`);
  setStatus('Ringing', 'wait');
  const ring = () => state.pool && state.pool.send(friend, { type: 'ring', sid, name: state.name });
  ring();
  state.session.ringTimer = setInterval(ring, 3000);
  state.session.timeout = setTimeout(() => {
    if (!state.session || state.session.sid !== sid || isConnected()) return;
    Log.warn('call', 'no answer after 60 s, giving up');
    leave();
    toast(`${friend.name} didn't pick up. They need Miserecord open to get calls.`);
  }, 60000);
}

function showRinging(title, sub) {
  $('#ringTitle').textContent = title;
  $('#ringSub').textContent = sub;
  showScreen('ringing');
}

function onRelayMessage(friend, msg) {
  const s = state.session;
  const mine = s && s.friend.id === friend.id;
  if (msg.type !== 'ring' || !state.ringIn || state.ringIn.sid !== msg.sid) {
    Log.info('relay', `received ${msg.type}`, { friend: friend.id.slice(0, 6), sid: String(msg.sid || '').slice(0, 6), mySession: s ? `${s.role} ${s.sid.slice(0, 6)}` : 'none', matches: !!(mine && s.sid === msg.sid) });
  }
  switch (msg.type) {
    case 'ring':
      if (mine) {
        // Both of you pressed Call at the same moment: one side answers the other.
        if (s.role === 'caller' && !state.pc && s.sid > msg.sid) acceptCall(friend, msg.sid, true);
        return;
      }
      if (s || state.pc || $('#join').hidden) {
        state.pool.send(friend, { type: 'busy', sid: msg.sid });
        return;
      }
      showIncoming(friend, msg.sid);
      break;
    case 'cancel':
      if (state.ringIn && state.ringIn.sid === msg.sid) {
        hideIncoming();
        toast(`Missed call from ${friend.name}`);
      }
      break;
    case 'accept':
      if (mine && s.role === 'caller' && s.sid === msg.sid && !state.pc) {
        stopRinging();
        setStatus(`Connecting to ${friend.name}`, 'wait');
        $('#ringTitle').textContent = `Connecting to ${friend.name}`;
        $('#ringSub').textContent = 'Setting up a direct connection.';
        armConnectTimeout();
        startPeer(false);
      }
      break;
    case 'decline':
    case 'busy':
      if (mine && s.role === 'caller' && s.sid === msg.sid && !state.pc) {
        leave();
        toast(msg.type === 'busy' ? `${friend.name} is in another call` : `${friend.name} can't talk right now`);
      }
      break;
    case 'signal':
      if (mine && s.sid === msg.sid && msg.data) queueSignal(msg.data);
      break;
  }
}

function showIncoming(friend, sid) {
  if (state.ringIn && state.ringIn.sid === sid) {
    state.ringIn.last = Date.now();
    return;
  }
  hideIncoming();
  state.ringIn = { friend, sid, last: Date.now() };
  Log.info('call', 'incoming call', { friend: friend.id.slice(0, 6), sid: sid.slice(0, 6) });
  $('#incomingTitle').textContent = `${friend.name} is calling`;
  $('#incoming').hidden = false;
  document.title = `${friend.name} is calling · Miserecord`;
  if (window.miserecordDesktop) window.miserecordDesktop.incomingCall(friend.name);
  // The caller re-sends every few seconds; if that stops, they gave up.
  state.ringIn.watch = setInterval(() => {
    if (state.ringIn && Date.now() - state.ringIn.last > 10000) {
      toast(`Missed call from ${state.ringIn.friend.name}`);
      hideIncoming();
    }
  }, 2000);
}

function hideIncoming() {
  if (state.ringIn) clearInterval(state.ringIn.watch);
  state.ringIn = null;
  $('#incoming').hidden = true;
  if (window.miserecordDesktop) window.miserecordDesktop.callAnswered();
  document.title = 'Miserecord';
}

function declineCall() {
  if (!state.ringIn) return;
  Log.info('call', 'declined incoming call');
  if (state.pool) state.pool.send(state.ringIn.friend, { type: 'decline', sid: state.ringIn.sid });
  hideIncoming();
}

// auto: both called each other at once and this side was already set up.
async function acceptCall(friend, sid, auto = false) {
  Log.info('call', auto ? 'both called at once, answering theirs' : 'answering call', { friend: friend.id.slice(0, 6), sid: sid.slice(0, 6) });
  hideIncoming();
  if (!auto && !(await prepare())) return;
  stopRinging();
  state.session = { friend, sid, role: 'callee' };
  showRinging(`Connecting to ${friend.name}`, 'Setting up a direct connection.');
  setStatus(`Connecting to ${friend.name}`, 'wait');
  armConnectTimeout();
  // The caller makes the offer; this side waits for it and answers.
  startPeer(true);
  const sent = await state.pool.send(friend, { type: 'accept', sid });
  Log.info('call', 'sent accept', { relays: sent });
  if (!sent) Log.error('call', 'no relay was connected, the caller will not see the answer');
}

function armConnectTimeout() {
  const s = state.session;
  clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    if (state.session !== s || isConnected()) return;
    Log.warn('call', 'not connected 30 s after answering, giving up', {
      pc: state.pc ? { signaling: state.pc.signalingState, ice: state.pc.iceConnectionState, gathering: state.pc.iceGatheringState, connection: state.pc.connectionState } : 'none',
    });
    if (state.pc) logIceDiagnosis(state.pc);
    leave();
    toast(`Couldn't connect to ${s.friend.name}. A strict firewall may be blocking direct connections.`, 'err');
  }, 30000);
}

function stopRinging() {
  const s = state.session;
  if (!s) return;
  clearInterval(s.ringTimer);
  clearTimeout(s.timeout);
}

function endSession() {
  stopRinging();
  state.session = null;
}

// ===================================================================
// First call with a new friend: swap two codes by hand
// ===================================================================
const CODE_PREFIX = 'MSR1.';

function startManual(role) {
  Log.info('codes', role === 'host' ? 'starting a call with codes' : 'joining with a code');
  const host = role === 'host';
  $('#connectTitle').textContent = host ? 'Start a call' : 'Join a call';
  $('#myCode').value = '';
  $('#theirCode').value = '';
  $('#copyCode').disabled = true;
  $('#useCode').disabled = false;
  $('#mMineTitle').textContent = host ? '1. Send this code to your friend' : '2. Send this reply code back to your friend';
  $('#mTheirsTitle').textContent = host ? "2. Paste your friend's reply code" : "1. Paste your friend's code";
  $('#useCode').textContent = host ? 'Connect' : 'Create reply';
  $('#mMine').style.order = host ? 0 : 1;
  $('#mMine').hidden = !host;
  if (host) {
    // The host's offer is created by onnegotiationneeded and lands in showMyCode().
    startPeer(false);
    setStatus('Preparing your code…', 'wait');
  } else {
    setStatus("Waiting for your friend's code", 'wait');
    $('#theirCode').focus();
  }
}

async function useTheirCode() {
  const host = !!state.pc && !state.polite;
  let description;
  try {
    description = await decodeCode($('#theirCode').value);
  } catch (err) {
    Log.warn('codes', 'pasted code could not be read', { length: $('#theirCode').value.length, error: err.message });
    return toast("That doesn't look like a Miserecord code. Copy the whole thing.", 'err');
  }
  const expected = host ? 'answer' : 'offer';
  Log.info('codes', `pasted ${description.type} code`, Log.sdp(description));
  if (description.type !== expected) {
    Log.warn('codes', `wrong code: expected ${expected}`);
    return toast(host ? "That's a start code. Paste your friend's reply code instead."
      : "That's a reply code. Paste the code from the friend who started the call.", 'err');
  }
  $('#useCode').disabled = true;
  if (!host) {
    startPeer(true);
    $('#mMine').hidden = false;
    setStatus('Preparing your reply code…', 'wait');
  } else {
    setStatus('Connecting directly to your friend…', 'wait');
  }
  queueSignal({ description });
}

// Called instead of sending our description to a server.
async function showMyCode() {
  const pc = state.pc;
  const started = Date.now();
  await waitForIceGathering(pc);
  if (pc !== state.pc) return;
  $('#myCode').value = await encodeCode(pc.localDescription);
  Log.info('codes', `${pc.localDescription.type} code ready`, { chars: $('#myCode').value.length, gatherMs: Date.now() - started, sdp: Log.sdp(pc.localDescription) });
  $('#copyCode').disabled = false;
  setStatus(state.polite ? 'Send the reply code back. Connecting once they paste it…'
    : "Send the code, then paste your friend's reply", 'wait');
}

// No trickle ICE in this mode: the code carries every candidate found.
function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    // Use whatever was found if a STUN server is slow.
    setTimeout(() => {
      if (pc.iceGatheringState !== 'complete') Log.warn('ice', 'gathering still running after 5 s, sending what was found so far');
      resolve();
    }, 5000);
  });
}

async function encodeCode(desc) {
  const json = new TextEncoder().encode(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
  const packed = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  let bin = '';
  for (const b of new Uint8Array(packed)) bin += String.fromCharCode(b);
  return CODE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decodeCode(code) {
  code = code.replace(/\s+/g, '');
  if (!code.startsWith(CODE_PREFIX)) throw new Error('bad prefix');
  const bin = atob(code.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  const desc = JSON.parse(text);
  if (!['offer', 'answer'].includes(desc.type) || typeof desc.sdp !== 'string') throw new Error('bad code');
  return desc;
}

function initManual() {
  $('#useCode').onclick = useTheirCode;
  $('#cancelConnect').onclick = leave;
  $('#copyCode').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#myCode').value);
      toast('Code copied');
    } catch {
      $('#myCode').select();
      toast('Press Ctrl+C to copy');
    }
  };
}

// ===================================================================
// Signaling
// ===================================================================
function sendSignal(data) {
  // Once connected, renegotiation (e.g. starting a screen share) goes over
  // the direct connection itself, so no new codes are needed.
  if (state.dc && state.dc.readyState === 'open') {
    Log.info('signal', `sent ${data.description ? data.description.type : 'candidate'} over the direct connection`);
    state.dc.send(JSON.stringify({ type: 'signal', data }));
    return Promise.resolve();
  }
  // Candidates are bundled into the description once gathering finishes,
  // so only descriptions are ever sent before connecting.
  if (!data.description) return Promise.resolve();
  // Calling a saved friend: send it as an encrypted relay message.
  if (state.session && state.pool) {
    const { friend, sid } = state.session;
    const pc = state.pc;
    const started = Date.now();
    return waitForIceGathering(pc).then(async () => {
      if (pc !== state.pc || !state.pool) {
        Log.warn('signal', 'connection changed while gathering, not sending');
        return;
      }
      const sent = await state.pool.send(friend, { type: 'signal', sid, data: { description: pc.localDescription } });
      Log.info('signal', `sent ${pc.localDescription.type} via relays`, { relays: sent, gatherMs: Date.now() - started, sdp: Log.sdp(pc.localDescription) });
      if (!sent) Log.error('signal', 'no relay was connected, nothing was sent');
    });
  }
  // First call with someone new: it becomes the code to copy.
  return showMyCode();
}

function queueSignal(data) {
  state.signalChain = state.signalChain
    .then(() => onSignal(data))
    .catch((err) => console.error('signal error', err));
}

// ===================================================================
// Peer connection with "perfect negotiation"
// (lets either side add or remove tracks at any time)
// ===================================================================
function startPeer(polite) {
  if (state.pc) {
    if (isConnected()) return;
    teardownPeer();
  }
  state.polite = polite;
  state.restartedIce = false;
  const servers = iceServers();
  const pc = new RTCPeerConnection({ iceServers: servers });
  state.pc = pc;
  Log.info('pc', 'created', { polite, stunServers: servers.length ? servers[0].urls.length : 0, via: state.session ? 'relay' : 'codes' });

  pc.onnegotiationneeded = async () => {
    // The guest never starts the first offer; it answers the pasted one.
    if (state.polite && !(state.dc && state.dc.readyState === 'open')) {
      Log.info('pc', 'negotiation needed, waiting for the other side to offer');
      return;
    }
    Log.info('pc', 'negotiation needed, making offer');
    try {
      state.makingOffer = true;
      await setLocal(pc);
      Log.info('pc', 'local offer set', Log.sdp(pc.localDescription));
      await sendSignal({ description: pc.localDescription });
    } catch (err) {
      Log.error('pc', 'making offer failed', err);
    } finally {
      state.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    Log.info('ice', 'local candidate', Log.candidate(candidate));
    if (candidate) sendSignal({ candidate });
  };
  pc.onicecandidateerror = (e) => Log.warn('ice', 'candidate error (often a STUN server not answering)', { url: e.url, code: e.errorCode, text: e.errorText });
  pc.onicegatheringstatechange = () => Log.info('ice', `gathering ${pc.iceGatheringState}`);
  pc.oniceconnectionstatechange = () => Log.info('ice', `connection ${pc.iceConnectionState}`);
  pc.ontrack = (e) => {
    Log.info('media', 'remote track', { kind: e.track.kind, stream: e.streams[0] ? e.streams[0].id.slice(0, 8) : 'none' });
    onRemoteTrack(e);
  };
  pc.onconnectionstatechange = () => {
    Log.info('pc', `connection ${pc.connectionState}`);
    onConnectionState(pc);
  };
  // Bitrate caps can only be set once a negotiation has finished.
  pc.onsignalingstatechange = () => {
    Log.info('pc', `signaling ${pc.signalingState}`);
    if (pc.signalingState === 'stable') applySendParams();
  };

  // Both sides create the same pre-agreed channel; no extra handshake needed.
  setupDataChannel(pc.createDataChannel('main', { negotiated: true, id: 0, ordered: true }));

  if (state.mic) for (const t of state.mic.getTracks()) pc.addTrack(t, state.mic);
  for (const kind of ['screen', 'media']) {
    const s = state[kind];
    if (s) s.senders = s.stream.getTracks().map((t) => pc.addTrack(t, s.stream));
  }
  setStatus('Connecting directly to your friend…', 'wait');
}

async function onSignal({ description, candidate }) {
  if (!state.pc) {
    // Ignore stray messages from a connection that already ended.
    if (!description || description.type !== 'offer') {
      Log.info('signal', 'ignored, no connection', description ? description.type : 'candidate');
      return;
    }
    startPeer(false);
  }
  const pc = state.pc;
  if (description) {
    Log.info('signal', `received ${description.type}`, Log.sdp(description));
    const readyForOffer = !state.makingOffer && (pc.signalingState === 'stable' || state.settingAnswer);
    const collision = description.type === 'offer' && !readyForOffer;
    state.ignoreOffer = !state.polite && collision;
    if (state.ignoreOffer) {
      Log.info('signal', 'offer collision, ignoring theirs (this side is impolite)');
      return;
    }
    if (collision) Log.info('signal', 'offer collision, rolling back ours (this side is polite)');
    state.settingAnswer = description.type === 'answer';
    try {
      await pc.setRemoteDescription(description);
    } catch (err) {
      Log.error('signal', `setting remote ${description.type} failed (signaling ${pc.signalingState})`, err);
      throw err;
    } finally {
      state.settingAnswer = false;
    }
    if (description.type === 'offer') {
      await setLocal(pc);
      Log.info('pc', 'local answer set', Log.sdp(pc.localDescription));
      await sendSignal({ description: pc.localDescription });
    }
  } else if (candidate) {
    try {
      await pc.addIceCandidate(candidate);
      Log.info('ice', 'remote candidate added', Log.candidate(candidate));
    } catch (err) {
      if (!state.ignoreOffer) {
        Log.warn('ice', 'remote candidate rejected', err);
        throw err;
      }
    }
  }
}

function onConnectionState(pc) {
  if (pc !== state.pc) return;
  switch (pc.connectionState) {
    case 'connected':
      setLive(true);
      setStatus('Connected directly', 'ok');
      updateRoute();
      clearInterval(state.statsTimer);
      state.statsTimer = setInterval(updateRoute, 2000);
      break;
    case 'disconnected':
      setStatus('Connection interrupted. Trying to recover…', 'warn');
      break;
    case 'failed':
      logIceDiagnosis(pc);
      if (!state.restartedIce) {
        state.restartedIce = true;
        setStatus('Connection failed. Retrying…', 'warn');
        pc.restartIce();
      } else {
        setStatus('No direct route found. A strict firewall or NAT is blocking it, and no relay is used by design.', 'err');
      }
      break;
  }
}

async function updateRoute() {
  const pc = state.pc;
  if (!pc || pc.connectionState !== 'connected') return;
  const stats = await pc.getStats();
  let pair;
  stats.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
  });
  if (!pair) stats.forEach((r) => {
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
  });
  if (!pair) return;
  const local = stats.get(pair.localCandidateId);
  if (!state.routeLogged) {
    const remote = stats.get(pair.remoteCandidateId);
    state.routeLogged = true;
    Log.info('ice', 'connected route', {
      local: local && `${local.candidateType} ${local.protocol} ${Log.ipKind(local.address || local.ip)}`,
      remote: remote && `${remote.candidateType} ${remote.protocol} ${Log.ipKind(remote.address || remote.ip)}`,
      rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    });
  }
  const where = local && local.candidateType === 'host' ? 'on your network' : 'over the internet';
  const rtt = pair.currentRoundTripTime != null ? `${Math.round(pair.currentRoundTripTime * 1000)} ms ` : '';
  setStatus('Connected directly', 'ok', `${rtt}${where}`);
}

// When a connection fails, record which candidate kinds each side had and how the checks went.
async function logIceDiagnosis(pc) {
  try {
    const stats = await pc.getStats();
    const local = {};
    const remote = {};
    const pairs = {};
    stats.forEach((r) => {
      if (r.type === 'local-candidate') local[`${r.candidateType} ${r.protocol}`] = (local[`${r.candidateType} ${r.protocol}`] || 0) + 1;
      if (r.type === 'remote-candidate') remote[`${r.candidateType} ${r.protocol}`] = (remote[`${r.candidateType} ${r.protocol}`] || 0) + 1;
      if (r.type === 'candidate-pair') pairs[r.state] = (pairs[r.state] || 0) + 1;
    });
    Log.warn('ice', 'connection failed, candidate summary', { local, remote, pairs });
  } catch (err) {
    Log.warn('ice', 'could not read stats', err);
  }
}

function teardownPeer() {
  if (state.pc) Log.info('pc', 'closing connection');
  state.routeLogged = false;
  clearInterval(state.statsTimer);
  setLive(false);
  endSession();
  if (state.dc) state.dc.close();
  if (state.pc) state.pc.close();
  state.pc = null;
  state.dc = null;
  state.makingOffer = state.ignoreOffer = state.settingAnswer = false;
  state.signalChain = Promise.resolve();
  for (const id of [...state.remote.keys()]) removeRemoteStream(id);
  state.remoteMeta.clear();
  for (const kind of ['screen', 'media']) if (state[kind]) state[kind].senders = [];
  if (state.incoming) state.incoming.card.fail('Transfer interrupted');
  state.incoming = null;
  state.peerName = '';
  const card = $('#peerCard');
  card.classList.add('waiting');
  card.querySelector('.label').textContent = 'Waiting for your friend';
  card.querySelector('.initial').textContent = '';
  card.querySelector('.micoff').hidden = true;
  detachMeter(card);
  setChatEnabled(false);
}

function leave() {
  Log.info('call', 'leaving', { connected: isConnected(), session: state.session ? state.session.role : 'none' });
  exitFocus();
  sendDC({ type: 'bye' });
  // Stop ringing your friend if they never picked up.
  const s = state.session;
  if (s && !isConnected() && state.pool) state.pool.send(s.friend, { type: 'cancel', sid: s.sid });
  endSession();
  teardownPeer();
  stopLocal('screen');
  stopLocal('media');
  if (state.mic) state.mic.getTracks().forEach((t) => t.stop());
  state.mic = null;
  state.muted = false;
  $('#micBtn').classList.remove('muted');
  label($('#micBtn'), 'Mute');
  state.unread = 0;
  $('#chatBadge').hidden = true;
  $('#meCard .micoff').hidden = true;
  detachMeter($('#meCard'));
  if (state.audioCtx) state.audioCtx.close();
  state.audioCtx = null;
  $('#messages').innerHTML = '<p class="empty">Messages and files go straight to your friend and aren\'t saved anywhere. Drop files here to send them.</p>';
  showScreen('join');
  renderFriends();
}

// ===================================================================
// Data channel: chat, file transfer and call metadata
// ===================================================================
function setupDataChannel(dc) {
  state.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = FILE_BUFFER_LOW;
  dc.onopen = () => {
    Log.info('dc', 'direct channel open');
    stopRinging();
    showScreen('call');
    sendDC({ type: 'hello', name: state.name, muted: state.muted });
    // Swap identity keys over this direct, encrypted channel so the two of
    // you can find each other again later without codes.
    Rendezvous.identity().then((me) => sendDC({ type: 'pair', pub: me.pub, name: state.name }))
      .catch((err) => console.warn('pairing unavailable', err));
    for (const kind of ['screen', 'media']) {
      const s = state[kind];
      if (s) sendDC({ type: 'stream', id: s.stream.id, kind, label: s.label });
    }
    setChatEnabled(true);
  };
  dc.onclose = () => {
    Log.info('dc', 'direct channel closed');
    if (dc === state.dc) setChatEnabled(false);
  };
  dc.onerror = (e) => Log.warn('dc', 'channel error', e.error ? e.error.message : 'unknown');
  dc.onmessage = (e) => {
    if (typeof e.data === 'string') onDataMessage(JSON.parse(e.data));
    else onFileChunk(e.data);
  };
}

function sendDC(msg) {
  if (state.dc && state.dc.readyState === 'open') state.dc.send(JSON.stringify(msg));
}

function onDataMessage(msg) {
  switch (msg.type) {
    case 'pair':
      Rendezvous.pair(msg.pub, state.peerName || msg.name).then(({ friend, isNew }) => {
        Log.info('pair', isNew ? 'saved new friend' : 'refreshed saved friend', { friend: friend.id.slice(0, 6) });
        if (isNew) toast(`${friend.name} is saved. Next time, just press Call.`);
        if (state.pool) state.pool.refreshTopics(true);
        else startListening();
        renderFriends();
      }).catch((err) => {
        Log.warn('pair', 'could not save friend', err);
        // Two tabs of the same browser share one identity, so they can't save each other.
        if (/own key/.test(err.message)) {
          toast('These two windows share the same browser data, so they can\'t save each other as friends. Use another browser or a private window for the second one.', 'err');
        }
      });
      break;
    case 'hello': {
      state.peerName = String(msg.name || 'Peer').slice(0, 32);
      const card = $('#peerCard');
      card.classList.remove('waiting');
      card.querySelector('.label').textContent = state.peerName;
      card.querySelector('.initial').textContent = initial(state.peerName);
      card.querySelector('.micoff').hidden = !msg.muted;
      addSystem(`${state.peerName} joined`);
      for (const id of state.remote.keys()) renderRemoteStream(id);
      break;
    }
    case 'signal':
      queueSignal(msg.data);
      break;
    case 'codec':
      onPeerCodec(String(msg.codec));
      break;
    case 'name':
      state.peerName = String(msg.name || '').slice(0, 32) || state.peerName;
      $('#peerCard .label').textContent = state.peerName;
      $('#peerCard .initial').textContent = initial(state.peerName);
      break;
    case 'mute':
      $('#peerCard .micoff').hidden = !msg.muted;
      break;
    case 'chat':
      addChat(state.peerName || 'Peer', String(msg.text), false);
      break;
    case 'stream':
      state.remoteMeta.set(msg.id, { kind: msg.kind, label: String(msg.label || '') });
      if (state.remote.has(msg.id)) renderRemoteStream(msg.id);
      break;
    case 'stream-end':
      state.remoteMeta.delete(msg.id);
      removeRemoteStream(msg.id);
      break;
    case 'file-start':
      state.incoming = {
        ...msg,
        chunks: [],
        received: 0,
        card: addFileCard(state.peerName || 'Peer', msg.name, msg.size, false),
      };
      break;
    case 'file-end': {
      const inc = state.incoming;
      if (!inc) break;
      state.incoming = null;
      // Only preview plain image types; everything else is a download, never rendered.
      const safe = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(inc.mime) ? inc.mime : 'application/octet-stream';
      inc.card.complete(new Blob(inc.chunks, { type: safe }));
      break;
    }
    case 'bye': {
      // Your friend hung up: end the call here too and go back to your friends list.
      const who = state.peerName || 'Your friend';
      state.dc = null;
      leave();
      toast(`${who} left the call`);
      break;
    }
  }
}

// ---------- chat ----------
function initChat() {
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text || !state.dc || state.dc.readyState !== 'open') return;
    sendDC({ type: 'chat', text });
    addChat(state.name, text, true);
    $('#chatInput').value = '';
  };
  $('#chatBtn').onclick = () => {
    // The chat panel sits outside the full-screen view, so leave full screen to show it.
    if ($('.stage-wrap').classList.contains('focus')) { exitFocus(); return setChatOpen(true); }
    setChatOpen(!$('#layout').classList.contains('chat-open'));
  };
  for (const b of document.querySelectorAll('[data-quick]')) b.onclick = () => $(`#${b.dataset.quick}`).click();
  $('#closeChat').onclick = () => setChatOpen(false);
  setChatOpen(window.innerWidth > 820);
  $('#attachBtn').onclick = () => $('#sendFiles').click();
  $('#sendFiles').onchange = (e) => {
    for (const f of e.target.files) queueFile(f);
    e.target.value = '';
  };
  const side = $('#side');
  side.ondragover = (e) => { e.preventDefault(); side.classList.add('drag'); };
  side.ondragleave = () => side.classList.remove('drag');
  side.ondrop = (e) => {
    e.preventDefault();
    side.classList.remove('drag');
    if (!state.dc || state.dc.readyState !== 'open') return toast('Files can be sent once your friend connects');
    for (const f of e.dataTransfer.files) queueFile(f);
  };
}

// ---------- chat panel ----------
function setChatOpen(open) {
  $('#layout').classList.toggle('chat-open', open);
  $('#chatBtn').classList.toggle('active', open);
  $('#chatBtn').setAttribute('aria-pressed', String(open));
  if (open) {
    state.unread = 0;
    $('#chatBadge').hidden = true;
    const box = $('#messages');
    box.scrollTop = box.scrollHeight;
  }
}

function noteUnread() {
  if ($('#layout').classList.contains('chat-open')) return;
  state.unread = (state.unread || 0) + 1;
  $('#chatBadge').textContent = state.unread > 9 ? '9+' : String(state.unread);
  $('#chatBadge').hidden = false;
}

function setChatEnabled(on) {
  $('#chatInput').disabled = !on;
  $('#sendBtn').disabled = !on;
  $('#attachBtn').disabled = !on;
  $('#chatInput').placeholder = on ? 'Message' : 'Waiting for your friend';
}

function messageShell(author, mine, bubbleClass) {
  const el = document.createElement('div');
  el.className = `msg${mine ? ' me' : ''}`;
  el.innerHTML = `<div class="meta"><span class="who"></span><span class="when"></span></div><div class="bubble ${bubbleClass}"></div>`;
  el.querySelector('.who').textContent = mine ? 'You' : author;
  el.querySelector('.when').textContent = clock();
  return el;
}

function addChat(author, text, mine) {
  const el = messageShell(author, mine, '');
  el.querySelector('.bubble').textContent = text;
  appendMessage(el);
  if (!mine) noteUnread();
}

function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'sys';
  el.textContent = text;
  appendMessage(el);
}

function appendMessage(el) {
  const box = $('#messages');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.append(el);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- file transfer ----------
function queueFile(file) {
  const card = addFileCard(state.name, file.name, file.size, true);
  card.setStatus('Queued');
  state.fileChain = state.fileChain.then(() => sendFile(file, card)).catch((err) => {
    console.warn('file send failed', err);
    card.fail('Not sent, the connection closed');
  });
}

async function sendFile(file, card) {
  const dc = state.dc;
  if (!dc || dc.readyState !== 'open') throw new Error('channel closed');
  const max = state.pc && state.pc.sctp && state.pc.sctp.maxMessageSize;
  const chunkSize = Math.min(64 * 1024, max || 16 * 1024);
  dc.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size, mime: file.type }));
  card.setStatus('Sending');
  let offset = 0;
  while (offset < file.size) {
    if (dc.readyState !== 'open') throw new Error('channel closed');
    if (dc.bufferedAmount > FILE_BUFFER_HIGH) {
      await new Promise((resolve) => {
        dc.addEventListener('bufferedamountlow', resolve, { once: true });
        dc.addEventListener('close', resolve, { once: true });
      });
      continue;
    }
    const buf = await file.slice(offset, offset + chunkSize).arrayBuffer();
    dc.send(buf);
    offset += buf.byteLength;
    card.progress(offset / file.size);
  }
  dc.send(JSON.stringify({ type: 'file-end' }));
  card.complete(file);
}

function onFileChunk(buf) {
  const inc = state.incoming;
  if (!inc) return;
  inc.chunks.push(buf);
  inc.received += buf.byteLength;
  inc.card.progress(inc.size ? inc.received / inc.size : 1);
}

function addFileCard(author, name, size, mine) {
  const el = messageShell(author, mine, 'file');
  el.querySelector('.bubble').innerHTML = `
    <div class="fname"></div>
    <div class="fmeta"><span class="fsize"></span><span class="fstate"></span></div>
    <div class="bar"><i></i></div>`;
  el.querySelector('.fname').textContent = name;
  el.querySelector('.fsize').textContent = formatBytes(size);
  const stateEl = el.querySelector('.fstate');
  const bar = el.querySelector('.bar');
  const fill = bar.querySelector('i');
  appendMessage(el);
  if (!mine) noteUnread();

  let lastPaint = 0;
  return {
    setStatus(text) { stateEl.textContent = text; },
    progress(p) {
      const now = performance.now();
      if (now - lastPaint < 80 && p < 1) return;
      lastPaint = now;
      fill.style.width = `${Math.min(100, p * 100).toFixed(1)}%`;
      stateEl.textContent = `${Math.floor(p * 100)}%`;
    },
    complete(blob) {
      bar.remove();
      stateEl.textContent = mine ? 'Sent' : '';
      const url = URL.createObjectURL(blob);
      const bubble = el.querySelector('.file');
      if (/^image\//.test(blob.type)) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = name;
        bubble.insertBefore(img, bubble.firstChild);
      }
      if (!mine) {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.textContent = 'Download';
        bubble.append(a);
      }
    },
    fail(text) {
      bar.remove();
      stateEl.textContent = text;
    },
  };
}

// ===================================================================
// Local media: mic, screen share, file streaming
// ===================================================================
function initControls() {
  $('#micBtn').onclick = toggleMute;
  $('#screenBtn').onclick = toggleScreen;
  $('#mediaBtn').onclick = () => (state.media ? stopLocal('media') : $('#mediaFile').click());
  $('#mediaFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) streamFile(f);
  };
  $('#hangBtn').onclick = leave;
}

function toggleMute() {
  if (!state.mic) return;
  state.muted = !state.muted;
  state.mic.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
  $('#micBtn').classList.toggle('muted', state.muted);
  label($('#micBtn'), state.muted ? 'Unmute' : 'Mute');
  $('#meCard .micoff').hidden = !state.muted;
  sendDC({ type: 'mute', muted: state.muted });
}

async function toggleScreen() {
  if (state.screen) return stopLocal('screen');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(shareConstraints());
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast(`Couldn't share screen: ${err.message}`, 'err');
    return;
  }
  const video = stream.getVideoTracks()[0];
  if (video) {
    if ('contentHint' in video) video.contentHint = 'detail';
    video.addEventListener('ended', () => { if (state.screen && state.screen.stream === stream) stopLocal('screen'); });
  }
  state.screen = { stream, senders: [], label: 'Screen' };
  const tile = makeTile({ title: 'Your screen', remote: false });
  tile.video.muted = true;
  tile.video.srcObject = stream;
  state.screen.tile = tile.el;
  publish('screen');
  $('#screenBtn').classList.add('active');
  label($('#screenBtn'), 'Stop sharing');
}

async function streamFile(file) {
  if (state.media) stopLocal('media');
  const url = URL.createObjectURL(file);
  const tile = makeTile({ title: `Streaming: ${file.name}`, remote: false });
  const el = tile.video;
  el.controls = true;
  el.src = url;
  try {
    await el.play();
  } catch (err) {
    tile.el.remove();
    URL.revokeObjectURL(url);
    return toast(`Couldn't play that file: ${err.message}`, 'err');
  }
  const capture = el.captureStream || el.mozCaptureStream;
  if (!capture) {
    tile.el.remove();
    URL.revokeObjectURL(url);
    return toast('This browser cannot stream media files. Try Chrome or Edge.', 'err');
  }
  // The browser drops captured tracks when a file ends, so we keep one stable
  // stream for the peer and swap in freshly captured tracks on every play.
  const stream = new MediaStream();
  state.media = { stream, senders: [], label: file.name, el, url, tile: tile.el };
  if (/^audio\//.test(file.type)) tile.el.classList.add('audio-only');
  const useTrack = (track) => {
    const media = state.media;
    if (!media || media.el !== el) return track.stop();
    if (stream.getTracks().includes(track)) return; // 'addtrack' can repeat a track we already have
    for (const old of stream.getTracks().filter((t) => t.kind === track.kind)) {
      stream.removeTrack(old);
      old.stop();
    }
    stream.addTrack(track);
    if (!state.pc) return;
    const sender = media.senders.find((s) => s.track && s.track.kind === track.kind);
    if (sender) sender.replaceTrack(track);
    else media.senders.push(state.pc.addTrack(track, stream));
  };
  const recapture = () => {
    const fresh = capture.call(el);
    fresh.getTracks().forEach(useTrack);
    fresh.addEventListener('addtrack', ({ track }) => useTrack(track));
  };
  publish('media');
  recapture();
  el.addEventListener('playing', recapture);
  $('#mediaBtn').classList.add('active');
  label($('#mediaBtn'), 'Stop streaming');
}

function publish(kind) {
  const s = state[kind];
  sendDC({ type: 'stream', id: s.stream.id, kind, label: s.label });
  if (state.pc) s.senders = s.stream.getTracks().map((t) => state.pc.addTrack(t, s.stream));
}

function stopLocal(kind) {
  const s = state[kind];
  if (!s) return;
  state[kind] = null;
  if (state.pc && state.pc.signalingState !== 'closed') {
    for (const sender of s.senders) {
      try { state.pc.removeTrack(sender); } catch { /* already gone */ }
    }
  }
  sendDC({ type: 'stream-end', id: s.stream.id });
  s.stream.getTracks().forEach((t) => t.stop());
  if (s.el) { s.el.pause(); s.el.removeAttribute('src'); s.el.load(); }
  if (s.url) URL.revokeObjectURL(s.url);
  if (s.tile) {
    if (state.focusTile === s.tile) exitFocus();
    s.tile.remove();
  }
  updateStageLayout();
  if (kind === 'screen') {
    $('#screenBtn').classList.remove('active');
    label($('#screenBtn'), 'Share screen');
  } else {
    $('#mediaBtn').classList.remove('active');
    label($('#mediaBtn'), 'Stream file');
  }
}

// ===================================================================
// Remote media
// ===================================================================
function onRemoteTrack(e) {
  const stream = e.streams[0] || new MediaStream([e.track]);
  if (!state.remote.has(stream.id)) {
    state.remote.set(stream.id, { stream });
    stream.addEventListener('removetrack', () => {
      if (stream.getTracks().length === 0) removeRemoteStream(stream.id);
    });
  }
  renderRemoteStream(stream.id);
}

function renderRemoteStream(id) {
  const entry = state.remote.get(id);
  if (!entry) return;
  const { stream } = entry;
  const meta = state.remoteMeta.get(id);
  const hasVideo = stream.getVideoTracks().length > 0;
  // The peer's microphone is the audio-only stream without screen/media metadata.
  const kind = meta ? meta.kind : hasVideo ? 'screen' : 'mic';

  if (kind === 'mic') {
    if (!entry.audio) {
      entry.audio = new Audio();
      entry.audio.autoplay = true;
      entry.audio.srcObject = stream;
      applySpeaker(entry.audio);
      entry.audio.play().catch(() => toast('Click anywhere to enable call audio.'));
      refreshPeerMeter();
    }
    return;
  }
  // It turned out to be a screen/media stream: drop the mic-style player.
  if (entry.audio) {
    entry.audio.srcObject = null;
    entry.audio = null;
    refreshPeerMeter();
  }
  const who = state.peerName || 'Your friend';
  const title = kind === 'media' ? `${who} is streaming: ${meta.label}` : `${who}'s screen`;
  if (!entry.tile) {
    const tile = makeTile({ title, remote: true });
    tile.video.srcObject = stream;
    applySpeaker(tile.video);
    tile.video.play().catch(() => {});
    entry.tile = tile;
  }
  entry.tile.setTitle(title);
  entry.tile.el.classList.toggle('audio-only', !hasVideo);
}

function removeRemoteStream(id) {
  const entry = state.remote.get(id);
  if (!entry) return;
  state.remote.delete(id);
  if (entry.audio) {
    entry.audio.srcObject = null;
    refreshPeerMeter();
  }
  if (entry.tile) {
    if (state.focusTile === entry.tile.el) exitFocus();
    entry.tile.el.remove();
  }
  updateStageLayout();
}

// ---------- full screen: one stream fills the screen, controls fade in on mouse move ----------
function enterFocus(tile) {
  const wrap = $('.stage-wrap');
  if (state.focusTile) state.focusTile.classList.remove('focused');
  state.focusTile = tile;
  tile.classList.add('focused');
  wrap.classList.add('focus');
  showFocusUi();
  if (wrap.requestFullscreen && !document.fullscreenElement) wrap.requestFullscreen().catch(() => {});
}

function exitFocus() {
  const wrap = $('.stage-wrap');
  clearTimeout(state.focusTimer);
  wrap.classList.remove('focus', 'show-ui');
  if (state.focusTile) state.focusTile.classList.remove('focused');
  state.focusTile = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function showFocusUi() {
  const wrap = $('.stage-wrap');
  if (!wrap.classList.contains('focus')) return;
  wrap.classList.add('show-ui');
  clearTimeout(state.focusTimer);
  state.focusTimer = setTimeout(function hide() {
    // Keep the controls up while the pointer rests on them.
    if (wrap.querySelector('.dock:hover, .exit-fs:hover')) state.focusTimer = setTimeout(hide, 1000);
    else wrap.classList.remove('show-ui');
  }, 2500);
}

function initFocus() {
  const wrap = $('.stage-wrap');
  for (const ev of ['mousemove', 'pointerdown', 'touchstart']) wrap.addEventListener(ev, showFocusUi, { passive: true });
  document.addEventListener('keydown', showFocusUi);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) exitFocus(); });
  $('#exitFocus').onclick = exitFocus;
}

// ---------- the hub: link between you, call timer, quick actions ----------
function setLive(on) {
  const hub = $('#hub');
  if (on === hub.classList.contains('live')) return;
  hub.classList.toggle('live', on);
  $('#quick').hidden = !on;
  clearInterval(state.timerId);
  $('#callTimer').textContent = '';
  if (!on) return;
  const start = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - start) / 1000);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
    const ss = String(s % 60).padStart(2, '0');
    $('#callTimer').textContent = h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  tick();
  state.timerId = setInterval(tick, 1000);
}

function makeTile({ title, remote }) {
  const el = document.createElement('div');
  el.className = `tile${remote ? ' remote' : ''}`;
  el.innerHTML = `
    <div class="audio-art" hidden><div class="orb"></div></div>
    <video autoplay playsinline></video>
    <div class="tile-bar"><span class="title"></span><span class="actions"></span></div>`;
  const video = el.querySelector('video');
  const titleEl = el.querySelector('.title');
  titleEl.textContent = title;
  const full = document.createElement('button');
  full.className = 'icon-btn';
  full.title = 'Full screen';
  full.setAttribute('aria-label', 'Full screen');
  full.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  full.onclick = () => enterFocus(el);
  el.querySelector('.actions').append(full);
  video.addEventListener('dblclick', () => {
    if (!video.controls) $('.stage-wrap').classList.contains('focus') ? exitFocus() : enterFocus(el);
  });  new MutationObserver(() => {
    const audioOnly = el.classList.contains('audio-only');
    el.querySelector('.audio-art').hidden = !audioOnly;
    full.hidden = audioOnly;
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
  // Remote tiles first, your own previews after them.
  const tiles = $('#tiles');
  if (remote) tiles.prepend(el);
  else tiles.append(el);
  updateStageLayout();
  return { el, video, setTitle: (t) => { titleEl.textContent = t; } };
}

// The peer card's speaking ring follows whichever remote stream is their mic.
function refreshPeerMeter() {
  const card = $('#peerCard');
  detachMeter(card);
  for (const entry of state.remote.values()) {
    if (entry.audio) return attachMeter(card, entry.stream);
  }
}

function updateStageLayout() {
  $('.stage').classList.toggle('has-tiles', $('#tiles').children.length > 0);
}

// ===================================================================
// Speaking indicators
// ===================================================================
function attachMeter(card, stream) {
  if (!state.audioCtx || !stream.getAudioTracks().length) return;
  detachMeter(card);
  const source = state.audioCtx.createMediaStreamSource(stream);
  const analyser = state.audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  state.meters.set(card, { source, analyser, data: new Uint8Array(analyser.fftSize) });
  if (state.meters.size === 1) requestAnimationFrame(tickMeters);
}

function detachMeter(card) {
  const m = state.meters.get(card);
  if (!m) return;
  m.source.disconnect();
  state.meters.delete(card);
  card.style.setProperty('--level', 0);
}

function tickMeters() {
  if (!state.meters.size) return;
  for (const [card, m] of state.meters) {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (const v of m.data) sum += (v - 128) ** 2;
    const rms = Math.sqrt(sum / m.data.length) / 128;
    const muted = card.id === 'meCard' && state.muted;
    card.style.setProperty('--level', muted ? 0 : Math.min(1, rms * 6).toFixed(3));
  }
  requestAnimationFrame(tickMeters);
}

// ===================================================================
// Helpers
// ===================================================================
function isConnected() {
  return !!state.pc && state.pc.connectionState === 'connected';
}

function iceServers() {
  const urls = $('#stun').value.split(/\s+/).filter(Boolean);
  return urls.length ? [{ urls }] : [];
}

function setStatus(text, kind, detail = '') {
  $('#statusText').textContent = text;
  $('#statusDetail').textContent = detail;
  $('#status').className = `status ${kind}`;
  $('#connectStatus').textContent = text;
  $('#connectPill').className = `status ${kind}`;
  $('#ringStatus').textContent = text;
  $('#ringPill').className = `status ${kind}`;
}

function showJoinError(text) {
  $('#joinError').textContent = text;
  $('#joinError').hidden = false;
}

// Dock buttons are icon-only; keep their hidden label and tooltip in sync.
function label(btn, text) {
  btn.querySelector('.sr').textContent = text;
  btn.title = text;
}

// Start a new offer, e.g. after the codec changed.
function renegotiate() {
  const pc = state.pc;
  if (pc && pc.onnegotiationneeded) pc.onnegotiationneeded();
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

function randomId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function initial(name) {
  return (name.trim()[0] || '?').toUpperCase();
}

function clock() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function load(key) {
  try { return localStorage.getItem(`miserecord.${key}`); } catch { return null; }
}

function save(key, value) {
  try { localStorage.setItem(`miserecord.${key}`, value); } catch { /* storage unavailable */ }
}

// Browsers may block audio until the user interacts with the page.
document.addEventListener('click', () => {
  if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
  for (const { audio } of state.remote.values()) if (audio && audio.paused) audio.play().catch(() => {});
});
window.addEventListener('beforeunload', () => sendDC({ type: 'bye' }));

initSettings();
initFocus();
initJoin();
initManual();
initChat();
initControls();
