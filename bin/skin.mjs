#!/usr/bin/env node
/**
 * mcskin-artist —— bin/skin.mjs（命令行外壳 / CLI shell）
 *
 * 职责边界（见 CONTRACT_CORE.md）：本文件只做
 *   1) argv 解析（-o/--out、--size、--template、--bounds、--outline、--include-outer、--limit、--scale）
 *   2) 调度 bin/skin-core.mjs 的纯函数
 *   3) 按 CONTRACT.md §1.1/§1.2 输出 stdout 纯 JSON、错误 exit 1
 * 本文件**不实现**任何像素算法与 lint 打分（全部在 bin/skin-core.mjs）。
 *
 * 运行环境：Node ≥18、零外部依赖、离线可用。stdout 只输出 JSON，进度/警告走 stderr。
 *
 * 用法：node bin/skin.mjs <command> [args...]
 *   new      -o <out> [--size 64|32] [--template blank|default]
 *   convert  <legacy.png> -o <out>
 *   info     <skin>
 *   pixel    <skin> <x>,<y>
 *   set      <skin> <x>,<y>,<color> [<x>,<y>,<color> ...]
 *   fill     <skin> <x>,<y>,<color> [--bounds region]
 *   rect     <skin> <x0>,<y0>,<x1>,<y1>,<color> [--outline <color>]
 *   line     <skin> <x0>,<y0>,<x1>,<y1>,<color>
 *   mirror-limbs <skin> [--include-outer]
 *   palette  <skin> [--limit 30]
 *   parts    <skin>
 *   crops    <skin> -o <dir> [--scale 8]
 *   lint     <skin> [--json]
 *   run      <script.txt> <skin> [-o <out>]
 *   selftest
 *
 * 颜色：'#rgb' | '#rrggbb' | '#rrggbbaa' | 'r,g,b' | 'r,g,b,a'（0-255）
 * 坐标：'x,y'；矩形 'x0,y0,x1,y1'（**含端点**）
 */

import fs from 'node:fs';
import path from 'node:path';

/* ══════════════════════════════════════════════════════════════════════
 * 0. 基础工具：JSON 输出 / 错误 / 路径 / core 懒加载
 * ══════════════════════════════════════════════════════════════════════ */

/** usage 只写 stderr —— stdout 必须永远是纯 JSON */
const USAGE = `mcskin-artist CLI（node bin/skin.mjs <command> [args...]）

绘制： new / convert / pixel / set / fill / rect / line / mirror-limbs
审查： info / palette / parts / crops / lint
批量： run <script.txt> <skin> [-o <out>]
其他： selftest

公共选项：-o/--out <file|dir>   --size 64|32   --template blank|default
          --bounds region      --outline <color>          --include-outer
          --limit <n>          --scale <n>                --json
颜色：'#rgb' | '#rrggbb' | '#rrggbbaa' | 'r,g,b' | 'r,g,b,a'
坐标：'x,y'（点）、'x0,y0,x1,y1'（矩形，含端点）
`;

/** 唯一允许写 stdout 的函数 */
function writeJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 警告/进度 → stderr */
function warn(msg) {
  process.stderr.write('[mcskin] ' + msg + '\n');
}

/** 抛错 → 由顶层 catch 转成 {"ok":false,"error"} + exit 1 */
function die(msg) {
  throw new Error(String(msg && msg.message ? msg.message : msg));
}

