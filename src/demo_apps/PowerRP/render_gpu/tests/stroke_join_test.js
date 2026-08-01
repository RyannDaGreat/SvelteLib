/**
 * THE STROKE-JOIN CONTRACT (strokeJoin + strokeMiter) — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/stroke_join_test.js
 *
 * ── WHAT THE TWO PROPERTIES MEAN ──────────────────────────────────────────────
 * A universal stroke option (user request: "the way a stroke behaves around bends
 * is something we should take into account... there are hyperparameters for Skia
 * that allow it to say the angle threshold for which we should give that up").
 * `strokeJoin` ∈ {miter, round, bevel} says how a stroke turns a CORNER;
 * `strokeMiter` is the miter's own sub-option, the ratio past which a miter gives
 * up and bevels. For a corner of interior angle θ the miter tip reaches
 * (w/2)/sin(θ/2) past the vertex — a multiple 1/sin(θ/2) of the half-width — and
 * THAT ratio is what the limit bounds, so a limit L gives up at θ = 2·asin(1/L).
 *
 * ── WHAT THIS SUITE PINS ──────────────────────────────────────────────────────
 *   1. THE GEOMETRY, in Skia PIXELS: at a fixed acute corner the three joins reach
 *      measurably different distances past the vertex, and the miter's reach
 *      matches the closed form until the limit cuts it off. A formula can be right
 *      while the paint flag is never set; only pixels catch that.
 *   2. THE IDENTITY IS DROPPED at the op boundary, so a pre-feature op is
 *      byte-identical and every existing deck renders exactly as before.
 *   3. THREE-BACKEND PARITY, including the defect this suite was written for:
 *      PDF's own default miter limit is 10 where Skia's and SVG's is 4, so a PDF
 *      export that stated nothing drew a 66px spike where the editor and the SVG
 *      export drew a flat bevel (measured, 24-unit stroke at a 20° corner).
 *      pdf_backend must STATE the limit on every stroke it emits. THIS IS THE
 *      ASSERTION THAT FAILS AT HEAD.
 *   4. THE POLYLINE OP'S CONTRACT is one fact, not three: the op is documented as
 *      round caps/joins and all three backends must say so from the same constant.
 */
import assert from "assert";
import { createRequire } from "module";
import path from "path";
import {
  path as pathOp, rect, polyline,
  opStrokeJoin, opStrokeMiter, normalizeStrokeJoin, applyStrokeJoin,
  STROKE_JOIN_DEFAULT, POLYLINE_JOIN, POLYLINE_CAP,
} from "../ir.js";
import { paintIR } from "../skia/paint_skia.js";
import { vectorCommandToSVG } from "../svg_backend.js";
import { irToPDF } from "../pdf_backend.js";
import { PROPS, BUNDLES, STROKE_JOIN_MODES, STROKE_JOIN_KEYS, STROKE_MITER_LIMIT, STROKE_MITER_LIMIT_MIN } from "../../core/properties.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });

// paintIR wants a FontCollection even when nothing draws text; an EMPTY one keeps
// the suite independent of which fonts happen to be on disk (stroke_offset_test's
// precedent, copied deliberately).
const fontCollection = (() => {
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(CanvasKit.TypefaceFontProvider.Make());
  return fc;
})();

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

