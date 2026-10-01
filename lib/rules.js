/* ============================================================================
 * js/rules.js — Minecraft 皮肤格式 + UV 映射「唯一真相」(MCSKIN.rules)
 * ----------------------------------------------------------------------------
 * 传统 <script> 标签加载（禁止 import/export），只向 MCSKIN.* 写数据。
 *   · 贴图坐标：左上角 (0,0)，x 向右，y 向下，单位为像素（64×64 坐标系）。
 *   · 颜色：[r,g,b,a]，每项 0-255。
 *   · 模型空间：1 单位 = 1 皮肤像素，y 轴向上，脚底 y=0，原点在身体中心。
 *     头部 y=24..32，躯干 y=12..24，手臂/腿 y=0..12，x∈[-8,8]，z∈[-4,4]。
 *
 * 已对齐 CONTRACT v1.1：贴图布局与 v1.1 §3.3 完全一致（leftArm 32,48 / leftLeg 16,48 /
 * leftSleeve 48,48 / leftPants 0,48），§3.6 的逐面镜像表也照做。仍有 3 处按证据修正：
 *
 *  1) leftPants 是**独立**贴图区 (0,48)-(16,64)，不与 leftLeg(16,48) 共用。
 *     证据 a：v1.1 自己引用的 `github.com/mineatar-io/skin-render` parts.go 里
 *       `LeftLeg = (16,52)-(32,64)`、`LeftLegOverlay = (0,52)-(16,64)`，两个独立变量。
 *     证据 b：苦力怕娘.png 实测 leftPants(0,48)=40 个不透明像素 == rightPants(0,32)=40
 *       （外层对称），而 leftLeg(16,48)=224 == rightLeg(0,16)=224（基础层满贴图）。
 *     若按「共用」实现，左裤外层会渲染成整条左腿贴图（左腿凭空变粗），
 *     同时 (0,48)-(16,64) 这块真实存在的裤子贴图会变成无人认领的死区。
 *  2) §3.6 第 2 步「按 2 倍放大整张」不成立：64×32 与 64×64 的像素网格是 1:1 的。
 *     证据：HIM.png 的头部贴图正好落在 (0,0)-(32,16) 的 384 个现代 UV 像素上
 *       （384/512 不透明，另两角 8×8 为空），右腿 224/256、躯干 352/384、右臂 224/256
 *       —— 与各自现代 UV 面积完全相等；若放大 2 倍，头会跑到 (0,0)-(64,32)、躯干跑到
 *       (32,32)-(80,64)（越界）。Lead 引用的 minecraft-skin-converter 里
 *       `data[i] * abstractScale` 的 abstractScale 是「每抽象单位 4 像素」（64/16=4），
 *       不是放大倍数；它的 `ctx.scale(-1,1)` 只做**逐面**水平镜像。
 *  3) §3.4 的 front/back/top 三行与展开图的相邻关系矛盾（见下方 quadFor 注释的证明）。
 *     geometry 用「相邻面共边一致」的版本；CONTRACT v1.1 的字面值保留在
 *     BOXES[].geometryContract 里，仅作对照/审计，渲染请用 geometry。
 *
 * 绕序：贴图 v 向下而模型 y 向上，所以「贴图左上→右上→右下→左下」在外部视角是
 * 顺时针：QUAD_WINDING = 'cw'。renderer 请用 gl.frontFace(gl.CW)（或关闭 CULL_FACE）；
 * 想要「逆时针 + CULL_FACE 默认设置」就用 faceQuadCCW() / BOXES[].geometryCCW
 * （顶点集相同、顺序相反），UV 请按 faces[f].uv 逐顶点取（与 geometry 下标对齐）。
 * ========================================================================== */
