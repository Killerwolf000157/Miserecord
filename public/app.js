// Miserecord client.
// Every call is a set of direct WebRTC connections, one per other person (a mesh).
// There is no server. The first connection info is exchanged one of three ways:
//   - two copy-paste codes (a new friend, 1:1),
//   - encrypted relay messages to a saved friend (1:1),
//   - encrypted relay messages on a lobby's topic, derived from its code (groups).
// Once a connection is up, all further signaling (e.g. starting a screen share)
// goes over that connection itself.
'use strict';

const $ = (sel) => document.querySelector(sel);
const DEFAULT_STUN = 'stun:stun.l.google.com:19302\nstun:stun1.l.google.com:19302';
const FILE_BUFFER_HIGH = 4 * 1024 * 1024;
const FILE_BUFFER_LOW = 1024 * 1024;
const MAX_PEOPLE = 8;

const state = {
  name: '',
  myId: randomId().slice(0, 16), // identifies this window inside a lobby
  mode: null,           // 'codes' | 'friend' | 'lobby' while in a call
  peers: new Map(),     // peer id -> Peer
  // 1:1 with a saved friend
  session: null,        // { friend, sid, role, ringTimer, timeout }
  // group lobby
  lobby: null,          // { code, channel, host, hostId, locked, joinedAt, blocked, announceTimer, timeout }
  // local media
  mic: null,
  muted: false,
  screen: null,         // { stream, senders: Map(peerId -> sender[]), label, tile }
  media: null,          // { stream, senders: Map(peerId -> sender[]), label, el, url, tile }
  // files
  fileChain: Promise.resolve(),
  // audio levels
  audioCtx: null,
  meters: new Map(),    // card element -> analyser
  statsTimer: null,
};

// ===================================================================
// Home screen
// ===================================================================
function initJoin() {
  if (!window.isSecureContext) $('#insecure').hidden = false;
  $('#name').value = load('name') || '';
  $('#stun').value = load('stun') ?? DEFAULT_STUN;
  $('#relays').value = load('relays') ?? Rendezvous.DEFAULT_RELAYS.join('\n');
  $('#relays').onchange = () => { save('relays', $('#relays').value); startListening(); };
  $('#stun').onchange = () => save('stun', $('#stun').value);
  // In case the network settings got edited into something that doesn't work.
  $('#sNetReset').onclick = () => {
    $('#stun').value = DEFAULT_STUN;
    $('#relays').value = Rendezvous.DEFAULT_RELAYS.join('\n');
    save('stun', DEFAULT_STUN);
    save('relays', $('#relays').value);
    Log.info('app', 'network settings reset to defaults');
    startListening();
    toast(inCall() ? 'Network settings reset. They apply from your next call.' : 'Network settings reset');
  };
  $('#joinForm').onsubmit = (e) => e.preventDefault();
  $('#startBtn').onclick = () => joinWithCodes('host');
  $('#answerBtn').onclick = () => joinWithCodes('guest');
  $('#createLobbyBtn').onclick = createLobby;
  $('#joinLobbyBtn').onclick = () => joinLobby($('#lobbyInput').value);
  $('#lobbyInput').onkeydown = (e) => { if (e.key === 'Enter') joinLobby($('#lobbyInput').value); };
  $('#cancelRing').onclick = leave;
  $('#acceptBtn').onclick = () => state.ringIn && (state.ringIn.code ? acceptInvite() : acceptCall(state.ringIn.friend, state.ringIn.sid));
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
    applyMicEnabled();
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

function showScreen(id) {
  for (const s of ['join', 'connect', 'ringing', 'call']) $(`#${s}`).hidden = s !== id;
  // The desktop app only installs an update by itself when you're not in a call.
  if (window.miserecordDesktop && window.miserecordDesktop.setBusy) window.miserecordDesktop.setBusy(id !== 'join');
  Social.statusChanged();
}

function inCall() {
  return !!state.mode;
}

// ===================================================================
// Relay pool: saved friends and lobbies
// ===================================================================
function relayUrls() {
  return $('#relays').value.split(/\s+/).filter((u) => /^wss:\/\/\S+$/.test(u));
}

function ensurePool() {
  if (state.pool) return state.pool;
  state.pool = new Rendezvous.Pool(relayUrls(), onRelayMessage, onRelayStatus);
  state.pool.start();
  return state.pool;
}

function startListening() {
  const lobbyChannel = state.lobby && state.lobby.channel;
  if (state.pool) state.pool.close();
  state.pool = null;
  renderFriends();
  const count = Rendezvous.friends().length;
  if (!count && !lobbyChannel) {
    Log.info('relay', 'no saved friends, not listening');
    return;
  }
  Log.info('relay', 'listening', { friends: count, lobby: !!lobbyChannel, relays: relayUrls().length });
  ensurePool();
  if (lobbyChannel) state.pool.addChannel(lobbyChannel);
}

function onRelayStatus(open) {
  Social.onRelays(open);
  $('#relayStatus').className = `status ${open ? 'ok' : 'wait'}`;
  $('#relayText').textContent = open ? 'Ready for calls' : 'Connecting to relays';
}

function waitForRelay(timeoutMs = 8000) {
  const pool = ensurePool();
  if (pool.connected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (pool.connected() || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(pool.connected() > 0);
      }
    }, 200);
  });
}

function onRelayMessage(channel, msg) {
  if (channel.lobby) return onLobbyMessage(channel, msg);
  onFriendMessage(channel, msg);
}