// ── 1. THE DECLARATION: two rows, inherited by every stroked box ─────────────
test("strokeJoin/strokeMiter are declared ONCE and both stroke bundles inherit them", () => {
  assert.equal(PROPS.strokeJoin.kind, "select");
  assert.deepEqual(PROPS.strokeJoin.options, STROKE_JOIN_MODES);
  assert.equal(PROPS.strokeMiter.kind, "number");
  // No default on either: absent IS (miter, 4), so composing the bundle changes
  // no widget's stored state — the absent-is-legacy rule the whole stroke block
  // follows (core/properties.js "ABSENT-IS-LEGACY").
  assert.ok(!("default" in PROPS.strokeJoin), "no default — absent IS miter");
  assert.ok(!("default" in PROPS.strokeMiter), "no default — absent IS STROKE_MITER_LIMIT");
  // tests/default_step_test.js pins opacity/particleFade as the ONLY number props
  // that may declare a `step`; a step here would make that suite red.
  assert.ok(!("step" in PROPS.strokeMiter), "no step — defaultStep's precision fallback gives continuous scrubbing");
  assert.equal(PROPS.strokeMiter.min, STROKE_MITER_LIMIT_MIN, "a ratio under 1 is geometrically unsatisfiable");
  assert.equal(PROPS.strokeMiter.max, undefined, "no ceiling — a huge limit is the legitimate 'never give up on the point'");
  for (const b of ["strokedBox", "strokedBorder"])
    for (const k of STROKE_JOIN_KEYS)
      assert.ok(BUNDLES[b].includes(k), `${b} must inherit ${k}`);
  // The limit reads as a sub-option OF the join, so it sits immediately after it.
  assert.equal(BUNDLES.strokedBox[BUNDLES.strokedBox.indexOf("strokeJoin") + 1], "strokeMiter");
});

test("the miter-limit row hides unless the join IS miter, and both hide behind a material", () => {
  const { strokeJoin, strokeMiter } = PROPS;
  assert.equal(strokeMiter.visibleWhen({ stroke: "#000", strokeJoin: "miter" }), true);
  assert.equal(strokeMiter.visibleWhen({ stroke: "#000" }), true, "absent join IS miter");
  assert.equal(strokeMiter.visibleWhen({ stroke: "#000", strokeJoin: "round" }), false, "a round join has no spike to cap");
  assert.equal(strokeMiter.visibleWhen({ stroke: { type: "none" } }), false, "no stroke, nothing to join");
  // A stroke MATERIAL rebuilds its own geometry (stroke_materials.js strokePaintOf),
  // so the join cannot reach the author's corners — the row hides rather than
  // sitting there inert.
  const material = { stroke: { type: "material", material: { id: "wavy" } } };
  assert.equal(strokeJoin.visibleWhen(material), false);
  assert.equal(strokeMiter.visibleWhen(material), false);
  assert.equal(strokeJoin.visibleWhen({ stroke: { type: "linear", stops: [] } }), true, "a gradient strokes through the same Paint as a solid");
});

// ── 2. THE IDENTITY IS DROPPED (structurally, not by hope) ───────────────────
test("the identity join/limit are DROPPED at the op boundary — a plain op is byte-identical", () => {
  const legacy = { op: "rect", x: 0, y: 0, w: 10, h: 5, cornerRadius: 0, fill: null, stroke: [0, 0, 0, 1], strokeWidth: 2, opacity: 1 };
  assert.deepStrictEqual(rect({ x: 0, y: 0, w: 10, h: 5, stroke: "#000", strokeWidth: 2 }), legacy);
  assert.deepStrictEqual(rect({ x: 0, y: 0, w: 10, h: 5, stroke: "#000", strokeWidth: 2, strokeJoin: "miter", strokeMiter: STROKE_MITER_LIMIT }), legacy);
  assert.deepStrictEqual(normalizeStrokeJoin("t", {}), {});
  assert.deepStrictEqual(normalizeStrokeJoin("t", { strokeJoin: STROKE_JOIN_DEFAULT, strokeMiter: STROKE_MITER_LIMIT }), {});
});

test("a non-identity join rides along, and a bad one fails LOUDLY (no silent clamp)", () => {
  assert.equal(rect({ x: 0, y: 0, w: 10, h: 5, stroke: "#000", strokeWidth: 2, strokeJoin: "bevel" }).strokeJoin, "bevel");
  assert.equal(pathOp({ d: "M0 0L10 0", stroke: "#000", strokeWidth: 2, strokeMiter: 10 }).strokeMiter, 10);
  assert.throws(() => rect({ x: 0, y: 0, w: 1, h: 1, strokeJoin: "sharp" }), /strokeJoin must be one of/);
  assert.throws(() => rect({ x: 0, y: 0, w: 1, h: 1, strokeMiter: NaN }), /finite/);
  assert.throws(() => rect({ x: 0, y: 0, w: 1, h: 1, strokeMiter: 0.5 }), /cannot be below/);
});

