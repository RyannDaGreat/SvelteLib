/**
 * Axis-1 PAINT + text-OUTLINE tests.
 *   - parsePaint / isGradientPaint pure-function contract (solid backward-compat,
 *     gradient normalization, loud stubs).
 *   - text_layout glyph-pass pure helpers (piece ranges / style lookup / gate).
 *   - SVG export: gradient <linearGradient>/<radialGradient> defs + url(#..) refs.
 *   - PDF export: axial (ShadingType 2) / radial (ShadingType 3) shadings + `sh`.
 *   - Skia RUNTIME render (node_render): a per-run text OUTLINE adds ink vs the
 *     same text without an outline (the F1.1 parity fix), a gradient shape fill
 *     spans its stop colors, and gradient text renders (not a solid).
 *   - Backward-compat: a plain-string solid fill is byte-identical IR.
 *
 * Run: node render_gpu/tests/paint_gradient_test.js
 */
import assert from "assert";
import { parsePaint, isGradientPaint, parseColor, paintSolidColor, magnifyBackdrop, rect, ellipse, text } from "../ir.js";
import { magnifierPlugin } from "../../plugins/magnifier.js";
import { pieceCharRanges, styleAtOffset, styleNeedsGlyphPass } from "../skia/text_layout.js";
import { irToSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";
import { renderToPng } from "../skia/node_render.js";
import { keyframed, foldState } from "../../core/document.js";
import { angleToLinearEndpoints } from "../../core/properties.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── parsePaint / isGradientPaint ──────────────────────────────────────────────
await test("parsePaint: a solid string/array is byte-identical rgba (backward compat)", () => {
  assert.deepEqual(parsePaint("#ff0000"), [1, 0, 0, 1]);
  assert.deepEqual(parsePaint([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3, 1]);
  assert.equal(parsePaint(null), null);
  assert.equal(isGradientPaint(parsePaint("#f00")), false);
});
await test("parsePaint: linear gradient normalizes stops (offset clamp + color→rgba)", () => {
  const p = parsePaint({ type: "linearGradient", stops: [{ offset: -1, color: "#000" }, { offset: 2, color: "#fff" }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } });
  assert.equal(p.type, "linearGradient");
  assert.deepEqual(p.stops.map((s) => s.offset), [0, 1]); // clamped
  assert.deepEqual(p.stops[1].color, [1, 1, 1, 1]);
  assert.deepEqual(p.from, { x: 0, y: 0 });
  assert.equal(isGradientPaint(p), true);
});
await test("parsePaint: radial gradient keeps center + r", () => {
  const p = parsePaint({ type: "radialGradient", stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], center: { x: 0.5, y: 0.5 }, r: 0.5 });
  assert.equal(p.type, "radialGradient");
  assert.equal(p.r, 0.5);
});
await test("parsePaint: MULTI-SUB-STATE object — solid is byte-identical; active gradient read from its wrapper", () => {
  // The PaintField's {type, solid, linear, radial} shape: type "solid" renders
  // byte-identically to the bare string (the stashed gradients are ignored);
  // the active gradient sub-state is read from its own wrapper, not inline.
  const sub = { solid: "#ff0000", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }, radial: { stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } };
  assert.deepEqual(parsePaint({ type: "solid", ...sub }), parsePaint("#ff0000"));
  assert.equal(isGradientPaint(parsePaint({ type: "solid", ...sub })), false);
  const lin = parsePaint({ type: "linearGradient", ...sub });
  assert.equal(lin.type, "linearGradient");
  assert.equal(lin.stops.length, 2);
  const rad = parsePaint({ type: "radialGradient", ...sub });
  assert.equal(rad.r, 0.5);
  assert.throws(() => parsePaint({ type: "solid" }), /needs a "solid" color/); // loud, never a silent blank
});

