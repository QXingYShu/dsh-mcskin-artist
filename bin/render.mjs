#!/usr/bin/env node
/* bin/render.mjs — mcskin-artist 多视角 / 多姿态 3D 渲染（归属：skin-render）
 *
 * 契约：CONTRACT.md §2。给一张皮肤 PNG，产出：
 *   <outdir>/views/*.png     8 个视角（400×460，深色底）
 *   <outdir>/poses/*.png     4 个确定性冻结姿态（默认 front 视角）
 *   <outdir>/texture/*.png   贴图高清裁切（调 bin/skin.mjs crops，缺失则记 error 继续）
 *   <outdir>/report.json     产物清单（结构见 §2.1）
 *
 * 用法：
 *   node bin/render.mjs <skin.png> -o <outdir> [--views default|all|none|<v1,v2,..>]
 *     [--poses default|none|<p1,p2,..>] [--pose-views front] [--scale 1]
 *     [--no-crops] [--keep-temp] [--timeout ms] [--selftest]
 *
 * 依赖：bin/headless.mjs（无头浏览器）、harness/render.html（探针页）、
 *       bin/skin.mjs（可选，crops）；零外部依赖，stdout 只输出 JSON（§0.1）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(HERE, '../harness/render.html');
const HEADLESS = path.join(HERE, 'headless.mjs');
const SKIN_CLI = path.join(HERE, 'skin.mjs');
const SKIN_CORE = path.join(HERE, 'skin-core.mjs');
const LIB_PNG = path.resolve(HERE, '../lib/png.mjs');
const LIB_RULES = path.resolve(HERE, '../lib/rules.js');

const CANVAS = { width: 400, height: 460 };
const BACKGROUND = '#12141a';
const MAX_SCALE = 2;             // 受无头窗口尺寸限制（§2.2）
const MIN_PNG_BYTES = 1024;      // views/poses 每张 PNG 落盘后校验 > 1KB（渲染失败/空图判据）
const MIN_TEXTURE_BYTES = 64;    // texture 裁切的最小字节数（小于此值视为损坏/空文件）

/* 视角预设：id / yaw / pitch 严格按 CONTRACT.md §2.1 表格。
 * 相机约定：yaw=0 → 角色正面；yaw=-90 → 角色右侧面。 */
const VIEW_PRESETS = [
  { id: 'front', yaw: 0, pitch: 0, label: '正视' },
  { id: 'front34R', yaw: -35, pitch: 10, label: '前右 3/4（角色右侧）' },
  { id: 'front34L', yaw: 35, pitch: 10, label: '前左 3/4' },
  { id: 'back', yaw: 180, pitch: 0, label: '背面' },
  { id: 'sideR', yaw: -90, pitch: 0, label: '角色右侧面' },
  { id: 'sideL', yaw: 90, pitch: 0, label: '角色左侧面' },
  { id: 'top', yaw: 20, pitch: 65, label: '俯视' },
  { id: 'bottom', yaw: 200, pitch: -35, label: '仰视' }
];

/* 姿态预设：id / animation / time(s) 严格按 §2.1 表格 */
const POSE_PRESETS = [
  { id: 'idle_0', anim: 'idle', time: 0, label: '待机 0.00s' },
  { id: 'walk_25', anim: 'walk', time: 0.25, label: '行走 0.25s' },
  { id: 'walk_75', anim: 'walk', time: 0.75, label: '行走 0.75s' },
  { id: 'wave_60', anim: 'wave', time: 0.6, label: '挥手 0.60s' }
];

const USAGE = [
  '用法: node bin/render.mjs <skin.png> -o <outdir> [选项]',
  '  --views default|all|none|<v1,v2,..>   视角（默认 default = 8 张：' + VIEW_PRESETS.map((v) => v.id).join(',') + '）',
  '  --poses default|none|<p1,p2,..>       姿态（默认 default = 4 张：' + POSE_PRESETS.map((p) => p.id).join(',') + '）',
  '  --pose-views front|<v1,v2,..>         姿态帧的视角（默认 front）',
  '  --scale 1|2                           等比放大（默认 1，最大 ' + MAX_SCALE + '）',
  '  --no-crops                            跳过 bin/skin.mjs crops 贴图裁切',
  '  --keep-temp                           保留无头浏览器的临时目录（排错用）',
  '  --timeout <ms>                        无头页面虚拟时间预算（默认 20000）',
  '  --selftest                            自测（无浏览器时输出 {ok:true,skipped:"no-browser"}）'
].join('\n');