test("the readers answer for every op — absent means the identity", () => {
  assert.equal(opStrokeJoin({}), "miter");
  assert.equal(opStrokeMiter({}), STROKE_MITER_LIMIT);
  assert.equal(opStrokeJoin({ strokeJoin: "round" }), "round");
  assert.equal(opStrokeMiter({ strokeMiter: 12 }), 12);
});

// ── the ports SEAM: stamped like the trim/offset fields, same ownership rule ──
test("applyStrokeJoin stamps a widget's state onto its own stroked ops only", () => {
  const cmds = [{ op: "rect", stroke: [0, 0, 0, 1], strokeWidth: 2 }, { op: "rect", fill: [1, 0, 0, 1] }];
  const out = applyStrokeJoin({ strokeJoin: "round" }, cmds);
  assert.equal(out[0].strokeJoin, "round");
  assert.equal(out[1].strokeJoin, undefined, "an unstroked op has no corners to join");
  assert.strictEqual(applyStrokeJoin({}, cmds), cmds, "identity returns the SAME array, not a copy");
  const inner = [{ op: "rect", stroke: [0, 0, 0, 1], strokeWidth: 2 }];
  assert.equal(applyStrokeJoin({ strokeJoin: "bevel" }, [{ op: "effectSubtree", content: inner }])[0].content[0].strokeJoin, "bevel");
  assert.equal(applyStrokeJoin({ strokeJoin: "bevel" }, [{ op: "cropSubtree", content: inner }])[0].content[0].strokeJoin, undefined,
    "a crop's content is a FOREIGN item, already stamped in its own emit");
});

// ── 3. THE DECISIVE MEASUREMENT: HOW FAR PAST THE VERTEX DOES THE INK REACH? ─
// A chevron whose apex points LEFT, stroked in pure blue on a white page. The
// leftmost ink column on the apex row IS the corner treatment, measured directly.
// The angle is ACUTE on purpose: at 90° a miter reaches only 1.41 half-widths and
// the three joins are hard to tell apart; at 40° a miter reaches 2.9 of them.
const W = 400, H = 200;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const STROKE_W = 24, HALF_W = STROKE_W / 2;
const APEX_X = 120, APEX_Y = 100, ARM = 200;
const SHARP_DEG = 40;   // 1/sin(20°) = 2.92 — inside the default limit of 4, so miter POINTS
const ACUTE_DEG = 20;   // 1/sin(10°) = 5.76 — past 4 but inside 10, the band PDF used to disagree on

/** Pure function. A chevron apexing LEFT with interior angle `deg` between arms. */
function chevronD(deg) {
  const h = (deg / 2) * Math.PI / 180;
  const dx = ARM * Math.cos(h), dy = ARM * Math.sin(h);
  return `M${APEX_X + dx} ${APEX_Y - dy} L${APEX_X} ${APEX_Y} L${APEX_X + dx} ${APEX_Y + dy}`;
}
/** Pure function. The closed-form miter reach past the vertex, in local units. */
const miterReach = (deg) => HALF_W / Math.sin((deg / 2) * Math.PI / 180);

const chev = (deg, extra) => pathOp({ d: chevronD(deg), stroke: "#0000ff", strokeWidth: STROKE_W, ...extra });

