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
  function createFanout({ number = 1, config, startRate, maxRate, minRate = 800e3, sendTo, setRate, wantKey }) {
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
      viewers.set(peer.id, { peer, dc, rate: startRate, needKey: true });
      sendTo(peer, { type: 'engine-config', stream: number, ...config });
      askKey(); // a new viewer can only start on a keyframe
    }

    function removeViewer(id) {
      viewers.delete(id);
    }

    function push(frame) {
      const data = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
      if (frame.key) { st.keyframes++; lastKeyAt = performance.now(); }
      let built = null;
      for (const v of viewers.values()) {
        if (v.dc.readyState !== 'open') continue;
        // A viewer whose line is full skips frames until the next keyframe.
        if (v.dc.bufferedAmount > 2 * 1024 * 1024) { v.needKey = true; st.skipped++; askKey(); continue; }
        if (v.needKey && !frame.key) continue;
        v.needKey = false;
        built ||= packets(number, frameNo, frame.key, frame.time, data);
        for (const p of built) v.dc.send(p);
      }
      if (built) { frameNo = (frameNo + 1) >>> 0; st.frames++; st.bytes += data.byteLength; }
    }

    function onControl(peer, msg) {
      const v = viewers.get(peer.id);
      if (!v) return;
      if (msg.type === 'engine-keyframe') { v.needKey = true; askKey(); }
      if (msg.type !== 'engine-feedback') return;
      v.rate = rateStep(v.rate, msg, v.dc.bufferedAmount, minRate, maxRate);
      const slowest = Math.min(...[...viewers.values()].map((x) => x.rate));
      const now = performance.now();
      if (Math.abs(slowest - rate) / rate > 0.1 && now - lastRateAt > 500) {
        rate = slowest;
        lastRateAt = now;
        setRate(Math.round(rate));
      }
    }

    function stop() {
      for (const v of viewers.values()) sendTo(v.peer, { type: 'engine-end', stream: number });
      viewers.clear();
    }

    return { addViewer, removeViewer, push, onControl, stop, stats: () => ({ ...st, rate: Math.round(rate), viewers: viewers.size, sinceKeyMs: Math.round(performance.now() - lastKeyAt) }) };
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
  function createReceiver({ dc, send, onTrack, onEnd }) {
    const streams = new Map(); // stream number -> state
    const st = { frames: 0, lost: 0, decoded: 0 };
    const total = { complete: 0, lost: 0, waitedForKey: 0, keyAsks: 0, packets: 0 };

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
        s = { number, generator, writer: generator.writable.getWriter(), decoder: null, config: null, parts: new Map(), needKey: true, lastKeyAsk: 0 };
        streams.set(number, s);
        s.config = msg;
        onTrack(generator, msg);
      }
      s.config = msg;
      if (s.decoder && s.decoder.state !== 'closed') s.decoder.close();
      s.decoder = new VideoDecoder({
        output: (frame) => { st.decoded++; s.writer.write(frame).catch(() => frame.close()); },
        error: (err) => { Log.warn('engine', 'decoder error', err); s.needKey = true; askKey(s); open(s.config); },
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
      // Packets can arrive slightly out of order; a frame still incomplete when one
      // three frames newer arrives is lost.
      for (const no of s.parts.keys()) {
        if (no + 3 <= p.frame) { s.parts.delete(no); st.lost++; total.lost++; s.needKey = true; }
      }
      let f = s.parts.get(p.frame);
      if (!f) { f = { key: p.key, count: p.count, got: 0, chunks: new Array(p.count), timestamp: p.timestamp }; s.parts.set(p.frame, f); }
      if (f.chunks[p.index]) return;
      f.chunks[p.index] = p.payload;
      f.got++;
      if (f.got < f.count) return;
      s.parts.delete(p.frame);
      st.frames++;
      total.complete++;
      // After a loss, only a keyframe can continue the picture.
      if (s.needKey && !f.key) { total.waitedForKey++; askKey(s); return; }
      s.needKey = false;
      const size = f.chunks.reduce((n, c) => n + c.byteLength, 0);
      const data = new Uint8Array(size);
      let o = 0;
      for (const c of f.chunks) { data.set(c, o); o += c.byteLength; }
      try {
        s.decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.timestamp, data }));
      } catch { s.needKey = true; askKey(s); }
    });

    const feedback = setInterval(() => {
      for (const s of streams.values()) {
        send({ type: 'engine-feedback', stream: s.number, frames: st.frames, lost: st.lost, queue: s.decoder ? s.decoder.decodeQueueSize : 0 });
      }
      st.frames = 0; st.lost = 0;
    }, 500);

    function close(number) {
      const s = streams.get(number);
      if (!s) return;
      streams.delete(number);
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

    return { onControl, stop, stats: () => ({ ...st, ...total }) };
  }

  return { channel, decodable, createFanout, createSender, createReceiver, CODECS };
})();
