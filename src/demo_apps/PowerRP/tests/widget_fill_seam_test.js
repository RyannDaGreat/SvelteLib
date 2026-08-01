/**
 * widget_fill_seam_test.js — THE SEAM GATE for widget FILLS.
 * Run: node src/demo_apps/PowerRP/tests/widget_fill_seam_test.js
 *
 * WHY THIS TEST EXISTS (R6-11, the user's "red flag": "why does the render look
 * different from the renderer I see on my screen in the editor? … it's the
 * geometry"). The donut and the fancy arrow used to ear-clip their outline and
 * emit ONE convex `polygon` IR op PER TRIANGLE — 128 ops for a donut. Skia draws
 * each as its own antialiased `drawPath`, and two abutting antialiased fills
 * conflate along their shared edge to ~192/255 instead of tiling to 255, so every
 * internal ear-clip diagonal is a visible crack. Whether you SEE it is decided by
 * one thing: the sample count of the surface. The editor viewport is the app's
 * ONLY multisampled surface (4x), which resolves the abutment away; every other
 * surface is 1 sample or software — thumbnails, the minimap, PNG/PDF export,
 * presenter fades, EVERY exported video frame, and the bare-node CLI. That is the
 * whole of the "the renderer disagrees with the editor" report.
 *
 * SO THE FIX WAS GEOMETRY, AND THIS IS WHAT GUARDS IT: each widget emits ONE
 * `path` op whose interior has no internal edges to conflate along. Setting the
 * offscreen surfaces to MSAA instead was measured and rejected — CanvasKit's
 * `MakeRenderTarget` has no sample-count overload, so it stays 1 sample even on a
 * multisampled context, and the software CLI surface can never be multisampled at
 * all.
 *
 * WHY IT RUNS IN BARE NODE. `CanvasKit.MakeSurface` — the SOFTWARE surface
 * `cli/render.js` renders on — reproduces the defect faithfully (measured min 163
 * of 255 inside a donut's ring). No browser, no GL, no puppeteer is needed to
 * catch this class, which is the same argument tests/vector_pattern_seam_test.js
 * makes for the pattern engine.
 *
 * WHAT IS ASSERTED, and note it is BOTH directions:
 *   1. NO SEAM: every interior pixel of the shape's solid body is at FULL
 *      coverage. Zero tolerance — see THE THRESHOLD below for why that is a
 *      measurement and not an aspiration.
 *   2. THE SHAPE IS STILL RIGHT: the donut's hole is empty, nothing spills
 *      outside the outer rim, and the inked area matches the analytic annulus.
 *      A blank frame would pass assertion 1 trivially.
 *   3. BOTH DONUT COPIES: `plugins/donut.js` (the parity baseline) and the
 *      SHIPPED `assets/builtin/library/donut.plugin.js`, resolved through the
 *      real registry. tests/builtin_asset_library_test.js already deep-equals
 *      their display lists; this asserts the seam PROPERTY on each, so a future
 *      drift cannot land the crack back in the widget users actually get.
 *   4. THE PICTURE AND THE HIT REGION AGREE, pixel for pixel. This is the
 *      property that DECIDED the fix's shape and it would otherwise be pinned
 *      nowhere. Two winding rules were measured and both gave zero seams and
 *      identical silhouettes, so the tie-break was that the keyhole form leaves
 *      `donutRingOutline` ONE flat point list which `emit` and `hitTest` both
 *      read — splitting it into [outer, inner] subpaths under even-odd would
 *      have made them two derivations of the same shape, free to drift.
 *   5. THE FILMSTRIP's perforated bands, which were the SAME defect at a larger
 *      scale and were left for a sibling task when 1-4 landed: a default 480x90
 *      strip emitted 480 `polygon` ops for two bands and cracked over 1 405 of
 *      3 332 band-interior pixels. They are now ONE even-odd `path` op.
 *
 * THE `polygon` OP IS NOT THE DEFECT AND IS NOT BANNED — that was measured, and
 * this note is here because the opposite conclusion is the obvious wrong one to
 * draw from these tests. One op is one shape: a LONE convex polygon has no
 * neighbour to conflate with, and per-op bounds is the correct gradient frame for
 * an op that IS a shape. Arrow heads, line caps, the video play glyphs and the
 * clock hands are each one polygon for one shape and are correct as they stand.
 * The sin is FAN-EMITTING ONE SHAPE ACROSS N OPS, which is what 1-5 above pin.
 * The structural companion to this file is tests/triangulated_paint_ban_test.js:
 * the ear-clipper that made those fans is no longer reachable from any paint path.
 */