/** Command. Paints ops on a fresh software surface; returns RGBA bytes. */
function renderPixels(cmds) {
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("stroke_join_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cmds, VIEW, { background: "#ffffff", media: {}, fontCollection });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: W, height: H,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  img.delete(); surface.dispose();
  return px;
}
/** Query. How far past the apex the leftmost blue pixel on the apex row sits. */
function tipReach(px) {
  for (let x = 0; x < W; x++) {
    const i = (APEX_Y * W + x) * 4;
    if (px[i + 2] > 128 && px[i] < 128) return APEX_X - x;
  }
  throw new Error("stroke_join_test: no ink found on the apex row");
}
const reachOf = (deg, extra) => tipReach(renderPixels([chev(deg, extra)]));

const AA_SLOP = 2; // px — an antialiased EDGE fades over about a pixel either way

/**
 * Pure function. How far short of the geometric apex a MITER tip's measured ink
 * stops, in px. A miter tip is a wedge of half-angle θ/2, so at distance d from
 * the apex it is only 2·d·tan(θ/2) wide; it therefore has to run back some way
 * before it covers a whole pixel and clears a 50% coverage threshold. Solving
 * 2·d·tan(θ/2) = 1 gives the fade length, and the ordinary edge slop rides on top.
 *
 * This is derived rather than tuned on purpose: a constant tolerance loose enough
 * for a 20° tip (~3px short) would be far too loose to catch a wrong join at 90°.
 *
 * @param {number} deg - the corner's interior angle in degrees
 * @returns {number} the tolerance in px
 *
 * @example tipSlop(90) // 2.5   (a blunt tip: half a pixel of fade)
 * @example tipSlop(20) // 4.84  (a sliver: ~2.8px of fade before it is a pixel wide)
 */
function tipSlop(deg) {
  return 1 / (2 * Math.tan((deg / 2) * Math.PI / 180)) + AA_SLOP;
}

console.log(`\n  corner ${SHARP_DEG}°, stroke ${STROKE_W}: closed-form miter reach = ${miterReach(SHARP_DEG).toFixed(1)}px`);
for (const join of STROKE_JOIN_MODES) console.log(`    ${join.padEnd(6)} reach ${reachOf(SHARP_DEG, { strokeJoin: join })}px`);

test("MITER reaches the closed form (w/2)/sin(θ/2) when the limit allows it", () => {
  const measured = reachOf(SHARP_DEG, { strokeJoin: "miter" });
  assert.ok(Math.abs(measured - miterReach(SHARP_DEG)) <= tipSlop(SHARP_DEG),
    `mitered ${SHARP_DEG}° corner reached ${measured}px, closed form says ${miterReach(SHARP_DEG).toFixed(1)}px (tolerance ${tipSlop(SHARP_DEG).toFixed(2)}px)`);
});

test("the ABSENT join renders identically to an explicit miter (absent IS the identity)", () => {
  assert.deepStrictEqual(
    Buffer.from(renderPixels([chev(SHARP_DEG, {})])),
    Buffer.from(renderPixels([chev(SHARP_DEG, { strokeJoin: "miter" })])),
    "an op with no join must paint byte-identically to one that says miter");
});

test("ROUND reaches exactly the half width — the disc, not the point", () => {
  const measured = reachOf(SHARP_DEG, { strokeJoin: "round" });
  assert.ok(Math.abs(measured - HALF_W) <= AA_SLOP,
    `a round join is a disc of radius w/2 = ${HALF_W}, so it reaches that far; measured ${measured}px`);
});

test("BEVEL is the shortest of the three, and shorter than round", () => {
  const bevel = reachOf(SHARP_DEG, { strokeJoin: "bevel" });
  const round = reachOf(SHARP_DEG, { strokeJoin: "round" });
  const miter = reachOf(SHARP_DEG, { strokeJoin: "miter" });
  assert.ok(bevel < round, `bevel (${bevel}) cuts inside the round disc (${round})`);
  assert.ok(round < miter, `round (${round}) sits inside the miter point (${miter})`);
});

// ── THE LIMIT: the angle threshold the request actually asked for ────────────
console.log(`\n  corner ${ACUTE_DEG}°, ratio 1/sin(θ/2) = ${(1 / Math.sin((ACUTE_DEG / 2) * Math.PI / 180)).toFixed(2)}`);
for (const limit of [STROKE_MITER_LIMIT, 10]) console.log(`    limit ${String(limit).padEnd(3)} reach ${reachOf(ACUTE_DEG, { strokeJoin: "miter", strokeMiter: limit })}px`);

test("the MITER LIMIT gives up at the angle 1/sin(θ/2) names", () => {
  const ratio = 1 / Math.sin((ACUTE_DEG / 2) * Math.PI / 180); // 5.76 at 20°
  assert.ok(ratio > STROKE_MITER_LIMIT && ratio < 10, "the fixture angle must straddle the two limits or it proves nothing");
  const atDefault = reachOf(ACUTE_DEG, { strokeJoin: "miter" });
  const atTen = reachOf(ACUTE_DEG, { strokeJoin: "miter", strokeMiter: 10 });
  assert.ok(atDefault < HALF_W, `limit ${STROKE_MITER_LIMIT} < ratio ${ratio.toFixed(2)}, so the point must be GIVEN UP; reached ${atDefault}px`);
  assert.ok(Math.abs(atTen - miterReach(ACUTE_DEG)) <= tipSlop(ACUTE_DEG),
    `limit 10 > ratio ${ratio.toFixed(2)}, so the full point must survive; reached ${atTen}px, closed form ${miterReach(ACUTE_DEG).toFixed(1)}px (tolerance ${tipSlop(ACUTE_DEG).toFixed(2)}px)`);
});

test("a limit of 1 bevels EVERY corner (no miter can beat a ratio of 1)", () => {
  const atOne = reachOf(SHARP_DEG, { strokeJoin: "miter", strokeMiter: STROKE_MITER_LIMIT_MIN });
  const bevel = reachOf(SHARP_DEG, { strokeJoin: "bevel" });
  assert.ok(Math.abs(atOne - bevel) <= AA_SLOP, `limit 1 must look like a bevel; got ${atOne}px vs bevel ${bevel}px`);
});

// ── 4. THE VECTOR EXPORTERS express the same thing ───────────────────────────
/** Command. A minimal SvgAssembly stand-in (stroke_offset_test.js's, verbatim). */
function svgCtx() {
  let n = 0; const defs = [];
  return { nextId: (p) => `${p}${++n}`, addDef: (d) => defs.push(d), defs };
}
const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };
const svgOf = (extra) => vectorCommandToSVG(chev(ACUTE_DEG, extra), WORLD, svgCtx());

