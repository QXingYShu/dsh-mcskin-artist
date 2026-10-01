#!/usr/bin/env node
/* skin-core.mjs —— mcskin-artist 的核心库（归属：Lead）
 *
 * 纯函数库：不做 argv 解析、不写 stdout、不 exit。
 * 供 bin/skin.mjs 调用；接口见 CONTRACT_CORE.md §1，lint 规则见 CONTRACT.md §1.2。
 *
 * 依赖：../lib/rules.js、../lib/model.js（浏览器经典脚本，Node 里用 Function 注入 window 加载）、
 *       ../lib/png.mjs（ESM，零依赖 PNG 编解码）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG, crop as pngCrop, scaleNearest } from '../lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '../lib');

/* 面镜像配对（与 rules/tools/verify_legacy.mjs 完全一致） */
const MIRROR_FACE = { right: 'left', left: 'right', front: 'front', back: 'back', top: 'top', bottom: 'bottom' };
const BASE_PARTS = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
const OUTER_PARTS = ['hat', 'jacket', 'rightSleeve', 'leftSleeve', 'rightPants', 'leftPants'];
const FACE_ORDER = ['right', 'front', 'left', 'back', 'top', 'bottom'];
const ANCHOR_PART = { hat: 'head', jacket: 'body', rightSleeve: 'rightArm', leftSleeve: 'leftArm', rightPants: 'rightLeg', leftPants: 'leftLeg' };

/* ------------------------------------------------------------------ 载入 rules/model */

let _MCSKIN = null;
function MCSKIN() {
  if (_MCSKIN) return _MCSKIN;
  const g = globalThis;
  g.window = g.window || g;
  const load = (file) => {
    const src = fs.readFileSync(path.join(LIB, file), 'utf8');
    // 经典脚本：注入 window，脚本内部写 window.MCSKIN.*
    new Function('window', 'globalThis', src)(g.window, g);
  };
  load('rules.js');
  load('model.js');
  _MCSKIN = g.window.MCSKIN;
  return _MCSKIN;
}

export function rules() { return MCSKIN().rules; }
export function partsList() {
  const R = rules();
  return R.BOXES.map((b) => ({ id: b.id, part: b.part || b.id, layer: b.layer, label: R.PART_LABEL[b.id] || (R.PART_LABEL[b.part] || b.id) }));
}

/* ------------------------------------------------------------------ 解析 */

export function parseColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3) {
      const v = h.split('').map((c) => parseInt(c + c, 16));
      if (v.some((n) => !Number.isFinite(n))) return null;
      return [v[0], v[1], v[2], 255];
    }
    if (h.length === 6 || h.length === 8) {
      const v = [];
      for (let i = 0; i < h.length; i += 2) {
        const n = parseInt(h.slice(i, i + 2), 16);
        if (!Number.isFinite(n)) return null;
        v.push(n);
      }
      return h.length === 6 ? [v[0], v[1], v[2], 255] : [v[0], v[1], v[2], v[3]];
    }
    return null;
  }
  const parts = s.split(',').map((x) => x.trim());
  if (parts.length !== 3 && parts.length !== 4) return null;
  const nums = parts.map((x) => (x === '' ? NaN : Number(x)));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return [Math.round(nums[0]), Math.round(nums[1]), Math.round(nums[2]), nums.length === 4 ? Math.round(nums[3]) : 255];
}

export function parseCoord(str) {
  if (typeof str !== 'string') return null;
  const p = str.split(',').map((x) => Number(x.trim()));
  if (p.length !== 2 || p.some((n) => !Number.isInteger(n))) return null;
  return { x: p[0], y: p[1] };
}

export function parseRect(str) {
  if (typeof str !== 'string') return null;
  const p = str.split(',').map((x) => Number(x.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return null;
  return { x0: p[0], y0: p[1], x1: p[2], y1: p[3] };
}

export function hexOf(rgba) {
  const h = (v) => { const s = Math.max(0, Math.min(255, Math.round(v))).toString(16); return s.length < 2 ? '0' + s : s; };
  return '#' + h(rgba[0]) + h(rgba[1]) + h(rgba[2]) + (rgba[3] < 255 ? h(rgba[3]) : '');
}

/* ------------------------------------------------------------------ 文件 IO */

function toClamped(data) {
  return data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.length) : data);
}

