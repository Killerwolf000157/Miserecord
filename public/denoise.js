// The microphone's path before it's sent: optional AI noise suppression, then
// your microphone volume (0-200%). Runs on your computer in Web Audio.
//
// AI noise suppression is DeepFilterNet3 (vendor/dfn): a neural network at
// 48 kHz that keeps the whole voice band and removes keyboards, fans, hiss and
// room noise, the same kind of model Krisp uses. A gate after it keeps pauses
// silent, and its own leveller replaces the browser's automatic volume, which
// would otherwise raise the noise before the model sees it.
'use strict';

const Denoise = (() => {
  let ctx = null;
  let loader = null; // Promise of the DeepFilterNet module

  function context() {
    // DeepFilterNet3 works at 48 kHz, the rate Opus sends.
    if (!ctx || ctx.state === 'closed') ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    return ctx;
  }

  function loadModel() {
    loader ||= import('./vendor/dfn/deepfilternet.js').catch((err) => { loader = null; throw err; });
    return loader;
  }

  // Returns a stream with the processed voice. Its track has setGain(0..2) for
  // live volume changes; stopping it also stops the microphone and frees the model.
  // ai: run the AI model; level: let the model's leveller set the volume.
  async function wrap(raw, { ai = false, level = true, gain = 1 } = {}) {
    const input = raw.getAudioTracks()[0];
    if (!input) return raw;
    const c = context();
    let model = null;
    if (ai) {
      const { createDeepFilterNetAudioWorklet } = await loadModel();
      const started = performance.now();
      model = await createDeepFilterNetAudioWorklet(c, {
        postGain: level,
        onOverload: (load) => {
          // This computer can't run the model in real time: keep the call going without it.
          Log.warn('media', 'AI noise suppression is too slow on this computer, sending the plain microphone', { load });
          if (bypass) bypass();
          toast("AI noise suppression is too heavy for this computer, so it's off for this call.", 'err');
        },
      });
      Log.info('media', 'AI noise suppression ready', { ms: Math.round(performance.now() - started) });
    }
    if (c.state === 'suspended') await c.resume().catch(() => {});
    const channels = model ? 1 : Math.min(2, (input.getSettings && input.getSettings().channelCount) || 1);
    const source = c.createMediaStreamSource(raw);
    const volume = c.createGain();
    volume.gain.value = gain;
    const out = c.createMediaStreamDestination();
    out.channelCount = channels;
    let bypass = null;
    if (model) {
      source.connect(model.node).connect(volume);
      bypass = () => {
        model.dispose();
        model = null;
        source.connect(volume);
      };
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
      if (model) model.dispose();
    };
    // If the mic is unplugged, the processed track ends with it.
    input.addEventListener('ended', () => track.stop());
    return out.stream;
  }

  return { wrap };
})();
