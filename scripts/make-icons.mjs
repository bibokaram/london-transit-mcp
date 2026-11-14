// Draws the app icon: line-coloured tracks on a dark tile. Writes PNGs with no image library.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const BG = hex('#16181c');
const BARS = [
  { y: 0.32, color: hex('#0098D4'), from: 0.2, to: 0.8 },
  { y: 0.5, color: hex('#E32017'), from: 0.2, to: 0.8 },
  { y: 0.68, color: hex('#FFD300'), from: 0.2, to: 0.8 },
];
const HALF_HEIGHT = 0.052;
const STOP_RADIUS = 0.085;
const STOP_X = 0.62;
const SAMPLES = 4;

function colorAt(x, y) {
  const dx = x - STOP_X;
  const dy = y - 0.5;
  if (dx * dx + dy * dy <= STOP_RADIUS * STOP_RADIUS) return [255, 255, 255];
  for (const bar of BARS) {
    const nearestX = Math.min(Math.max(x, bar.from), bar.to);
    const distX = x - nearestX;
    const distY = y - bar.y;
    if (distX * distX + distY * distY <= HALF_HEIGHT * HALF_HEIGHT) return bar.color;
  }
  return BG;
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let offset = 0;
  for (let py = 0; py < size; py++) {
    raw[offset++] = 0;
    for (let px = 0; px < size; px++) {
      const total = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = colorAt((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          total[0] += c[0]; total[1] += c[1]; total[2] += c[2];
        }
      }
      for (const channel of total) raw[offset++] = Math.round(channel / (SAMPLES * SAMPLES));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB, no alpha: iOS fills transparent icon pixels with black
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) writeFileSync(`public/icons/icon-${size}.png`, png(size));
