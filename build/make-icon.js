// Draws the Miserecord app icon (the aurora orb):
//   build/icon.png  512×512, for Electron and the installer
//   build/icon.ico  16–256 px in one file, so Windows shows a crisp icon on
//                   the taskbar, title bar, Start menu, desktop and tray
// Each size is drawn directly at that size, not scaled down, so small ones stay sharp.
// Run with: npm run icon
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const STOPS = ['#7AA2FF', '#B28BFF', '#FF8CC6', '#FFB77A', '#8EE3C8', '#7AA2FF'].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function conic(angle) {
  const t = ((angle / (2 * Math.PI)) % 1 + 1) % 1 * (STOPS.length - 1);
  const i = Math.floor(t);
  const f = t - i;
  return STOPS[i].map((c, k) => c + (STOPS[i + 1][k] - c) * f);
}

// RGBA pixels of the orb at the given size.
function drawOrb(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  // Small icons fill more of their square, as Windows icons usually do.
  const r = size * (size <= 32 ? 0.49 : 0.46);
  const ss = size <= 64 ? 8 : 4; // supersampling for a smooth edge
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const dx = px - cx;
          const dy = py - cy;
          if (dx * dx + dy * dy > r * r) continue;
          let [cr, cg, cb] = conic(Math.atan2(dy, dx) + Math.PI / 2);
          // soft white highlight at the top left, like the in-app orb
          const hx = px - (cx - r * 0.36);
          const hy = py - (cy - r * 0.44);
          const h = Math.max(0, 1 - Math.sqrt(hx * hx + hy * hy) / (r * 1.1));
          const w = Math.min(0.85, h * h * h * 1.3);
          cr += (255 - cr) * w; cg += (255 - cg) * w; cb += (255 - cb) * w;
          acc = [acc[0] + cr, acc[1] + cg, acc[2] + cb, acc[3] + 1];
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

const big = encodePng(512, drawOrb(512));
fs.writeFileSync(path.join(__dirname, 'icon.png'), big);
const ico = encodeIco(ICO_SIZES.map((size) => {
  const pixels = drawOrb(size);
  return { size, png: size >= 256 ? encodePng(size, pixels) : encodeBmpEntry(size, pixels) };
}));
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
console.log(`wrote build/icon.png (${big.length} bytes) and build/icon.ico (${ICO_SIZES.join(', ')} px, ${ico.length} bytes)`);
