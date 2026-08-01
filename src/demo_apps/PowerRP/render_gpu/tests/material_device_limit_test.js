/**
 * THE DEVICE-CAPABILITY GATE for materials — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/material_device_limit_test.js
 *
 * WHY THIS EXISTS. `RuntimeEffect.Make` and `makeShaderWithChildren` only build
 * Skia objects. **The GL program is linked at DRAW time inside Ganesh, and a
 * driver that refuses it makes Skia DROP THE DRAW and return normally** — no
 * exception, no null, no console line. So paint_skia's three `if (!shader) throw`
 * guards cannot fire for a capability overrun, and any material past a device
 * limit renders as NOTHING. core/paint_containment.js calls a failure the user
 * cannot even see "the quietest failure of all"; this is one.
 *
 * WHY IT IS A BARE-NODE TEST AND NOT A BROWSER PROBE. **The defect is invisible
 * on this machine.** Measured with `.frenzy/round6/scratchpad_W4S_glcap.mjs`:
 * this host's WebGL2 reports MAX_FRAGMENT_UNIFORM_VECTORS = 4096, and even a
 * deliberately over-limit shader reported COMPILE_STATUS true. Nothing we ship
 * can exceed 4096, so a probe here would pass on a broken build forever. The
 * decision therefore had to be a PURE FUNCTION of (material, ceiling), which can
 * be handed any ceiling — including the ones real hardware has.
 *
 * THE NUMBERS ARE REAL, not invented for the test: `mandelbrot` declares 574
 * uniform rows, WebGL2's SPEC MINIMUM is 224, and web3dsurvey's distribution is a
 * step function at 256 (100% of devices) then 1024 (95%) — all documented at
 * mandelbrot_shader.js MANDELBROT_UNIFORM_ROW_BUDGET. So mandelbrot is genuinely
 * unrenderable on a conformant low-end device, and that device is the one that
 * used to get a blank rectangle.
 *
 * WHAT IT PROVES:
 *   (1) the cost of EVERY registered material is knowable — declared where it is
 *       measured, derived from the packed footprint where it is not, so absence
 *       of a declaration is not a blind spot;
 *   (2) a DECLARED cost may never sit below the derived floor — the check that
 *       catches mandelbrot's declaration rotting when someone changes REF_LEN;
 *   (3) any material big enough to matter DECLARES an exact figure rather than
 *       relying on the under-estimating floor;
 *   (4) the refusal fires at the real thresholds and, crucially, NEVER fires when
 *       no ceiling is known — the node/CLI path must stay byte-identical;
 *   (5) the sentence is composed for the ONE existing voice
 *       (core/paint_containment.js errorMessage), not a second dialect;
 *   (6) END TO END on a real software Skia surface, through the real painter, for
 *       BOTH handlers: a refused material paints the RED CONTAINMENT BOX and
 *       names itself on the console, where before it painted nothing and said
 *       nothing. Proven by PIXELS — a source grep cannot tell a check that runs
 *       from a check that is merely spelled correctly;
 *   (7) and browser_surface.js — the only module that can see a GL context —
 *       actually queries the limit and passes it. Without (7) the whole mechanism
 *       is inert in the app while every other check here still passes. This one
 *       IS asserted against source text, because a bare-node test cannot
 *       construct a WebGL2 canvas.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  materialIds, getMaterial, materialUniformRows, materialUnavailableReason,
  materialFillParamDefaults, WEBGL2_MIN_FRAGMENT_UNIFORM_VECTORS,
} from "../skia/materials.js";
import { errorMessage, errorAffordanceArgs } from "../../core/paint_containment.js";
import { materialFill, materialBackdrop, rect } from "../ir.js";
import { renderToPng } from "../skia/node_render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKIA_FIXED_ROWS = 4; // sk_RTAdjust (1) + umatrix mat3 (3) — mirrored from materials.js for an INDEPENDENT floor
const BOX = 200; // the square the end-to-end scene renders into, device px
const REGION = { cx: BOX / 2, cy: BOX / 2, halfW: BOX / 2, halfH: BOX / 2, cornerRadius: 0 }; // the material covers the whole box
const CHANNEL_TOLERANCE = 2 / 255; // PNG round-trip quantization; a colour match need not be bit-exact

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Query. Does this encoded PNG contain a pixel of (approximately) this colour?
 *  Decoded through CanvasKit, the glass_outline_test.js precedent — the renderer
 *  is already a CanvasKit consumer, so no second image library enters the tree.
 *  @example // await hasPixel(png, 1, 0, 0) — true when anything red was drawn
 */
async function hasPixel(png, r, g, b) {
  const { default: CKInit } = await import("canvaskit-wasm");
  const CanvasKit = await CKInit();
  const img = CanvasKit.MakeImageFromEncoded(png);
  if (!img) throw new Error("hasPixel: could not decode the render");
  const raw = new Uint8Array(img.readPixels(0, 0, {
    width: img.width(), height: img.height(), colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB,
  }));
  img.delete();
  for (let i = 0; i < raw.length; i += 4)
    if (Math.abs(raw[i] / 255 - r) <= CHANNEL_TOLERANCE
      && Math.abs(raw[i + 1] / 255 - g) <= CHANNEL_TOLERANCE
      && Math.abs(raw[i + 2] / 255 - b) <= CHANNEL_TOLERANCE) return true;
  return false;
}

