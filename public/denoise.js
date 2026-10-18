// The microphone's path before it's sent: optional AI noise suppression, then
// your microphone volume (0-200%). Runs on your computer in Web Audio.
// Noise suppression: a small neural network removes keyboards, fans and
// background noise, much better than the built-in filter.
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
    // The models work at 48 kHz, the rate Opus sends.
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

  // Returns a stream with the processed voice. Its track has setGain(0..2) for
  // live volume changes; stopping it also stops the microphone and frees the model.
  // mode: 'strong' | 'strongest' | anything else for no AI model.
  async function wrap(raw, { mode, gain = 1 } = {}) {
    const input = raw.getAudioTracks()[0];
    if (!input) return raw;
    const m = MODELS[mode];
    const c = context();
    const wasmBinary = m ? await load(mode) : null;
    if (c.state === 'suspended') await c.resume().catch(() => {});
    const channels = m ? 1 : Math.min(2, (input.getSettings && input.getSettings().channelCount) || 1);
    const source = c.createMediaStreamSource(raw);
    const volume = c.createGain();
    volume.gain.value = gain;
    const out = c.createMediaStreamDestination();
    out.channelCount = channels;
    let node = null;
    if (m) {
      node = new AudioWorkletNode(c, m.processor, {
        processorOptions: { maxChannels: 1, wasmBinary, ...(m.options || {}) },
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      source.connect(node).connect(volume);
    } else {
      source.connect(volume);
    }
    volume.connect(out);
    const track = out.stream.getAudioTracks()[0];
    const stop = MediaStreamTrack.prototype.stop;
    track.setGain = (v) => volume.gain.setTargetAtTime(Math.max(0, Math.min(2, v)), c.currentTime, 0.02);
    track.stop = () => {
      stop.call(track);
      raw.getTracks().forEach((t) => t.stop());
      source.disconnect();
      volume.disconnect();
      if (node) { node.disconnect(); node.port.postMessage('destroy'); }
    };
    // If the mic is unplugged, the processed track ends with it.
    input.addEventListener('ended', () => track.stop());
    return out.stream;
  }

  return { wrap, modes: Object.keys(MODELS) };
})();
