# dsh-mcskin-artist

**Draw, lint and 3D-review Minecraft skins from DeepSeek Harness.**

A plugin that gives the agent four tools and a skill for making Minecraft skins
end to end: pixel editing, a 13-check quality score, and multi-view 3D renders
the agent actually looks at.

[中文](#中文说明)

---

## What it does

Minecraft skins are 64×64 pixel grids with a strict, counter-intuitive UV
layout. Getting them to look good means iterating: draw, score it, *look at it*,
fix what's wrong, repeat. This plugin makes that loop available to the agent.

| Tool | Purpose |
|---|---|
| `mcskin_draw` | Pixel operations: `new` / `convert` / `set` / `fill` / `rect` / `line` / `mirror-limbs` / `run` |
| `mcskin_inspect` | Read-only reports: `info` / `pixel` / `palette` / `parts` / `crops` |
| `mcskin_lint` | 13 programmatic checks, a 0–100 score and an A/B/C/D grade, with coordinates to fix |
| `mcskin_render` | 8 camera angles, 4 pose frames and magnified texture crops |

Plus a **`mcskin-artist`** skill that teaches the workflow: plan a palette →
lay down colours with a batch script → lint → render → *open the images* → refine.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-mcskin-artist
```

From a clone:

```bash
dsh plugin --profile <your-profile> add /path/to/dsh-mcskin-artist
```

Requires DeepSeek Harness `>=0.2.0-rc.1`. The Host supplies
`@deepseek-ai/dsh-tools`, so there is nothing else to install.

Then just ask for a skin:

> 画一个森林游侠的 MC 皮肤

> Review this skin and tell me what to fix: `./my-skin.png`

## Why lint alone is not enough

`mcskin_lint` scores what it can *measure*: colour counts, edge energy, symmetry,
palette size. It cannot tell whether a face reads as a face.

During development this plugin produced a skin that scored **100/100, grade A** —
and rendered with its entire face missing, because the outer hat layer fully
covers the same coordinates as the head. The score was perfect and the result was
unusable.

So the skill makes one rule non-negotiable: **lint first, then open the images.**
The bundled skill documents this failure mode so the agent repeats it less often.

## Layout

```
lib/index.js       plugin entry: registers the four tools and the skill
bin/skin.mjs       CLI: drawing, inspection, lint (pure JSON on stdout)
bin/render.mjs     CLI: headless-browser 3D renders
lib/rules.js       the 13 lint checks
lib/renderer3d.js  geometry and shading
harness/render.html  the page the renderer drives
skills/SKILL.md    the workflow the agent follows
skills/r-full.txt  a verified base-layer script (scores 100 / grade A)
scripts/smoke.mjs  end-to-end test
```

`bin/` and `lib/` hold the drawing engine; `lib/index.js` is a thin translator
that shells out to it, so the CLI stays the single source of truth for pixels.

## Using the CLI directly

The plugin is a Host integration, not a wrapper — the CLI works on its own:

```bash
node bin/skin.mjs new -o skin.png --template blank
node bin/skin.mjs run rounds/r1.txt skin.png -o skin.png
node bin/skin.mjs lint skin.png
node bin/render.mjs skin.png -o skin.review
node bin/skin.mjs selftest
```

Every command prints JSON on stdout and exits non-zero on failure, so it composes
with `jq` and CI.

> **PowerShell:** quote any argument containing commas, e.g.
> `node bin/skin.mjs set skin.png '9,12,#3f70c8'`. Unquoted, PowerShell splits
> `a,b` into an array and treats `#` as a comment. The agent tools already do
> this for you.

## Test

```bash
npm test
```

Runs the four tools against a temporary workspace, including a real 3D render.

## Notes

- 64×64 modern format is required; use `mcskin_draw` with `command: "convert"`
  to upgrade a legacy 64×32 skin.
- `y` never exceeds 31. Pixels below that are reported as `outside-pixels`.
- Draw the right arm and leg, then run `mirror-limbs` — hand-drawing the left
  side is a reliable way to get it wrong.
- The bundled skill carries a verified coordinate table and the three UV traps
  worth knowing before you start.

## License

MIT

---

<a id="中文说明"></a>
## 中文说明

给 DeepSeek Harness 用的 Minecraft 皮肤绘制插件：**四个 Agent 工具 + 一个技能**，
让模型能端到端地画皮肤、打分、做 3D 多视角审查。

| 工具 | 作用 |
|---|---|
| `mcskin_draw` | 像素操作：`new` / `convert` / `set` / `fill` / `rect` / `line` / `mirror-limbs` / `run` |
| `mcskin_inspect` | 只读报告：`info` / `pixel` / `palette` / `parts` / `crops` |
| `mcskin_lint` | 13 项质检 + 0~100 分 + A/B/C/D 等级，每条问题都带要改的坐标 |
| `mcskin_render` | 8 视角 + 4 姿态 + 贴图放大裁切 |

外加 `mcskin-artist` 技能，教会模型完整流程：定调色板 → 批量铺底 → lint → 渲染 →
**真的看图** → 精修。

### 安装

```bash
dsh plugin --profile <你的 profile> add dsh-mcskin-artist
```

需要 DeepSeek Harness `>=0.2.0-rc.1`。`@deepseek-ai/dsh-tools` 由 Host 提供，
无需另外安装。

### 为什么光看 lint 不够

`mcskin_lint` 只统计**能量化的东西**：颜色数、边缘能量、左右对称、调色板规模。
它不知道脸长什么样。

开发这个插件时实测出现过一张 **100 分、grade A、但 3D 渲染里整张脸消失**的皮肤 ——
原因是外层帽子和头部正面坐标完全重叠、被填满了。分数满分，结果完全不能用。

所以技能里写死了一条规矩：**先 lint，再真的把图打开看。**
这条失败案例也写进了技能文档，让模型少踩一次。

### 几个容易踩的坑

- **y 最大只到 31**，画到 32 就是越界像素。
- **只画右臂右腿，然后跑 `mirror-limbs`**。手动画左肢基本会错，工具算的镜像才准。
- **外层别填满**。尤其 `hat/front`：盖住额头两行（y=8–9）即可，填满 y=8–15 会盖掉整张脸。
- **不确定坐标就查**：`mcskin_inspect` 的 `command: "pixel"` 会告诉你这个点属于哪个部位/面/层。

技能文档里附了一张**实测验证过的完整坐标表**，以及一份直接能跑出 100 分的
基础铺底脚本（`skills/r-full.txt`）。

### 测试

```bash
npm test
```

会在临时目录里跑通四个工具，含真实 3D 渲染。

### 许可

MIT