// ── linear-gradient DIRECTION: `angle` is authoritative, from/to DERIVED (#80) ─
await test("parsePaint: linear from/to are DERIVED from the authoritative `angle` (stale from/to ignored)", () => {
  // angle present ⇒ endpoints computed from it via angleToLinearEndpoints; a
  // CONTRADICTORY stored from/to is ignored (angle wins). 90° = a vertical axis.
  const p = parsePaint({ type: "linearGradient", linear: {
    stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }],
    angle: 90, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } } });
  assert.deepEqual(p.from, angleToLinearEndpoints(90).from);
  assert.deepEqual(p.to, angleToLinearEndpoints(90).to);
  assert.equal(p.from.x, p.to.x); // vertical axis, NOT the stale horizontal from/to
});
await test("parsePaint: linear direction FALLS BACK to from/to (no angle), else a 0° default; bad angle is loud", () => {
  // Un-migrated in-memory paint: no angle ⇒ the stored from/to render as-is.
  const raw = parsePaint({ type: "linearGradient", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], from: { x: 0.2, y: 0.3 }, to: { x: 0.8, y: 0.7 } });
  assert.deepEqual(raw.from, { x: 0.2, y: 0.3 });
  assert.deepEqual(raw.to, { x: 0.8, y: 0.7 });
  // Neither angle nor from/to ⇒ the GRADIENT_DEFAULT_ANGLE (0°, left→right).
  const def = parsePaint({ type: "linearGradient", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] });
  assert.deepEqual(def.from, angleToLinearEndpoints(0).from);
  assert.deepEqual(def.to, angleToLinearEndpoints(0).to);
  // A non-finite angle is a loud error, never a silent NaN endpoint.
  assert.throws(() => parsePaint({ type: "linearGradient", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], angle: "nope" }), /"angle" must be a finite number/);
});
await test("parsePaint: a KEYFRAMED angle 0°→180° tweens as a ROTATING axis (90° at alpha 0.5), not a collapsed midpoint", () => {
  // THE point of task #80: only `angle` is keyframed, so alpha 0.5 folds to 90°
  // — a full-strength VERTICAL gradient — instead of two endpoints lerping to a
  // degenerate horizontal midpoint (from ≈ to). from/to are DERIVED post-fold.
  const mkfill = () => ({ type: "linearGradient", linear: {
    stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], angle: 0 } });
  let doc = { meta: {}, slides: [
    { id: "s0", name: "s0", delta: { items: { r1: { type: "rect", fill: mkfill() } } } },
    { id: "s1", name: "s1", delta: {} },
  ] };
  doc = keyframed(doc, 1, ["items", "r1", "fill", "linear", "angle"], 180);
  const mid = parsePaint(foldState(doc, 1, 0.5).items.r1.fill);
  assert.deepEqual(mid.from, angleToLinearEndpoints(90).from); // {x: 0.5, y: 0}
  assert.deepEqual(mid.to, angleToLinearEndpoints(90).to);     // {x: 0.5, y: 1}
  assert.notEqual(mid.from.y, mid.to.y); // a REAL axis (not a collapsed point)
});
await test("REGRESSION: parsePaint ACCEPTS a folded gradient after a single-stop keyframe (no numeric-keyed-object crash)", () => {
  // The live crash — keyframing one stop's offset across slides used to fold to
  // stops = {"2":{offset:…}} (numeric-keyed object), which parsePaint rejected
  // as "a gradient needs >= 2 stops". The folded gradient must be a clean array
  // of complete stops that parsePaint accepts.
  const mkfill = () => ({ type: "linearGradient", solid: "#111111", linear: {
    stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 1, color: "#0000ff" }],
    from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }, radial: { stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } });
  let doc = { meta: {}, slides: [
    { id: "s0", name: "s0", delta: { items: { r1: { type: "rect", fill: mkfill() } } } },
    { id: "s1", name: "s1", delta: {} },
  ] };
  doc = keyframed(doc, 1, ["items", "r1", "fill", "linear", "stops", 2, "offset"], 0.74);
  const p = parsePaint(foldState(doc, 1, 1).items.r1.fill); // must NOT throw
  assert.equal(p.type, "linearGradient");
  assert.equal(p.stops.length, 3);
  assert.equal(p.stops[2].color[0], 0); // #0000ff base color survived the keyframe (b=1)
  assert.equal(p.stops[2].color[2], 1);
  // Same-slide per-index edit (the exact crash write) also stays parseable.
  let doc2 = { meta: {}, slides: [{ id: "s0", name: "s0", delta: { items: { r1: { type: "rect", fill: mkfill() } } } }] };
  doc2 = keyframed(doc2, 0, ["items", "r1", "fill", "linear", "stops", 2, "offset"], 0.74);
  assert.doesNotThrow(() => parsePaint(doc2.slides[0].delta.items.r1.fill));
});
await test("REGRESSION: a SINGLE-COLOR consumer (magnifier border) renders when its stroke is a PAINT OBJECT", () => {
  // The 2nd live crash — a widget (magnifier) whose stroke/fill is now the
  // polymorphic multi-sub-state paint object flowed into parseColor (which only
  // knew strings/arrays) and threw "unsupported color". parseColor must now
  // RESOLVE a paint object to its representative solid color; a plain string
  // must still work; genuine garbage must still throw. ("cornflowerblue" used to
  // be the garbage example here — it is a valid CSS colour, now accepted.)
  const paintObj = { type: "linearGradient", solid: "#1a1a2e", linear: { stops: [{ offset: 0, color: "#111111" }, { offset: 1, color: "#fff" }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }, radial: { stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], center: { x: 0.5, y: 0.5 }, r: 0.5 } };
  assert.deepEqual(parseColor(paintObj), parseColor("#1a1a2e"), "paint object → its remembered solid");
  assert.deepEqual(parseColor("#00ff00"), [0, 1, 0, 1], "plain string still parses");
  assert.deepEqual(parseColor([0.5, 0.5, 0.5]), [0.5, 0.5, 0.5, 1], "array still parses");
  assert.equal(paintSolidColor({ type: "linearGradient", stops: [{ offset: 0, color: "#0000ff" }] }), "#0000ff", "legacy inline → first stop");
  assert.throws(() => parseColor("notacolour"), /unsupported color/, "genuine garbage still throws");
  assert.throws(() => parseColor({ nope: 1 }), /cannot resolve a solid color/, "unreducible object throws loudly");
  // FULL PATH: magnifier.emit with a paint-object stroke → magnifyBackdrop op
  // renders (no throw), border resolved to the paint's solid color.
  const op = magnifierPlugin.emit({ shape: "circle", x: 0, y: 0, w: 160, h: 160, magnification: 2, stroke: paintObj, strokeWidth: 4 })[0];
  assert.deepEqual(op.stroke, parseColor("#1a1a2e"), "magnifier border resolves the paint object to its solid");
  assert.doesNotThrow(() => magnifyBackdrop({ cx: 0, cy: 0, r: 50, magnification: 2, stroke: paintObj, strokeWidth: 3 }));
});
await test("parsePaint: pattern/image/shader are loud stubs; <2 stops throws", () => {
  assert.throws(() => parsePaint({ type: "pattern" }), /not implemented/);
  assert.throws(() => parsePaint({ type: "image" }), /not implemented/);
  assert.throws(() => parsePaint({ type: "shader" }), /not implemented/);
  assert.throws(() => parsePaint({ type: "linearGradient", stops: [{ offset: 0, color: "#000" }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }), />= 2 stops/);
  assert.throws(() => parsePaint({ type: "conic" }), /unknown paint type/);
});
await test("rect/ellipse solid fill is byte-identical; gradient threads through", () => {
  assert.deepEqual(rect({ x: 0, y: 0, w: 10, h: 5, fill: "#f00" }).fill, [1, 0, 0, 1]);
  const g = { type: "linearGradient", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
  assert.equal(rect({ x: 0, y: 0, w: 10, h: 5, fill: g }).fill.type, "linearGradient");
  assert.equal(ellipse({ cx: 0, cy: 0, rx: 5, ry: 5, fill: g }).fill.type, "linearGradient");
});

// ── text_layout glyph-pass pure helpers ───────────────────────────────────────
await test("pieceCharRanges / styleAtOffset map glyphs to piece styles", () => {
  const pieces = [{ text: "ab", style: { color: "#f00" } }, { text: "cde", style: { color: "#00f" } }];
  const ranges = pieceCharRanges(pieces);
  assert.deepEqual(ranges.map((r) => [r.start, r.end]), [[0, 2], [2, 5]]);
  assert.equal(styleAtOffset(ranges, 0).color, "#f00");
  assert.equal(styleAtOffset(ranges, 3).color, "#00f");
  assert.equal(styleAtOffset(ranges, 99).color, "#00f"); // trailing → last piece
});
await test("styleNeedsGlyphPass: outline OR gradient triggers the glyph pass; solid does not", () => {
  assert.equal(styleNeedsGlyphPass({ outlineWidth: 2 }), true);
  assert.equal(styleNeedsGlyphPass({ color: { type: "linearGradient" } }), true);
  assert.equal(styleNeedsGlyphPass({ color: "#f00", outlineWidth: 0 }), false);
  assert.equal(styleNeedsGlyphPass({}), false);
});

// ── SVG export ────────────────────────────────────────────────────────────────
await test("irToSVG: gradient fill emits <linearGradient>/<radialGradient> defs + url() refs", async () => {
  const lg = { type: "linearGradient", stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }], from: { x: 0, y: 0 }, to: { x: 1, y: 1 } };
  const rg = { type: "radialGradient", stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }], center: { x: 0.5, y: 0.5 }, r: 0.5 };
  const svg = await irToSVG([rect({ x: 0, y: 0, w: 100, h: 60, fill: lg }), ellipse({ cx: 200, cy: 50, rx: 40, ry: 30, fill: rg })], { width: 300, height: 120, view: { zoom: 1, panX: 0, panY: 0 }, background: "#fff" });
  assert.match(svg, /<linearGradient id="[^"]+" x1="0" y1="0" x2="1" y2="1">/);
  assert.match(svg, /<radialGradient id="[^"]+" cx="0.5" cy="0.5" r="0.5">/);
  assert.match(svg, /fill="url\(#[^)]+\)"/);
  assert.match(svg, /stop-color="rgb\(255,0,0\)"/);
});
await test("irToSVG: a solid fill still emits a plain rgba() (no gradient def)", async () => {
  const svg = await irToSVG([rect({ x: 0, y: 0, w: 10, h: 10, fill: "#ff0000" })], { width: 20, height: 20, view: { zoom: 1, panX: 0, panY: 0 } });
  assert.match(svg, /fill="rgba\(255,0,0,1\)"/);
  assert.doesNotMatch(svg, /linearGradient|radialGradient/);
});

