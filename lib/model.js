/* ============================================================================
 * js/model.js — 像素数据模型 (MCSKIN.model)
 * ----------------------------------------------------------------------------
 * 传统 <script> 标签加载（禁止 import/export）。像素数据是唯一真相：
 * Uint8ClampedArray(w*h*4)，行优先，RGBA 0-255。
 *   · 只支持 64×64（modern）与 64×32（legacy），format 由高度判定。
 *   · 撤销栈上限 100 步；setPixels / fillRect / clear / restore / loadImageData
 *     各算「一步」，beginStroke()..endStroke() 之间的所有写入合并为一步。
 *   · fillRect(x0,y0,x1,y1) 的 x1/y1 是「包含」的最后一个像素（两端都画），
 *     且允许 x0>x1（自动交换）。
 * ========================================================================== */
(function (global) {
  'use strict';

  var MCSKIN = global.MCSKIN = global.MCSKIN || {};

  var VERSION = '1.0';
  var UNDO_LIMIT = 100;

  function formatOf(w, h) {
    if (w === 64 && h === 64) return 'modern';
    if (w === 64 && h === 32) return 'legacy';
    return null;
  }

  function rgbaOf(c) {
    if (!c) return [0, 0, 0, 0];
    if (typeof c === 'string') {
      var s = c.charAt(0) === '#' ? c.slice(1) : c;
      if (s.length === 6 || s.length === 8) {
        var n = parseInt(s, 16);
        return s.length === 6
          ? [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
          : [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      return [0, 0, 0, 0];
    }
    var a = c.length > 3 ? c[3] : 255;
    if (a == null || isNaN(a)) a = 255;
    return [c[0] | 0, c[1] | 0, c[2] | 0, a | 0];
  }

  /* ------------------------------------------------------------ 实例 ------- */

  function SkinModel(width, height, format) {
    this.width = width;
    this.height = height;
    this.format = format;
    this.data = new Uint8ClampedArray(width * height * 4);
    this._past = [];     // 撤销栈（保存「变更前」的完整快照）
    this._future = [];   // 重做栈
    this._stroke = null;  // { label, before, dirty }
  }

  SkinModel.prototype._idx = function (x, y) { return (y * this.width + x) * 4; };
  SkinModel.prototype._inBounds = function (x, y) {
    return typeof x === 'number' && typeof y === 'number' &&
      isFinite(x) && isFinite(y) && x >= 0 && y >= 0 && x < this.width && y < this.height;
  };
  SkinModel.prototype._entry = function (label) {
    return {
      label: label || '',
      width: this.width, height: this.height, format: this.format,
      data: new Uint8ClampedArray(this.data)
    };
  };
  SkinModel.prototype._apply = function (e) {
    this.width = e.width; this.height = e.height; this.format = e.format;
    this.data = new Uint8ClampedArray(e.data);
  };
  SkinModel.prototype._capPast = function () {
    while (this._past.length > UNDO_LIMIT) this._past.shift();
  };
  /* 真正写入之前调用：笔画中只标记 dirty（整笔合并成一步），否则压入一步快照 */
  SkinModel.prototype._before = function (opts) {
    if (this._stroke) { this._stroke.dirty = true; return; }
    if (opts && opts.record === false) return;
    this._past.push(this._entry('edit'));
    this._capPast();
    this._future.length = 0;
  };

  SkinModel.prototype.getPixel = function (x, y) {
    if (!this._inBounds(x, y)) return [0, 0, 0, 0];
    var i = this._idx(x, y), d = this.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  };

  SkinModel.prototype.setPixel = function (x, y, rgba, opts) {
    x = x | 0; y = y | 0;
    if (!this._inBounds(x, y)) return this;
    var c = rgbaOf(rgba);
    this._before(opts);
    var i = this._idx(x, y), d = this.data;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    if (!(opts && opts.merge === 'keepAlpha')) d[i + 3] = c[3];
    return this;
  };

  /* edits = [{x,y,rgba}]（兼容 {x,y,color} / [x,y,rgba]），整批只入一次撤销栈 */
  SkinModel.prototype.setPixels = function (edits, opts) {
    if (!edits || !edits.length) return this;
    var list = [], k, e;
    for (k = 0; k < edits.length; k++) {
      e = edits[k];
      if (!e) continue;
      var ex, ey, ec;
      if (e.length) { ex = e[0]; ey = e[1]; ec = e[2]; }
      else { ex = e.x; ey = e.y; ec = e.rgba || e.color; }
      ex = ex | 0; ey = ey | 0;
      if (!this._inBounds(ex, ey)) continue;
      list.push([ex, ey, rgbaOf(ec), (e.merge || (opts && opts.merge) || 'replace')]);
    }
    if (!list.length) return this;
    this._before(opts);
    for (k = 0; k < list.length; k++) {
      var i = this._idx(list[k][0], list[k][1]), c = list[k][2], d = this.data;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
      if (list[k][3] !== 'keepAlpha') d[i + 3] = c[3];
    }
    return this;
  };

  /* 填矩形：x1/y1 为包含的最后一个像素 */
  SkinModel.prototype.fillRect = function (x0, y0, x1, y1, rgba) {
    x0 = x0 | 0; y0 = y0 | 0; x1 = x1 | 0; y1 = y1 | 0;
    if (x0 > x1) { var t = x0; x0 = x1; x1 = t; }
    if (y0 > y1) { var t2 = y0; y0 = y1; y1 = t2; }
    var xa = Math.max(0, x0), ya = Math.max(0, y0);
    var xb = Math.min(this.width - 1, x1), yb = Math.min(this.height - 1, y1);
    if (xa > xb || ya > yb) return this;
    var c = rgbaOf(rgba);
    this._before(null);
    var d = this.data;
    for (var y = ya; y <= yb; y++) {
      for (var x = xa; x <= xb; x++) {
        var i = this._idx(x, y);
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
      }
    }
    return this;
  };

  SkinModel.prototype.snapshot = function () {
    return { width: this.width, height: this.height, data: new Uint8ClampedArray(this.data) };
  };

  /* 恢复快照（可撤销；opts.record=false 时不入撤销栈） */
  SkinModel.prototype.restore = function (snap, opts) {
    if (!snap || !snap.data) throw new Error('MCSKIN.model.restore: 需要 { width, height, data }');
    var w = snap.width | 0 || this.width, h = snap.height | 0 || this.height;
    var fmt = formatOf(w, h);
    if (!fmt) throw new Error('MCSKIN.model.restore: 只支持 64×64 / 64×32，收到 ' + w + '×' + h);
    if (snap.data.length !== w * h * 4) throw new Error('MCSKIN.model.restore: data 长度与 ' + w + '×' + h + ' 不符');
    if (!(opts && opts.record === false)) this._before(opts);
    this.width = w; this.height = h; this.format = fmt;
    this.data = new Uint8ClampedArray(snap.data);
    return this;
  };

  SkinModel.prototype.canUndo = function () { return this._past.length > 0; };
  SkinModel.prototype.canRedo = function () { return this._future.length > 0; };

  SkinModel.prototype.undo = function () {
    if (!this._past.length) return false;
    this._future.push(this._entry('redo'));
    this._apply(this._past.pop());
    return true;
  };
  SkinModel.prototype.redo = function () {
    if (!this._future.length) return false;
    this._past.push(this._entry('undo'));
    this._capPast();
    this._apply(this._future.pop());
    return true;
  };

  /* 一次笔画 = 一个撤销步：beginStroke() 后所有写入合并，endStroke() 提交 */
  SkinModel.prototype.beginStroke = function (label) {
    if (this._stroke) this.endStroke();
    this._stroke = { label: label || 'stroke', before: this._entry(label || 'stroke'), dirty: false };
    return this;
  };
  SkinModel.prototype.endStroke = function () {
    var s = this._stroke;
    if (!s) return this;
    this._stroke = null;
    if (s.dirty) {
      this._past.push(s.before);
      this._capPast();
      this._future.length = 0;
    }
    return this;
  };

  SkinModel.prototype.clear = function () {
    this._before(null);
    for (var i = 0; i < this.data.length; i++) this.data[i] = 0;
    return this;
  };

  /* 转成 64×64 现代格式（legacy 走 rules.convertLegacy64x32） */
  SkinModel.prototype.toModern = function () {
    if (this.format === 'legacy') {
      var R = MCSKIN.rules;
      if (R && typeof R.convertLegacy64x32 === 'function') {
        var r = R.convertLegacy64x32(this.data);
        return { width: 64, height: 64, data: new Uint8ClampedArray(r.data) };
      }
      // rules 未加载时的降级：至少把 64×32 平移到 64×64 左半（不做镜像/补外层）
      var d = new Uint8ClampedArray(64 * 64 * 4);
      for (var y = 0; y < 32; y++) {
        for (var x = 0; x < 64; x++) {
          var s = (y * 64 + x) * 4, t = (y * 64 + x) * 4;
          d[t] = this.data[s]; d[t + 1] = this.data[s + 1]; d[t + 2] = this.data[s + 2]; d[t + 3] = this.data[s + 3];
        }
      }
      return { width: 64, height: 64, data: d };
    }
    return { width: this.width, height: this.height, data: new Uint8ClampedArray(this.data) };
  };

  /* 从 ImageData / canvas / {width,height,data} 载入（步长会随来源尺寸改变） */
  SkinModel.prototype.loadImageData = function (src, opts) {
    if (!src) throw new Error('MCSKIN.model.loadImageData: 输入为空');
    var w = src.width | 0, h = src.height | 0, data = src.data;
    if (!data && typeof src.getContext === 'function') {
      var ctx = src.getContext('2d');
      if (!ctx) throw new Error('MCSKIN.model.loadImageData: canvas 无 2d 上下文');
      var img = ctx.getImageData(0, 0, src.width, src.height);
      w = img.width; h = img.height; data = img.data;
    }
    var fmt = formatOf(w, h);
    if (!fmt) throw new Error('MCSKIN.model.loadImageData: 只支持 64×64 / 64×32，收到 ' + w + '×' + h);
    if (!data || data.length < w * h * 4) throw new Error('MCSKIN.model.loadImageData: 像素数据不足');
    if (!(opts && opts.record === false)) this._before(opts);
    this.width = w; this.height = h; this.format = fmt;
    this.data = new Uint8ClampedArray(w * h * 4);
    for (var i = 0; i < this.data.length; i++) this.data[i] = data[i];
    return this;
  };

  SkinModel.prototype.stats = function () {
    var opaque = 0;
    for (var i = 3; i < this.data.length; i += 4) if (this.data[i] > 0) opaque++;
    return { opaque: opaque, total: this.width * this.height, format: this.format };
  };

  /* ------------------------------------------------------------ API -------- */

  function create(width, height) {
    width = width | 0; height = height | 0;
    var fmt = formatOf(width, height);
    if (!fmt) throw new Error('MCSKIN.model.create: 只支持 64×64 或 64×32，收到 ' + width + '×' + height);
    return new SkinModel(width, height, fmt);
  }

  /* ---------------------------------------------------------- 自检（无浏览器） */

  function _selfTest() {
    var pass = [], fail = [];
    function ok(name, cond, extra) { if (cond) pass.push(name); else fail.push(name + (extra ? ' — ' + extra : '')); }
    function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
    function sameData(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    try {
      // ---- create / format
      var m = create(64, 64);
      ok('create(64,64) → modern，data = 64*64*4', m.format === 'modern' && m.width === 64 && m.height === 64 &&
        m.data instanceof Uint8ClampedArray && m.data.length === 64 * 64 * 4);
      var ml = create(64, 32);
      ok('create(64,32) → legacy', ml.format === 'legacy' && ml.height === 32 && ml.data.length === 64 * 32 * 4);
      ok('create(32,32) 抛错', (function () { try { create(32, 32); return false; } catch (e) { return true; } })());

      // ---- getPixel / setPixel
      m.setPixel(3, 4, [10, 20, 30, 255]);
      eq('setPixel/getPixel 往返', m.getPixel(3, 4), [10, 20, 30, 255]);
      m.setPixel(4, 4, [1, 2, 3]);          // 省略 alpha → 255
      eq('setPixel 支持 [r,g,b]（alpha 默认 255）', m.getPixel(4, 4), [1, 2, 3, 255]);
      var alphaBefore = m.getPixel(4, 4)[3];
      m.setPixel(4, 4, [200, 201, 202, 12], { merge: 'keepAlpha' });
      eq('setPixel merge=keepAlpha 保留原 alpha', [m.getPixel(4, 4)[0], m.getPixel(4, 4)[3]], [200, alphaBefore]);
      m.setPixel(-5, -5, [9, 9, 9, 9]);
      m.setPixel(999, 999, [9, 9, 9, 9]);
      ok('越界 setPixel 被安全忽略', m.getPixel(0, 0)[3] === 0);
      eq('越界 getPixel 返回透明', m.getPixel(-1, 0), [0, 0, 0, 0]);

      // ---- fillRect 与逐点 setPixel 结果一致
      var a = create(64, 64), b = create(64, 64);
      a.fillRect(5, 6, 12, 20, [200, 30, 40, 255]);
      for (var y = 6; y <= 20; y++) for (var x = 5; x <= 12; x++) b.setPixel(x, y, [200, 30, 40, 255]);
      ok('fillRect 与逐点 setPixel 结果一致（x1/y1 含端点）', sameData(a.data, b.data));
      eq('fillRect 边界像素已画', [a.getPixel(5, 6)[3], a.getPixel(12, 20)[3], a.getPixel(4, 6)[3], a.getPixel(13, 6)[3]], [255, 255, 0, 0]);
      var c1 = create(64, 64);
      c1.fillRect(12, 20, 5, 6, [200, 30, 40, 255]);
      ok('fillRect 端点顺序颠倒也能画', sameData(c1.data, a.data));
      var o = create(64, 64);
      o.fillRect(-5, -5, 2, 2, [1, 1, 1, 255]);
      eq('fillRect 越界部分被裁掉', [o.getPixel(0, 0)[3], o.getPixel(2, 2)[3], o.getPixel(3, 3)[3]], [255, 255, 0]);

      // ---- undo / redo 往返一致
      var u = create(64, 64);
      u.setPixel(1, 1, [11, 22, 33, 255]);
      var snapAfterFirst = u.snapshot();
      u.fillRect(0, 0, 63, 63, [7, 7, 7, 255]);
      var snapAfterFill = u.snapshot();
      ok('canUndo/canRedo 初值', u.canUndo() === true && u.canRedo() === false);
      ok('undo() 返回 true 并回到上一状态', u.undo() === true && sameData(u.data, snapAfterFirst.data));
      ok('undo 后 canRedo', u.canRedo() === true);
      ok('redo() 返回 true 并回到 fill 后状态', u.redo() === true && sameData(u.data, snapAfterFill.data));
      ok('再 undo 再 undo 回到空画布', u.undo() === true && u.undo() === true && u.canUndo() === false);
      var allZero = true;
      for (var i = 0; i < u.data.length; i++) if (u.data[i] !== 0) { allZero = false; break; }
      ok('两次 undo 后画布全透明（往返一致）', allZero);
      var fresh = create(64, 64);
      ok('空栈时 undo()/redo() 返回 false', fresh.canUndo() === false && fresh.canRedo() === false &&
        fresh.undo() === false && fresh.redo() === false);

      // ---- setPixels 一次性入栈
      var sp = create(64, 64);
      sp.setPixel(0, 0, [1, 1, 1, 255]);
      var snap0 = sp.snapshot();
      sp.setPixels([{ x: 1, y: 1, rgba: [5, 5, 5, 255] }, { x: 2, y: 2, rgba: [6, 6, 6, 255] }, { x: 3, y: 3, rgba: [7, 7, 7, 255] }]);
      eq('setPixels 写入全部像素', [sp.getPixel(1, 1)[0], sp.getPixel(2, 2)[0], sp.getPixel(3, 3)[0]], [5, 6, 7]);
      sp.undo();
      ok('setPixels 整批只占一步撤销（一次 undo 全回退）', sameData(sp.data, snap0.data));
      var sp2 = create(64, 64);
      sp2.setPixels([[10, 10, [3, 3, 3, 255]], { x: 11, y: 11, color: '#0a0b0c' }]);
      eq('setPixels 兼容 [x,y,rgba] 与 {x,y,color:"#rrggbb"}', [sp2.getPixel(10, 10)[0], sp2.getPixel(11, 11)[2]], [3, 12]);

      // ---- beginStroke / endStroke = 一步
      var st = create(64, 64);
      var stSnap = st.snapshot();
      st.beginStroke('pencil');
      for (var k = 0; k < 8; k++) st.setPixel(k, 0, [9, 9, 9, 255]);
      st.endStroke();
      eq('笔画期间写入生效', st.getPixel(7, 0)[3], 255);
      st.undo();
      ok('beginStroke/endStroke：整笔只占一步撤销', sameData(st.data, stSnap.data) && st.canUndo() === false);
      st.redo();
      ok('笔画可重做', st.getPixel(7, 0)[3] === 255);
      var st2 = create(64, 64);
      st2.beginStroke(); st2.endStroke();   // 没有写入 → 不产生撤销步
      ok('空笔画不产生撤销步', st2.canUndo() === false);

      // ---- 撤销栈上限 100
      var lim = create(64, 64);
      for (var q = 0; q < 150; q++) lim.setPixel(q % 64, (q / 64) | 0, [q & 255, 0, 0, 255]);
      var n = 0;
      while (lim.canUndo()) { lim.undo(); n++; if (n > 500) break; }
      ok('撤销栈上限 100 步', n === 100, 'n=' + n);

      // ---- clear
      var cl = create(64, 64);
      cl.fillRect(0, 0, 63, 63, [1, 2, 3, 255]);
      eq('stats 统计不透明像素', [cl.stats().opaque, cl.stats().total, cl.stats().format], [4096, 4096, 'modern']);
      cl.clear();
      ok('clear 后全透明且可撤销', cl.stats().opaque === 0 && cl.canUndo() && (cl.undo(), cl.stats().opaque === 4096));

      // ---- snapshot / restore
      var s1 = create(64, 64);
      s1.fillRect(0, 0, 3, 3, [4, 5, 6, 255]);
      var sSnap = s1.snapshot();
      s1.clear();
      s1.restore(sSnap);
      ok('snapshot/restore 往返一致', sameData(s1.data, sSnap.data) && s1.width === 64 && s1.format === 'modern');
      ok('restore 可撤销（回到 clear 后）', s1.canUndo() && (s1.undo(), s1.stats().opaque === 0));
      ok('restore 尺寸不符抛错', (function () { try { s1.restore({ width: 64, height: 64, data: new Uint8ClampedArray(10) }); return false; } catch (e) { return true; } })());

      // ---- loadImageData
      var L = create(64, 64);
      var src = new Uint8ClampedArray(64 * 64 * 4);
      src[0] = 111; src[1] = 112; src[2] = 113; src[3] = 255;
      L.loadImageData({ width: 64, height: 64, data: src });
      eq('loadImageData({width,height,data})', L.getPixel(0, 0), [111, 112, 113, 255]);
      var L2 = create(64, 64);
      L2.loadImageData({ width: 64, height: 32, data: new Uint8ClampedArray(64 * 32 * 4) });
      ok('loadImageData 载入 64×32 → format=legacy', L2.format === 'legacy' && L2.height === 32);
      ok('loadImageData 尺寸非法抛错', (function () {
        try { L2.loadImageData({ width: 128, height: 128, data: new Uint8ClampedArray(128 * 128 * 4) }); return false; } catch (e) { return true; }
      })());
      ok('loadImageData 可撤销', L.canUndo() && (L.undo(), L.getPixel(0, 0)[3] === 0));

      // ---- toModern
      var md = create(64, 64);
      md.fillRect(0, 0, 63, 63, [8, 9, 10, 255]);
      var tm = md.toModern();
      ok('toModern（modern）返回 64×64 副本且不影响原实例', tm.width === 64 && tm.height === 64 &&
        tm.data.length === 64 * 64 * 4 && !sameData(tm.data, new Uint8ClampedArray(64 * 64 * 4)) && md.stats().opaque === 4096);
      var rules = MCSKIN.rules;
      if (rules && typeof rules.convertLegacy64x32 === 'function') {
        var lg = create(64, 32);
        for (var yy = 0; yy < 32; yy++) for (var xx = 0; xx < 64; xx++) lg.setPixel(xx, yy, [xx * 4 & 255, yy * 8 & 255, 128, 255], { record: false });
        var conv = lg.toModern();
        var want = rules.convertLegacy64x32(lg.data);
        ok('toModern（legacy）= rules.convertLegacy64x32 的结果', conv.width === 64 && conv.height === 64 && sameData(conv.data, want.data));
        var leftLegOpaque = 0;
        for (var yl = 48; yl < 64; yl++) for (var xl = 16; xl < 32; xl++) if (conv.data[(yl * 64 + xl) * 4 + 3] > 0) leftLegOpaque++;
        ok('toModern（legacy）左腿区 6 个面覆盖（224）', leftLegOpaque === 224, 'leftLegOpaque=' + leftLegOpaque);
      } else {
        pass.push('rules 未加载，跳过 legacy→modern 转换检查');
      }

      // ---- 与 rules 的默认皮肤互相兼容
      if (rules && typeof rules.defaultSkin === 'function') {
        var def = rules.defaultSkin();
        var dm = create(64, 64);
        dm.loadImageData(def);
        eq('defaultSkin 可载入 model 且 stats 一致', dm.stats().opaque, (function () {
          var o = 0;
          for (var i2 = 3; i2 < def.data.length; i2 += 4) if (def.data[i2] > 0) o++;
          return o;
        })());
      } else {
        pass.push('rules 未加载，跳过 defaultSkin 检查');
      }
    } catch (e) {
      fail.push('model 自检异常: ' + (e && e.message ? e.message : e));
    }
    return { pass: pass, fail: fail };
  }

  /* ------------------------------------------------------------- 导出 ------- */

  MCSKIN.model = {
    VERSION: VERSION,
    UNDO_LIMIT: UNDO_LIMIT,
    create: create,
    _selfTest: _selfTest
  };

  MCSKIN.tests = MCSKIN.tests || {};
  MCSKIN.tests.model = _selfTest();
})(typeof window !== 'undefined' ? window : this);
