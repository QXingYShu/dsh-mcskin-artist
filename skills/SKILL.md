---
name: mcskin-artist
description: "Draw, review and iterate on Minecraft skins (64x64 / 64x32) end-to-end with the mcskin_* tools: batch pixel drawing, programmatic lint scoring, and multi-view multi-pose 3D screenshot review. | 用 mcskin_* 工具端到端绘制与审查 Minecraft 皮肤：批量像素绘制、lint 质量评分、多视角多姿态 3D 截图审查。触发：画/绘制/审查 MC 皮肤、skin 绘制、皮肤质检、多视角预览皮肤。"
argument-hint: "[skin.png 或 绘制需求描述]"
version: "1.1.0"
user-invocable: true
allowed-tools: Read, Write, Edit, mcskin_draw, mcskin_inspect, mcskin_lint, mcskin_render
---

> **Language / 语言**: This skill supports both English and Chinese. Detect the user's language from the first message and keep answering in that language. 本 Skill 支持中英文：按用户第一条消息的语言，全程使用同一语言。

> **Critical rule / 关键规则**: Draw with the `mcskin_*` tools, NOT with hand-written `node bin/skin.mjs` commands. The tools
> already encode the correct argument order and return structured JSON. If you find yourself typing a `node ...` command,
> stop and use the tool instead.

---

# mcskin-artist：用工具绘制 + 审查 Minecraft 皮肤

## 1. 四个工具（不要绕过它们）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `mcskin_draw` | **唯一**的写像素工具 | `command`（new/convert/set/fill/rect/line/mirror-limbs/run） |
| `mcskin_inspect` | 只读报告 | `command`（info/pixel/palette/parts/crops） |
| `mcskin_lint` | 13 项质检 + 0~100 分 + A/B/C/D | `skin` |
| `mcskin_render` | 8 视角 + 4 姿态 + 贴图裁切 | `skin`、`out` |

**画皮肤永远只调 `mcskin_draw`。** `mcskin_inspect`/`lint`/`render` 都不改像素。

### 坐标与颜色格式

- 点：`'x,y'`　矩形：`'x0,y0,x1,y1'`（**两端都含**）
- 颜色：`'#rrggbb'`、`'#rrggbbaa'`、`'r,g,b'`
- 不确定某个坐标属于哪个部位 → 先 `mcskin_inspect` 的 `command: "pixel"`，**不要猜**

### ✅ 经实测验证的 64×64 布局（现代格式）

**把这张表背下来，比反复 `pixel` 查询快。**（左列 x 范围，右列 y 范围）

| 部位 | 正面 | 背面 | 右侧 | 左侧 | 顶面 | 底面 |
|---|---|---|---|---|---|---|
| head | 8,8–15,15 | 24,8–31,15 | 0,8–7,15 | 16,8–23,15 | 8,0–15,7 | — |
| body | 20,20–27,31 | 28,20–31,27 | 16,20–19,31 | 32,20–35,27 | 20,32–27,35 | 28,32–31,35 |
| rightArm | 44,20–47,31 | 48,20–51,31 | 40,20–43,31 | 52,20–55,31 | 44,32–47,35 | — |
| rightLeg | 4,20–7,31 | 8,20–11,31 | 0,20–3,31 | 12,20–15,31 | 4,32–7,35 | 4,16–7,19 |

**外层（hat / jacket / rightSleeve / rightPants）与 base 层坐标完全重叠**：
`hat/front` = 40,8–47,15，`jacket/front` = 40,20–43,32（但 **y 只到 31**，y=32 会越界）。

**三条铁律：**
1. **y 最大 31。** 画到 y=32 会被 lint 判 `outside-pixels`。
2. **只画右臂右腿，再 `mirror-limbs`。** 手动画左肢几乎必错 —— 工具算的镜像才准。
3. **外层别填满。** 尤其 `hat/front`：盖满额头两行（y=8–9）即可，填满 y=8–15 会**盖住整张脸**。

---

## 2. 标准工作流（多轮）

> **硬性节奏：每一轮都必须「先 lint，再看图」。两者都不许省。**

### R0 规划（先不画像素）

1. 读需求，定风格关键词（角色、配色、材质）。
2. 定调色板：≤24 色，最多 40。每色一个 `#rrggbb` + 用途，**先写下来**。
3. 建新皮：
   ```json
   {"tool":"mcskin_draw","command":"new","out":"skin.png","size":64,"template":"blank"}
   ```
   （`template: "default"` 从 Steve 皮起步）

