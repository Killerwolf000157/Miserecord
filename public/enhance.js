// Stream enhancement on the viewer's GPU, for native streams: frames are drawn
// through two WebGL passes before they're shown.
//   1. Catmull-Rom bicubic upscaling to the screen's size when the stream is
//      smaller (sharper than the browser's bilinear stretch).
//   2. RCAS, the contrast-adaptive sharpening from AMD FidelityFX FSR 1 (MIT):
//      sharpens each pixel only as far as its neighbours allow, so detail softened
//      by compression comes back without halos or ringing.
'use strict';

const Enhance = (() => {
  const VERT = `#version 300 es
  in vec2 p; out vec2 uv;
  void main() { uv = p * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;

  // Catmull-Rom with 9 bilinear taps (the classic optimisation of 16 taps).
  const UPSCALE = `#version 300 es
  precision highp float;
  uniform sampler2D src; uniform vec2 size; in vec2 uv; out vec4 o;
  void main() {
    vec2 pos = uv * size, t1 = floor(pos - 0.5) + 0.5, f = pos - t1;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2, o12 = w2 / w12;
    vec2 p0 = (t1 - 1.0) / size, p3 = (t1 + 2.0) / size, p12 = (t1 + o12) / size;
    vec3 c = vec3(0.0);
    c += texture(src, vec2(p0.x, p0.y)).rgb * w0.x * w0.y;
    c += texture(src, vec2(p12.x, p0.y)).rgb * w12.x * w0.y;
    c += texture(src, vec2(p3.x, p0.y)).rgb * w3.x * w0.y;
    c += texture(src, vec2(p0.x, p12.y)).rgb * w0.x * w12.y;
    c += texture(src, vec2(p12.x, p12.y)).rgb * w12.x * w12.y;
    c += texture(src, vec2(p3.x, p12.y)).rgb * w3.x * w12.y;
    c += texture(src, vec2(p0.x, p3.y)).rgb * w0.x * w3.y;
    c += texture(src, vec2(p12.x, p3.y)).rgb * w12.x * w3.y;
    c += texture(src, vec2(p3.x, p3.y)).rgb * w3.x * w3.y;
    o = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`;

  // FSR 1 RCAS (robust contrast-adaptive sharpening), per channel.
  const RCAS = `#version 300 es
  precision highp float;
  uniform sampler2D src; uniform float sharpness; in vec2 uv; out vec4 o;
  void main() {
    // The first pass already wrote the picture the right way up into its texture.
    ivec2 q = ivec2(gl_FragCoord.xy);
    vec3 b = texelFetch(src, q + ivec2(0, -1), 0).rgb;
    vec3 d = texelFetch(src, q + ivec2(-1, 0), 0).rgb;
    vec3 e = texelFetch(src, q, 0).rgb;
    vec3 f = texelFetch(src, q + ivec2(1, 0), 0).rgb;
    vec3 h = texelFetch(src, q + ivec2(0, 1), 0).rgb;
    vec3 mn = min(min(b, d), min(f, h));
    vec3 mx = max(max(b, d), max(f, h));
    vec3 hitMin = mn / (4.0 * mx + 1e-5);
    vec3 hitMax = (1.0 - mx) / (4.0 * mn - 4.0 - 1e-5);
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * sharpness;
    o = vec4(clamp((lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0), 0.0, 1.0), 1.0);
  }`;

  function create() {
    const canvas = new OffscreenCanvas(16, 16);
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = (frag) => {
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, frag));
      gl.bindAttribLocation(p, 0, 'p');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    const up = program(UPSCALE);
    const cas = program(RCAS);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const texture = (filter) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const srcTex = texture(gl.LINEAR);
    const midTex = texture(gl.NEAREST);
    const fbo = gl.createFramebuffer();
    let midW = 0, midH = 0;

    // frame: a decoded VideoFrame. Returns a new VideoFrame (outW x outH); the
    // caller closes the original.
    function process(frame, outW, outH, sharpness = 0.6) {
      const w = frame.displayWidth, h = frame.displayHeight;
      if (canvas.width !== outW || canvas.height !== outH) { canvas.width = outW; canvas.height = outH; }
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      // pass 1: upscale into a texture of the output size (a plain copy at 1:1)
      if (midW !== outW || midH !== outH) {
        gl.bindTexture(gl.TEXTURE_2D, midTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, outW, outH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        midW = outW; midH = outH;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, midTex, 0);
      gl.viewport(0, 0, outW, outH);
      gl.useProgram(up);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(gl.getUniformLocation(up, 'src'), 0);
      gl.uniform2f(gl.getUniformLocation(up, 'size'), w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // pass 2: sharpen onto the canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, outW, outH);
      gl.useProgram(cas);
      gl.bindTexture(gl.TEXTURE_2D, midTex);
      gl.uniform1i(gl.getUniformLocation(cas, 'src'), 0);
      gl.uniform1f(gl.getUniformLocation(cas, 'sharpness'), sharpness);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return new VideoFrame(canvas, { timestamp: frame.timestamp });
    }

    return { process };
  }

  // The size to show a stream at: the screen's height (physical pixels) when the
  // stream is smaller, at most twice the stream; otherwise its own size.
  function outputSize(w, h) {
    const screenH = Math.round((window.screen.height || 1080) * (window.devicePixelRatio || 1));
    // Capped at 1440p: beyond that the frames get heavy, and the screen's own scaling
    // of an already sharp 1440p picture is fine.
    const target = Math.min(screenH, 1440, h * 2);
    if (target <= h) return [w, h];
    return [Math.round((w * target) / h / 2) * 2, Math.round(target / 2) * 2];
  }

  return { create, outputSize };
})();