import assert from "node:assert/strict";
import { createRequire } from "module";
import path from "path";
import { paintIR } from "../render_gpu/skia/paint_skia.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { donutPlugin, ringGeom } from "../plugins/donut.js";
import { fancyArrowPlugin } from "../plugins/fancy_arrow.js";
import { filmBandOps, filmstripGeom } from "../plugins/filmstrip.js";
import { fancyArrowOutline } from "../core/outline.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });
const fontCollection = (() => {
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(CanvasKit.TypefaceFontProvider.Make());
  return fc;
})();

const registry = createRegistry();
registerPlugins(registry);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

// ── THE PROBE FRAME ──────────────────────────────────────────────────────────
// Four sizes, because the defect's crack DEPTH is scale-invariant (measured
// 163-168 at all four) while its AREA FRACTION grows as the widget shrinks — a
// single size could not tell "fixed" from "too small to see".
const SIZES = [100, 200, 400, 600];
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
// Opaque white ink on opaque black: a seam then reads as a DARK cut in the red
// channel, and no alpha blending stands between the geometry and the number.
// (vector_pattern_seam_test.js makes the same choice for the same reason.)
const INK = "#ffffff";
const BACKGROUND = "#000000";
const FULL_COVERAGE = 255;
// A sanity floor for the hit-agreement census, not a tolerance on the result: only
// fully-inked and fully-blank pixels can be compared against a boolean hit test, and
// if the antialiased rim ever grew to more than a tenth of the frame the comparison
// would be measuring almost nothing. Measured at 300px: 98.2% decided.
const MIN_DECIDED_FRACTION = 0.9;

// ── THE THRESHOLD, DERIVED ───────────────────────────────────────────────────
// An interior pixel must be EXACTLY FULL_COVERAGE — no slack. That is a measured
// property of the fixed geometry, not a hope: a single antialiased fill assigns
// 255 to every pixel it fully covers, and the census below only ever looks at
// fully covered pixels (see INTERIOR_MARGIN_PX). It held at 0 seam pixels across
// all four sizes for both widgets and under both candidate winding rules. Slack
// would be actively harmful here: the defect's own signature is a shallow
// 192/255 dip, so a tolerance loose enough to be "safe" is loose enough to let
// the bug back in.
const SEAM_LEVEL = FULL_COVERAGE;

// The two flat terms of the census margin below. A single antialiased fill spreads
// its edge over at most ONE pixel, and one more pixel of slack means the gate can
// never fail on a boundary pixel it had no business examining. Both are widths, not
// tuning knobs — neither trades accuracy for pass rate, because a seam is 190-odd
// levels deep in the middle of a solid body, nowhere near an edge.
const ANTIALIASED_EDGE_PX = 1;
const CENSUS_SAFETY_PX = 1;

/**
 * Pure function. How far inside the shape's mathematical boundary a pixel must
 * sit before its coverage is guaranteed complete, in device px, for a rim of
 * radius `r` sampled as `segments` chords.
 *
 * Three terms, all real: ANTIALIASED_EDGE_PX, plus the chord SAGITTA
 * `r·(1 − cos(π/segments))` — the polygonal rim cuts INSIDE the ideal circle
 * between vertices, so the true ink boundary is that much further in than the
 * analytic radius the census uses — plus CENSUS_SAFETY_PX. A straight edge has no
 * sagitta term, so `segments` is omitted there.
 *
 * @example interiorMarginPx(0) // 2 (a straight edge: the AA pixel plus safety)
 * @example interiorMarginPx(300, 64) // 3 (a 300px rim in 64 chords bows ~0.36px inward)
 */
export function interiorMarginPx(r, segments = 0) {
  const sagitta = segments > 0 ? r * (1 - Math.cos(Math.PI / segments)) : 0;
  return Math.ceil(ANTIALIASED_EDGE_PX + sagitta + CENSUS_SAFETY_PX);
}

/** Query (allocates a surface). Paints `cmds` on the SOFTWARE surface and
 *  returns its RGBA8888 unpremultiplied bytes, `px` square. */
