// Rasterises the app icon to PNG (needed for iOS home screens and Android).
// Usage: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) * (512 / size), (y + 0.5) * (512 / size));
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [11, 16, 32], GREEN = [61, 220, 132];
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

function arch(x, y, cx, cy, rx, ry, w) {
  if (y > cy) return 0;
  const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
  const d = Math.abs(r - 1) * Math.min(rx, ry);
  return Math.max(0, Math.min(1, w / 2 - d + 0.5));
}

function pixel(x, y) {
  let c = BG;
  c = mix(c, GREEN, 0.5 * arch(x, y, 256, 380, 106, 140, 32));
  c = mix(c, GREEN, arch(x, y, 256, 380, 184, 250, 40));
  return [...c, 255]; // full-bleed square so it also works as a maskable icon
}

for (const size of [192, 512]) writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), png(size, pixel));
console.log('icons written');