export function loadSkin(file) {
  if (!fs.existsSync(file)) throw new Error('皮肤文件不存在: ' + file);
  const img = decodePNG(fs.readFileSync(file));
  const w = img.width, h = img.height;
  if (h !== 32 && h !== 64) throw new Error('只支持 64×64 或 64×32 的皮肤 PNG，实际 ' + w + '×' + h);
  if (w !== 64) throw new Error('皮肤宽度必须是 64，实际 ' + w);
  return { w, h, format: h === 32 ? 'legacy' : 'modern', data: toClamped(img.data), file };
}

export function saveSkin(file, skin) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, encodePNG(skin.w, skin.h, skin.data));
  return { file, w: skin.w, h: skin.h, bytes: fs.statSync(file).size };
}

export function newSkin(size = 64, template = 'blank') {
  const R = rules();
  if (size === 32) {
    if (template === 'default') {
      // 用默认皮肤的左半（64×32 旧版布局）作为起始内容
      const def = R.defaultSkin();
      const d = new Uint8ClampedArray(64 * 32 * 4);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
        const s = (y * 64 + x) * 4, t = (y * 64 + x) * 4;
        d[t] = def.data[s]; d[t + 1] = def.data[s + 1]; d[t + 2] = def.data[s + 2]; d[t + 3] = def.data[s + 3];
      }
      return { w: 64, h: 32, format: 'legacy', data: d };
    }
    return { w: 64, h: 32, format: 'legacy', data: new Uint8ClampedArray(64 * 32 * 4) };
  }
  if (template === 'default') {
    const def = R.defaultSkin();
    return { w: 64, h: 64, format: 'modern', data: toClamped(def.data) };
  }
  return { w: 64, h: 64, format: 'modern', data: new Uint8ClampedArray(64 * 64 * 4) };
}

export function convertLegacy(skin32) {
  const R = rules();
  const out = R.convertLegacy64x32(toClamped(skin32.data));
  return { w: 64, h: 64, format: 'modern', data: toClamped(out.data) };
}

export function regionAt(x, y, opts) {
  try { return rules().regionAt(x, y, opts || {}); } catch (e) { return null; }
}

/* ------------------------------------------------------------------ 像素基础 */

export function getPixel(skin, x, y) {
  if (x < 0 || y < 0 || x >= skin.w || y >= skin.h) return [0, 0, 0, 0];
  const i = (y * skin.w + x) * 4;
  return [skin.data[i], skin.data[i + 1], skin.data[i + 2], skin.data[i + 3]];
}

function samePx(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }

export function setPixels(skin, entries) {
  const edits = [];
  for (const e of entries) {
    if (!e) continue;
    const { x, y } = e;
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (x < 0 || y < 0 || x >= skin.w || y >= skin.h) continue;
    const before = getPixel(skin, x, y);
    const rgba = e.rgba;
    if (samePx(before, rgba)) continue;
    const i = (y * skin.w + x) * 4;
    skin.data[i] = rgba[0]; skin.data[i + 1] = rgba[1]; skin.data[i + 2] = rgba[2]; skin.data[i + 3] = rgba[3];
    edits.push({ x, y, rgba: rgba.slice() });
  }
  return { changed: edits.length, edits };
}

export function boundsFromRegion(region) {
  // rules.regionAt 返回的 rect 是半开 [x0,y0,x1,y1)；本库所有边界都用「含端点」[x0,y0,x1,y1]
  if (!region || !region.rect || region.rect.length < 4) return null;
  const r = region.rect;
  return [r[0], r[1], r[2] - 1, r[3] - 1];
}

export function fillOp(skin, x, y, rgba, opts = {}) {
  if (x < 0 || y < 0 || x >= skin.w || y >= skin.h) return { changed: 0, edits: [] };
  const target = getPixel(skin, x, y);
  if (samePx(target, rgba)) return { changed: 0, edits: [] };
  // boundsRegion 兼容两种形状：数组 [x0,y0,x1,y1] 或对象 {x0,y0,x1,y1}，都是「含端点」
  const b = opts.boundsRegion || null;
  const bb = b ? (Array.isArray(b) ? [b[0], b[1], b[2], b[3]] : [b.x0, b.y0, b.x1, b.y1]) : null;
  const inBounds = (px, py) => !bb || (px >= bb[0] && py >= bb[1] && px <= bb[2] && py <= bb[3]);
  const seen = new Uint8Array(skin.w * skin.h);
  const queue = [[x, y]];
  const edits = [];
  seen[y * skin.w + x] = 1;
  while (queue.length) {
    const [cx, cy] = queue.pop();
    if (!inBounds(cx, cy)) continue;
    if (!samePx(getPixel(skin, cx, cy), target)) continue;
    const i = (cy * skin.w + cx) * 4;
    skin.data[i] = rgba[0]; skin.data[i + 1] = rgba[1]; skin.data[i + 2] = rgba[2]; skin.data[i + 3] = rgba[3];
    edits.push({ x: cx, y: cy, rgba: rgba.slice() });
    const nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
    for (const [nx, ny] of nb) {
      if (nx < 0 || ny < 0 || nx >= skin.w || ny >= skin.h) continue;
      const k = ny * skin.w + nx;
      if (seen[k]) continue;
      seen[k] = 1;
      queue.push([nx, ny]);
    }
  }
  return { changed: edits.length, edits };
}