function renderPixels(cmds, px) {
  const surface = CanvasKit.MakeSurface(px, px);
  if (!surface) throw new Error("widget_fill_seam_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cmds, VIEW, { background: BACKGROUND, media: {}, fontCollection });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const bytes = img.readPixels(0, 0, {
    width: px, height: px,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  img.delete();
  surface.dispose();
  return bytes;
}

/**
 * Pure function. Censuses the red channel over the pixels `inside` accepts.
 *
 * @param {Uint8Array} bytes - RGBA8888 pixels, `px` square
 * @param {number} px - frame size
 * @param {(x: number, y: number) => boolean} inside - pixel-centre predicate
 * @returns {{min: number, below: number, n: number}} darkest level, count under
 *   full coverage, and how many pixels were examined
 *
 * @example // census(allWhite, 2, () => true) // {min: 255, below: 0, n: 4}
 */
function census(bytes, px, inside) {
  let min = FULL_COVERAGE, below = 0, n = 0;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const r = bytes[(y * px + x) * 4];
      n++;
      if (r < min) min = r;
      if (r < SEAM_LEVEL) below++;
    }
  }
  return { min, below, n };
}

/** Pure function. Count of pixels at or above half coverage — the shape's area.
 *
 * @example // inkedArea(allBlack, 2) // 0
 */
function inkedArea(bytes, px) {
  let n = 0;
  for (let i = 0; i < px * px; i++) if (bytes[i * 4] >= FULL_COVERAGE / 2) n++;
  return n;
}

/**
 * Pure function. The brightest red level over the pixels `inside` accepts — the
 * complement of `census`'s `min`, for asserting a region is BARE rather than solid.
 *
 * @param {Uint8Array} bytes - RGBA8888 pixels, `px` square
 * @param {number} px - frame size
 * @param {(x: number, y: number) => boolean} inside - pixel-centre predicate
 * @returns {number} 0 when no pixel in the region carries any ink at all
 *
 * @example // brightest(allBlack, 2, () => true) // 0
 */
function brightest(bytes, px, inside) {
  let max = 0;
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++)
      if (inside(x + 0.5, y + 0.5)) max = Math.max(max, bytes[(y * px + x) * 4]);
  return max;
}

/**
 * Pure function. The pixels strictly INSIDE the ink, by MORPHOLOGICAL EROSION: a
 * pixel qualifies when every pixel within Chebyshev distance `margin` of it carries
 * some ink at all. Returns a `px`-square 0/1 mask.
 *
 * WHY EROSION RATHER THAN AN ANALYTIC REGION, which is what the donut and arrow
 * censuses above use. Both are correct; they suit different shapes. A donut's census
 * region is two radii and a subtraction, so stating it analytically is short and
 * exact. A perforated film band's is a rectangle minus a row of rounded rectangles
 * whose count and pitch the geometry derives — restating that here would be a
 * HAND-MAINTAINED MIRROR of the code under test, free to drift from it, and the one
 * thing a mirror cannot catch is the case where both copies are wrong together.
 * Eroding the rendered ink asks the picture instead: it needs no geometry at all.
 *
 * The margin does the same job the analytic one does, by the same two terms — a
 * single antialiased fill spreads its edge over at most ANTIALIASED_EDGE_PX, plus
 * CENSUS_SAFETY_PX. There is no sagitta term because there is no analytic boundary
 * being approximated: the mask is derived from the ink that was actually laid down,
 * so a polygonal rim's inward bow is already in it.
 *
 * ANY INK (> 0) COUNTS AS INK, not half coverage. A seam is a shallow ~192/255 dip,
 * so a half-coverage threshold would keep seam pixels in the mask either way — but
 * an AA edge pixel at 250 would ALSO survive, and fail the census for being an edge.
 * Thresholding at "> 0" makes the erosion strictly wider than the shape's true
 * boundary, so every AA pixel is eroded away and only body is examined.
 *
 * @param {Uint8Array} bytes - RGBA8888 pixels, `px` square
 * @param {number} px - frame size
 * @param {number} margin - erosion radius in pixels
 * @returns {Uint8Array} `px * px` mask, 1 where the pixel is interior ink
 *
 * @example // a 4x4 frame fully inked, eroded by 1, leaves the middle 2x2:
 * @example // interiorInkMask(allWhite16px, 4, 1).reduce((a, b) => a + b) // 4
 */
function interiorInkMask(bytes, px, margin) {
  const inked = new Uint8Array(px * px);
  for (let i = 0; i < px * px; i++) inked[i] = bytes[i * 4] > 0 ? 1 : 0;
  // Separable: erode along x into `rows`, then along y. A square structuring element
  // is the product of its two 1-D passes, so this is the same result as the naive
  // (2·margin+1)² scan at a fraction of the work.
  const rows = new Uint8Array(px * px);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let all = 1;
      for (let d = -margin; d <= margin && all; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= px || !inked[y * px + xx]) all = 0;
      }
      rows[y * px + x] = all;
    }
  }
  const out = new Uint8Array(px * px);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let all = 1;
      for (let d = -margin; d <= margin && all; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= px || !rows[yy * px + x]) all = 0;
      }
      out[y * px + x] = all;
    }
  }
  return out;
}