test("SVG: the identity emits NO join attributes (byte-identical legacy)", () => {
  const out = svgOf({});
  assert.ok(!out.includes("stroke-linejoin"), "SVG's own initial value IS miter, so silence and statement agree");
  assert.ok(!out.includes("stroke-miterlimit"), "SVG's own initial value IS 4");
});

test("SVG: a non-identity join/limit is a PASS-THROUGH, no translation table", () => {
  assert.ok(svgOf({ strokeJoin: "bevel" }).includes(`stroke-linejoin="bevel"`));
  assert.ok(svgOf({ strokeJoin: "round" }).includes(`stroke-linejoin="round"`));
  assert.ok(svgOf({ strokeMiter: 10 }).includes(`stroke-miterlimit="10"`));
  // The ids ARE the attribute values — that is the whole reason there is no map.
  // Derived from the mode list, minus the identity (which the test above pins as
  // deliberately OMITTED), so adding a fourth join mode without teaching the
  // exporter about it turns this red instead of silently exporting nothing.
  for (const join of STROKE_JOIN_MODES.filter((j) => j !== STROKE_JOIN_DEFAULT))
    assert.ok(svgOf({ strokeJoin: join }).includes(`stroke-linejoin="${join}"`), `${join} must serialize as itself`);
});

const PDF_OPTS = { width: W, height: H, view: VIEW, background: "#ffffff" };
/** Query. The decoded content stream of a one-op PDF, as text. */
async function pdfStream(cmd) {
  return Buffer.from(await irToPDF([cmd], PDF_OPTS)).toString("latin1");
}