function msg(e) { return (e && e.message) ? e.message : String(e); }

function jsonOut(obj) { console.log(JSON.stringify(obj, null, 2)); }

/* 零依赖读取 PNG 尺寸（校验皮肤与产物用） */
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* ------------------------------------------------------------------ argv */

function parseArgs(argv) {
  const o = {
    skin: null, out: null,
    views: 'default', poses: 'default', poseViews: 'front',
    scale: 1, crops: true, keepTemp: false, timeout: 20000,
    selftest: false, help: false
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(a + ' 需要一个参数');
      return v;
    };
    if (a === '--selftest') o.selftest = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-o' || a === '--out') o.out = need();
    else if (a === '--views') o.views = need();
    else if (a === '--poses') o.poses = need();
    else if (a === '--pose-views') o.poseViews = need();
    else if (a === '--scale') o.scale = Number(need());
    else if (a === '--timeout') o.timeout = Number(need());
    else if (a === '--no-crops') o.crops = false;
    else if (a === '--crops') o.crops = true;
    else if (a === '--keep-temp') o.keepTemp = true;
    else if (a.startsWith('-')) throw new Error('未知参数: ' + a);
    else positional.push(a);
  }
  if (positional.length > 2) throw new Error('多余的位置参数: ' + positional.slice(1).join(' '));
  o.skin = positional[0] || null;
  if (positional.length === 2) throw new Error('只接受一个 <skin.png> 位置参数（输出目录请用 -o）');

  if (!Number.isFinite(o.scale) || o.scale < 1 || o.scale > MAX_SCALE) {
    throw new Error('--scale 必须是 1 或 ' + MAX_SCALE + ' 之间的数（受无头窗口尺寸限制），实际: ' + o.scale);
  }
  if (!Number.isFinite(o.timeout) || o.timeout < 1000) {
    throw new Error('--timeout 必须是 ≥1000 的毫秒数，实际: ' + o.timeout);
  }
  return o;
}

/* ------------------------------------------------------------------ 计划 */

function selectPresets(spec, presets, kind) {
  const s = String(spec === undefined || spec === null ? '' : spec).trim();
  if (s === '' || s === 'default' || s === 'all') return presets.slice();
  if (s === 'none') return [];
  const ids = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (!ids.length) return [];
  const out = [];
  for (const id of ids) {
    const p = presets.find((x) => x.id === id);
    if (!p) throw new Error('未知' + kind + ' id: ' + id + '（可用: ' + presets.map((x) => x.id).join(', ') + '）');
    if (!out.some((x) => x.id === id)) out.push(p);
  }
  return out;
}

/* 生成渲染计划：views 直接进 plan；poses 展开成「姿态 × 姿态视角」的帧列表，
 * 每条帧自带 yaw/pitch，harness 不需要再查预设表。 */
function buildPlan(opts) {
  const views = selectPresets(opts.views, VIEW_PRESETS, '视角').map((v) => ({ id: v.id, yaw: v.yaw, pitch: v.pitch }));
  const poses = selectPresets(opts.poses, POSE_PRESETS, '姿态');
  let poseViews = [];
  if (poses.length) {
    poseViews = selectPresets(opts.poseViews, VIEW_PRESETS, '姿态视角');
    if (!poseViews.length) throw new Error('--pose-views 不能为空：要跳过姿态帧请用 --poses none');
  }
  const frames = [];
  for (const p of poses) {
    for (const v of poseViews) {
      frames.push({
        id: poseViews.length === 1 ? p.id : p.id + '__' + v.id,
        poseId: p.id,
        anim: p.anim,
        time: p.time,
        view: v.id,
        yaw: v.yaw,
        pitch: v.pitch
      });
    }
  }
  if (!views.length && !frames.length) {
    throw new Error('没有任何视角或姿态需要渲染（--views none 且 --poses none）');
  }
  return { views, poses: frames };
}