// ── DONUT ────────────────────────────────────────────────────────────────────
// The two copies of the widget, driven identically. `plugins/donut.js` is the
// parity baseline; the registry's entry is the SHIPPED plugin asset.
const DONUT_COPIES = [
  ["plugins/donut.js (parity baseline)", donutPlugin],
  ["assets/builtin/library/donut.plugin.js (SHIPPED)", registry.get("donut")],
];
const DONUT_INNER = 0.5;
// donutOutline's rim tessellation (core/outline.js DONUT_SEGMENTS). Restated
// rather than imported because it is module-private there, and because the
// margin below only needs an UPPER bound on the chord bow: a finer real rim bows
// less, so the margin stays valid if that constant ever rises.
const DONUT_RIM_SEGMENTS = 64;
// How much of the ANALYTIC annulus the drawn ring must cover. It can never exceed
// it: both polygonal rims INSCRIBE their circles, so the drawn ring is a little
// smaller and never larger. One chord's bow bounds the shortfall at
// 1 − cos(π/64) ≈ 0.12% of the radius per rim, so 2% is that bound with two
// orders of magnitude of room — loose enough never to fail on tessellation, tight
// enough to refuse a ring that lost or gained a visible fraction of its body.
const MIN_RING_AREA_FRACTION = 0.98;

/** Pure function. A centred, stroke-free donut state filling a `px` frame.
 *
 * @example donutState(100).w // 100
 * @example donutState(100).strokeWidth // 0 (the fill is what this gate measures)
 */
function donutState(px) {
  return { ...donutPlugin.defaults, x: 0, y: 0, w: px, h: px, inner: DONUT_INNER, fill: INK, strokeWidth: 0, opacity: 1 };
}

for (const [label, plugin] of DONUT_COPIES) {
  test(`DONUT — no interior seam at ${SIZES.join("/")} px on the 1-sample software surface: ${label}`, () => {
    assert.ok(plugin, `${label} is not registered — the seam gate cannot measure a widget that does not exist`);
    for (const px of SIZES) {
      const s = donutState(px);
      const { cx, cy, rx } = ringGeom(s);
      const rIn = rx * DONUT_INNER;
      const margin = interiorMarginPx(rx, DONUT_RIM_SEGMENTS);
      const bytes = renderPixels(plugin.emit(s, null, { x: 0, y: 0, rotation: 0, scale: 1 }), px);
      const band = census(bytes, px, (x, y) => {
        const d = Math.hypot(x - cx, y - cy);
        return d > rIn + margin && d < rx - margin;
      });
      assert.ok(band.n > 0, `${px}px: the census region is empty — the probe, not the widget, is broken`);
      assert.equal(
        band.below, 0,
        `${label} at ${px}px: ${band.below}/${band.n} ring-interior pixels below full coverage (darkest ${band.min}). ` +
        "That is the abutting-antialiased-fill signature — this widget is emitting more than one fill op again.",
      );
    }
  });
}

test("DONUT — the hole is EMPTY, nothing spills past the rim, and the area is the analytic annulus", () => {
  // Assertion 1 is satisfied by a blank frame; these three are what make it mean
  // something. Tested on the SHIPPED asset — the picture a user actually gets.
  const plugin = registry.get("donut");
  for (const px of SIZES) {
    const s = donutState(px);
    const { cx, cy, rx } = ringGeom(s);
    const rIn = rx * DONUT_INNER;
    const margin = interiorMarginPx(rx, DONUT_RIM_SEGMENTS);
    const bytes = renderPixels(plugin.emit(s, null, { x: 0, y: 0, rotation: 0, scale: 1 }), px);
    const at = (x, y) => bytes[(Math.round(y) * px + Math.round(x)) * 4];

    const hole = census(bytes, px, (x, y) => Math.hypot(x - cx, y - cy) < rIn - margin);
    assert.equal(hole.min, 0, `${px}px: the hole is not empty (brightest interior sample ${hole.min}) — the winding rule stopped punching it`);
    assert.equal(at(1, 1), 0, `${px}px: ink outside the outer rim — the outline's bridge or its close is leaking`);

    const ideal = Math.PI * (rx ** 2 - rIn ** 2);
    const area = inkedArea(bytes, px);
    assert.ok(area <= ideal, `${px}px: inked ${area} > analytic annulus ${Math.round(ideal)} — the fill escaped its outline`);
    assert.ok(area >= ideal * MIN_RING_AREA_FRACTION, `${px}px: inked only ${area} of an analytic ${Math.round(ideal)} — the ring lost body`);
  }
});

