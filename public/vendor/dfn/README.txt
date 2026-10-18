AI noise suppression for the microphone: DeepFilterNet3 (48 kHz, full voice band),
from @workadventure/noise-suppression 0.2.0 (MIT, https://github.com/workadventure/noise-suppression),
copied unchanged except for the removed source map comments. The folder layout matches
the package so deepfilternet.js finds its worklet, Wasm and model next to it.

  deepfilternet.js                          loader (ES module)
  assets/deepfilternet-worklet-processor.js the AudioWorklet processor
  assets/deepfilternet/df_bg.wasm           libDF (Rust) compiled to WebAssembly
  assets/deepfilternet/DeepFilterNet3_onnx.tar.gz  the DeepFilterNet3 model

DeepFilterNet (https://github.com/Rikorose/DeepFilterNet) is MIT / Apache-2.0 licensed.