/* 把 __SKIN__ / __PLAN__ 注入 harness/render.html（§2.2：由 render.mjs 生成注入文件）。
 * 注入页写在系统临时目录，页内相对 src（../lib/rules.js 等）会失效，
 * 所以这里统一把 <script src> 改写成绝对 file:// URL。 */
function buildInjectedHtml(plan, skinDataUrl) {
  let html = fs.readFileSync(HARNESS, 'utf8');
  html = html.replace(/(<script[^>]*\ssrc=")([^"]+)(")/g, (all, pre, src, post) => {
    if (/^(https?:|file:|data:|\/\/)/i.test(src)) return all;
    const abs = path.resolve(path.dirname(HARNESS), src);
    return pre + pathToFileURL(abs).href + post;
  });
  const inject = '<script>window.__SKIN__=' + JSON.stringify(skinDataUrl) +
    ';\nwindow.__PLAN__=' + JSON.stringify(plan) + ';</script>';
  if (html.indexOf('<!--__INJECT__-->') >= 0) return html.replace('<!--__INJECT__-->', inject);
  if (html.indexOf('</body>') >= 0) return html.replace('</body>', inject + '\n</body>');
  return html + inject;
}

/* ------------------------------------------------------------ 子进程封装 */

function writeDataUrl(file, dataurl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataurl || ''));
  if (!m) throw new Error('探针返回的 dataURL 不是 PNG base64：' + String(dataurl || '').slice(0, 60));
  const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

function probeBrowser() {
  if (!fs.existsSync(HEADLESS)) return { ok: false, error: '缺少 bin/headless.mjs: ' + HEADLESS };
  const r = spawnSync(process.execPath, [HEADLESS, '--probe'], { encoding: 'utf8', timeout: 30000 });
  if (r.error) return { ok: false, error: '探测浏览器失败：' + r.error.message };
  const text = String(r.stdout || '').trim();
  try { return JSON.parse(text); }
  catch (e) {
    return { ok: false, error: 'headless.mjs --probe 输出无法解析：' + (text.slice(0, 200) || String(r.stderr || '').slice(-200)) };
  }
}

function runHeadless(htmlPath, opts) {
  if (!fs.existsSync(HEADLESS)) return { ok: false, error: '缺少 bin/headless.mjs: ' + HEADLESS };
  const args = [
    HEADLESS, htmlPath,
    '--width', String(Math.round(CANVAS.width * opts.scale)),
    '--height', String(Math.round(CANVAS.height * opts.scale)),
    '--timeout', String(opts.timeout)
  ];
  if (opts.keepTemp) args.push('--keep');
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: Math.max(60000, opts.timeout * 4), maxBuffer: 256 * 1024 * 1024
  });
  if (r.error) return { ok: false, error: '启动 headless.mjs 失败：' + r.error.message };
  const text = String(r.stdout || '').trim();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!json) {
    return {
      ok: false,
      error: 'headless.mjs 未输出 JSON（exit ' + r.status + '）：' +
        (text.slice(0, 300) || String(r.stderr || '').slice(-300))
    };
  }
  return json;
}

/* --crops：spawn bin/skin.mjs crops。该文件由队友并行开发，可能不存在
 * → 用 existsSync 探测，缺失/失败都只记 error 并继续，绝不崩（CONTRACT §2.1）。 */
function runCrops(skinFile, dir, scale) {
  if (!fs.existsSync(SKIN_CLI)) return { files: [], error: 'skin.mjs unavailable' };
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.execPath, [SKIN_CLI, 'crops', skinFile, '-o', dir, '--scale', String(scale)], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024
  });
  if (r.error) return { files: [], error: 'skin.mjs crops 启动失败：' + r.error.message };
  const text = String(r.stdout || '').trim();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!json) {
    return {
      files: [],
      error: 'skin.mjs crops 输出无法解析（exit ' + r.status + '）：' +
        (text.slice(0, 200) || String(r.stderr || '').slice(-200))
    };
  }
  if (!json.ok) return { files: [], error: 'skin.mjs crops 失败：' + (json.error || '未知原因') };
  return { files: (json.files || []).map((f) => String(f).replace(/\\/g, '/')) };
}

