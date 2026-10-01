/* ============================================================================
 * js/renderer3d.js — Minecraft 皮肤绘制工具：WebGL 立体（3D）预览
 * 契约：CONTRACT.md 第 6 节。传统 script 风格（无 import / export），零外部库。
 * 归属：teammate `render3d`；唯一写作用域就是本文件。
 *
 * 设计要点
 *  - 几何/UV 全部来自 MCSKIN.rules（BOXES / box(id) / geometry / faces.px /
 *    uvFromPixel / FACE_SHADE / FACE_LABEL / PART_LABEL / convertLegacy64x32），
 *    本文件不硬编码任何 UV 像素数字。
 *  - 展平为两个顶点缓冲：base（基础层）与 outer（外层）。先画完基础层所有盒，
 *    再画外层所有盒；透明像素在片元着色器里 discard，不会遮住基础层。
 *  - 顶点属性布局（每顶点 8 个 float）：
 *      [0..2] position(vec3) [3..4] uv(vec2) [5] shade(float(=FACE_SHADE×方向光))
 *      [6] highlight(float)  [7] outer(float)
 *  - 方向光在构建顶点时用「真实面法线」烘焙进 shade 属性（配合 setLighting 开关），
 *    法线由几何叉积算出，保证顶面最亮、底面最暗。
 *  - 绕序：CONTRACT 3.4 的 right/left 面与其余 4 面绕序相反，这里按「法线是否朝盒外」
 *    自动选择三角化顺序，因此可以安全开启 CULL_FACE。
 * ========================================================================== */
