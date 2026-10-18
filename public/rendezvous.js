// Miserecord rendezvous: lets two saved friends find each other again
// without swapping codes, using public Nostr relays as a meeting point.
//
// What the relays see: encrypted blobs under a topic that changes daily,
// the time, and your IP address. They never see names, connection info,
// audio, video, chat or files. Messages use "ephemeral" events, which relays
// forward to whoever is listening and don't store.
//
// Crypto, all built on the browser's Web Crypto API:
//   - Each device has an ECDH P-256 identity key, kept in localStorage.
//   - After the first call (made with copy-paste codes), the two devices
//     swap public keys over the direct, encrypted WebRTC connection and
//     derive a shared secret. That secret gives the AES-GCM key for relay
//     messages and the daily topic name.
//   - Nostr requires every event to carry a BIP-340 Schnorr signature
//     (secp256k1). Each session signs with a throwaway key, so events
//     can't be linked to you across sessions.
'use strict';

const Rendezvous = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtle = crypto.subtle;

  const log = (level, msg, data) => { if (typeof Log !== 'undefined') Log[level]('relay', msg, data); };

  const EVENT_KIND = 25050; // ephemeral range (20000–29999): relays don't store it
  const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social'];

  // ---------------------------------------------------------------- bytes
  const concat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
  const toB64 = (b) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
  const bigToBytes = (n) => fromHex(n.toString(16).padStart(64, '0'));
  const sha256 = async (b) => new Uint8Array(await subtle.digest('SHA-256', b));

  // ---------------------------------------------------------------- secp256k1 / BIP-340
  const P = 2n ** 256n - 0x1000003D1n;
  const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const G = {
    x: 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
    y: 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n,
  };
  const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
  function invert(a, m = P) {
    let [r0, r1] = [mod(a, m), m];
    let [s0, s1] = [1n, 0n];
    while (r1 !== 0n) {
      const q = r0 / r1;
      [r0, r1] = [r1, r0 - q * r1];
      [s0, s1] = [s1, s0 - q * s1];
    }
    return mod(s0, m);
  }
  // Jacobian coordinates; null is the point at infinity.
  function jDouble(p) {
    if (!p || p.y === 0n) return null;
    const A = mod(p.x * p.x), B = mod(p.y * p.y), C = mod(B * B);
    const D = mod(2n * (mod((p.x + B) ** 2n) - A - C));
    const E = mod(3n * A), F = mod(E * E);
    const x = mod(F - 2n * D);
    return { x, y: mod(E * (D - x) - 8n * C), z: mod(2n * p.y * p.z) };
  }
  function jAdd(p, q) {
    if (!p) return q;
    if (!q) return p;
    const Z1Z1 = mod(p.z * p.z), Z2Z2 = mod(q.z * q.z);
    const U1 = mod(p.x * Z2Z2), U2 = mod(q.x * Z1Z1);
    const S1 = mod(p.y * q.z * Z2Z2), S2 = mod(q.y * p.z * Z1Z1);
    const H = mod(U2 - U1), r = mod(2n * (S2 - S1));
    if (H === 0n) return r === 0n ? jDouble(p) : null;
    const I = mod((2n * H) ** 2n), J = mod(H * I), V = mod(U1 * I);
    const x = mod(r * r - J - 2n * V);
    return { x, y: mod(r * (V - x) - 2n * S1 * J), z: mod((mod((p.z + q.z) ** 2n) - Z1Z1 - Z2Z2) * H) };
  }
  function mulG(k) {
    let result = null;
    let addend = { x: G.x, y: G.y, z: 1n };
    while (k > 0n) {
      if (k & 1n) result = jAdd(result, addend);
      addend = jDouble(addend);
      k >>= 1n;
    }
    const zi = invert(result.z), zi2 = mod(zi * zi);
    return { x: mod(result.x * zi2), y: mod(result.y * zi2 * zi) };
  }
  async function taggedHash(tag, ...msgs) {
    const t = await sha256(enc.encode(tag));
    return sha256(concat(t, t, ...msgs));
  }
  // BIP-340 Schnorr signature over a 32-byte message.
  async function schnorrSign(msg, secret, aux = crypto.getRandomValues(new Uint8Array(32))) {
    const pub = mulG(secret);
    const d = pub.y % 2n === 0n ? secret : N - secret;
    const px = bigToBytes(pub.x);
    const t = bigToBytes(d ^ bytesToBig(await taggedHash('BIP0340/aux', aux)));
    const k0 = mod(bytesToBig(await taggedHash('BIP0340/nonce', t, px, msg)), N);
    if (k0 === 0n) throw new Error('bad nonce');
    const R = mulG(k0);
    const k = R.y % 2n === 0n ? k0 : N - k0;
    const rx = bigToBytes(R.x);
    const e = mod(bytesToBig(await taggedHash('BIP0340/challenge', rx, px, msg)), N);
    return concat(rx, bigToBytes(mod(k + e * d, N)));
  }
  function newNostrKey() {
    let sk = 0n;
    while (sk === 0n || sk >= N) sk = bytesToBig(crypto.getRandomValues(new Uint8Array(32)));
    return { sk, pk: toHex(bigToBytes(mulG(sk).x)) };
  }

  // ---------------------------------------------------------------- identity & friends
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(`miserecord.${key}`)); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(`miserecord.${key}`, JSON.stringify(value)); } catch { /* storage off */ } },
  };

  let identityPromise = null;
  function identity() {
    identityPromise ||= (async () => {
      let saved = store.get('identity');
      if (!saved) {
        const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        saved = {
          pub: await subtle.exportKey('jwk', pair.publicKey),
          priv: await subtle.exportKey('jwk', pair.privateKey),
        };
        store.set('identity', saved);
      }
      const priv = await subtle.importKey('jwk', saved.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const pub = { kty: saved.pub.kty, crv: saved.pub.crv, x: saved.pub.x, y: saved.pub.y };
      return { pub, priv, id: await keyId(pub) };
    })();
    return identityPromise;
  }

  async function keyId(jwk) {
    return toHex(await sha256(enc.encode(`${jwk.x}.${jwk.y}`))).slice(0, 16);
  }

  const friends = () => store.get('friends') || [];
  const saveFriends = (list) => store.set('friends', list);

  // Called once the direct connection is up and the friend sent their public key.
  async function pair(theirPub, name) {
    if (!theirPub || theirPub.kty !== 'EC' || theirPub.crv !== 'P-256') throw new Error('bad key');
    const me = await identity();
    const id = await keyId(theirPub);
    if (typeof Log !== 'undefined') Log.info('pair', 'friend sent their key', { mine: me.id.slice(0, 6), theirs: id.slice(0, 6) });
    if (id === me.id) throw new Error('that is my own key');
    const theirKey = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: theirPub.x, y: theirPub.y }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await subtle.deriveBits({ name: 'ECDH', public: theirKey }, me.priv, 256);
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const derive = async (info) => new Uint8Array(await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('miserecord v1'), info: enc.encode(info) }, hkdf, 256));
    const list = friends();
    const existing = list.find((f) => f.id === id);
    const friend = {
      id,
      name: String(name || 'Friend').slice(0, 32),
      pub: { kty: 'EC', crv: 'P-256', x: theirPub.x, y: theirPub.y },
      key: toB64(await derive('message key')),
      topicSeed: toB64(await derive('topic seed')),
      added: existing ? existing.added : Date.now(),
      lastCall: Date.now(),
    };
    saveFriends([friend, ...list.filter((f) => f.id !== id)]);
    return { friend, isNew: !existing };
  }

  function touchFriend(id, patch) {
    saveFriends(friends().map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function removeFriend(id) {
    saveFriends(friends().filter((f) => f.id !== id));
  }

  // The topic changes every UTC day so relays can't link calls across days.
  // ---------------------------------------------------------------- lobbies
  // A lobby code is the secret: its topic and encryption key are derived from it,
  // so only people who have the code can find the lobby or read its messages.
  const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U

  function newLobbyCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const chars = Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join(''); // 16 × 5 bits = 80 bits
    return chars.match(/.{4}/g).join('-');
  }

  // Accepts pasted codes with spaces, lowercase, or easily confused letters.
  function normalizeLobbyCode(text) {
    const clean = String(text || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
    if (clean.length !== 16 || [...clean].some((c) => !CODE_ALPHABET.includes(c))) return null;
    return clean.match(/.{4}/g).join('-');
  }

  // A channel object shaped like a saved friend, so the relay pool can use it.
  async function lobbyChannel(code) {
    const hkdf = await subtle.importKey('raw', enc.encode(code), 'HKDF', false, ['deriveBits']);
    const derive = async (info) => new Uint8Array(await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('miserecord lobby v1'), info: enc.encode(info) }, hkdf, 256));
    return {
      id: `lobby:${toHex(await derive('lobby id')).slice(0, 12)}`,
      name: 'Lobby',
      key: toB64(await derive('message key')),
      topicSeed: toB64(await derive('topic seed')),
      lobby: true,
    };
  }

  async function topicFor(friend, dayOffset = 0) {
    const day = Math.floor(Date.now() / 86400000) + dayOffset;
    return toHex(await sha256(concat(fromB64(friend.topicSeed), enc.encode(`:${day}`)))).slice(0, 40);
  }

  const keyCache = new Map();
  async function aesKey(friend) {
    if (!keyCache.has(friend.id)) {
      keyCache.set(friend.id, await subtle.importKey('raw', fromB64(friend.key), 'AES-GCM', false, ['encrypt', 'decrypt']));
    }
    return keyCache.get(friend.id);
  }
  async function seal(friend, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(friend), enc.encode(JSON.stringify(obj))));
    return toB64(concat(iv, ct));
  }
  async function open(friend, text) {
    const raw = fromB64(text);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(friend), raw.slice(12));
    return JSON.parse(dec.decode(pt));
  }

  // ---------------------------------------------------------------- relay pool
  // Listens on every saved friend's topic and delivers decrypted messages.
  class Pool {
    constructor(urls, onMessage, onStatus) {
      this.urls = urls.length ? urls : DEFAULT_RELAYS;
      this.onMessage = onMessage;
      this.onStatus = onStatus || (() => {});
      this.sockets = new Map();
      this.seen = new Set();
      this.nostr = newNostrKey();
      this.topics = new Map(); // topic -> friend
      this.closed = false;
      this.extra = []; // lobby channels
      this.subId = toHex(crypto.getRandomValues(new Uint8Array(8)));
      this.loggedRings = new Set();
    }

    async start() {
      await this.refreshTopics();
      for (const url of this.urls) this.connect(url);
      // Pick up a new day's topic shortly after midnight UTC.
      this.topicTimer = setInterval(() => this.refreshTopics(true), 10 * 60 * 1000);
    }

    async refreshTopics(resubscribe) {
      const map = new Map();
      for (const f of [...friends(), ...this.extra]) {
        for (const off of [-1, 0, 1]) map.set(await topicFor(f, off), f);
      }
      this.topics = map;
      if (resubscribe) for (const ws of this.sockets.values()) this.subscribe(ws);
    }

    connected() {
      return [...this.sockets.values()].filter((ws) => ws.readyState === WebSocket.OPEN).length;
    }

    connect(url) {
      if (this.closed) return;
      let ws;
      const host = url.replace(/^wss:\/\//, '');
      try { ws = new WebSocket(url); } catch (err) {
        log('warn', `could not open ${host}`, err);
        return;
      }
      this.sockets.set(url, ws);
      ws.onopen = () => {
        log('info', `connected to ${host}`);
        this.subscribe(ws);
        this.onStatus(this.connected());
      };
      ws.onmessage = (e) => this.onRelayMessage(e.data, host);
      ws.onclose = (e) => {
        if (!this.closed) log('warn', `disconnected from ${host}`, { code: e.code, reason: e.reason || '' });
        this.onStatus(this.connected());
        if (!this.closed) setTimeout(() => this.connect(url), 5000 + Math.random() * 5000);
      };
      ws.onerror = () => log('warn', `socket error on ${host}`);
    }

    subscribe(ws) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const topics = [...this.topics.keys()];
      if (!topics.length) return;
      log('info', 'subscribing', { topics: topics.length });
      ws.send(JSON.stringify(['REQ', this.subId, { kinds: [EVENT_KIND], '#t': topics, since: Math.floor(Date.now() / 1000) - 30 }]));
    }

    async onRelayMessage(data, host) {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      // Relay replies worth knowing about: rejected events, notices, closed subscriptions.
      if (msg[0] === 'OK' && msg[2] === false) return log('warn', `${host} rejected a message`, String(msg[3] || ''));
      if (msg[0] === 'NOTICE') return log('warn', `${host} notice`, String(msg[1] || ''));
      if (msg[0] === 'CLOSED') return log('warn', `${host} closed the subscription`, String(msg[2] || ''));
      if (msg[0] === 'EOSE') return log('info', `${host} subscription active`);
      if (msg[0] !== 'EVENT' || !msg[2]) return;
      const ev = msg[2];
      if (this.seen.has(ev.id)) return; // the same event arrives once per relay
      this.seen.add(ev.id);
      if (ev.pubkey === this.nostr.pk) return; // our own message, echoed back
      const tag = (ev.tags || []).find((t) => t[0] === 't');
      const friend = tag && this.topics.get(tag[1]);
      if (!friend) return;
      let body;
      try {
        body = await open(friend, ev.content);
      } catch {
        // Wrong key: e.g. the friend was removed and re-added on only one side.
        return log('warn', `message on ${friend.id.slice(0, 6)}'s topic could not be decrypted`, { via: host });
      }
      const skew = body && typeof body.ts === 'number' ? Math.round((Date.now() - body.ts) / 1000) : null;
      if (skew === null || Math.abs(skew) > 90) {
        return log('warn', 'dropped a stale message (check both computers\' clocks)', { type: body && body.type, skewSeconds: skew, via: host });
      }
      log('info', `got ${body.type}`, { via: host, ageSeconds: skew });
      this.onMessage(friend, body);
    }

    async send(friend, body) {
      const content = await seal(friend, { ...body, ts: Date.now() });
      const ev = {
        pubkey: this.nostr.pk,
        created_at: Math.floor(Date.now() / 1000),
        kind: EVENT_KIND,
        tags: [['t', await topicFor(friend)]],
        content,
      };
      const id = await sha256(enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])));
      ev.id = toHex(id);
      ev.sig = toHex(await schnorrSign(id, this.nostr.sk));
      this.seen.add(ev.id);
      const frame = JSON.stringify(['EVENT', ev]);
      let sent = 0;
      for (const ws of this.sockets.values()) {
        if (ws.readyState === WebSocket.OPEN) { ws.send(frame); sent++; }
      }
      // Rings repeat every few seconds; log only the first of each call.
      if (body.type !== 'ring' || !this.loggedRings.has(body.sid)) {
        if (body.type === 'ring') this.loggedRings.add(body.sid);
        log(sent ? 'info' : 'error', `sent ${body.type}${body.type === 'ring' ? ' (repeats every 3 s)' : ''}`, { relays: sent, bytes: frame.length });
      }
      return sent;
    }

    async addChannel(channel) {
      this.extra = [...this.extra.filter((c) => c.id !== channel.id), channel];
      await this.refreshTopics(true);
    }

    async removeChannel(channel) {
      this.extra = this.extra.filter((c) => c.id !== channel.id);
      await this.refreshTopics(true);
    }

    close() {
      this.closed = true;
      clearInterval(this.topicTimer);
      for (const ws of this.sockets.values()) {
        try { ws.close(); } catch { /* already closed */ }
      }
      this.sockets.clear();
    }
  }

  return {
    DEFAULT_RELAYS, identity, pair, friends, touchFriend, removeFriend, Pool, keyId,
    newLobbyCode, normalizeLobbyCode, lobbyChannel,
    // exposed for tests
    _test: { schnorrSign, mulG, toHex, fromHex, bytesToBig },
  };
})();
