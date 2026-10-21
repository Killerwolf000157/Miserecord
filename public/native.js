// Native streaming in calls (see docs/native-engine.md): a screen share goes
// through miserecord-capture (capture + the graphics card's encoder) and the
// engine's video channel when the helper runs and everyone watching can decode
// its codec. Otherwise the share uses WebRTC exactly as before.
'use strict';

// The small layer's sizes (Native.chooseLayers), with what each spends.
const LOW_SIZES = [
  { w: 640, h: 360, mbps: 0.6 },
  { w: 960, h: 540, mbps: 1.2 },
  { w: 1280, h: 720, mbps: 2 },
];

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
      for (const peer of state.peers.values()) Lanes.open(peer);
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
      setLowRate: (bps) => desk.engineControl(`lowbitrate ${bps}`),
      wantKey: (layer) => desk.engineControl(layer ? 'lowkey' : 'key'),
      // Every viewer waits this long anyway: the encoder may spread bits over it.
      // Settled for a second first: a viewer joining says its delay right after, and
      // each change restarts the encoder.
      // Longer waits are used after a second; shorter ones after 10 s, since a
      // viewer's automatic delay often dips and comes back.
      onDelay: (ms) => {
        clearTimeout(this.delayTimer);
        const up = ms > (this.bufferMs || 0);
        this.delayTimer = setTimeout(() => {
          this.bufferMs = ms;
          desk.engineControl(`buffer ${ms}`);
          Log.info('engine', 'viewers delay', { ms });
        }, up ? 1000 : 10000);
      },
    });
    this.low = null; this.lowOn = null; this.lowFailed = false; this.netTicks = 0;
    for (const peer of state.peers.values()) this.addViewer(peer);
    Log.info('engine', 'native share started', { codec: info.codec, encoder: info.encoder, size: `${info.width}x${info.height}`, capture: info.capture, priority: info.priority, copy: info.copy });
    return true;
  },

  addViewer(peer) {
    if (!this.fanout || !peer.engineDc || peer.pc.connectionState !== 'connected') return;
    if (!(peer.engineDecode || []).includes(this.info.codec)) {
      Log.warn('engine', 'a viewer cannot show this native share', { peer: peer.id.slice(0, 6), codec: this.info.codec });
      return;
    }
    this.fanout.addViewer(peer, peer.engineDc);
    for (const dc of Lanes.ready(peer)) this.fanout.addLane(peer.id, dc); // more lanes, each with its own congestion window
    // They may have said how they show it before the share reached them.
    const view = peer.views && peer.views.get(this.streamId);
    if (view) this.fanout.setView(peer.id, view);
    this.chooseLayers();
  },

  // A viewer's view report (app.js onStreamView). Hidden viewers are paused;
  // viewers who show the stream small get the small layer.
  setView(peer, view) {
    if (!this.fanout) return;
    this.fanout.setView(peer.id, view);
    this.chooseLayers();
  },

  removeViewer(peer) {
    if (!this.fanout) return;
    this.fanout.removeViewer(peer.id);
    this.chooseLayers();
  },

  // The small layer: one second encode, as big as the largest small view needs
  // (360p, 540p or 720p at 30 fps), for every viewer who shows the stream at
  // most 60% of the main layer's height. It runs only while someone needs it,
  // and stops 10 s after the last one. If the graphics card can't run a second
  // encode, everyone stays on the main layer, as before.
  chooseLayers() {
    if (!this.fanout || !this.info) return;
    const mainH = this.info.height;
    const small = [];
    for (const peer of state.peers.values()) {
      const view = peer.views && peer.views.get(this.streamId);
      if (view && !view.hidden && !view.full && view.h > 0 && view.h <= mainH * 0.6) small.push({ peer, h: view.h });
    }
    const need = small.length ? Math.max(...small.map((x) => x.h)) : 0;
    const size = need ? LOW_SIZES.find((s) => s.h >= need) || LOW_SIZES[LOW_SIZES.length - 1] : null;
    const useful = size && !this.lowFailed && size.h <= mainH * 0.75;
    const desk = window.miserecordDesktop;
    if (useful) {
      clearTimeout(this.lowOffTimer);
      this.lowOffTimer = null;
      if (!this.low || this.low.h !== size.h) {
        this.low = size;
        this.lowOn = null;
        const fps = Math.min(30, this.info.fps);
        desk.engineControl(`low ${size.w} ${size.h} ${fps} ${Math.round(size.mbps * 1e6)}`);
        this.fanout.setLowWant(size.mbps * 1e6);
        Log.info('engine', 'small layer', { size: `${size.h}p`, viewers: small.length });
      }
    } else if (this.low && !this.lowOffTimer) {
      this.lowOffTimer = setTimeout(() => {
        this.lowOffTimer = null;
        if (!this.fanout) return;
        this.low = null;
        this.lowOn = null;
        desk.engineControl('low off');
        Log.info('engine', 'small layer off');
      }, 10000);
    }
    const ready = useful && this.lowOn === size.h;
    for (const peer of state.peers.values()) {
      const isSmall = small.some((x) => x.peer === peer);
      this.fanout.setLayer(peer.id, ready && isSmall ? 1 : 0);
    }
  },

  stop() {
    clearTimeout(this.lowOffTimer);
    this.lowOffTimer = null;
    this.low = null;
    this.lowOn = null;
    if (this.fanout) this.fanout.stop();
    this.fanout = null;
    this.info = null;
    this.streamId = null;
    clearTimeout(this.delayTimer);
    this.bufferMs = 0;
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
    // A viewer's computer can't decode this size this fast (its decoder has
    // been behind for 3 s): a smaller size or frame rate helps it, a lower
    // bitrate doesn't.
    const viewerSlow = this.fanout.slowDecoders() > 0;
    // Behind only when the helper really skipped frames because every texture was
    // still waiting on the graphics card (busyDrops), two seconds running: a gap
    // between captured and encoded counts alone also happens for a second after
    // each size change and isn't a problem. The encoder chip itself is rarely the
    // limit; a game holding the whole graphics card is.
    const busy = typeof ev.busyDrops === 'number' ? ev.busyDrops >= fps * 0.1 : ev.captureFps >= fps * 0.8 && ev.encodeFps < fps * 0.75;
    const settled = now - this.changedAt > 2000;
    this.busySecs = busy && settled ? (this.busySecs || 0) + 1 : 0;
    const slowEncoder = this.busySecs >= 2;
    this.diagnosis = starved ? 'bandwidth' : slowEncoder ? 'gpu' : viewerSlow ? 'viewer' : ev.encodeFps >= fps * 0.85 ? 'ok' : 'still';
    this.bad = starved ? this.bad + 1 : 0;
    this.slow = slowEncoder || viewerSlow ? this.slow + 1 : 0;
    const roomUp = this.level > this.ceiling && rate >= LEVELS[this.level - 1].mbps * 1e6 * 1.25;
    this.good = !starved && !slowEncoder && !viewerSlow && roomUp ? this.good + 1 : 0;
    if (now - this.changedAt < 6000) return;
    // Viewers a second or more behind absorb dips in their buffer: give the line
    // longer before giving up resolution.
    const patience = (this.bufferMs || 0) >= 1000 ? 6 : 3;
    if ((this.bad >= patience || this.slow >= 4) && this.level < LEVELS.length - 1) {
      if (this.upAt && now - this.upAt < 20000) this.holdUp = true;
      this.setLevel(this.level + 1, this.bad >= patience ? `only ${(rate / 1e6).toFixed(1)} Mbps gets through` : viewerSlow ? "a viewer's computer can't decode it this fast" : 'the graphics card is busy');
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
    if (ev.event === 'low' && this.fanout) {
      if (ev.on) this.lowOn = this.low ? this.low.h : null; // the helper answers commands in order
      else if (ev.reason) { this.lowFailed = true; this.low = null; Log.warn('engine', 'no small layer', ev.reason); }
      this.chooseLayers();
      return;
    }
    if (ev.event === 'resized') Log.info('engine', 'helper rebuilt its encoder', ev);
    if (ev.event === 'resized' && this.fanout && this.info) {
      Object.assign(this.info, { width: ev.width, height: ev.height, fps: ev.fps });
      this.fanout.reconfigure({ width: ev.width, height: ev.height });
      this.chooseLayers(); // the line between small and big moved
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
      // Each viewer gets its own network numbers, so the viewer's log shows the
      // sender's side too (send me your log covers both ends).
      const nets = {};
      for (const peer of state.peers.values()) {
        const net = this.fanout.viewerNet(peer.id);
        if (!net) continue;
        nets[peer.id.slice(0, 6)] = net;
        sendTo(peer, { type: 'engine-net', stream: 1, encMbps: ev.mbps, capture: ev.captureFps, encoded: ev.encodeFps, level: levelName(this.level), size: `${this.info.width}x${this.info.height}`, ...net });
      }
      if (++this.netTicks % 5 === 0) Log.info('stats', 'native video per viewer', nets);
      if (document.querySelector('.stream-info')) refreshStreamInfo().catch(() => {});
      const pushedFps = this.lastPushed != null ? f.frames - this.lastPushed : null;
      this.lastPushed = f.frames;
      const buffered = Math.max(0, ...[...state.peers.values()].map((p) => (p.engineDc ? p.engineDc.bufferedAmount : 0)));
      Log.info('stats', 'native video', { lanes: this.fanout.lanesNow(), buffered, maxLoopMs: ev.maxLoopMs, maxPushMs: ev.maxPushMs, capture: ev.captureFps, encoded: ev.encodeFps, pushed: pushedFps, arrived: this.arrived, mbps: ev.mbps, rate: f.rate, viewers: f.viewers, skipped: f.skipped, encodeMs: ev.encodeMs });
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
    // Stream delay (settings): frames are held back this long, and so is the sound;
    // 'auto' lets each stream find the least that keeps it smooth (engine.js).
    peer.engineRx.setDelay(settings.streamDelay === 'auto' ? 'auto' : Math.max(0, Math.min(3000, Number(settings.streamDelay) || 0)));
    const list = peer.engineRx.streamsInfo();
    if (!list.length) continue;
    const stats = await pcStats(peer.pc).catch(() => null);
    for (const info of list) {
      const delay = info.delay || 0;
      const entry = peer.remote.get(info.id);
      const audio = entry && entry.stream.getAudioTracks()[0];
      let target = 50;
      if (audio) {
        const rx = peer.pc.getReceivers().find((r) => r.track && r.track.id === audio.id);
        if (rx && 'jitterBufferTarget' in rx && rx.jitterBufferTarget !== delay) {
          try { rx.jitterBufferTarget = delay; } catch { /* not supported */ }
        }
      }
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
      // The held frames already wait (delay - 100 ms) of it.
      peer.engineRx.setTargetDelay(info.number, delay ? target - (delay - 100) : target);
    }
  }
}

// ---------------------------------------------------------------- video lanes
// One data channel carries little over a line that loses packets: its
// congestion control halves its window at every loss, like one TCP connection.
// Measured through a relay with a 50 ms round trip: 39 Mbps with no loss, but
// 2.6 Mbps at 1% loss and 1.7 at 2% (what a friend's 40 Mbps upload gave the
// stream). Several connections side by side add up, as in a speed test (1%
// loss: 4.1 Mbps with 2, 8.6 with 4), so the sharer opens extra lanes to each
// viewer: small peer connections with one video channel each, set up over the
// call's own channel. Older versions don't answer and keep the one channel.
const LANES = 9; // plus the main video channel: 10
// The lanes are opened once per call, as soon as both sides can show native
// streams, by one side (the impolite one, so two offers never cross), one every
// 200 ms: opening all nine at once gathered hundreds of network candidates and
// stalled the app's main process for ~2 s, which froze a running stream. Each
// lane carries video both ways, so either side can share over it later.
const Lanes = {
  open(peer) {
    if (peer.polite || peer.lanesOpening) return;
    if (!(peer.engineDecode || []).length || !(state.engineDecode || []).length) return;
    peer.lanesOpening = true;
    peer.lanes ||= [];
    let n = peer.lanes.length;
    const next = () => {
      if (n >= LANES || state.peers.get(peer.id) !== peer) return;
      this.offer(peer, n++);
      setTimeout(next, 200);
    };
    next();
  },

  async offer(peer, n) {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const dc = Engine.channel(pc);
    const lane = { n, pc, dc };
    peer.lanes.push(lane);
    this.watch(peer, lane, 'offered');
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      sendTo(peer, { type: 'engine-lane', n, sdp: pc.localDescription.sdp });
    } catch (err) {
      Log.warn('engine', 'video lane not offered', err);
    }
  },

  // The other side's answer to a lane we offered.
  async answered(peer, msg) {
    const lane = (peer.lanes || []).find((l) => l.n === msg.n);
    if (!lane || lane.pc.signalingState !== 'have-local-offer' || typeof msg.sdp !== 'string') return;
    try { await lane.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); } catch (err) { Log.warn('engine', 'video lane answer failed', err); }
  },

  // A lane the other side offered.
  async offered(peer, msg) {
    if (typeof msg.sdp !== 'string' || !(msg.n >= 0 && msg.n < 16)) return;
    peer.lanes ||= [];
    const old = peer.lanes.find((l) => l.n === msg.n);
    if (old) { old.pc.close(); peer.lanes = peer.lanes.filter((l) => l !== old); }
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const dc = Engine.channel(pc);
    const lane = { n: msg.n, pc, dc };
    peer.lanes.push(lane);
    this.watch(peer, lane, 'answered');
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      sendTo(peer, { type: 'engine-lane-answer', n: msg.n, sdp: pc.localDescription.sdp });
    } catch (err) {
      Log.warn('engine', 'video lane not answered', err);
    }
  },

  // Once open, a lane brings their video in, and takes ours out a second later
  // (the first packets on a lane that just opened were sometimes resent only
  // after SCTP's timeout, ~2 s late).
  watch(peer, lane, how) {
    lane.pc.addEventListener('connectionstatechange', () => {
      if (lane.pc.connectionState === 'failed') Log.warn('engine', 'video lane failed', { peer: peer.id.slice(0, 6), n: lane.n, how });
    });
    lane.dc.addEventListener('open', () => {
      Log.info('engine', 'video lane open', { peer: peer.id.slice(0, 6), n: lane.n, how });
      engineReceiver(peer).addChannel(lane.dc);
      setTimeout(() => {
        lane.ready = true;
        if (Native.fanout && lane.dc.readyState === 'open') Native.fanout.addLane(peer.id, lane.dc);
      }, 1000);
    });
  },

  // For a share that starts (or a viewer added) after the lanes are up.
  ready(peer) {
    return (peer.lanes || []).filter((l) => l.ready && l.dc.readyState === 'open').map((l) => l.dc);
  },

  close(peer) {
    for (const l of peer.lanes || []) l.pc.close();
    peer.lanes = [];
    peer.lanesOpening = false;
  },
};

