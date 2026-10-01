#!/usr/bin/env node
/* tools/png.mjs — 零依赖 PNG 编解码（归属：Lead）
 * 只支持 8bit RGBA/RGB 非隔行 PNG（Chromium 的 --screenshot 与 ImageData 输出都是这种）。
 * 用法（CLI）:
 *   node tools/png.mjs info  <a.png>
 *   node tools/png.mjs tojson <a.png> <out.json>     # {width,height,data:[r,g,b,a,...]} 稀疏化：只存非透明像素
 *   node tools/png.mjs crop  <in.png> <out.png> x y w h
 */
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

/* ---------------- 解码 ---------------- */

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit PNG，实际 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
          v = (v + pr) & 255; break;
        }
        default: throw new Error('未知行滤波 ' + filter);
      }
      line[x] = v;
    }
    line.copy(out, y * stride);
    prev = line;
  }

  // 统一成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b, a = 255;
    if (colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else if (colorType === 3) {
      const p = out[i]; r = palette[p * 3]; g = palette[p * 3 + 1]; b = palette[p * 3 + 2];
      a = trns && p < trns.length ? trns[p] : 255;
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, data: rgba };
}

/* ---------------- 编码 ---------------- */

export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer ? rgba.buffer : rgba, rgba.byteOffset || 0, rgba.length)
      .subarray(y * stride, y * stride + stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1);
}

/* ---------------- 便捷 ---------------- */

export function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

export function crop(img, x0, y0, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.width + (x0 + x)) * 4;
      const d = (y * w + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}

export function scaleNearest(img, factor) {
  const w = img.width * factor, h = img.height * factor;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 4;
      const d = (y * w + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/* ---------------- CLI ---------------- */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (process.argv[1] && process.argv[1].includes('png.mjs')) {
  const [cmd, a, b, cx, cy, cw, ch] = process.argv.slice(2);
  if (cmd === 'info') {
    const img = decodePNG(readFileSync(a));
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) opaque++;
    console.log(JSON.stringify({ file: a, width: img.width, height: img.height, opaque, total: img.width * img.height }));
  } else if (cmd === 'crop') {
    const img = decodePNG(readFileSync(a));
    const c = crop(img, +cx, +cy, +cw, +ch);
    writeFileSync(b, encodePNG(c.width, c.height, c.data));
    console.log(JSON.stringify({ out: b, width: c.width, height: c.height }));
  } else if (cmd === 'scale') {
    const img = decodePNG(readFileSync(a));
    const s = scaleNearest(img, +b);
    writeFileSync(process.argv[4], encodePNG(s.width, s.height, s.data));
    console.log(JSON.stringify({ out: process.argv[4], width: s.width, height: s.height }));
  } else {
    console.error('用法: node tools/png.mjs info|crop|scale <in.png> [out.png] [args]');
    process.exit(2);
  }
}