/** Query. Reads a shipped source file as text, for the checks that must assert
 *  about a module no bare-node test can execute (browser_surface needs a canvas). */
function source(rel) {
  return fs.readFileSync(path.join(HERE, "..", rel), "utf8");
}

/** Pure function. The floor this test derives INDEPENDENTLY of materials.js, so a
 *  bug in materialUniformRows cannot make its own check vacuous.
 *  @example derivedFloor({uniformFloats: 368}) // 96
 */
function derivedFloor(material) {
  if (!Number.isFinite(material?.uniformFloats)) return 0;
  return Math.ceil(material.uniformFloats / 4) + SKIA_FIXED_ROWS;
}

// ── (1) every material's cost is knowable ─────────────────────────────────────

await test("EVERY registered material has a knowable uniform cost — declared or derived", () => {
  const ids = materialIds();
  assert.ok(ids.length > 15, `expected the full material registry, got ${ids.length}`);
  for (const id of ids) {
    const rows = materialUniformRows(getMaterial(id));
    assert.ok(Number.isInteger(rows) && rows >= 0, `${id}: uniform rows must be a non-negative integer, got ${rows}`);
  }
});

await test("a SAMPLER / PATTERN material costs 0 — it runs no SkSL, so no driver can refuse it", () => {
  // magnify dispatches an op and vector_pattern tiles a picture shader; neither
  // compiles a runtime effect, so neither may ever be refused for uniform rows.
  for (const id of ["magnify", "vector_pattern"]) {
    assert.equal(materialUniformRows(getMaterial(id)), 0, id);
    assert.equal(materialUnavailableReason(getMaterial(id), 1), null, `${id} must survive any ceiling`);
  }
});

// ── (2) a declaration may not rot below its own floor ─────────────────────────

await test("a DECLARED uniformRows may never be BELOW the derived floor", () => {
  // The floor under-estimates (GLSL ES packs scalars into earlier rows' gaps), so
  // declared < floor is provably wrong — it is what a stale declaration looks like
  // after someone raises an array length. mandelbrot: declared 574, floor 549.
  for (const id of materialIds()) {
    const m = getMaterial(id);
    if (!Number.isFinite(m.uniformRows)) continue;
    assert.ok(m.uniformRows >= derivedFloor(m),
      `${id}: declares ${m.uniformRows} rows but its packed footprint needs at least ${derivedFloor(m)} — the declaration is stale`);
  }
});

// ── (3) anything big enough to matter must declare ────────────────────────────

await test("a material whose FLOOR reaches the WebGL2 spec minimum must DECLARE an exact cost", () => {
  // Above the spec minimum a conformant device can legitimately refuse the
  // program, so the framework needs the exact number rather than an
  // under-estimate. Below it, the floor is good enough and no declaration is
  // required — metaballs (the runner-up, 96 rows) deliberately has none.
  for (const id of materialIds()) {
    const m = getMaterial(id);
    if (derivedFloor(m) < WEBGL2_MIN_FRAGMENT_UNIFORM_VECTORS) continue;
    assert.ok(Number.isFinite(m.uniformRows),
      `${id}: its packed footprint alone is ${derivedFloor(m)} rows, past WebGL2's ${WEBGL2_MIN_FRAGMENT_UNIFORM_VECTORS}-vector spec minimum, so it must declare an exact uniformRows (the floor under-estimates and would miss a real refusal)`);
  }
  assert.ok(Number.isFinite(getMaterial("mandelbrot").uniformRows), "mandelbrot is the material this rule exists for");
});

// ── (4) the refusal fires at the real thresholds, and never without a ceiling ──

await test("the refusal is decided by the real numbers, at the real thresholds", () => {
  const mandelbrot = getMaterial("mandelbrot");
  const rows = materialUniformRows(mandelbrot);
  assert.equal(materialUnavailableReason(mandelbrot, rows), null, "exactly at the ceiling is renderable");
  assert.ok(materialUnavailableReason(mandelbrot, rows - 1), "one row over is not");
  assert.ok(materialUnavailableReason(mandelbrot, WEBGL2_MIN_FRAGMENT_UNIFORM_VECTORS),
    "and a spec-minimum device genuinely cannot run it — this is the case that used to draw nothing");
});

await test("NO CEILING KNOWN ⇒ NO REFUSAL — the node/CLI path must stay byte-identical", () => {
  // cli/render.js and every node test render on a software surface with no GL
  // context to ask. If absence of a ceiling refused anything, this change would
  // have silently broken headless rendering for every material at once.
  for (const id of materialIds())
    assert.equal(materialUnavailableReason(getMaterial(id), Infinity), null, id);
});

// ── (5) one voice ─────────────────────────────────────────────────────────────

