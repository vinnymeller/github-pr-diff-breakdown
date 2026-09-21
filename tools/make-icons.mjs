// Generates the extension icons: three stacked bars of different lengths, which
// is what the extension actually draws. No image dependency, no binary blobs in
// review — run `npm run icons` to regenerate.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { crc32 } from './crc32.mjs';

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BARS = [
  { width: 0.92, color: hex('#4493f8') },
  { width: 0.58, color: hex('#ab7df8') },
  { width: 0.34, color: hex('#7d8590') },
];

function draw(size) {
  const pad = size * 0.09;
  const gap = size * 0.09;
  const barHeight = (size - pad * 2 - gap * 2) / 3;
  const radius = Math.min(barHeight / 2, size * 0.09);

  return (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    for (let i = 0; i < BARS.length; i++) {
      const top = pad + i * (barHeight + gap);
      const left = pad;
      const right = pad + (size - pad * 2) * BARS[i].width;
      if (py < top || py > top + barHeight || px < left || px > right) continue;

      // Round the caps so the shape survives being scaled down to 16px.
      const cx = Math.min(Math.max(px, left + radius), right - radius);
      const cy = Math.min(Math.max(py, top + radius), top + barHeight - radius);
      const d = Math.hypot(px - cx, py - cy);
      if (d > radius + 0.5) continue;
      const alpha = Math.round(255 * Math.min(1, Math.max(0, radius + 0.5 - d)));
      return [...BARS[i].color, alpha];
    }
    return [0, 0, 0, 0];
  };
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = new URL(`../icons/icon-${size}.png`, import.meta.url);
  writeFileSync(file, png(size, draw(size)));
  console.log(`icons/icon-${size}.png`);
}
