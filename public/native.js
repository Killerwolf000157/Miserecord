// Native streaming in calls (see docs/native-engine.md): a screen share goes
// through miserecord-capture (capture + the graphics card's encoder) and the
// engine's video channel when the helper runs and everyone watching can decode
// its codec. Otherwise the share uses WebRTC exactly as before.
'use strict';

const Native = {
  caps: null,      // { adapter, codecs } from the helper's probe
  fanout: null,    // the running share's sender
  info: null,      // the helper's "ready" event: codec, encoder, size, fps
  streamId: null,
  readyWaiter: null,

  async init() {
    Engine.decodable().then((codecs) => {
      state.engineDecode = codecs;
      // People already connected learn what we can show.
      broadcast({ type: 'engine-hello', codecs });
    });
    const desk = window.miserecordDesktop;
    if (!desk || !desk.engineProbe) return;
    this.arrived = 0;
    desk.onEngineFrame((f) => { this.arrived++; if (this.fanout) this.fanout.push(f); });
    desk.onEngineEvent((ev) => this.onEvent(ev));
    try {
      this.caps = await desk.engineProbe();
      Log.info('engine', 'native helper', this.caps);
    } catch (err) {
      Log.warn('engine', 'native helper unavailable', err);
    }
  },

  // The codec to use: one this graphics card encodes and everyone connected can
  // decode, best first. Null means: use WebRTC for this share.
  pickCodec() {
    if (!settings.engine || !this.caps || !(this.caps.codecs || []).length) return null;
    const peers = [...state.peers.values()].filter((p) => p.pc.connectionState === 'connected');
    if (!peers.length) return null;
    for (const c of this.caps.codecs) {
      if (peers.every((p) => (p.engineDecode || []).includes(c))) return c;
    }
    return null;
  },

  async start(streamId) {
    const codec = this.pickCodec();
    if (!codec) return false;
    const desk = window.miserecordDesktop;
    const level = LEVELS[ceilingLevel()];
    const cap = VIDEO_BITRATE[settings.videoQuality] || 20e6;
    const startRate = Math.min(cap, level.mbps * 1.5e6);
    const ready = new Promise((resolve) => {
      this.readyWaiter = resolve;
      setTimeout(() => resolve(null), 6000);
    });
    const r = await desk.engineStart({ codec, width: Math.round((level.h * 16) / 9), height: level.h, fps: level.fps, bitrate: Math.round(startRate) });
    if (!r || !r.ok) { Log.warn('engine', 'native share not started', r && r.reason); return false; }
    const info = await ready;
    this.readyWaiter = null;
    if (!info) { desk.engineStop(); Log.warn('engine', 'native helper did not get ready'); return false; }
    this.info = info;
    this.streamId = streamId;
    this.fanout = Engine.createFanout({
      number: 1,
      config: { id: streamId, codec: info.codec, width: info.width, height: info.height },
      startRate,
      maxRate: cap,
      sendTo,
      setRate: (bps) => desk.engineControl(`bitrate ${bps}`),
      wantKey: () => desk.engineControl('key'),
    });
    for (const peer of state.peers.values()) this.addViewer(peer);
    Log.info('engine', 'native share started', { codec: info.codec, encoder: info.encoder, size: `${info.width}x${info.height}`, capture: info.capture, priority: info.priority });
    return true;
  },

  addViewer(peer) {
    if (!this.fanout || !peer.engineDc || peer.pc.connectionState !== 'connected') return;
    if (!(peer.engineDecode || []).includes(this.info.codec)) {
      Log.warn('engine', 'a viewer cannot show this native share', { peer: peer.id.slice(0, 6), codec: this.info.codec });
      return;
    }
    this.fanout.addViewer(peer, peer.engineDc);
  },

  removeViewer(peer) {
    if (this.fanout) this.fanout.removeViewer(peer.id);
  },

  stop() {
    if (this.fanout) this.fanout.stop();
    this.fanout = null;
    this.info = null;
    this.streamId = null;
    const desk = window.miserecordDesktop;
    if (desk && desk.engineStop) desk.engineStop();
  },

  onEvent(ev) {
    if (ev.event === 'ready' && this.readyWaiter) { this.readyWaiter(ev); return; }
    if (ev.event === 'stats' && this.fanout && this.info) {
      const f = this.fanout.stats();
      const want = this.info.fps;
      // What viewers see in Stream info, as for a WebRTC share.
      state.sendStats = {
        size: `${this.info.width}×${this.info.height}`,
        capture: ev.captureFps,
        sent: ev.encodeFps,
        codec: this.info.codec,
        gpu: true,
        auto: true,
        level: `${this.info.height}p ${want} fps`,
        upload: Math.round(f.rate / 1e5) / 10,
        diagnosis: ev.encodeFps >= want * 0.85 ? 'ok' : ev.captureFps < want * 0.6 ? 'still' : 'encoder',
        engine: `${this.info.encoder} · ${this.info.capture}`,
      };
      broadcast({ type: 'stream-stats', id: this.streamId, stats: state.sendStats });
      if (document.querySelector('.stream-info')) refreshStreamInfo().catch(() => {});
      const pushedFps = this.lastPushed != null ? f.frames - this.lastPushed : null;
      this.lastPushed = f.frames;
      const buffered = Math.max(0, ...[...state.peers.values()].map((p) => (p.engineDc ? p.engineDc.bufferedAmount : 0)));
      Log.info('stats', 'native video', { buffered, capture: ev.captureFps, encoded: ev.encodeFps, pushed: pushedFps, arrived: this.arrived, mbps: ev.mbps, rate: f.rate, viewers: f.viewers, skipped: f.skipped, encodeMs: ev.encodeMs });
      this.arrived = 0;
      return;
    }
    if ((ev.event === 'error' || ev.event === 'exit') && this.fanout) {
      Log.warn('engine', 'native helper stopped', ev);
      toast("The native streaming engine stopped, so your share ended. Share again to use the standard stream.", 'err');
      stopLocal('screen');
    }
  },
};