// Candidates go in the description itself (no trickling for lanes): wait for
// gathering, at most 3 s.
function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 3000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

// What arrives of each person's native stream, for the log and Stream info:
// every 5 s while someone streams to us.
setInterval(() => {
  for (const peer of state.peers.values()) {
    const rx = peer.engineRx;
    if (!rx || !rx.streamsInfo().length) continue;
    const st = rx.stats();
    const now = performance.now();
    const prev = peer.rxPrev;
    peer.rxPrev = { bytes: st.bytes, decoded: st.decoded, t: now };
    if (!prev) continue;
    const secs = (now - prev.t) / 1000;
    peer.rxNow = { mbps: +(((st.bytes - prev.bytes) * 8) / secs / 1e6).toFixed(1), fps: Math.round((st.decoded - prev.decoded) / secs), lanes: st.channels };
    lineStats(peer).then((line) => {
      Log.info('stats', 'native video in', { peer: peer.id.slice(0, 6), their: peer.version || 'older', ...peer.rxNow, ...line, delay: rx.streamsInfo()[0].delay, lateMs: rx.streamsInfo()[0].late, delayUps: st.delayUps, stalls: st.stalls, keyAsks: st.keyAsks, late: st.late, sender: peer.engineNet || null });
    });
  }
}, 5000);