### R1 铺底：用 `run` 批量脚本，不要逐像素

**批量脚本比几十次单点调用快得多，也省 token。**

1. 用 Write 工具写脚本文件（如 `rounds/r1.txt`），一行一条绘制命令，`#` 开头是注释。
   **脚本里不要写皮肤路径和 `-o`**，工具会自动补：
   ```text
   # rounds/r1.txt —— 森林游侠 铺底
   rect 8,8,15,15,#e8b48a           # 头正面：肤色
   rect 8,8,15,10,#6b4a2f           # 头发（盖住额头三行）
   rect 20,20,27,31,#3f8f5f         # 躯干：上衣
   rect 16,20,19,31,#34774f         # 躯干右侧面：暗部
   rect 44,20,47,24,#3f8f5f         # 右臂：袖子
   rect 44,25,47,31,#e8b48a         # 右臂：手
   rect 4,20,7,27,#4a5a78           # 右腿：裤子
   rect 4,28,7,31,#6b6b73           # 右腿：鞋
   mirror-limbs                     # 右臂/右腿镜像到左边
   ```
   > ⚠️ `run` 脚本**只支持** `set` / `fill` / `rect` / `line` / `mirror-limbs` / `palette` / `parts`。
   > 带参数的命令（如 `set` 的 `x,y,#色` 三元组、`rect` 的矩形四元组）直接写在一行里。
   > **不要**在脚本里写 `--outline`、`--bounds`、`--include-outer` 这类选项 —— 它们会让整行失败。
   > 需要 `mirror-limbs --include-outer` 时，单独调一次 `mcskin_draw` 的 `command: "mirror-limbs"` 加 `include_outer: true`。

2. 执行：
   ```json
   {"tool":"mcskin_draw","command":"run","script":"rounds/r1.txt","skin":"skin.png","out":"skin.png"}
   ```

铺底要求：6 个基础层部位都要有内容，别留空白（lint 会报 `empty-base-part`）。

### R2+ 精修循环（最多 5 轮）

每轮依次做 4 件事：

1. **存档**：把 `skin.png` 复制成 `skin.round<N>.png`（改坏了能退回）。

2. **lint**：
   ```json
   {"tool":"mcskin_lint","skin":"skin.png"}
   ```
   记下 `score`、`grade`，以及每条 `fail`/`warn` 的 `id` + `evidence`。
   **evidence 里就是具体坐标，照着改，不要凭感觉重画。**

3. **渲染 + 真的看图**（关键步骤，不许跳过）：
   ```json
   {"tool":"mcskin_render","skin":"skin.png","out":"skin.review"}
   ```
   然后用 read_image **逐张打开**：
   - `skin.review/views/*.png`（8 张，按 §4 清单看）
   - `skin.review/poses/*.png`（4 张姿态帧，看关节有没有错位/露底）
   - `skin.review/texture/*.png`（贴图 4×/8×，看像素级缺陷）

   **每张都要写一句「我看到了什么」。只看一张就下结论是不合格的。**

4. **写问题清单 + 改**：按「坐标 + 期望效果」写新脚本 → 执行 → 回到第 2 步。

### 终止条件

- `fail = 0`、`warn ≤ 2`、`grade = A`（score ≥ 85）
- **且** §4 视觉清单全部通过
- **且**至少完成 2 轮「lint + 看图」——**一轮就交付是违规的**

### ⚠️ 满分 ≠ 能看（真实教训）

**lint 打 100 分但图完全不能用，是这个工作流最常见的失败。** lint 只统计颜色数、边缘能量、对称性等**可计算指标**，
它**不知道脸长什么样**。实测踩过：帽子外层（`hat/front` 与头部正面坐标完全重叠）被填满，
lint 依然给出 100 分 grade A，但 3D 渲染里**整张脸消失了**。

**所以：先看图，再决定收不收工。分数是下限，不是上限。**

### 🧭 别猜坐标，先查 `pixel`

Minecraft 的 UV 布局有几个反直觉之处，猜坐标必错：

- 躯干只有 16-19 / 28-31 / 32-35 三条侧面，**没有** x=36-39（那是躯干背面区）。
- 右臂右侧面是 **x=40-43**，右臂正面是 **x=44-47** —— 两个不同的面。
- **y 最大只到 31**，画到 y=32 就是越界像素。
- 外层（hat / jacket / sleeve）与其 base 层**坐标完全重叠**，填满就会盖住整个部位。

不确定就 `mcskin_inspect` 的 `command: "pixel"` 查一个坐标，问它属于哪个 part/face/layer。
这是本工作流里**最省时间的一步**，比反复试错快得多。

