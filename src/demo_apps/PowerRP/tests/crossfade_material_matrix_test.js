/**
 * CROSSFADE × MATERIAL matrix gate (bare node) — WORKSTREAM AC, extended by AJ.
 *
 * TWO SECTIONS, because there are TWO resolution seams. The matrix proper covers
 * an OP's paint slots (resolveMaterialFillPaints); the BACKGROUND section at the
 * bottom covers the camera background (resolvedBackgroundFill), which is not an
 * op slot and so has its own seam — and which shipped the identical wrapper bug
 * one day later, on the user's own deck. See that section's header for AJ.
 *
 * THE BUG, as reported (user, 2026-08-02, verbatim): "unknown item failed to
 * paint when i am tweening… between two slides one of which has a linear
 * gradient and one of which has the sky shader it says that in the middle of
 * transition is this a generalized problem… it's fine with going from a
 * gradient to a gradient but what about to material no it doesn't work it
 * doesn't crossfade them it errors."
 *
 * IT WAS A GENERALIZED PROBLEM, and considerably more general than the report.
 * Measured on the frozen baseline: EVERY from × to pair with a material on
 * EITHER side drew the red containment box at interior alpha — including
 * material→material and material→solid. Only gradient→gradient and solid→solid
 * survived, which is exactly why it presented as "fine with going from a
 * gradient to a gradient".
 *
 * ROOT CAUSE — resolution could not see inside the wrapper. Mid-transition the
 * `blend` interp mode replaces a paint slot with `{type: "crossfade", from, to,
 * t}`. That wrapper is not a material paint, so ports.js's
 * `isMaterialPaint(cmd.fill)` test answered FALSE and any material hidden on a
 * side never got its `resolvedParams`. The painter throws on absence by
 * contract (paint_skia.js handleMaterialPaintShape), so paint containment caught
 * the op and drew the error box. The crossfade ROUTER was never at fault:
 * pre-resolving the operands by hand made sky, crt, frosted, metal and
 * vector_pattern all paint correctly through it.
 *
 * WHAT THIS PINS. The full from × to grid at an interior alpha, asserting on the
 * REPORT rather than on pixels: every cell must paint with NO "failed to PAINT"
 * report. Pixels are the wrong witness here and that is worth recording — the
 * containment box is red-dominant, but so is a red `from` colour crossfaded onto
 * a pale material, so a mean-colour test produces FALSE POSITIVES. It did during
 * this workstream, on three cells that were painting perfectly.
 *
 * THE DEDUPE IS THE OTHER TRAP, and it is why this gate gives each cell its own
 * ITEM OWNER. core/report.js reportOnce dedupes by key, and paint containment's
 * key is `paint_skia:node:<itemId>:<message>` — the message names only the
 * MATERIAL. With every op unowned, "solid→sky" and "linear→sky" collide on one
 * key, so the first cell reports and every later cell is SILENT: the failure
 * reads as a pass. That is not hypothetical either; it is what the first version
 * of this probe measured, and it disagreed with the user's own report until the
 * owner was made unique. A distinct `owner.itemId` per cell keeps the keys
 * distinct without needing to reach into the reporter's memory.
 */

import assert from "node:assert/strict";
import { rect, pushTransform, popTransform, parsePaint, parseColor, paintSolidColor, CROSSFADE_PAINT_TYPE } from "../render_gpu/ir.js";
import { resolveMaterialFillPaints, resolvedBackgroundFill } from "../render_gpu/ports.js";
import { readPng } from "./imageDistinctness.js";

const { renderToPng } = await import("../render_gpu/skia/node_render.js");

const W = 200, H = 120;
const INTERIOR_ALPHA = 0.5; // a strictly-interior frame: the only place a crossfade paint exists
const material = (id) => ({ type: "material", material: { id, params: {} } });