export function rectOp(skin, x0, y0, x1, y1, rgba, opts = {}) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1), by = Math.max(y0, y1);
  const entries = [];
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) entries.push({ x, y, rgba });
  if (opts.outline) {
    for (let y = ay; y <= by; y++) {
      entries.push({ x: ax, y, rgba: opts.outline });
      entries.push({ x: bx, y, rgba: opts.outline });
    }
    for (let x = ax; x <= bx; x++) {
      entries.push({ x, y: ay, rgba: opts.outline });
      entries.push({ x, y: by, rgba: opts.outline });
    }
  }
  return setPixels(skin, entries);
}

export function lineOp(skin, x0, y0, x1, y1, rgba) {
  const entries = [];
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, guard = 0;
  for (;;) {
    entries.push({ x, y, rgba });
    if ((x === x1 && y === y1) || ++guard > 100000) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return setPixels(skin, entries);
}

/* 逐面水平镜像：把 srcBox 的 6 个面写到 dstBox 的镜像面 */
function mirrorBox(skin, srcBox, dstBox, entries) {
  for (const f of FACE_ORDER) {
    const s = srcBox.faces[f].px, d = dstBox.faces[MIRROR_FACE[f]].px;
    const w = s[2] - s[0], h = s[3] - s[1];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = getPixel(skin, s[0] + (w - 1 - x), s[1] + y);
        entries.push({ x: d[0] + x, y: d[1] + y, rgba: px });
      }
    }
  }
}

export function mirrorLimbsOp(skin, opts = {}) {
  const R = rules();
  const box = (id) => R.box(id);
  const entries = [];
  const mirrored = [];
  mirrorBox(skin, box('rightArm'), box('leftArm'), entries);
  mirrorBox(skin, box('rightLeg'), box('leftLeg'), entries);
  mirrored.push('rightArm→leftArm', 'rightLeg→leftLeg');
  if (opts.includeOuter) {
    mirrorBox(skin, box('rightSleeve'), box('leftSleeve'), entries);
    mirrorBox(skin, box('rightPants'), box('leftPants'), entries);
    mirrored.push('rightSleeve→leftSleeve', 'rightPants→leftPants');
  }
  const res = setPixels(skin, entries);
  return { changed: res.changed, edits: res.edits, mirrored };
}

/* ------------------------------------------------------------------ 统计 */