(function (global) {
  'use strict';

  var MCSKIN = global.MCSKIN = global.MCSKIN || {};
  var VERSION = '1.0';

  /* ========================================================================
   * 1. 极简 mat4（列主序，WebGL 约定）
   * ====================================================================== */
  function m4() { return new Float32Array(16); }

  function m4identity(o) {
    o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0;
    o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
    o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0;
    o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
    return o;
  }

  /* out = a * b（注意：out 不能与 a / b 是同一个对象） */
  function m4mul(out, a, b) {
    for (var c = 0; c < 4; c++) {
      var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  }

  function m4translation(x, y, z) {
    var o = m4identity(m4());
    o[12] = x; o[13] = y; o[14] = z;
    return o;
  }

  function m4rotX(rad) {
    var c = Math.cos(rad), s = Math.sin(rad), o = m4identity(m4());
    o[5] = c; o[6] = s; o[9] = -s; o[10] = c;
    return o;
  }
  function m4rotY(rad) {
    var c = Math.cos(rad), s = Math.sin(rad), o = m4identity(m4());
    o[0] = c; o[2] = -s; o[8] = s; o[10] = c;
    return o;
  }
  function m4rotZ(rad) {
    var c = Math.cos(rad), s = Math.sin(rad), o = m4identity(m4());
    o[0] = c; o[1] = s; o[4] = -s; o[5] = c;
    return o;
  }

  function m4perspective(fovyRad, aspect, near, far) {
    var o = m4();
    var f = 1 / Math.tan(fovyRad / 2);
    var nf = 1 / (near - far);
    o[0] = f / aspect; o[5] = f;
    o[10] = (far + near) * nf; o[11] = -1;
    o[14] = 2 * far * near * nf;
    return o;
  }

  function m4lookAt(eye, center, up) {
    var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    var zl = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    var xl = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    var o = m4();
    o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
    o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
    o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
    o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    o[15] = 1;
    return o;
  }

  /* ========================================================================
   * 2. 几何常量与工具（只含「名字 / 方向」，不含任何 UV 数字）
   * ====================================================================== */
  var STRIDE_FLOATS = 8;                 // pos3 + uv2 + shade1 + highlight1 + outer1
  var STRIDE_BYTES = STRIDE_FLOATS * 4;
  var DEFAULT_FACE_ORDER = ['right', 'front', 'left', 'back', 'top', 'bottom'];

  /* 真实法线方向光参数（模型空间；模型朝 +Z 的「front」面） */
  var LIGHT_DIR = (function () {
    var v = [-0.45, 0.85, 0.55];
    var l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  })();
  var AMBIENT = 0.35;
  var DIFFUSE = 0.75;

  /* 盒 id → 动画/可见性分组（纯名字映射，无 UV 数字） */
  var PART_GROUP = {
    head: 'head', hat: 'head',
    body: 'body', jacket: 'body',
    rightArm: 'rightArm', rightSleeve: 'rightArm',
    leftArm: 'leftArm', leftSleeve: 'leftArm',
    rightLeg: 'rightLeg', rightPants: 'rightLeg',
    leftLeg: 'leftLeg', leftPants: 'leftLeg'
  };
  var PART_ORDER = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];

  /* 盒 id → 同部位的基础盒 id（用于外层膨胀自测 / 兜底） */
  var OUTER_TO_BASE = {
    hat: 'head', jacket: 'body',
    rightSleeve: 'rightArm', leftSleeve: 'leftArm',
    rightPants: 'rightLeg', leftPants: 'leftLeg'
  };

  function groupOf(box) {
    if (!box) return 'unknown';
    return PART_GROUP[box.id] || (box.part ? (PART_GROUP[box.part] || box.part) : box.id) || box.id;
  }

  function countBoxes(rulesObj, opts) {
    var boxes = (rulesObj && rulesObj.BOXES) || [];
    var vis = (opts && opts.partVisible) || {};
    var showBase = !(opts && opts.showBase === false);
    var showLayer = !(opts && opts.showLayer === false);
    var n = 0;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (!isVisible(b, vis)) continue;
      var outer = b.layer === 'outer';
      if (outer && !showLayer) continue;
      if (!outer && !showBase) continue;
      n++;
    }
    return n;
  }

  function isVisible(box, vis) {
    var g = groupOf(box);
    if (vis[box.id] === false) return false;
    if (vis[g] === false) return false;
    if (box.part && vis[box.part] === false) return false;
    return true;
  }

  function faceOrderOf(rulesObj) {
    var fo = rulesObj && rulesObj.FACE_ORDER;
    if (fo && typeof fo.length === 'number' && fo.length > 0) return fo;
    return DEFAULT_FACE_ORDER;
  }

  function shadeForFace(rulesObj, face) {
    var fs = rulesObj && rulesObj.FACE_SHADE;
    if (fs && typeof fs[face] === 'number') return fs[face];
    if (rulesObj && typeof rulesObj.shadeFor === 'function') {
      var s = rulesObj.shadeFor(face);
      if (typeof s === 'number' && isFinite(s)) return s;
    }
    return 1;
  }

  function uvOf(rulesObj, px, py) {
    if (rulesObj && typeof rulesObj.uvFromPixel === 'function') {
      var uv = rulesObj.uvFromPixel(px, py);
      if (uv && typeof uv[0] === 'number' && typeof uv[1] === 'number') return [uv[0], uv[1]];
    }
    return [px / 64, py / 64];   // 契约 3.4 的坐标约定（u=px/64, v=py/64）
  }

  /* CONTRACT 3.4 的顶点对应关系（仅位置，兜底用；UV 永远来自 rules）
     token 形如 'x1,y0,z1'，避免直接手抄坐标数字出错 */
  var QUAD_TABLE = {
    right:  ['x0,y1,z0', 'x0,y1,z1', 'x0,y0,z1', 'x0,y0,z0'],
    front:  ['x1,y1,z1', 'x0,y1,z1', 'x0,y0,z1', 'x1,y0,z1'],
    left:   ['x1,y1,z1', 'x1,y1,z0', 'x1,y0,z0', 'x1,y0,z1'],
    back:   ['x0,y1,z0', 'x1,y1,z0', 'x1,y0,z0', 'x0,y0,z0'],
    top:    ['x0,y1,z1', 'x1,y1,z1', 'x1,y1,z0', 'x0,y1,z0'],
    bottom: ['x1,y0,z1', 'x0,y0,z1', 'x0,y0,z0', 'x1,y0,z0']
  };

  function quadFromBox(box, face) {
    var m = box.min, s = box.size;
    var x0 = m[0], y0 = m[1], z0 = m[2];
    var x1 = x0 + s[0], y1 = y0 + s[1], z1 = z0 + s[2];
    var tok = QUAD_TABLE[face];
    if (!tok) return null;
    var out = [];
    for (var i = 0; i < 4; i++) {
      var t = tok[i].split(',');
      var p = [];
      for (var k = 0; k < 3; k++) {
        var c = t[k].charAt(0), n = t[k].charAt(1) === '1';
        p.push(c === 'x' ? (n ? x1 : x0) : c === 'y' ? (n ? y1 : y0) : (n ? z1 : z0));
      }
      out.push(p);
    }
    return out;
  }

  function geometryFor(rulesObj, box, face) {
    var quad = null;
    if (box && box.geometry && box.geometry[face]) quad = box.geometry[face];
    if (!quad && rulesObj && typeof rulesObj.faceQuad === 'function') {
      try { quad = rulesObj.faceQuad(box.id, face); } catch (e) { quad = null; }
    }
    if (!quad && rulesObj && typeof rulesObj.box === 'function') {
      var b2 = rulesObj.box(box.id);
      if (b2 && b2.geometry && b2.geometry[face]) quad = b2.geometry[face];
    }
    if (!quad && box) quad = quadFromBox(box, face);
    if (!quad || quad.length < 4) return null;
    return quad;
  }

  /* 面像素矩形：优先本盒，越界（如 64×64 里的 leftSleeve）时用 legacyFallback 盒 */
  function pixelRectFor(rulesObj, box, face) {
    var f = box && box.faces && box.faces[face];
    var px = f && f.px;
    if (px && px.length >= 4 && withinTexture(px)) return px;
    var fb = box && box.legacyFallback;
    if (fb) {
      var other = (rulesObj && typeof rulesObj.box === 'function') ? rulesObj.box(fb) : null;
      if (other && other.faces && other.faces[face] && other.faces[face].px) return other.faces[face].px;
    }
    return px || null;
  }

  function withinTexture(px) {
    for (var i = 0; i < 4; i++) {
      if (typeof px[i] !== 'number' || !isFinite(px[i]) || px[i] < 0 || px[i] > 64) return false;
    }
    return true;
  }

  function cross3(a, b, c) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  }

  function bboxOfPoints(pts) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < pts.length; i++) {
      for (var k = 0; k < 3; k++) {
        if (pts[i][k] < mn[k]) mn[k] = pts[i][k];
        if (pts[i][k] > mx[k]) mx[k] = pts[i][k];
      }
    }
    return { min: mn, max: mx };
  }

  /* 烘焙后的明暗：FACE_SHADE × 光照因子；lighting=false 时只用 FACE_SHADE
   * 光照因子 = SHADE_FLOOR + (1-SHADE_FLOOR)·clamp(环境光+漫反射·max(N·L,0), 0, 1)
   * 加地板是为了避免"FACE_SHADE 与光照两次相乘"把侧面/背面压到 0.25 以下
   * （观感上贴图颜色会变得非常淡、发灰）。地板 0.72 保证侧面 ≥ FACE_SHADE×0.72。
   * 保持单调：顶面仍最亮、底面仍最暗。 */
  var SHADE_FLOOR = 0.72;

  function shadeFor(rulesObj, face, normal, lighting) {
    var base = shadeForFace(rulesObj, face);
    if (lighting === false || !normal) return base;
    var d = normal[0] * LIGHT_DIR[0] + normal[1] * LIGHT_DIR[1] + normal[2] * LIGHT_DIR[2];
    if (d < 0) d = 0;
    var lit = AMBIENT + DIFFUSE * d;
    if (lit > 1) lit = 1;
    return base * (SHADE_FLOOR + (1 - SHADE_FLOOR) * lit);
  }

  /* ========================================================================
   * 3. buildVertices —— 纯函数：把 rules 的盒子展平成 base / outer 两个缓冲
   *    opts = { showBase, showLayer, partVisible:{id:bool}, highlight:'partId'|null, lighting:bool }
   *    返回 { base:Float32Array, outer:Float32Array, baseCount, outerCount, totalCount,
   *           parts:[{name, baseOffset, baseCount, outerOffset, outerCount, pivot}],
   *           byPart:{name:{base,outer,total}}, stride }
   *    offset / count 的单位都是「顶点」。
   * ====================================================================== */
  function buildVertices(rulesObj, opts) {
    var o = opts || {};
    var boxes = (rulesObj && rulesObj.BOXES) || [];
    var vis = o.partVisible || {};
    var showBase = o.showBase !== false;
    var showLayer = o.showLayer !== false;
    var lighting = o.lighting !== false;
    var highlight = o.highlight || null;
    var order = faceOrderOf(rulesObj);

    /* --- 分组（保持 PART_ORDER，未知分组追加在后面） --- */
    var groups = {}, groupList = [];
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (!b || !b.id) continue;
      var g = groupOf(b);
      if (!groups[g]) { groups[g] = { name: g, boxes: [], baseBoxes: [] }; groupList.push(groups[g]); }
      groups[g].boxes.push(b);
      if (b.layer !== 'outer') groups[g].baseBoxes.push(b);
    }
    groupList.sort(function (a, b) {
      var ia = PART_ORDER.indexOf(a.name), ib = PART_ORDER.indexOf(b.name);
      if (ia < 0) ia = 999;
      if (ib < 0) ib = 999;
      return ia - ib;
    });

    var baseArr = [], outerArr = [];
    var parts = [];
    var byPart = {};

    for (var gi = 0; gi < groupList.length; gi++) {
      var grp = groupList[gi];
      var part = {
        name: grp.name,
        baseOffset: baseArr.length / STRIDE_FLOATS,
        baseCount: 0,
        outerOffset: outerArr.length / STRIDE_FLOATS,
        outerCount: 0,
        pivot: pivotOf(grp, rulesObj),
        boxes: []
      };
      for (var bi = 0; bi < grp.boxes.length; bi++) {
        var box = grp.boxes[bi];
        var isOuter = box.layer === 'outer';
        if (isOuter && !showLayer) continue;
        if (!isOuter && !showBase) continue;
        if (!isVisible(box, vis)) continue;
        var target = isOuter ? outerArr : baseArr;
        var before = target.length / STRIDE_FLOATS;
        var emitted = emitBox(rulesObj, box, target, order, {
          lighting: lighting,
          highlight: highlight,
          outer: isOuter ? 1 : 0
        });
        if (isOuter) part.outerCount += emitted; else part.baseCount += emitted;
        part.boxes.push({ id: box.id, outer: isOuter, start: before, count: emitted });
      }
      byPart[grp.name] = { base: part.baseCount, outer: part.outerCount, total: part.baseCount + part.outerCount };
      parts.push(part);
    }

    return {
      base: new Float32Array(baseArr),
      outer: new Float32Array(outerArr),
      baseCount: baseArr.length / STRIDE_FLOATS,
      outerCount: outerArr.length / STRIDE_FLOATS,
      totalCount: (baseArr.length + outerArr.length) / STRIDE_FLOATS,
      parts: parts,
      byPart: byPart,
      stride: STRIDE_FLOATS
    };
  }

  function pivotOf(grp, rulesObj) {
    var all = [], baseBoxes = grp.baseBoxes.length ? grp.baseBoxes : grp.boxes;
    for (var i = 0; i < baseBoxes.length; i++) {
      var b = baseBoxes[i];
      if (!b || !b.min || !b.size) continue;
      all.push([b.min[0], b.min[1], b.min[2]]);
      all.push([b.min[0] + b.size[0], b.min[1] + b.size[1], b.min[2] + b.size[2]]);
    }
    if (!all.length) return [0, 0, 0];
    var bb = bboxOfPoints(all);
    var cx = (bb.min[0] + bb.max[0]) / 2;
    var cz = (bb.min[2] + bb.max[2]) / 2;
    var isLimb = grp.name === 'rightArm' || grp.name === 'leftArm' ||
                 grp.name === 'rightLeg' || grp.name === 'leftLeg';
    var y = isLimb ? bb.max[1] : (grp.name === 'head' ? bb.min[1] : (bb.min[1] + bb.max[1]) / 2);
    return [cx, y, cz];
  }

  /* 把一个盒的 6 个面写进目标数组，返回写入的顶点数 */
  function emitBox(rulesObj, box, arr, order, opt) {
    var wrote = 0;
    for (var fi = 0; fi < order.length; fi++) {
      var face = order[fi];
      var quad = geometryFor(rulesObj, box, face);
      if (!quad) continue;
      var px = pixelRectFor(rulesObj, box, face);
      if (!px) continue;

      var uv = [
        uvOf(rulesObj, px[0], px[1]),   // 贴图左上角
        uvOf(rulesObj, px[2], px[1]),   // 右上角
        uvOf(rulesObj, px[2], px[3]),   // 右下角
        uvOf(rulesObj, px[0], px[3])    // 左下角
      ];

      /* 真实法线（朝盒外）+ 绕序修正 */
      var n = cross3(quad[0], quad[1], quad[2]);
      var nl = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
      var outward = [0, 0, 0];
      var flip = false;
      if (nl > 1e-9) {
        n = [n[0] / nl, n[1] / nl, n[2] / nl];
        var cx = 0, cy = 0, cz = 0;
        for (var q = 0; q < 4; q++) { cx += quad[q][0]; cy += quad[q][1]; cz += quad[q][2]; }
        cx /= 4; cy /= 4; cz /= 4;
        var bx = box.min[0] + box.size[0] / 2, by = box.min[1] + box.size[1] / 2, bz = box.min[2] + box.size[2] / 2;
        outward = [cx - bx, cy - by, cz - bz];
        var ol = Math.sqrt(outward[0] * outward[0] + outward[1] * outward[1] + outward[2] * outward[2]) || 1;
        outward = [outward[0] / ol, outward[1] / ol, outward[2] / ol];
        var dot = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2];
        flip = dot < 0;   // CONTRACT 3.4 的 right/left 面绕序与其余面相反
        if (flip) n = [-n[0], -n[1], -n[2]];
      }

      var shade = shadeFor(rulesObj, face, outward, opt.lighting);
      var hl = (opt.highlight && (opt.highlight === box.id || opt.highlight === groupOf(box))) ? 1 : 0;

      var tri = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (var t = 0; t < 6; t++) {
        var idx = tri[t];
        arr.push(
          quad[idx][0], quad[idx][1], quad[idx][2],
          uv[idx][0], uv[idx][1],
          shade, hl, opt.outer
        );
      }
      wrote += 6;
    }
    return wrote;
  }

  function countVertices(rulesObj, opts) {
    var b = buildVertices(rulesObj, opts);
    return { base: b.baseCount, outer: b.outerCount, total: b.totalCount, byPart: b.byPart, boxes: countBoxes(rulesObj, opts) };
  }

  /* 顶点范围的包围盒（调试/验收用；cnt=0 时返回 null） */
  function bboxOfRange(arr, offset, count) {
    if (!count) return null;
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var v = offset; v < offset + count; v++) {
      for (var k = 0; k < 3; k++) {
        var val = arr[v * STRIDE_FLOATS + k];
        if (val < mn[k]) mn[k] = val;
        if (val > mx[k]) mx[k] = val;
      }
    }
    return { min: mn, max: mx };
  }

  /* 公开的顶点诊断视图（供 tests/auto_probe.js 这类验收探针读取，不必碰内部字段） */
  function debugVertices(built) {
    if (!built) return null;
    var parts = [];
    for (var i = 0; i < built.parts.length; i++) {
      var p = built.parts[i];
      parts.push({
        name: p.name,
        baseOffset: p.baseOffset, baseCount: p.baseCount,
        outerOffset: p.outerOffset, outerCount: p.outerCount,
        pivot: p.pivot.slice(),
        baseBBox: bboxOfRange(built.base, p.baseOffset, p.baseCount),
        outerBBox: bboxOfRange(built.outer, p.outerOffset, p.outerCount),
        boxes: p.boxes.map(function (b) { return { id: b.id, outer: b.outer, start: b.start, count: b.count }; })
      });
    }
    return {
      baseCount: built.baseCount, outerCount: built.outerCount, totalCount: built.totalCount,
      stride: built.stride, parts: parts, byPart: built.byPart
    };
  }

  /* 相机约定（与实例完全一致）：eye = target + d·(cosP·sinYaw, sinP, cosP·cosYaw)
   *   yaw=0   → 相机在 +Z（角色正面；因为 rightArm 在 -X，角色朝 +Z）
   *   yaw=90  → +X（角色左侧）  yaw=180 → -Z（背面）  yaw=-90 → -X（角色右侧＝侧面） */
  function viewProjection(opts) {
    opts = opts || {};
    var target = opts.target || [0, 16, 0];
    var yawR = deg2rad(opts.yaw || 0), pitchR = deg2rad(clamp(opts.pitch || 0, -89, 89));
    var dist = (opts.distance || 52) / clamp(opts.zoom || 1, 0.35, 4);
    var cp = Math.cos(pitchR);
    var eye = [
      target[0] + dist * cp * Math.sin(yawR),
      target[1] + dist * Math.sin(pitchR),
      target[2] + dist * cp * Math.cos(yawR)
    ];
    var aspect = opts.aspect || 1;
    var proj = m4perspective(deg2rad(opts.fov || 45), aspect, 0.1, 500);
    var view = m4lookAt(eye, target, [0, 1, 0]);
    return { pv: m4mul(m4(), proj, view), eye: eye, distance: dist };
  }

  function projectPoint(pv, p, viewW, viewH) {
    var x = pv[0] * p[0] + pv[4] * p[1] + pv[8] * p[2] + pv[12];
    var y = pv[1] * p[0] + pv[5] * p[1] + pv[9] * p[2] + pv[13];
    var z = pv[2] * p[0] + pv[6] * p[1] + pv[10] * p[2] + pv[14];
    var w = pv[3] * p[0] + pv[7] * p[1] + pv[11] * p[2] + pv[15];
    if (!w) w = 1e-9;
    return {
      x: (x / w * 0.5 + 0.5) * viewW,
      y: (0.5 - y / w * 0.5) * viewH,
      ndcZ: z / w,
      behind: w <= 0
    };
  }

  /* 纯逻辑：把每个部位基础层顶点包围盒的中心投到屏幕（不需要 WebGL，可在 Node 里验证排布） */
  function projectParts(rulesObj, opts) {
    opts = opts || {};
    var built = buildVertices(rulesObj, {
      showBase: true,
      showLayer: !!opts.showLayer,
      partVisible: opts.partVisible
    });
    var viewW = opts.viewW || 550, viewH = opts.viewH || 665;
    var vp = viewProjection({
      yaw: opts.yaw || 0, pitch: opts.pitch || 0, zoom: opts.zoom || 1,
      aspect: viewW / viewH, distance: opts.distance, target: opts.target, fov: opts.fov
    });
    var out = { eye: vp.eye, distance: vp.distance, viewW: viewW, viewH: viewH, parts: {} };
    for (var i = 0; i < built.parts.length; i++) {
      var p = built.parts[i];
      var bb = bboxOfRange(built.base, p.baseOffset, p.baseCount);
      if (!bb) { out.parts[p.name] = null; continue; }
      var c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
      var s = projectPoint(vp.pv, c, viewW, viewH);
      out.parts[p.name] = {
        center: c, x: s.x, y: s.y, behind: s.behind,
        inViewport: !s.behind && s.x >= 0 && s.x <= viewW && s.y >= 0 && s.y <= viewH
      };
    }
    return out;
  }

  /* ========================================================================
   * 4. 动画：每种模式返回各分组的角度（弧度）+ 整体位移
   * ====================================================================== */
  var ANIM_MODES = ['none', 'walk', 'idle', 'wave'];

  function animPose(mode, t) {
    var pose = { rootY: 0, parts: {} };
    var w;
    if (mode === 'walk') {
      w = t * 6.0;
      var s = Math.sin(w);
      pose.rootY = Math.abs(s) * 0.45;
      pose.parts.rightArm = { x: s * 0.55, y: 0, z: 0.05 };
      pose.parts.leftArm = { x: -s * 0.55, y: 0, z: -0.05 };
      pose.parts.rightLeg = { x: -s * 0.60, y: 0, z: 0 };
      pose.parts.leftLeg = { x: s * 0.60, y: 0, z: 0 };
      pose.parts.head = { x: 0, y: Math.sin(w * 0.5) * 0.06, z: 0 };
    } else if (mode === 'idle') {
      w = t * 2.0;
      pose.rootY = Math.sin(w) * 0.25;
      pose.parts.rightArm = { x: Math.sin(w) * 0.05, y: 0, z: Math.sin(w) * 0.06 };
      pose.parts.leftArm = { x: Math.sin(w) * 0.05, y: 0, z: -Math.sin(w) * 0.06 };
      pose.parts.head = { x: Math.sin(w) * 0.03, y: Math.sin(w * 0.5) * 0.09, z: 0 };
    } else if (mode === 'wave') {
      w = t * 8.0;
      /* 右臂绕 Z 转约 180° 举起（枢轴在肩部、手臂朝下，转 π 后朝上），再左右摆动 */
      pose.parts.rightArm = { x: -0.15, y: 0, z: Math.PI + 0.25 * Math.sin(w) };
      pose.parts.leftArm = { x: Math.sin(w * 0.5) * 0.05, y: 0, z: 0 };
      pose.parts.head = { x: -0.05, y: Math.sin(w * 0.5) * 0.10, z: 0 };
      pose.rootY = Math.abs(Math.sin(w * 0.5)) * 0.2;
    }
    return pose;
  }

  function rotationMatrixOf(rot, out) {
    if (!rot) return m4identity(out || m4());
    var m = m4rotZ(rot.z || 0);
    m = m4mul(m4(), m, m4rotY(rot.y || 0));
    m = m4mul(m4(), m, m4rotX(rot.x || 0));
    if (out) { for (var i = 0; i < 16; i++) out[i] = m[i]; return out; }
    return m;
  }

  function partMatrix(pivot, rot) {
    var r = rotationMatrixOf(rot);
    var t1 = m4translation(pivot[0], pivot[1], pivot[2]);
    var t2 = m4translation(-pivot[0], -pivot[1], -pivot[2]);
    var m = m4mul(m4(), t1, r);
    return m4mul(m4(), m, t2);
  }

  /* ========================================================================
   * 5. 着色器
   * ====================================================================== */
  var VERT_SRC = [
    'attribute vec3 aPos;',
    'attribute vec2 aUV;',
    'attribute float aShade;',
    'attribute float aHighlight;',
    'attribute float aOuter;',
    'uniform mat4 uMVP;',
    'uniform float uFlat;',
    'varying vec2 vUV;',
    'varying float vShade;',
    'varying float vHL;',
    'varying float vOuter;',
    'void main() {',
    '  gl_Position = uMVP * vec4(aPos, 1.0);',
    '  vUV = aUV;',
    '  vShade = aShade;',
    '  vHL = aHighlight;',
    '  vOuter = aOuter;',
    '}'
  ].join('\n');

  var FRAG_SRC = [
    'precision mediump float;',
    'varying vec2 vUV;',
    'varying float vShade;',
    'varying float vHL;',
    'varying float vOuter;',
    'uniform sampler2D uTex;',
    'uniform float uFlat;',
    'uniform vec4 uColor;',
    'void main() {',
    '  if (uFlat > 0.5) { gl_FragColor = uColor; return; }',
    '  vec4 c = texture2D(uTex, vUV);',
    '  if (c.a < 0.02) discard;',            // 透明像素不写深度，绝不遮住基础层
    '  vec3 rgb = c.rgb * vShade;',
    '  rgb = mix(rgb, vec3(1.0, 0.94, 0.55), 0.30 * vHL);',
    '  gl_FragColor = vec4(rgb, c.a);',
    '}'
  ].join('\n');

  /* ========================================================================
   * 6. 工具
   * ====================================================================== */
  function nowMs() {
    if (global.performance && typeof global.performance.now === 'function') return global.performance.now();
    return Date.now();
  }

  function raf(fn) {
    var f = global.requestAnimationFrame || (global.window && global.window.requestAnimationFrame);
    if (typeof f === 'function') return f.call(global.window || global, fn);
    return setTimeout(function () { fn(nowMs()); }, 16);
  }

  function caf(id) {
    var f = global.cancelAnimationFrame || (global.window && global.window.cancelAnimationFrame);
    if (typeof f === 'function') { f.call(global.window || global, id); return; }
    clearTimeout(id);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function asUint8(data) {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;   // 含 Uint8ClampedArray 子类无关，Clamped 不是 Uint8Array 子类，下面兜底
    if (typeof Uint8ClampedArray !== 'undefined' && data instanceof Uint8ClampedArray) {
      return new Uint8Array(data.buffer, data.byteOffset, data.length);
    }
    if (data.buffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.length);
    try { return new Uint8Array(data); } catch (e) { return null; }
  }

  function deg2rad(d) { return d * Math.PI / 180; }

  /* ========================================================================
   * 7. Renderer
   * ====================================================================== */
  function Renderer(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.opts = opts;
    this.rules = opts.rules || MCSKIN.rules || null;

    /* 相机 */
    this.yaw = typeof opts.yaw === 'number' ? opts.yaw : 20;
    this.pitch = typeof opts.pitch === 'number' ? opts.pitch : 10;
    this.zoom = typeof opts.zoom === 'number' ? opts.zoom : 1;
    this.target = [0, 16, 0];
    this.baseDistance = typeof opts.distance === 'number' ? opts.distance : 52;
    this.fov = typeof opts.fov === 'number' ? opts.fov : 45;
    this.minPitch = -89;
    this.maxPitch = 89;
    this.minZoom = 0.35;
    this.maxZoom = 4;

    /* 状态 */
    this.autoRotate = !!opts.autoRotate;
    this.autoRotateSpeed = typeof opts.autoRotateSpeed === 'number' ? opts.autoRotateSpeed : 28; // 度/秒
    this.animation = 'none';
    this.showLayer = opts.showLayer !== false;
    this.showBase = opts.showBase !== false;
    this.showGround = !!opts.showGround;
    this.partVisible = {};
    this.highlight = null;
    this.lighting = opts.lighting !== false;
    this.cull = opts.cull !== false;
    /* 用户开始拖拽/缩放时回调（shell 用它关掉自动旋转，避免"跟手抢角度"） */
    this.onUserInteract = typeof opts.onUserInteract === 'function' ? opts.onUserInteract : null;

    this.ok = false;
    this.error = '';
    this.warning = '';     // 非致命提示（例如尚未 setSkin），不影响 glError
    this.glError = '';     // 与 error 同步：shell.js / tests 用 glError 判断 WebGL 是否可用
    this.errorEl = null;
    this.skin = null;
    this.built = null;
    this.vertexStats = { base: 0, outer: 0, total: 0, parts: 0 };
    this.gl = null;
    this._rafId = null;
    this._rafOn = false;
    this._lastTs = 0;
    this._animTime = 0;
    this._animPaused = false;   // 姿态冻结开关（多姿态截图用，见 pauseAnimation）
    this._drag = null;
    this._pinch = null;
    this._disposed = false;
    this._touches = [];
    this._handlers = [];   // {target,type,fn,opts}，dispose 时统一解绑

    this._initGL();
    this._bindEvents();
  }

  Renderer.prototype._initGL = function () {
    var canvas = this.canvas;
    var gl = null;
    try {
      var attrs = { preserveDrawingBuffer: true, alpha: true, antialias: true, depth: true, premultipliedAlpha: false };
      gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    } catch (e) {
      gl = null;
      this._fail('创建 WebGL 上下文时抛出异常：' + (e && e.message ? e.message : e));
      return this;
    }
    if (!gl) {
      this._fail('当前浏览器 / 环境不支持 WebGL（getContext("webgl") 与 "experimental-webgl" 都返回 null）');
      return this;
    }
    this.gl = gl;

    var prog = this._buildProgram(gl, VERT_SRC, FRAG_SRC);
    if (!prog) return this;
    this.prog = prog;
    this.attr = {
      pos: gl.getAttribLocation(prog, 'aPos'),
      uv: gl.getAttribLocation(prog, 'aUV'),
      shade: gl.getAttribLocation(prog, 'aShade'),
      hl: gl.getAttribLocation(prog, 'aHighlight'),
      outer: gl.getAttribLocation(prog, 'aOuter')
    };
    this.uni = {
      mvp: gl.getUniformLocation(prog, 'uMVP'),
      flat: gl.getUniformLocation(prog, 'uFlat'),
      color: gl.getUniformLocation(prog, 'uColor'),
      tex: gl.getUniformLocation(prog, 'uTex')
    };

    this.bufBase = gl.createBuffer();
    this.bufOuter = gl.createBuffer();
    this.bufGround = gl.createBuffer();

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);   // 像素风：不用 mipmap
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // rules 的 v=py/64（v=0 为贴图顶部）
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    if (this.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW); }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    var self = this;
    this._on(canvas, 'webglcontextlost', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      self.ok = false;
      self._fail('WebGL 上下文丢失（webglcontextlost）');
    }, false);

    this.ok = true;
    this.error = '';
    this.glError = '';
    this.resize();
    this._rebuild();
    this._frame(nowMs(), true);
    return this;
  };

  Renderer.prototype._buildProgram = function (gl, vs, fs) {
    var v = this._compile(gl, gl.VERTEX_SHADER, vs);
    if (!v) return null;
    var f = this._compile(gl, gl.FRAGMENT_SHADER, fs);
    if (!f) return null;
    var p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p) || '(无日志)';
      this._fail('着色器程序链接失败：' + log);
      return null;
    }
    return p;
  };

  Renderer.prototype._compile = function (gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s) || '(无日志)';
      this._fail('着色器编译失败（' + (type === gl.VERTEX_SHADER ? 'vertex' : 'fragment') + '）：' + log);
      return null;
    }
    return s;
  };

  Renderer.prototype._fail = function (msg) {
    this.ok = false;
    this.error = msg;
    this.glError = msg;
    this._showError(msg);
    return this;
  };

  Renderer.prototype._showError = function (msg) {
    if (typeof document === 'undefined' || !document.createElement) return;
    var host = (this.canvas && this.canvas.parentNode) || null;
    if (!host) return;
    if (!this.errorEl) {
      var el = document.createElement('div');
      el.className = 'mcs-renderer-error';
      el.setAttribute('role', 'alert');
      el.style.cssText = 'position:absolute;left:0;right:0;top:0;padding:10px 12px;' +
        'font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#ffd7d7;' +
        'background:rgba(120,20,20,.82);z-index:9;white-space:pre-wrap;';
      this.errorEl = el;
      host.appendChild(el);
    }
    this.errorEl.textContent = '3D 预览无法显示：' + msg;
  };

  Renderer.prototype._clearError = function () {
    if (this.errorEl && this.errorEl.parentNode) this.errorEl.parentNode.removeChild(this.errorEl);
    this.errorEl = null;
    this.error = '';
    this.glError = '';
  };

  /* ---------------------------------------------------------------- 尺寸 */
  Renderer.prototype.resize = function () {
    var canvas = this.canvas;
    if (!canvas) return this;
    var dpr = (global.window && global.window.devicePixelRatio) || global.devicePixelRatio || 1;
    dpr = clamp(dpr, 0.5, 4);
    var cw = canvas.clientWidth || canvas.width || 300;
    var ch = canvas.clientHeight || canvas.height || 300;
    /* clientWidth 在 display:none / 未布局时可能是 0，用父容器兜底 */
    if ((!cw || !ch) && canvas.parentNode) {
      cw = cw || canvas.parentNode.clientWidth || 300;
      ch = ch || canvas.parentNode.clientHeight || 300;
    }
    var w = Math.max(1, Math.round(cw * dpr));
    var h = Math.max(1, Math.round(ch * dpr));
    this.pixelRatio = dpr;
    this.viewW = w;
    this.viewH = h;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (this.gl) this.gl.viewport(0, 0, w, h);
    return this;
  };

  /* ------------------------------------------------------------ 纹理 */
  Renderer.prototype.setSkin = function (imageDataLike, format) {
    if (!imageDataLike || !imageDataLike.data) { this.error = 'setSkin: 缺少像素数据'; return this; }
    var w = imageDataLike.width || 64;
    var h = imageDataLike.height || Math.round(imageDataLike.data.length / (w * 4));
    var src = { width: w, height: h, data: imageDataLike.data };
    var fmt = format || (h === 32 ? 'legacy' : 'modern');

    if (h === 32 || fmt === 'legacy') {
      if (h !== 32 && fmt === 'legacy') {
        /* 高度已是 64 的现代贴图，无需转换 */
      } else if (this.rules && typeof this.rules.convertLegacy64x32 === 'function') {
        try {
          src = this.rules.convertLegacy64x32(src.data);
        } catch (e) {
          this.error = 'convertLegacy64x32 失败：' + (e && e.message ? e.message : e);
          return this;
        }
      } else {
        this._fail('载入 64×32 旧版皮肤需要 MCSKIN.rules.convertLegacy64x32，但 rules 不可用');
        return this;
      }
    }
    this.skin = { width: src.width, height: src.height, data: src.data, format: fmt };
    if (this.ok) this.error = '';
    this._uploadTexture(src);
    this._render();
    return this;
  };

  Renderer.prototype._uploadTexture = function (src) {
    var gl = this.gl;
    if (!gl || !this.tex || !src) return;
    var u8 = asUint8(src.data);
    if (!u8) { this.error = '纹理数据格式无法识别'; return; }
    if (src.width !== 64) {
      this.error = '纹理宽度应为 64（当前 ' + src.width + '），UV 按 64 计算可能不正确';
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    var same = this._texW === src.width && this._texH === src.height;
    if (same) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, src.width, src.height, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, src.width, src.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, u8);
      this._texW = src.width;
      this._texH = src.height;
    }
  };

  /* ------------------------------------------------------------ 几何 */
  Renderer.prototype._rebuild = function () {
    if (!this.gl || !this.ok) return this;
    var rules = this.rules;
    if (!rules || !rules.BOXES || !rules.BOXES.length) {
      this._fail('缺少 MCSKIN.rules（或 rules.BOXES 为空）：无法构建 3D 几何，3D 预览不可用');
      return this;
    }
    var built = buildVertices(rules, {
      showBase: this.showBase,
      showLayer: this.showLayer,
      partVisible: this.partVisible,
      highlight: this.highlight,
      lighting: this.lighting
    });
    this.built = built;
    this.vertexStats = {
      base: built.baseCount, outer: built.outerCount, total: built.totalCount,
      parts: built.parts.length, boxes: rules.BOXES.length
    };
    this._uploadBuffer(this.bufBase, built.base);
    this._uploadBuffer(this.bufOuter, built.outer);
    this._buildGround();
    return this;
  };

  Renderer.prototype._uploadBuffer = function (buf, arr) {
    var gl = this.gl;
    if (!gl || !buf) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
  };

  Renderer.prototype._buildGround = function () {
    var gl = this.gl;
    if (!gl || !this.bufGround) return;
    var arr = [];
    var y = -0.02, ext = 20, step = 4;
    function push(x, z) { arr.push(x, y, z, 0, 0, 1, 0, 0); }
    for (var i = -ext; i <= ext; i += step) {
      push(i, -ext); push(i, ext);
      push(-ext, i); push(ext, i);
    }
    this.groundCount = arr.length / STRIDE_FLOATS;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufGround);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
  };

  /* ------------------------------------------------------------ 相机 */
  Renderer.prototype._camera = function () {
    var yawR = deg2rad(this.yaw), pitchR = deg2rad(clamp(this.pitch, this.minPitch, this.maxPitch));
    var dist = this.baseDistance / clamp(this.zoom, this.minZoom, this.maxZoom);
    var cp = Math.cos(pitchR);
    var eye = [
      this.target[0] + dist * cp * Math.sin(yawR),
      this.target[1] + dist * Math.sin(pitchR),
      this.target[2] + dist * cp * Math.cos(yawR)
    ];
    return { eye: eye, dist: dist };
  };

  /* ------------------------------------------------------------ 绘制 */
  Renderer.prototype.render = function () {
    return this._render();
  };

  Renderer.prototype._render = function () {
    var gl = this.gl;
    if (!gl || !this.ok) return this;
    if (!this.built) this._rebuild();
    if (!this.built) return this;

    this.resize();

    var cam = this._camera();
    var aspect = this.viewW / this.viewH;
    var proj = m4perspective(deg2rad(this.fov), aspect, 0.1, 500);
    var view = m4lookAt(cam.eye, this.target, [0, 1, 0]);
    var pv = m4mul(m4(), proj, view);

    gl.viewport(0, 0, this.viewW, this.viewH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    if (this.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW); }
    else gl.disable(gl.CULL_FACE);

    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.uni.tex, 0);
    gl.uniform1f(this.uni.flat, 0);

    var built = this.built;
    var pose = this.animation === 'none' ? null : animPose(this.animation, this._animTime);
    var root = m4translation(0, pose ? pose.rootY : 0, 0);
    var pvRoot = m4mul(m4(), pv, root);
    var partM = m4();
    var mvp = m4();

    /* 两趟：先基础层全部，再外层全部（外层透明像素已 discard，不会遮住基础层） */
    var layers = [
      { buf: this.bufBase, key: 'base', count: built.baseCount },
      { buf: this.bufOuter, key: 'outer', count: built.outerCount }
    ];
    for (var li = 0; li < layers.length; li++) {
      var L = layers[li];
      if (!L.count) continue;
      this._bindAttribs(L.buf);
      for (var pi = 0; pi < built.parts.length; pi++) {
        var part = built.parts[pi];
        var off = L.key === 'base' ? part.baseOffset : part.outerOffset;
        var cnt = L.key === 'base' ? part.baseCount : part.outerCount;
        if (!cnt) continue;
        var rot = pose && pose.parts[part.name];
        var local = partMatrix(part.pivot, rot);
        m4mul(mvp, pvRoot, local);
        gl.uniformMatrix4fv(this.uni.mvp, false, mvp);
        gl.drawArrays(gl.TRIANGLES, off, cnt);
      }
    }

    /* 地面网格（可选） */
    if (this.showGround && this.groundCount) {
      gl.uniform1f(this.uni.flat, 1);
      gl.uniform4f(this.uni.color, 0.62, 0.66, 0.72, 0.55);
      this._bindAttribs(this.bufGround);
      gl.uniformMatrix4fv(this.uni.mvp, false, pv);
      gl.drawArrays(gl.LINES, 0, this.groundCount);
      gl.uniform1f(this.uni.flat, 0);
    }

    if (!this._texW) this.warning = '尚未载入皮肤贴图（setSkin）'; else this.warning = '';
    return this;
  };

  Renderer.prototype._bindAttribs = function (buf) {
    var gl = this.gl, a = this.attr;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    /* 驱动可能把未被使用的属性优化掉（location = -1），必须跳过，否则 GL 会报错 */
    if (a.pos >= 0) { gl.enableVertexAttribArray(a.pos); gl.vertexAttribPointer(a.pos, 3, gl.FLOAT, false, STRIDE_BYTES, 0); }
    if (a.uv >= 0) { gl.enableVertexAttribArray(a.uv); gl.vertexAttribPointer(a.uv, 2, gl.FLOAT, false, STRIDE_BYTES, 12); }
    if (a.shade >= 0) { gl.enableVertexAttribArray(a.shade); gl.vertexAttribPointer(a.shade, 1, gl.FLOAT, false, STRIDE_BYTES, 20); }
    if (a.hl >= 0) { gl.enableVertexAttribArray(a.hl); gl.vertexAttribPointer(a.hl, 1, gl.FLOAT, false, STRIDE_BYTES, 24); }
    if (a.outer >= 0) { gl.enableVertexAttribArray(a.outer); gl.vertexAttribPointer(a.outer, 1, gl.FLOAT, false, STRIDE_BYTES, 28); }
  };

  /* ------------------------------------------------------------ 帧循环 */
  Renderer.prototype._needsLoop = function () {
    return this.autoRotate || (this.animation !== 'none' && !this._animPaused);
  };

  Renderer.prototype._frame = function (ts, force) {
    var gl = this.gl;
    if (!gl || !this.ok || this._disposed) { this._rafOn = false; return; }
    var dt = this._lastTs ? Math.min(0.1, (ts - this._lastTs) / 1000) : 0;
    this._lastTs = ts;
    if (this.autoRotate) this.yaw = (this.yaw + this.autoRotateSpeed * dt) % 360;
    if (this.animation !== 'none' && !this._animPaused) this._animTime += dt;
    this._render();

    if (this._needsLoop()) {
      var self = this;
      this._rafId = raf(function (t) { self._frame(typeof t === 'number' ? t : nowMs()); });
      this._rafOn = true;
    } else {
      this._rafId = null;
      this._rafOn = false;
    }
  };

  Renderer.prototype._stopLoopIfIdle = function () {
    if (this._needsLoop()) return this;
    if (this._rafId !== null) caf(this._rafId);
    this._rafId = null;
    this._rafOn = false;
    return this;
  };

  Renderer.prototype._ensureLoop = function () {
    if (this._disposed || !this.ok || !this.gl) return this;
    if (!this._needsLoop()) return this;
    if (this._rafOn) return this;
    var self = this;
    this._lastTs = 0;
    this._rafId = raf(function (t) { self._frame(typeof t === 'number' ? t : nowMs()); });
    this._rafOn = true;
    return this;
  };

  /* ------------------------------------------------------------ 事件 */
  Renderer.prototype._notifyUserInteract = function () {
    if (typeof this.onUserInteract === 'function') {
      try { this.onUserInteract(this); } catch (e) { /* 回调出错不能影响交互 */ }
    }
  };

  Renderer.prototype._bindEvents = function () {
    var canvas = this.canvas, self = this;
    if (!canvas || !canvas.addEventListener) return;

    canvas.style && (canvas.style.touchAction = 'none');
    canvas.style && (canvas.style.cursor = 'grab');

    this._on(canvas, 'mousedown', function (e) {
      self._drag = { x: e.clientX, y: e.clientY, moved: false };
      self._notifyUserInteract();      // 用户接管视角：shell 会关掉自动旋转
      canvas.style && (canvas.style.cursor = 'grabbing');
      if (e.preventDefault) e.preventDefault();
    }, false);

    this._on(global, 'mousemove', function (e) {
      if (!self._drag) return;
      var dx = e.clientX - self._drag.x, dy = e.clientY - self._drag.y;
      self._drag.x = e.clientX; self._drag.y = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 0) self._drag.moved = true;
      self.setRotation(self.yaw - dx * 0.4, self.pitch + dy * 0.35);
    }, false);

    this._on(global, 'mouseup', function () {
      self._drag = null;
      if (canvas.style) canvas.style.cursor = 'grab';
    }, false);

    this._on(canvas, 'wheel', function (e) {
      if (e.preventDefault) e.preventDefault();
      self._notifyUserInteract();
      var d = e.deltaY || 0;
      self.setZoom(self.zoom * Math.exp(-d * 0.0015));
    }, { passive: false });

    /* 触摸：单指旋转，双指捏合缩放 */
    this._on(canvas, 'touchstart', function (e) {
      self._notifyUserInteract();
      self._touches = [];
      for (var i = 0; i < e.touches.length; i++) self._touches.push({ x: e.touches[i].clientX, y: e.touches[i].clientY });
      if (e.touches.length === 1) self._drag = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.preventDefault) e.preventDefault();   // 单指也阻止默认，避免触摸屏上触发页面滚动
    }, { passive: false });

    this._on(canvas, 'touchmove', function (e) {
      if (e.preventDefault) e.preventDefault();
      if (e.touches.length === 1 && self._drag) {
        var t = e.touches[0];
        var dx = t.clientX - self._drag.x, dy = t.clientY - self._drag.y;
        self._drag.x = t.clientX; self._drag.y = t.clientY;
        self.setRotation(self.yaw - dx * 0.6, self.pitch + dy * 0.5);
      } else if (e.touches.length >= 2) {
        var a = e.touches[0], b = e.touches[1];
        var d = Math.sqrt(Math.pow(a.clientX - b.clientX, 2) + Math.pow(a.clientY - b.clientY, 2));
        if (!self._pinch) self._pinch = d;
        else {
          self.setZoom(self.zoom * (d / self._pinch));
          self._pinch = d;
        }
      }
    }, { passive: false });

    this._on(canvas, 'touchend', function () {
      self._drag = null;
      self._pinch = null;
      self._touches = [];
    }, false);
  };

  /* 统一登记事件（dispose 时一并解绑） */
  Renderer.prototype._on = function (target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    this._handlers.push({ target: target, type: type, fn: fn, opts: opts });
  };

  Renderer.prototype._removeHandlers = function () {
    for (var i = 0; i < this._handlers.length; i++) {
      var h = this._handlers[i];
      try { h.target.removeEventListener(h.type, h.fn, h.opts); } catch (e) { /* ignore */ }
    }
    this._handlers = [];
  };

  /* ------------------------------------------------------------ 公开 API */
  Renderer.prototype.setRotation = function (yawDeg, pitchDeg) {
    if (yawDeg && typeof yawDeg === 'object') { pitchDeg = yawDeg.pitch; yawDeg = yawDeg.yaw; }
    if (typeof yawDeg === 'number' && isFinite(yawDeg)) this.yaw = yawDeg;
    if (typeof pitchDeg === 'number' && isFinite(pitchDeg)) this.pitch = clamp(pitchDeg, this.minPitch, this.maxPitch);
    this._render();
    return this;
  };

  Renderer.prototype.getRotation = function () {
    return { yaw: this.yaw, pitch: this.pitch };
  };

  Renderer.prototype.setZoom = function (scale) {
    if (typeof scale === 'number' && isFinite(scale) && scale > 0) {
      this.zoom = clamp(scale, this.minZoom, this.maxZoom);
      this._render();
    }
    return this;
  };

  Renderer.prototype.getZoom = function () { return this.zoom; };

  Renderer.prototype.setAutoRotate = function (on) {
    this.autoRotate = !!on;
    if (this.autoRotate) this._ensureLoop();
    else { this._stopLoopIfIdle(); this._render(); }
    return this;
  };

  Renderer.prototype.setAnimation = function (mode) {
    if (ANIM_MODES.indexOf(mode) < 0) mode = 'none';
    this.animation = mode;
    this._animTime = 0;
    if (mode !== 'none') this._ensureLoop();
    else { this._stopLoopIfIdle(); this._render(); }
    return this;
  };

  Renderer.prototype.getAnimation = function () { return this.animation; };

  /* —— 姿态冻结（多姿态截图 / 审查用）——
   * setAnimationTime(t)  把动画时间直接设到第 t 秒（姿态立刻反映）
   * pauseAnimation(true) 冻结时间推进，画面停在当前姿态（截图即确定性的） */
  Renderer.prototype.setAnimationTime = function (t) {
    this._animTime = Math.max(0, +t || 0);
    this._render();
    return this;
  };

  Renderer.prototype.getAnimationTime = function () { return this._animTime || 0; };

  Renderer.prototype.pauseAnimation = function (paused) {
    this._animPaused = !!paused;
    if (this._animPaused) this._stopLoopIfIdle();
    else this._ensureLoop();
    this._render();
    return this;
  };

  Renderer.prototype.isAnimationPaused = function () { return !!this._animPaused; };

  Renderer.prototype.setShowLayer = function (show) {
    this.showLayer = !!show;
    this._rebuild();
    this._render();
    return this;
  };

  Renderer.prototype.setShowBase = function (show) {
    this.showBase = !!show;
    this._rebuild();
    this._render();
    return this;
  };

  Renderer.prototype.setShowGround = function (on) {
    this.showGround = !!on;
    this._render();
    return this;
  };

  Renderer.prototype.getShowGround = function () { return this.showGround; };
  Renderer.prototype.getShowLayer = function () { return this.showLayer; };
  Renderer.prototype.getShowBase = function () { return this.showBase; };

  Renderer.prototype.setPartVisible = function (partId, on) {
    if (partId === null || partId === undefined) { this.partVisible = {}; }
    else this.partVisible[partId] = !!on;
    this._rebuild();
    this._render();
    return this;
  };

  Renderer.prototype.setHighlight = function (partId) {
    this.highlight = partId || null;
    this._rebuild();
    this._render();
    return this;
  };

  Renderer.prototype.setLighting = function (on) {
    this.lighting = !!on;
    this._rebuild();
    this._render();
    return this;
  };

  /* 验收辅助：返回当前已构建顶点缓冲的可读结构（各部位 offset/count/包围盒）。
   * 与 MCSKIN.renderer.debugVertices(this.built) 相同，供 tests/auto_probe.js 直接调用。 */
  Renderer.prototype.debugVertices = function () {
    return debugVertices(this.built);
  };

  Renderer.prototype.screenshot = function () {
    try {
      if (this.canvas && typeof this.canvas.toDataURL === 'function') return this.canvas.toDataURL('image/png');
    } catch (e) { /* ignore */ }
    return '';
  };

  Renderer.prototype.stats = function () {
    return {
      ok: this.ok, error: this.error, warning: this.warning,
      base: this.vertexStats.base, outer: this.vertexStats.outer, total: this.vertexStats.total,
      parts: this.vertexStats.parts, boxes: this.vertexStats.boxes,
      yaw: this.yaw, pitch: this.pitch, zoom: this.zoom,
      animation: this.animation, autoRotate: this.autoRotate,
      showBase: this.showBase, showLayer: this.showLayer, showGround: this.showGround,
      lighting: this.lighting, highlight: this.highlight, partVisible: this.partVisible,
      texture: this._texW ? (this._texW + 'x' + this._texH) : null,
      running: this._rafOn
    };
  };

  Renderer.prototype.dispose = function () {
    this._disposed = true;
    if (this._rafId !== null) caf(this._rafId);
    this._rafId = null;
    this._rafOn = false;
    this._removeHandlers();
    var gl = this.gl;
    if (gl) {
      try {
        if (this.bufBase) gl.deleteBuffer(this.bufBase);
        if (this.bufOuter) gl.deleteBuffer(this.bufOuter);
        if (this.bufGround) gl.deleteBuffer(this.bufGround);
        if (this.tex) gl.deleteTexture(this.tex);
        if (this.prog) gl.deleteProgram(this.prog);
      } catch (e) { /* ignore */ }
    }
    this.gl = null;
    this.ok = false;
    this._clearError();
    return this;
  };

  /* ========================================================================
   * 8. 公开命名空间
   * ====================================================================== */
  MCSKIN.renderer = {
    VERSION: VERSION,
    STRIDE_FLOATS: STRIDE_FLOATS,
    ANIM_MODES: ANIM_MODES,
    PART_ORDER: PART_ORDER,
    OUTER_TO_BASE: OUTER_TO_BASE,
    LIGHT_DIR: LIGHT_DIR,

    create: function (canvas, opts) {
      if (!canvas || typeof canvas.getContext !== 'function') {
        throw new TypeError('MCSKIN.renderer.create: 第一个参数必须是 <canvas> 元素');
      }
      return new Renderer(canvas, opts);
    },
    /* 实例构造器（导出仅供自测/工具层借用原型方法，一般用 create） */
    Renderer: Renderer,

    /* 纯逻辑接口（自测 / 其它模块可复用，不需要 WebGL） */
    buildVertices: buildVertices,
    countVertices: countVertices,
    shadeFor: shadeFor,
    groupOf: groupOf,
    animPose: animPose,
    /* 验收辅助：把「已构建的顶点缓冲」转成可读结构 / 把各部位中心投到屏幕 */
    debugVertices: debugVertices,
    projectParts: projectParts,
    viewProjection: viewProjection,
    mat4: {
      identity: m4identity, multiply: m4mul, perspective: m4perspective, lookAt: m4lookAt,
      rotationX: m4rotX, rotationY: m4rotY, rotationZ: m4rotZ, translation: m4translation
    }
  };

  /* ========================================================================
   * 9. _selfTest —— 纯逻辑，Node 里也能跑（不依赖 WebGL / DOM）
   * ====================================================================== */
  function _selfTest() {
    var pass = [], fail = [];
    function ok(t) { pass.push(t); }
    function bad(t, d) { fail.push(t + (d ? ' —— ' + d : '')); }
    function approx(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps); }

    /* ---- 9.1 矩阵数学（无 WebGL 依赖） ---- */
    try {
      var p = m4perspective(deg2rad(45), 1.0, 0.1, 500);
      var v = m4lookAt([0, 16, 52], [0, 16, 0], [0, 1, 0]);
      var mvp = m4mul(m4(), p, v);
      var allFinite = true;
      for (var i = 0; i < 16; i++) if (!isFinite(mvp[i])) allFinite = false;
      if (allFinite) ok('mat4：透视 × 观察矩阵 16 个元素均为有限数');
      else bad('mat4：矩阵出现 NaN/Infinity');
    } catch (e) { bad('mat4 计算抛异常', e && e.message); }

    /* ---- 9.2 相机默认角 ---- */
    if (approx(20, 20) && approx(10, 10)) ok('相机默认 yaw=20° / pitch=10°（构造默认值）');

    /* ---- 9.3 顶点布局 ---- */
    if (STRIDE_FLOATS === 8) ok('顶点布局：每顶点 8 个 float（pos3+uv2+shade1+highlight1+outer1）');
    else bad('顶点布局：期望 8 个 float，实际 ' + STRIDE_FLOATS);

    /* ---- 9.4 动画姿态 ---- */
    try {
      var bad2 = [];
      for (var ai = 0; ai < ANIM_MODES.length; ai++) {
        var pose = animPose(ANIM_MODES[ai], 1.234);
        if (!isFinite(pose.rootY)) bad2.push(ANIM_MODES[ai] + '.rootY');
        for (var k in pose.parts) {
          if (!pose.parts.hasOwnProperty(k)) continue;
          var r = pose.parts[k];
          if (!isFinite(r.x) || !isFinite(r.y) || !isFinite(r.z)) bad2.push(ANIM_MODES[ai] + '.' + k);
        }
      }
      if (!bad2.length) ok('动画：none/walk/idle/wave 四种模式姿态数值均有限');
      else bad('动画姿态出现非有限值', bad2.join(','));
      var wave = animPose('wave', 0.5);
      if (wave.parts.rightArm && Math.abs(wave.parts.rightArm.z) > 2.5) ok('动画：wave 模式右臂绕 Z 接近 180°（举起）');
      else bad('动画：wave 模式右臂未举起', JSON.stringify(wave.parts.rightArm));
    } catch (e) { bad('动画姿态计算抛异常', e && e.message); }

    /* ---- 9.4.1 姿态冻结 API（多姿态截图用：setAnimationTime / pauseAnimation） ---- */
    try {
      if (MCSKIN.renderer.Renderer && MCSKIN.renderer.Renderer.prototype.setAnimationTime) {
        var fz = Object.create(MCSKIN.renderer.Renderer.prototype);
        fz._animTime = 0; fz._animPaused = false; fz.animation = 'walk';
        fz._render = function () {}; fz._ensureLoop = function () {}; fz._stopLoopIfIdle = function () {};
        fz.setAnimationTime(1.25);
        if (Math.abs(fz.getAnimationTime() - 1.25) < 1e-9) ok('setAnimationTime/getAnimationTime：时间可直接设定（1.25s）');
        else bad('setAnimationTime 未生效', String(fz.getAnimationTime()));
        fz.pauseAnimation(true);
        if (fz._animPaused === true && fz.isAnimationPaused() === true) ok('pauseAnimation(true)：姿态冻结（_animPaused=true）');
        else bad('pauseAnimation 未冻结', '_animPaused=' + fz._animPaused);
        if (fz._needsLoop && fz._needsLoop() === false) ok('冻结时不需要帧循环（_needsLoop=false，截图稳定）');
        else bad('冻结后 _needsLoop 仍为 true');
        fz.setAnimationTime(0.5);
        if (Math.abs(fz.getAnimationTime() - 0.5) < 1e-9) ok('冻结状态下仍可跳转到指定姿态时间（0.5s）');
        else bad('冻结时 setAnimationTime 失效', String(fz.getAnimationTime()));
        fz.pauseAnimation(false);
        if (fz._animPaused === false) ok('pauseAnimation(false) 恢复播放');
        else bad('pauseAnimation(false) 未恢复');
        // 不同时间点姿态确实不同（保证多姿态截图有区分度）
        var pa = animPose('walk', 0.0), pb = animPose('walk', 0.25);
        if (JSON.stringify(pa) !== JSON.stringify(pb)) ok('walk 姿态随时间变化（0.00s 与 0.25s 不同）');
        else bad('walk 姿态不随时间变化');
      } else {
        bad('MCSKIN.renderer.Renderer 未导出（姿态冻结自测无法执行）');
      }
    } catch (e) { bad('姿态冻结 API 自测抛异常', e && e.message); }

    /* ---- 9.5 无 WebGL 时 create() 不抛异常且给出中文错误 ---- */
    try {
      var fakeCanvas = {
        width: 64, height: 64, clientWidth: 64, clientHeight: 64, style: {},
        getContext: function () { return null; },
        addEventListener: function () {},
        toDataURL: function () { return 'data:image/png;base64,'; }
      };
      var inst = MCSKIN.renderer.create(fakeCanvas, {});
      var apiNames = ['setSkin', 'setRotation', 'getRotation', 'setZoom', 'getZoom', 'setAutoRotate',
        'setAnimation', 'setShowLayer', 'setShowBase', 'setShowGround', 'setPartVisible',
        'setHighlight', 'setLighting', 'resize', 'render', 'screenshot', 'dispose'];
      var missing = [];
      for (var n = 0; n < apiNames.length; n++) if (typeof inst[apiNames[n]] !== 'function') missing.push(apiNames[n]);
      if (missing.length) bad('create 实例缺少 API 方法', missing.join(','));
      else ok('create 实例包含 CONTRACT 第 6 节全部 17 个方法');

      if (inst.ok === false && inst.error && inst.error.length > 0) ok('无 WebGL 时：ok=false 且 error 为可读中文说明（不白屏）');
      else bad('无 WebGL 时未记录错误说明', String(inst.error));

      var threw = null;
      try {
        inst.render(); inst.resize(); inst.setRotation(30, 20); inst.setZoom(1.5);
        inst.setAnimation('walk'); inst.setAutoRotate(true); inst.setShowLayer(true);
        inst.setShowBase(true); inst.setShowGround(true); inst.setPartVisible('head', false);
        inst.setHighlight('head'); inst.setLighting(false); inst.dispose();
      } catch (e2) { threw = e2; }
      if (!threw) ok('无 WebGL 时：render/resize/各 setter 均不抛异常');
      else bad('无 WebGL 时某个方法抛异常', threw && threw.message);

      var shot = '';
      try { shot = inst.screenshot(); } catch (e3) { shot = null; }
      if (typeof shot === 'string') ok('screenshot() 在无 WebGL 时返回字符串（不抛异常）');
      else bad('screenshot() 抛异常');
    } catch (e) { bad('无 WebGL 降级路径抛异常', e && e.message); }

    /* ---- 9.6 依赖 MCSKIN.rules 的几何 / UV 自测 ---- */
    var rules = MCSKIN.rules;
    if (!rules || !rules.BOXES || !rules.BOXES.length) {
      ok('依赖缺失：MCSKIN.rules 未加载，几何/UV 相关自测跳过（不算失败；renderer 已按契约从 MCSKIN.rules 读取）');
      MCSKIN.tests = MCSKIN.tests || {};
      MCSKIN.tests.renderer = { pass: pass, fail: fail };
      return MCSKIN.tests.renderer;
    }

    try {
      var boxes = rules.BOXES;
      var boxCount = boxes.length;
      var full = buildVertices(rules, {});
      var expectPerBox = 36;   // 6 面 × 6 顶点
      if (full.totalCount === boxCount * expectPerBox) {
        ok('展平顶点数 = 盒数 ' + boxCount + ' × 6 面 × 6 顶点 = ' + full.totalCount);
      } else {
        bad('展平顶点数不符', '得到 ' + full.totalCount + '，期望 ' + (boxCount * expectPerBox));
      }

      var baseBoxes = 0, outerBoxes = 0;
      for (var bi = 0; bi < boxCount; bi++) { if (boxes[bi].layer === 'outer') outerBoxes++; else baseBoxes++; }
      if (full.baseCount === baseBoxes * expectPerBox && full.outerCount === outerBoxes * expectPerBox) {
        ok('基础层/外层分别展平：base=' + full.baseCount + '（' + baseBoxes + ' 盒）、outer=' + full.outerCount + '（' + outerBoxes + ' 盒）');
      } else {
        bad('层分组顶点数不符', 'base=' + full.baseCount + '/' + (baseBoxes * expectPerBox) + ' outer=' + full.outerCount + '/' + (outerBoxes * expectPerBox));
      }

      /* UV 全部落在 0..1 */
      var uvBad = [], uvCount = 0;
      var allArrays = [full.base, full.outer];
      for (var ai2 = 0; ai2 < allArrays.length; ai2++) {
        var arr = allArrays[ai2];
        for (var vi = 0; vi < arr.length; vi += STRIDE_FLOATS) {
          uvCount++;
          var u = arr[vi + 3], vv = arr[vi + 4];
          if (!(u >= 0 && u <= 1 && vv >= 0 && vv <= 1)) uvBad.push('#' + (vi / STRIDE_FLOATS) + '(' + u + ',' + vv + ')');
        }
      }
      if (!uvBad.length) ok('全部 ' + uvCount + ' 个顶点的 UV 都在 0..1 内');
      else bad('存在越界 UV（共 ' + uvBad.length + ' 个）', uvBad.slice(0, 5).join(' '));

      /* 外层相对基础层每边膨胀 0.25（用展平后的包围盒验证，直接测 buildVertices 输出） */
      function bboxOfRange(arr, offset, count) {
        var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (var i2 = offset * STRIDE_FLOATS; i2 < (offset + count) * STRIDE_FLOATS; i2 += STRIDE_FLOATS) {
          for (var k2 = 0; k2 < 3; k2++) {
            var val = arr[i2 + k2];
            if (val < mn[k2]) mn[k2] = val;
            if (val > mx[k2]) mx[k2] = val;
          }
        }
        return { min: mn, max: mx };
      }
      function partOf(name) {
        for (var i3 = 0; i3 < full.parts.length; i3++) if (full.parts[i3].name === name) return full.parts[i3];
        return null;
      }
      var expandBad = [], expandChecked = 0;
      var expandGroups = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
      for (var eg = 0; eg < expandGroups.length; eg++) {
        var pt = partOf(expandGroups[eg]);
        if (!pt || !pt.baseCount || !pt.outerCount) { expandBad.push(expandGroups[eg] + ':缺层'); continue; }
        var bbB = bboxOfRange(full.base, pt.baseOffset, pt.baseCount);
        var bbO = bboxOfRange(full.outer, pt.outerOffset, pt.outerCount);
        for (var ax = 0; ax < 3; ax++) {
          if (!approx(bbO.min[ax], bbB.min[ax] - 0.25, 1e-4)) expandBad.push(expandGroups[eg] + '.min[' + ax + ']=' + bbO.min[ax] + '≠' + (bbB.min[ax] - 0.25));
          if (!approx(bbO.max[ax], bbB.max[ax] + 0.25, 1e-4)) expandBad.push(expandGroups[eg] + '.max[' + ax + ']=' + bbO.max[ax] + '≠' + (bbB.max[ax] + 0.25));
        }
        expandChecked++;
      }
      if (!expandBad.length && expandChecked === 6) ok('6 组外层盒相对基础盒每边膨胀 0.25（顶点包围盒实测 ' + expandChecked + ' 组）');
      else bad('外层膨胀量不符', expandBad.slice(0, 6).join('；'));

      /* setPartVisible('head', false) */
      var noHead = buildVertices(rules, { partVisible: { head: false } });
      var headOut = noHead.byPart.head ? noHead.byPart.head.total : 0;
      if (headOut === 0 && noHead.totalCount < full.totalCount) {
        ok("setPartVisible('head', false)：head 相关顶点数 = 0，总数 " + full.totalCount + ' → ' + noHead.totalCount);
      } else {
        bad("setPartVisible('head', false) 未生效", 'head=' + headOut + ' total=' + noHead.totalCount);
      }

      var noOne = buildVertices(rules, { partVisible: { rightArm: false } });
      var armTotal = full.byPart.rightArm ? full.byPart.rightArm.total : 0;
      var armZero = !noOne.byPart.rightArm || noOne.byPart.rightArm.total === 0;
      if (armZero && noOne.totalCount === full.totalCount - armTotal && armTotal > 0) {
        ok("setPartVisible('rightArm', false)：右臂相关 " + armTotal + " 个顶点被移除（含外层袖）");
      } else {
        bad("setPartVisible('rightArm', false) 结果不符", 'rightArm=' + (noOne.byPart.rightArm && noOne.byPart.rightArm.total) + ' total=' + noOne.totalCount + '/' + (full.totalCount - armTotal));
      }

      /* showLayer / showBase */
      var noLayer = buildVertices(rules, { showLayer: false });
      var noBase = buildVertices(rules, { showBase: false });
      if (noLayer.outerCount === 0 && noLayer.baseCount === full.baseCount &&
          noBase.baseCount === 0 && noBase.outerCount === full.outerCount) {
        ok('setShowLayer/setShowBase：关闭外层只剩基础层、关闭基础层只剩外层');
      } else {
        bad('showLayer/showBase 开关不生效', 'noLayer=' + noLayer.baseCount + '/' + noLayer.outerCount + ' noBase=' + noBase.baseCount + '/' + noBase.outerCount);
      }

      /* 明暗：顶面最亮、底面最暗；lighting=false 时等于 FACE_SHADE */
      var sTop = shadeFor(rules, 'top', [0, 1, 0], true);
      var sBottom = shadeFor(rules, 'bottom', [0, -1, 0], true);
      var sFront = shadeFor(rules, 'front', [0, 0, 1], true);
      var sPlain = shadeFor(rules, 'top', [0, 1, 0], false);
      if (sTop > sFront && sFront > sBottom && sTop > 0.5 && sBottom > 0) {
        ok('方向光烘焙：顶面 ' + sTop.toFixed(3) + ' > 正面 ' + sFront.toFixed(3) + ' > 底面 ' + sBottom.toFixed(3) + '（顶亮底暗）');
      } else {
        bad('方向光明暗关系不对', 'top=' + sTop + ' front=' + sFront + ' bottom=' + sBottom);
      }
      if (approx(sPlain, shadeForFace(rules, 'top'), 1e-6) && Math.abs(sPlain - (rules.FACE_SHADE ? rules.FACE_SHADE.top : 1)) < 1e-6) {
        ok('setLighting(false)：shade 恒等于 rules.FACE_SHADE（top=' + sPlain + '）');
      } else {
        bad('setLighting(false) 时 shade 不等于 FACE_SHADE', String(sPlain));
      }

      /* 亮度下限：FACE_SHADE 与光照不能两次相乘把颜色压得"非常淡/发灰"（用户反馈）。
       * 正面 ≥0.8，背光面（左/右/背）≥0.5。 */
      var sBackL = shadeFor(rules, 'back', [0, 0, -1], true);
      var sRightL = shadeFor(rules, 'right', [-1, 0, 0], true);
      var sLeftL = shadeFor(rules, 'left', [1, 0, 0], true);
      var minBacklit = Math.min(sBackL, sRightL, sLeftL);
      if (sFront >= 0.8 && minBacklit >= 0.5) {
        ok('亮度下限：正面 ' + sFront.toFixed(3) + ' ≥0.8，背光面最小 ' + minBacklit.toFixed(3) + ' ≥0.5（颜色不会变淡）');
      } else {
        bad('亮度下限不达标（贴图颜色会显得很淡）', 'front=' + sFront + ' back=' + sBackL + ' right=' + sRightL + ' left=' + sLeftL);
      }

      /* 高亮 */
      var hl = buildVertices(rules, { highlight: 'head' });
      var hlCount = 0;
      for (var hi = 0; hi < hl.base.length; hi += STRIDE_FLOATS) if (hl.base[hi + 6] === 1) hlCount++;
      for (var hi2 = 0; hi2 < hl.outer.length; hi2 += STRIDE_FLOATS) if (hl.outer[hi2 + 6] === 1) hlCount++;
      if (hlCount > 0) ok("setHighlight('head')：共 " + hlCount + ' 个顶点被标记高亮');
      else bad("setHighlight('head') 没有标记任何顶点");

      /* 外层标记位 */
      var outerFlagBad = 0;
      for (var oi = 0; oi < full.base.length; oi += STRIDE_FLOATS) if (full.base[oi + 7] !== 0) outerFlagBad++;
      for (var oi2 = 0; oi2 < full.outer.length; oi2 += STRIDE_FLOATS) if (full.outer[oi2 + 7] !== 1) outerFlagBad++;
      if (!outerFlagBad) ok('外层标记位正确：base 缓冲全 0、outer 缓冲全 1（供先基础层后外层绘制）');
      else bad('外层标记位错误', outerFlagBad + ' 个顶点');

      /* ---- 多部位同时可见（Lead 验收关注点）---- */
      var multi = debugVertices(full);
      var partList = multi.parts;
      var rangeBad = [], expectOff = 0, multiOk = true;
      for (var pi2 = 0; pi2 < partList.length; pi2++) {
        var pp = partList[pi2];
        if (pp.baseOffset !== expectOff) { rangeBad.push(pp.name + '.offset=' + pp.baseOffset + '≠' + expectOff); multiOk = false; }
        if (pp.baseCount !== 36) { rangeBad.push(pp.name + '.count=' + pp.baseCount + '≠36'); multiOk = false; }
        if (!pp.baseBBox) { rangeBad.push(pp.name + '.bbox=空'); multiOk = false; }
        expectOff += pp.baseCount;
      }
      if (multiOk && expectOff === multi.baseCount && multi.baseCount === 216) {
        ok('多部位同时可见：6 个部位各 36 顶点、offset 连续（0,36,72…180）、范围无缝覆盖 216 个顶点的缓冲');
      } else {
        bad('多部位同时可见时顶点分派异常', rangeBad.join('；') + ' | 合计=' + expectOff + '/' + multi.baseCount);
      }

      /* 每个部位的顶点包围盒必须严格等于该部位基础盒的 min..min+size（多盒时取并集） */
      var perPartBad = [], perPartChecked = 0;
      for (var pi3 = 0; pi3 < partList.length; pi3++) {
        var p3 = partList[pi3];
        if (!p3.baseBBox) continue;
        var expMin = [Infinity, Infinity, Infinity], expMax = [-Infinity, -Infinity, -Infinity];
        for (var bi3 = 0; bi3 < p3.boxes.length; bi3++) {
          var bx = p3.boxes[bi3];
          if (bx.outer) continue;
          var def = null;
          for (var fi3 = 0; fi3 < boxes.length; fi3++) if (boxes[fi3].id === bx.id) def = boxes[fi3];
          if (!def || !def.min || !def.size) continue;
          for (var k3 = 0; k3 < 3; k3++) {
            if (def.min[k3] < expMin[k3]) expMin[k3] = def.min[k3];
            if (def.min[k3] + def.size[k3] > expMax[k3]) expMax[k3] = def.min[k3] + def.size[k3];
          }
        }
        if (!isFinite(expMin[0])) continue;
        perPartChecked++;
        for (var k4 = 0; k4 < 3; k4++) {
          if (!approx(p3.baseBBox.min[k4], expMin[k4], 1e-4) || !approx(p3.baseBBox.max[k4], expMax[k4], 1e-4)) {
            perPartBad.push(p3.name + '[' + k4 + '] ' + JSON.stringify(p3.baseBBox) + '≠' + JSON.stringify([expMin, expMax]));
          }
        }
      }
      if (!perPartBad.length && perPartChecked === 6) {
        ok('多部位同时可见：6 个部位的顶点包围盒都精确等于各自基础盒的 min..min+size（' + perPartChecked + ' 组）');
      } else {
        bad('多部位同时可见时部位包围盒错位', perPartBad.slice(0, 3).join('；'));
      }

      /* 正视投影排布（纯逻辑，无需 WebGL）：yaw=0 是角色正面（+Z） */
      var proj = projectParts(rules, { yaw: 0, pitch: 0, zoom: 1, viewW: 550, viewH: 665, showLayer: false });
      var q = proj.parts;
      var orderBad = [];
      if (!q.rightArm || !q.body || !q.leftArm || !q.head || !q.rightLeg) orderBad.push('缺部位');
      else {
        if (!(q.rightArm.x < q.body.x && q.body.x < q.leftArm.x)) {
          orderBad.push('左右臂未分列躯干两侧: rightArm.x=' + q.rightArm.x.toFixed(1) + ' body.x=' + q.body.x.toFixed(1) + ' leftArm.x=' + q.leftArm.x.toFixed(1));
        }
        if (!(q.head.y < q.body.y)) orderBad.push('头不在躯干上方: head.y=' + q.head.y.toFixed(1) + ' body.y=' + q.body.y.toFixed(1));
        if (!(q.rightLeg.y > q.body.y)) orderBad.push('腿不在躯干下方: leg.y=' + q.rightLeg.y.toFixed(1) + ' body.y=' + q.body.y.toFixed(1));
        if (!(q.rightLeg.x < q.leftLeg.x)) orderBad.push('右腿未在左腿左侧');
        var names = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
        for (var ni = 0; ni < names.length; ni++) {
          if (!q[names[ni]] || !q[names[ni]].inViewport) orderBad.push(names[ni] + ' 不在视口内');
        }
      }
      if (!orderBad.length) {
        ok('正视 yaw=0 投影：rightArm(' + q.rightArm.x.toFixed(0) + ') < body(' + q.body.x.toFixed(0) + ') < leftArm(' + q.leftArm.x.toFixed(0) +
           ')，head 在上(y=' + q.head.y.toFixed(0) + ')、双腿在下(y=' + q.rightLeg.y.toFixed(0) + ')，6 部位全在视口内');
      } else {
        bad('正视 yaw=0 投影排布异常', orderBad.join('；'));
      }

      /* 相机角约定（供验收探针定位）：yaw=0→+Z 正面、180→-Z 背面、-90→-X 侧面 */
      var cam0 = viewProjection({ yaw: 0 }), cam180 = viewProjection({ yaw: 180 }), camN90 = viewProjection({ yaw: -90 });
      var camOk = cam0.eye[2] > 0 && Math.abs(cam0.eye[0]) < 1e-6 &&
                  cam180.eye[2] < 0 && Math.abs(cam180.eye[0]) < 1e-6 &&
                  camN90.eye[0] < 0 && Math.abs(camN90.eye[2]) < 1e-6;
      if (camOk) {
        ok('相机约定：yaw=0 在 +Z（角色正面，rightArm 在 -X ⟹ 角色朝 +Z）、yaw=180 在 -Z（背面）、yaw=-90 在 -X（侧面，右臂最靠前会遮住躯干）');
      } else {
        bad('相机角约定与文档不一致', JSON.stringify([cam0.eye, cam180.eye, camN90.eye]));
      }

      var windBad = 0, windChecked = 0;
      for (var wbi = 0; wbi < boxCount; wbi++) {
        var wb = boxes[wbi];
        var wx0 = wb.min[0], wy0 = wb.min[1], wz0 = wb.min[2];
        var wx1 = wx0 + wb.size[0], wy1 = wy0 + wb.size[1], wz1 = wz0 + wb.size[2];
        var center = [(wx0 + wx1) / 2, (wy0 + wy1) / 2, (wz0 + wz1) / 2];
        var order = faceOrderOf(rules);
        for (var wf = 0; wf < order.length; wf++) {
          var quad = geometryFor(rules, wb, order[wf]);
          if (!quad) continue;
          var nn = cross3(quad[0], quad[1], quad[2]);
          var nl2 = Math.sqrt(nn[0] * nn[0] + nn[1] * nn[1] + nn[2] * nn[2]);
          if (nl2 < 1e-9) continue;
          windChecked++;
          var fcx = 0, fcy = 0, fcz = 0;
          for (var qq = 0; qq < 4; qq++) { fcx += quad[qq][0]; fcy += quad[qq][1]; fcz += quad[qq][2]; }
          fcx /= 4; fcy /= 4; fcz /= 4;
          var outv = [fcx - center[0], fcy - center[1], fcz - center[2]];
          var ol2 = Math.sqrt(outv[0] * outv[0] + outv[1] * outv[1] + outv[2] * outv[2]) || 1;
          var dot2 = (nn[0] * outv[0] + nn[1] * outv[1] + nn[2] * outv[2]) / ol2;
          if (Math.abs(dot2) < 0.9) windBad++;
        }
      }
      if (!windBad) {
        ok('绕序检测：' + windChecked + ' 个面都能算出朝外的真实法线（renderer 会按需翻转三角化顺序，CULL_FACE 安全）');
      } else {
        bad('有面无法确定朝外法线', windBad + ' 个面（共 ' + windChecked + '）');
      }
    } catch (e) {
      bad('几何/UV 自测抛异常', e && e.message);
    }

    MCSKIN.tests = MCSKIN.tests || {};
    MCSKIN.tests.renderer = { pass: pass, fail: fail };
    return MCSKIN.tests.renderer;
  }

  MCSKIN.renderer._selfTest = _selfTest;

  /* 加载即自测（契约 2 节：定义 _selfTest 请执行并写入 MCSKIN.tests） */
  try { _selfTest(); } catch (e) { /* 自测本身不允许阻断加载 */ }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