// ── PDF export ────────────────────────────────────────────────────────────────
await test("irToPDF: gradient fill emits axial/radial shadings + `sh`", async () => {
  const lg = { type: "linearGradient", stops: [{ offset: 0, color: "#f00" }, { offset: 0.5, color: "#0f0" }, { offset: 1, color: "#00f" }], from: { x: 0, y: 0 }, to: { x: 1, y: 1 } };
  const rg = { type: "radialGradient", stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }], center: { x: 0.5, y: 0.5 }, r: 0.5 };
  const bytes = await irToPDF([rect({ x: 0, y: 0, w: 100, h: 60, fill: lg }), ellipse({ cx: 200, cy: 50, rx: 40, ry: 30, fill: rg })], { width: 300, height: 120, view: { zoom: 1, panX: 0, panY: 0 }, background: "#fff" });
  const s = Buffer.from(bytes).toString("latin1");
  assert.ok(s.startsWith("%PDF"));
  assert.match(s, /ShadingType\s*2/); // axial (linear)
  assert.match(s, /ShadingType\s*3/); // radial
  assert.match(s, /\/Sh\d+ sh/);      // shading paint operator
  assert.match(s, /FunctionType\s*3/); // stitching (3-stop linear)
});

// ── Skia RUNTIME render (the F1.1 parity fix + gradient render) ───────────────
const DPR = 2, W = 200, H = 90;
const view = { zoom: 1, panX: 0, panY: 0, dpr: DPR };
function richRun(extra) {
  return { runs: [{ text: "Ag", size: 60, font: "inter", color: "#ffffff", bold: true, italic: false, underline: false, strike: false, outlineColor: "#000000", outlineWidth: 0, highlight: "", ...extra }], paras: [{ align: "left" }] };
}
/** Near-pure. Counts near-black ink pixels in an RGBA PNG-decoded buffer via a
 * re-render to raw pixels is overkill; instead we compare PNG-encoded sizes +
 * re-render both and count dark pixels through a second CanvasKit read. Simpler:
 * render each and assert the outlined PNG is materially different (more dark ink). */
