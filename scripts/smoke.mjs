/**
 * Smoke test for dsh-mcskin-artist.
 *
 * Runs the four tools against a real temporary workspace, using the same call
 * shape the Host uses. It imports the plugin's tool factories through a fake
 * `ctx`, so it exercises the real defineTool validation, the real CLI
 * subprocesses and the real renderer.
 *
 * Usage: node scripts/smoke.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

/**
 * Import the plugin with a stub for the Host-only `defineTool` dependency.
 *
 * `@deepseek-ai/dsh-tools` only exists inside a real DSH Host, so a plain
 * checkout cannot import `lib/index.js` directly. Writing a rewritten copy next
 * to it (rather than a data: URL) keeps `import.meta.url` a real file URL, which
 * the plugin needs to locate its bundled `bin/` and `skills/`.
 */
async function loadPlugin() {
  const entry = new URL("../lib/index.js", import.meta.url);
  const stub = `
    export function defineTool(options) {
      const parameters = { type: "object", properties: {}, required: [] };
      for (const [key, spec] of Object.entries(options.parameters ?? {})) {
        parameters.properties[key] = { type: spec.type };
        if (spec.required === true) parameters.required.push(key);
      }
      if (parameters.required.length === 0) delete parameters.required;
      return {
        name: options.name,
        description: options.description,
        parameters,
        output: options.output,
        ...(options.isConcurrencySafe ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
        async execute(args, exec) { return options.execute(args, exec); },
      };
    }
  `;
  const source = readFileSync(entry, "utf8").replace(
    /^import \{ defineTool \} from "@deepseek-ai\/dsh-tools";$/m,
    stub,
  );
  const mirror = new URL("../lib/.smoke-entry.mjs", import.meta.url);
  writeFileSync(mirror, source);
  try {
    return await import(mirror.href);
  } finally {
    rmSync(mirror, { force: true });
  }
}

