/**
 * CROSSFADE × MATERIAL matrix gate (bare node) — WORKSTREAM AC.
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
import { rect, pushTransform, popTransform } from "../render_gpu/ir.js";
import { resolveMaterialFillPaints } from "../render_gpu/ports.js";
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

console.log("crossfade_material_matrix_test: OK");