/* ------------------------------------------------------------ 渲染主流程 */

function renderPlan(opts) {
  const errors = [];
  const notes = [];
  if (!fs.existsSync(HARNESS)) throw new Error('缺少 harness/render.html: ' + HARNESS);
  const skinFile = path.resolve(opts.skin);
  if (!fs.existsSync(skinFile)) throw new Error('皮肤文件不存在: ' + skinFile);
  const skinBuf = fs.readFileSync(skinFile);
  const size = pngSize(skinBuf);
  if (!size) throw new Error('不是合法的 PNG 文件: ' + skinFile);
  if (size.width !== 64 || (size.height !== 64 && size.height !== 32)) {
    throw new Error('只支持 64×64 或 64×32 皮肤，实际 ' + size.width + '×' + size.height);
  }
  const format = size.height === 32 ? 'legacy' : 'modern';
  const outDir = path.resolve(opts.out);
  const built = buildPlan(opts);
  const plan = {
    canvas: CANVAS,
    scale: opts.scale,
    background: BACKGROUND,
    format: size.width + 'x' + size.height,
    views: built.views,
    poses: built.poses.map((p) => ({ id: p.id, anim: p.anim, time: p.time, view: p.view, yaw: p.yaw, pitch: p.pitch }))
  };

  const probe = probeBrowser();
  if (!probe.ok) {
    throw new Error('找不到无头浏览器（Edge/Chrome）：' + (probe.error || '未知原因') +
      '；可退化用 bin/skin.mjs crops 做贴图裁切审查');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcskin-render-'));
  if (opts.keepTemp) notes.push('无头注入页保留在: ' + tmp);
  try {
    const htmlPath = path.join(tmp, 'render.injected.html');
    fs.writeFileSync(htmlPath, buildInjectedHtml(plan, 'data:image/png;base64,' + skinBuf.toString('base64')), 'utf8');

    const res = runHeadless(htmlPath, opts);
    if (!res.ok) throw new Error(res.error || 'headless 运行失败');
    const probeData = res.probe || {};
    if (probeData.parseError) {
      throw new Error('页面探针 JSON 解析失败：' + probeData.parseError + '（title=' + (res.title || '') + '）');
    }
    for (const e of (probeData.errors || [])) errors.push(String(e));
    const items = Array.isArray(probeData.items) ? probeData.items : [];
    if (!items.length) {
      throw new Error('渲染器没有产出任何图像（title=' + (res.title || '') + '）' +
        (errors.length ? '：' + errors.join('；') : ''));
    }
    const byId = new Map();
    for (const it of items) if (it && it.id) byId.set(it.id, it);

    fs.mkdirSync(path.join(outDir, 'views'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'poses'), { recursive: true });

    const writeShot = (rel, it, extra) => {
      let bytes = 0;
      try { bytes = writeDataUrl(path.join(outDir, rel), it.dataurl); }
      catch (e) { errors.push(rel + ' 落盘失败：' + msg(e)); return null; }
      if (bytes < MIN_PNG_BYTES) {
        errors.push(rel + ' 过小（' + bytes + ' 字节 < ' + MIN_PNG_BYTES + ' 字节），不计入产物');
        return null;
      }
      return Object.assign({ file: rel, bytes }, extra);
    };

    const viewEntries = [];
    for (const v of built.views) {
      const it = byId.get(v.id);
      if (!it) { errors.push('缺少视角图像: ' + v.id); continue; }
      const entry = writeShot('views/' + v.id + '.png', it, { id: v.id, yaw: v.yaw, pitch: v.pitch });
      if (entry) viewEntries.push(entry);
    }
    const poseEntries = [];
    for (const p of built.poses) {
      const it = byId.get(p.id);
      if (!it) { errors.push('缺少姿态图像: ' + p.id); continue; }
      const entry = writeShot('poses/' + p.id + '.png', it, {
        id: p.id, anim: p.anim, time: p.time, view: p.view
      });
      if (entry) poseEntries.push(entry);
    }

    let texture = [];
    if (opts.crops) {
      const dir = path.join(outDir, 'texture');
      const r = runCrops(skinFile, dir, 8);
      if (r.error) errors.push(r.error);
      else {
        for (const f of r.files) {
          const rel = (f.indexOf('texture/') === 0 ? f : 'texture/' + f).replace(/\\/g, '/');
          const abs = path.join(outDir, rel);
          if (!fs.existsSync(abs)) { errors.push('裁切文件缺失: ' + rel); continue; }
          const bytes = fs.statSync(abs).size;
          const head = pngSize(fs.readFileSync(abs));
          /* CONTRACT §2.1 把裁切固定为 8×，纯色肢体的裁切压缩后天然只有几百字节，
           * 那不是渲染失败 → 只对「损坏/几乎空」的文件记 error，小文件进 notes，
           * 文件本身照常进 texture[]（否则审查会漏掉整条腿/整只手）。 */
          if (!head || bytes < MIN_TEXTURE_BYTES) {
            errors.push('裁切文件损坏或为空: ' + rel + '（' + bytes + ' 字节）');
            continue;
          }
          if (bytes < MIN_PNG_BYTES) {
            notes.push(rel + ' 仅 ' + bytes + ' 字节（纯色区域 8× 裁切天然 <1KB，非渲染失败）');
          }
          texture.push(rel);
        }
      }
    }

    const report = {
      ok: (viewEntries.length + poseEntries.length) > 0,
      skin: opts.skin,
      format: plan.format,
      generatedAt: new Date().toISOString(),
      views: viewEntries,
      poses: poseEntries,
      texture,
      errors
    };
    if (notes.length) report.notes = notes;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

    return {
      ok: report.ok, out: outDir, report, views: viewEntries, poses: poseEntries, texture, errors, notes,
      format: plan.format, browser: probe.browser || null, title: res.title || null, headlessExitCode: res.exitCode
    };
  } finally {
    if (!opts.keepTemp) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
    }
  }
}