/** Collect the tools and skill a plugin registers against a fake ctx. */
function fakeCtx() {
  const tools = new Map();
  const skills = [];
  let effectDispose = null;
  const ctx = {
    effect(run) {
      effectDispose = run();
    },
    tools: { register: (tool) => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    skills: { register: (skill) => (skills.push(skill), () => {}) },
  };
  return {
    ctx,
    tools,
    skills,
    dispose: () => effectDispose?.(),
  };
}

const plugin = await loadPlugin();
const harness = fakeCtx();
plugin.apply(harness.ctx);

const workspace = mkdtempSync(join(tmpdir(), "mcskin-smoke-"));
const cwd = process.cwd();
process.chdir(workspace);

const skin = "skin.png";
const run = (name, args, exec) => harness.tools.get(name).execute(args, exec);
const draw = (args) => run("mcskin_draw", args);
const inspect = (args) => run("mcskin_inspect", args);
const lint = (args) => run("mcskin_lint", args);
const render = (args) => run("mcskin_render", args);

try {
  /* ── registration ─────────────────────────────────────────────────────── */

  check("registers four tools", () => {
    assert.deepEqual(
      [...harness.tools.keys()].sort(),
      ["mcskin_draw", "mcskin_inspect", "mcskin_lint", "mcskin_render"],
    );
  });

  check("registers the mcskin-artist skill", () => {
    assert.equal(harness.skills.length, 1);
    assert.equal(harness.skills[0].name, "mcskin-artist");
    assert.ok(harness.skills[0].content.length > 500, "skill body should carry the workflow");
  });

  check("every tool declares a name, description and output renderer", () => {
    for (const tool of harness.tools.values()) {
      assert.ok(tool.name.startsWith("mcskin_"));
      assert.ok((tool.description?.length ?? 0) > 80, `${tool.name} needs a real description`);
      assert.equal(typeof tool.output?.render, "function", `${tool.name} needs output.render`);
    }
  });

  /* ── drawing ──────────────────────────────────────────────────────────── */

  const created = await draw({ command: "new", out: skin, size: 64, template: "blank" });
  check("mcskin_draw new creates a 64x64 skin", () => {
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.width, 64);
    assert.equal(created.height, 64);
    assert.equal(created.format, "modern");
  });

  check("mcskin_draw reports a missing argument instead of throwing", async () => {
    const result = await draw({ command: "run" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "missing-argument");
  });

  // A batch script is how the skill expects real skins to be drawn.
  const script = [
    "# smoke: lay down a readable base",
    "rect 8,8,15,15,#e8b48a",
    "rect 8,8,15,10,#6b4a2f",
    "rect 20,20,27,31,#3f8f5f",
    "rect 16,20,19,31,#34774f",
    "rect 44,20,47,24,#3f8f5f",
    "rect 44,25,47,31,#e8b48a",
    "rect 4,20,7,27,#4a5a78",
    "rect 4,28,7,31,#6b6b73",
    "mirror-limbs",
    "",
  ].join("\n");
  writeFileSync("r1.txt", script);

  const ran = await draw({ command: "run", script: "r1.txt", skin, out: skin });
  check("mcskin_draw run applies a batch script", () => {
    assert.equal(ran.ok, true, JSON.stringify(ran));
  });

  const pixel = await inspect({ command: "pixel", skin, at: "10,9" });
  check("mcskin_inspect pixel resolves colour and part", () => {
    assert.equal(pixel.ok, true, JSON.stringify(pixel));
    assert.match(String(pixel.message), /head|#|transparent/i);
  });

  const info = await inspect({ command: "info", skin });
  check("mcskin_inspect info reports dimensions and coverage", () => {
    assert.equal(info.ok, true);
    assert.equal(info.width, 64);
    assert.ok(info.totalOpaque > 0, "a drawn skin must have opaque pixels");
  });

  /* ── lint ─────────────────────────────────────────────────────────────── */

  const report = await lint({ skin });
  check("mcskin_lint returns a score, grade and checks", () => {
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(typeof report.score, "number");
    assert.ok(["A", "B", "C", "D"].includes(report.grade), `unexpected grade ${report.grade}`);
    assert.equal(report.checks.length, 13, "the rules engine ships 13 checks");
  });

  check("mcskin_lint summary counts add up", () => {
    const s = report.summary;
    assert.equal(s.fail + s.warn + s.info + s.pass, report.checks.length);
  });

  const rendered = harness.tools.get("mcskin_lint").output.render({}, report)[0].text;
  check("lint render output surfaces non-passing checks", () => {
    const text = rendered;
    assert.match(text, /Score \d+\/100/);
    // Only fail/warn are actionable; `info` and `pass` are deliberately omitted.
    const actionable = report.checks.filter((c) => c.level === "fail" || c.level === "warn");
    for (const check of actionable) {
      assert.ok(text.includes(check.id), `render should mention ${check.id}`);
    }
    for (const quiet of report.checks.filter((c) => c.level === "pass" || c.level === "info")) {
      assert.ok(!text.includes(quiet.id), `render should not pad the output with ${quiet.id}`);
    }
  });

  /* ── failure paths ────────────────────────────────────────────────────── */

  const missing = await lint({ skin: "does-not-exist.png" });
  check("lint on a missing file fails cleanly", () => {
    assert.equal(missing.ok, false);
    assert.ok(missing.error, "must explain the failure");
  });

  /* ── render ───────────────────────────────────────────────────────────── */

  const shots = await render({ skin, out: "skin.review" });
  check("mcskin_render produces review images", () => {
    assert.equal(shots.ok, true, JSON.stringify(shots));
    assert.ok(shots.images.length > 0, "expected at least texture crops");
    assert.ok(shots.review_dir, "expected a review directory");
  });

  check("render advertises that the images must be opened", () => {
    assert.match(shots.message, /open these images/i);
  });

  /* ── concurrency policy ───────────────────────────────────────────────── */

  check("draw is concurrency-unsafe, the rest are safe", () => {
    assert.equal(harness.tools.get("mcskin_draw").isConcurrencySafe({ command: "set" }), false);
    assert.equal(harness.tools.get("mcskin_lint").isConcurrencySafe({}), true);
    assert.equal(harness.tools.get("mcskin_inspect").isConcurrencySafe({}), true);
    assert.equal(harness.tools.get("mcskin_render").isConcurrencySafe({}), false);
  });

  /* ── teardown ─────────────────────────────────────────────────────────── */

  check("dispose unregisters every tool", () => {
    harness.dispose();
    assert.equal(harness.tools.size, 0);
  });
} finally {
  process.chdir(cwd);
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}:\n${failure.error.stack}`);
  process.exit(1);
}
