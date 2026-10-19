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
    // Start where this computer can (the specs scan), never above Settings.
    this.ceiling = ceilingLevel();
    this.level = settings.adaptive && Specs.info ? Math.max(this.ceiling, Specs.info.start) : this.ceiling;
    this.bad = 0; this.good = 0; this.slow = 0; this.holdUp = false; this.changedAt = performance.now(); this.upAt = 0;
    const level = LEVELS[this.level];
    // The native engine goes higher on the default "High" (35 instead of 20 Mbps):
    // 1440p60 game footage still gains visibly there, and congestion control keeps
    // the stream to what the line really carries.
    const cap = settings.videoQuality === 'veryhigh' ? 35e6 : VIDEO_BITRATE[settings.videoQuality] || 20e6;
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

  // The ladder (LEVELS in adapt.js), once a second from the helper's numbers:
  // down a level when the line only carries 60% of what this size needs (the
  // congestion control has already lowered the bitrate to what gets through),
  // or when the encoder can't keep up; up again after 15 s with room for the
  // next level. Changes are 6 s apart, and a level that failed right after
  // going up isn't tried again during this share.
  adapt(ev) {
    if (!settings.adaptive || this.level == null) return;
    const now = performance.now();
    const rate = this.fanout.stats().rate;
    const fps = LEVELS[this.level].fps;
    const need = LEVELS[this.level].mbps * 1e6;
    const starved = rate < need * 0.6;
    const slowEncoder = ev.captureFps >= fps * 0.8 && ev.encodeFps < fps * 0.75;
    this.diagnosis = starved ? 'bandwidth' : slowEncoder ? 'encoder' : ev.encodeFps >= fps * 0.85 ? 'ok' : 'still';
    this.bad = starved ? this.bad + 1 : 0;
    this.slow = slowEncoder ? this.slow + 1 : 0;
    const roomUp = this.level > this.ceiling && rate >= LEVELS[this.level - 1].mbps * 1e6 * 1.25;
    this.good = !starved && !slowEncoder && roomUp ? this.good + 1 : 0;
    if (now - this.changedAt < 6000) return;
    if ((this.bad >= 3 || this.slow >= 4) && this.level < LEVELS.length - 1) {
      if (this.upAt && now - this.upAt < 20000) this.holdUp = true;
      this.setLevel(this.level + 1, this.bad >= 3 ? `only ${(rate / 1e6).toFixed(1)} Mbps gets through` : 'the encoder is behind');
    } else if (this.good >= 15 && !this.holdUp) {
      this.upAt = now;
      this.setLevel(this.level - 1, 'room for more');
    }
  },

  setLevel(i, why) {
    this.level = i;
    this.bad = 0; this.good = 0; this.slow = 0;
    this.changedAt = performance.now();
    const l = LEVELS[i];
    Log.info('engine', `native stream ${levelName(i)}`, why);
    window.miserecordDesktop.engineControl(`size ${Math.round((l.h * 16) / 9)} ${l.h} ${l.fps}`);
  },

  onEvent(ev) {
    if (ev.event === 'ready' && this.readyWaiter) { this.readyWaiter(ev); return; }
    if (ev.event === 'resized' && this.fanout && this.info) {
      Object.assign(this.info, { width: ev.width, height: ev.height, fps: ev.fps });
      this.fanout.reconfigure({ width: ev.width, height: ev.height });
      return;
    }
    if (ev.event === 'stats' && this.fanout && this.info) {
      this.adapt(ev);
      const f = this.fanout.stats();
      const want = this.info.fps;
      // What viewers see in Stream info, as for a WebRTC share.
      state.sendStats = {
        size: `${this.info.width}×${this.info.height}`,
        capture: ev.captureFps,
        sent: ev.encodeFps,
        codec: this.info.codec,
        gpu: true,
        auto: !!settings.adaptive,
        level: levelName(this.level),
        upload: Math.round(f.rate / 1e5) / 10,
        diagnosis: this.diagnosis || 'ok',
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
// Sound and picture in step: the stream's sound waits in WebRTC's jitter buffer
// before it plays; native video waits the same time (plus the ~20 ms its own
// pipeline is quicker), at least 50 ms so frames come out evenly. Every 2 s.
async function syncEngineStreams() {
  for (const peer of state.peers.values()) {
    if (!peer.engineRx || peer.pc.connectionState !== 'connected') continue;
    const list = peer.engineRx.streamsInfo();
    if (!list.length) continue;
    const stats = await peer.pc.getStats().catch(() => null);
    for (const info of list) {
      const entry = peer.remote.get(info.id);
      const audio = entry && entry.stream.getAudioTracks()[0];
      let target = 50;
      if (audio && stats) {
        stats.forEach((r) => {
          if (r.type !== 'inbound-rtp' || r.kind !== 'audio' || r.trackIdentifier !== audio.id) return;
          const prev = entry.audioJb;
          entry.audioJb = { delay: r.jitterBufferDelay, count: r.jitterBufferEmittedCount };
          if (prev && r.jitterBufferEmittedCount > prev.count) {
            const ms = ((r.jitterBufferDelay - prev.delay) / (r.jitterBufferEmittedCount - prev.count)) * 1000;
            target = Math.max(50, ms + 20);
          } else if (r.jitterBufferEmittedCount) {
            target = Math.max(50, (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000 + 20);
          }
        });
      }
      peer.engineRx.setTargetDelay(info.number, target);
    }
  }
}

function engineReceiver(peer) {
  if (!peer.engineRx) {
    peer.engineRx = Engine.createReceiver({
      dc: peer.engineDc,
      send: (m) => sendTo(peer, m),
      onTrack: (track, cfg) => attachEngineTrack(peer, String(cfg.id), track),
      onEnd: (cfg) => detachEngineTrack(peer, String(cfg.id)),
      enhance: () => settings.enhance,
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