/* ------------------------------------------------------------ 自测辅助 */

/* CONTRACT §0.1：浏览器经典脚本在 Node 里用 Function 注入 window 加载 */
function loadRulesClassic() {
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const src = fs.readFileSync(LIB_RULES, 'utf8');
  new Function('window', 'globalThis', src)(globalThis.window, globalThis);
  return globalThis.window.MCSKIN;
}

/* 造一张有内容的 64×64 测试皮肤（selftest 用）：
 * 1) 首选 bin/skin.mjs new --template default（cli-main 并行开发，可能还没就绪）
 * 2) 退路 lib/rules.js defaultSkin() + lib/png.mjs encodePNG（只依赖 Lead 的 lib）
 * 3) 最后退路：手绘棋盘格（只保证几何体可见） */
async function makeTestSkin(dir) {
  const out = path.join(dir, 'selftest-skin.png');
  if (fs.existsSync(SKIN_CLI)) {
    const r = spawnSync(process.execPath, [SKIN_CLI, 'new', '-o', out, '--template', 'default'], {
      encoding: 'utf8', timeout: 60000
    });
    if (r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 100) {
      return { file: out, via: 'skin.mjs new --template default' };
    }
  }
  let png = null;
  try { png = await import(pathToFileURL(LIB_PNG).href); } catch (e) { png = null; }
  if (!png || typeof png.encodePNG !== 'function') {
    return { file: null, via: null, error: '既没有 bin/skin.mjs，也加载不到 lib/png.mjs' };
  }
  let data = null, via = 'lib-fallback';
  try {
    const m = loadRulesClassic();
    const def = m && m.rules && typeof m.rules.defaultSkin === 'function' ? m.rules.defaultSkin() : null;
    if (def && def.data && def.data.length >= 64 * 64 * 4) { data = def.data; via = 'rules.defaultSkin + lib/png.mjs'; }
  } catch (e) { /* 退到棋盘格 */ }
  if (!data) {
    data = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const on = (((x >> 2) + (y >> 2)) % 2) === 0;
        data[i] = on ? 180 : 60; data[i + 1] = on ? 90 : 60; data[i + 2] = on ? 70 : 60; data[i + 3] = 255;
      }
    }
    via = 'checkerboard + lib/png.mjs';
  }
  fs.writeFileSync(out, png.encodePNG(64, 64, data));
  return { file: out, via };
}