function mkdirp(dir) {
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolvePath(p, what) {
  if (typeof p !== 'string' || p.trim() === '') die('缺少' + (what || '路径') + '参数');
  return path.resolve(p);
}

/** 读取文本文件（UTF-8） */
function readText(p, what) {
  const abs = resolvePath(p, what);
  try {
    return { path: abs, text: fs.readFileSync(abs, 'utf8') };
  } catch (e) {
    die('无法读取' + (what || '文件') + ' ' + abs + '：' + (e && e.message ? e.message : e));
  }
}

let _core = null;
/** 懒加载 skin-core.mjs：core 缺失时给出可读的 JSON 错误而不是裸 ERR_MODULE_NOT_FOUND + 堆栈 */
async function getCore() {
  if (_core) return _core;
  try {
    _core = await import('./skin-core.mjs');
  } catch (e) {
    die('无法加载 bin/skin-core.mjs：' + (e && e.message ? e.message : e));
  }
  return _core;
}

/** 断言 core 导出了所需函数后再取用 */
async function needCore(...names) {
  const c = await getCore();
  for (const n of names) {
    if (typeof c[n] !== 'function') die('bin/skin-core.mjs 缺少导出函数 ' + n + '()');
  }
  return c;
}

/** 写盘（core.saveSkin 可能是同步或异步） */
async function saveSkinTo(core, outPath, skin) {
  mkdirp(path.dirname(outPath));
  await core.saveSkin(outPath, skin);
  return outPath;
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. argv 解析
 * ══════════════════════════════════════════════════════════════════════ */

/** 需要取值的选项 → 内部字段名 */
const VALUE_FLAGS = {
  '-o': 'out', '--out': 'out',
  '--size': 'size',
  '--template': 'template',
  '--bounds': 'bounds',
  '--outline': 'outline',
  '--limit': 'limit',
  '--scale': 'scale',
};

/** 布尔开关 → 内部字段名 */
const BOOL_FLAGS = {
  '--include-outer': 'includeOuter',
  '--json': 'json',
  '-h': 'help', '--help': 'help',
};

/**
 * 解析命令之后的参数。
 * 返回 { positional, flags, bools }；flags 为对象（可能带 --flag=value 写法）。
 */
function parseArgv(argv) {
  const positional = [];
  const flags = {};
  const bools = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }

    let name = a;
    let inline = null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { name = a.slice(0, eq); inline = a.slice(eq + 1); }
    }

    if (BOOL_FLAGS[name]) { bools[BOOL_FLAGS[name]] = true; continue; }

    if (VALUE_FLAGS[name]) {
      let val = inline;
      if (val === null) {
        val = argv[++i];
        if (val === undefined) die('选项 ' + name + ' 缺少参数值');
      }
      flags[VALUE_FLAGS[name]] = val;
      continue;
    }

    // 未知选项：'-' 开头且不是负数
    if (a.length > 1 && a[0] === '-' && !/^-\d/.test(a)) die('未知选项：' + a);
    positional.push(a);
  }
  return { positional, flags, bools };
}

/** 取第 i 个位置参数，缺则报错 */
function argAt(parsed, i, what) {
  const v = parsed.positional[i];
  if (v === undefined) die('缺少参数：' + what);
  return v;
}

/** 取整数选项 */
function intFlag(flags, key, dflt) {
  if (flags[key] === undefined) return dflt;
  const n = Number(flags[key]);
  if (!Number.isFinite(n) || !Number.isInteger(n)) die('--' + key + ' 需要整数（收到 ' + flags[key] + '）');
  return n;
}

/** 输出文件：-o/--out 优先，否则覆盖输入文件 */
function outPathFor(flags, inputPath) {
  return flags.out ? path.resolve(flags.out) : inputPath;
}

/* ══════════════════════════════════════════════════════════════════════
 * 2. 输出小工具（仅做格式化与汇总，不含算法）
 * ══════════════════════════════════════════════════════════════════════ */

function clamp255(n) {
  n = Math.round(Number(n) || 0);
  return n < 0 ? 0 : (n > 255 ? 255 : n);
}

/** [r,g,b,a] → '#rrggbb' */
function hexOf(rgba) {
  const h = (n) => clamp255(n).toString(16).padStart(2, '0');
  return '#' + h(rgba[0]) + h(rgba[1]) + h(rgba[2]);
}

/** regionAt 结果 → 稳定 key（用于去重统计） */
function regionKey(region) {
  if (!region) return null;
  const part = region.part != null ? region.part : (region.boxId != null ? region.boxId : '?');
  return part + '|' + (region.layer || '') + '|' + (region.face || '');
}

/** regionAt 结果 → 输出结构 */
function regionOut(region) {
  if (!region) return null;
  return {
    part: region.part,
    face: region.face,
    label: region.label,
    layer: region.layer,
    boxId: region.boxId,
  };
}