// ===================================================================
// Saved friends: call again without codes (1:1)
// ===================================================================
function renderFriends() {
  // Online friends first, then those in a call, then everyone else.
  const rank = (f) => { const p = Social.presence.get(f.id); return p ? (p.status === 'online' ? 0 : 1) : 2; };
  const list = Rendezvous.friends().sort((a, b) => rank(a) - rank(b));
  const any = list.length > 0;
  $('#friendsSection').hidden = !any;
  $('#addTitle').hidden = !any;
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
      <div class="f-text"><div class="f-name" translate="no"></div><div class="f-sub"></div></div>
      <button type="button" class="icon-btn f-remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <button type="button" class="btn primary call-btn">
        <svg viewBox="0 0 24 24"><path d="M6.6 3.5h3l1.5 4-2 1.4a10 10 0 0 0 6 6l1.4-2 4 1.5v3a2 2 0 0 1-2.1 2A16.5 16.5 0 0 1 4.5 5.6a2 2 0 0 1 2.1-2.1z"/></svg>
        Call
      </button>`;
    row.querySelector('.f-avatar').textContent = initial(f.name);
    row.querySelector('.f-name').textContent = f.name;
    // Online status (social.js): a dot on the picture, and the line under the name.
    const seen = Social.presence.get(f.id);
    row.classList.toggle('online', !!seen && seen.status === 'online');
    row.classList.toggle('busy', !!seen && seen.status === 'busy');
    row.querySelector('.f-sub').textContent = seen ? I18n.t(seen.status === 'busy' ? 'In a call' : 'Online') : `Last call ${sinceText(f.lastCall)}`;
    const remove = row.querySelector('.f-remove');
    remove.title = `Remove ${f.name}`;
    remove.setAttribute('aria-label', `Remove ${f.name}`);
    remove.onclick = () => {
      if (!confirm(I18n.t(`Remove ${f.name}? You'll need to swap codes again to call them.`))) return;
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
  if (inCall()) {
    Log.warn('call', 'call pressed while already in a call', { mode: state.mode });
    return;
  }
  if (!state.pool || !state.pool.connected()) {
    Log.warn('call', 'no relay connected, cannot call', { pool: !!state.pool });
    return toast("Can't reach the relays right now. Check your internet connection.", 'err');
  }
  if (!(await prepare())) return;
  const sid = randomId();
  Log.info('call', 'calling friend', { friend: friend.id.slice(0, 6), sid: sid.slice(0, 6), relays: state.pool.connected() });
  state.mode = 'friend';
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

// Signals for a 1:1 call with a saved friend go through the relays until connected.
function friendSender(friend, sid) {
  return (desc) => state.pool && state.pool.send(friend, { type: 'signal', sid, data: { description: desc } });
}

function onFriendMessage(friend, msg) {
  if (Social.onFriendMessage(friend, msg)) return; // online status and invites
  const s = state.session;
  const mine = s && s.friend.id === friend.id;
  if (msg.type !== 'ring' || !state.ringIn || state.ringIn.sid !== msg.sid) {
    Log.info('relay', `received ${msg.type}`, { friend: friend.id.slice(0, 6), sid: String(msg.sid || '').slice(0, 6), mySession: s ? `${s.role} ${s.sid.slice(0, 6)}` : 'none', matches: !!(mine && s.sid === msg.sid) });
  }
  switch (msg.type) {
    case 'ring':
      if (mine) {
        // Both of you pressed Call at the same moment: one side answers the other.
        if (s.role === 'caller' && !state.peers.size && s.sid > msg.sid) acceptCall(friend, msg.sid, true);
        return;
      }
      if (inCall() || $('#join').hidden) {
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
      if (mine && s.role === 'caller' && s.sid === msg.sid && !state.peers.size) {
        stopRinging();
        setStatus(`Connecting to ${friend.name}`, 'wait');
        $('#ringTitle').textContent = `Connecting to ${friend.name}`;
        $('#ringSub').textContent = 'Setting up a direct connection.';
        armConnectTimeout();
        createPeer(friend.id, { name: friend.name, polite: false, sendPre: friendSender(friend, s.sid) });
      }
      break;
    case 'decline':
    case 'busy':
      if (mine && s.role === 'caller' && s.sid === msg.sid && !state.peers.size) {
        leave();
        toast(msg.type === 'busy' ? `${friend.name} is in another call` : `${friend.name} can't talk right now`);
      }
      break;
    case 'signal': {
      const peer = state.peers.get(friend.id);
      if (mine && s.sid === msg.sid && msg.data && peer) queueSignal(peer, msg.data);
      break;
    }
  }
}

// invite: { code } when a friend asks you into their lobby (social.js).
function showIncoming(friend, sid, invite = null) {
  if (state.ringIn && state.ringIn.sid === sid) {
    state.ringIn.last = Date.now();
    return;
  }
  hideIncoming();
  state.ringIn = { friend, sid, last: Date.now(), code: invite ? invite.code : null };
  Log.info('call', invite ? 'invited to a lobby' : 'incoming call', { friend: friend.id.slice(0, 6), sid: sid.slice(0, 6) });
  $('#incomingTitle').textContent = invite ? I18n.t(`${friend.name} invites you to their lobby`) : `${friend.name} is calling`;
  $('#acceptBtn').textContent = I18n.t(invite ? 'Join' : 'Answer');
  $('#incoming').hidden = false;
  document.title = I18n.t(`${friend.name} is calling · Miserecord`);
  if (window.miserecordDesktop) window.miserecordDesktop.incomingCall(friend.name, invite ? 'invite' : 'call');
  Ringtone.start();
  // The caller re-sends every few seconds; if that stops, they gave up.
  state.ringIn.watch = setInterval(() => {
    if (state.ringIn && Date.now() - state.ringIn.last > 10000) {
      toast(state.ringIn.code ? `Missed invite from ${state.ringIn.friend.name}` : `Missed call from ${state.ringIn.friend.name}`);
      hideIncoming();
    }
  }, 2000);
}

function hideIncoming() {
  if (state.ringIn) clearInterval(state.ringIn.watch);
  state.ringIn = null;
  $('#incoming').hidden = true;
  Ringtone.stop();
  if (window.miserecordDesktop) window.miserecordDesktop.callAnswered();
  document.title = I18n.t('Miserecord');
}

function declineCall() {
  if (!state.ringIn) return;
  Log.info('call', 'declined incoming call');
  if (state.pool) state.pool.send(state.ringIn.friend, { type: 'decline', sid: state.ringIn.sid });
  hideIncoming();
}

// Join the lobby a friend invited you to.
async function acceptInvite() {
  const { friend, sid, code } = state.ringIn;
  Log.info('lobby', 'accepting an invite', { friend: friend.id.slice(0, 6) });
  hideIncoming();
  if (state.pool) state.pool.send(friend, { type: 'accept', sid });
  await joinLobby(code);
}

// auto: both called each other at once and this side was already set up.
async function acceptCall(friend, sid, auto = false) {
  Log.info('call', auto ? 'both called at once, answering theirs' : 'answering call', { friend: friend.id.slice(0, 6), sid: sid.slice(0, 6) });
  hideIncoming();
  if (!auto && !(await prepare())) return;
  stopRinging();
  state.mode = 'friend';
  state.session = { friend, sid, role: 'callee' };
  showRinging(`Connecting to ${friend.name}`, 'Setting up a direct connection.');
  setStatus(`Connecting to ${friend.name}`, 'wait');
  armConnectTimeout();
  // The caller makes the offer; this side waits for it and answers.
  createPeer(friend.id, { name: friend.name, polite: true, waitForOffer: true, sendPre: friendSender(friend, sid) });
  const sent = await state.pool.send(friend, { type: 'accept', sid });
  Log.info('call', 'sent accept', { relays: sent });
  if (!sent) Log.error('call', 'no relay was connected, the caller will not see the answer');
}

function armConnectTimeout() {
  const s = state.session;
  clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    if (state.session !== s || isConnected()) return;
    const peer = state.peers.get(s.friend.id);
    Log.warn('call', 'not connected after 30 s, giving up', peer ? pcSummary(peer.pc) : 'no connection');
    if (peer) logIceDiagnosis(peer.pc);
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

// ===================================================================
// Group lobbies
// ===================================================================
async function createLobby() {
  if (inCall()) return;
  if (!(await prepare())) return;
  const code = Rendezvous.newLobbyCode();
  Log.info('lobby', 'creating lobby');
  await enterLobby(code, true);
  setStatus('Waiting for people to join', 'wait');
}

async function joinLobby(text) {
  if (inCall()) return;
  const code = Rendezvous.normalizeLobbyCode(text);
  if (!code) {
    Log.warn('lobby', 'invalid code entered', { length: String(text || '').length });
    $('#lobbyInput').focus();
    return toast('That code needs 16 letters and numbers, like 7KQ4-XM2P-9DTA-H3VW.', 'err');
  }
  if (!(await prepare())) return;
  Log.info('lobby', 'joining lobby');
  showRinging('Joining the lobby', 'Looking for the people in it.');
  setStatus('Connecting to relays', 'wait');
  await enterLobby(code, false);
}

async function enterLobby(code, host) {
  state.mode = 'lobby';
  const channel = await Rendezvous.lobbyChannel(code);
  state.lobby = {
    code, channel, host, hostId: host ? state.myId : null, locked: false,
    joinedAt: Date.now(), blocked: new Set(),
  };
  ensurePool();
  await state.pool.addChannel(channel);
  const ok = await waitForRelay();
  Log.info('lobby', 'relays', { connected: state.pool.connected() });
  if (!ok) {
    leave();
    return toast("Can't reach the relays right now. Check your internet connection.", 'err');
  }
  renderLobby();
  if (host) {
    showScreen('call');
    return;
  }
  // Announce yourself; everyone already in the lobby connects to you. Repeats
  // back off (relays rate-limit chatty clients) and stop soon after connecting.
  const lobby = state.lobby;
  const schedule = [0, 2000, 5000, 10000, 18000, 30000];
  let sinceConnected = 0;
  const announce = (i) => {
    if (state.lobby !== lobby || i >= schedule.length) return;
    if (isConnected() && ++sinceConnected > 1) return; // one more after the first connection, for late listeners
    lobbySend({ type: 'join', name: state.name, since: lobby.joinedAt });
    lobby.announceTimer = setTimeout(() => announce(i + 1), schedule[i + 1] - schedule[i]);
  };
  announce(0);
  setStatus('Waiting for an answer', 'wait');
  lobby.timeout = setTimeout(() => {
    if (state.lobby !== lobby || state.peers.size) return;
    Log.warn('lobby', 'nobody answered in 30 s');
    leave();
    toast('Nobody answered. Check the code, and make sure someone in the lobby has Miserecord open.', 'err');
  }, 30000);
}

function lobbySend(body) {
  const lobby = state.lobby;
  if (!lobby || !state.pool) return Promise.resolve(0);
  return state.pool.send(lobby.channel, { ...body, from: state.myId });
}

function lobbySender(peerId) {
  return (desc) => lobbySend({ type: 'signal', to: peerId, data: { description: desc } });
}

function onLobbyMessage(channel, msg) {
  const lobby = state.lobby;
  if (!lobby || channel.id !== lobby.channel.id) return;
  const from = String(msg.from || '');
  if (!from || from === state.myId) return;
  if (msg.to && msg.to !== state.myId) return; // addressed to someone else
  Log.info('lobby', `received ${msg.type}`, { from: from.slice(0, 6) });
  switch (msg.type) {
    case 'join': {
      if (lobby.blocked.has(from)) return;
      const existing = state.peers.get(from);
      if (existing && existing.pc.connectionState !== 'failed' && existing.pc.connectionState !== 'closed') return;
      if (lobby.locked) {
        if (lobby.host) lobbySend({ type: 'locked', to: from });
        return;
      }
      if (state.peers.size >= MAX_PEOPLE - 1) {
        lobbySend({ type: 'full', to: from });
        return;
      }
      // Whoever joined earlier makes the offer, so two newcomers don't both wait.
      const since = Number(msg.since) || Date.now();
      const iOffer = lobby.joinedAt < since || (lobby.joinedAt === since && state.myId < from);
      if (!iOffer) return;
      if (existing) removePeer(existing, 'retry');
      createPeer(from, { name: String(msg.name || 'Someone').slice(0, 32), polite: state.myId > from, sendPre: lobbySender(from) });
      break;
    }
    case 'signal': {
      if (lobby.blocked.has(from) || !msg.data) return;
      let peer = state.peers.get(from);
      if (!peer) {
        if (!msg.data.description || msg.data.description.type !== 'offer') return;
        if (state.peers.size >= MAX_PEOPLE - 1) return;
        peer = createPeer(from, { name: 'Someone', polite: state.myId > from, waitForOffer: true, sendPre: lobbySender(from) });
      }
      queueSignal(peer, msg.data);
      break;
    }
    case 'locked':
    case 'full':
      if (!state.peers.size) {
        leave();
        toast(msg.type === 'locked' ? 'This lobby is locked. Ask the host to unlock it.' : `This lobby is full. Up to ${MAX_PEOPLE} people can be in one.`, 'err');
      }
      break;
  }
}

function renderLobby() {
  const lobby = state.lobby;
  const show = !!lobby;
  $('#lobbyChip').hidden = !show;
  if (!show) {
    $('#lobbyInvite').hidden = true;
    return;
  }
  $('#lobbyCodeChip').textContent = lobby.code;
  $('#lobbyCodeBig').textContent = lobby.code;
  const anyFriends = Rendezvous.friends().length > 0;
  $('#lobbyFriendsChip').hidden = !anyFriends;
  $('#lobbyFriendsBig').hidden = !anyFriends;
  const isHost = lobby.hostId === state.myId;
  $('#lobbyLock').hidden = !isHost;
  $('#lobbyLock').classList.toggle('on', lobby.locked);
  $('#lobbyLock').title = lobby.locked ? 'Unlock the lobby' : 'Lock the lobby';
  $('#lobbyInvite').hidden = state.peers.size > 0;
  $('#lobbyChip').classList.toggle('locked', lobby.locked);
  for (const peer of state.peers.values()) peer.card.querySelector('.kick').hidden = !isHost;
  updatePeopleLayout();
}

function setLobbyLocked(locked) {
  const lobby = state.lobby;
  if (!lobby || lobby.hostId !== state.myId) return;
  lobby.locked = locked;
  Log.info('lobby', locked ? 'locked' : 'unlocked');
  broadcast({ type: 'lobby', hostId: lobby.hostId, locked });
  toast(locked ? 'Lobby locked. Nobody new can join.' : 'Lobby unlocked');
  renderLobby();
}

function kickPeer(peer) {
  const lobby = state.lobby;
  if (!lobby || lobby.hostId !== state.myId) return;
  if (!confirm(I18n.t(`Remove ${peer.name} from the lobby?`))) return;
  Log.info('lobby', 'removing someone', { id: peer.id.slice(0, 6) });
  lobby.blocked.add(peer.id);
  broadcast({ type: 'kick', id: peer.id });
  removePeer(peer, 'removed');
}

async function copyLobbyCode() {
  if (!state.lobby) return;
  try {
    await navigator.clipboard.writeText(state.lobby.code);
    toast('Lobby code copied');
  } catch {
    toast(state.lobby.code);
  }
}

function initLobby() {
  $('#lobbyCopyChip').onclick = copyLobbyCode;
  $('#lobbyCopyBig').onclick = copyLobbyCode;
  $('#lobbyLock').onclick = () => setLobbyLocked(!state.lobby.locked);
  $('#lobbyFriendsChip').onclick = (e) => Social.openInviteMenu(e);
  $('#lobbyFriendsBig').onclick = (e) => Social.openInviteMenu(e);
}

// ===================================================================
// First call with a new friend: swap two codes by hand (1:1)
// ===================================================================
const CODE_PREFIX = 'MSR1.';
const CODES_PEER = 'codes';

async function joinWithCodes(role) {
  if (inCall()) return;
  if (!(await prepare())) return;
  // The code exchange comes first; the call screen opens once connected.
  state.mode = 'codes';
  showScreen('connect');
  startManual(role);
}

function startManual(role) {
  Log.info('codes', role === 'host' ? 'starting a call with codes' : 'joining with a code');
  const host = role === 'host';
  state.codesRole = role;
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
    // The offer is created by onnegotiationneeded and lands in showMyCode().
    createPeer(CODES_PEER, { name: 'Your friend', polite: false, sendPre: showMyCode });
    setStatus('Preparing your code…', 'wait');
  } else {
    setStatus("Waiting for your friend's code", 'wait');
    $('#theirCode').focus();
  }
}

async function useTheirCode() {
  const host = state.codesRole === 'host';
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
  let peer = state.peers.get(CODES_PEER);
  if (!host) {
    peer = createPeer(CODES_PEER, { name: 'Your friend', polite: true, waitForOffer: true, sendPre: showMyCode });
    $('#mMine').hidden = false;
    setStatus('Preparing your reply code…', 'wait');
  } else {
    setStatus('Connecting directly to your friend…', 'wait');
  }
  queueSignal(peer, { description });
}

// Called instead of sending our description to a server.
async function showMyCode(desc) {
  $('#myCode').value = await encodeCode(desc);
  Log.info('codes', `${desc.type} code ready`, { chars: $('#myCode').value.length, sdp: Log.sdp(desc) });
  $('#copyCode').disabled = false;
  setStatus(state.codesRole === 'guest' ? 'Send the reply code back. Connecting once they paste it…'
    : "Send the code, then paste your friend's reply", 'wait');
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
// Peers: one direct connection per other person, with "perfect negotiation"
// (either side can add or remove tracks at any time)
// ===================================================================

// options: name, polite, waitForOffer (don't send the first offer), sendPre(desc)
// for signaling before the direct channel is open.
function createPeer(id, { name, polite, waitForOffer = false, sendPre }) {
  const old = state.peers.get(id);
  if (old) removePeer(old, 'replaced');
  const servers = iceServers();
  const pc = new RTCPeerConnection({ iceServers: servers });
  const peer = {
    id, name, pc, dc: null, polite, waitForOffer, sendPre,
    makingOffer: false, ignoreOffer: false, settingAnswer: false, restartedIce: false,
    signalChain: Promise.resolve(),
    remote: new Map(), remoteMeta: new Map(),
    incoming: null, volume: 100, wasConnected: false, routeLogged: false,
    card: makePersonCard(id, name),
  };
  state.peers.set(id, peer);
  Log.info('pc', 'created', { peer: id.slice(0, 6), polite, waitForOffer, stunServers: servers.length ? servers[0].urls.length : 0, mode: state.mode });

  pc.onnegotiationneeded = () => negotiate(peer);
  pc.onicecandidate = ({ candidate }) => {
    Log.info('ice', 'local candidate', Log.candidate(candidate));
    if (candidate) sendSignal(peer, { candidate });
  };
  pc.onicecandidateerror = (e) => Log.warn('ice', 'candidate error (often a STUN server not answering)', { url: e.url, code: e.errorCode, text: e.errorText });
  pc.onicegatheringstatechange = () => Log.info('ice', `gathering ${pc.iceGatheringState}`, { peer: id.slice(0, 6) });
  pc.oniceconnectionstatechange = () => Log.info('ice', `connection ${pc.iceConnectionState}`, { peer: id.slice(0, 6) });
  pc.ontrack = (e) => {
    Log.info('media', 'remote track', { peer: id.slice(0, 6), kind: e.track.kind, stream: e.streams[0] ? e.streams[0].id.slice(0, 8) : 'none' });
    onRemoteTrack(peer, e);
  };
  pc.onconnectionstatechange = () => {
    Log.info('pc', `connection ${pc.connectionState}`, { peer: id.slice(0, 6) });
    onConnectionState(peer);
  };
  // Bitrate caps can only be set once a negotiation has finished.
  pc.onsignalingstatechange = () => {
    Log.info('pc', `signaling ${pc.signalingState}`, { peer: id.slice(0, 6) });
    if (pc.signalingState === 'stable') applySendParams();
  };

  // Both sides create the same pre-agreed channel; no extra handshake needed.
  setupDataChannel(peer, pc.createDataChannel('main', { negotiated: true, id: 0, ordered: true }));
  // The native streaming engine's video channel (public/engine.js).
  peer.engineDc = Engine.channel(pc);

  if (state.mic) for (const t of state.mic.getTracks()) pc.addTrack(t, state.mic);
  for (const kind of ['screen', 'media']) {
    const s = state[kind];
    if (s) s.senders.set(id, s.stream.getTracks().map((t) => pc.addTrack(t, s.stream)));
  }
  updatePeopleLayout();
  return peer;
}

async function negotiate(peer) {
  const { pc } = peer;
  // A side that answers a pasted code or a lobby offer never starts the first offer.
  if (peer.waitForOffer && !dcOpen(peer)) {
    Log.info('pc', 'negotiation needed, waiting for the other side to offer', { peer: peer.id.slice(0, 6) });
    return;
  }
  Log.info('pc', 'negotiation needed, making offer', { peer: peer.id.slice(0, 6) });
  try {
    peer.makingOffer = true;
    await setLocal(pc);
    Log.info('pc', 'local offer set', Log.sdp(pc.localDescription));
    await sendSignal(peer, { description: pc.localDescription });
  } catch (err) {
    Log.error('pc', 'making offer failed', err);
  } finally {
    peer.makingOffer = false;
  }
}

function dcOpen(peer) {
  return !!peer.dc && peer.dc.readyState === 'open';
}

function sendSignal(peer, data) {
  // Once connected, renegotiation (e.g. starting a screen share) goes over
  // the direct connection itself.
  if (dcOpen(peer)) {
    Log.info('signal', `sent ${data.description ? data.description.type : 'candidate'} over the direct connection`, { peer: peer.id.slice(0, 6) });
    peer.dc.send(JSON.stringify({ type: 'signal', data }));
    return Promise.resolve();
  }
  // Before that, candidates are bundled into the description once gathering
  // finishes, so only descriptions are sent.
  if (!data.description) return Promise.resolve();
  const { pc } = peer;
  const started = Date.now();
  return waitForIceGathering(pc).then(async () => {
    if (state.peers.get(peer.id) !== peer || pc.signalingState === 'closed') {
      Log.warn('signal', 'connection changed while gathering, not sending');
      return;
    }
    const desc = pc.localDescription;
    const sent = await peer.sendPre(desc);
    Log.info('signal', `sent ${desc.type} before connecting`, { peer: peer.id.slice(0, 6), mode: state.mode, relays: typeof sent === 'number' ? sent : undefined, gatherMs: Date.now() - started, sdp: Log.sdp(desc) });
    if (sent === 0) Log.error('signal', 'no relay was connected, nothing was sent');
  });
}

// No trickle ICE before connecting: each description carries every candidate found.
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

function queueSignal(peer, data) {
  peer.signalChain = peer.signalChain
    .then(() => onSignal(peer, data))
    .catch((err) => console.error('signal error', err));
}

async function onSignal(peer, { description, candidate }) {
  if (state.peers.get(peer.id) !== peer) return;
  const { pc } = peer;
  if (description) {
    Log.info('signal', `received ${description.type}`, { peer: peer.id.slice(0, 6), sdp: Log.sdp(description) });
    const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
    const collision = description.type === 'offer' && !readyForOffer;
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) {
      Log.info('signal', 'offer collision, ignoring theirs (this side is impolite)');
      return;
    }
    if (collision) Log.info('signal', 'offer collision, rolling back ours (this side is polite)');
    peer.settingAnswer = description.type === 'answer';
    try {
      await pc.setRemoteDescription(description);
    } catch (err) {
      Log.error('signal', `setting remote ${description.type} failed (signaling ${pc.signalingState})`, err);
      throw err;
    } finally {
      peer.settingAnswer = false;
    }
    if (description.type === 'offer') {
      await setLocal(pc);
      Log.info('pc', 'local answer set', Log.sdp(pc.localDescription));
      await sendSignal(peer, { description: pc.localDescription });
    }
  } else if (candidate) {
    try {
      await pc.addIceCandidate(candidate);
      Log.info('ice', 'remote candidate added', Log.candidate(candidate));
    } catch (err) {
      if (!peer.ignoreOffer) {
        Log.warn('ice', 'remote candidate rejected', err);
        throw err;
      }
    }
  }
}

function onConnectionState(peer) {
  if (state.peers.get(peer.id) !== peer) return;
  const { pc } = peer;
  switch (pc.connectionState) {
    case 'connected':
      if (!peer.wasConnected) Sfx.play('join');
      peer.wasConnected = true;
      peer.card.classList.remove('waiting');
      peer.card.classList.add('connected');
      setLive(true);
      updateRoute();
      clearInterval(state.statsTimer);
      state.statsTicks = 0;
      state.statsTimer = setInterval(() => {
        updateRoute();
        if (++state.statsTicks % 5 === 0) logVideoQuality().catch(() => {});
        checkCodecLoad().catch(() => {});
        Adapt.tick().catch((err) => Log.warn('media', 'smart streaming check failed', err));
        syncEngineStreams().catch(() => {});
        if (document.querySelector('.stream-info')) refreshStreamInfo().catch(() => {});
      }, 2000);
      break;
    case 'disconnected':
      peer.routeLogged = false; // log the route it recovers on
      setStatus(`Connection to ${peer.name} interrupted. Trying to recover…`, 'warn');
      break;
    case 'failed':
      logIceDiagnosis(pc);
      if (!peer.restartedIce) {
        peer.restartedIce = true;
        setStatus(`Connection to ${peer.name} failed. Retrying…`, 'warn');
        pc.restartIce();
      } else if (state.mode === 'lobby') {
        toast(`Couldn't keep a direct connection to ${peer.name}.`, 'err');
        removePeer(peer, 'failed');
      } else {
        setStatus('No direct route found. A strict firewall or NAT is blocking it, and no relay is used by design.', 'err');
      }
      break;
  }
}

function pcSummary(pc) {
  return { signaling: pc.signalingState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, connection: pc.connectionState };
}

// A connection can come back (a VPN switched off, Wi-Fi back) with only the ICE
// state saying so at first; either one counts.
const isUp = (pc) => pc.connectionState === 'connected' || ['connected', 'completed'].includes(pc.iceConnectionState);

// Runs every 2 s during a call: the status always reflects the connections as
// they are now, so a recovered call never stays on "trying to recover".
async function updateRoute() {
  const peers = [...state.peers.values()].filter((p) => p.wasConnected);
  const connected = peers.filter((p) => isUp(p.pc));
  if (!connected.length) return;
  const down = peers.find((p) => !isUp(p.pc));
  if (down) {
    setStatus(`Connection to ${down.name} interrupted. Trying to recover…`, 'warn');
    return;
  }
  const details = [];
  for (const peer of connected) {
    const stats = await pcStats(peer.pc);
    let pair;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
    });
    if (!pair) continue;
    const local = stats.get(pair.localCandidateId);
    if (!peer.routeLogged) {
      const remote = stats.get(pair.remoteCandidateId);
      peer.routeLogged = true;
      Log.info('ice', 'connected route', {
        peer: peer.id.slice(0, 6),
        local: local && `${local.candidateType} ${local.protocol} ${Log.ipKind(local.address || local.ip)}`,
        remote: remote && `${remote.candidateType} ${remote.protocol} ${Log.ipKind(remote.address || remote.ip)}`,
        rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      });
    }
    details.push({ lan: local && local.candidateType === 'host', rtt: pair.currentRoundTripTime });
  }
  if (connected.length === 1) {
    const d = details[0];
    if (!d) return setStatus('Connected directly', 'ok');
    const rtt = d.rtt != null ? `${Math.round(d.rtt * 1000)} ms ` : '';
    setStatus('Connected directly', 'ok', `${rtt}${d.lan ? 'on your network' : 'over the internet'}`);
  } else {
    setStatus('Connected directly', 'ok', `to ${connected.length} people`);
  }
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

// reason: 'left' | 'removed' | 'failed' | 'replaced' | 'retry' | 'leaving'
function removePeer(peer, reason) {
  if (state.peers.get(peer.id) !== peer) return;
  Log.info('pc', 'closing connection', { peer: peer.id.slice(0, 6), reason });
  state.peers.delete(peer.id);
  if (peer.dc) peer.dc.close();
  peer.pc.close();
  for (const id of [...peer.remote.keys()]) removeRemoteStream(peer, id);
  if (peer.incoming) peer.incoming.card.fail('Transfer interrupted');
  for (const kind of ['screen', 'media']) if (state[kind]) state[kind].senders.delete(peer.id);
  if (peer.engineRx) peer.engineRx.stop();
  Native.removeViewer(peer);
  Lanes.close(peer);
  detachMeter(peer.card);
  peer.card.remove();
  if (!state.peers.size) {
    setLive(false);
    clearInterval(state.statsTimer);
  }
  updatePeopleLayout();
  renderLobby();
  setChatEnabled([...state.peers.values()].some(dcOpen));
  if (state.mode === 'lobby' && !state.peers.size && reason !== 'leaving') {
    setStatus('Waiting for people to join', 'wait');
  }
}

function leave() {
  Log.info('call', 'leaving', { mode: state.mode, peers: state.peers.size });
  exitFocus();
  broadcast({ type: 'bye' });
  // Stop ringing your friend if they never picked up.
  const s = state.session;
  if (s && !isConnected() && state.pool) state.pool.send(s.friend, { type: 'cancel', sid: s.sid });
  stopRinging();
  Social.stopInvites();
  state.session = null;
  for (const peer of [...state.peers.values()]) removePeer(peer, 'leaving');
  const lobby = state.lobby;
  if (lobby) {
    clearTimeout(lobby.announceTimer);
    clearTimeout(lobby.timeout);
    if (state.pool) state.pool.removeChannel(lobby.channel);
  }
  state.lobby = null;
  state.mode = null;
  state.codesRole = null;
  state.codecOverride = null;
  renderLobby();
  stopLocal('screen', true);
  stopLocal('media', true);
  if (state.mic) state.mic.getTracks().forEach((t) => t.stop());
  state.mic = null;
  state.muted = false;
  resetDeafen();
  $('#micBtn').classList.remove('muted');
  label($('#micBtn'), 'Mute');
  state.unread = 0;
  $('#chatBadge').hidden = true;
  $('#meCard .micoff').hidden = true;
  detachMeter($('#meCard'));
  if (state.audioCtx) state.audioCtx.close();
  state.audioCtx = null;
  $('#messages').innerHTML = '<p class="empty">Messages and files go straight to the people in the call and aren\'t saved anywhere. Drop files here to send them.</p>';
  setLive(false);
  showScreen('join');
  if (!Rendezvous.friends().length && state.pool) {
    state.pool.close();
    state.pool = null;
  }
  renderFriends();
}

// ===================================================================
// Friends from a lobby: Add friend on one side, Accept on the other
// ===================================================================
const isFriend = (peer) => !!peer.friendId && Rendezvous.friends().some((f) => f.id === peer.friendId);

function renderBefriend(peer) {
  const box = peer.card && peer.card.querySelector('.befriend');
  if (!box) return;
  const show = state.mode === 'lobby' && !!peer.pub && !isFriend(peer);
  box.hidden = !show;
  peer.card.classList.toggle('is-friend', state.mode === 'lobby' && isFriend(peer));
  if (!show) return;
  const add = box.querySelector('.add-friend');
  const accept = box.querySelector('.accept-friend');
  const note = box.querySelector('.befriend-note');
  add.hidden = peer.asked || peer.theyAsked;
  accept.hidden = !peer.theyAsked || peer.asked;
  note.textContent = peer.asked ? 'Request sent' : peer.theyAsked ? 'Wants to be friends' : '';
  note.hidden = !note.textContent;
}

function askFriend(peer) {
  if (!peer.pub || isFriend(peer)) return;
  peer.asked = true;
  sendTo(peer, { type: 'friend-request' });
  if (peer.theyAsked) return acceptFriend(peer);
  renderBefriend(peer);
}

function acceptFriend(peer) {
  peer.asked = true;
  sendTo(peer, { type: 'friend-accept' });
  saveFriend(peer).then(() => toast(`${peer.name} is now your friend. Call them anytime from the home screen.`));
}

async function saveFriend(peer) {
  try {
    const { friend } = await Rendezvous.pair(peer.pub, peer.name);
    Log.info('pair', 'saved friend from a lobby', { friend: friend.id.slice(0, 6) });
    if (state.pool) state.pool.refreshTopics(true);
    else startListening();
    renderFriends();
  } catch (err) {
    Log.warn('pair', 'could not save friend', err);
    if (/own key/.test(err.message)) toast("These two windows share the same saved data, so they can't save each other as friends. Use a second computer or Windows account for the other one.", 'err');
  }
  renderBefriend(peer);
}

// ===================================================================
// People on the stage
// ===================================================================
function makePersonCard(id, name) {
  const card = $('#personTpl').content.firstElementChild.cloneNode(true);
  card.dataset.peer = id;
  card.classList.add('waiting'); // until the connection is up
  card.querySelector('.label').textContent = name;
  card.querySelector('.label').setAttribute('translate', 'no');
  card.querySelector('.initial').textContent = initial(name);
  const vol = card.querySelector('.peer-vol input');
  const pct = card.querySelector('.peer-vol-pct');
  vol.max = MAX_VOLUME;
  vol.value = 100;
  vol.setAttribute('aria-label', `${name}'s volume`);
  syncSlider(vol, 100);
  pct.textContent = '100%';
  vol.oninput = () => {
    const peer = state.peers.get(id);
    if (peer) setPeerVolume(peer, Number(vol.value), vol);
  };
  // Right-click someone for their volume (and Add friend or Remove in a lobby).
  card.addEventListener('contextmenu', (e) => {
    const peer = state.peers.get(id);
    if (!peer) return;
    e.preventDefault();
    const actions = [];
    if (state.mode === 'lobby' && peer.pub && !isFriend(peer) && !peer.asked) {
      actions.push({ label: peer.theyAsked ? 'Accept friend request' : 'Add friend', run: () => (peer.theyAsked ? acceptFriend(peer) : askFriend(peer)) });
    }
    if (state.lobby && state.lobby.hostId === state.myId) actions.push({ label: 'Remove from the lobby', danger: true, run: () => kickPeer(peer) });
    showVolumeMenu(e, { title: peer.name, value: peer.volume, onChange: (v) => setPeerVolume(peer, v), actions });
  });
  card.querySelector('.add-friend').onclick = () => { const peer = state.peers.get(id); if (peer) askFriend(peer); };
  card.querySelector('.accept-friend').onclick = () => { const peer = state.peers.get(id); if (peer) acceptFriend(peer); };
  card.querySelector('.kick').onclick = () => {
    const peer = state.peers.get(id);
    if (peer) kickPeer(peer);
  };
  $('.people').insertBefore(card, $('#peerCard'));
  return card;
}

function setPeerName(peer, name) {
  peer.name = String(name || '').slice(0, 32) || peer.name;
  peer.card.querySelector('.label').textContent = peer.name;
  peer.card.querySelector('.initial').textContent = initial(peer.name);
  peer.card.querySelector('.peer-vol input').setAttribute('aria-label', `${peer.name}'s volume`);
  if (!$('#soundPanel').hidden) renderSoundPeople();
  for (const id of peer.remote.keys()) renderRemoteStream(peer, id);
}

function updatePeopleLayout() {
  if (!$('#soundPanel').hidden) renderSoundPeople();
  const n = state.peers.size;
  const placeholder = $('#peerCard');
  placeholder.hidden = n > 0;
  placeholder.querySelector('.label').textContent = state.mode === 'lobby' ? 'Waiting for people to join' : 'Waiting for your friend';
  // The line between avatars only makes sense for two people.
  $('.link').hidden = n > 1;
  $('.people').classList.toggle('many', n > 1);
  $('.people').classList.toggle('crowd', n > 3);
}

// ===================================================================
// Data channel: chat, file transfer and call metadata (one per peer)
// ===================================================================
function setupDataChannel(peer, dc) {
  peer.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = FILE_BUFFER_LOW;
  dc.onopen = () => {
    Log.info('dc', 'direct channel open', { peer: peer.id.slice(0, 6) });
    if (state.session) stopRinging();
    if (state.lobby) clearTimeout(state.lobby.timeout);
    showScreen('call');
    sendTo(peer, { type: 'hello', name: state.name, muted: state.muted });
    // What we can decode for a native share (public/native.js).
    sendTo(peer, { type: 'engine-hello', codecs: state.engineDecode || [] });
    // 1:1 calls swap identity keys over this direct, encrypted channel so you
    // can find each other again later without codes. In lobbies everyone shares
    // their public key so the app can tell who's already a friend; saving someone
    // takes an Add friend on one side and an Accept on the other.
    Rendezvous.identity().then((me) => sendTo(peer, { type: state.mode === 'lobby' ? 'ident' : 'pair', pub: me.pub, name: state.name }))
      .catch((err) => console.warn('pairing unavailable', err));
    if (state.lobby && state.lobby.hostId === state.myId) {
      sendTo(peer, { type: 'lobby', hostId: state.myId, locked: state.lobby.locked });
    }
    for (const kind of ['screen', 'media']) {
      const s = state[kind];
      if (s) sendTo(peer, { type: 'stream', id: s.stream.id, kind, label: s.label });
    }
    setChatEnabled(true);
    renderLobby();
  };
  dc.onclose = () => {
    Log.info('dc', 'direct channel closed', { peer: peer.id.slice(0, 6) });
    if (state.peers.get(peer.id) !== peer) return;
    setChatEnabled([...state.peers.values()].some(dcOpen));
    // The other side closed the window without saying goodbye.
    if (peer.wasConnected) onPeerGone(peer, 'left');
  };
  dc.onerror = (e) => Log.warn('dc', 'channel error', e.error ? e.error.message : 'unknown');
  dc.onmessage = (e) => {
    if (typeof e.data === 'string') onDataMessage(peer, JSON.parse(e.data));
    else onFileChunk(peer, e.data);
  };
}

function sendTo(peer, msg) {
  if (dcOpen(peer)) peer.dc.send(JSON.stringify(msg));
}

function broadcast(msg) {
  for (const peer of state.peers.values()) sendTo(peer, msg);
}

// Someone hung up or vanished: a 1:1 call ends, a lobby carries on.
function onPeerGone(peer, reason) {
  if (state.peers.get(peer.id) !== peer) return;
  const who = peer.name || 'Your friend';
  Sfx.play('leave');
  if (state.mode === 'lobby') {
    removePeer(peer, reason);
    addSystem(`${who} left`);
    toast(`${who} left the lobby`);
    return;
  }
  peer.dc = null;
  leave();
  toast(`${who} left the call`);
}

function onDataMessage(peer, msg) {
  if (typeof msg.type === 'string' && msg.type.startsWith('engine-')) return onEngineMessage(peer, msg);
  switch (msg.type) {
    case 'ident':
      if (msg.pub && msg.pub.kty === 'EC') {
        peer.pub = msg.pub;
        Rendezvous.keyId(msg.pub).then((id) => { peer.friendId = id; renderBefriend(peer); }).catch(() => {});
      }
      break;
    case 'friend-request':
      peer.theyAsked = true;
      if (peer.asked) acceptFriend(peer);
      else {
        renderBefriend(peer);
        toast(`${peer.name} wants to add you as a friend`);
        Sfx.play('join');
      }
      break;
    case 'friend-accept':
      // Only someone you asked can add themselves.
      if (peer.asked) saveFriend(peer).then(() => toast(`${peer.name} is now your friend. Call them anytime from the home screen.`));
      break;
    case 'pair':
      if (state.mode === 'lobby') break;
      Rendezvous.pair(msg.pub, peer.name || msg.name).then(({ friend, isNew }) => {
        Log.info('pair', isNew ? 'saved new friend' : 'refreshed saved friend', { friend: friend.id.slice(0, 6) });
        if (isNew) toast(`${friend.name} is saved. Next time, just press Call.`);
        if (state.pool) state.pool.refreshTopics(true);
        else startListening();
        renderFriends();
      }).catch((err) => {
        Log.warn('pair', 'could not save friend', err);
        // Two tabs of the same browser share one identity, so they can't save each other.
        if (/own key/.test(err.message)) {
          toast('These two windows share the same saved data, so they can\'t save each other as friends. Use a second computer or Windows account for the other one.', 'err');
        }
      });
      break;
    case 'hello':
      setPeerName(peer, msg.name || 'Someone');
      peer.card.querySelector('.micoff').hidden = !msg.muted;
      addSystem(`${peer.name} joined`);
      break;
    case 'signal':
      queueSignal(peer, msg.data);
      break;
    case 'codec':
      onPeerCodec(String(msg.codec));
      break;
    case 'codec-fallback':
      onPeerCodecFallback(String(msg.codec));
      break;
    case 'stream-stats':
      onStreamStats(peer, msg);
      break;
    case 'name':
      setPeerName(peer, msg.name);
      break;
    case 'mute':
      peer.muted = !!msg.muted;
      peer.card.querySelector('.micoff').hidden = !msg.muted;
      break;
    case 'chat':
      addChat(peer.name || 'Someone', String(msg.text), false);
      break;
    case 'stream':
      peer.remoteMeta.set(msg.id, { kind: msg.kind, label: String(msg.label || '') });
      if (peer.remote.has(msg.id)) renderRemoteStream(peer, msg.id);
      break;
    case 'stream-view':
      onStreamView(peer, msg);
      break;
    case 'stream-end':
      peer.remoteMeta.delete(msg.id);
      removeRemoteStream(peer, msg.id);
      break;
    case 'file-start':
      peer.incoming = {
        ...msg,
        chunks: [],
        received: 0,
        card: addFileCard(peer.name || 'Someone', msg.name, msg.size, false),
      };
      break;
    case 'file-end': {
      const inc = peer.incoming;
      if (!inc) break;
      peer.incoming = null;
      // Only preview plain image types; everything else is a download, never rendered.
      const safe = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(inc.mime) ? inc.mime : 'application/octet-stream';
      inc.card.complete(new Blob(inc.chunks, { type: safe }));
      break;
    }
    case 'lobby':
      // Only the person who created the lobby sends this.
      if (state.lobby && (!state.lobby.hostId || state.lobby.hostId === msg.hostId) && msg.hostId === peer.id) {
        state.lobby.hostId = msg.hostId;
        if (state.lobby.locked !== !!msg.locked) addSystem(msg.locked ? 'The host locked the lobby' : 'The host unlocked the lobby');
        state.lobby.locked = !!msg.locked;
        renderLobby();
      }
      break;
    case 'kick':
      if (!state.lobby || state.lobby.hostId !== peer.id) break; // only the host can remove people
      if (msg.id === state.myId) {
        leave();
        toast('The host removed you from the lobby', 'err');
      } else {
        state.lobby.blocked.add(String(msg.id));
        const gone = state.peers.get(String(msg.id));
        if (gone) {
          addSystem(`${gone.name} was removed`);
          removePeer(gone, 'removed');
        }
      }
      break;
    case 'bye':
      peer.wasConnected = false; // don't also treat the channel closing as a second leave
      onPeerGone(peer, 'left');
      break;
  }
}

// ---------- chat ----------
function initChat() {
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text || ![...state.peers.values()].some(dcOpen)) return;
    broadcast({ type: 'chat', text });
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
    if (![...state.peers.values()].some(dcOpen)) return toast('Files can be sent once someone is connected');
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
  $('#chatInput').placeholder = on ? 'Message' : state.mode === 'lobby' ? 'Waiting for people to join' : 'Waiting for your friend';
}

