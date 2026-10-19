// Online status, invites to a lobby, and the in-game overlay's feed.
// Loaded after app.js; uses its state and helpers.
//
// Online status: while the app is open it tells each saved friend "here" once a
// minute through the relays, encrypted with that friend's key like every relay
// message, so only they can read it. A friend counts as online for 2.5 minutes
// after their last "here". "who" (sent when the relays connect) asks friends to
// answer at once instead of within the minute.
'use strict';

Object.assign(SETTINGS_DEFAULTS, {
  showOnline: true,     // tell saved friends when I have Miserecord open
  overlay: true,        // in-game overlay of who's talking, during calls (desktop app)
  overlayCorner: 'top-left',
});
for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) if (!(k in settings)) settings[k] = v;

const Social = {
  presence: new Map(),   // friend id -> { status: 'online' | 'busy', at }
  answered: new Map(),   // friend id -> when we last answered their "who"
  invites: new Map(),    // sid -> { friend, timer, stop }
  relaysUp: false,

  EVERY: 60000,
  TTL: 150000,

  init() {
    setInterval(() => this.announce('here'), this.EVERY);
    // Friends whose last "here" is too old go offline.
    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, p] of this.presence) if (now - p.at > this.TTL) { this.presence.delete(id); changed = true; }
      if (changed) renderFriends();
    }, 15000);
    window.addEventListener('beforeunload', () => this.announce('away'));
    Overlay.init();
  },

  status() {
    return inCall() ? 'busy' : 'online';
  },

  announce(type) {
    if (!settings.showOnline || !state.pool || !state.pool.connected()) return;
    for (const f of Rendezvous.friends()) state.pool.send(f, { type, status: this.status() });
  },

  // From app.js: the relays' connection count changed.
  onRelays(open) {
    const up = open > 0;
    if (up && !this.relaysUp) this.announce('who');
    this.relaysUp = up;
  },

  // From app.js: calling, in a call or back on the home screen.
  statusChanged() {
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.announce('here'), 500);
  },

  // Relay messages from a saved friend. True when handled here.
  onFriendMessage(friend, msg) {
    switch (msg.type) {
      case 'here':
      case 'who':
      case 'away': {
        const before = this.presence.get(friend.id);
        if (msg.type === 'away') this.presence.delete(friend.id);
        else this.presence.set(friend.id, { status: msg.status === 'busy' ? 'busy' : 'online', at: Date.now() });
        const after = this.presence.get(friend.id);
        if (!before !== !after || (before && after && before.status !== after.status)) {
          Log.info('friends', `${friend.id.slice(0, 6)} ${after ? after.status : 'offline'}`);
          renderFriends();
        }
        // Answer a "who" soon (spread out), at most once every 10 s per friend.
        if (msg.type === 'who' && settings.showOnline && state.pool) {
          const last = this.answered.get(friend.id) || 0;
          if (Date.now() - last > 10000) {
            this.answered.set(friend.id, Date.now());
            setTimeout(() => state.pool && state.pool.send(friend, { type: 'here', status: this.status() }), 300 + Math.random() * 2000);
          }
        }
        return true;
      }
      case 'invite':
        if (inCall() || $('#join').hidden) {
          if (state.pool) state.pool.send(friend, { type: 'busy', sid: msg.sid });
          return true;
        }
        if (!Rendezvous.normalizeLobbyCode(msg.code)) return true;
        showIncoming(friend, String(msg.sid || ''), { code: msg.code });
        return true;
      case 'accept':
      case 'decline':
      case 'busy': {
        const inv = this.invites.get(msg.sid);
        if (!inv) return false; // an answer to a call, not an invite
        inv.stop();
        if (msg.type === 'decline') toast(`${friend.name} can't join right now`);
        if (msg.type === 'busy') toast(`${friend.name} is in another call`);
        return true;
      }
      case 'cancel':
        if (state.ringIn && state.ringIn.sid === msg.sid && state.ringIn.code) {
          hideIncoming();
          return true;
        }
        return false;
    }
    return false;
  },

  // ---------------------------------------------------------------- invites
  // Asks a saved friend to join the lobby you're in: their app rings, and
  // "Join" enters the lobby with its code (sent encrypted, to them only).
  invite(friend) {
    const lobby = state.lobby;
    if (!lobby || !state.pool) return;
    for (const inv of this.invites.values()) if (inv.friend.id === friend.id) inv.stop();
    const sid = randomId();
    const send = () => state.pool && state.pool.send(friend, { type: 'invite', sid, code: lobby.code, name: state.name });
    const inv = {
      friend,
      timer: setInterval(() => { if (state.lobby === lobby) send(); else inv.stop(); }, 3000),
      stop: () => {
        clearInterval(inv.timer);
        clearTimeout(inv.giveUp);
        this.invites.delete(sid);
      },
    };
    inv.giveUp = setTimeout(() => {
      if (!this.invites.has(sid)) return;
      inv.stop();
      if (state.pool) state.pool.send(friend, { type: 'cancel', sid });
    }, 45000);
    this.invites.set(sid, inv);
    send();
    Log.info('lobby', 'invited a friend', { friend: friend.id.slice(0, 6) });
    toast(`Inviting ${friend.name}…`);
  },

  // The friends to invite, online ones first.
  openInviteMenu(e) {
    const label = (f) => {
      const p = this.presence.get(f.id);
      return `${f.name} · ${I18n.t(p ? (p.status === 'busy' ? 'in a call' : 'online') : 'offline')}`;
    };
    const rank = (f) => { const p = this.presence.get(f.id); return p ? (p.status === 'online' ? 0 : 1) : 2; };
    const list = [...Rendezvous.friends()].sort((a, b) => rank(a) - rank(b));
    if (!list.length) return toast('Saved friends show up here after your first call with them.');
    showVolumeMenu(e, { title: I18n.t('Invite a friend'), value: null, actions: list.map((f) => ({ label: label(f), run: () => this.invite(f) })) });
  },

  stopInvites() {
    for (const inv of [...this.invites.values()]) inv.stop();
  },
};

// ===================================================================
// In-game overlay (desktop app): a small always-on-top, click-through panel with
// the people in the call and who's talking. Fed from here ~8 times a second
// while it changes; the window itself is overlay.html.
// ===================================================================
const Overlay = {
  last: '',

  init() {
    const desk = window.miserecordDesktop;
    if (!desk || !desk.setOverlay) return;
    setInterval(() => this.push(), 120);
  },

  people() {
    const out = [];
    const level = (card) => Number(card.style.getPropertyValue('--level')) || 0;
    if (state.mic || state.mode) {
      const me = $('#meCard');
      out.push({ name: state.name || 'You', me: true, speaking: me ? level(me) > 0.08 : false, muted: !!state.muted, deafened: !!state.deafened });
    }
    for (const peer of state.peers.values()) {
      if (peer.pc.connectionState !== 'connected') continue;
      out.push({ name: peer.name, speaking: peer.card ? level(peer.card) > 0.08 : false, muted: !!peer.muted });
    }
    return out;
  },

  push() {
    const show = !!(settings.overlay && state.mode && isConnected());
    const data = show ? { corner: settings.overlayCorner, people: this.people() } : null;
    const text = JSON.stringify(data);
    if (text === this.last) return;
    this.last = text;
    window.miserecordDesktop.setOverlay(data);
  },
};