/** 命令注册表（各分块自行 register；实现见对应小节，op 原子层在 §8） */
const COMMANDS = Object.create(null);
function register(name, fn) { COMMANDS[name] = fn; }

/* ══════════════════════════════════════════════════════════════════════
 * 3. new / convert / info
 * ══════════════════════════════════════════════════════════════════════ */

/** new -o <out> [--size 64|32] [--template blank|default] */
register('new', async function cmdNew(parsed) {
  const { flags } = parsed;
  if (!flags.out) die('new 需要 -o/--out <file>');
  const size = flags.size === undefined ? 64 : intFlag(flags, 'size', 64);
  if (size !== 64 && size !== 32) die('--size 只能是 64 或 32（收到 ' + flags.size + '）');
  // 默认 blank（空白画布）；要默认皮肤必须显式 --template default（Lead 2025 裁定）
  const template = flags.template === undefined ? 'blank' : String(flags.template);
  if (template !== 'blank' && template !== 'default') {
    die('--template 只能是 blank 或 default（收到 ' + flags.template + '）');
  }

  const core = await needCore('newSkin', 'saveSkin');
  const skin = core.newSkin(size, template);
  if (!skin || !skin.data) die('core.newSkin 返回了无效皮肤对象');
  const out = await saveSkinTo(core, path.resolve(flags.out), skin);
  warn('new → ' + out + ' (' + skin.w + '×' + skin.h + ', ' + skin.format + ', ' + template + ')');
  writeJson({ ok: true, w: skin.w, h: skin.h, format: skin.format });
});

/** convert <legacy.png> -o <out> */
register('convert', async function cmdConvert(parsed) {
  const src = argAt(parsed, 0, '<legacy.png>（64×32 旧版皮肤）');
  const inPath = resolvePath(src, '输入 PNG');
  if (!parsed.flags.out) die('convert 需要 -o/--out <file>');

  const core = await needCore('loadSkin', 'convertLegacy', 'saveSkin');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');
  if (skin.h !== 32) die('convert 需要 64×32 旧版皮肤（收到 ' + skin.w + '×' + skin.h + '）');

  const converted = core.convertLegacy(skin);
  const out = await saveSkinTo(core, path.resolve(parsed.flags.out), converted);
  warn('convert → ' + out);
  writeJson({ ok: true, from: '64x32', to: '64x64' });
});

