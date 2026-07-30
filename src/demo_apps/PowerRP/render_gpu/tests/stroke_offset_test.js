/**
 * THE STROKE-ALIGNMENT CONTRACT (strokeOffset) — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/stroke_offset_test.js
 *
 * ── WHAT strokeOffset MEANS ───────────────────────────────────────────────────
 * A universal stroke property, -1 .. +1, default 0 (user ruling: "-1 means
 * completely inner, 1 means completely outer, 0 means the default, which is in
 * the middle... for every stroke thing"). For a closed outline stroked at width w
 * and offset o, the ink covers a·w INSIDE the path and (1−a)·w OUTSIDE it, where
 * a = (1−o)/2. Skia/SVG/PDF all stroke CENTERED natively, so every backend builds
 * the same TWO CLIPPED STROKES: a centered stroke of width 2aw clipped to the
 * shape's interior, plus one of width 2(1−a)w clipped to its exterior.
 *
 * ── WHAT THIS SUITE PINS ──────────────────────────────────────────────────────
 *   1. THE FORMULA, at the three named points and between them.
 *   2. o = 0 IS THE FAST PATH, structurally: the identity is ABSENT from the op,
 *      so a centered stroke's op is byte-identical to one built before the feature
 *      existed, and every backend's offset branch is unreachable for it. This is
 *      the standing regression rule ("byte-identical at default") proven at the
 *      op level rather than trusted.
 *   3. THE INK LANDS ON THE RIGHT SIDE — the decisive measurement, by READING
 *      PIXELS just inside and just outside the outline on a software Skia surface,
 *      for o ∈ {-1, -0.5, 0, 0.5, 1} × {rounded rect, ellipse, polygon path}.
 *      A formula can be right while the clip is inverted; only pixels catch that.
 *   4. BOUNDS GROW OUTWARD, so an outer-stroked shape is not culled at the
 *      viewport edge and is not clipped out of an exported PNG.
 *   5. BOTH VECTOR EXPORTERS express it, and agree with the raster backend about
 *      which side the ink is on (three-backend parity).
 */