function messageShell(author, mine, bubbleClass) {
  const el = document.createElement('div');
  el.className = `msg${mine ? ' me' : ''}`;
  el.innerHTML = `<div class="meta"><span class="who"></span><span class="when"></span></div><div class="bubble ${bubbleClass}" translate="no"></div>`;
  el.querySelector('.who').textContent = mine ? 'You' : author;
  if (!mine) el.querySelector('.who').setAttribute('translate', 'no');
  el.querySelector('.when').textContent = clock();
  return el;
}

function addChat(author, text, mine) {
  const el = messageShell(author, mine, '');
  el.querySelector('.bubble').textContent = text;
  appendMessage(el);
  if (!mine) {
    noteUnread();
    // Only when you might not see it: chat closed or the window in the background.
    if (!$('#layout').classList.contains('chat-open') || document.hidden) Sfx.play('message');
  }
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

// ---------- file transfer: sent to everyone connected, one after another ----------
function queueFile(file) {
  const card = addFileCard(state.name, file.name, file.size, true);
  card.setStatus('Queued');
  state.fileChain = state.fileChain.then(() => sendFileToAll(file, card)).catch((err) => {
    console.warn('file send failed', err);
    card.fail('Not sent, the connection closed');
  });
}

async function sendFileToAll(file, card) {
  const targets = [...state.peers.values()].filter(dcOpen);
  if (!targets.length) throw new Error('nobody connected');
  let delivered = 0;
  for (const [i, peer] of targets.entries()) {
    try {
      await sendFile(peer, file, (p) => card.progress((i + p) / targets.length));
      delivered++;
    } catch (err) {
      Log.warn('files', 'sending to one person failed', { peer: peer.id.slice(0, 6), error: err.message });
    }
  }
  if (!delivered) throw new Error('not delivered');
  card.complete(file);
  if (delivered < targets.length) card.setStatus(`Sent to ${delivered} of ${targets.length}`);
}

async function sendFile(peer, file, onProgress) {
  const dc = peer.dc;
  if (!dcOpen(peer)) throw new Error('channel closed');
  const max = peer.pc.sctp && peer.pc.sctp.maxMessageSize;
  const chunkSize = Math.min(64 * 1024, max || 16 * 1024);
  dc.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size, mime: file.type }));
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
    onProgress(offset / file.size);
  }
  dc.send(JSON.stringify({ type: 'file-end' }));
}