/** info <skin> → {ok,w,h,format,opaque,total,regionsUsed,partsPainted} */
register('info', async function cmdInfo(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');
  const core = await needCore('loadSkin', 'regionAt', 'partsOf');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const { w, h, data } = skin;
  const total = w * h;
  let opaque = 0;
  const regions = new Set();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] === 0) continue;   // 只统计不透明像素
      opaque++;
      const key = regionKey(core.regionAt(x, y, {}));
      if (key) regions.add(key);
    }
  }

  const parts = core.partsOf(skin) || [];
  const partsPainted = parts.filter((p) => (p.totalOpaque || 0) > 0).length;

  writeJson({
    ok: true,
    w, h,
    format: skin.format,
    opaque,
    total,
    regionsUsed: regions.size,
    partsPainted,
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. pixel / set / fill
 * ══════════════════════════════════════════════════════════════════════ */

/** '<x>,<y>,<color...>' → {xText,yText,colorText}（color 可能自带逗号：r,g,b,a） */
function splitTriple(s, what) {
  const parts = String(s).split(',');
  if (parts.length < 3) die(what + ' 需要 x,y,color 三段（收到 ' + s + '）');
  return {
    xText: parts[0].trim(),
    yText: parts[1].trim(),
    colorText: parts.slice(2).join(',').trim(),
  };
}

/** 两个整数字段 → {x,y} */
function parseXY(xText, yText, what) {
  const x = Number(xText);
  const y = Number(yText);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    die(what + ' 需要整数坐标（收到 ' + xText + ',' + yText + '）');
  }
  return { x, y };
}

/** 变更类命令统一收尾：按需写盘 → stdout {"ok":true,"changed":n,...} */
async function finishMutation(core, skin, res, parsed, inPath, extra) {
  const changed = (res && res.changed) || 0;
  const explicitOut = !!parsed.flags.out;
  if (changed > 0 || explicitOut) {
    await saveSkinTo(core, outPathFor(parsed.flags, inPath), skin);
  }
  const payload = Object.assign({ ok: true, changed }, extra || null);
  writeJson(payload);
}

/** '<x>,<y>' → {xText,yText} */
function splitPair(s, what) {
  const parts = String(s).split(',');
  if (parts.length < 2) die(what + ' 需要 x,y 两段（收到 ' + s + '）');
  return { xText: parts[0].trim(), yText: parts[1].trim() };
}

/** pixel <skin> <x>,<y> */
register('pixel', async function cmdPixel(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');
  const core = await needCore('loadSkin', 'getPixel', 'regionAt');
  const t = splitPair(argAt(parsed, 1, '<x>,<y>'), 'pixel 坐标');
  const { x, y } = parseXY(t.xText, t.yText, 'pixel 坐标');

  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');
  if (x < 0 || y < 0 || x >= skin.w || y >= skin.h) {
    die('坐标越界：(' + x + ',' + y + ') 不在 ' + skin.w + '×' + skin.h + ' 内');
  }

  const rgba = core.getPixel(skin, x, y);
  const region = core.regionAt(x, y, { format: skin.format });
  writeJson({
    ok: true,
    x, y,
    rgba: [rgba[0], rgba[1], rgba[2], rgba[3]],
    hex: hexOf(rgba),
    region: regionOut(region),
  });
});

/** set <skin> <x>,<y>,<color> [<x>,<y>,<color> ...]（同坐标后者覆盖） */
register('set', async function cmdSet(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');
  const groups = parsed.positional.slice(1);
  if (!groups.length) die('set 需要至少一组 <x>,<y>,<color>');

  const core = await needCore('loadSkin', 'parseColor', 'setPixels', 'saveSkin');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const res = op.set(core, skin, groups);
  await finishMutation(core, skin, res, parsed, inPath, null);
});

/** fill <skin> <x>,<y>,<color> [--bounds region] */
register('fill', async function cmdFill(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');
  const group = argAt(parsed, 1, '<x>,<y>,<color>');

  const core = await needCore('loadSkin', 'parseColor', 'fillOp', 'regionAt', 'boundsFromRegion', 'saveSkin');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const res = op.fill(core, skin, group, parsed.flags.bounds);
  await finishMutation(core, skin, res, parsed, inPath, res.bounds ? { bounds: res.bounds } : null);
});

/* ══════════════════════════════════════════════════════════════════════
 * 5. rect / line / mirror-limbs
 * ══════════════════════════════════════════════════════════════════════ */

/** '<x0>,<y0>,<x1>,<y1>,<color...>' → {x0,y0,x1,y1,colorText}（矩形含端点） */
function splitRectColor(s, what) {
  const parts = String(s).split(',');
  if (parts.length < 5) die(what + ' 需要 x0,y0,x1,y1,color 五段（收到 ' + s + '）');
  const nums = parts.slice(0, 4).map((t) => Number(t.trim()));
  if (nums.some((n) => !Number.isInteger(n))) {
    die(what + ' 的四个坐标都需要整数（收到 ' + parts.slice(0, 4).join(',') + '）');
  }
  return {
    x0: nums[0], y0: nums[1], x1: nums[2], y1: nums[3],
    colorText: parts.slice(4).join(',').trim(),
  };
}

/** 解析颜色选项，失败即报错 */
function colorOrDie(core, text, what) {
  const rgba = core.parseColor(text);
  if (!rgba) die('无法解析' + what + '颜色：' + text);
  return rgba;
}

/** rect <skin> <x0>,<y0>,<x1>,<y1>,<color> [--outline <color>]（含端点） */
register('rect', async function cmdRect(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');
  const group = argAt(parsed, 1, '<x0>,<y0>,<x1>,<y1>,<color>');

  const core = await needCore('loadSkin', 'parseColor', 'rectOp', 'saveSkin');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const res = op.rect(core, skin, group, parsed.flags.outline);
  await finishMutation(core, skin, res, parsed, inPath, null);
});

/** line <skin> <x0>,<y0>,<x1>,<y1>,<color>（Bresenham） */
register('line', async function cmdLine(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');
  const group = argAt(parsed, 1, '<x0>,<y0>,<x1>,<y1>,<color>');

  const core = await needCore('loadSkin', 'parseColor', 'lineOp', 'saveSkin');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const res = op.line(core, skin, group);
  await finishMutation(core, skin, res, parsed, inPath, null);
});

/** mirror-limbs <skin> [--include-outer] */
register('mirror-limbs', async function cmdMirrorLimbs(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');

  const core = await needCore('loadSkin', 'mirrorLimbsOp', 'saveSkin');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const res = op.mirror(core, skin, parsed.bools.includeOuter);
  await finishMutation(core, skin, res, parsed, inPath, { mirrored: res.mirrored });
});

/* ══════════════════════════════════════════════════════════════════════
 * 6. palette / parts / crops（只读审查类）
 * ══════════════════════════════════════════════════════════════════════ */

/** palette <skin> [--limit 30] → {ok,colors:[{hex,count}],distinct} */
register('palette', async function cmdPalette(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');
  const limit = intFlag(parsed.flags, 'limit', 30);
  if (limit < 0) die('--limit 不能为负数（收到 ' + limit + '）');

  const core = await needCore('loadSkin', 'paletteOf');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const p = op.palette(core, skin, limit);
  writeJson({ ok: true, colors: p.colors, distinct: p.distinct });
});

/** parts <skin> → {ok,parts:[{part,layer,faces:{...},totalOpaque}]} */
register('parts', async function cmdParts(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');

  const core = await needCore('loadSkin', 'partsOf');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  writeJson({ ok: true, parts: op.parts(core, skin).parts });
});

/** crops <skin> -o <dir> [--scale 8] → {ok,files:[...]} */
register('crops', async function cmdCrops(parsed) {
  const inPath = resolvePath(argAt(parsed, 0, '<skin>'), '皮肤 PNG');
  if (!parsed.flags.out) die('crops 需要 -o/--out <dir>');
  const scale = intFlag(parsed.flags, 'scale', 8);
  if (scale < 1) die('--scale 需要 ≥1（收到 ' + scale + '）');

  const core = await needCore('loadSkin', 'cropsOf');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const outDir = path.resolve(parsed.flags.out);
  mkdirp(outDir);
  const files = core.cropsOf(skin, outDir, scale) || [];
  warn('crops → ' + outDir + '（' + files.length + ' 个文件, scale ' + scale + '）');
  writeJson({ ok: true, files });
});

/* ══════════════════════════════════════════════════════════════════════
 * 7. lint（审查引擎，报告结构见 CONTRACT.md §1.2）
 * ══════════════════════════════════════════════════════════════════════ */

/** lint <skin> [--json]（--json 默认开，保留兼容） */
register('lint', async function cmdLint(parsed) {
  const raw = argAt(parsed, 0, '<skin>');
  const inPath = resolvePath(raw, '皮肤 PNG');

  const core = await needCore('loadSkin', 'lintSkin');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const report = core.lintSkin(skin, { file: raw });
  if (!report || typeof report !== 'object') die('core.lintSkin 未返回报告对象');
  if (report.ok === undefined) report.ok = true;
  writeJson(report);
});

/* ══════════════════════════════════════════════════════════════════════
 * 8. run（批量脚本）与 selftest
 * ══════════════════════════════════════════════════════════════════════ */

/** 脚本内允许的命令（不含 skin 路径与 -o；整个脚本只读写一次输入/输出） */
const RUN_COMMANDS = ['set', 'fill', 'rect', 'line', 'mirror-limbs', 'palette', 'parts'];
const RUN_MUTATORS = new Set(['set', 'fill', 'rect', 'line', 'mirror-limbs']);

/**
 * 原子操作层：供 CLI 命令与 run 脚本共用（不写 stdout、不写盘）。
 * 只做参数解析/校验 + 调 core，不含像素算法。
 */
const op = {
  /** set 组：['x,y,color', ...] */
  set(core, skin, groups) {
    if (!groups || !groups.length) die('set 需要至少一组 <x>,<y>,<color>');
    const entries = groups.map((g) => {
      const t = splitTriple(g, 'set 的像素组');
      const { x, y } = parseXY(t.xText, t.yText, 'set 坐标（组 ' + g + '）');
      return { x, y, rgba: colorOrDie(core, t.colorText, '像素') };
    });
    return core.setPixels(skin, entries) || { changed: 0 };
  },

  /** fill：'x,y,color' + 可选 bounds 值（'region'） */
  fill(core, skin, group, boundsValue) {
    const t = splitTriple(group, 'fill 参数');
    const { x, y } = parseXY(t.xText, t.yText, 'fill 坐标');
    const rgba = colorOrDie(core, t.colorText, '填充');

    let boundsRegion = null;
    let bounds = null;
    if (boundsValue !== undefined) {
      if (String(boundsValue) !== 'region') die('--bounds 只支持 region（收到 ' + boundsValue + '）');
      const region = core.regionAt(x, y, { format: skin.format });
      if (!region) die('点 (' + x + ',' + y + ') 不属于任何 UV 区域，无法用 --bounds region 限制');
      boundsRegion = core.boundsFromRegion(region);
      bounds = region.boxId + '.' + region.face;
    }
    const res = core.fillOp(skin, x, y, rgba, { boundsRegion }) || { changed: 0 };
    return { changed: (res && res.changed) || 0, bounds };
  },

  /** rect：'x0,y0,x1,y1,color' + 可选 outline 颜色文本 */
  rect(core, skin, group, outlineText) {
    const g = splitRectColor(group, 'rect 参数');
    const rgba = colorOrDie(core, g.colorText, '填充');
    const outline = outlineText === undefined ? null : colorOrDie(core, outlineText, '边框');
    return core.rectOp(skin, g.x0, g.y0, g.x1, g.y1, rgba, { outline }) || { changed: 0 };
  },

  /** line：'x0,y0,x1,y1,color' */
  line(core, skin, group) {
    const g = splitRectColor(group, 'line 参数');
    const rgba = colorOrDie(core, g.colorText, '线条');
    return core.lineOp(skin, g.x0, g.y0, g.x1, g.y1, rgba) || { changed: 0 };
  },

  /** mirror-limbs */
  mirror(core, skin, includeOuter) {
    const res = core.mirrorLimbsOp(skin, { includeOuter: !!includeOuter }) || { changed: 0, mirrored: [] };
    return { changed: (res && res.changed) || 0, mirrored: Array.isArray(res.mirrored) ? res.mirrored : [] };
  },

  /** palette */
  palette(core, skin, limit) {
    const p = core.paletteOf(skin, limit) || { distinct: 0, colors: [] };
    return { colors: Array.isArray(p.colors) ? p.colors : [], distinct: p.distinct || 0 };
  },

  /** parts */
  parts(core, skin) {
    const parts = core.partsOf(skin);
    return { parts: Array.isArray(parts) ? parts : [] };
  },
};

/** 执行脚本中的一行（tokens 已按空白切分）→ {changed?, output?}；失败则抛错 */
function execScriptLine(core, skin, tokens) {
  const cmd = tokens[0];
  const parsed = parseArgv(tokens.slice(1));
  const pos = parsed.positional;

  switch (cmd) {
    case 'set':
      return { changed: op.set(core, skin, pos).changed };

    case 'fill': {
      if (!pos.length) die('fill 需要 <x>,<y>,<color>');
      const r = op.fill(core, skin, pos[0], parsed.flags.bounds);
      return r.bounds ? { changed: r.changed, bounds: r.bounds } : { changed: r.changed };
    }

    case 'rect': {
      if (!pos.length) die('rect 需要 <x0>,<y0>,<x1>,<y1>,<color>');
      return { changed: op.rect(core, skin, pos[0], parsed.flags.outline).changed };
    }

    case 'line': {
      if (!pos.length) die('line 需要 <x0>,<y0>,<x1>,<y1>,<color>');
      return { changed: op.line(core, skin, pos[0]).changed };
    }

    case 'mirror-limbs': {
      const r = op.mirror(core, skin, parsed.bools.includeOuter);
      return { changed: r.changed, output: { mirrored: r.mirrored } };
    }

    case 'palette':
      return { output: op.palette(core, skin, intFlag(parsed.flags, 'limit', 30)) };

    case 'parts':
      return { output: op.parts(core, skin) };

    default:
      die('run 脚本不支持命令：' + cmd + '（可用：' + RUN_COMMANDS.join('/') + '）');
  }
}

/** run <script.txt> <skin> [-o <out>] */
register('run', async function cmdRun(parsed) {
  const script = readText(argAt(parsed, 0, '<script.txt>'), '脚本文件');
  const skinArg = argAt(parsed, 1, '<skin>');
  const inPath = resolvePath(skinArg, '皮肤 PNG');

  const core = await needCore('loadSkin', 'saveSkin', 'setPixels', 'fillOp', 'rectOp', 'lineOp',
    'mirrorLimbsOp', 'paletteOf', 'partsOf', 'regionAt', 'boundsFromRegion', 'parseColor');
  const skin = core.loadSkin(inPath);
  if (!skin || !skin.data) die('core.loadSkin 返回了无效皮肤对象');

  const lines = script.text.split(/\r?\n/);
  const results = [];
  let totalChanged = 0;
  let failures = 0;
  let mutated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;   // 空行与 # 注释

    const tokens = line.split(/\s+/);
    const cmd = tokens[0];
    try {
      const r = execScriptLine(core, skin, tokens);
      const entry = { line: i + 1, cmd, ok: true };
      if (r.output !== undefined) entry.output = r.output;
      if (r.changed !== undefined) { entry.changed = r.changed; totalChanged += r.changed; }
      if (r.bounds !== undefined) entry.bounds = r.bounds;
      if (RUN_MUTATORS.has(cmd)) mutated = true;
      results.push(entry);
    } catch (e) {
      failures++;
      results.push({ line: i + 1, cmd, ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  }

  // 整个脚本只写一次盘：显式 -o 必写；有变更类命令也落盘（保留已成功的改动）
  const out = outPathFor(parsed.flags, inPath);
  if (parsed.flags.out || mutated || totalChanged > 0) await saveSkinTo(core, out, skin);
  if (failures > 0) warn('run: ' + failures + ' 行失败，已写入已成功的改动 → ' + out);
  else warn('run: ' + results.length + ' 行 / 改动 ' + totalChanged + ' px → ' + out);

  writeJson({ ok: failures === 0, results, changed: totalChanged });
  return failures === 0 ? 0 : 1;
});

/** selftest → core.selftest() 结果原样输出；fail===0 才 exit 0 */
register('selftest', async function cmdSelftest() {
  const core = await needCore('selftest');
  const r = core.selftest() || {};
  const fail = r.fail || 0;
  writeJson({
    ok: r.ok !== false && fail === 0,
    pass: r.pass || 0,
    fail,
    failures: Array.isArray(r.failures) ? r.failures : [],
  });
  return fail === 0 && r.ok !== false ? 0 : 1;
});

/* ══════════════════════════════════════════════════════════════════════
 * 9. main 分发
 * ══════════════════════════════════════════════════════════════════════ */

async function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stderr.write(USAGE);
    return 0;
  }
  const handler = COMMANDS[cmd];
  if (!handler) die('未知命令：' + cmd + '（可用：' + Object.keys(COMMANDS).sort().join(' / ') + '）');

  const parsed = parseArgv(argv.slice(1));
  if (parsed.bools.help) {
    process.stderr.write(USAGE);
    return 0;
  }
  // handler 可返回退出码（run 有失败行时返回 1；selftest fail>0 时返回 1）
  const code = await handler(parsed);
  return typeof code === 'number' ? code : 0;
}

/* ══════════════════════════════════════════════════════════════════════
 * 10. 入口：顶层 try/catch → stdout {"ok":false,"error"} + exit 1
 * ══════════════════════════════════════════════════════════════════════ */

try {
  const code = await main(process.argv.slice(2));
  process.exit(typeof code === 'number' ? code : 0);
} catch (e) {
  writeJson({ ok: false, error: (e && e.message) ? e.message : String(e) });
  if (process.env.MCSKIN_DEBUG && e && e.stack) process.stderr.write(e.stack + '\n');
  process.exit(1);
}