await test("the sentence composes into the EXISTING failure voice, not a second dialect", () => {
  const reason = materialUnavailableReason(getMaterial("mandelbrot"), WEBGL2_MIN_FRAGMENT_UNIFORM_VECTORS);
  // errorMessage(who, what) is what the per-node paint boundary already puts on
  // the red box for every other unpaintable widget. The reason must read as its
  // `what` clause — lower-case, no leading capital, no trailing period.
  assert.match(reason, /^[a-z]/, "a clause, not a sentence");
  assert.ok(!reason.endsWith("."), "no trailing period — errorMessage supplies the punctuation");
  const composed = errorMessage("Mandelbrot (mandelbrot)", reason);
  assert.ok(composed.includes("Mandelbrot (mandelbrot)"), "the ITEM is named");
  assert.ok(composed.includes("uniform rows"), "and so is the cause");
});

// ── (6) the mechanism is actually wired — without this the rest is inert ──────

/** Query. The uniform params a material's own schema defaults produce — the
 *  scene an author gets by dropping the material on a shape with nothing tweaked. */
function defaultParams(id) {
  const m = getMaterial(id);
  const d = materialFillParamDefaults(m);
  return m.toUniformParams ? m.toUniformParams(d) : d;
}

/** Query. Renders `scene` twice on a software Skia surface — once with no
 *  ceiling, once one row BELOW the material's cost — capturing console.error.
 *  Returns {allowed, refused, errors}. */
async function renderAtBothCeilings(scene, materialId) {
  const view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
  const opts = { width: BOX, height: BOX, background: "#ffffff" };
  const justUnder = materialUniformRows(getMaterial(materialId)) - 1;
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  try {
    const allowed = await renderToPng(scene, view, opts);
    const refused = await renderToPng(scene, view, { ...opts, maxUniformRows: justUnder });
    return { allowed, refused, errors };
  } finally { console.error = realError; }
}

/** Command (asserts). The whole claim of #188, for one scene: a refused material
 *  paints the RED BOX and says why, instead of painting nothing and saying nothing. */
async function assertRefusalIsLoud(scene, materialId, label) {
  const { allowed, refused, errors } = await renderAtBothCeilings(scene, materialId);
  // (a) the frame survived — the per-node paint boundary contained it.
  assert.ok(refused.length > 0, `${label}: the refused render still produced a frame`);
  // (b) the picture CHANGED, which is the whole claim: not a silently blank widget.
  assert.notDeepEqual(Buffer.from(refused), Buffer.from(allowed), `${label}: a refusal must change the pixels`);
  // (c) and what changed is the containment box, identified by its own fill colour.
  const [r, g, b] = errorAffordanceArgs(BOX, BOX, "x").rect.fill;
  assert.ok(await hasPixel(refused, r, g, b), `${label}: the error box's fill colour is on the canvas`);
  assert.ok(!(await hasPixel(allowed, r, g, b)), `${label}: and is NOT there when the material is allowed`);
  // (d) the console carried the cause — loud, not merely visible.
  assert.ok(errors.some((e) => e.includes("uniform rows") && e.includes(materialId)),
    `${label}: the console must name the material and the cause; got ${JSON.stringify(errors)}`);
}

await test("END TO END, materialFill: a refused material paints the RED BOX, not nothing", async () => {
  // Rendered through the REAL painter on a software surface. A source grep cannot
  // tell a check that runs from a check that is merely spelled correctly.
  //
  // `metal` and not `mandelbrot`, deliberately: mandelbrot is the material whose
  // REAL cost exceeds real hardware (574 rows — asserted against the real
  // thresholds in the pure checks above), but it is also per-pixel deep-zoom
  // iteration, which on this software surface costs minutes per frame. The code
  // path is identical for every shader-backed material, so the behavioural half
  // uses the cheapest one and drops the ceiling to it instead.
  await assertRefusalIsLoud(
    [materialFill({ material: "metal", ...REGION, params: defaultParams("metal") })],
    "metal", "materialFill");
});

await test("END TO END, materialBackdrop: the OTHER handler fails the same way", async () => {
  // Both handlers, both proven by pixels rather than by counting call sites.
  // A backdrop needs something beneath it to sample, hence the rect.
  await assertRefusalIsLoud(
    [rect({ x: 0, y: 0, w: BOX, h: BOX, fill: "#3355aa" }),
      materialBackdrop({ material: "crt", ...REGION, blurRadius: 0, backdropScale: 1, params: defaultParams("crt") })],
    "crt", "materialBackdrop");
});

await test("browser_surface QUERIES the limit and PASSES it — the one module that can see a GL context", () => {
  // Asserted against source text because a bare-node test cannot construct a
  // WebGL2 canvas, and because this is precisely the wire that, if left
  // unconnected, leaves every other check in this file green and the app blind.
  const src = source("skia/browser_surface.js");
  assert.match(src, /MAX_FRAGMENT_UNIFORM_VECTORS/, "must query the limit");
  assert.match(src, /this\.maxUniformRows/, "must keep it per-instance, beside maxDim");
  assert.match(src, /paintIR\([^)]*maxUniformRows: this\.maxUniformRows/s, "must pass it into paintIR");
});

console.log(`\n${passed} material device-limit tests passed.`);
