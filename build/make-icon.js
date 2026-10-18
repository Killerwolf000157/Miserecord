// Draws the Miserecord app icon (the aurora orb) as build/icon.png, 512×512.
// Run with: npm run icon
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const STOPS = ['#7AA2FF', '#B28BFF', '#FF8CC6', '#FFB77A', '#8EE3C8', '#7AA2FF'].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

function conic(angle) {
  const t = ((angle / (2 * Math.PI)) % 1 + 1) % 1 * (STOPS.length - 1);
  const i = Math.floor(t);
  const f = t - i;
  return STOPS[i].map((c, k) => c + (STOPS[i + 1][k] - c) * f);
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
const cx = SIZE / 2;
const cy = SIZE / 2;
const r = SIZE * 0.46;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 4×4 supersampling for a smooth edge
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4;
        const py = y + (sy + 0.5) / 4;
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
    const o = (y * SIZE + x) * 4;
    if (acc[3]) {
      pixels[o] = Math.round(acc[0] / acc[3]);
      pixels[o + 1] = Math.round(acc[1] / acc[3]);
      pixels[o + 2] = Math.round(acc[2] / acc[3]);
      pixels[o + 3] = Math.round((acc[3] / 16) * 255);
    }
  }
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
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log(`wrote build/icon.png (${png.length} bytes)`);
