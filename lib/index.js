/**
 * dsh-mcskin-artist — draw, lint and 3D-review Minecraft skins from the agent.
 *
 * The plugin exposes four model-facing tools:
 *
 *   mcskin_draw    — pixel edits (new / set / fill / rect / line / mirror / run-script)
 *   mcskin_inspect — info / palette / parts / crops reports
 *   mcskin_lint    — the 13-check quality score with per-check evidence
 *   mcskin_render  — multi-view / multi-pose 3D screenshots for visual review
 *
 * plus a `mcskin-artist` skill that teaches the model the pixel-art workflow
 * (plan → lay down colours → lint → render → look → refine).
 *
 * Every tool shells out to the bundled CLI under `bin/`. That CLI is the single
 * source of truth for pixels: it emits pure JSON on stdout, so the tools stay
 * thin translators rather than a second implementation of the rules engine.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "mcskin-artist";
export const inject = ["tools", "skills"];

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIN_CLI = join(PACKAGE_ROOT, "bin", "skin.mjs");
const RENDER_CLI = join(PACKAGE_ROOT, "bin", "render.mjs");
const SKILL_DIR = join(PACKAGE_ROOT, "skills");

/** Ceiling for a lint/inspect run. The rules engine is pure CPU and fast. */
const FAST_TIMEOUT_MS = 60_000;

/** Ceiling for a 3D render: it boots a headless browser and takes WebGL shots. */
const RENDER_TIMEOUT_MS = 300_000;

/** How long to wait for a killed child before escalating to SIGKILL. */
const KILL_GRACE_MS = 5_000;

/* ── output shape ────────────────────────────────────────────────────────── */

/**
 * One JSON object out of every tool.
 *
 * `ok:false` carries a `code` so the model can branch without string matching,
 * and `hint` carries the recovery step. Mirrors the CLI's own error shape.
 */
const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    code: { type: "string" },
    error: { type: "string" },
    hint: { type: "string" },
    skin: { type: "string" },
    skin_path: { type: "string" },
    format: { type: "string" },
    width: { type: "integer" },
    height: { type: "integer" },
    score: { type: "integer" },
    grade: { type: "string" },
    summary: {
      type: "object",
      additionalProperties: false,
      properties: {
        fail: { type: "integer" },
        warn: { type: "integer" },
        info: { type: "integer" },
        pass: { type: "integer" },
      },
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "level", "msg"],
        properties: {
          id: { type: "string" },
          level: { type: "string" },
          msg: { type: "string" },
          evidence: { type: "json" },
        },
      },
    },
    parts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["part", "opaque"],
        properties: {
          part: { type: "string" },
          layer: { type: "string" },
          opaque: { type: "integer" },
          frontDistinctColors: { type: "integer" },
          frontEdgeRatio: { type: "number" },
        },
      },
    },
    palette: {
      type: "object",
      additionalProperties: false,
      properties: {
        distinct: { type: "integer" },
        top: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["hex"],
            properties: {
              hex: { type: "string" },
              count: { type: "integer" },
            },
          },
        },
      },
    },
    totalOpaque: { type: "integer" },
    review_dir: { type: "string" },
    views: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file"],
        properties: {
          file: { type: "string" },
          id: { type: "string" },
          bytes: { type: "integer" },
        },
      },
    },
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file"],
        properties: {
          file: { type: "string" },
          id: { type: "string" },
          bytes: { type: "integer" },
        },
      },
    },
    message: { type: "string" },
  },
};

/* ── process plumbing ────────────────────────────────────────────────────── */

/** Raised when the CLI exits non-zero; carries its JSON error when it sent one. */
class CliError extends Error {
  constructor(code, stderr) {
    super(stderr || code);
    this.name = "CliError";
    this.code = code;
  }
}

/**
 * Run one bundled CLI command and return its stdout.
 *
 * The child is spawned without a shell so paths and colors survive verbatim:
 * PowerShell would otherwise split `9,12,#3f70c8` into an array and treat `#`
 * as a comment. Timeout escalates SIGTERM → SIGKILL so a wedged browser never
 * leaves the tool hanging past its budget.
 */
