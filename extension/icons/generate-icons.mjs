/**
 * Generates the WatchSync extension icons (16/48/128) as valid PNGs using only
 * Node's built-in zlib — no third-party image libraries required.
 *
 * The icon is a rounded purple tile with a white lightning bolt, matching the
 * "⚡ WatchSync" brand. Run once with:  node icons/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

/* ---- minimal PNG encoder (RGBA, 8-bit) ---- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression, filter, interlace (all 0)

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- draw the icon ---- */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;

  // Diagonal purple gradient + rounded corners.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inCorner = (cx, cy) =>
        (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2;
      let outside = false;
      if (x < radius && y < radius && inCorner(radius, radius)) outside = true;
      if (x > size - radius && y < radius && inCorner(size - radius, radius)) outside = true;
      if (x < radius && y > size - radius && inCorner(radius, size - radius)) outside = true;
      if (x > size - radius && y > size - radius && inCorner(size - radius, size - radius)) outside = true;

      if (outside) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
        continue;
      }
      const t = (x + y) / (2 * size);
      rgba[i] = Math.round(108 + (162 - 108) * t); // R 6c -> a2
      rgba[i + 1] = Math.round(92 + (155 - 92) * t); // G 5c -> 9b
      rgba[i + 2] = Math.round(231 + (254 - 231) * t); // B e7 -> fe
      rgba[i + 3] = 255;
    }
  }

  // Lightning bolt (normalized polygon), filled white.
  const bolt = [
    [0.56, 0.12],
    [0.3, 0.56],
    [0.46, 0.56],
    [0.4, 0.88],
    [0.72, 0.42],
    [0.54, 0.42],
  ].map(([px, py]) => [px * size, py * size]);

  const inPoly = (px, py) => {
    let inside = false;
    for (let a = 0, b = bolt.length - 1; a < bolt.length; b = a++) {
      const [xa, ya] = bolt[a];
      const [xb, yb] = bolt[b];
      if (ya > py !== yb > py && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) {
        inside = !inside;
      }
    }
    return inside;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inPoly(x + 0.5, y + 0.5)) {
        const i = (y * size + x) * 4;
        if (rgba[i + 3] !== 0) {
          rgba[i] = 255;
          rgba[i + 1] = 255;
          rgba[i + 2] = 255;
          rgba[i + 3] = 255;
        }
      }
    }
  }

  return encodePng(size, size, rgba);
}

for (const size of [16, 48, 128]) {
  const png = drawIcon(size);
  writeFileSync(join(OUT_DIR, `icon${size}.png`), png);
  console.log(`Wrote icon${size}.png (${png.length} bytes)`);
}