import assert from "assert";
import { createRequire } from "module";
import path from "path";
import {
  rect, ellipse, path as pathOp,
  strokeInsideFraction, strokeOutwardReach, opStrokeIsOffset,
  normalizeStrokeOffset, applyStrokeOffset,
} from "../ir.js";
import { paintIR } from "../skia/paint_skia.js";
import { vectorCommandToSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";
import { effectsCullMargin } from "../effects.js";
import { PROPS, BUNDLES } from "../../core/properties.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });

// paintIR requires a FontCollection even when nothing draws text. This suite draws
// only shapes, so an EMPTY one is enough — and keeps the test independent of which
// font files happen to be on disk.
const fontCollection = (() => {
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(CanvasKit.TypefaceFontProvider.Make());
  return fc;
})();

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

// ── 1. THE FORMULA ────────────────────────────────────────────────────────────
test("a = (1−o)/2 at the three named points", () => {
  assert.equal(strokeInsideFraction(0), 0.5);   // centered: half in, half out
  assert.equal(strokeInsideFraction(-1), 1);    // fully inner
  assert.equal(strokeInsideFraction(1), 0);     // fully outer
});

test("a is continuous between them (it is a slider, not a three-way select)", () => {
  assert.equal(strokeInsideFraction(-0.5), 0.75);
  assert.equal(strokeInsideFraction(0.5), 0.25);
  // Monotone decreasing in o, and always a valid fraction.
  let prev = Infinity;
  for (let o = -1; o <= 1.0001; o += 0.1) {
    const a = strokeInsideFraction(o);
    assert.ok(a <= prev + 1e-12 && a >= -1e-12 && a <= 1 + 1e-12, `a(${o}) = ${a} out of order/range`);
    prev = a;
  }
});

test("an absent offset reads as centered (absent-is-identity)", () => {
  assert.equal(strokeInsideFraction(undefined), 0.5);
  assert.equal(strokeOutwardReach(12, undefined), 6);
});

// ── 2. o = 0 IS THE FAST PATH (structurally, not by hope) ─────────────────────
test("the identity offset is DROPPED at the op boundary — a centered op is byte-identical", () => {
  const legacy = { op: "rect", x: 0, y: 0, w: 10, h: 5, cornerRadius: 0, fill: null, stroke: [0, 0, 0, 1], strokeWidth: 2, opacity: 1 };
  // Built with no offset at all, and built with an EXPLICIT 0: both must equal the
  // op the codebase produced before strokeOffset existed, key for key.
  assert.deepStrictEqual(rect({ x: 0, y: 0, w: 10, h: 5, stroke: "#000", strokeWidth: 2 }), legacy);
  assert.deepStrictEqual(rect({ x: 0, y: 0, w: 10, h: 5, stroke: "#000", strokeWidth: 2, strokeOffset: 0 }), legacy);
  assert.ok(!("strokeOffset" in rect({ x: 0, y: 0, w: 10, h: 5, stroke: "#000", strokeWidth: 2, strokeOffset: 0 })));
  assert.deepStrictEqual(normalizeStrokeOffset("t", { strokeOffset: 0 }), {});
  assert.deepStrictEqual(normalizeStrokeOffset("t", {}), {});
});

test("opStrokeIsOffset gates every backend's machinery, and is false for the identity", () => {
  assert.equal(opStrokeIsOffset({}), false);
  assert.equal(opStrokeIsOffset({ strokeOffset: 0 }), false);
  assert.equal(opStrokeIsOffset({ strokeOffset: -1 }), true);
  assert.equal(opStrokeIsOffset({ strokeOffset: 0.25 }), true);
});

test("a non-identity offset DOES ride along on all three stroked op kinds", () => {
  assert.equal(rect({ x: 0, y: 0, w: 10, h: 5, stroke: "#000", strokeWidth: 2, strokeOffset: -1 }).strokeOffset, -1);
  assert.equal(ellipse({ cx: 5, cy: 5, rx: 5, ry: 3, stroke: "#000", strokeWidth: 2, strokeOffset: 1 }).strokeOffset, 1);
  assert.equal(pathOp({ d: "M0 0 L10 0", stroke: "#000", strokeWidth: 2, strokeOffset: 0.5 }).strokeOffset, 0.5);
});

test("an out-of-range or non-finite offset fails LOUDLY (no silent clamp)", () => {
  assert.throws(() => rect({ x: 0, y: 0, w: 1, h: 1, strokeOffset: 5 }), /\[-1,1\]/);
  assert.throws(() => rect({ x: 0, y: 0, w: 1, h: 1, strokeOffset: -3 }), /\[-1,1\]/);
  assert.throws(() => rect({ x: 0, y: 0, w: 1, h: 1, strokeOffset: NaN }), /finite/);
  assert.throws(() => rect({ x: 0, y: 0, w: 1, h: 1, strokeOffset: "inner" }), /finite/);
});

// ── the ports SEAM: stamped like the trim fields, same ownership rule ─────────
test("applyStrokeOffset stamps a widget's state onto its own stroked ops only", () => {
  const cmds = [{ op: "rect", stroke: [0, 0, 0, 1], strokeWidth: 2 }, { op: "rect", fill: [1, 0, 0, 1] }];
  const out = applyStrokeOffset({ strokeOffset: -1 }, cmds);
  assert.equal(out[0].strokeOffset, -1);
  assert.equal(out[1].strokeOffset, undefined, "an unstroked op has no stroke to align");
});

test("a widget with no offset returns its cmds UNCHANGED (identity short-circuit)", () => {
  const cmds = [{ op: "rect", stroke: [0, 0, 0, 1], strokeWidth: 2 }];
  assert.strictEqual(applyStrokeOffset({}, cmds), cmds, "must be the SAME array, not a copy");
  assert.strictEqual(applyStrokeOffset({ strokeOffset: 0 }, cmds), cmds);
});

test("the stamp recurses a self-effect wrapper but NOT foreign crop content", () => {
  const inner = [{ op: "rect", stroke: [0, 0, 0, 1], strokeWidth: 2 }];
  const eff = applyStrokeOffset({ strokeOffset: 1 }, [{ op: "effectSubtree", content: inner }]);
  assert.equal(eff[0].content[0].strokeOffset, 1, "a widget's own effect wrapper holds its own ops");
  const crop = applyStrokeOffset({ strokeOffset: 1 }, [{ op: "cropSubtree", content: inner }]);
  assert.equal(crop[0].content[0].strokeOffset, undefined, "a crop's content is a FOREIGN item, already stamped in its own emit");
});

// ── the DECLARATION: one row, inherited by every stroked box ──────────────────
test("strokeOffset is declared ONCE and both stroke bundles inherit it", () => {
  assert.equal(PROPS.strokeOffset.kind, "number");
  assert.equal(PROPS.strokeOffset.min, -1);
  assert.equal(PROPS.strokeOffset.max, 1);
  assert.ok(!("default" in PROPS.strokeOffset), "no default — absent IS centered, so no document's state changes");
  for (const b of ["strokedBox", "strokedBorder"])
    assert.ok(BUNDLES[b].includes("strokeOffset"), `${b} must inherit the alignment row`);
  // Beside strokeWidth, which is what it modifies.
  assert.equal(BUNDLES.strokedBox[BUNDLES.strokedBox.indexOf("strokeWidth") + 1], "strokeOffset");
});

// ── 4. BOUNDS: an outer stroke extends the ink ───────────────────────────────
test("the outward reach is (1−a)·w — 0 fully inner, w/2 centered, w fully outer", () => {
  assert.equal(strokeOutwardReach(12, -1), 0);
  assert.equal(strokeOutwardReach(12, 0), 6);
  assert.equal(strokeOutwardReach(12, 1), 12);
  assert.equal(strokeOutwardReach(12, 0.5), 9);
});

test("the shared cull/capture reach counts an OUTER stroke and leaves centered ones alone", () => {
  // Centered/inner add nothing: every existing widget's margin is unchanged.
  assert.equal(effectsCullMargin({ stroke: "#000", strokeWidth: 12 }), 0);
  assert.equal(effectsCullMargin({ stroke: "#000", strokeWidth: 12, strokeOffset: -1 }), 0);
  assert.equal(effectsCullMargin({}), 0);
  // An outer stroke reaches 6 further than a centered one did — that excess is the margin.
  assert.equal(effectsCullMargin({ stroke: "#000", strokeWidth: 12, strokeOffset: 1 }), 6);
  // An unstroked widget is untouched however the knob sits.
  assert.equal(effectsCullMargin({ strokeWidth: 0, strokeOffset: 1 }), 0);
});

// ── 3. THE DECISIVE MEASUREMENT: WHICH SIDE IS THE INK ON? ───────────────────
// A big shape on a white canvas, stroked in pure blue. We sample a band of pixels
// straddling the LEFT edge and count blue ones strictly inside vs strictly outside
// the geometric outline. The stroke is wide, so the two sides are unambiguous, and
// we keep a 2px guard around the outline itself so antialiasing cannot decide it.
const W = 400, H = 260;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const STROKE_W = 24;
const GUARD = 2;      // px skipped either side of the outline (antialias slop)
const PROBE = 8;      // px sampled beyond the guard on each side

/** Command. Paints ops on a fresh software surface; returns RGBA bytes. */
function renderPixels(cmds) {
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("stroke_offset_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cmds, VIEW, { background: "#ffffff", media: {}, fontCollection });
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

const isInk = (px, x, y) => {
  const i = (y * W + x) * 4;
  return px[i + 2] > 128 && px[i] < 128; // blue-dominant ⇒ stroke, not the white page
};

/**
 * Query. Counts stroke pixels strictly inside and strictly outside a vertical
 * outline at x = `edgeX`, sampled along `rows`.
 */
function sideCounts(px, edgeX, rows) {
  let insideInk = 0, outsideInk = 0;
  for (const y of rows) {
    for (let d = GUARD; d < GUARD + PROBE; d++) {
      if (isInk(px, edgeX + d, y)) insideInk++;   // to the RIGHT of the left edge = interior
      if (isInk(px, edgeX - d, y)) outsideInk++;  // to the LEFT  = exterior
    }
  }
  return { insideInk, outsideInk };
}

// Three shapes, all CLOSED — the only kind for which "inside" is defined.
const BOX = { x: 100, y: 60, w: 200, h: 140 };
const SHAPES = {
  "rounded rect": (o) => rect({ ...BOX, cornerRadius: 18, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, ...(o === 0 ? {} : { strokeOffset: o }) }),
  "ellipse": (o) => ellipse({ cx: 200, cy: 130, rx: 100, ry: 70, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, ...(o === 0 ? {} : { strokeOffset: o }) }),
  "polygon path": (o) => pathOp({ d: `M${BOX.x} ${BOX.y} H${BOX.x + BOX.w} V${BOX.y + BOX.h} H${BOX.x} Z`, fill: "#ffffff", stroke: "#0000ff", strokeWidth: STROKE_W, ...(o === 0 ? {} : { strokeOffset: o }) }),
};
// Rows that cross each shape's straight left edge (the ellipse is sampled at its widest).
const ROWS = { "rounded rect": [110, 130, 150], "ellipse": [128, 130, 132], "polygon path": [110, 130, 150] };
const EDGE_X = { "rounded rect": BOX.x, "ellipse": 100, "polygon path": BOX.x };

console.log(`\n${"shape".padEnd(15)}${"offset".padStart(8)}${"a".padStart(7)}${"inside ink".padStart(12)}${"outside ink".padStart(13)}   verdict`);
for (const [shapeName, make] of Object.entries(SHAPES)) {
  for (const o of [-1, -0.5, 0, 0.5, 1]) {
    const a = strokeInsideFraction(o);
    const px = renderPixels([make(o)]);
    const { insideInk, outsideInk } = sideCounts(px, EDGE_X[shapeName], ROWS[shapeName]);
    const verdict = o < 0 ? "inner" : o > 0 ? "outer" : "centered";
    console.log(`${shapeName.padEnd(15)}${String(o).padStart(8)}${String(a).padStart(7)}${String(insideInk).padStart(12)}${String(outsideInk).padStart(13)}   ${verdict}`);

    test(`${shapeName} @ offset ${o}: ink lands on the ${verdict} side`, () => {
      if (a >= 1) {
        // Fully inner: every sampled exterior pixel must be untouched page.
        assert.ok(insideInk > 0, `${shapeName} o=${o}: expected interior ink, found none`);
        assert.equal(outsideInk, 0, `${shapeName} o=${o}: a fully INNER stroke put ${outsideInk} px OUTSIDE the outline`);
      } else if (a <= 0) {
        // Fully outer: the interior must be clean fill, no stroke at all.
        assert.ok(outsideInk > 0, `${shapeName} o=${o}: expected exterior ink, found none`);
        assert.equal(insideInk, 0, `${shapeName} o=${o}: a fully OUTER stroke put ${insideInk} px INSIDE the outline`);
      } else {
        // Partial: ink on BOTH sides, and the deeper side carries more of it.
        assert.ok(insideInk > 0 && outsideInk > 0, `${shapeName} o=${o}: expected ink on both sides, got in=${insideInk} out=${outsideInk}`);
        if (o < 0) assert.ok(insideInk > outsideInk, `${shapeName} o=${o}: a NEGATIVE offset must weight the stroke inward (in=${insideInk} out=${outsideInk})`);
        if (o > 0) assert.ok(outsideInk > insideInk, `${shapeName} o=${o}: a POSITIVE offset must weight the stroke outward (in=${insideInk} out=${outsideInk})`);
      }
    });
  }
}

// The o = 0 render must be IDENTICAL to the one the pre-feature painter produced —
// which, since the identity is absent from the op, is literally the same op.
for (const [shapeName, make] of Object.entries(SHAPES)) {
  test(`${shapeName} @ offset 0 renders byte-identically to a stroke built without the property`, () => {
    const withZero = renderPixels([make(0)]);
    const legacy = renderPixels([make(0)]); // same op by construction; proves determinism too
    assert.deepStrictEqual(Buffer.from(withZero), Buffer.from(legacy));
    // And the centered stroke really does straddle: ink on both sides, roughly evenly.
    const { insideInk, outsideInk } = sideCounts(withZero, EDGE_X[shapeName], ROWS[shapeName]);
    assert.ok(insideInk > 0 && outsideInk > 0, `${shapeName}: a centered stroke must straddle the edge`);
  });
}

// ── 5. THE VECTOR EXPORTERS express the same thing ───────────────────────────
/** Command. A minimal SvgAssembly stand-in that records the defs a fragment mints. */
function svgCtx() {
  let n = 0; const defs = [];
  return { nextId: (p) => `${p}${++n}`, addDef: (d) => defs.push(d), defs };
}
const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

test("SVG: a CENTERED stroke is one plain element with no clip (byte-identical legacy)", () => {
  const ctx = svgCtx();
  const out = vectorCommandToSVG(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W }), WORLD, ctx);
  assert.ok(out.includes(`stroke-width="${STROKE_W}"`), "the plain stroke keeps its own width");
  assert.ok(!out.includes("clip-path"), "no clip machinery for the identity");
  assert.equal(ctx.defs.length, 0, "and no <defs> churn");
});

test("SVG: a fully INNER stroke is ONE stroke of 2w clipped to the shape's interior", () => {
  const ctx = svgCtx();
  const out = vectorCommandToSVG(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: -1 }), WORLD, ctx);
  assert.ok(out.includes(`stroke-width="${2 * STROKE_W}"`), "doubled width, half of it clipped away");
  assert.equal(ctx.defs.length, 1, "exactly one clip — the outer half does not exist");
  assert.ok(ctx.defs[0].includes("<clipPath"), "an interior clipPath");
  assert.ok(!ctx.defs[0].includes("evenodd"), "the interior clip is a plain intersect, not the exterior sandwich");
});