// The line from this peer to us: packet loss measured on their voice (RTP
// counts every packet, so it shows what any data on that line goes through)
// and the round trip, since the last call.
async function lineStats(peer) {
  try {
    const st = await peer.pc.getStats();
    let lost = 0, got = 0, rtt = null;
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') { lost += r.packetsLost || 0; got += r.packetsReceived || 0; }
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = Math.round(r.currentRoundTripTime * 1000);
    });
    const prev = peer.linePrev;
    peer.linePrev = { lost, got };
    const dl = prev ? lost - prev.lost : 0, dg = prev ? got - prev.got : 0;
    return { lossPct: dl + dg > 0 ? +((100 * dl) / (dl + dg)).toFixed(2) : 0, rttMs: rtt };
  } catch {
    return {};
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
      Lanes.open(peer); // the video lanes, ready before anyone shares
      Native.addViewer(peer); // someone joined a native share in progress
      break;
    case 'engine-config':
    case 'engine-end':
      engineReceiver(peer).onControl(msg);
      break;
    case 'engine-net':
      // The sender's own numbers for us (from 2.1.3): logged with what arrives.
      peer.engineNet = msg;
      break;
    case 'engine-lane':
      Lanes.offered(peer, msg);
      break;
    case 'engine-lane-answer':
      Lanes.answered(peer, msg);
      break;
    case 'engine-feedback':
    case 'engine-keyframe':
    case 'engine-delay':
      if (Native.fanout) Native.fanout.onControl(peer, msg);
      break;
  }
}