/* ------------------------------------------------------------ --selftest */

async function selftest() {
  const checks = [];
  const add = (id, ok, message, evidence) => checks.push({ id, ok: !!ok, message, evidence: evidence === undefined ? null : evidence });

  /* 1. 视角预设表必须与 CONTRACT §2.1 逐项一致 */
  const expectViews = [
    ['front', 0, 0], ['front34R', -35, 10], ['front34L', 35, 10], ['back', 180, 0],
    ['sideR', -90, 0], ['sideL', 90, 0], ['top', 20, 65], ['bottom', 200, -35]
  ];
  const viewDiff = [];
  for (const [id, yaw, pitch] of expectViews) {
    const p = VIEW_PRESETS.find((x) => x.id === id);
    if (!p || p.yaw !== yaw || p.pitch !== pitch) viewDiff.push(id + '→' + (p ? p.yaw + ',' + p.pitch : '缺失'));
  }
  add('views-preset', VIEW_PRESETS.length === expectViews.length && !viewDiff.length,
    '视角预设 8 项 id/yaw/pitch 与 §2.1 一致（yaw=0 为角色正面）', { diff: viewDiff });

  /* 2. 姿态预设表 */
  const expectPoses = [['idle_0', 'idle', 0], ['walk_25', 'walk', 0.25], ['walk_75', 'walk', 0.75], ['wave_60', 'wave', 0.6]];
  const poseDiff = [];
  for (const [id, anim, time] of expectPoses) {
    const p = POSE_PRESETS.find((x) => x.id === id);
    if (!p || p.anim !== anim || Math.abs(p.time - time) > 1e-9) poseDiff.push(id);
  }
  add('poses-preset', POSE_PRESETS.length === expectPoses.length && !poseDiff.length,
    '姿态预设 4 项 id/animation/time 与 §2.1 一致', { diff: poseDiff });

  /* 3. 计划生成 */
  let built = null;
  try { built = buildPlan({ views: 'default', poses: 'default', poseViews: 'front' }); } catch (e) { /* 断言会失败 */ }
  const p1 = built && built.poses[1];
  add('plan-default', !!built && built.views.length === 8 && built.poses.length === 4 &&
    !!p1 && p1.id === 'walk_25' && p1.anim === 'walk' && p1.time === 0.25 && p1.yaw === 0 && p1.pitch === 0 && p1.view === 'front',
    '默认计划 = 8 视角 + 4 姿态（walk_25 落在 front 视角 yaw=0/pitch=0）',
    built ? built.poses.map((p) => p.id + '@' + p.view) : null);

  let multi = null;
  try { multi = buildPlan({ views: 'none', poses: 'walk_25,wave_60', poseViews: 'front,sideR' }); } catch (e) { /* 断言会失败 */ }
  add('plan-multi-pose-view', !!multi && multi.views.length === 0 && multi.poses.length === 4 &&
    multi.poses[1].id === 'walk_25__sideR' && multi.poses[1].yaw === -90 && multi.poses[1].pitch === 0,
    '--pose-views 多视角时帧 id 加视角后缀并带各自 yaw/pitch',
    multi ? multi.poses.map((p) => p.id + ':' + p.yaw) : null);

  let threw = false, threwMsg = '';
  try { buildPlan({ views: 'nope', poses: 'none', poseViews: 'front' }); } catch (e) { threw = true; threwMsg = msg(e); }
  add('plan-invalid-id', threw, '未知视角 id 被拒绝并列出可用 id', threwMsg);

  let emptyRejected = false;
  try { buildPlan({ views: 'none', poses: 'none', poseViews: 'front' }); } catch (e) { emptyRejected = true; }
  add('plan-empty-rejected', emptyRejected, '--views none 且 --poses none 被拒绝（没有可渲染项）');

  /* 4. 注入文件生成 */
  let html = '';
  const stubPlan = {
    canvas: CANVAS, scale: 1, background: BACKGROUND, format: '64x64',
    views: [{ id: 'front', yaw: 0, pitch: 0 }], poses: []
  };
  try { html = buildInjectedHtml(stubPlan, 'data:image/png;base64,AAAA'); } catch (e) { /* 断言会失败 */ }
  add('inject-html', html.indexOf('window.__SKIN__=') >= 0 && html.indexOf('window.__PLAN__=') >= 0 &&
    html.indexOf('<!--__INJECT__-->') < 0 && html.indexOf('renderer3d.js') >= 0 &&
    html.indexOf('src="file://') >= 0,
    '注入文件含 __SKIN__/__PLAN__、占位符已替换、lib 引用改写成绝对 file:// URL', { bytes: html.length });

  let parsed = null;
  const mm = /window\.__PLAN__=([\s\S]*?);<\/script>/.exec(html);
  if (mm) { try { parsed = JSON.parse(mm[1]); } catch (e) { parsed = null; } }
  add('inject-plan-json', !!parsed && parsed.canvas.width === 400 && parsed.canvas.height === 460 &&
    parsed.views.length === 1 && parsed.views[0].id === 'front',
    '注入的 __PLAN__ 可被 JSON.parse 还原', parsed ? { canvas: parsed.canvas, views: parsed.views.length } : null);

  /* 5. 浏览器探测；没有浏览器就跳过真渲染，但仍要 exit 0 */
  const probe = probeBrowser();
  add('browser-probe', true,
    probe.ok ? '找到无头浏览器: ' + probe.browser : '未找到无头浏览器：' + (probe.error || '未知') +
      '（跳过真实渲染，退化为 crops 裁切审查）',
    probe.ok ? { browser: probe.browser } : { error: probe.error });

  const summarize = () => {
    const failed = checks.filter((c) => !c.ok);
    return {
      ok: failed.length === 0,
      pass: checks.length - failed.length,
      fail: failed.length,
      failures: failed.map((c) => c.id + ': ' + c.message),
      checks
    };
  };
  if (!probe.ok) { const s = summarize(); s.skipped = 'no-browser'; return s; }

  /* 6. 最小计划真跑：views=front, poses=walk_25, --no-crops */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcskin-selftest-'));
  try {
    const made = await makeTestSkin(tmp);
    add('test-skin', !!made.file && fs.existsSync(made.file) && fs.statSync(made.file).size > 100,
      '测试皮肤已生成（' + (made.via || '失败') + '）', { file: made.file, via: made.via, error: made.error || null });
    if (!made.file) return summarize();

    const base = { skin: made.file, scale: 1, crops: false, keepTemp: false, timeout: 20000 };
    const out = path.join(tmp, 'review');
    const res = renderPlan(Object.assign({}, base, { out, views: 'front', poses: 'walk_25', poseViews: 'front' }));
    add('render-view-front', res.views.length === 1 && res.views[0].id === 'front' &&
      res.views[0].bytes >= MIN_PNG_BYTES && res.views[0].yaw === 0 && res.views[0].pitch === 0 &&
      res.views[0].file === 'views/front.png',
      'front 视角 PNG ≥1KB，yaw/pitch 与预设一致', res.views);
    add('render-pose-walk25', res.poses.length === 1 && res.poses[0].id === 'walk_25' &&
      res.poses[0].anim === 'walk' && res.poses[0].time === 0.25 && res.poses[0].bytes >= MIN_PNG_BYTES &&
      res.poses[0].file === 'poses/walk_25.png',
      'walk_25 姿态 PNG ≥1KB（确定性问题见下一条）', res.poses);

    const png1 = pngSize(fs.readFileSync(path.join(out, 'views', 'front.png')));
    add('png-header', !!png1 && png1.width === CANVAS.width && png1.height === CANVAS.height,
      '产物是 ' + CANVAS.width + '×' + CANVAS.height + ' 的合法 PNG', png1);
    add('no-crops-dir', !fs.existsSync(path.join(out, 'texture')),
      '--no-crops 时不生成 texture/ 目录、不调用 skin.mjs');

    let rep = null;
    try { rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')); } catch (e) { rep = null; }
    add('report-fields', !!rep && rep.ok === true && rep.views.length === 1 && rep.poses.length === 1 &&
      Array.isArray(rep.texture) && Array.isArray(rep.errors) && rep.format === '64x64' &&
      typeof rep.generatedAt === 'string' && typeof rep.skin === 'string',
      'report.json 结构齐全（ok/skin/format/generatedAt/views/poses/texture/errors）',
      rep ? { format: rep.format, errors: rep.errors } : null);
    add('probe-no-errors', !!rep && rep.errors.length === 0, '最小渲染的 errors 为空', rep ? rep.errors : null);

    /* 姿态冻结的确定性：同一姿态两次渲染必须字节一致 */
    const out2 = path.join(tmp, 'review2');
    const res2 = renderPlan(Object.assign({}, base, { out: out2, views: 'none', poses: 'walk_25', poseViews: 'front' }));
    const b1 = fs.readFileSync(path.join(out, 'poses', 'walk_25.png'));
    const b2 = fs.readFileSync(path.join(out2, 'poses', 'walk_25.png'));
    add('pose-deterministic', res2.poses.length === 1 && b1.length === b2.length && b1.equals(b2),
      'walk_25 两次渲染字节完全一致（setAnimation+setAnimationTime+pauseAnimation+setAutoRotate 生效）',
      { bytes1: b1.length, bytes2: b2.length });

    /* --crops 默认开：skin.mjs 就绪时产出裁切且无假错误；缺失时必须容错继续 */
    const out3 = path.join(tmp, 'review3');
    const res3 = renderPlan(Object.assign({}, base, { out: out3, views: 'front', poses: 'none', poseViews: 'front', crops: true }));
    if (fs.existsSync(SKIN_CLI)) {
      add('crops-texture', res3.ok === true && res3.texture.length > 0 &&
        res3.texture.some((f) => /full_4x\.png$/.test(f)) && res3.texture.some((f) => /_8x\.png$/.test(f)) &&
        !res3.errors.some((e) => /过小|损坏|unavailable/.test(e)),
        'crops 默认开：产出 texture/full_4x.png + <part>_8x.png 且无假错误',
        { texture: res3.texture, errors: res3.errors });
    } else {
      add('crops-unavailable-tolerant', res3.ok === true && res3.errors.indexOf('skin.mjs unavailable') >= 0,
        'skin.mjs 缺失时记 "skin.mjs unavailable" 并继续（不崩、ok 仍为 true）', { errors: res3.errors });
    }
  } catch (e) {
    add('render-run', false, '最小渲染失败：' + msg(e));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  return summarize();
}

/* ------------------------------------------------------------ CLI 入口 */

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { jsonOut({ ok: false, error: msg(e), usage: USAGE }); process.exitCode = 2; return; }

  if (opts.help) {
    jsonOut({ ok: true, usage: USAGE, views: VIEW_PRESETS, poses: POSE_PRESETS, canvas: CANVAS, maxScale: MAX_SCALE });
    return;
  }

  if (opts.selftest) {
    let r;
    try { r = await selftest(); }
    catch (e) { jsonOut({ ok: false, error: 'selftest 异常：' + msg(e) }); process.exitCode = 1; return; }
    jsonOut(r);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (!opts.skin) { jsonOut({ ok: false, error: '缺少 <skin.png> 参数', usage: USAGE }); process.exitCode = 2; return; }
  if (!opts.out) { jsonOut({ ok: false, error: '缺少 -o <outdir> 参数', usage: USAGE }); process.exitCode = 2; return; }

  try {
    const r = renderPlan(opts);
    jsonOut({
      ok: r.ok,
      out: r.out,
      skin: opts.skin,
      format: r.format,
      report: path.join(r.out, 'report.json'),
      views: r.views,
      poses: r.poses,
      texture: r.texture,
      errors: r.errors,
      notes: r.notes,
      browser: r.browser
    });
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    jsonOut({ ok: false, error: msg(e) });
    process.exitCode = 1;
  }
}

export { VIEW_PRESETS, POSE_PRESETS, CANVAS, buildPlan, buildInjectedHtml, renderPlan, selftest, parseArgs, pngSize };

const invokedDirectly = !!process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  main().catch((e) => { jsonOut({ ok: false, error: '未捕获异常：' + msg(e) }); process.exitCode = 1; });
}
/* ==== END OF FILE ==== */
