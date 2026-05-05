import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function radialGradientPng(size: number, inner: [number, number, number], outer: [number, number, number]): Buffer {
  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(rowLen * size);
  const cx = size / 2, cy = size / 2, maxR = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const t = Math.min(1, Math.sqrt(dx * dx + dy * dy) / maxR);
      const r = Math.round(inner[0] * (1 - t) + outer[0] * t);
      const g = Math.round(inner[1] * (1 - t) + outer[1] * t);
      const b = Math.round(inner[2] * (1 - t) + outer[2] * t);
      const o = y * rowLen + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }

  // overlay a white "H" by stamping pixel rows (no font; geometric strokes)
  const stroke = Math.round(size * 0.09);
  const xL = Math.round(size * 0.32);
  const xR = Math.round(size * 0.59);
  const yT = Math.round(size * 0.28);
  const yB = Math.round(size * 0.72);
  const yMidT = Math.round(size * 0.46);
  const yMidB = Math.round(size * 0.54);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inLeft = x >= xL && x < xL + stroke && y >= yT && y < yB;
      const inRight = x >= xR && x < xR + stroke && y >= yT && y < yB;
      const inBar = y >= yMidT && y < yMidB && x >= xL && x < xR + stroke;
      if (inLeft || inRight || inBar) {
        const o = y * rowLen + 1 + x * 4;
        raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255;
      }
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const cache = new Map<number, Buffer>();
export function hermesIconPng(size: number): Buffer {
  let cached = cache.get(size);
  if (cached) return cached;
  cached = radialGradientPng(size, [167, 139, 250], [76, 29, 149]); // violet-400 → violet-900
  cache.set(size, cached);
  return cached;
}
