#!/usr/bin/env node
/* bin/headless.mjs — 用系统自带 Edge/Chrome 的 headless 模式跑探针页（归属：skin-render）
 *
 * 改造自 tools/headless.mjs（原版已验证可用）。改造点见 CONTRACT.md §2.3：
 *   · 输出目录改用系统临时目录（os.tmpdir() 下的 mkdtemp），用完删除 profile 与探针页，不写 tests/out
 *   · stdout 只输出纯 JSON（含 probe / title / exitCode / stderrTail）
 *   · 不再截图：渲染结果由页面 canvas.toDataURL 回传，省掉第二次浏览器启动
 *   · 保留「多个 probe-json 候选逐个解析直到成功」的逻辑
 *   · 浏览器参数沿用原版（--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader
 *     --virtual-time-budget --dump-dom）
 *
 * 用法:
 *   node bin/headless.mjs <page.html> [--width 1600] [--height 1000] [--timeout 15000] [--keep]
 *   node bin/headless.mjs --probe          # 只探测浏览器，输出 {ok,browser}
 *
 * 退出码：0 成功；1 找不到浏览器；2 参数错误；3 浏览器启动失败
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BROWSER_CANDIDATES = [
  process.env.MCSKIN_BROWSER || '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Users\\18002\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
].filter(Boolean);

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

function emit(obj, code) {
  console.log(JSON.stringify(obj, null, 2));
  if (code) process.exitCode = code;
}

function unescapeHtml(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

function parseArgs(argv) {
  const o = { page: null, width: 1600, height: 1000, budget: 15000, keep: false, probe: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(a + ' 需要一个参数');
      return v;
    };
    if (a === '--probe') o.probe = true;
    else if (a === '--width') o.width = parseInt(need(), 10);
    else if (a === '--height') o.height = parseInt(need(), 10);
    else if (a === '--timeout') o.budget = parseInt(need(), 10);
    else if (a === '--keep') o.keep = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error('未知参数: ' + a);
    else if (!o.page) o.page = path.resolve(a);
    else throw new Error('多余的位置参数: ' + a);
  }
  return o;
}

const USAGE = '用法: node bin/headless.mjs <page.html> [--width N] [--height N] [--timeout ms] [--keep]\n' +
  '      node bin/headless.mjs --probe';

/* 提取探针 JSON：注入脚本的注释/字符串里也可能出现同名 id，所以逐个候选尝试直到解析成功 */
function extractProbe(dom) {
  const re = /<script[^>]*id="probe-json"[^>]*>([\s\S]*?)<\/script>/g;
  const candidates = [];
  let m;
  while ((m = re.exec(dom)) !== null) candidates.push(m[1]);
  for (const raw of candidates) {
    const text = unescapeHtml(raw).replace(/^\s+|\s+$/g, '');
    if (!text) continue;
    try { return { probe: JSON.parse(text), candidates: candidates.length }; } catch (e) { /* 试下一个 */ }
  }
  return { probe: { parseError: 'no valid probe-json found', candidates: candidates.length }, candidates: candidates.length };
}

function run(a) {
  const browser = findBrowser();
  if (!browser) {
    emit({ ok: false, error: '找不到 Edge/Chrome（候选: ' + BROWSER_CANDIDATES.join(' | ') + '）', candidates: BROWSER_CANDIDATES }, 1);
    return;
  }
  if (a.probe) {
    emit({ ok: true, browser, candidates: BROWSER_CANDIDATES }, 0);
    return;
  }
  if (!a.page) { emit({ ok: false, error: '缺少 <page.html> 参数\n' + USAGE }, 2); return; }
  if (!existsSync(a.page)) { emit({ ok: false, error: '页面不存在: ' + a.page }, 2); return; }

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'mcskin-headless-'));
  try {
    const profile = path.join(workDir, 'profile');
    mkdirSync(profile, { recursive: true });
    const common = [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--user-data-dir=' + profile,
      '--window-size=' + a.width + ',' + a.height,
      '--virtual-time-budget=' + a.budget,
      '--run-all-compositor-stages-before-draw',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist'
    ];
    const url = pathToFileURL(a.page).href;
    const res = spawnSync(browser, common.concat(['--dump-dom', url]), {
      encoding: 'utf8', timeout: 180000, maxBuffer: 256 * 1024 * 1024
    });
    if (res.error) {
      emit({ ok: false, error: '启动浏览器失败: ' + res.error.message, browser, page: a.page }, 3);
      return;
    }
    const dom = res.stdout || '';
    if (a.keep) writeFileSync(path.join(workDir, 'dom.html'), dom, 'utf8');
    const got = extractProbe(dom);
    const title = (/<title>([\s\S]*?)<\/title>/.exec(dom) || [, ''])[1];
    emit({
      ok: true,
      browser,
      page: a.page,
      url,
      exitCode: res.status,
      title,
      domBytes: dom.length,
      probeCandidates: got.candidates,
      probe: got.probe,
      stderrTail: String(res.stderr || '').slice(-1500),
      workDir: a.keep ? workDir : null
    }, 0);
  } finally {
    if (!a.keep) {
      try { rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
    }
  }
}

let opts;
try { opts = parseArgs(process.argv.slice(2)); }
catch (e) { emit({ ok: false, error: e && e.message ? e.message : String(e) }, 2); opts = null; }

if (opts) {
  if (opts.help) emit({ ok: true, usage: USAGE, candidates: BROWSER_CANDIDATES }, 0);
  else run(opts);
}