const FROM = {
  solid: "#cc3344",
  linear: { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#ff00aa" }, { offset: 1, color: "#00ccff" }] } },
  radial: { type: "radialGradient", radial: { center: { x: 0.5, y: 0.5 }, r: 0.5, stops: [{ offset: 0, color: "#ffcc00" }, { offset: 1, color: "#003366" }] } },
  material: material("metal"),
};
// sky/metal are FILL-capable materials; crt/frosted are BACKDROP-class (they
// need the {blurredBackdrop, sharpBackdrop} supply only handleMaterialBackdrop
// threads); vector_pattern is a SAMPLER/pattern material that dispatches its own
// op. All three classes are represented deliberately — the suspicion going in was
// that the backdrop class specifically would be un-crossfadable, and it is not.
const TO = {
  sky: material("sky"),
  crt: material("crt"),
  frosted: material("frosted"),
  metal: material("metal"),
  vector_pattern: material("vector_pattern"),
  solid: "#2244cc",
};

let cellSeq = 0;

/**
 * Command (renders one cell; returns its PNG and any paint-failure reports).
 * `itemId` is unique per call so the reporter's dedupe key is unique too — see
 * the dedupe note in the header.
 */
async function renderCell(from, to) {
  const itemId = `ac-cell-${cellSeq++}`;
  const reports = [];
  const realError = console.error;
  console.error = (...a) => { reports.push(String(a[0])); };
  let png;
  try {
    const fill = { type: "crossfade", from, to, t: INTERIOR_ALPHA };
    const ops = resolveMaterialFillPaints([rect({ x: 10, y: 10, w: 180, h: 100, fill })], null, null);
    const owned = [
      { ...pushTransform({ x: 0, y: 0, rotation: 0, scale: 1 }), owner: { itemId, type: "rect" } },
      ...ops,
      popTransform(),
    ];
    png = await renderToPng(owned, { zoom: 1, dpr: 1, panX: 0, panY: 0 }, { width: W, height: H });
  } finally {
    console.error = realError;
  }
  return { png, failures: reports.filter((r) => r.includes("failed to PAINT")) };
}

let cells = 0;
for (const [fromName, from] of Object.entries(FROM)) {
  for (const [toName, to] of Object.entries(TO)) {
    const where = `${fromName} -> ${toName}`;
    const { png, failures } = await renderCell(from, to);
    // THE MATRIX LAW: every cell either crossfades or degrades honestly. An error
    // box is for a MALFORMED DOCUMENT, never for a mode limitation, so zero cells
    // may report a paint failure.
    assert.equal(failures.length, 0, `crossfade ${where} at alpha ${INTERIOR_ALPHA} reported a paint failure: ${failures[0]}`);
    assert.ok(png && png.length > 0, `crossfade ${where} produced no PNG`);
    cells++;
  }
}
console.log(`  crossfade matrix: ${cells} cells (${Object.keys(FROM).length} from × ${Object.keys(TO).length} to) paint clean at alpha ${INTERIOR_ALPHA}`);

// ── THE USER'S EXACT CASE, PIXEL-CHECKED ────────────────────────────────────
// linear gradient -> sky, mid-tween. Beyond "it did not report", this asserts the
// frame is a genuine MIX: distinct from both endpoints, and NOT the containment
// box. The endpoints are rendered through the same seam so the comparison is
// like-for-like.
const meanRgb = (png) => {
  const img = readPng(png);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4) { r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
  return [r / n, g / n, b / n];
};
const plain = async (fill) => (await renderCell(fill, fill)).png; // t is irrelevant when both sides match
const linear = FROM.linear, sky = TO.sky;
const [midPng, fromPng, toPng] = [await renderCell(linear, sky), { png: await plain(linear) }, { png: await plain(sky) }].map((x) => x.png);
const [mid, a, b] = [midPng, fromPng, toPng].map(meanRgb);
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
assert.ok(dist(mid, a) > 2, `linear->sky mid-tween is indistinguishable from the gradient endpoint (${mid.map(Math.round)} vs ${a.map(Math.round)})`);
assert.ok(dist(mid, b) > 2, `linear->sky mid-tween is indistinguishable from the sky endpoint (${mid.map(Math.round)} vs ${b.map(Math.round)})`);
// The containment box's own fill is #f6c9c4 — a specific pale red. A correct mix
// of a pink→cyan gradient with the sky is nothing like it.
const ERROR_BG_RGB = [246, 201, 196];
assert.ok(dist(mid, ERROR_BG_RGB) > 30, `linear->sky mid-tween looks like the containment error box (${mid.map(Math.round)})`);
console.log(`  user's case linear->sky at alpha ${INTERIOR_ALPHA}: mixes both endpoints, no error box`);

// ── THE BACKGROUND SLOT (WORKSTREAM AJ) ─────────────────────────────────────
// THE SIXTH SLOT, and the one the matrix above structurally cannot reach. Every
// cell above goes through resolveMaterialFillPaints, which walks an OP's paint
// slots — but the camera BACKGROUND is not an op slot. It is hand-assembled by
// web/cameraFrame.js and web/CanvasView.svelte outside sceneIR, so it has its own
// resolution seam (ports.resolvedBackgroundFill), and that seam kept its own
// inline `isMaterialPaint` test after AC fixed the other five. The wrapper
// answered false there exactly as it had everywhere else, so both material sides
// reached the painter unresolved.
//
// THE USER'S REPORT (2026-08-02, verbatim): "when interpolating from material to
// material, blend does not seem to do what it's supposed to do. I mean, it should
// just render twice, right? … It just gives me a big error when I interpolate and
// I fade between two materials on the background."
//
// These cells therefore call resolvedBackgroundFill FIRST and paint its output as
// the background rect — the real seam, not a restatement of the op path. A cell
// that regressed would either throw here or draw the containment box.
const BACKGROUND_CASES = {
  "material -> material": [material("sky"), material("metal")], // the user's exact case
  "gradient -> material": [FROM.linear, material("sky")],
  "solid -> material": [FROM.solid, material("metal")],
  "material -> solid": [material("crt"), TO.solid], // the wrapper resolves on EITHER side
};

/**
 * Command (renders one background cell). Mirrors renderCell's report capture, but
 * the paint goes through resolvedBackgroundFill — the background's own seam.
 */
async function renderBackgroundCell(from, to) {
  const itemId = `aj-bg-${cellSeq++}`;
  const reports = [];
  const realError = console.error;
  console.error = (...a) => { reports.push(String(a[0])); };
  let png;
  try {
    const background = { type: "crossfade", from, to, t: INTERIOR_ALPHA };
    const fill = resolvedBackgroundFill(background, []);
    const owned = [
      { ...pushTransform({ x: 0, y: 0, rotation: 0, scale: 1 }), owner: { itemId, type: "camera" } },
      rect({ x: 0, y: 0, w: W, h: H, fill }),
      popTransform(),
    ];
    png = await renderToPng(owned, { zoom: 1, dpr: 1, panX: 0, panY: 0 }, { width: W, height: H });
  } finally {
    console.error = realError;
  }
  return { png, failures: reports.filter((r) => r.includes("failed to PAINT")) };
}

let bgCells = 0;
for (const [where, [from, to]] of Object.entries(BACKGROUND_CASES)) {
  const { png, failures } = await renderBackgroundCell(from, to);
  assert.equal(failures.length, 0, `background crossfade ${where} at alpha ${INTERIOR_ALPHA} reported a paint failure: ${failures[0]}`);
  assert.ok(png && png.length > 0, `background crossfade ${where} produced no PNG`);
  bgCells++;
}
console.log(`  background slot: ${bgCells} cells paint clean at alpha ${INTERIOR_ALPHA}`);

// THE BYTE-IDENTICAL CONTRACT resolvedBackgroundFill has always carried: a
// background that is neither a material nor a crossfade comes back as plain
// parsePaint output. Routing it through resolvedPaint must not have changed that,
// so this pins the non-crossfade path the fix passes THROUGH.
assert.deepEqual(resolvedBackgroundFill("#123f5a", []), parsePaint("#123f5a"), "a solid background must be byte-identical to parsePaint");
assert.deepEqual(resolvedBackgroundFill(FROM.linear, []), parsePaint(FROM.linear), "a gradient background must be byte-identical to parsePaint");
assert.equal(resolvedBackgroundFill({ type: "material", material: { id: "comic", params: {} } }, []).resolvedParams.mode, "cmyk", "a bare material background still resolves");
// …and the fix itself, asserted structurally rather than only through pixels:
// BOTH sides of a background crossfade carry resolvedParams.
const bgMix = resolvedBackgroundFill({ type: "crossfade", from: material("sky"), to: material("metal"), t: INTERIOR_ALPHA }, []);
assert.ok(bgMix.from.resolvedParams, "a background crossfade's FROM material must be resolved");
assert.ok(bgMix.to.resolvedParams, "a background crossfade's TO material must be resolved");
console.log("  background slot: resolution reaches both sides; non-crossfade backgrounds unchanged");

// THE SECOND CAUSE ON THE SAME FRAME (AJ). Resolution was only half of it. The
// camera background is ALSO paintIR's surface CLEAR colour, which is a scalar by
// construction (a clear cannot be a shader), so it goes through parseColor →
// paintSolidColor — a reduction with a branch for every paint KIND and none for
// the wrapper, which is not a kind. A crossfade therefore fell through to that
// function's throw and killed the whole render, AFTER resolution was fixed. Found
// only by rendering the user's deck end-to-end through the CLI; the seam above
// cannot reach it, which is exactly why this case is here.
assert.equal(paintSolidColor({ type: CROSSFADE_PAINT_TYPE, from: { type: "solid", solid: "#ff0000" }, to: { type: "solid", solid: "#0000ff" }, t: 0.75 }), "#0000ff", "past halfway a crossfade reduces to its TO side");
assert.equal(paintSolidColor({ type: CROSSFADE_PAINT_TYPE, from: { type: "solid", solid: "#ff0000" }, to: material("sky"), t: 0.25 }), "#ff0000", "before halfway it reduces to its FROM side");
assert.equal(paintSolidColor({ type: CROSSFADE_PAINT_TYPE, from: material("sky"), to: material("metal"), t: 0.5 }), "#888888", "material→material reduces to the documented gray stand-in, not a throw");
// …and the whole point: parseColor no longer throws on a background crossfade.
assert.doesNotThrow(() => parseColor({ type: CROSSFADE_PAINT_TYPE, from: material("sky"), to: material("metal"), t: 0.5 }), "a background crossfade must reduce to a clear colour rather than killing the render");
console.log("  background slot: a crossfade reduces to a scalar clear colour (paintIR's surface clear)");

console.log("crossfade_material_matrix_test: OK");
