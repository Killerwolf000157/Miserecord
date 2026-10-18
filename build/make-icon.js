// Draws the Miserecord app icon: a white circle with a rainbow wave in the lower middle
// (the same design as build/logo-concept.svg and public/logo.svg).
//   build/icon.png  512×512, for Electron and the installer
//   build/icon.ico  16–256 px in one file, so Windows shows a crisp icon on
//                   the taskbar, title bar, Start menu, desktop and tray
// Each size is drawn directly at that size, not scaled down. Small sizes get a
// fuller circle and a thicker wave so the wave stays readable at 16 px.
// Run with: npm run icon
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// The app's aurora colors along the wave, left to right (x in 512-unit space).
const WAVE_STOPS = [[0, '#7AA2FF'], [0.3, '#B28BFF'], [0.58, '#FF8CC6'], [0.82, '#FFB77A'], [1, '#8EE3C8']].map(([t, c]) => [t, hex(c)]);
const WAVE_X0 = 138;
const WAVE_X1 = 374;
const FACE_IN = hex('#FFFFFF');
const FACE_OUT = hex('#E9EAF0');

// The wave's centre line, as in the SVG: M144 338 C 178 296, 226 300, 258 326 S 332 374, 370 330
const CURVES = [
  [[144, 338], [178, 296], [226, 300], [258, 326]],
  [[258, 326], [290, 352], [332, 374], [370, 330]],
];
const WAVE_POINTS = (() => {
  const pts = [];
  for (const [p0, p1, p2, p3] of CURVES) {
    for (let i = 0; i <= 80; i++) {
      const t = i / 80, u = 1 - t;
      pts.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
  }
  return pts;
})();

function distToWave(x, y) {
  let best = Infinity;
  for (let i = 1; i < WAVE_POINTS.length; i++) {
    const [ax, ay] = WAVE_POINTS[i - 1];
    const [bx, by] = WAVE_POINTS[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    const ex = x - (ax + t * dx), ey = y - (ay + t * dy);
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function waveColor(x) {
  const t = Math.max(0, Math.min(1, (x - WAVE_X0) / (WAVE_X1 - WAVE_X0)));
  for (let i = 1; i < WAVE_STOPS.length; i++) {
    const [t1, c1] = WAVE_STOPS[i];
    const [t0, c0] = WAVE_STOPS[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return c0.map((c, k) => c + (c1[k] - c) * f);
    }
  }
  return WAVE_STOPS[WAVE_STOPS.length - 1][1];
}

// RGBA pixels of the logo at the given size.
function drawLogo(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const k = size / 512; // pixels per design unit
  const small = size <= 32;
  const r = small ? 250 : 238; // circle radius in design units
  const half = size <= 24 ? 34 : size <= 48 ? 29 : 22; // half the wave's thickness
  const ss = size <= 64 ? 8 : size <= 128 ? 5 : 3; // supersampling
  const gx = 256 - r + 0.76 * r, gy = 256 - r + 0.6 * r, gr = 1.64 * r; // soft shading centre
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (x + (sx + 0.5) / ss) / k;
          const uy = (y + (sy + 0.5) / ss) / k;
          const dc = Math.hypot(ux - 256, uy - 256);
          if (dc > r) continue;
          let col;
          const nearWave = ux > 100 && ux < 412 && uy > 270 && uy < 410;
          if (nearWave && distToWave(ux, uy) <= half) {
            col = waveColor(ux);
          } else {
            const t = Math.min(1, Math.hypot(ux - gx, uy - gy) / gr);
            col = FACE_IN.map((c, i) => c + (FACE_OUT[i] - c) * t);
            // a faint edge so the circle holds up on light backgrounds
            if (r - dc < 1 / k) col = col.map((c) => c * 0.92);
          }
          acc = [acc[0] + col[0], acc[1] + col[1], acc[2] + col[2], acc[3] + 1];
        }
      }
      const o = (y * size + x) * 4;
      if (acc[3]) {
        pixels[o] = Math.round(acc[0] / acc[3]);
        pixels[o + 1] = Math.round(acc[1] / acc[3]);
        pixels[o + 2] = Math.round(acc[2] / acc[3]);
        pixels[o + 3] = Math.round((acc[3] / (ss * ss)) * 255);
      }
    }
  }
  return pixels;
}

// ---------------------------------------------------------------- minimal PNG encoder
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO container
// 256 px is stored as PNG; smaller sizes as classic 32-bit bitmaps, which every
// part of Windows can read (some older APIs can't decode small PNG entries).
function encodeBmpEntry(size, pixels) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height: color + mask
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  const color = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4; // bottom-up rows
      color[dst] = pixels[src + 2]; // B
      color[dst + 1] = pixels[src + 1]; // G
      color[dst + 2] = pixels[src]; // R
      color[dst + 3] = pixels[src + 3]; // A
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size); // all zero: transparency comes from alpha
  return Buffer.concat([header, color, mask]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size; // 0 means 256
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0; // no palette
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4); // color planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.png)]);
}

const big = encodePng(512, drawLogo(512));
fs.writeFileSync(path.join(__dirname, 'icon.png'), big);
const ico = encodeIco(ICO_SIZES.map((size) => {
  const pixels = drawLogo(size);
  return { size, png: size >= 256 ? encodePng(size, pixels) : encodeBmpEntry(size, pixels) };
}));
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
console.log(`wrote build/icon.png (${big.length} bytes) and build/icon.ico (${ICO_SIZES.join(', ')} px, ${ico.length} bytes)`);