function onFileChunk(peer, buf) {
  const inc = peer.incoming;
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
  el.querySelector('.fname').setAttribute('translate', 'no');
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
// Local media: mic, screen share, file streaming (sent to every peer)
// ===================================================================
function initControls() {
  $('#micBtn').onclick = toggleMute;
  $('#deafenBtn').onclick = toggleDeafen;
  $('#screenBtn').onclick = toggleScreen;
  $('#mediaBtn').onclick = () => (state.media ? stopLocal('media') : $('#mediaFile').click());
  $('#mediaFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) streamFile(f);
  };
  $('#hangBtn').onclick = () => { if (state.mode) Sfx.play('hangup'); leave(); };
}

// Native shares: the browser's own capture was only your tile's preview, and it
// still grabs full-size frames in the main process (~130 MB at 1440p) to shrink
// them. Your tile keeps a snapshot instead and that capture closes; the sound
// (its own capture) and the native stream go on. A share of a window that
// closes still ends: the helper reports it.
async function freezePreview(track, el) {
  try {
    const frame = await new ImageCapture(track).grabFrame();
    const w = Math.min(960, frame.width);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = Math.round((frame.height * w) / frame.width);
    canvas.getContext('2d').drawImage(frame, 0, 0, canvas.width, canvas.height);
    frame.close();
    el.poster = canvas.toDataURL('image/jpeg', 0.85);
  } catch (err) {
    Log.warn('media', 'no snapshot for the preview', err);
  }
  if (!state.screen || state.screen.preview.getVideoTracks()[0] !== track) return; // stopped meanwhile
  el.srcObject = null;
  track.stop();
  Log.info('media', 'preview capture closed, native share goes on');
}

function toggleMute() {
  if (!state.mic) return;
  state.muted = !state.muted;
  $('#micBtn').classList.toggle('muted', state.muted);
  applyMicEnabled(); // also sets the button's label
  $('#meCard .micoff').hidden = !state.muted;
  broadcast({ type: 'mute', muted: state.muted });
  Sfx.play(state.muted ? 'mute' : 'unmute');
}

async function toggleScreen() {
  if (state.screen) return stopLocal('screen');
  let stream;
  state.pickerCancelled = false;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(shareConstraints());
  } catch (err) {
    shareEnded();
    // Closing the picker is not an error.
    const cancelled = err.name === 'NotAllowedError' || state.pickerCancelled;
    Log.info('media', cancelled ? 'screen share cancelled' : 'screen share failed', `${err.name}: ${err.message}`);
    if (!cancelled) toast(`Couldn't share screen: ${err.message}`, 'err');
    return;
  }
  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0];
  Log.info('media', 'screen share started', {
    video: video && video.getSettings ? (({ width, height, frameRate }) => ({ width, height, frameRate }))(video.getSettings()) : null,
    audio: audio ? { label: audio.label, restrictOwnAudio: audio.getSettings ? audio.getSettings().restrictOwnAudio : undefined } : 'none',
  });
  if (video) {
    if ('contentHint' in video) video.contentHint = motionFor('screen') === 'sharp' ? 'detail' : 'motion';
    video.addEventListener('ended', () => { if (state.screen && state.screen.preview === stream) stopLocal('screen'); });
  }
  // The native engine sends the picture itself when everyone can show it: then
  // only the sound goes over WebRTC, and the browser's capture is just a small
  // preview for your own tile.
  let publishStream = stream;
  let native = false;
  if (video && Native.pickCodec()) {
    publishStream = new MediaStream(stream.getAudioTracks());
    native = await Native.start(publishStream.id);
    if (!native) publishStream = stream;
  }
  state.screen = { stream: publishStream, preview: stream, native, senders: new Map(), label: 'Screen' };
  const tile = makeTile({ title: 'Your screen', remote: false });
  tile.video.muted = true;
  tile.video.srcObject = stream;
  if (native) freezePreview(video, tile.video);
  state.screen.tile = tile.el;
  addQualityPicker(tile.el);
  publish('screen');
  if (video && !native) Adapt.start(video);
  streaming();
  // Right-click your own share for its numbers.
  tile.el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showVolumeMenu(e, { title: I18n.t('Your screen'), value: null, actions: [{ label: tile.el.querySelector('.stream-info') ? 'Hide stream info' : 'Stream info', run: () => toggleStreamInfo(tile.el) }] });
  });
  Sfx.play('streamStart');
  $('#screenBtn').classList.add('active');
  label($('#screenBtn'), 'Stop sharing');
}