test("DONUT — the picture and the HIT REGION agree pixel for pixel (why the keyhole form was kept)", () => {
  const plugin = registry.get("donut");
  const px = 300;
  const s = donutState(px);
  const bytes = renderPixels(plugin.emit(s, null, { x: 0, y: 0, rotation: 0, scale: 1 }), px);
  // Only FULLY covered and FULLY uncovered pixels are compared. The antialiased
  // rim is where a boolean boundary test is entitled to differ from a coverage
  // measurement, so including it would assert something untrue about both.
  let disagreed = 0, decided = 0;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const r = bytes[(y * px + x) * 4];
      if (r !== 0 && r !== FULL_COVERAGE) continue;
      decided++;
      if ((r === FULL_COVERAGE) !== plugin.hitTest(s, x + 0.5, y + 0.5)) disagreed++;
    }
  }
  assert.ok(decided >= px * px * MIN_DECIDED_FRACTION, `only ${decided}/${px * px} pixels were fully decided — the probe is measuring rim, not body`);
  assert.equal(disagreed, 0, `${disagreed}/${decided} pixels are inked-but-unclickable or clickable-but-blank — emit and hitTest have stopped reading the same geometry`);
});

// ── FANCY ARROW ──────────────────────────────────────────────────────────────
// Its outline is ONE closed 7-point loop, concave at the dimple. The census
// region is the SHAFT's solid core: inside the tail, short of the head's base,
// and within the shaft's own half-width — a region with no boundary of the
// shape's in it, which is exactly where the ear-clip diagonals used to run.
const ARROW_SHAPE = { tipLength: 60, tipWidth: 70, tipDimple: 18, startWidth: 14, endWidth: 34 };

test(`FANCY ARROW — no seam across the shaft at ${SIZES.join("/")} px`, () => {
  const margin = interiorMarginPx(0);
  for (const px of SIZES) {
    const ends = { x0: px * 0.1, y0: px / 2, x1: px * 0.9, y1: px / 2 };
    const s = {
      ...fancyArrowPlugin.defaults,
      from: { x: ends.x0, y: ends.y0 }, to: { x: ends.x1, y: ends.y1 },
      ...ARROW_SHAPE, fill: INK, strokeWidth: 0, opacity: 1,
    };
    const outline = fancyArrowOutline({ ...ends, ...ARROW_SHAPE });
    assert.ok(outline, `${px}px: the generator produced no outline — the probe is misconfigured`);
    const tailX = Math.min(...outline.map((p) => p[0]));
    const headBaseX = ends.x1 - ARROW_SHAPE.tipLength;
    const bytes = renderPixels(fancyArrowPlugin.emit(s, null, { x: 0, y: 0, rotation: 0, scale: 1 }), px);
    const shaft = census(bytes, px, (x, y) =>
      x > tailX + margin && x < headBaseX - margin &&
      Math.abs(y - px / 2) < ARROW_SHAPE.startWidth / 2 - margin);
    assert.ok(shaft.n > 0, `${px}px: the census region is empty — the probe, not the widget, is broken`);
    assert.equal(
      shaft.below, 0,
      `${px}px: ${shaft.below}/${shaft.n} shaft-interior pixels below full coverage (darkest ${shaft.min}). ` +
      "That is the abutting-antialiased-fill signature — the arrow is emitting more than one fill op again.",
    );
    // And it still draws an arrow: the tip is inked, the corner is not.
    assert.ok(bytes[(Math.round(px / 2) * px + Math.round(ends.x1 - 2)) * 4] > 0, `${px}px: the tip is blank`);
    assert.equal(bytes[(1 * px + 1) * 4], 0, `${px}px: ink in the corner — the fill escaped its outline`);
  }
});

