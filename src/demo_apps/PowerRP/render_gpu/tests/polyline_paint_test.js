/**
 * THE PAINTED POLYLINE — bare node, real Skia pixels, plus both vector exporters.
 * Run: node render_gpu/tests/polyline_paint_test.js
 *
 * THE DEFECT THIS PINS. `polyline` was the ONE geometry builder still parsing its
 * ink with `parseColor` instead of `parsePaint`. parseColor's contract is to reduce
 * a paint OBJECT to a representative SOLID — correct for a single-colour consumer
 * (a crop-box border, a shadow tint), catastrophic for a widget's real ink: a
 * gradient stroke silently became its FIRST STOP and a material became "#888888",
 * with no warning at any layer. Nine plugins drew flat strokes that should have
 * been gradients (line, arrow, elbow_arrow, curved_arrow, fancy_arrow's rim,
 * tangent_lines, donut's two rims, clock_analog).
 *
 * THE SHARPEST CASE IS HALF AN ARROW, and it is the acceptance picture below:
 * plugins/arrow.js draws its shaft with polyline and its heads with polygon/path
 * from the SAME `s.stroke` leaf, so ONE gradient rendered TWO ways in ONE widget.
 *
 * WHY THESE ASSERTIONS. The sibling gradient suites' lesson is that a paint test
 * must read back RENDERED PIXELS and assert the property the feature claims, not
 * that the machinery ran — the camera dither shipped green for months while doing
 * nothing. So each claim here is written so a plausible wrong implementation fails:
 *
 *   - "a gradient polyline spans its stops"  fails if the ink flattens to one stop
 *                                            (the exact regression, in pixels).
 *   - "a SOLID polyline is byte-identical"   fails if parsePaint perturbed the
 *                                            overwhelming-majority path.
 *   - "shaft and head agree"                 fails if the two builders disagree
 *                                            about one leaf again.
 *   - "SVG mints a real def"                 fails if the exporter flattens.
 *   - "PDF degrades LOUDLY"                  fails if a real limitation goes quiet.
 */

import assert from "node:assert/strict";
import path from "path";
import { createRequire } from "module";
import { paintIR } from "../skia/paint_skia.js";
import { polyline, rect, parsePaint } from "../ir.js";
import { irToSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";
import { arrowPlugin } from "../../plugins/arrow.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
const fontCollection = CanvasKit.FontCollection.Make(); // no text in any scene here

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const W = 200, H = 60;
/** A RED→BLUE ramp along +x. Horizontal so the polyline's own run samples the
 *  whole axis, which is what makes a flattened ink measurable at the two ends. */
const RAMP = {
  type: "linearGradient",
  linear: { stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }], angle: 0 },
};

/**
 * Command (allocates + frees a surface). Renders `cmds` and returns UNPREMULTIPLIED
 * RGBA device pixels — the gradient_dither_test readback, reused verbatim.
 */
function pixels(cmds) {
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("polyline_paint_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cmds,
    { zoom: 1, panX: 0, panY: 0, dpr: 1 }, { fontCollection, background: "#000000" });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: W, height: H,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  img.delete();
  surface.dispose();
  return px;
}

/** Pure function. The [r,g,b,a] byte quad at (x, y) of a W-wide RGBA buffer. */
const at = (px, x, y) => [...px.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];

/** A thick horizontal run across the full width, centred vertically. */
const RUN = { points: [[10, H / 2], [W - 10, H / 2]], width: 24 };

// ── THE REGRESSION, IN PIXELS ────────────────────────────────────────────────
await test("a GRADIENT polyline spans its stops (it does not flatten to the first)", () => {
  const px = pixels([polyline({ ...RUN, color: RAMP })]);
  const y = Math.floor(H / 2);
  const left = at(px, 20, y), right = at(px, W - 20, y);
  // The defect drew BOTH ends in the first stop's red. A real ramp is red at the
  // left and blue at the right, so each end must dominate in its own channel.
  assert.ok(left[0] > 200 && left[2] < 60, `left end should be RED, got rgba(${left})`);
  assert.ok(right[2] > 200 && right[0] < 60, `right end should be BLUE, got rgba(${right})`);
  // And the two ends must actually DIFFER — the single assertion the flattened
  // implementation could never pass, whatever colour it happened to pick.
  assert.ok(Math.abs(left[0] - right[0]) > 150, "the ramp's ends must differ, not repeat one stop");
});

await test("a RADIAL gradient polyline renders its ramp too (the slot is a full paint, not a linear special case)", () => {
  // A DIAGONAL run, deliberately. A gradient maps over the op's objectBoundingBox,
  // and a perfectly horizontal polyline's bbox has ZERO HEIGHT — a radial mapped
  // into it degenerates and paints one flat colour. That is a pre-existing property
  // of bbox-space paint shared with the `polygon` op (measured: a zero-height
  // polygon with the same radial ink paints flat too), NOT something this op's
  // paint move introduced, so the case is avoided here rather than asserted about.
  const radial = { type: "radialGradient", radial: { stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } };
  const px = pixels([polyline({ points: [[10, 12], [W - 10, H - 12]], width: 20, color: radial })]);
  const middle = at(px, Math.floor(W / 2), Math.floor(H / 2)), edge = at(px, 20, 16);
  assert.ok(middle[0] > edge[0], `the radial centre should be redder than its edge, got ${middle} vs ${edge}`);
});