async function streamFile(file) {
  if (state.media) stopLocal('media');
  const url = URL.createObjectURL(file);
  const tile = makeTile({ title: `Streaming: ${file.name}`, remote: false });
  const el = tile.video;
  el.controls = true;
  tile.el.querySelector('.zoom-btn').hidden = true; // the player's own controls would zoom too
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
    return toast('Media file streaming isn\'t supported here. Use the Miserecord app.', 'err');
  }
  // The browser drops captured tracks when a file ends, so we keep one stable
  // stream for everyone and swap in freshly captured tracks on every play.
  const stream = new MediaStream();
  state.media = { stream, senders: new Map(), label: file.name, el, url, tile: tile.el };
  addQualityPicker(tile.el);
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
    for (const peer of state.peers.values()) {
      const list = media.senders.get(peer.id) || [];
      const sender = list.find((s) => s.track && s.track.kind === track.kind);
      if (sender) sender.replaceTrack(track);
      else media.senders.set(peer.id, [...list, peer.pc.addTrack(track, stream)]);
    }
  };
  const recapture = () => {
    const fresh = capture.call(el);
    fresh.getTracks().forEach(useTrack);
    fresh.addEventListener('addtrack', ({ track }) => useTrack(track));
  };
  publish('media');
  Sfx.play('streamStart');
  streaming();
  recapture();
  el.addEventListener('playing', recapture);
  $('#mediaBtn').classList.add('active');
  label($('#mediaBtn'), 'Stop streaming');
}