(function (global) {
  'use strict';

  var MCSKIN = global.MCSKIN = global.MCSKIN || {};

  var VERSION = '1.0';
  var SIZE_MODERN = { w: 64, h: 64 };
  var SIZE_LEGACY = { w: 64, h: 32 };
  var TEX = 64;                      // 贴图宽高（像素）
  var QUAD_WINDING = 'cw';           // 见头部说明 3)：外部视角为顺时针

  var FACE_ORDER = ['right', 'front', 'left', 'back', 'top', 'bottom'];
  var FACE_SHADE = { top: 1.0, front: 0.95, right: 0.80, left: 0.80, back: 0.72, bottom: 0.55 };
  var FACE_LABEL = { right: '右面', front: '正面', left: '左面', back: '背面', top: '顶面', bottom: '底面' };

  var PART_LABEL = {
    head: '头', body: '躯干', rightArm: '右臂', leftArm: '左臂', rightLeg: '右腿', leftLeg: '左腿',
    hat: '帽子(外层)', jacket: '外套(外层)', rightSleeve: '右袖(外层)', leftSleeve: '左袖(外层)',
    rightPants: '右裤(外层)', leftPants: '左裤(外层)'
  };
  var SHORT_LABEL = {
    head: '头', hat: '帽', body: '躯干', jacket: '外套', rightArm: '右臂', rightSleeve: '右袖',
    leftArm: '左臂', leftSleeve: '左袖', rightLeg: '右腿', rightPants: '右裤', leftLeg: '左腿', leftPants: '左裤'
  };
  var PART_KIND = {
    head: 'head', hat: 'head', body: 'body', jacket: 'body',
    rightArm: 'arm', rightSleeve: 'arm', leftArm: 'arm', leftSleeve: 'arm',
    rightLeg: 'leg', rightPants: 'leg', leftLeg: 'leg', leftPants: 'leg'
  };

  /* ---------------------------------------------------------------- 几何 ---- */

  /* §3.4：贴图左上角(u0,v0)、右上(u1,v0)、右下(u1,v1)、左下(u0,v1) 对应的 3D 顶点。
   * 记 x0=min[0], y0=min[1], z0=min[2], x1=x0+w, y1=y0+h, z1=z0+d；
   * 角色朝 +Z（正面 = z1 面），右手在 -X 侧（与 §3.2 的 rightArm 在 x 负侧一致）。
   *
   * 为什么 front/back 的 u 与 top 的 v 与 CONTRACT v1.1 字面值相反（严格证明）：
   *   皮肤展开图里相邻贴图区共用一条贴图线，它必须映射到两个面共用的那条 3D 棱。
   *   · head/body/arm/leg 的横排顺序是 [right][front][left][back]，于是贴图列
   *     （head 的 x=8，body 的 x=20）既是 right 区的右边缘、也是 front 区的左边缘，
   *     它必须同时等于 right 面(-X) 与 front 面的公共棱；v1.1 的 right 行给出该棱
   *     为 (x0, ·, z1)，而 v1.1 的 front 行却把 front 区左边缘放在 (x1, ·, z1)
   *     —— x0≠x1，同一张贴图列要同时表示「右前棱」和「左前棱」，展开图无法闭合。
   *     把 front 行按 u 反向（u0↔x0、u1↔x1）后，x=8 ↔ (x0,z1) 与 right 行一致、
   *     x=16 ↔ (x1,z1) 与 left 行的 u0 一致，闭合。back 行同理（与 left/right 的
   *     后棱一致）。
   *   · top 区正好压在 front 区上方（body：top y16..20、front y20..32），中间的贴图线
   *     y=20 既是 top 区的下边缘、也是 front 区的上边缘，必须映射到 top 面与 front 面
   *     的公共棱 (·, y1, z1)；v1.1 的 top 行把 v1 放在 z0，与 front 行的 v0=z1 冲突；
   *     v 反向（v0↔z0、v1↔z1）后闭合。
   *   bottom 区与任何区都不共边（官方排布里它在 top 区右边，是人为打包），所以它只
   *   需要是一个「刚体旋转」（不能是镜像）；v1.1 的 bottom 行是合法旋转，已采纳。 */
  function quadFor(min, size, face) {
    var x0 = min[0], y0 = min[1], z0 = min[2];
    var x1 = x0 + size[0], y1 = y0 + size[1], z1 = z0 + size[2];
    switch (face) {
      case 'right':  return [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]];
      case 'front':  return [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]];
      case 'left':   return [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]];
      case 'back':   return [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]];
      case 'top':    return [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      case 'bottom': return [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]];
    }
    return null;
  }

  /* CONTRACT v1.1 §3.4 的字面顶点表（仅用于对照/审计，渲染请用 quadFor 的结果） */
  function quadForContract(min, size, face) {
    var x0 = min[0], y0 = min[1], z0 = min[2];
    var x1 = x0 + size[0], y1 = y0 + size[1], z1 = z0 + size[2];
    switch (face) {
      case 'right':  return [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]];
      case 'front':  return [[x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [x1, y0, z1]];
      case 'left':   return [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]];
      case 'back':   return [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]];
      case 'top':    return [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]];
      case 'bottom': return [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]];
    }
    return null;
  }

  /* 官方 16×16 贴图块内的 6 面像素 UV：给定块的左上角 (bx,by) 与像素尺寸 (w,h,d)
   * 展开长度：右(d) + 前(w) + 左(d) + 后(w) = 2(w+d) 宽，(d + h) 高 */
  function uvFromBlock(bx, by, w, h, d) {
    var v = by + d, u0 = bx + d;
    return {
      top:    [u0,          by, u0 + w,      by + d],
      bottom: [u0 + w,      by, u0 + w + w,  by + d],
      right:  [bx,          v,  bx + d,      v + h],
      front:  [u0,          v,  u0 + w,      v + h],
      left:   [bx + d + w,  v,  bx + d + w + d, v + h],
      back:   [bx + d + w + d, v, bx + d + w + d + w, v + h]
    };
  }

  /* 盒定义：block = 官方 16×16 贴图块左上角；uv = 贴图像素尺寸(w,h,d)；
   * min/size = 模型空间盒（外层已按 §3.2 向外膨胀 0.25）。 */
  var BOX_DEFS = [
    { id: 'head',        part: 'head',        layer: 'base',  block: [0, 0],   uv: [8, 8, 8],  min: [-4, 24, -4],          size: [8, 8, 8] },
    { id: 'hat',         part: 'hat',         layer: 'outer', block: [32, 0],  uv: [8, 8, 8],  min: [-4.25, 23.75, -4.25], size: [8.5, 8.5, 8.5] },
    { id: 'rightLeg',    part: 'rightLeg',    layer: 'base',  block: [0, 16],  uv: [4, 12, 4], min: [-4, 0, -2],           size: [4, 12, 4] },
    { id: 'body',        part: 'body',        layer: 'base',  block: [16, 16], uv: [8, 12, 4], min: [-4, 12, -2],          size: [8, 12, 4] },
    { id: 'rightArm',    part: 'rightArm',    layer: 'base',  block: [40, 16], uv: [4, 12, 4], min: [-8, 12, -2],          size: [4, 12, 4] },
    { id: 'rightPants',  part: 'rightPants',  layer: 'outer', block: [0, 32],  uv: [4, 12, 4], min: [-4.25, -0.25, -2.25], size: [4.5, 12.5, 4.5] },
    { id: 'jacket',      part: 'jacket',      layer: 'outer', block: [16, 32], uv: [8, 12, 4], min: [-4.25, 11.75, -2.25], size: [8.5, 12.5, 4.5] },
    { id: 'rightSleeve', part: 'rightSleeve', layer: 'outer', block: [40, 32], uv: [4, 12, 4], min: [-8.25, 11.75, -2.25], size: [4.5, 12.5, 4.5] },
    { id: 'leftPants',   part: 'leftPants',   layer: 'outer', block: [0, 48],  uv: [4, 12, 4], min: [-0.25, -0.25, -2.25], size: [4.5, 12.5, 4.5] },
    { id: 'leftLeg',     part: 'leftLeg',     layer: 'base',  block: [16, 48], uv: [4, 12, 4], min: [0, 0, -2],            size: [4, 12, 4] },
    { id: 'leftArm',     part: 'leftArm',     layer: 'base',  block: [32, 48], uv: [4, 12, 4], min: [4, 12, -2],           size: [4, 12, 4] },
    { id: 'leftSleeve',  part: 'leftSleeve',  layer: 'outer', block: [48, 48], uv: [4, 12, 4], min: [3.75, 11.75, -2.25],  size: [4.5, 12.5, 4.5] }
  ];

  var BOXES = [];
  var BY_ID = {};
  BOX_DEFS.forEach(function (def) {
    var px = uvFromBlock(def.block[0], def.block[1], def.uv[0], def.uv[1], def.uv[2]);
    var faces = {};
    var geometry = {};
    var geometryCCW = {};
    var geometryContract = {};
    FACE_ORDER.forEach(function (f) {
      var r = px[f];
      var uv4 = [
        [r[0] / TEX, r[1] / TEX],
        [r[2] / TEX, r[1] / TEX],
        [r[2] / TEX, r[3] / TEX],
        [r[0] / TEX, r[3] / TEX]
      ];
      faces[f] = {
        px: r,
        // 与 geometry[f] / geometryCCW[f] 逐顶点对齐的归一化 UV（u = px/64，v = py/64，v=0 在贴图顶部）
        uv: uv4,
        uv4: uv4,
        uvCCW: [uv4[3], uv4[2], uv4[1], uv4[0]],
        label: FACE_LABEL[f]
      };
      geometry[f] = quadFor(def.min, def.size, f);
      geometryContract[f] = quadForContract(def.min, def.size, f);
      var g = geometry[f];
      // 反转绕序 → 外部视角逆时针（配 faces[f].uvCCW 使用）
      geometryCCW[f] = [g[3], g[2], g[1], g[0]];
    });
    var box = {
      id: def.id,
      part: def.part,
      label: PART_LABEL[def.id],
      layer: def.layer,
      min: def.min.slice(),
      size: def.size.slice(),
      block: def.block.slice(),
      uvSize: def.uv.slice(),
      // 该盒在贴图上占的矩形（展开后宽 2(w+d)、高 d+h）
      region: [def.block[0], def.block[1], def.block[0] + 2 * (def.uv[0] + def.uv[2]), def.block[1] + def.uv[2] + def.uv[1]],
      faces: faces,
      geometry: geometry,
      geometryCCW: geometryCCW,
      // CONTRACT v1.1 §3.4 的字面值（对照/审计用，渲染请用 geometry）
      geometryContract: geometryContract
    };
    BOXES.push(box);
    BY_ID[def.id] = box;
  });

  /* --------------------------------------------------------------- 查询 ---- */

  function box(id) { return BY_ID[id] || null; }

  function faceQuad(boxId, face) {
    var b = BY_ID[boxId];
    if (!b || !b.geometry[face]) return null;
    return b.geometry[face].map(function (p) { return [p[0], p[1], p[2]]; });
  }

  /* 与 faceQuad 同一四边形，但顶点顺序反转 → 外部视角逆时针（可直接配 CULL_FACE 默认 CCW） */
  function faceQuadCCW(boxId, face) {
    var b = BY_ID[boxId];
    if (!b || !b.geometryCCW[face]) return null;
    return b.geometryCCW[face].map(function (p) { return [p[0], p[1], p[2]]; });
  }

  function uvFromPixel(px, py) { return [px / TEX, py / TEX]; }
  function uvFromPixelCenter(px, py) { return [(px + 0.5) / TEX, (py + 0.5) / TEX]; }

  function shadeFor(face) { return FACE_SHADE[face] == null ? 1.0 : FACE_SHADE[face]; }

  /* 教学用的面名：同一个 face 在不同部位叫法不同（外侧/内侧） */
  function faceSuffix(partId, face) {
    var isRightPart = (partId === 'rightArm' || partId === 'rightSleeve' || partId === 'rightLeg' || partId === 'rightPants');
    var isLeftPart = (partId === 'leftArm' || partId === 'leftSleeve' || partId === 'leftLeg' || partId === 'leftPants');
    var isHead = (partId === 'head' || partId === 'hat');
    if (face === 'right') return isRightPart ? '外侧面' : (isLeftPart ? '内侧面' : '右侧面');
    if (face === 'left') return isRightPart ? '内侧面' : (isLeftPart ? '外侧面' : '左侧面');
    if (face === 'front') return isHead ? '正面(脸)' : '前面';
    if (face === 'back') return isHead ? '背面' : '后面';
    if (face === 'top') return isHead ? '顶面' : ((partId === 'body' || partId === 'jacket') ? '肩面' : '顶面');
    if (face === 'bottom') {
      if (isHead) return '底面(脖子)';
      if (partId === 'rightLeg' || partId === 'leftLeg' || partId === 'rightPants' || partId === 'leftPants') return '脚底面';
      if (partId === 'body' || partId === 'jacket') return '腰面';
      return '手面';
    }
    return FACE_LABEL[face];
  }

  /* 2D 编辑器用的分区表：每个盒 × 每个面 = 一个可点选/画图例的矩形 */
  var LAYOUT_REGIONS = (function () {
    var out = [];
    BOXES.forEach(function (b) {
      FACE_ORDER.forEach(function (f) {
        var r = b.faces[f].px;
        out.push({
          id: b.id + '.' + f,
          boxId: b.id,
          part: b.part,
          face: f,
          label: SHORT_LABEL[b.id] + '·' + faceSuffix(b.id, f),
          px: [r[0], r[1], r[2], r[3]],
          kind: PART_KIND[b.id],
          layer: b.layer
        });
      });
    });
    return out;
  })();

  /* ------------------------------------------------------------ regionAt ---- */

  /* 反查像素属于哪个部位/哪个面。
   * opts: { layer:'all'|'base'|'outer', format:'modern'|'legacy' }
   * 命中多个盒时（官方布局下不会发生，见说明 1）返回第一个，并在 overlaps 列出全部。
   * 判定顺序：先外层（画在上面）后基础层。 */
  /* 64×32 旧版里真实存在的贴图区（无第二层、无左半边下排） */
  var LEGACY_BOXES = { head: 1, rightLeg: 1, body: 1, rightArm: 1 };

  function regionAt(px, py, opts) {
    opts = opts || {};
    var layer = opts.layer || 'all';
    var format = opts.format || 'modern';
    var hits = [];
    var i, b, f, r;
    var pass = function (b) {
      if (layer !== 'all' && layer !== b.layer) return false;
      if (format === 'legacy' && !LEGACY_BOXES[b.id]) return false;
      return true;
    };
    // 判定顺序：先外层（画在基础层之上）后基础层
    for (i = 0; i < BOXES.length; i++) {
      b = BOXES[i];
      if (b.layer !== 'outer' || !pass(b)) continue;
      for (f = 0; f < FACE_ORDER.length; f++) {
        r = b.faces[FACE_ORDER[f]].px;
        if (px >= r[0] && px < r[2] && py >= r[1] && py < r[3]) { hits.push({ box: b, face: FACE_ORDER[f], rect: r }); break; }
      }
    }
    for (i = 0; i < BOXES.length; i++) {
      b = BOXES[i];
      if (b.layer !== 'base' || !pass(b)) continue;
      for (f = 0; f < FACE_ORDER.length; f++) {
        r = b.faces[FACE_ORDER[f]].px;
        if (px >= r[0] && px < r[2] && py >= r[1] && py < r[3]) { hits.push({ box: b, face: FACE_ORDER[f], rect: r }); break; }
      }
    }
    if (!hits.length) return null;
    var h = hits[0];
    var overlaps = hits.map(function (x) { return x.box.id; });
    return {
      part: h.box.part,
      label: PART_LABEL[h.box.id] + '·' + faceSuffix(h.box.id, h.face),
      layer: h.box.layer,
      face: h.face,
      boxId: h.box.id,
      rect: [h.rect[0], h.rect[1], h.rect[2], h.rect[3]],
      // 像素在该面贴图矩形内的局部比例（0..1），便于调试/取色
      u: (px - h.rect[0]) / (h.rect[2] - h.rect[0]),
      v: (py - h.rect[1]) / (h.rect[3] - h.rect[1]),
      overlaps: overlaps
    };
  }

  /* ---------------------------------------------------------- 像素小工具 ---- */

  function blankSkin(w, h) {
    w = w || SIZE_MODERN.w;
    h = h || SIZE_MODERN.h;
    return new Uint8ClampedArray(w * h * 4);
  }

  function putPx(d, w, x, y, c) {
    if (x < 0 || y < 0 || x >= w) return;
    var i = (y * w + x) * 4;
    if (i + 3 >= d.length) return;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c.length > 3 ? c[3] : 255;
  }
  function putRect(d, w, x0, y0, x1, y1, c) {   // 内部用：半开区间
    for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) putPx(d, w, x, y, c);
  }

  /* 可辨识的默认皮肤（接近官方 Steve）：肤色头 + 棕发 + 青蓝上衣 + 深蓝裤 + 灰鞋 */
  function defaultSkin() {
    var W = SIZE_MODERN.w, H = SIZE_MODERN.h, d = blankSkin(W, H);
    var SKIN = [240, 196, 158, 255], SKIN_D = [214, 168, 128, 255],
        HAIR = [122, 80, 46, 255], EYE = [92, 62, 44, 255], MOUTH = [196, 124, 108, 255],
        SHIRT = [86, 176, 200, 255], SHIRT_D = [64, 142, 168, 255],
        PANTS = [78, 100, 186, 255], SHOE = [132, 132, 138, 255];
    var R = function (id, face) { return BY_ID[id].faces[face].px; };

    // 头：整头先铺头发
    FACE_ORDER.forEach(function (f) { var r = R('head', f); putRect(d, W, r[0], r[1], r[2], r[3], HAIR); });
    // 两侧面：下半张脸肤色（留出鬓角）
    ['right', 'left'].forEach(function (f) { var r = R('head', f); putRect(d, W, r[0], r[1] + 3, r[2], r[3], SKIN); });
    // 正面：3 行头发 + 肤色 + 眼睛 + 嘴
    var fr = R('head', 'front');
    putRect(d, W, fr[0], fr[1] + 3, fr[2], fr[3], SKIN);
    putPx(d, W, fr[0] + 1, fr[1] + 4, EYE); putPx(d, W, fr[0] + 2, fr[1] + 4, EYE);
    putPx(d, W, fr[0] + 5, fr[1] + 4, EYE); putPx(d, W, fr[0] + 6, fr[1] + 4, EYE);
    putRect(d, W, fr[0] + 3, fr[1] + 6, fr[0] + 5, fr[1] + 7, MOUTH);
    // 脖子
    var hb = R('head', 'bottom'); putRect(d, W, hb[0], hb[1], hb[2], hb[3], SKIN_D);
    // 躯干：上衣
    FACE_ORDER.forEach(function (f) {
      var r = R('body', f);
      putRect(d, W, r[0], r[1], r[2], r[3], (f === 'top' || f === 'bottom') ? SHIRT_D : SHIRT);
    });
    // 手臂：前 4 行短袖，其余肤色；顶=袖子，底=手
    ['rightArm', 'leftArm'].forEach(function (id) {
      FACE_ORDER.forEach(function (f) {
        var r = R(id, f);
        if (f === 'top') { putRect(d, W, r[0], r[1], r[2], r[3], SHIRT); return; }
        if (f === 'bottom') { putRect(d, W, r[0], r[1], r[2], r[3], SKIN); return; }
        putRect(d, W, r[0], r[1], r[2], r[3], SKIN);
        putRect(d, W, r[0], r[1], r[2], r[1] + 4, SHIRT);
      });
    });
    // 腿：裤子 + 最后 4 行灰鞋；顶=裤子，底=鞋底
    ['rightLeg', 'leftLeg'].forEach(function (id) {
      FACE_ORDER.forEach(function (f) {
        var r = R(id, f);
        if (f === 'top') { putRect(d, W, r[0], r[1], r[2], r[3], PANTS); return; }
        if (f === 'bottom') { putRect(d, W, r[0], r[1], r[2], r[3], SHOE); return; }
        putRect(d, W, r[0], r[1], r[2], r[3], PANTS);
        putRect(d, W, r[0], r[1] + 8, r[2], r[3], SHOE);
      });
    });
    // 外层（hat/jacket/sleeve/pants）保持全透明 → 与基础层外观一致
    return { width: W, height: H, data: d };
  }

  /* ------------------------------------------------ 旧版 64×32 → 64×64 ---- */

  function copyBlock(dst, dw, src, sw, sx, sy, dx, dy, w, h, mirrorX) {
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var ss = ((sy + y) * sw + (mirrorX ? (sx + w - 1 - x) : (sx + x))) * 4;
        var dd = ((dy + y) * dw + (dx + x)) * 4;
        if (ss + 3 >= src.length || dd + 3 >= dst.length) continue;
        dst[dd] = src[ss]; dst[dd + 1] = src[ss + 1]; dst[dd + 2] = src[ss + 2]; dst[dd + 3] = src[ss + 3];
      }
    }
  }

  /* 3D 左右镜像的面配对：外↔内（right↔left）换位，前/后/顶/底不变，
   * 每个面自身再水平翻转 —— 与 vanilla 的 mirror=true 及 minecraft-skin-converter
   * 的 CopyAreas.Arm/Leg 逐面镜像表完全一致（v1.1 §3.6 第 3/4 步的表）。 */
  var MIRROR_FACE = { right: 'left', left: 'right', front: 'front', back: 'back', top: 'top', bottom: 'bottom' };

  /* 整块原样复制（贴图区 → 贴图区），用于补外层 */
  function copyBoxRegion(dst, dw, src, sw, srcBox, dstBox) {
    copyBlock(dst, dw, src, sw, srcBox.region[0], srcBox.region[1], dstBox.region[0], dstBox.region[1],
      srcBox.region[2] - srcBox.region[0], srcBox.region[3] - srcBox.region[1], false);
  }

  /* 逐面镜像：把 srcBox 的 6 个面水平翻转写到 dstBox 的镜像面 */
  function mirrorBox(dst, dw, src, sw, srcBox, dstBox) {
    FACE_ORDER.forEach(function (f) {
      var s = srcBox.faces[f].px, d = dstBox.faces[MIRROR_FACE[f]].px;
      copyBlock(dst, dw, src, sw, s[0], s[1], d[0], d[1], s[2] - s[0], s[3] - s[1], true);
    });
  }

  function convertLegacy64x32(data32) {
    if (!data32 || data32.length < SIZE_LEGACY.w * SIZE_LEGACY.h * 4) {
      throw new Error('convertLegacy64x32: 需要 64×32 的 RGBA 数据（' + (SIZE_LEGACY.w * SIZE_LEGACY.h * 4) + ' 字节）');
    }
    var out = blankSkin(SIZE_MODERN.w, SIZE_MODERN.h);
    var SW = SIZE_LEGACY.w;
    // 1) 旧版上半 (0,0)-(64,16) 原样复制：64×32 与 64×64 是同一像素网格，**不放大**
    copyBlock(out, TEX, data32, SW, 0, 0, 0, 0, 64, 16, false);
    // 2) 旧版下半的三块贴图位置不变：rightLeg(0,16) body(16,16) rightArm(40,16)
    copyBlock(out, TEX, data32, SW, 0, 16, 0, 16, 16, 16, false);
    copyBlock(out, TEX, data32, SW, 16, 16, 16, 16, 24, 16, false);
    copyBlock(out, TEX, data32, SW, 40, 16, 40, 16, 16, 16, false);
    // 3) 左臂/左腿 = 右臂/右腿逐面水平镜像（外↔内换位，见 v1.1 §3.6 的对应表）
    mirrorBox(out, TEX, out, TEX, BY_ID.rightArm, BY_ID.leftArm);
    mirrorBox(out, TEX, out, TEX, BY_ID.rightLeg, BY_ID.leftLeg);
    // 4) 补齐外层：旧版没有第二层，用基础层原样复制（外层与基础层外观一致）
    copyBoxRegion(out, TEX, out, TEX, BY_ID.head, BY_ID.hat);
    copyBoxRegion(out, TEX, out, TEX, BY_ID.body, BY_ID.jacket);
    copyBoxRegion(out, TEX, out, TEX, BY_ID.rightArm, BY_ID.rightSleeve);
    copyBoxRegion(out, TEX, out, TEX, BY_ID.rightLeg, BY_ID.rightPants);
    copyBoxRegion(out, TEX, out, TEX, BY_ID.leftArm, BY_ID.leftSleeve);   // 已镜像
    copyBoxRegion(out, TEX, out, TEX, BY_ID.leftLeg, BY_ID.leftPants);    // 官方两个区独立
    return { width: TEX, height: TEX, data: out };
  }

  /* ---------------------------------------------------------- 自检（无浏览器） */

  function _selfTest() {
    var pass = [], fail = [];
    function ok(name, cond, extra) { if (cond) pass.push(name); else fail.push(name + (extra ? ' — ' + extra : '')); }
    function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }

    try {
      // ---- BOXES 结构
      eq('BOXES 有 12 个盒', BOXES.length, 12);
      var ids = BOXES.map(function (b) { return b.id; }).join(',');
      eq('12 个盒 id 齐全', ids,
        'head,hat,rightLeg,body,rightArm,rightPants,jacket,rightSleeve,leftPants,leftLeg,leftArm,leftSleeve');
      ok('6 基础层 + 6 外层', BOXES.filter(function (b) { return b.layer === 'base'; }).length === 6 &&
        BOXES.filter(function (b) { return b.layer === 'outer'; }).length === 6);
      ok('每个盒都有 6 个面 + 几何', BOXES.every(function (b) {
        return FACE_ORDER.every(function (f) { return b.faces[f] && b.faces[f].px && b.geometry[f] && b.geometryCCW[f]; });
      }));
      ok('leftSleeve 不再是 CONTRACT 的越界映射（有独立贴图区）',
        box('leftSleeve').faces.front.px[1] < 64 && box('leftSleeve').faces.back.px[3] <= 64,
        JSON.stringify(box('leftSleeve').faces.front.px));

      // ---- UV 矩形都在 0..64 内、非退化，且落在自己声明的贴图区内
      var uvOk = true, uvBad = '';
      BOXES.forEach(function (b) {
        FACE_ORDER.forEach(function (f) {
          var r = b.faces[f].px;
          if (r[0] < 0 || r[1] < 0 || r[2] > TEX || r[3] > TEX || r[2] <= r[0] || r[3] <= r[1]) { uvOk = false; uvBad = b.id + '.' + f + '=' + r; }
          if (r[0] < b.region[0] || r[2] > b.region[2] || r[1] < b.region[1] || r[3] > b.region[3]) { uvOk = false; uvBad = b.id + '.' + f + ' 越出贴图区 ' + JSON.stringify(b.region) + ' rect=' + r; }
        });
      });
      ok('所有面的 UV 都落在 64×64 内且不越出所属贴图区', uvOk, uvBad);
      ok('贴图区都是官方格子（宽 2(w+d)、高 d+h）', BOXES.every(function (b) {
        return b.region[2] - b.region[0] === 2 * (b.uvSize[0] + b.uvSize[2]) &&
          b.region[3] - b.region[1] === b.uvSize[2] + b.uvSize[1];
      }));
      var overlapBad = '';
      for (var oi = 0; oi < BOXES.length; oi++) {
        for (var oj = oi + 1; oj < BOXES.length; oj++) {
          var ra = BOXES[oi].region, rb = BOXES[oj].region;
          if (ra[0] < rb[2] && rb[0] < ra[2] && ra[1] < rb[3] && rb[1] < ra[3]) overlapBad = BOXES[oi].id + '×' + BOXES[oj].id;
        }
      }
      ok('12 个贴图区互不重叠（官方布局，无左右裤/腿共用区）', overlapBad === '', overlapBad);

      // ---- 关键 UV 数值（官方布局）
      eq('head.front.px', box('head').faces.front.px, [8, 8, 16, 16]);
      eq('hat = head + (32,0)', box('hat').faces.front.px, [40, 8, 48, 16]);
      eq('body.front.px', box('body').faces.front.px, [20, 20, 28, 32]);
      eq('body.back.px（后面与前面同宽 8）', box('body').faces.back.px, [32, 20, 40, 32]);
      eq('jacket.back.px', box('jacket').faces.back.px, [32, 36, 40, 48]);
      eq('rightArm.front.px', box('rightArm').faces.front.px, [44, 20, 48, 32]);
      eq('rightSleeve = rightArm + (0,16)', box('rightSleeve').faces.front.px, [44, 36, 48, 48]);
      eq('rightLeg.front.px', box('rightLeg').faces.front.px, [4, 20, 8, 32]);
      eq('rightPants = rightLeg + (0,16)', box('rightPants').faces.front.px, [4, 36, 8, 48]);
      eq('leftArm = 官方 (32,48) 块', box('leftArm').faces.front.px, [36, 52, 40, 64]);
      eq('leftLeg = 官方 (16,48) 块', box('leftLeg').faces.front.px, [20, 52, 24, 64]);
      eq('leftPants = 官方 (0,48) 块', box('leftPants').faces.front.px, [4, 52, 8, 64]);
      eq('leftSleeve = 官方 (48,48) 块', box('leftSleeve').faces.front.px, [52, 52, 56, 64]);
      ok('左右肢体贴图块为官方格位（左臂=右臂块-8x+32y，左腿=右腿块+16x+32y）',
        box('leftArm').block[0] === box('rightArm').block[0] - 8 && box('leftArm').block[1] === box('rightArm').block[1] + 32 &&
        box('leftLeg').block[0] === box('rightLeg').block[0] + 16 && box('leftLeg').block[1] === box('rightLeg').block[1] + 32);
      var shiftOk = true, shiftBad = '';
      [['rightArm', 'leftArm', -8, 32], ['rightLeg', 'leftLeg', 16, 32],
        ['rightSleeve', 'leftSleeve', 8, 16], ['rightPants', 'leftPants', 0, 16]].forEach(function (t) {
        FACE_ORDER.forEach(function (f) {
          var a = box(t[0]).faces[f].px, b2 = box(t[1]).faces[f].px;
          for (var k = 0; k < 4; k++) {
            if (b2[k] !== a[k] + (k % 2 === 0 ? t[2] : t[3])) {
              shiftOk = false; shiftBad = t[1] + '.' + f + ' ' + b2 + ' ≠ ' + a + ' + (' + t[2] + ',' + t[3] + ')';
            }
          }
        });
      });
      ok('左臂/左腿/左袖/左裤 的 6 个矩形 = 右侧对应矩形按官方格位平移', shiftOk, shiftBad);

      // ---- 几何：bbox = min..min+size；四点贴在该面平面上
      var bboxOk = true, bboxBad = '';
      BOXES.forEach(function (b) {
        var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        FACE_ORDER.forEach(function (f) {
          b.geometry[f].forEach(function (p) {
            for (var a = 0; a < 3; a++) { if (p[a] < mn[a]) mn[a] = p[a]; if (p[a] > mx[a]) mx[a] = p[a]; }
          });
        });
        for (var a = 0; a < 3; a++) {
          if (Math.abs(mn[a] - b.min[a]) > 1e-9 || Math.abs(mx[a] - (b.min[a] + b.size[a])) > 1e-9) {
            bboxOk = false; bboxBad = b.id + ' axis' + a + ' got ' + mn[a] + '..' + mx[a] + ' want ' + b.min[a] + '..' + (b.min[a] + b.size[a]);
          }
        }
      });
      ok('每个盒 6 面的几何 bbox = min .. min+size', bboxOk, bboxBad);

      var axisOk = true, axisBad = '';
      BOXES.forEach(function (b) {
        var x0 = b.min[0], y0 = b.min[1], z0 = b.min[2];
        var x1 = x0 + b.size[0], y1 = y0 + b.size[1], z1 = z0 + b.size[2];
        var want = {
          right: ['x', x0], left: ['x', x1], front: ['z', z1], back: ['z', z0], top: ['y', y1], bottom: ['y', y0]
        };
        FACE_ORDER.forEach(function (f) {
          var ax = want[f][0] === 'x' ? 0 : (want[f][0] === 'y' ? 1 : 2);
          b.geometry[f].forEach(function (p) {
            if (Math.abs(p[ax] - want[f][1]) > 1e-9) { axisOk = false; axisBad = b.id + '.' + f + ' 不在 ' + want[f][0] + '=' + want[f][1]; }
          });
        });
      });
      ok('每个面的 4 个顶点都贴在该面所在的平面上', axisOk, axisBad);

      // ---- 绕序：外部视角一致（QUAD_WINDING='cw'）
      var OUT_N = { right: [-1, 0, 0], left: [1, 0, 0], front: [0, 0, 1], back: [0, 0, -1], top: [0, 1, 0], bottom: [0, -1, 0] };
      var windOk = true, windBad = '';
      BOXES.forEach(function (b) {
        FACE_ORDER.forEach(function (f) {
          var g = b.geometry[f];
          var u = [g[1][0] - g[0][0], g[1][1] - g[0][1], g[1][2] - g[0][2]];
          var v = [g[2][0] - g[0][0], g[2][1] - g[0][1], g[2][2] - g[0][2]];
          var n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          var dot = n[0] * OUT_N[f][0] + n[1] * OUT_N[f][1] + n[2] * OUT_N[f][2];
          var len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
          if (len < 1e-9) { windOk = false; windBad = b.id + '.' + f + ' 退化'; }
          else if (QUAD_WINDING === 'cw' ? !(dot < 0) : !(dot > 0)) { windOk = false; windBad = b.id + '.' + f + ' dot=' + dot; }
        });
      });
      ok('所有面绕序一致且与 QUAD_WINDING=' + QUAD_WINDING + ' 相符', windOk, windBad);
      ok('geometryCCW 与 geometry 顶点相同但顺序相反', (function () {
        return BOXES.every(function (b) {
          return FACE_ORDER.every(function (f) {
            var a = b.geometry[f], c = b.geometryCCW[f];
            for (var k = 0; k < 4; k++) if (a[k][0] !== c[3 - k][0] || a[k][1] !== c[3 - k][1] || a[k][2] !== c[3 - k][2]) return false;
            return true;
          });
        });
      })());

      // ---- 展开图闭合：相邻贴图区共用的贴图线必须映射到同一条 3D 棱（见 quadFor 注释）
      var eKey = function (p) { return p[0] + ',' + p[1] + ',' + p[2]; };
      var eStr = function (g, i, j) { var a = eKey(g[i]), b2 = eKey(g[j]); return a < b2 ? a + '|' + b2 : b2 + '|' + a; };
      var foldBad = '';
      BOXES.forEach(function (b) {
        [['right', 'front'], ['front', 'left'], ['left', 'back'], ['back', 'right']].forEach(function (pair) {
          // 前一个区 u1 边 = 顶点 1,2；后一个区 u0 边 = 顶点 0,3
          if (eStr(b.geometry[pair[0]], 1, 2) !== eStr(b.geometry[pair[1]], 0, 3)) foldBad = b.id + ' ' + pair[0] + '.u1 ≠ ' + pair[1] + '.u0';
        });
        // top 紧贴 front 上方：top 的 v1 边(2,3) == front 的 v0 边(0,1)
        if (eStr(b.geometry.top, 2, 3) !== eStr(b.geometry.front, 0, 1)) foldBad = b.id + ' top.v1 ≠ front.v0';
        // top 的 v0 边(0,1) == back 的 v0 边(0,1)（顶部后棱）
        if (eStr(b.geometry.top, 0, 1) !== eStr(b.geometry.back, 0, 1)) foldBad = b.id + ' top.v0 ≠ back.v0';
        // bottom 采用标准十字展开朝向：v0 边(0,1) == front 的 v1 边(2,3)
        if (eStr(b.geometry.bottom, 0, 1) !== eStr(b.geometry.front, 2, 3)) foldBad = b.id + ' bottom.v0 ≠ front.v1';
      });
      ok('展开图闭合：相邻贴图区共用贴图线映射到同一条 3D 棱', foldBad === '', foldBad);
      ok('geometryContract（v1.1 字面值）顶点集与 geometry 相同', BOXES.every(function (b) {
        return FACE_ORDER.every(function (f) {
          var a = b.geometry[f].map(eKey).sort().join(';');
          var c = b.geometryContract[f].map(eKey).sort().join(';');
          return a === c && b.geometryContract[f].length === 4;
        });
      }));
      ok('faces[].uv 与 geometry 下标对齐、uvCCW 与 geometryCCW 下标对齐', BOXES.every(function (b) {
        return FACE_ORDER.every(function (f) {
          var r = b.faces[f].px, uv = b.faces[f].uv;
          return uv[0][0] === r[0] / 64 && uv[0][1] === r[1] / 64 && uv[2][0] === r[2] / 64 && uv[2][1] === r[3] / 64 &&
            b.faces[f].uvCCW[0][0] === uv[3][0] && b.faces[f].uvCCW[0][1] === uv[3][1];
        });
      }));
      // ---- regionAt（v1.1 验收点）
      var r1 = regionAt(21, 22);
      ok('regionAt(21,22) → body/front', !!r1 && r1.boxId === 'body' && r1.face === 'front' && r1.layer === 'base', JSON.stringify(r1));
      var r2 = regionAt(45, 22);
      ok('regionAt(45,22) → rightArm/front', !!r2 && r2.boxId === 'rightArm' && r2.face === 'front', JSON.stringify(r2));
      var r3 = regionAt(10, 10);
      ok('regionAt(10,10) → head/front', !!r3 && r3.boxId === 'head' && r3.face === 'front', JSON.stringify(r3));
      var r4 = regionAt(45, 10);
      ok('regionAt(45,10) → hat/front（外层优先于 head）', !!r4 && r4.boxId === 'hat' && r4.layer === 'outer', JSON.stringify(r4));
      var r5 = regionAt(37, 53);
      ok('regionAt(37,53) → leftArm/front', !!r5 && r5.boxId === 'leftArm' && r5.face === 'front', JSON.stringify(r5));
      var r6 = regionAt(21, 53);
      ok('regionAt(21,53) → leftLeg/front', !!r6 && r6.boxId === 'leftLeg' && r6.face === 'front', JSON.stringify(r6));
      var r7 = regionAt(53, 53);
      ok('regionAt(53,53) → leftSleeve/front（左袖有独立贴图区）', !!r7 && r7.boxId === 'leftSleeve' && r7.face === 'front', JSON.stringify(r7));
      var r8 = regionAt(45, 53);
      ok('regionAt(45,53) → leftArm/back（不是左臂正面）', !!r8 && r8.boxId === 'leftArm' && r8.face === 'back', JSON.stringify(r8));
      var r9 = regionAt(5, 53);
      ok('regionAt(5,53) → leftPants/front（左裤是 (0,48) 独立区）', !!r9 && r9.boxId === 'leftPants' && r9.face === 'front', JSON.stringify(r9));
      ok('regionAt(2,2) → null（头部贴图块左上 8×8 是官方未使用区）', regionAt(2, 2) === null);
      ok('regionAt(-1,-1) → null', regionAt(-1, -1) === null);
      ok('leftPants 与 leftLeg 贴图区互不重叠（官方两个独立区）',
        box('leftPants').region[2] <= box('leftLeg').region[0] || box('leftLeg').region[2] <= box('leftPants').region[0]);
      ok('overlaps[0] === boxId 且长度 ≥1', !!r1 && r1.overlaps.length >= 1 && r1.overlaps[0] === r1.boxId);
      ok('opts.layer 过滤生效', regionAt(44, 25, { layer: 'outer' }) === null && !!regionAt(44, 25, { layer: 'base' }));
      ok('opts.format=legacy 时不认 hat（旧版无外层）', regionAt(45, 10, { format: 'legacy' }) === null &&
        !!regionAt(20, 22, { format: 'legacy' }));
      ok('regionAt 返回局部 u/v ∈ [0,1)', !!r1 && r1.u >= 0 && r1.u < 1 && r1.v >= 0 && r1.v < 1);

      // ---- 其它查询
      eq('uvFromPixel(0,0)', uvFromPixel(0, 0), [0, 0]);
      eq('uvFromPixel(32,16)', uvFromPixel(32, 16), [0.5, 0.25]);
      ok('shadeFor(top)=1.0 且 bottom 最暗', shadeFor('top') === 1.0 && shadeFor('bottom') === 0.55 && shadeFor('nope') === 1.0);
      eq('FACE_ORDER', FACE_ORDER, ['right', 'front', 'left', 'back', 'top', 'bottom']);
      ok('faceQuad/faceQuadCCW 都是 4 个顶点，box(id) 可查，box("x") 为 null',
        faceQuad('head', 'front').length === 4 && faceQuadCCW('head', 'front').length === 4 &&
        !!box('body') && box('nope') === null && faceQuad('head', 'nope') === null);
      ok('FACE_LABEL / PART_LABEL 齐全', FACE_ORDER.every(function (f) { return !!FACE_LABEL[f]; }) &&
        BOXES.every(function (b) { return !!PART_LABEL[b.id]; }));

      // ---- LAYOUT_REGIONS
      eq('LAYOUT_REGIONS = 12 盒 × 6 面', LAYOUT_REGIONS.length, 72);
      ok('LAYOUT_REGIONS 字段齐全且中文标签带「·」', LAYOUT_REGIONS.every(function (g) {
        return g.id && g.label && g.label.indexOf('·') > 0 && g.px.length === 4 &&
          g.px[2] > g.px[0] && g.px[3] > g.px[1] && g.px[0] >= 0 && g.px[3] <= 64 &&
          (g.kind === 'head' || g.kind === 'body' || g.kind === 'arm' || g.kind === 'leg') &&
          (g.layer === 'base' || g.layer === 'outer');
      }));
      ok('LAYOUT_REGIONS 覆盖所有面且不重复', (function () {
        var seen = {};
        return LAYOUT_REGIONS.every(function (g) {
          if (seen[g.id]) return false; seen[g.id] = 1; return true;
        });
      })());
      ok('「右臂·外侧面」标签存在', LAYOUT_REGIONS.some(function (g) { return g.label === '右臂·外侧面'; }));
      ok('「头·正面(脸)」标签存在', LAYOUT_REGIONS.some(function (g) { return g.label === '头·正面(脸)'; }));

      // ---- blankSkin / defaultSkin
      var blank = blankSkin(64, 64);
      ok('blankSkin 全透明', blank.length === 64 * 64 * 4 && blank.every(function (v) { return v === 0; }));
      var def = defaultSkin();
      var opaque = 0, i;
      for (i = 3; i < def.data.length; i += 4) if (def.data[i] > 0) opaque++;
      ok('defaultSkin 是 64×64 且有内容（可辨识，非全透明）', def.width === 64 && def.height === 64 && opaque > 1000, 'opaque=' + opaque);
      var bodyFront = box('body').faces.front.px;
      var bp = ((bodyFront[1] + 1) * 64 + bodyFront[0] + 1) * 4;
      ok('defaultSkin 躯干是青蓝色上衣', def.data[bp] < 120 && def.data[bp + 1] > 110 && def.data[bp + 1] < 200 && def.data[bp + 2] > 140,
        [def.data[bp], def.data[bp + 1], def.data[bp + 2]].join(','));
      var headTop = box('head').faces.top.px;
      var hp = ((headTop[1] + 1) * 64 + headTop[0] + 1) * 4;
      ok('defaultSkin 头顶是棕发', def.data[hp] > def.data[hp + 1] && def.data[hp + 1] > def.data[hp + 2] && def.data[hp] > 60 && def.data[hp] < 140,
        [def.data[hp], def.data[hp + 1], def.data[hp + 2]].join(','));
      var legFront = box('rightLeg').faces.front.px;
      var lp = ((legFront[1] + 10) * 64 + legFront[0] + 1) * 4;
      ok('defaultSkin 小腿下部是灰鞋', Math.abs(def.data[lp] - def.data[lp + 2]) < 30 && def.data[lp] > 80 && def.data[lp] < 160,
        [def.data[lp], def.data[lp + 1], def.data[lp + 2]].join(','));
      ok('defaultSkin 外层保持透明', FACE_ORDER.every(function (f) {
        var r = box('hat').faces[f].px;
        for (var y = r[1]; y < r[3]; y++) for (var x = r[0]; x < r[2]; x++) if (def.data[(y * 64 + x) * 4 + 3] !== 0) return false;
        return true;
      }));

      // ---- convertLegacy64x32（用合成图，不依赖任何外部文件）
      var leg = blankSkin(64, 32);
      for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
        putPx(leg, 64, x, 16 + y, [10 + x * 3, 40 + y * 5, 200, 255]);            // rightLeg（渐变，可测镜像）
      }
      for (var ya0 = 0; ya0 < 16; ya0++) for (var xa0 = 0; xa0 < 16; xa0++) {
        putPx(leg, 64, 40 + xa0, 16 + ya0, [90 + xa0 * 5, 90 + ya0 * 3, 220 - xa0 * 4, 255]);  // rightArm（渐变）
      }
      putRect(leg, 64, 0, 0, 32, 16, [200, 100, 50, 255]);        // head
      putRect(leg, 64, 16, 16, 40, 32, [30, 160, 60, 255]);       // body
      var conv = convertLegacy64x32(leg);
      ok('convertLegacy64x32 返回 64×64 Uint8ClampedArray',
        conv.width === 64 && conv.height === 64 && conv.data instanceof Uint8ClampedArray && conv.data.length === 64 * 64 * 4);
      var px = function (d, x, y) { var i = (y * 64 + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
      var rectEq = function (x0, y0, x1, y1, u0, v0) {
        for (var yy = y0; yy < y1; yy++) for (var xx = x0; xx < x1; xx++) {
          var a = px(conv.data, xx, yy), b2 = px(conv.data, u0 + (xx - x0), v0 + (yy - y0));
          if (a[0] !== b2[0] || a[1] !== b2[1] || a[2] !== b2[2] || a[3] !== b2[3]) return false;
        }
        return true;
      };
      eq('转换：头部 (0,0)-(32,16) 1:1 原样', [px(conv.data, 3, 3), px(conv.data, 30, 14)], [[200, 100, 50, 255], [200, 100, 50, 255]]);
      ok('转换：hat = 头部（整区原样）', rectEq(32, 0, 64, 16, 0, 0));
      ok('转换：jacket = 躯干', rectEq(16, 32, 40, 48, 16, 16));
      ok('转换：rightSleeve = 右臂', rectEq(40, 32, 56, 48, 40, 16));
      ok('转换：rightPants = 右腿', rectEq(0, 32, 16, 48, 0, 16));
      ok('转换：leftSleeve = 左臂（已镜像）', rectEq(48, 48, 64, 64, 32, 48));
      ok('转换：leftPants = 左腿', rectEq(0, 48, 16, 64, 16, 48));
      ok('转换：legacy 未定义的 (56,16)-(64,32) 保持透明', conv.data[((20) * 64 + 60) * 4 + 3] === 0);
      // 逐面镜像（外↔内换位 + 每个面自身水平翻转），与 v1.1 §3.6 表 / msc CopyAreas 一致
      var MF = { right: 'left', left: 'right', front: 'front', back: 'back', top: 'top', bottom: 'bottom' };
      var mirrorBad = '';
      [['rightArm', 'leftArm'], ['rightLeg', 'leftLeg']].forEach(function (pair) {
        var sBox = box(pair[0]), dBox = box(pair[1]);
        FACE_ORDER.forEach(function (f) {
          var s = sBox.faces[f].px, d = dBox.faces[MF[f]].px, w = s[2] - s[0], h = s[3] - s[1];
          for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
            var a = px(conv.data, d[0] + xx, d[1] + yy), b2 = px(conv.data, s[0] + w - 1 - xx, s[1] + yy);
            if (a[0] !== b2[0] || a[1] !== b2[1] || a[2] !== b2[2] || a[3] !== b2[3]) mirrorBad = pair[1] + '.' + f + ' ← ' + pair[0] + '.' + MF[f];
          }
        });
      });
      ok('转换后左臂/左腿 = 右臂/右腿逐面水平镜像（外↔内换位）', mirrorBad === '', mirrorBad);
      var legNonEmpty = 0, armNonEmpty = 0;
      for (var yy2 = 48; yy2 < 64; yy2++) {
        for (var xx2 = 16; xx2 < 32; xx2++) if (px(conv.data, xx2, yy2)[3] > 0) legNonEmpty++;
        for (var xx3 = 32; xx3 < 48; xx3++) if (px(conv.data, xx3, yy2)[3] > 0) armNonEmpty++;
      }
      ok('转换后左腿区 6 个面全覆盖（224 = 6 面 UV 面积；贴图块空角保持透明）', legNonEmpty === 224, 'nonEmpty=' + legNonEmpty);
      ok('转换后左臂区 6 个面全覆盖（224）', armNonEmpty === 224, 'nonEmpty=' + armNonEmpty);
      ok('转换后 (37,53)=左臂正面、(21,53)=左腿正面 有内容',
        px(conv.data, 37, 53)[3] > 0 && px(conv.data, 21, 53)[3] > 0);
      ok('convertLegacy64x32 对错误尺寸抛错', (function () {
        try { convertLegacy64x32(new Uint8ClampedArray(10)); return false; } catch (e) { return true; }
      })());
    } catch (e) {
      fail.push('rules 自检异常: ' + (e && e.message ? e.message : e));
    }
    return { pass: pass, fail: fail };
  }

  /* ------------------------------------------------------------- 导出 ------- */

  MCSKIN.rules = {
    VERSION: VERSION,
    SIZE_MODERN: SIZE_MODERN,
    SIZE_LEGACY: SIZE_LEGACY,
    TEX_SIZE: TEX,
    QUAD_WINDING: QUAD_WINDING,
    FACE_ORDER: FACE_ORDER,
    FACE_SHADE: FACE_SHADE,
    FACE_LABEL: FACE_LABEL,
    PART_LABEL: PART_LABEL,
    BOXES: BOXES,
    LAYOUT_REGIONS: LAYOUT_REGIONS,

    box: box,
    faceQuad: faceQuad,
    faceQuadCCW: faceQuadCCW,
    uvFromPixel: uvFromPixel,
    uvFromPixelCenter: uvFromPixelCenter,
    shadeFor: shadeFor,
    faceLabelFor: function (partId, face) { return SHORT_LABEL[partId] + '·' + faceSuffix(partId, face); },
    regionAt: regionAt,
    convertLegacy64x32: convertLegacy64x32,
    blankSkin: blankSkin,
    defaultSkin: defaultSkin,
    _selfTest: _selfTest
  };

  MCSKIN.tests = MCSKIN.tests || {};
  MCSKIN.tests.rules = _selfTest();
})(typeof window !== 'undefined' ? window : this);