// ── THE IDENTITY PATH: the overwhelming majority ─────────────────────────────
await test("a SOLID polyline is byte-identical to the parseColor era (IR, pixels, and both exporters)", async () => {
  // IR: parsePaint delegates a string/array straight to parseColor, so the op is
  // the same object it always was — which is what keeps every cache key stable.
  assert.deepEqual(polyline({ ...RUN, color: "#3355cc" }).color, [0.2, 0.3333333333333333, 0.8, 1]);
  assert.deepEqual(polyline({ ...RUN, color: "#3355cc" }), polyline({ ...RUN, color: [0.2, 0.3333333333333333, 0.8, 1] }));
  // Pixels: a solid stroke paints one flat colour end to end.
  const px = pixels([polyline({ ...RUN, color: "#3355cc" })]);
  const y = Math.floor(H / 2);
  assert.deepEqual(at(px, 20, y), at(px, W - 20, y), "a solid stroke must be the same colour at both ends");
  // Exporters: the solid spelling each backend emitted before.
  const out = { width: W, height: H, view: { zoom: 1, panX: 0, panY: 0, dpr: 1 } };
  const svg = await irToSVG([polyline({ ...RUN, color: "#3355cc" })], out);
  assert.match(svg, /stroke="rgba\(51,85,204,1\)"/, "a solid stroke keeps its literal rgba(), not a url(#..) ref");
  assert.doesNotMatch(svg, /<linearGradient/, "a solid stroke must mint NO gradient def");
});

await test("an OFF ink (parsePaint → null) draws NOTHING rather than throwing", async () => {
  // parsePaint maps {type:"none"} to null, the same null the fill-only ops already
  // guard on. Before this, `color` could not be null at all and every backend
  // would have indexed it as an rgba array.
  const off = polyline({ ...RUN, color: { type: "none" } });
  assert.equal(off.color, null);
  const px = pixels([off]), blank = pixels([]);
  assert.deepEqual([...px], [...blank], "an OFF polyline must leave the surface untouched");
  const out = { width: W, height: H, view: { zoom: 1, panX: 0, panY: 0, dpr: 1 } };
  assert.doesNotMatch(await irToSVG([off], out), /<polyline/, "an OFF polyline emits no SVG element");
});

// ── THE ACCEPTANCE PICTURE: one leaf, one paint ──────────────────────────────
await test("ARROW: the shaft (polyline) and the head (polygon/path) agree on ONE stroke leaf", () => {
  const state = { ...(arrowPlugin.defaults ?? {}), from: { x: 10, y: 10 }, to: { x: 150, y: 100 }, stroke: RAMP, strokeWidth: 6 };
  const cmds = arrowPlugin.emit(state);
  const shaft = cmds.find((c) => c.op === "polyline");
  const head = cmds.find((c) => c.op === "polygon" || c.op === "path");
  assert.ok(shaft && head, "the arrow must emit both a shaft and a head");
  // THE defect: shaft.color was [1,0,0,1] (the first stop) while head.fill was the
  // whole gradient — one authored leaf, two pictures.
  assert.deepEqual(shaft.color, head.fill ?? head.stroke,
    "shaft and head must carry the SAME parsed paint — they come from one `stroke` leaf");
  assert.equal(shaft.color.type, "linearGradient", "the shaft must keep the gradient, not a representative solid");
});

// ── THE EXPORTERS ────────────────────────────────────────────────────────────
await test("SVG: a gradient polyline mints a real <linearGradient> def and references it", async () => {
  const out = { width: W, height: H, view: { zoom: 1, panX: 0, panY: 0, dpr: 1 } };
  const svg = await irToSVG([polyline({ ...RUN, color: RAMP })], out);
  const def = svg.match(/<linearGradient id="([^"]+)"/);
  assert.ok(def, "a gradient stroke must emit a <linearGradient> def");
  assert.match(svg, new RegExp(`<polyline[^>]*stroke="url\\(#${def[1]}\\)"`),
    "the polyline's stroke must reference the def it minted");
  assert.match(svg, /stop-color="rgb\(255,0,0\)"/);
  assert.match(svg, /stop-color="rgb\(0,0,255\)"/);
});

await test("PDF: a gradient polyline degrades to a solid LOUDLY (the backend's standing gradient-STROKE rule)", async () => {
  // PDF has no stroked-gradient primitive, so EVERY gradient stroke in this
  // backend degrades to its first stop with a one-time report. A polyline's ink IS
  // a stroke, so it joins that existing rule rather than inventing a second answer
  // — the point being that it is now REPORTED, where the old silent flattening
  // happened at the builder with nothing said anywhere.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    await irToPDF([polyline({ ...RUN, color: RAMP })],
      { width: W, height: H, view: { zoom: 1, panX: 0, panY: 0, dpr: 1 } });
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warnings.some((w) => /gradient STROKE is not expressible/.test(w)),
    `the degradation must be announced, not silent — got ${JSON.stringify(warnings)}`);
});

// ── THE STATED BOUND ─────────────────────────────────────────────────────────
await test("a MATERIAL ink is REFUSED loudly (the stroke-material framework reads stroke/strokeWidth, not color/width)", () => {
  assert.throws(
    () => polyline({ ...RUN, color: { type: "material", material: { id: "crt" } } }),
    /MATERIAL ink is not supported on this op/,
    "a material must fail at the funnel rather than reach a painter and draw garbage");
});

console.log(`\npolyline_paint: ${passed} passed`);
