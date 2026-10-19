// Miserecord streaming engine (see docs/native-engine.md).
// Encoded video travels over its own data channel on the call's peer-to-peer
// connection: unordered and without retransmits, so a lost packet costs one
// frame instead of holding up the ones after it. The viewer decodes on the GPU
// with WebCodecs and turns the frames back into a normal video track, so the
// stream tile (zoom, volume, full screen) works as it does today.
//
// Sources: createFanout() takes frames from the native capture + hardware encoder
// (miserecord-capture) and sends each one to every viewer; createSender() uses
// Chromium's WebCodecs encoder on a track (used in tests).
'use strict';

const Engine = (() => {
  const VERSION = 1;
  const HEADER = 20;
  const MAX_PACKET = 16 * 1024;
  const FLAG_KEY = 1, FLAG_FIRST = 2, FLAG_LAST = 4;
  const CODECS = {
    AV1: 'av01.0.08M.08',
    H264: 'avc1.640033', // High 5.1: up to 4K60
  };

  // The engine's channel, created the same way on both sides (negotiated id 1).
  function channel(pc) {
    // Reliable but unordered: frames don't wait for each other, and nothing is
    // abandoned (partly reliable modes dropped ~40% of frames between two apps).
    // Delay stays bounded because the sender skips to the next keyframe when a
    // viewer's buffer passes 2 MB.
    const dc = pc.createDataChannel('video', { negotiated: true, id: 1, ordered: false });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    return dc;
  }

  // What this app can show: codecs it decodes, ideally on the GPU.
  async function decodable() {
    if (!window.VideoDecoder || !window.MediaStreamTrackGenerator) return [];
    const out = [];
    for (const [name, codec] of Object.entries(CODECS)) {
      try {
        const s = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 });
        if (s.supported) out.push(name);
      } catch { /* no */ }
    }
    return out;
  }

  // ---------------------------------------------------------------- packets
  function packets(stream, frameNo, key, timestampUs, data) {
    const count = Math.max(1, Math.ceil(data.byteLength / (MAX_PACKET - HEADER)));
    const out = [];
    for (let i = 0; i < count; i++) {
      const part = data.subarray(i * (MAX_PACKET - HEADER), (i + 1) * (MAX_PACKET - HEADER));
      const buf = new Uint8Array(HEADER + part.byteLength);
      const v = new DataView(buf.buffer);
      v.setUint8(0, VERSION);
      v.setUint8(1, (key ? FLAG_KEY : 0) | (i === 0 ? FLAG_FIRST : 0) | (i === count - 1 ? FLAG_LAST : 0));
      v.setUint16(2, stream);
      v.setUint32(4, frameNo);
      v.setUint16(8, i);
      v.setUint16(10, count);
      v.setBigUint64(12, BigInt(Math.max(0, Math.round(timestampUs))));
      buf.set(part, HEADER);
      out.push(buf);
    }
    return out;
  }

  function readPacket(ab) {
    if (!(ab instanceof ArrayBuffer) || ab.byteLength < HEADER) return null;
    const v = new DataView(ab);
    if (v.getUint8(0) !== VERSION) return null;
    const flags = v.getUint8(1);
    return {
      key: !!(flags & FLAG_KEY),
      stream: v.getUint16(2),
      frame: v.getUint32(4),
      index: v.getUint16(8),
      count: v.getUint16(10),
      timestamp: Number(v.getBigUint64(12)),
      payload: new Uint8Array(ab, HEADER),
    };
  }

  // ---------------------------------------------------------------- rate control
  // Per viewer: back off fast on loss, a growing decode queue or a full send
  // buffer; creep up while clean. The stream goes at the slowest viewer's rate.
  function rateStep(rate, msg, buffered, floor, cap) {
    const loss = msg.frames + msg.lost > 0 ? msg.lost / (msg.frames + msg.lost) : 0;
    if (loss > 0.03 || msg.queue > 3 || buffered > 1024 * 1024) rate *= 0.8;
    else rate *= 1.05;
    return Math.max(floor, Math.min(cap, rate));
  }

  // ---------------------------------------------------------------- fan-out sender
  // One encoded stream (the native helper's) to every viewer.
  //   config: { id (MediaStream id), codec, width, height }
  //   sendTo(peer, json): the call's normal channel
  //   setRate(bps), wantKey(): back to the encoder
  function createFanout({ number = 1, config, startRate, maxRate, minRate = 500e3, sendTo, setRate, wantKey, onDelay = () => {} }) {
    const viewers = new Map(); // peer id -> { peer, dc, rate, needKey, frames }
    let frameNo = 0;
    let rate = startRate;
    let lastRateAt = 0;
    let lastKeyAsk = 0;
    let lastKeyAt = 0;
    const st = { frames: 0, bytes: 0, keyframes: 0, skipped: 0 };

    const askKey = () => {
      const now = performance.now();
      if (now - lastKeyAsk < 500) return;
      lastKeyAsk = now;
      wantKey();
    };

    function addViewer(peer, dc) {
      if (viewers.has(peer.id)) return;
      viewers.set(peer.id, { peer, dc, rate: startRate, needKey: true, queue: [], queued: 0, sentWin: 0, lastBuffered: 0, lastBacklog: 0, tput: 0, calm: 0, full: 0, delay: 0 });
      delayChanged();
      sendTo(peer, { type: 'engine-config', stream: number, ...config });
      askKey(); // a new viewer can only start on a keyframe
    }

    function removeViewer(id) {
      viewers.delete(id);
      delayChanged();
    }

    // The encoder's buffer follows the least delayed viewer (a live viewer can't
    // wait for bursts).
    let lastDelay = 0;
    function delayChanged() {
      const d = viewers.size ? Math.min(...[...viewers.values()].map((x) => x.delay)) : 0;
      if (d !== lastDelay) { lastDelay = d; onDelay(d); }
    }

    // Pacing: a keyframe is a few hundred kilobytes; sent in one go it overflows
    // the other side's network buffer and the connection stalls to recover. Like
    // WebRTC's own pacer, packets go out at a steady rate a little above the
    // stream's bitrate instead.
    const PACE_FACTOR = 3;
    const MIN_PACE = 20e6;
    const BURST = 48 * 1024;
    let budget = BURST;
    let lastPace = performance.now();
    let pacing = false;

    function pace() {
      const now = performance.now();
      // window.__testUploadBps: tests stand in a slow upload this way.
      const bps = Math.min(window.__testUploadBps || Infinity, Math.max(MIN_PACE, rate * PACE_FACTOR));
      budget = Math.min(BURST, budget + ((now - lastPace) / 1000) * (bps / 8));
      lastPace = now;
      let more = false;
      for (const v of viewers.values()) {
        while (v.queue.length && budget > 0) {
          const p = v.queue.shift();
          v.queued -= p.byteLength;
          if (v.dc.readyState === 'open') { v.dc.send(p); v.sentWin += p.byteLength; }
          budget -= p.byteLength;
        }
        if (v.queue.length) more = true;
      }
      pacing = more;
      if (more) setTimeout(pace, 1);
    }

    function push(frame) {
      const data = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
      if (frame.key) { st.keyframes++; lastKeyAt = performance.now(); }
      let built = null;
      for (const v of viewers.values()) {
        if (v.dc.readyState !== 'open') continue;
        // A viewer whose line is full (queued here or in the channel) skips frames
        // until the next keyframe, instead of falling further behind.
        if (v.queued + v.dc.bufferedAmount > skipAt(v)) { v.needKey = true; st.skipped++; askKey(); continue; }
        if (v.needKey && !frame.key) continue;
        v.needKey = false;
        built ||= packets(number, frameNo, frame.key, frame.time, data);
        for (const p of built) { v.queue.push(p); v.queued += p.byteLength; }
      }
      if (built) { frameNo = (frameNo + 1) >>> 0; st.frames++; st.bytes += data.byteLength; }
      if (!pacing) { pacing = true; lastPace = performance.now(); pace(); }
    }

    // The stream goes at the slowest viewer's rate.
    function applyRate() {
      if (!viewers.size) return;
      const slowest = Math.min(...[...viewers.values()].map((x) => x.rate));
      const now = performance.now();
      if (Math.abs(slowest - rate) / rate > 0.05 && now - lastRateAt > 250) {
        rate = slowest;
        lastRateAt = now;
        setRate(Math.round(rate));
      }
    }

    // Congestion control, every 250 ms per viewer. What really left for them
    // (sent minus what's still waiting) is the line's speed, but only in a window
    // where data was waiting from start to end: otherwise the sender was just idle
    // and the number says nothing about the line. A backlog over 256 KB for two
    // windows in a row (one keyframe alone doesn't count) means the line is full:
    // go just under its speed. With little waiting for 2 s, probe 8% higher.
    const WINDOW = 250;
    // A viewer with a stream delay holds frames back anyway: data waiting here up
    // to half that delay isn't a full line, just a burst being spread out, and
    // only a backlog worth the whole delay is skipped.
    const fullAt = (v) => Math.max(256 * 1024, (v.rate / 8) * (v.delay / 2000));
    const skipAt = (v) => Math.max(2 * 1024 * 1024, (v.rate / 8) * (v.delay / 1000));
    const cc = setInterval(() => {
      for (const v of viewers.values()) {
        const buffered = v.dc.bufferedAmount;
        const backlog = buffered + v.queued;
        const drained = Math.max(0, v.sentWin - (buffered - v.lastBuffered));
        const saturated = v.lastBacklog > 64 * 1024 && backlog > 64 * 1024;
        if (saturated) {
          const speed = (drained * 8 * 1000) / WINDOW;
          v.tput = v.tput ? v.tput * 0.7 + speed * 0.3 : speed;
        }
        // Only raise the rate when the stream actually uses most of it: a still
        // screen sends little and would otherwise push the rate far above the line.
        const using = (v.sentWin * 8 * 1000) / WINDOW >= v.rate * 0.6;
        v.lastBuffered = buffered;
        v.lastBacklog = backlog;
        v.sentWin = 0;
        v.full = backlog > fullAt(v) ? (v.full || 0) + 1 : 0;
        if (v.full >= 2) {
          const target = v.tput ? v.tput * 0.85 : v.rate * 0.85;
          if (v.rate > target) v.rate = Math.max(minRate, v.tput ? v.tput * 0.7 : minRate, target);
          v.calm = 0;
        } else if (backlog < 64 * 1024 && using && ++v.calm >= 8) {
          v.rate = Math.min(maxRate, v.rate * 1.08);
          v.calm = 4; // keep probing once a second while it stays calm
        }
      }
      applyRate();
    }, WINDOW);

    function onControl(peer, msg) {
      const v = viewers.get(peer.id);
      if (!v) return;
      if (msg.type === 'engine-keyframe') { v.needKey = true; askKey(); }
      if (msg.type === 'engine-delay') { v.delay = Math.max(0, Math.min(3000, msg.ms | 0)); delayChanged(); }
      if (msg.type !== 'engine-feedback') return;
      // The viewer's decoder falling behind is a reason to slow down too.
      if (msg.queue > 3) { v.rate = Math.max(minRate, v.rate * 0.85); applyRate(); }
    }

    // A new picture size or frame rate from the encoder: tell every viewer.
    function reconfigure(change) {
      Object.assign(config, change);
      for (const v of viewers.values()) sendTo(v.peer, { type: 'engine-config', stream: number, ...config });
    }

    function stop() {
      clearInterval(cc);
      for (const v of viewers.values()) sendTo(v.peer, { type: 'engine-end', stream: number });
      viewers.clear();
    }

    function backlog() {
      return Math.max(0, ...[...viewers.values()].map((v) => v.dc.bufferedAmount + v.queued));
    }

    return { addViewer, removeViewer, push, onControl, reconfigure, stop, backlog, stats: () => ({ ...st, rate: Math.round(rate), viewers: viewers.size, sinceKeyMs: Math.round(performance.now() - lastKeyAt) }) };
  }

  // ---------------------------------------------------------------- WebCodecs sender (tests)
  function createSender({ dc, track, codec = 'H264', fps = 60, bitrate = 8e6, maxBitrate = 20e6, stream = 1, send }) {
    let frameNo = 0;
    let rate = bitrate;
    let wantKey = true;
    let stopped = false;
    let configured = null;
    const st = { sent: 0, dropped: 0, bytes: 0, keyframes: 0 };
    const cfg = (w, h) => ({
      codec: CODECS[codec], width: w, height: h, framerate: fps, bitrate: Math.round(rate),
      bitrateMode: 'variable', latencyMode: 'realtime', hardwareAcceleration: 'prefer-hardware',
      ...(codec === 'H264' ? { avc: { format: 'annexb' } } : {}),
    });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (stopped) return;
        if (meta && meta.decoderConfig && !configured) {
          configured = meta.decoderConfig;
          send({ type: 'engine-config', stream, codec, width: configured.codedWidth, height: configured.codedHeight });
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const key = chunk.type === 'key';
        if (key) st.keyframes++;
        if (dc.readyState !== 'open') return;
        for (const p of packets(stream, frameNo, key, chunk.timestamp, data)) dc.send(p);
        frameNo = (frameNo + 1) >>> 0;
        st.sent++;
        st.bytes += data.byteLength;
      },
      error: (err) => { Log.warn('engine', 'encoder error', err); stop(); },
    });
    let width = 0, height = 0;
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let lastKeyAt = 0;
    (async () => {
      while (!stopped) {
        const { value: frame, done } = await reader.read();
        if (done || stopped) { if (frame) frame.close(); break; }
        if (!width || frame.codedWidth !== width || frame.codedHeight !== height) {
          width = frame.codedWidth & ~1; height = frame.codedHeight & ~1;
          encoder.configure(cfg(width, height));
          configured = null; wantKey = true;
        }
        const busy = encoder.encodeQueueSize > 2 || dc.bufferedAmount > 2 * 1024 * 1024;
        if (busy && !wantKey) { st.dropped++; frame.close(); continue; }
        const now = performance.now();
        const key = wantKey || now - lastKeyAt > 4000;
        if (key) { lastKeyAt = now; wantKey = false; }
        encoder.encode(frame, { keyFrame: key });
        frame.close();
      }
    })().catch((err) => Log.warn('engine', 'capture stopped', err));
    function onControl(msg) {
      if (msg.type === 'engine-keyframe') wantKey = true;
      if (msg.type !== 'engine-feedback') return;
      const before = rate;
      rate = rateStep(rate, msg, dc.bufferedAmount, 500e3, maxBitrate);
      if (Math.abs(rate - before) / before > 0.1 && width) encoder.configure(cfg(width, height));
    }
    function stop() {
      if (stopped) return;
      stopped = true;
      reader.cancel().catch(() => {});
      if (encoder.state !== 'closed') encoder.close();
      send({ type: 'engine-end', stream });
    }
    return { stop, onControl, stats: () => ({ ...st, rate: Math.round(rate) }) };
  }

  // ---------------------------------------------------------------- receiver
  // Rebuilds frames from packets, decodes them on the GPU and outputs a normal
  // video track. onTrack(track, config) when a stream starts, onEnd(config) when it ends.
  function createReceiver({ dc, send, onTrack, onEnd, enhance = () => false }) {
    const streams = new Map(); // stream number -> state
    const st = { frames: 0, lost: 0, decoded: 0, late: 0, shown: 0 };
    const total = { complete: 0, lost: 0, waitedForKey: 0, keyAsks: 0, packets: 0, reordered: 0, stalls: 0, gapN: 0, gapSum: 0, gapSq: 0, gapMax: 0, enhanced: 0, enhanceMs: 0 };

    function askKey(s) {
      const now = performance.now();
      if (now - s.lastKeyAsk < 300) return;
      s.lastKeyAsk = now;
      total.keyAsks++;
      send({ type: 'engine-keyframe', stream: s.number });
    }

    function open(msg) {
      const number = msg.stream | 0;
      let s = streams.get(number);
      if (!s) {
        const generator = new MediaStreamTrackGenerator({ kind: 'video' });
        s = { number, generator, writer: generator.writable.getWriter(), decoder: null, config: null, parts: new Map(), ready: new Map(), next: null, waitSince: 0, held: [], holdTimer: null, delay: viewDelay, arrBest: Infinity, arrRecent: Infinity, arrAt: performance.now(), needKey: true, lastKeyAsk: 0, best: Infinity, recentBest: Infinity, bestAt: performance.now(), queue: [], timer: null, target: 50 };
        streams.set(number, s);
        s.config = msg;
        onTrack(generator, msg);
        if (viewDelay) send({ type: 'engine-delay', stream: number, ms: viewDelay });
      }
      const sameCodec = s.config && s.config.codec === msg.codec && s.decoder && s.decoder.state === 'configured';
      s.config = msg;
      // Only the size changed: the next keyframe carries it, and resetting the
      // decoder here would freeze the picture until the keyframe after that.
      if (sameCodec && s.started) return;
      s.started = true;
      if (s.decoder && s.decoder.state !== 'closed') s.decoder.close();
      s.decoder = new VideoDecoder({
        output: (frame) => {
          st.decoded++;
          // Late frames (they piled up somewhere and arrived in a burst) are skipped
          // so the picture jumps back to live instead of playing in fast-forward.
          // "Late" is against the best delay seen recently: the two computers'
          // clocks differ, but that difference is constant.
          const now = performance.now();
          const delay = now - frame.timestamp / 1000;
          if (now - s.bestAt > 3000) { s.best = s.recentBest; s.recentBest = Infinity; s.bestAt = now; }
          s.recentBest = Math.min(s.recentBest, delay);
          s.best = Math.min(s.best, delay);
          if (delay - s.best > 300) { st.late++; frame.close(); return; }
          // Playout: show each frame at its capture time plus a small steady delay
          // (s.target, matched to the stream's sound), so frames that arrive
          // unevenly still come out at an even pace and in step with the audio.
          s.queue.push({ frame, due: frame.timestamp / 1000 + s.best + s.target });
          if (s.queue.length > 30) { s.queue.shift().frame.close(); st.late++; }
          playout(s);
        },
        error: (err) => { Log.warn('engine', 'decoder error', err); restart(s); askKey(s); open(s.config); },
      });
      s.decoder.configure({ codec: CODECS[msg.codec] || CODECS.H264, codedWidth: msg.width, codedHeight: msg.height, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
      s.needKey = true;
    }

    dc.addEventListener('message', (e) => {
      const p = readPacket(e.data);
      if (!p) return;
      total.packets++;
      const s = streams.get(p.stream);
      if (!s || !s.decoder) return; // waiting for engine-config
      if (s.next !== null && p.frame < s.next) return; // a frame already passed over
      // Pieces of frames dropped by a restart never complete: don't keep them.
      if (s.parts.size > 60) for (const k of s.parts.keys()) if (k + 120 < p.frame) s.parts.delete(k);
      let f = s.parts.get(p.frame);
      if (!f) { f = { key: p.key, count: p.count, got: 0, chunks: new Array(p.count), timestamp: p.timestamp }; s.parts.set(p.frame, f); }
      if (f.chunks[p.index]) return;
      f.chunks[p.index] = p.payload;
      f.got++;
      if (f.got < f.count) return;
      s.parts.delete(p.frame);
      st.frames++;
      total.complete++;
      arrived(s, p.frame, f);
    });

    // The channel is reliable but unordered: when a packet is lost on the way and
    // sent again, the frames after it can finish first. Each frame needs the one
    // before it, so frames are decoded strictly in order: a finished frame waits
    // here until the ones before it are in (a resend takes about one round trip).
    // For a given viewer the sender only leaves out frames right before a
    // keyframe, so a gap in front of a normal frame always means "still coming".
    function arrived(s, no, f) {
      // How fast frames get here at best (the clocks differ, but by a constant).
      const now = performance.now();
      const d = now - f.timestamp / 1000;
      if (now - s.arrAt > 3000) { s.arrBest = s.arrRecent; s.arrRecent = Infinity; s.arrAt = now; }
      s.arrRecent = Math.min(s.arrRecent, d);
      s.arrBest = Math.min(s.arrBest, d);
      if (f.key && (s.next === null || no >= s.next)) {
        // A keyframe needs nothing before it: start over from here.
        for (const k of s.ready.keys()) if (k < no) s.ready.delete(k);
        for (const k of s.parts.keys()) if (k < no) s.parts.delete(k);
        s.needKey = false;
        s.next = no;
      }
      if (s.needKey || s.next === null) { total.waitedForKey++; askKey(s); return; }
      if (no !== s.next) {
        s.ready.set(no, f);
        total.reordered++;
        if (!s.waitSince) s.waitSince = performance.now();
        // Nothing came for the missing frame in a second: give up on it.
        if (performance.now() - s.waitSince > 1000) {
          st.lost++; total.lost++; total.stalls++;
          restart(s);
          askKey(s);
        }
        return;
      }
      decode(s, f);
      s.next = no + 1;
      while (s.ready.has(s.next)) {
        const g = s.ready.get(s.next);
        s.ready.delete(s.next);
        decode(s, g);
        s.next++;
      }
      s.waitSince = s.ready.size ? performance.now() : 0;
    }

    // Stream delay (settings): frames wait here, still compressed, until shortly
    // before they're due, so a slow moment on the line, a resend or a big frame
    // is absorbed by the buffer instead of freezing the picture, and the sender
    // can spend bits unevenly where the picture needs them.
    const LEAD = 100; // ms before showing: time to decode
    function decode(s, f) {
      if (!s.delay) { decodeNow(s, f); return; }
      s.held.push({ f, release: f.timestamp / 1000 + s.arrBest + s.delay - LEAD });
      release(s);
    }

    function release(s) {
      clearTimeout(s.holdTimer);
      s.holdTimer = null;
      const now = performance.now();
      while (s.held.length && (!s.delay || s.held[0].release <= now + 1)) decodeNow(s, s.held.shift().f);
      if (s.held.length) s.holdTimer = setTimeout(() => release(s), Math.max(1, s.held[0].release - now));
    }

    function decodeNow(s, f) {
      const size = f.chunks.reduce((n, c) => n + c.byteLength, 0);
      const data = new Uint8Array(size);
      let o = 0;
      for (const c of f.chunks) { data.set(c, o); o += c.byteLength; }
      try {
        s.decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.timestamp, data }));
      } catch { restart(s); askKey(s); }
    }

    // Wait for the next keyframe: nothing held so far can be shown without it.
    function restart(s) {
      s.needKey = true;
      s.next = null;
      s.waitSince = 0;
      s.ready.clear();
      s.parts.clear();
      s.held = [];
      clearTimeout(s.holdTimer);
    }

    const feedback = setInterval(() => {
      for (const s of streams.values()) {
        send({ type: 'engine-feedback', stream: s.number, frames: st.frames, lost: st.lost, queue: s.decoder ? s.decoder.decodeQueueSize : 0 });
      }
      st.frames = 0; st.lost = 0;
    }, 500);

    function playout(s) {
      if (s.timer) return;
      const now = performance.now();
      while (s.queue.length && s.queue[0].due <= now + 2) {
        const item = s.queue.shift();
        // Two frames due at once (the timer ran late): show only the newer one.
        if (s.queue.length && s.queue[0].due <= now + 2) { item.frame.close(); continue; }
        let out = item.frame;
        // Sharpen (and upscale to the screen, when the stream is smaller): enhance.js.
        if (enhance() && !s.enhanceFailed && typeof Enhance !== 'undefined') {
          try {
            s.enhancer ||= Enhance.create();
            if (s.enhancer) {
              const t0 = performance.now();
              const [ow, oh] = Enhance.outputSize(out.displayWidth, out.displayHeight);
              const sharp = s.enhancer.process(out, ow, oh);
              total.enhanceMs += performance.now() - t0;
              total.enhanced++;
              out.close();
              out = sharp;
            }
          } catch (err) {
            Log.warn('engine', 'stream enhancement failed, showing frames as they are', err);
            s.enhanceFailed = true;
          }
        }
        const shownFrame = out;
        s.writer.write(shownFrame).catch(() => shownFrame.close());
        st.shown++;
        // How even the pace is: intervals between shown frames, for Stream info and tests.
        if (s.lastShown) { const gap = now - s.lastShown; total.gapN++; total.gapSum += gap; total.gapSq += gap * gap; total.gapMax = Math.max(total.gapMax, gap); }
        s.lastShown = now;
      }
      if (s.queue.length) {
        s.timer = setTimeout(() => { s.timer = null; playout(s); }, Math.max(1, s.queue[0].due - now));
      }
    }

    function close(number) {
      const s = streams.get(number);
      if (!s) return;
      streams.delete(number);
      clearTimeout(s.timer);
      clearTimeout(s.holdTimer);
      for (const item of s.queue || []) item.frame.close();
      if (s.decoder && s.decoder.state !== 'closed') s.decoder.close();
      s.writer.close().catch(() => {});
      s.generator.stop();
      if (onEnd) onEnd(s.config);
    }

    function onControl(msg) {
      if (msg.type === 'engine-config') open(msg);
      if (msg.type === 'engine-end') close(msg.stream | 0);
    }

    function stop() {
      clearInterval(feedback);
      for (const n of [...streams.keys()]) close(n);
    }

    // How long frames wait before they're shown (ms), e.g. to match the sound.
    function setTargetDelay(number, ms) {
      const s = streams.get(number);
      if (s) s.target = Math.max(30, Math.min(400, ms));
    }

    // Extra delay for quality (ms, 0 = live), for every stream; the sender is told
    // so it can use the room.
    let viewDelay = 0;
    function setDelay(ms) {
      ms = Math.max(0, Math.min(3000, ms | 0));
      if (ms === viewDelay) return;
      viewDelay = ms;
      for (const s of streams.values()) {
        s.delay = ms;
        release(s);
        send({ type: 'engine-delay', stream: s.number, ms });
      }
    }

    function streamsInfo() {
      return [...streams.values()].map((s) => ({ number: s.number, id: s.config && String(s.config.id), target: s.target, delay: s.delay }));
    }

    return { onControl, stop, setTargetDelay, setDelay, streamsInfo, stats: () => ({ ...st, ...total }) };
  }

  return { channel, decodable, createFanout, createSender, createReceiver, CODECS };
})();