// The desktop app gives the capture and encoder above-normal priority while you
// share a screen or stream a file.
function streaming() {
  if (window.miserecordDesktop && window.miserecordDesktop.setStreaming) window.miserecordDesktop.setStreaming(!!(state.screen || state.media));
}

// The desktop app hides itself from screen captures while you share a monitor;
// this undoes it.
function shareEnded() {
  if (window.miserecordDesktop && window.miserecordDesktop.shareEnded) window.miserecordDesktop.shareEnded();
}

function publish(kind) {
  const s = state[kind];
  broadcast({ type: 'stream', id: s.stream.id, kind, label: s.label });
  for (const peer of state.peers.values()) {
    s.senders.set(peer.id, s.stream.getTracks().map((t) => peer.pc.addTrack(t, s.stream)));
  }
}

function stopLocal(kind, quiet = false) {
  const s = state[kind];
  if (!s) return;
  if (!quiet) Sfx.play('streamStop');
  state[kind] = null;
  for (const peer of state.peers.values()) {
    if (peer.pc.signalingState === 'closed') continue;
    for (const sender of s.senders.get(peer.id) || []) {
      try { peer.pc.removeTrack(sender); } catch { /* already gone */ }
    }
  }
  broadcast({ type: 'stream-end', id: s.stream.id });
  if (s.native) Native.stop();
  s.stream.getTracks().forEach((t) => t.stop());
  if (s.preview) s.preview.getTracks().forEach((t) => t.stop());
  if (s.el) { s.el.pause(); s.el.removeAttribute('src'); s.el.load(); }
  if (s.url) URL.revokeObjectURL(s.url);
  if (s.tile) {
    if (state.focusTile === s.tile) exitFocus();
    removeTile(s.tile);
  }
  updateStageLayout();
  if (kind === 'screen') Adapt.stop();
  streaming();
  if (kind === 'screen') {
    shareEnded();
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
function onRemoteTrack(peer, e) {
  const stream = e.streams[0] || new MediaStream([e.track]);
  if (!peer.remote.has(stream.id)) {
    peer.remote.set(stream.id, { stream });
    stream.addEventListener('removetrack', () => {
      if (stream.getTracks().length === 0) removeRemoteStream(peer, stream.id);
    });
  }
  const entry = peer.remote.get(stream.id);
  // A native share's picture can arrive before its sound: the entry then holds
  // our own stream with the decoded video, and the sound joins it here.
  if (entry.stream !== stream && !entry.stream.getTracks().includes(e.track)) {
    entry.stream.addTrack(e.track);
    if (entry.tile) Playback.route(entry.tile.video, entry.stream);
  }
  renderRemoteStream(peer, stream.id);
}

function renderRemoteStream(peer, id) {
  const entry = peer.remote.get(id);
  if (!entry) return;
  const { stream } = entry;
  const meta = peer.remoteMeta.get(id);
  const hasVideo = stream.getVideoTracks().length > 0;
  // Their microphone is the audio-only stream without screen/media metadata.
  const kind = meta ? meta.kind : hasVideo ? 'screen' : 'mic';

  if (kind === 'mic') {
    if (!entry.audio) {
      entry.audio = new Audio();
      entry.audio.autoplay = true;
      entry.audio.srcObject = stream;
      Playback.route(entry.audio, stream);
      Playback.set(entry.audio, voiceVolumeFor(peer));
      entry.audio.play().catch(() => toast('Click anywhere to enable call audio.'));
      refreshPeerMeter(peer);
    }
    return;
  }
  // It turned out to be a screen/media stream: drop the mic-style player.
  if (entry.audio) {
    Playback.unroute(entry.audio);
    entry.audio.srcObject = null;
    entry.audio = null;
    refreshPeerMeter(peer);
  }
  const who = peer.name || 'Someone';
  const title = kind === 'media' ? `${who} is streaming: ${meta.label}` : `${who}'s screen`;
  if (!entry.tile) {
    const tile = makeTile({ title, remote: true });
    tile.video.srcObject = stream;
    Playback.route(tile.video, stream);
    addTileVolume(tile, entry);
    tile.video.play().catch(() => {});
    entry.tile = tile;
    watchView(peer, id, entry);
  }
  entry.tile.setTitle(title);
  entry.tile.el.classList.toggle('audio-only', !hasVideo);
}

function removeRemoteStream(peer, id) {
  const entry = peer.remote.get(id);
  if (!entry) return;
  peer.remote.delete(id);
  if (entry.audio) {
    Playback.unroute(entry.audio);
    entry.audio.srcObject = null;
    entry.audio = null;
    refreshPeerMeter(peer);
  }
  if (entry.viewObserver) entry.viewObserver.disconnect();
  clearTimeout(entry.viewTimer);
  if (entry.tile) {
    Playback.unroute(entry.tile.video);
    if (state.focusTile === entry.tile.el) exitFocus();
    removeTile(entry.tile.el);
  }
  updateStageLayout();
}

// ---------- how big each stream is shown here, told to whoever sends it ----------
// The sender uploads a stream once per viewer, so it sends each viewer only what
// they can see: a small tile gets a small, cheap picture, a minimized window
// none at all, full screen or a big tile the full one. The size is the
// picture's real size on screen in physical pixels (a big tile on a 1440p
// monitor counts as big). Growing is reported at once; shrinking after 1.5 s,
// so resizing or a quick toggle doesn't flip the quality back and forth.
const VIEW_STEP = 90; // px: sizes are rounded so small wobbles aren't reported
function watchView(peer, id, entry) {
  const report = () => reportView(peer, id, entry);
  entry.viewObserver = new ResizeObserver(report);
  entry.viewObserver.observe(entry.tile.video);
  entry.tile.video.addEventListener('resize', report); // the picture's own size changed
  // Zoom changes how many pixels are needed without changing the tile.
  new MutationObserver(report).observe(entry.tile.el, { attributes: true, attributeFilter: ['class'] });
  report();
}

function viewOf(entry) {
  const video = entry.tile.video;
  if (document.hidden) return { w: 0, h: 0, hidden: true };
  const dpr = window.devicePixelRatio || 1;
  const box = video.getBoundingClientRect();
  let w = box.width * dpr, h = box.height * dpr;
  // The picture fits inside the box (letterboxed): its own shape decides.
  if (video.videoWidth && video.videoHeight && w && h) {
    const ratio = video.videoWidth / video.videoHeight;
    if (w / h > ratio) w = h * ratio; else h = w / ratio;
  }
  if (w < 2 || h < 2) return { w: 0, h: 0, hidden: true };
  // Zoomed in: the full picture is needed.
  if (entry.tile.el.classList.contains('zoomed')) return { w: 0, h: 0, full: true };
  const round = (v) => Math.max(VIEW_STEP, Math.ceil(v / VIEW_STEP) * VIEW_STEP);
  return { w: round(w), h: round(h) };
}

function reportView(peer, id, entry) {
  if (!entry.tile) return;
  // Before its first frame a video element has the browser's default size
  // (300x150), which would look like a small view. Its "resize" event reports
  // once the picture is in.
  if (!entry.tile.video.videoWidth && !document.hidden) return;
  const view = viewOf(entry);
  const last = entry.view;
  if (last && last.w === view.w && last.h === view.h && !!last.hidden === !!view.hidden && !!last.full === !!view.full) {
    clearTimeout(entry.viewTimer);
    entry.viewTimer = null;
    return;
  }
  const bigger = !last || view.full || (last.hidden && !view.hidden) || (!last.full && view.h > last.h);
  const send = () => {
    entry.viewTimer = null;
    entry.view = view;
    sendTo(peer, { type: 'stream-view', id, ...view });
  };
  clearTimeout(entry.viewTimer);
  if (bigger) send();
  else entry.viewTimer = setTimeout(send, 1500);
}

function reportAllViews() {
  for (const peer of state.peers.values()) {
    for (const [id, entry] of peer.remote) if (entry.tile) reportView(peer, id, entry);
  }
}
document.addEventListener('visibilitychange', reportAllViews);
document.addEventListener('fullscreenchange', reportAllViews);

// Sender side: a viewer said how they show one of your streams.
function onStreamView(peer, msg) {
  const id = String(msg.id || '');
  const num = (v) => Math.max(0, Math.min(16384, Number(v) || 0));
  const view = { w: num(msg.w), h: num(msg.h), hidden: !!msg.hidden, full: !!msg.full };
  peer.views ||= new Map();
  peer.views.set(id, view);
  Log.info('media', 'viewer shows a stream at', { peer: peer.id.slice(0, 6), size: view.hidden ? 'hidden' : view.full ? 'full' : `${view.w}x${view.h}` });
  applySendParamsTo(peer);
  if (Native.streamId === id) Native.setView(peer, view);
}

function voiceVolumeFor(peer) {
  return (settings.voiceVolume / 100) * (peer.volume / 100);
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

// ---------- the hub: the people, call timer, quick actions ----------
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
    <div class="video-wrap"><video autoplay playsinline></video><button type="button" class="zoom-chip" hidden></button></div>
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
  const zoom = enableZoom(el, video);
  const zoomBtn = document.createElement('button');
  zoomBtn.className = 'icon-btn zoom-btn';
  zoomBtn.title = 'Zoom in';
  zoomBtn.setAttribute('aria-label', 'Zoom in');
  zoomBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M10.5 8v5M8 10.5h5"/></svg>';
  zoomBtn.onclick = () => zoom.step(1.5);
  el.querySelector('.actions').append(zoomBtn, full);
  video.addEventListener('dblclick', () => {
    if (video.controls) return;
    // Zoomed in: double-click goes back to the whole picture first.
    if (zoom.level() > 1) return zoom.reset();
    $('.stage-wrap').classList.contains('focus') ? exitFocus() : enterFocus(el);
  });
  new MutationObserver(() => {
    const audioOnly = el.classList.contains('audio-only');
    el.querySelector('.audio-art').hidden = !audioOnly;
    full.hidden = audioOnly;
    zoomBtn.hidden = audioOnly || video.controls;
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
  // Remote tiles first, your own previews after them.
  const tiles = $('#tiles');
  if (remote) tiles.prepend(el);
  else tiles.append(el);
  updateStageLayout();
  return { el, video, setTitle: (t) => { titleEl.textContent = t; } };
}

// Zoom into a stream: scroll (in full screen, or Ctrl+scroll on the stage) zooms
// around the pointer, dragging moves around, double-click or the chip resets.
const MAX_ZOOM = 8;

function enableZoom(tile, video) {
  const chip = tile.querySelector('.zoom-chip');
  let z = 1, x = 0, y = 0;
  let drag = null;

  const size = () => ({ w: video.offsetWidth, h: video.offsetHeight });
  const clamp = () => {
    const { w, h } = size();
    x = Math.min(0, Math.max(w - w * z, x));
    y = Math.min(0, Math.max(h - h * z, y));
  };
  const render = () => {
    clamp();
    video.style.transform = z > 1 ? `translate(${x}px, ${y}px) scale(${z})` : '';
    tile.classList.toggle('zoomed', z > 1);
    chip.hidden = z <= 1;
    chip.textContent = `${Math.round(z * 100)}%`;
    chip.title = 'Back to the whole picture';
  };
  // Zoom to a new level, keeping the point under (cx, cy) where it is.
  const zoomAt = (next, cx, cy) => {
    next = Math.min(MAX_ZOOM, Math.max(1, next));
    const lx = (cx - x) / z, ly = (cy - y) / z;
    z = next;
    x = cx - z * lx;
    y = cy - z * ly;
    if (z === 1) { x = 0; y = 0; }
    render();
  };
  const local = (e) => {
    const r = video.parentElement.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  video.addEventListener('wheel', (e) => {
    if (video.controls) return;
    const focused = tile.classList.contains('focused');
    if (!focused && !e.ctrlKey) return; // on the stage, plain scrolling scrolls the page
    e.preventDefault();
    const [cx, cy] = local(e);
    zoomAt(z * Math.pow(1.0015, -e.deltaY), cx, cy);
  }, { passive: false });

  video.addEventListener('pointerdown', (e) => {
    if (z <= 1 || e.button !== 0) return;
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x, y };
    video.setPointerCapture(e.pointerId);
    tile.classList.add('panning');
  });
  video.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    x = drag.x + (e.clientX - drag.sx);
    y = drag.y + (e.clientY - drag.sy);
    render();
  });
  const endDrag = () => { drag = null; tile.classList.remove('panning'); };
  video.addEventListener('pointerup', endDrag);
  video.addEventListener('pointercancel', endDrag);
  chip.addEventListener('click', () => zoomAt(1, 0, 0));
  // Keep the picture in bounds when the tile changes size (full screen, window).
  new ResizeObserver(render).observe(video);

  return {
    level: () => z,
    reset: () => zoomAt(1, 0, 0),
    step: (factor) => { const { w, h } = size(); zoomAt(z * factor, w / 2, h / 2); },
  };
}

// Each person's speaking ring follows whichever of their streams is their mic.
function refreshPeerMeter(peer) {
  detachMeter(peer.card);
  for (const entry of peer.remote.values()) {
    if (entry.audio) return attachMeter(peer.card, entry.stream);
  }
}

function removeTile(el) {
  if (!el) return;
  el.remove();
  updateStageLayout();
}

// With a stream on the stage, the people move to a row at the top.
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
  state.meters.set(card, { source, analyser, data: new Uint8Array(analyser.fftSize), shown: -1 });
  if (!state.meterTimer) state.meterTimer = setTimeout(tickMeters, 33);
}

function detachMeter(card) {
  const m = state.meters.get(card);
  if (!m) return;
  m.source.disconnect();
  state.meters.delete(card);
  card.style.setProperty('--level', 0);
}

// 30 times a second on a timer, not on every screen frame: that was 144 style
// updates a second per person on a 144 Hz screen, and screen frames stop while
// the window is minimized or in the tray, which froze the in-game overlay's
// "who's talking". A card is only touched when its level visibly changes.
function tickMeters() {
  state.meterTimer = null;
  if (!state.meters.size) return;
  for (const [card, m] of state.meters) {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (const v of m.data) sum += (v - 128) ** 2;
    const rms = Math.sqrt(sum / m.data.length) / 128;
    const muted = card.id === 'meCard' && state.muted;
    const level = muted ? 0 : Math.round(Math.min(1, rms * 6) * 50) / 50;
    if (level !== m.shown) {
      m.shown = level;
      card.style.setProperty('--level', level);
    }
  }
  state.meterTimer = setTimeout(tickMeters, 33);
}

// ===================================================================
// Helpers
// ===================================================================
// One getStats() per connection per moment: the checks of the 2-s tick (route,
// smart streaming, codec load, sound sync, Stream info) share it instead of
// each asking the browser for the whole report again.
function pcStats(pc) {
  const now = performance.now();
  if (!pc.statsCache || now - pc.statsCache.at > 500) pc.statsCache = { at: now, report: pc.getStats() };
  return pc.statsCache.report;
}

function isConnected() {
  return [...state.peers.values()].some((p) => p.pc.connectionState === 'connected');
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

// Start new offers, e.g. after the codec changed.
function renegotiate() {
  for (const peer of state.peers.values()) negotiate(peer);
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
  return (String(name || '').trim()[0] || '?').toUpperCase();
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
  for (const peer of state.peers.values()) {
    for (const { audio } of peer.remote.values()) if (audio && audio.paused) audio.play().catch(() => {});
  }
});
window.addEventListener('beforeunload', () => broadcast({ type: 'bye' }));

initSettings();
initExtras();
initSounds();
initFocus();
initJoin();
initManual();
initLobby();
initChat();
initControls();
Social.init();
initSoundPanel();
Native.init();