await (async () => {
  const identity = await pdfStream(chev(ACUTE_DEG, {}));
  const bevel = await pdfStream(chev(ACUTE_DEG, { strokeJoin: "bevel" }));
  const round = await pdfStream(chev(ACUTE_DEG, { strokeJoin: "round" }));
  const limited = await pdfStream(chev(ACUTE_DEG, { strokeMiter: 10 }));

  // THE REGRESSION THIS SUITE EXISTS FOR. Before the fix this stream contained no
  // `M` at all, PDF fell back to its own default of 10, and the SAME chevron that
  // the painter and the SVG export bevelled flat exported with a 66px spike.
  test("PDF: the miter limit is STATED, not inherited — PDF's own default is 10, ours is 4", () => {
    assert.ok(/(^|\s)4 M(\s|$)/m.test(identity),
      `pdf_backend must emit "${STROKE_MITER_LIMIT} M" on a stroke; PDF's own default is 10 and would spike a corner the painter bevels`);
    assert.ok(/(^|\s)10 M(\s|$)/m.test(limited), "a widget's own limit must reach the stream");
  });

  test("PDF: the join code is stated too, from the ISO table (0 miter / 1 round / 2 bevel)", () => {
    assert.ok(/(^|\s)0 j(\s|$)/m.test(identity), "miter = 0");
    assert.ok(/(^|\s)1 j(\s|$)/m.test(round), "round = 1");
    assert.ok(/(^|\s)2 j(\s|$)/m.test(bevel), "bevel = 2");
  });

  test("PDF/SVG/skia agree: the SAME chevron gives up its point in all three", () => {
    // The ratio at ACUTE_DEG (5.76) sits between our limit (4) and PDF's own (10),
    // which is exactly the band where the three used to disagree. Skia's answer is
    // the pixel measurement above (atDefault < HALF_W); SVG's is its silence, which
    // means 4; PDF's is now the stated 4 rather than its inherited 10.
    assert.ok(!svgOf({}).includes("stroke-miterlimit"), "SVG: silence means SVG's initial 4");
    assert.ok(/(^|\s)4 M(\s|$)/m.test(identity), "PDF: states the same 4");
    assert.ok(reachOf(ACUTE_DEG, {}) < HALF_W, "skia: bevels at 4");
  });
})();

// ── 5. THE POLYLINE OP'S CONTRACT IS ONE FACT, NOT THREE ─────────────────────
const PL = polyline({ points: [[APEX_X + 100, APEX_Y - 20], [APEX_X, APEX_Y], [APEX_X + 100, APEX_Y + 20]], width: STROKE_W, color: "#0000ff" });

await (async () => {
  const svg = vectorCommandToSVG(PL, WORLD, svgCtx());
  const pdf = await pdfStream(PL);
  test("polyline: all three backends spell the op's round caps/joins from the SAME constants", () => {
    assert.equal(POLYLINE_JOIN, "round");
    assert.equal(POLYLINE_CAP, "round");
    assert.ok(svg.includes(`stroke-linejoin="${POLYLINE_JOIN}"`) && svg.includes(`stroke-linecap="${POLYLINE_CAP}"`));
    assert.ok(pdf.includes("1 J 1 j"), "PDF cap 1 = round, join 1 = round");
    // And the painter: a round join on a 40° corner reaches the half width, where
    // the file-level default (miter) would have reached 2.9 of them.
    const px = renderPixels([polyline({ points: [[APEX_X + ARM * Math.cos(0.349), APEX_Y - ARM * Math.sin(0.349)], [APEX_X, APEX_Y], [APEX_X + ARM * Math.cos(0.349), APEX_Y + ARM * Math.sin(0.349)]], width: STROKE_W, color: "#0000ff" })]);
    assert.ok(Math.abs(tipReach(px) - HALF_W) <= AA_SLOP, "skia must round the polyline's corner too");
  });

  test("polyline ignores a stamped widget join — the op fixes its own corners", () => {
    const stamped = applyStrokeJoin({ strokeJoin: "bevel" }, [PL]);
    assert.strictEqual(stamped[0], PL, "a polyline carries no `stroke` key, so the stamp cannot reach it");
  });
})();

console.log(`\nstroke_join_test: ${passed} passed`);