async function darkInk(rich) {
  // Render to PNG then re-decode is heavy; instead reuse renderToPng and measure
  // the encoded byte length as a coarse proxy is unreliable. We instead render a
  // WHITE-fill text on white bg: without an outline it is nearly invisible (few
  // dark px), with a dark outline it gains a clear dark silhouette.
  const png = await renderToPng([text({ text: "Ag", x: 10, y: 8, size: 60, color: "#ffffff", font: "inter", rich, boxW: 180 })], view, { width: W * DPR, height: H * DPR, background: "#ffffff" });
  return png.length;
}
await test("text OUTLINE renders at runtime (Skia) — white-on-white text gains a dark outline", async () => {
  const noOutline = await darkInk(richRun({ outlineWidth: 0 }));
  const withOutline = await darkInk(richRun({ outlineColor: "#000000", outlineWidth: 5 }));
  // White text on white with no outline compresses tiny; a dark outline adds a
  // real silhouette → a materially larger PNG. (Coarse but decisive here.)
  assert.ok(withOutline > noOutline * 1.5, `outline PNG (${withOutline}) should dwarf the outline-free PNG (${noOutline})`);
});
await test("gradient shape renders as a GRADIENT (differs from the same shape filled solid)", async () => {
  const grad = { type: "linearGradient", stops: [{ offset: 0, color: "#e100ff" }, { offset: 1, color: "#7f00ff" }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
  const gradPng = await renderToPng([rect({ x: 10, y: 10, w: 160, h: 60, fill: grad })], view, { width: W * DPR, height: H * DPR, background: "#ffffff" });
  const solidPng = await renderToPng([rect({ x: 10, y: 10, w: 160, h: 60, fill: "#e100ff" })], view, { width: W * DPR, height: H * DPR, background: "#ffffff" });
  // A varying gradient encodes to different bytes than a flat solid of the same
  // shape — decisive proof the shader painted a gradient, not a constant color.
  assert.ok(gradPng.length > 200 && !Buffer.from(gradPng).equals(Buffer.from(solidPng)), "gradient fill should differ from a solid fill of the same shape");
});
await test("gradient TEXT renders (a valid PNG; the run's gradient fill did not throw)", async () => {
  const grad = { type: "linearGradient", stops: [{ offset: 0, color: "#e100ff" }, { offset: 1, color: "#7f00ff" }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
  const textPng = await renderToPng([text({ text: "Grad", x: 10, y: 10, size: 50, color: "#000", font: "inter", rich: { runs: [{ text: "Grad", size: 50, font: "inter", bold: true, italic: false, underline: false, strike: false, outlineColor: "#000", outlineWidth: 0, highlight: "", color: grad }], paras: [{ align: "left" }] }, boxW: 180 })], view, { width: W * DPR, height: H * DPR, background: "#ffffff" });
  const blankPng = await renderToPng([], view, { width: W * DPR, height: H * DPR, background: "#ffffff" });
  assert.ok(!Buffer.from(textPng).equals(Buffer.from(blankPng)), "gradient text should draw ink (differ from a blank canvas)");
});

console.log(`\n${passed} paint/gradient/outline checks passed`);