export function paletteOf(skin, limit = 30) {
  const counts = new Map();
  for (let y = 0; y < skin.h; y++) {
    for (let x = 0; x < skin.w; x++) {
      const c = getPixel(skin, x, y);
      if (c[3] === 0) continue;
      const k = c[0] + ',' + c[1] + ',' + c[2] + ',' + c[3];
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const colors = [...counts.entries()].map(([k, count]) => {
    const [r, g, b, a] = k.split(',').map(Number);
    return { hex: hexOf([r, g, b, a]), count, rgba: [r, g, b, a] };
  }).sort((a, b) => b.count - a.count);
  return { distinct: colors.length, colors: colors.slice(0, limit) };
}

function faceStats(skin, rect) {
  let opaque = 0, edge = 0, pairs = 0;
  const colors = new Set();
  let sum = [0, 0, 0];
  const { px } = rect;
  for (let y = px[1]; y < px[3]; y++) {
    for (let x = px[0]; x < px[2]; x++) {
      const c = getPixel(skin, x, y);
      if (c[3] === 0) continue;
      opaque++;
      colors.add(c[0] + ',' + c[1] + ',' + c[2]);
      sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
      // 与自己右边、下边的邻居比较（都要求不透明）
      for (const [nx, ny] of [[x + 1, y], [x, y + 1]]) {
        if (nx >= px[2] || ny >= px[3]) continue;
        const n = getPixel(skin, nx, ny);
        if (n[3] === 0) continue;
        pairs++;
        const d = Math.abs(c[0] - n[0]) + Math.abs(c[1] - n[1]) + Math.abs(c[2] - n[2]);
        if (d > 30) edge++;
      }
    }
  }
  return {
    opaque,
    distinctColors: colors.size,
    mean: opaque ? [Math.round(sum[0] / opaque), Math.round(sum[1] / opaque), Math.round(sum[2] / opaque)] : null,
    edgeRatio: pairs ? edge / pairs : 0,
    edgePairs: pairs, edgeCount: edge
  };
}

export function partsOf(skin) {
  const R = rules();
  return R.BOXES.map((b) => {
    const faces = {};
    let total = 0;
    for (const f of FACE_ORDER) {
      const st = faceStats(skin, { px: b.faces[f].px });
      faces[f] = { opaque: st.opaque, distinctColors: st.distinctColors, mean: st.mean, edgeRatio: +st.edgeRatio.toFixed(3) };
      total += st.opaque;
    }
    return { part: b.id, layer: b.layer, label: (R.PART_LABEL[b.id] || b.id), totalOpaque: total, faces };
  });
}

/* ------------------------------------------------------------------ 裁切导出 */

export function cropsOf(skin, outDir, scale = 8) {
  fs.mkdirSync(outDir, { recursive: true });
  const R = rules();
  const img = { width: skin.w, height: skin.h, data: skin.data };
  const files = [];

  const full = scaleNearest(img, 4);
  const fullName = 'full_4x.png';
  fs.writeFileSync(path.join(outDir, fullName), encodePNG(full.width, full.height, full.data));
  files.push(fullName);

  for (const b of R.BOXES) {
    let minX = 64, minY = 64, maxX = 0, maxY = 0, opaque = 0;
    for (const f of FACE_ORDER) {
      const p = b.faces[f].px;
      minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[2]); maxY = Math.max(maxY, p[3]);
    }
    for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) if (getPixel(skin, x, y)[3] > 0) opaque++;
    if (!opaque) continue;
    const c = pngCrop(img, minX, minY, maxX - minX, maxY - minY);
    const s = scaleNearest(c, scale);
    const name = b.id + '_' + scale + 'x.png';
    fs.writeFileSync(path.join(outDir, name), encodePNG(s.width, s.height, s.data));
    files.push(name);
  }
  return files;
}

/* 供 cli-main 复用的常量 */
export const CONST = { MIRROR_FACE, BASE_PARTS, OUTER_PARTS, FACE_ORDER, ANCHOR_PART, LIB };

/* ================================================================== lint 审查引擎
 * 12 个检查项 + 计分，规则见 CONTRACT.md §1.2（id/级别/证据固定）
 * ================================================================== */

export function gradeOf(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  return 'D';
}

function countOpaqueInRect(skin, px) {
  let n = 0;
  for (let y = px[1]; y < px[3]; y++) for (let x = px[0]; x < px[2]; x++) if (getPixel(skin, x, y)[3] > 0) n++;
  return n;
}

