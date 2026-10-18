// Miserecord streaming engine, stage 1 (see docs/native-engine.md).
// Encoded video travels over its own data channel on the call's peer-to-peer
// connection: unordered and without retransmits, so a lost packet costs one
// frame instead of holding up the ones after it. The viewer decodes on the GPU
// with WebCodecs and turns the frames back into a normal video track, so the
// stream tile (zoom, volume, full screen) works as it does today.
//
// The frame source is pluggable. Stage 1 uses Chromium's WebCodecs encoder on a
// screen-share track; stage 3 swaps in the native capture + hardware encoder.
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
    const dc = pc.createDataChannel('video', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    return dc;
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
    if (ab.byteLength < HEADER) return null;
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

  // ---------------------------------------------------------------- sender
  // source: a MediaStreamTrack (stage 1). send(json) carries control messages on
  // the normal channel. Returns { stop, onControl(msg), stats() }.
  function createSender({ dc, track, codec = 'H264', fps = 60, bitrate = 8e6, maxBitrate = 20e6, stream = 1, send }) {
    let frameNo = 0;
    let rate = bitrate;
    let wantKey = true;
    let stopped = false;
    let configured = null;
    const st = { sent: 0, dropped: 0, bytes: 0, keyframes: 0, encoder: '' };

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
    const configure = (w, h) => {
      width = w; height = h;
      encoder.configure({
        codec: CODECS[codec], width: w, height: h, framerate: fps, bitrate: Math.round(rate),
        bitrateMode: 'variable', latencyMode: 'realtime', hardwareAcceleration: 'prefer-hardware',
        ...(codec === 'H264' ? { avc: { format: 'annexb' } } : {}),
      });
      configured = null;
      wantKey = true;
    };

    // Read frames from the track and encode them, dropping frames when the line
    // or the encoder is behind instead of building up delay.
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let lastKeyAt = 0;
    (async () => {
      while (!stopped) {
        const { value: frame, done } = await reader.read();
        if (done || stopped) { if (frame) frame.close(); break; }
        if (!width || frame.codedWidth !== width || frame.codedHeight !== height) configure(frame.codedWidth & ~1, frame.codedHeight & ~1);
        const busy = encoder.encodeQueueSize > 2 || dc.bufferedAmount > 2 * 1024 * 1024;
        if (busy && !wantKey) { st.dropped++; frame.close(); continue; }
        const now = performance.now();
        const key = wantKey || now - lastKeyAt > 4000; // a keyframe every 4 s heals any loss
        if (key) { lastKeyAt = now; wantKey = false; }
        encoder.encode(frame, { keyFrame: key });
        frame.close();
      }
    })().catch((err) => Log.warn('engine', 'capture stopped', err));

    // Rate control from the viewer's reports: back off fast on loss or a growing
    // queue, creep up while clean, never above the cap.
    function onControl(msg) {
      if (msg.type === 'engine-keyframe') wantKey = true;
      if (msg.type !== 'engine-feedback') return;
      const loss = msg.frames ? msg.lost / (msg.frames + msg.lost) : 0;
      const before = rate;
      if (loss > 0.02 || msg.queue > 3 || dc.bufferedAmount > 1024 * 1024) rate *= 0.8;
      else rate = Math.min(maxBitrate, rate * 1.05);
      rate = Math.max(500e3, rate);
      if (Math.abs(rate - before) / before > 0.1 && width) {
        encoder.configure({
          codec: CODECS[codec], width, height, framerate: fps, bitrate: Math.round(rate),
          bitrateMode: 'variable', latencyMode: 'realtime', hardwareAcceleration: 'prefer-hardware',
          ...(codec === 'H264' ? { avc: { format: 'annexb' } } : {}),
        });
      }
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
  // video track (onTrack). send(json) carries feedback and keyframe requests.
  function createReceiver({ dc, send, onTrack }) {
    const streams = new Map(); // stream -> state
    const st = { frames: 0, lost: 0, decoded: 0 };

    function streamState(id) {
      let s = streams.get(id);
      if (s) return s;
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      const writer = generator.writable.getWriter();
      s = { id, generator, writer, decoder: null, config: null, parts: new Map(), next: null, needKey: true, lastKeyAsk: 0 };
      streams.set(id, s);
      onTrack(generator, id);
      return s;
    }

    function configure(s, msg) {
      s.config = msg;
      if (s.decoder && s.decoder.state !== 'closed') s.decoder.close();
      s.decoder = new VideoDecoder({
        output: (frame) => { st.decoded++; s.writer.write(frame).catch(() => frame.close()); },
        error: (err) => { Log.warn('engine', 'decoder error', err); s.needKey = true; askKey(s); configure(s, s.config); },
      });
      s.decoder.configure({ codec: CODECS[msg.codec] || CODECS.H264, codedWidth: msg.width, codedHeight: msg.height, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
      s.needKey = true;
    }

    function askKey(s) {
      const now = performance.now();
      if (now - s.lastKeyAsk < 300) return;
      s.lastKeyAsk = now;
      send({ type: 'engine-keyframe', stream: s.id });
    }

    dc.addEventListener('message', (e) => {
      const p = readPacket(e.data);
      if (!p) return;
      const s = streamState(p.stream);
      if (!s.decoder) return; // waiting for engine-config
      // Packets can arrive slightly out of order; a frame still incomplete when one
      // three frames newer arrives is lost.
      for (const no of s.parts.keys()) {
        if (no + 3 <= p.frame) { s.parts.delete(no); st.lost++; s.needKey = true; }
      }
      let f = s.parts.get(p.frame);
      if (!f) { f = { key: p.key, count: p.count, got: 0, chunks: new Array(p.count), timestamp: p.timestamp }; s.parts.set(p.frame, f); }
      if (f.chunks[p.index]) return;
      f.chunks[p.index] = p.payload;
      f.got++;
      if (f.got < f.count) return;
      s.parts.delete(p.frame);
      st.frames++;
      // After a loss, only a keyframe can continue the picture.
      if (s.needKey && !f.key) { askKey(s); return; }
      s.needKey = false;
      const size = f.chunks.reduce((n, c) => n + c.byteLength, 0);
      const data = new Uint8Array(size);
      let o = 0;
      for (const c of f.chunks) { data.set(c, o); o += c.byteLength; }
      try {
        s.decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.timestamp, data }));
      } catch (err) { s.needKey = true; askKey(s); }
    });

    const feedback = setInterval(() => {
      for (const s of streams.values()) {
        send({ type: 'engine-feedback', stream: s.id, frames: st.frames, lost: st.lost, queue: s.decoder ? s.decoder.decodeQueueSize : 0 });
      }
      st.frames = 0; st.lost = 0;
    }, 500);

    function onControl(msg) {
      if (msg.type === 'engine-config') configure(streamState(msg.stream), msg);
      if (msg.type === 'engine-end') {
        const s = streams.get(msg.stream);
        if (!s) return;
        streams.delete(msg.stream);
        if (s.decoder && s.decoder.state !== 'closed') s.decoder.close();
        s.writer.close().catch(() => {});
      }
    }

    function stop() {
      clearInterval(feedback);
      for (const s of streams.values()) {
        if (s.decoder && s.decoder.state !== 'closed') s.decoder.close();
        s.writer.close().catch(() => {});
      }
      streams.clear();
    }

    return { onControl, stop, stats: () => ({ ...st }) };
  }

  return { channel, createSender, createReceiver, CODECS };
})();