// ── FILMSTRIP ────────────────────────────────────────────────────────────────
// The same defect as the donut's, at a larger scale and with a real hole pattern
// rather than one bridge. `filmBandOps` used to slice each band into one COLUMN per
// perforation and tessellate every column into quads around its hole: 480 `polygon`
// ops for a default 480x90 strip. It is now ONE `path` op — the band rectangles plus
// one closed loop per hole, filled even-odd.
//
// THE BANDS ARE PAINTED ALONE, not through filmstripPlugin.emit. emit() lays a
// contentRect of the SAME filmColor between the bands and per-frame media on top,
// and a same-coloured neighbour would fill the very cracks this measures — testing
// through emit() would be the WEAKER test, not the more realistic one.
const FILM_SIZES = [[240, 45], [480, 90], [960, 180]];
// A frame count for the probe strips. The perforation PITCH is derived from the frame
// step (perforationPitch: the holes lock to the pictures), so the count is part of the
// geometry under test rather than decoration; three is the smallest count that gives a
// leader, interior frames and a tail.
const FILM_PROBE_FRAMES = 3;
// What fraction of the UNPERFORATED band pair's ink must survive perforation. The
// reference is the widget's own `perforate: false` render rather than the analytic
// rectangle area, because a band is a few pixels tall and the analytic area is not a
// whole number of them: at 240x45 the bands are 5.65 px, so pixel quantization alone
// puts the solid render 0.6% ABOVE the arithmetic — an analytic ceiling read that as
// "the holes stopped being holes". Comparing render to render cancels that exactly.
// Bounded below by "the band did not vanish" and above by "the holes were not filled
// in"; measured 0.87-0.97 of solid across the three sizes, the smaller strip losing
// proportionally less because its holes shrink faster than its band.
const BAND_INK_MIN_FRACTION = 0.5;
const BAND_INK_MAX_FRACTION = 0.99;

test(`FILMSTRIP — the perforated bands have no interior seam at ${FILM_SIZES.map(([w]) => w).join("/")} px`, () => {
  const margin = interiorMarginPx(0);
  for (const [w, h] of FILM_SIZES) {
    const geom = filmstripGeom({ w, h, vertical: false }, FILM_PROBE_FRAMES);
    const ops = filmBandOps(geom, INK, 1, true);
    const bytes = renderPixels(ops, w);
    const mask = interiorInkMask(bytes, w, margin);
    const band = census(bytes, w, (x, y) => mask[Math.floor(y) * w + Math.floor(x)] === 1);
    assert.ok(band.n > 0, `${w}x${h}: the census region is empty — the probe, not the widget, is broken`);
    assert.equal(
      band.below, 0,
      `${w}x${h}: ${band.below}/${band.n} band-interior pixels below full coverage (darkest ${band.min}). ` +
      "That is the abutting-antialiased-fill signature — the bands are being emitted as more than one fill op again.",
    );
  }
});

test("FILMSTRIP — the holes are still punched, the film between the bands is still bare", () => {
  // Assertion 1 is satisfied by a solid band AND by a blank frame; these are what make
  // it mean something. A wrong winding rule is the specific failure they catch: under
  // non-zero with same-wound loops the holes fill in, and the seam census would pass.
  for (const [w, h] of FILM_SIZES) {
    const geom = filmstripGeom({ w, h, vertical: false }, FILM_PROBE_FRAMES);
    const bytes = renderPixels(filmBandOps(geom, INK, 1, true), w);
    const solid = inkedArea(renderPixels(filmBandOps(geom, INK, 1, false), w), w);
    const area = inkedArea(bytes, w);
    assert.ok(solid > 0, `${w}x${h}: the unperforated reference render is blank — the probe is broken`);
    assert.ok(
      area >= solid * BAND_INK_MIN_FRACTION,
      `${w}x${h}: inked only ${area} of the unperforated band pair's ${solid} — the bands lost body`,
    );
    assert.ok(
      area < solid * BAND_INK_MAX_FRACTION,
      `${w}x${h}: inked ${area} of the unperforated band pair's ${solid} — the perforations stopped being holes, ` +
      "which is exactly what a non-zero fill rule does to loops that share the band's winding",
    );
    // Nothing between the bands: that gap is where emit() puts the frames, and film
    // spilling into it would put band ink under every picture.
    const inGap = (x, y) => y > geom.bandA.y + geom.bandA.h + 1 && y < geom.bandB.y - 1;
    assert.ok(census(bytes, w, inGap).n > 0, `${w}x${h}: no gap between the bands to measure — the probe is misconfigured`);
    assert.equal(
      brightest(bytes, w, inGap), 0,
      `${w}x${h}: the strip's middle is inked — a band subpath escaped its rectangle`,
    );
  }
});

console.log(`\nwidget fill seam tests: ${passed} passed`);
