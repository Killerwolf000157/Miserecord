// Strong noise suppression for the microphone: a small neural network removes
// keyboards, fans and background noise before your voice is sent, much better
// than the built-in filter. Runs on your computer in an audio worklet.
//   strong:    RNNoise ("AI, light"), gentle, keeps the full range of your voice
//   strongest: GTCRN ("AI, strong", the default), removes keyboards and hiss almost
//              completely; the voice can sound a little narrower
'use strict';

const Denoise = (() => {
  const MODELS = {
    strong: {
      worklet: 'vendor/noise/rnnoise-worklet.js',
      processor: '@sapphi-red/web-noise-suppressor/rnnoise',
      wasm: () => (simd() ? 'vendor/noise/rnnoise_simd.wasm' : 'vendor/noise/rnnoise.wasm'),
    },
    strongest: {
      worklet: 'vendor/noise/gtcrn-worklet.js',
      processor: '@sapphi-red/web-noise-suppressor/gtcrn',
      wasm: () => 'vendor/noise/gtcrn.wasm',
      options: { sampleRate: 48000 },
    },
  };
  // A tiny module that uses a SIMD instruction: valid only where SIMD works.
  const simd = () => WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));

  let ctx = null;
  const loaded = new Map(); // mode -> Promise<ArrayBuffer>

  function context() {
    // Both models work at 48 kHz, the rate Opus sends.
    if (!ctx || ctx.state === 'closed') ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    return ctx;
  }

  function load(mode) {
    if (!loaded.has(mode)) {
      const m = MODELS[mode];
      const c = context();
      const p = Promise.all([
        c.audioWorklet.addModule(m.worklet),
        fetch(m.wasm()).then((r) => r.arrayBuffer()),
      ]).then(([, wasm]) => wasm);
      p.catch(() => loaded.delete(mode));
      loaded.set(mode, p);
    }
    return loaded.get(mode);
  }

  // Returns a stream with the cleaned-up voice. Stopping its track also stops
  // the microphone and frees the model.
  async function wrap(raw, mode) {
    const m = MODELS[mode];
    if (!m || !raw.getAudioTracks().length) return raw;
    const c = context();
    const wasmBinary = await load(mode);
    if (c.state === 'suspended') await c.resume().catch(() => {});
    const source = c.createMediaStreamSource(raw);
    const node = new AudioWorkletNode(c, m.processor, {
      processorOptions: { maxChannels: 1, wasmBinary, ...(m.options || {}) },
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    const out = c.createMediaStreamDestination();
    out.channelCount = 1;
    source.connect(node).connect(out);
    const track = out.stream.getAudioTracks()[0];
    const stop = MediaStreamTrack.prototype.stop;
    track.stop = () => {
      stop.call(track);
      raw.getTracks().forEach((t) => t.stop());
      source.disconnect();
      node.disconnect();
      node.port.postMessage('destroy');
    };
    // If the mic is unplugged, the cleaned track ends with it.
    raw.getAudioTracks()[0].addEventListener('ended', () => track.stop());
    return out.stream;
  }

  return { wrap, modes: Object.keys(MODELS) };
})();