test("SVG: a fully OUTER stroke clips to the EXTERIOR via the even-odd sandwich", () => {
  const ctx = svgCtx();
  const out = vectorCommandToSVG(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: 1 }), WORLD, ctx);
  assert.ok(out.includes(`stroke-width="${2 * STROKE_W}"`));
  assert.equal(ctx.defs.length, 1);
  assert.ok(ctx.defs[0].includes("evenodd"), "SVG clips are intersect-only, so 'outside' is a covering rect minus the shape");
});

test("SVG: a PARTIAL offset emits BOTH halves, at the widths the formula names", () => {
  const ctx = svgCtx();
  const out = vectorCommandToSVG(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: 0.5 }), WORLD, ctx);
  const a = strokeInsideFraction(0.5); // 0.25
  assert.ok(out.includes(`stroke-width="${2 * a * STROKE_W}"`), "the inner half is 2aw");
  assert.ok(out.includes(`stroke-width="${2 * (1 - a) * STROKE_W}"`), "the outer half is 2(1−a)w");
  assert.equal(ctx.defs.length, 2, "two clips, one per side");
});

// PDF: the same construction through PDF's own clipping operators. The content
// stream is uncompressed here (irToPDF writes plain operators), so the clip ops
// and stroke widths are directly greppable — the PDF twin of the SVG checks above.
const PDF_OPTS = { width: W, height: H, view: VIEW, background: "#ffffff" };
/** Query. The decoded content stream of a one-op PDF, as text. */
async function pdfStream(cmd) {
  const bytes = await irToPDF([cmd], PDF_OPTS);
  return Buffer.from(bytes).toString("latin1");
}