### 收尾

保存最终 `skin.png`，保留各轮存档。汇报三段：**最终 score/grade**、**每轮分数变化**、**还剩哪些已知小瑕疵**。

---

## 3. lint 常见问题与对策

| lint id | 含义 | 怎么修 |
|---|---|---|
| `low-detail` | 边缘能量太低，几乎整块平涂 | 加 2~3 级明暗、衣褶、发丝；别只堆颜色 |
| `outer-unused` | 外层（帽子/外套/袖/裤）没用 | 头发、衣摆、腰带 —— 层次感的关键 |
| `flat-face` | 某部位正面只有 1 种颜色 | 该部位做明暗或图案 |
| `content-coverage` | 不透明像素不足 | 铺满 6 个基础部位（≥1200，最好 ≥2500） |
| `palette-size` | 颜色数失控（>40） | 合并近色，控制在 ≤24 |
| `noise` | 孤立噪点 >4 | `set` 那些坐标到邻近色 |
| `mirror-balance` | 左右臂正面色差明显 | 跑 `mirror-limbs` 同步两侧 |
| `legacy` | 还是 64×32 旧格式 | `command: "convert"` |
| `outside-pixels` | 有像素落在有效部位外 | 按 evidence 坐标 `set` 成 `#00000000` |

**分数上不去、又看不出问题** → 优先加**外层**（头发/衣摆/腰带）和 2~3 级明暗，而不是继续加颜色。

---

## 4. 视觉审查清单（lint 查不出来的部分）

### 视角（`views/`）
- **front**：脸可辨吗（两眼对称、间距合理）？发际线压住额头了吗？衣服中缝/扣子居中吗？左右臂色差过大吗？
- **front34L / front34R**：发梢/帽檐有厚度吗（外层生效）？鼻梁与下颌的明暗过渡？肩线断了吗？
- **sideR / sideL**：头厚 8 / 躯干厚 4 / 四肢厚 4 的比例正常吗？前后缘齐吗？袖口裤脚有收边吗？
- **back**：背面不能是纯色平板（至少要有发尾、衣褶或背带）；鞋跟有区分吗？
- **top / bottom**：头顶分区错位吗？脚底是鞋底色还是和鞋面一样？

### 姿态（`poses/`）
- **walk_25 / walk_75**：手臂前后摆时，肩/肘贴图错位吗？露出透明或杂色了吗？
- **wave_60**：右臂抬起 180°，腋下/侧腰有拉伸错位或空白吗？
- **idle_0**：呼吸起伏时躯干与腿交界稳定吗？

### 像素级（`texture/`）
- `full_4x.png`：有孤立噪点、色带断层、锯齿边吗？
- `<part>_8x.png`：边界对齐吗？渐变至少 2~3 级吗？细节是不是只有一块平色？

---

## 5. 多轮修改协议

- 每轮产出三段：**① lint 分数 ② 看图结论（每张图一句）③ 本轮改动清单**。
- 改动要「成块」：一轮只修一类问题（这轮只修脸、下轮只修衣褶），不要每轮全图微调。
- **连续两轮分数不涨 → 换策略**：从「叠加细节」改成「局部重画」（先 `rect` 铺回底色再画）。
- **禁止**：只跑 lint 不看图（分数会好看但图很丑）；不查坐标就改；一轮就交付。

---

## 6. 故障处理

| 现象 | 处理 |
|---|---|
| `mcskin_render` 失败 / 没有 WebGL | 不是皮肤的问题。退化为 `mcskin_inspect` 的 `command: "crops"`，只看贴图裁切，并在汇报里说明「本轮无法做 3D 审查」 |
| 渲染返回 `errors` | 把 errors 原文贴进汇报 |
| 不确定坐标属于哪个部位 | 先 `mcskin_inspect` 的 `command: "pixel"` 查询，再动手 |
| 参数校验失败 | 工具会返回 `INVALID_ARGS` 和具体违规项；按它说的改类型或补必填项 |
| 提示浏览器不可用 | 用 `crops` 代替，并**明确告诉用户 3D 审查这轮没做成** |

---

## 7. 交付物

- 最终皮肤：`skin.png`（64×64 现代格式；64×32 必须先 `convert`）
- 各轮快照：`skin.round1.png`、`skin.round2.png` …
- 审查产物：`skin.review/`（`views/` `poses/` `texture/` `report.json`）
- 批量脚本：`rounds/r<N>.txt`
