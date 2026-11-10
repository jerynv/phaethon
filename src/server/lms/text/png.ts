import zlib from "node:zlib";

/**
 * A small PNG writer (8-bit grey or RGB, or rows already PNG-filtered) and a
 * reader of a PNG's or JPEG's width and height from its header.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A PNG of `height` rows of `width * channels` bytes (or, when `filtered`,
 * each row led by its PNG filter byte). `channels` is 1 (grey) or 3 (RGB).
 * Null when the sizes don't add up.
 */
export function encodePng(width: number, height: number, channels: number, rows: Uint8Array, filtered: boolean): Buffer | null {
  if (width <= 0 || height <= 0 || (channels !== 1 && channels !== 3)) return null;
  const stride = width * channels;
  const want = (stride + (filtered ? 1 : 0)) * height;
  if (rows.length < want) return null;
  let raw: Buffer;
  if (filtered) raw = Buffer.from(rows.subarray(0, want));
  else {
    raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0;
      raw.set(rows.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array())]);
}

/** Width and height of a PNG or JPEG file, from its header. */
export function pngSizeOf(bytes: Uint8Array): [number, number] | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.subarray(0, 8).equals(SIGNATURE)) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (sof) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  return null;
}