// ---------------------------------------------------------------- viewer side
function engineReceiver(peer) {
  if (!peer.engineRx) {
    peer.engineRx = Engine.createReceiver({
      dc: peer.engineDc,
      send: (m) => sendTo(peer, m),
      onTrack: (track, cfg) => attachEngineTrack(peer, String(cfg.id), track),
      onEnd: (cfg) => detachEngineTrack(peer, String(cfg.id)),
    });
  }
  return peer.engineRx;
}

// The decoded video joins the stream's entry (with its WebRTC sound, if any), so
// it shows in a normal stream tile.
function attachEngineTrack(peer, id, track) {
  let entry = peer.remote.get(id);
  if (!entry) { entry = { stream: new MediaStream() }; peer.remote.set(id, entry); }
  entry.stream.addTrack(track);
  entry.engineTrack = track;
  if (entry.tile) entry.tile.video.srcObject = entry.stream;
  Log.info('engine', 'native stream arriving', { peer: peer.id.slice(0, 6) });
  renderRemoteStream(peer, id);
}

function detachEngineTrack(peer, id) {
  const entry = peer.remote.get(id);
  if (!entry || !entry.engineTrack) return;
  entry.stream.removeTrack(entry.engineTrack);
  entry.engineTrack = null;
  if (!entry.stream.getTracks().length) removeRemoteStream(peer, id);
  else renderRemoteStream(peer, id);
}

function onEngineMessage(peer, msg) {
  switch (msg.type) {
    case 'engine-hello':
      peer.engineDecode = Array.isArray(msg.codecs) ? msg.codecs.filter((c) => c in Engine.CODECS) : [];
      Native.addViewer(peer); // someone joined a native share in progress
      break;
    case 'engine-config':
    case 'engine-end':
      engineReceiver(peer).onControl(msg);
      break;
    case 'engine-feedback':
    case 'engine-keyframe':
      if (Native.fanout) Native.fanout.onControl(peer, msg);
      break;
  }
}