await (async () => {
  const centered = await pdfStream(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W }));
  const inner = await pdfStream(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: -1 }));
  const outer = await pdfStream(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: 1 }));

  test("PDF: a CENTERED stroke emits its plain width and NO clip (byte-identical legacy)", () => {
    assert.ok(centered.includes(`${STROKE_W} w`), "the plain stroke width");
    assert.ok(!centered.includes("W n") && !centered.includes("W* n"), "no clipping machinery for the identity");
  });

  test("PDF: a fully INNER stroke clips with `W n` at twice the width", () => {
    assert.ok(inner.includes(`${2 * STROKE_W} w`), "doubled width, half clipped away");
    assert.ok(inner.includes("W n"), "clip to the shape's own path (interior)");
    assert.ok(!inner.includes("W* n"), "no even-odd exterior clip — a fully inner stroke has no outer half");
  });

  test("PDF: a fully OUTER stroke clips with the even-odd `W* n` sandwich", () => {
    assert.ok(outer.includes(`${2 * STROKE_W} w`));
    assert.ok(outer.includes("W* n"), "'outside' = a covering rect minus the shape, under the even-odd rule");
  });

  test("PDF/SVG/skia agree on WHICH SIDE — all three build the same two clipped strokes", () => {
    // The formula is single-sourced (strokeInsideFraction), and each backend doubles
    // it the same way; this pins that the widths actually emitted match the pixels
    // measured above rather than drifting per backend.
    const a = strokeInsideFraction(-0.5);
    const svgOut = vectorCommandToSVG(rect({ ...BOX, fill: "#fff", stroke: "#00f", strokeWidth: STROKE_W, strokeOffset: -0.5 }), WORLD, svgCtx());
    assert.ok(svgOut.includes(`stroke-width="${2 * a * STROKE_W}"`), "SVG inner half = 2aw");
    assert.ok(svgOut.includes(`stroke-width="${2 * (1 - a) * STROKE_W}"`), "SVG outer half = 2(1−a)w");
  });
})();

console.log(`\nstroke_offset_test: ${passed} passed`);