function runCli(script, args, { timeoutMs = FAST_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new CliError("aborted", "cancelled before dispatch"));
      return;
    }

    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out = [];
    const err = [];
    let settled = false;
    let killTimer = null;
    let timeoutTimer = null;
    let onAbort = null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => finish(rejectPromise, error));

    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code === 0) {
        finish(resolvePromise, stdout);
        return;
      }
      // The CLI prints {"ok":false,"error"} on stdout even when it fails.
      let message = stderr;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && parsed.ok === false) message = parsed.error || message;
      } catch {
        // Not JSON: keep the raw stderr.
      }
      finish(rejectPromise, new CliError("cli-failed", message || `exit ${code}`));
    });

    timeoutTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();

    if (signal) {
      onAbort = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Parse the CLI's pure-JSON stdout, with a clear error when it is not JSON. */
function parseJson(stdout, what) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new CliError("bad-output", `${what} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

/** Resolve a workspace-relative path against the session cwd. */
function resolveInWorkspace(target) {
  return isAbsolute(target) ? target : resolve(process.cwd(), target);
}

/** Turn a thrown value into the tool's result shape, keeping the cause legible. */
function toFailure(error, hint) {
  const code = error instanceof CliError ? error.code : "unexpected";
  return { ok: false, code, error: error?.message ?? String(error), ...(hint ? { hint } : {}) };
}

/* ── shared parameter docs ───────────────────────────────────────────────── */

const SKIN_PARAM = {
  skin: {
    type: "string",
    required: true,
    description: "Path to the skin PNG, absolute or relative to the workspace.",
  },
};

const SKIN_HINT = "Call mcskin_draw with command 'new' first, or pass an existing 64x64/64x32 skin.";

/* ── mcskin_draw ─────────────────────────────────────────────────────────── */

/** Commands that write pixels; used for concurrency and for hint selection. */
const DRAW_COMMANDS = new Set(["new", "convert", "set", "fill", "rect", "line", "mirror-limbs", "run"]);

function drawTool() {
  return defineTool({
    name: "mcskin_draw",
    description: [
      "Draw or modify a Minecraft skin by pixel operations. This is the only tool that writes pixels.",
      "",
      "Commands:",
      "  new           - create a skin. args: size (64|32), template (blank|default). template=default starts from Steve.",
      "  convert       - upgrade a legacy 64x32 skin to modern 64x64.",
      "  set           - set individual pixels. args: pixels, a comma-separated list of 'x,y,#rrggbb' triples.",
      "  fill          - flood-fill a region. args: start ('x,y'), color, optional bounds.",
      "  rect          - filled rectangle, endpoints inclusive. args: rect ('x0,y0,x1,y1'), color, optional outline.",
      "  line          - straight line. args: from ('x0,y0'), to ('x1,y1'), color.",
      "  mirror-limbs  - mirror the right arm/leg onto the left, so both sides match.",
      "  run           - execute a batch script file. args: script (path), out (output skin path).",
      "",
      "Colors accept '#rrggbb', '#rrggbbaa', or 'r,g,b'. Coordinates are a point 'x,y' or a rectangle 'x0,y0,x1,y1'.",
      "For a new skin prefer 'new' then 'run' with a batch script: one run script draws a whole layer far faster",
      "than dozens of single-pixel calls. Use mcskin_inspect pixel first when unsure which part a coordinate belongs to.",
    ].join("\n"),
    parameters: {
      command: {
        type: "string",
        required: true,
        enum: [...DRAW_COMMANDS],
        description: "Which drawing operation to apply.",
      },
      skin: {
        type: "string",
        required: false,
        description:
          "Skin to read (commands that take an input) or to write (new/convert/run). Absolute or workspace-relative.",
      },
      out: {
        type: "string",
        required: false,
        description: "Output path for commands that produce a file (new, convert, run).",
      },
      pixels: {
        type: "string",
        required: false,
        description: "For 'set': comma-separated 'x,y,#rrggbb' triples, e.g. '9,12,#3f70c8,10,12,#3f70c8'.",
      },
      start: { type: "string", required: false, description: "For 'fill': start point as 'x,y'." },
      from: { type: "string", required: false, description: "For 'line': start point as 'x,y'." },
      to: { type: "string", required: false, description: "For 'line': end point as 'x,y'." },
      rect: { type: "string", required: false, description: "For 'rect': 'x0,y0,x1,y1', both endpoints inclusive." },
      color: { type: "string", required: false, description: "Fill color: '#rrggbb', '#rrggbbaa', or 'r,g,b'." },
      outline: {
        type: "string",
        required: false,
        description: "For 'rect': optional border color drawn around the rectangle.",
      },
      bounds: {
        type: "string",
        required: false,
        description: "For 'fill': region name to confine the flood to the current face, e.g. 'head-front'.",
      },
      script: {
        type: "string",
        required: false,
        description: "For 'run': path to a batch script file. One drawing command per line; '#' starts a comment.",
      },
      size: {
        type: "integer",
        required: false,
        description: "For 'new': 64 for the modern format (default), 32 for legacy.",
      },
      template: {
        type: "string",
        required: false,
        enum: ["blank", "default"],
        description: "For 'new': 'blank' starts empty (default), 'default' starts from a Steve skin.",
      },
      include_outer: {
        type: "boolean",
        required: false,
        description: "For 'mirror-limbs': also mirror the outer sleeve/pants layers.",
      },
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    // Any mutating command must not overlap another write to the same skin.
    isConcurrencySafe: (args) => !DRAW_COMMANDS.has(args.command),
    async execute(args, exec) {
      try {
        const argv = [args.command];
        const writesFile = args.command === "new" || args.command === "convert" || args.command === "run";

        if (args.command === "new") {
          if (args.size !== undefined) argv.push("--size", String(args.size));
          if (args.template !== undefined) argv.push("--template", args.template);
          argv.push("-o", args.out ?? args.skin ?? "skin.png");
        } else if (args.command === "convert") {
          argv.push(args.skin ?? "", "-o", args.out ?? args.skin);
        } else if (args.command === "run") {
          if (args.script === undefined) {
            return { ok: false, code: "missing-argument", error: "command 'run' requires the script argument" };
          }
          argv.push(args.script, args.skin ?? "skin.png", "-o", args.out ?? args.skin ?? "skin.png");
        } else {
          // The remaining commands mutate the input skin in place.
          if (args.skin === undefined) {
            return { ok: false, code: "missing-argument", error: `command '${args.command}' requires the skin argument` };
          }
          argv.push(args.skin);
          if (args.pixels !== undefined) argv.push(args.pixels);
          if (args.start !== undefined) argv.push(args.start);
          if (args.from !== undefined) argv.push(args.from);
          if (args.to !== undefined) argv.push(args.to);
          if (args.rect !== undefined) argv.push(args.rect);
          if (args.color !== undefined) argv.push(args.color);
          if (args.outline !== undefined) argv.push("--outline", args.outline);
          if (args.bounds !== undefined) argv.push("--bounds", args.bounds);
          if (args.include_outer === true) argv.push("--include-outer");
        }

        const stdout = await runCli(SKIN_CLI, argv, { signal: exec?.signal });
        const parsed = parseJson(stdout, `mcskin_draw ${args.command}`);
        const produced = args.out ?? args.skin;
        return {
          ok: true,
          skin: args.command,
          ...(produced === undefined ? {} : { skin_path: resolveInWorkspace(produced) }),
          ...(parsed.format === undefined ? {} : { format: parsed.format }),
          ...(parsed.w === undefined ? {} : { width: parsed.w }),
          ...(parsed.h === undefined ? {} : { height: parsed.h }),
          message: describeDraw(args.command, parsed, produced),
        };
      } catch (error) {
        return toFailure(error, SKIN_HINT);
      }
    },
  });
}

/** One human-readable line describing what a draw command actually did. */
function describeDraw(command, parsed, out) {
  const where = out ? ` -> ${out}` : "";
  switch (command) {
    case "new":
      return `Created a ${parsed.w}x${parsed.h} ${parsed.format} skin${where}.`;
    case "convert":
      return `Converted the legacy skin to the modern 64x64 format${where}.`;
    case "run":
      return `Applied the batch script${where}${parsed.applied ? ` (${parsed.applied} operations)` : ""}.`;
    default:
      return `Applied '${command}'${where}.`;
  }
}

/* ── mcskin_inspect ──────────────────────────────────────────────────────── */

function inspectTool() {
  return defineTool({
    name: "mcskin_inspect",
    description: [
      "Inspect a skin without changing it. Use this to answer 'what is on this skin?' and to find coordinates.",
      "",
      "Commands:",
      "  info    - size, format, opaque pixel count, which parts have content.",
      "  pixel   - the color and owning part/face/layer at one coordinate. args: at ('x,y'). Use this before drawing an unfamiliar coordinate.",
      "  palette - color statistics, to check the palette has not ballooned. args: limit.",
      "  parts   - per-part opaque counts, distinct front colors and edge ratio.",
      "  crops   - write magnified texture crops for visual review. args: out (directory), scale.",
      "",
      "'pixel' is the reliable way to learn the UV layout: ask where a coordinate lands instead of guessing.",
    ].join("\n"),
    parameters: {
      command: {
        type: "string",
        required: true,
        enum: ["info", "pixel", "palette", "parts", "crops"],
        description: "Which report to produce.",
      },
      skin: { ...SKIN_PARAM.skin },
      at: {
        type: "string",
        required: false,
        description: "For 'pixel': the coordinate to probe, as 'x,y'.",
      },
      limit: {
        type: "integer",
        required: false,
        description: "For 'palette': how many top colors to list. Default 30.",
      },
      out: {
        type: "string",
        required: false,
        description: "For 'crops': output directory for the magnified crops.",
      },
      scale: {
        type: "integer",
        required: false,
        description: "For 'crops': magnification factor. Default 8.",
      },
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const argv = [args.command, args.skin];
        if (args.command === "pixel") {
          if (args.at === undefined) {
            return { ok: false, code: "missing-argument", error: "command 'pixel' requires the at argument" };
          }
          argv.push(args.at);
        }
        if (args.command === "palette" && args.limit !== undefined) argv.push("--limit", String(args.limit));
        if (args.command === "crops") {
          argv.push("-o", args.out ?? args.skin.replace(/\.png$/i, ".crops"));
          if (args.scale !== undefined) argv.push("--scale", String(args.scale));
        }

        const stdout = await runCli(SKIN_CLI, argv, { signal: exec?.signal });
        const parsed = parseJson(stdout, `mcskin_inspect ${args.command}`);
        return {
          ok: true,
          skin: args.command,
          skin_path: resolveInWorkspace(args.skin),
          ...(parsed.format === undefined ? {} : { format: parsed.format }),
          ...(parsed.w === undefined ? {} : { width: parsed.w }),
          ...(parsed.h === undefined ? {} : { height: parsed.h }),
          ...(parsed.opaque === undefined ? {} : { totalOpaque: parsed.opaque }),
          ...(parsed.palette === undefined ? {} : { palette: parsed.palette }),
          ...(parsed.parts === undefined ? {} : { parts: parsed.parts }),
          ...(parsed.files === undefined ? {} : { images: parsed.files }),
          message: describeInspect(args.command, parsed, args),
        };
      } catch (error) {
        return toFailure(error, SKIN_HINT);
      }
    },
  });
}

/** One human-readable line describing an inspect report. */
function describeInspect(command, parsed, args) {
  switch (command) {
    case "info":
      return `${parsed.w}x${parsed.h} ${parsed.format}, ${parsed.opaque ?? 0} opaque pixels, ${parsed.partsPainted ?? 0} parts painted.`;
    case "pixel": {
      const where = parsed.part === undefined ? "" : ` (${parsed.part}${parsed.face ? ` / ${parsed.face}` : ""})`;
      return `(${args.at}) = ${parsed.color ?? "transparent"}${where}`;
    }
    case "palette":
      return `${parsed.distinct ?? 0} distinct colors.`;
    case "parts":
      return `${parsed.parts?.length ?? 0} parts reported.`;
    case "crops":
      return `Wrote ${parsed.files?.length ?? 0} magnified crops to ${args.out ?? args.skin}.`;
    default:
      return `Inspect '${command}' complete.`;
  }
}

/* ── mcskin_lint ─────────────────────────────────────────────────────────── */

function lintTool() {
  return defineTool({
    name: "mcskin_lint",
    description: [
      "Score a skin on 13 programmatic quality checks and return a 0-100 grade (A/B/C/D).",
      "",
      "This is the objective half of skin review: it catches flat colour areas, an unused outer layer, palette",
      "bloat, stray noise, left/right imbalance and legacy format. Each failing or warning check carries `evidence`",
      "with the exact coordinates or counts to fix, so act on the evidence rather than guessing.",
      "",
      "Ship only when fail === 0, warn <= 2 and grade is A. A high score with no visual review is not a finished skin:",
      "pair this with mcskin_render and actually look at the images.",
    ].join("\n"),
    parameters: { skin: { ...SKIN_PARAM.skin } },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const stdout = await runCli(SKIN_CLI, ["lint", args.skin], { signal: exec?.signal });
        const parsed = parseJson(stdout, "mcskin_lint");
        return {
          ok: true,
          skin: "lint",
          skin_path: resolveInWorkspace(args.skin),
          score: parsed.score,
          grade: parsed.grade,
          summary: parsed.summary,
          checks: parsed.checks,
          ...(parsed.palette === undefined ? {} : { palette: parsed.palette }),
          ...(parsed.parts === undefined ? {} : { parts: parsed.parts }),
          message: `Score ${parsed.score}/100 (grade ${parsed.grade}): ${parsed.summary?.fail ?? 0} fail, ${parsed.summary?.warn ?? 0} warn, ${parsed.summary?.pass ?? 0} pass.`,
        };
      } catch (error) {
        return toFailure(error, SKIN_HINT);
      }
    },
  });
}

/* ── mcskin_render ───────────────────────────────────────────────────────── */

function renderTool() {
  return defineTool({
    name: "mcskin_render",
    description: [
      "Render a skin to PNGs for visual review: 8 camera angles (front, back, both sides, two 3/4 views,",
      "top, bottom) and 4 deterministic pose frames (idle, two walk frames, wave), plus magnified texture crops.",
      "",
      "Then OPEN the returned files with your image-reading tool and actually look at them. This is the half of review",
      "lint cannot do: it catches a face that reads wrong, a hair layer that lost depth, a flat-textured back, or a",
      "texture seam that only shows up when the arm swings.",
      "",
      "Returns a directory containing views/, poses/ and texture/. On a host without WebGL the views may be missing;",
      "the texture crops still work, and the message will say so.",
    ].join("\n"),
    parameters: {
      skin: { ...SKIN_PARAM.skin },
      out: {
        type: "string",
        required: false,
        description: "Review output directory. Defaults to <skin>.review next to the skin.",
      },
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    // Rendering boots a browser: never run two at once.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const argv = [args.skin, "-o", args.out ?? args.skin.replace(/\.png$/i, "") + ".review"];
        const stdout = await runCli(RENDER_CLI, argv, { timeoutMs: RENDER_TIMEOUT_MS, signal: exec?.signal });
        const parsed = parseJson(stdout, "mcskin_render");
        const views = parsed.views ?? [];
        const poses = parsed.poses ?? [];
        const texture = parsed.texture ?? [];
        const notes = [];
        if (parsed.errors?.length > 0) {
          notes.push(`renderer reported: ${parsed.errors.join("; ")}`);
        }
        if (views.length === 0 && texture.length > 0) {
          notes.push("no 3D views were produced (headless WebGL likely unavailable); review the texture crops instead");
        }
        notes.push("open these images and describe what you see before changing anything");
        return {
          ok: true,
          skin: "render",
          skin_path: resolveInWorkspace(args.skin),
          format: parsed.format,
          review_dir: parsed.out,
          views,
          images: [...views, ...poses, ...texture],
          message: `Rendered ${views.length} views, ${poses.length} poses and ${texture.length} texture crops to ${parsed.out}. ${notes.join(". ")}.`,
        };
      } catch (error) {
        return toFailure(
          error,
          "3D review needs a headless browser with WebGL. If it is unavailable, the failure is environmental, not a bad skin.",
        );
      }
    },
  });
}

/* ── rendering ───────────────────────────────────────────────────────────── */

/**
 * Default renderer for every tool result.
 *
 * The CLI already reports the decisive numbers, so this stays short and puts
 * the paths first: those are what the model needs in order to look at the work.
 */
function renderResult(_args, value) {
  if (value.ok === false) {
    const lines = [`${value.code ?? "failed"}: ${value.error ?? "unknown error"}`];
    if (value.hint !== undefined) lines.push(`Hint: ${value.hint}`);
    return [{ type: "text", text: lines.join("\n") }];
  }

  const lines = [];
  if (value.message !== undefined) lines.push(value.message);

  // Surface the actionable part of a lint report: only non-passing checks.
  if (value.checks !== undefined) {
    const problems = value.checks.filter((check) => check.level === "fail" || check.level === "warn");
    if (problems.length > 0) {
      lines.push("");
      lines.push("Needs work:");
      for (const check of problems) {
        const evidence = check.evidence === undefined ? "" : ` ${JSON.stringify(check.evidence)}`;
        lines.push(`  [${check.level}] ${check.id}: ${check.msg}${evidence}`);
      }
    }
  }

  const paths = [];
  if (value.skin_path !== undefined) paths.push(value.skin_path);
  if (value.review_dir !== undefined) paths.push(value.review_dir);
  for (const image of value.images ?? []) paths.push(join(value.review_dir ?? "", image.file));
  if (paths.length > 0) {
    lines.push("");
    for (const path of paths) lines.push(path);
  }

  return [{ type: "text", text: lines.join("\n") }];
}

/* ── skill ───────────────────────────────────────────────────────────────── */

/** The bundled skill, loaded lazily so a missing file cannot break plugin load. */
function loadSkill() {
  const path = join(SKILL_DIR, "SKILL.md");
  const body = readFileSync(path, "utf8");
  return {
    name: "mcskin-artist",
    description:
      "Draw, review and iterate on Minecraft skins (64x64 / 64x32) end to end with the mcskin_* tools: batch pixel " +
      "drawing, programmatic lint scoring, and multi-view multi-pose 3D screenshot review. Use when the user asks to " +
      "draw or design a Minecraft skin, review or score one, fix a skin's colours or shading, or preview a skin from " +
      "several angles.",
    whenToUse:
      "The user wants a Minecraft skin created, drawn, reviewed, scored, iterated on, or previewed in 3D.",
    content: body,
  };
}

/* ── plugin entry ────────────────────────────────────────────────────────── */

/** Plugin entry. Registers the tools and the skill inside one effect scope. */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [];

    if (ctx.tools !== undefined) {
      for (const tool of [drawTool(), inspectTool(), lintTool(), renderTool()]) {
        disposers.push(ctx.tools.register(tool));
      }
    }

    if (ctx.skills !== undefined && existsSync(SKILL_DIR)) {
      try {
        disposers.push(ctx.skills.register(loadSkill()));
      } catch (error) {
        // A malformed skill must not take the tools down with it.
        console.error("[mcskin-artist] skill registration failed:", error);
      }
    }

    return () => {
      for (const dispose of disposers.splice(0)) dispose();
    };
  }, "mcskin-artist: tools and skill");
}