export function lintSkin(skin, opts = {}) {
  const R = rules();
  const w = skin.w, h = skin.h, data = skin.data;
  const checks = [];
  const add = (id, level, msg, evidence) => checks.push({ id, level, msg, evidence: evidence || {} });

  /* 区域掩码：所有盒的 6 个面 UV 矩形的并集 */
  const mask = new Uint8Array(w * h);
  for (const b of R.BOXES) {
    for (const f of FACE_ORDER) {
      const p = b.faces[f].px;
      for (let y = p[1]; y < p[3]; y++) for (let x = p[0]; x < p[2]; x++) mask[y * w + x] = 1;
    }
  }

  /* 1) format */
  if (w === 64 && h === 64) add('format', 'pass', '64×64 现代格式', { w, h, format: 'modern' });
  else if (w === 64 && h === 32) add('format', 'pass', '64×32 旧版格式（可 convert 升级）', { w, h, format: 'legacy' });
  else add('format', 'fail', '尺寸不支持：需要 64×64 或 64×32', { w, h });

  /* 2) outside-pixels */
  let outside = 0; const outSamples = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0 && !mask[y * w + x]) {
        outside++;
        if (outSamples.length < 8) outSamples.push({ x, y });
      }
    }
  }
  add('outside-pixels', outside ? 'fail' : 'pass',
    outside ? `有 ${outside} 个不透明像素不在任何部位区域内（脏点/越界）` : '所有不透明像素都属于有效部位区域',
    { count: outside, samples: outSamples });

  /* 3) empty-base-part */
  const parts = partsOf(skin);
  const baseParts = parts.filter((p) => p.layer === 'base');
  const painted = baseParts.filter((p) => p.totalOpaque > 0).length;
  const missing = baseParts.filter((p) => p.totalOpaque === 0).map((p) => p.part);
  if (painted > 0 && missing.length) {
    add('empty-base-part', 'warn', `基础层有 ${missing.length} 个部位完全空白：${missing.join('、')}`, { missing });
  } else {
    add('empty-base-part', 'pass', painted === 0 ? '皮肤整体为空（尚未开始画）' : '基础层 6 个部位都有内容', { missing });
  }

  /* 4) content-coverage —— 内容量：空白/半成品不能算合格成品 */
  let totalOpaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) totalOpaque++;
  if (totalOpaque === 0) {
    add('content-coverage', 'fail', '皮肤是空的：还没有画任何像素', { totalOpaque: 0 });
  } else if (totalOpaque < 1200) {
    add('content-coverage', 'warn', `内容偏少：只有 ${totalOpaque} 个不透明像素（完整皮肤通常 ≥2500）`, { totalOpaque });
  } else {
    add('content-coverage', 'pass', `内容量正常（${totalOpaque} 个不透明像素）`, { totalOpaque });
  }

  /* 5) base-alpha */
  let semi = 0;
  for (const b of R.BOXES) {
    if (b.layer !== 'base') continue;
    for (const f of FACE_ORDER) {
      const p = b.faces[f].px;
      for (let y = p[1]; y < p[3]; y++) for (let x = p[0]; x < p[2]; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (a > 0 && a < 255) semi++;
      }
    }
  }
  add('base-alpha', semi ? 'warn' : 'pass',
    semi ? `基础层有 ${semi} 个半透明像素（官方内层会强制不透明，建议改回 255）` : '基础层像素不透明度正常',
    { count: semi });

  /* 5) flat-face */
  const flat = baseParts.filter((p) => p.totalOpaque > 20 && p.faces.front.distinctColors === 1).map((p) => p.part);
  add('flat-face', flat.length ? 'warn' : 'pass',
    flat.length ? `这些部件的正面只有一种颜色，缺少细节：${flat.join('、')}` : '已绘制部件的正面都有颜色变化',
    { parts: flat });

  /* 6) low-detail（边缘能量） */
  let edgeSum = 0, pairSum = 0;
  for (const b of R.BOXES) {
    if (b.layer !== 'base') continue;
    for (const f of FACE_ORDER) {
      const st = faceStats(skin, { px: b.faces[f].px });
      edgeSum += st.edgeCount; pairSum += st.edgePairs;
    }
  }
  const edgeRatio = pairSum ? edgeSum / pairSum : 0;
  if (painted === 0) add('low-detail', 'info', '皮肤还是空的，暂不评估细节密度', { edgeRatio: 0 });
  else if (edgeRatio < 0.10) add('low-detail', 'fail', `细节严重不足：边缘能量 ${edgeRatio.toFixed(3)} < 0.10（几乎全是整块平涂）`, { edgeRatio: +edgeRatio.toFixed(3) });
  else if (edgeRatio < 0.18) add('low-detail', 'warn', `细节偏少：边缘能量 ${edgeRatio.toFixed(3)} < 0.18（大面积平涂）`, { edgeRatio: +edgeRatio.toFixed(3) });
  else add('low-detail', 'pass', `细节密度合格：边缘能量 ${edgeRatio.toFixed(3)}`, { edgeRatio: +edgeRatio.toFixed(3) });

  /* 7) noise（孤立噪点） */
  const nbsOf = (x, y) => {
    const out = [];
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return null;
      const j = (ny * w + nx) * 4;
      if (data[j + 3] === 0) return null;
      out.push([data[j], data[j + 1], data[j + 2]]);
    }
    return out;
  };
  const dist3 = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  let noise = 0; const noiseSamples = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) continue;
      const nbs = nbsOf(x, y);
      if (!nbs) continue;
      const c = [data[i], data[i + 1], data[i + 2]];
      if (!nbs.every((n) => dist3(n, c) > 60)) continue;
      let similar = 0;
      for (let a = 0; a < 4; a++) for (let b2 = a + 1; b2 < 4; b2++) if (dist3(nbs[a], nbs[b2]) < 20) similar++;
      if (similar >= 5) { noise++; if (noiseSamples.length < 8) noiseSamples.push({ x, y }); }
    }
  }
  add('noise', noise > 4 ? 'warn' : 'pass',
    noise > 4 ? `有 ${noise} 个孤立噪点（与四周都不连色）` : (noise ? `少量孤立像素 ${noise} 个（可接受）` : '没有孤立噪点'),
    { count: noise, samples: noiseSamples });

  /* 8) palette-size / 9) palette-dupes */
  const pal = paletteOf(skin, 200);
  add('palette-size', pal.distinct > 40 ? 'warn' : 'pass',
    pal.distinct > 40 ? `颜色过多：${pal.distinct} 种（建议 ≤40，风格会更统一）` : `调色板规模合适（${pal.distinct} 种颜色）`,
    { distinct: pal.distinct });
  let dupeGroups = 0; const dupeSamples = [];
  for (let i = 0; i < pal.colors.length; i++) {
    for (let j = i + 1; j < pal.colors.length; j++) {
      const d = dist3(pal.colors[i].rgba, pal.colors[j].rgba);
      if (d > 0 && d <= 6) { dupeGroups++; if (dupeSamples.length < 10) dupeSamples.push({ a: pal.colors[i].hex, b: pal.colors[j].hex, distance: d }); }
    }
  }
  add('palette-dupes', dupeGroups ? 'info' : 'pass',
    dupeGroups ? `有 ${dupeGroups} 组近似重复颜色（差值 ≤6），可以合并` : '没有近似重复颜色',
    { groups: dupeSamples, count: dupeGroups });

  /* 10) outer-unused */
  const outerOpaque = parts.filter((p) => p.layer === 'outer').reduce((s, p) => s + p.totalOpaque, 0);
  if (skin.format === 'modern' && outerOpaque === 0) {
    add('outer-unused', 'warn', '外层（帽子/外套/袖/裤）完全没用：加头发或衣摆会明显提升层次感', { outerOpaque: 0 });
  } else {
    add('outer-unused', 'pass', `外层已使用（${outerOpaque} 像素）`, { outerOpaque });
  }

  /* 11) mirror-balance（信息项） */
  const ra = parts.find((p) => p.part === 'rightArm'), la = parts.find((p) => p.part === 'leftArm');
  let balance = null;
  if (ra && la && ra.faces.front.mean && la.faces.front.mean) balance = dist3(ra.faces.front.mean, la.faces.front.mean);
  add('mirror-balance', 'info',
    balance === null ? '左右臂正面暂无可比较内容' : `左右臂正面平均色差 ${balance}（0 表示完全一致）`,
    { distance: balance });

  /* 12) legacy */
  if (skin.format === 'legacy') add('legacy', 'info', '当前是旧版 64×32：建议先 convert 成 64×64 再精修（左右肢体可独立编辑）', { format: 'legacy' });
  else add('legacy', 'pass', '现代 64×64 格式，左右肢体可独立编辑', { format: 'modern' });

  /* 计分：100 - 25×fail - 6×warn，clamp[0,100] */
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const score = Math.max(0, Math.min(100, 100 - 25 * fails - 6 * warns));

  return {
    ok: true,
    file: opts.file || null,
    format: skin.format,
    score,
    grade: gradeOf(score),
    checks,
    summary: { fail: fails, warn: warns, info: checks.filter((c) => c.level === 'info').length, pass: checks.filter((c) => c.level === 'pass').length },
    palette: { distinct: pal.distinct, top: pal.colors.slice(0, 10).map((c) => ({ hex: c.hex, count: c.count })) },
    parts: parts.map((p) => ({
      part: p.part, layer: p.layer, opaque: p.totalOpaque,
      frontDistinctColors: p.faces.front.distinctColors, frontEdgeRatio: p.faces.front.edgeRatio
    }))
  };
}

/* ================================================================== 自测（纯内存） */

export function selftest() {
  const pass = [], fail = [];
  const ok = (name, cond, extra) => { if (cond) pass.push(name); else fail.push(name + (extra === undefined ? '' : ' — ' + JSON.stringify(extra))); };
  const R = rules();

  /* 解析 */
  ok('#rgb → 展开为 6 位', JSON.stringify(parseColor('#f00')) === JSON.stringify([255, 0, 0, 255]));
  ok('#rrggbbaa → 带 alpha', JSON.stringify(parseColor('#0a0b0c80')) === JSON.stringify([10, 11, 12, 128]));
  ok('r,g,b,a → 数组', JSON.stringify(parseColor('1,2,3,4')) === JSON.stringify([1, 2, 3, 4]));
  ok('非法颜色返回 null', parseColor('zzz') === null && parseColor('#12') === null && parseColor('1,2') === null);
  ok('parseCoord / parseRect', JSON.stringify(parseCoord('3,4')) === '{"x":3,"y":4}' && parseRect('1,2,3,4').x1 === 3 && parseCoord('a,1') === null);

  /* new / convert */
  const blank = newSkin(64, 'blank');
  ok('newSkin blank 全透明', blank.data.every((v) => v === 0) && blank.format === 'modern');
  const def = newSkin(64, 'default');
  let defOpaque = 0;
  for (let i = 3; i < def.data.length; i += 4) if (def.data[i] > 0) defOpaque++;
  ok('newSkin default 有内容且不透明像素 > 1000', defOpaque > 1000, defOpaque);
  ok('newSkin 32 → legacy 且高 32', newSkin(64, 'blank').h === 64 && newSkin(32, 'blank').h === 32);

  /* 基本操作 */
  const s = newSkin(64, 'blank');
  const r1 = rectOp(s, 20, 20, 27, 31, [255, 0, 0, 255]);
  ok('rect 填充 8×12=96 像素', r1.changed === 96, r1.changed);
  ok('rect 含端点 (20,20) 与 (27,31)', getPixel(s, 20, 20)[0] === 255 && getPixel(s, 27, 31)[0] === 255);
  const l1 = lineOp(s, 0, 0, 5, 0, [0, 255, 0, 255]);
  ok('line 画 6 个像素', l1.changed === 6, l1.changed);
  const set1 = setPixels(s, [{ x: 1, y: 1, rgba: [1, 2, 3, 255] }, { x: 1, y: 1, rgba: [1, 2, 3, 255] }]);
  ok('set 相同颜色只计 1 次改动', set1.changed === 1, set1.changed);
  const outOfRange = setPixels(s, [{ x: 999, y: 999, rgba: [1, 2, 3, 255] }]);
  ok('set 越界坐标被忽略', outOfRange.changed === 0);

  /* fill（经典洪水 + 区域边界） */
  const f1 = fillOp(s, 60, 60, [9, 9, 9, 255]);
  ok('fill 经典洪水会填满连通空白区', f1.changed > 3000, f1.changed);
  ok('fill 不覆盖已画的红块', getPixel(s, 22, 25)[0] === 255 && getPixel(s, 22, 25)[1] === 0);
  const boundsSkin = newSkin(64, 'blank');
  const f2 = fillOp(boundsSkin, 2, 2, [7, 7, 7, 255], { boundsRegion: [0, 0, 7, 7] });
  ok('fill --bounds region 不越出指定矩形', f2.changed === 64 && f2.edits.every((e) => e.x <= 7 && e.y <= 7), f2.changed);

  /* mirror-limbs */
  const m = newSkin(64, 'blank');
  const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255], [255, 0, 255, 255], [0, 255, 255, 255]];
  FACE_ORDER.forEach((f, idx) => {
    const p = R.box('rightArm').faces[f].px;
    const c = colors[idx];
    for (let y = p[1]; y < p[3]; y++) for (let x = p[0]; x < p[2]; x++) setPixels(m, [{ x, y, rgba: c }]);
  });
  const mm = mirrorLimbsOp(m, {});
  ok('mirror-limbs 产生改动', mm.changed > 0, mm.changed);
  let mirrorOk = true, mirrorBad = null;
  for (const f of FACE_ORDER) {
    const sb = R.box('rightArm').faces[f].px, db = R.box('leftArm').faces[MIRROR_FACE[f]].px;
    const w2 = sb[2] - sb[0], h2 = sb[3] - sb[1];
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        const a = getPixel(m, sb[0] + (w2 - 1 - x), sb[1] + y);
        const b2 = getPixel(m, db[0] + x, db[1] + y);
        if (JSON.stringify(a) !== JSON.stringify(b2)) { mirrorOk = false; if (!mirrorBad) mirrorBad = { face: f, x, y, got: b2, want: a }; }
      }
    }
  }
  ok('mirror-limbs 逐面水平镜像（外↔内换位）正确', mirrorOk, mirrorBad);
  const mo = mirrorLimbsOp(newSkin(64, 'blank'), { includeOuter: true });
  ok('mirror-limbs --include-outer 也镜像袖/裤', mo.mirrored.length === 4, mo.mirrored);

  /* convertLegacy */
  const leg = newSkin(32, 'blank');
  rectOp(leg, 44, 20, 47, 31, [200, 10, 10, 255]);   // 旧版右臂「正面」区 [44,20,48,32]
  const conv = convertLegacy(leg);
  ok('convertLegacy 输出 64×64 modern', conv.w === 64 && conv.h === 64 && conv.format === 'modern');
  ok('convertLegacy 左臂正面区有内容（逐面镜像补齐）', countOpaqueInRect(conv, R.box('leftArm').faces.front.px) > 0,
    countOpaqueInRect(conv, R.box('leftArm').faces.front.px));

  /* 统计 */
  ok('paletteOf 统计出 ≥3 种颜色', paletteOf(s, 10).distinct >= 3, paletteOf(s, 10).distinct);
  ok('partsOf 返回 12 个盒', partsOf(s).length === 12);

  /* lint：正反例 + 计分公式 */
  const blankLint = lintSkin(newSkin(64, 'blank'), { file: 'blank.png' });
  ok('lint 全透明 → empty-base-part 判为 pass（还没开始画，不算漏画）',
    blankLint.checks.some((c) => c.id === 'empty-base-part' && c.level === 'pass'));
  ok('lint 全透明 → outer-unused 警告', blankLint.checks.some((c) => c.id === 'outer-unused' && c.level === 'warn'));
  ok('lint 空皮肤不报 outside-pixels', blankLint.checks.some((c) => c.id === 'outside-pixels' && c.level === 'pass'));

  const partialSkin = newSkin(64, 'blank');
  rectOp(partialSkin, 20, 20, 27, 31, [80, 120, 90, 255]);   // 只画躯干
  const partialLint = lintSkin(partialSkin, {});
  const ebp = partialLint.checks.find((c) => c.id === 'empty-base-part');
  ok('lint 只画躯干 → empty-base-part 警告并列出缺失部位',
    ebp && ebp.level === 'warn' && Array.isArray(ebp.evidence.missing) && ebp.evidence.missing.length === 5,
    ebp && ebp.evidence);

  const outSkin = newSkin(64, 'default');
  setPixels(outSkin, [{ x: 0, y: 0, rgba: [1, 2, 3, 255] }]);   // (0,0) 不属于任何部位
  const outLint = lintSkin(outSkin, {});
  ok('lint 越界像素 → outside-pixels fail 且扣 25 分',
    outLint.checks.some((c) => c.id === 'outside-pixels' && c.level === 'fail') && outLint.score <= 75, outLint.score);

  const flatSkin = newSkin(64, 'blank');
  rectOp(flatSkin, 20, 20, 27, 31, [5, 5, 5, 255]);
  const flatLint = lintSkin(flatSkin, {});
  ok('lint 躯干正面单色 → flat-face 警告', flatLint.checks.some((c) => c.id === 'flat-face' && c.level === 'warn'));
  const fCount = flatLint.checks.filter((c) => c.level === 'fail').length;
  const wCount = flatLint.checks.filter((c) => c.level === 'warn').length;
  ok('lint 计分公式 = 100-25×fail-6×warn', flatLint.score === Math.max(0, Math.min(100, 100 - 25 * fCount - 6 * wCount)),
    { score: flatLint.score, fCount, wCount });
  ok('lint grade 与 score 一致', flatLint.grade === gradeOf(flatLint.score));
  ok('lint 报告含 13 个检查项', flatLint.checks.length === 13, flatLint.checks.length);
  ok('lint 空皮肤 → content-coverage fail（不能放行空皮）',
    lintSkin(newSkin(64, 'blank'), {}).checks.some((c) => c.id === 'content-coverage' && c.level === 'fail'));
  ok('lint 空皮肤分数 < 70（低于 B 级门槛）', lintSkin(newSkin(64, 'blank'), {}).score < 70,
    lintSkin(newSkin(64, 'blank'), {}).score);
  ok('lint 默认皮肤 → content-coverage pass',
    lintSkin(newSkin(64, 'default'), {}).checks.some((c) => c.id === 'content-coverage' && c.level === 'pass'));

  /* crops */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcskin-core-'));
  try {
    const files = cropsOf(newSkin(64, 'default'), tmp, 8);
    ok('cropsOf 产出 full_4x + 各部件图（≥5 个文件）', files.includes('full_4x.png') && files.length >= 5, files.length);
    ok('cropsOf 文件都非空', files.every((n) => fs.statSync(path.join(tmp, n)).size > 100));
  } catch (e) {
    fail.push('cropsOf 抛异常 — ' + e.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { ok: fail.length === 0, pass: pass.length, fail: fail.length, failures: fail };
}
