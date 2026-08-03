/**
 * THE SKY'S TWO SCREEN-SPACE LAWS — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/sky_star_seam_test.js
 *
 * ── LAW 1 (R6-9.1): THE STAR FIELD DOES NOT KNOW HOW BIG ITS BOX IS ───────────
 *
 * User: "stars STRETCH when the sky is stretched. They need their own scale,
 * controllable with respect to pixel space, independent of the widget box."
 *
 * The lattice used to live in the dome's (azimuth, elevation) parameter plane,
 * which sounds angular but is not: the box→dome map is AFFINE in both axes, so it
 * was really an anisotropic lattice in BOX coordinates. Stars therefore came out
 * as ellipses whose eccentricity WAS the box aspect. MEASURED at HEAD before the
 * fix, median star blob w/h: 1.50 square, 5.00 in a 3:1 box (predicted 4.97 from
 * AZ_SPAN·(1−horizon)·halfH/(PI·halfW)), 0.67 in a 1:3 box. After: 1.00, 1.00, 1.00.
 *
 * Two halves are asserted, because "round" alone would still allow a field that
 * rescales with the box:
 *   (a) ROUNDNESS — the median blob is square at every aspect.
 *   (b) BOX INDEPENDENCE — growing the box about its own centre, with the CAMERA
 *       unchanged, leaves the overlapping region BYTE-IDENTICAL. The lattice is a
 *       length in page px anchored on the box centre, so a bigger box can only
 *       show MORE of the same field. This is the strong form of the user's
 *       requirement and nothing weaker implies it.
 *
 * (b) IS A STATEMENT ABOUT STARS ALONE, and the fixture earns that rather than
 * assuming it. The Milky Way is off, the night colour is black and there is NO sun,
 * so the day term is zero and the frame is night + stars + ground. THE TWO BOXES
 * SHARE A HEIGHT and differ only in width, which is what makes the rest of the
 * shader cancel exactly: every remaining term (the horizon mask, the ground mask,
 * the airmass, the night colour) is a function of the box-normalized VERTICAL
 * coordinate alone, so at a given device row it is identical in both renders.
 * Widening the box changes only the horizontal mapping — which, after the fix, no
 * term reads at all. Any surviving difference is therefore the star field.
 *
 * ── LAW 2 (R6-9.2): THE GALAXY HAS NO DISCONTINUITY AT ANY TIME OF DAY ───────
 *
 * TWO defects, two statistics, because they have different SHAPES.
 *
 * 2b, AND IT IS THE BIGGER ONE: the band mask read
 * `exp(-pow(dot(rdN, galAxis), 2.0) / …)`, and `pow(x, y)` IS UNDEFINED FOR x < 0
 * in SkSL. dot(rdN, galAxis) is the SIGNED sine of galactic latitude, so the whole
 * negative-latitude half of the sky rendered with NO Milky Way, bounded by a hard
 * arc where it crosses zero. Squaring by multiplication fixes it. A column-wise
 * statistic barely sees a curve, so this one is measured as the largest per-pixel
 * gradient over the frame's 99th percentile: MEASURED on this fixture, 41.0 and
 * 47.8 broken against 1.8–3.1 fixed, and 2.8/3.4 broken at the two times of day
 * whose arc misses the box — which is the control that the statistic is not simply
 * always high.
 *
 * The Milky-Way mottling was 2D fbm over (atan(rd.x, rd.z), asin(rd.y)), and
 * atan2's branch cut at ±PI is a hard discontinuity in that domain. Invisible
 * while the sky looks straight ahead — the box spans only ±AZ_SPAN = ±1.65 rad —
 * but timeOfDay ROTATES the direction before the projection, so the cut SWEEPS
 * ACROSS THE BOX.
 *
 * MEASURED at HEAD, 900×500, with the offending column landing within 1 px of the
 * predicted phi = timeOfDay·TWO_PI − PI every time (0.25→21, 0.35→192, 0.5→449,
 * 0.6→620, 0.7→792, 0.75→877). That range includes the 0.7 that FIVE OF THE SIX
 * shipped sky presets use. On THIS fixture the column statistic reads 22.5 and 24.3
 * broken against 1.09–1.16 fixed, and 1.11–1.23 broken outside the range.
 *
 * THE STATISTIC. For each column, the mean |Δluma| against its right neighbour;
 * the score is the LARGEST of those divided by their 99th percentile. A branch cut
 * is a step the rest of the frame never produces, so it towers over p99; a steep
 * but smooth gradient (the band's own edge, the horizon) sits right at it. Judging
 * against the MEDIAN instead was tried and rejected — most columns of a night sky
 * are empty, so the median measures the emptiness and every frame scores high.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { paintIR } from "../skia/paint_skia.js";
import { deserialize, repairedDocument, foldState } from "../../core/document.js";
import { evaluateState } from "../../core/expressions.js";
import { createRegistry } from "../../core/registry.js";
import { createCommands } from "../../core/commands.js";
import { registerAll } from "../../plugins/index.js";
import { cameraRect } from "../../core/derive.js";
import { fitRectView } from "../../core/view.js";
import { cameraFrameIR } from "../../web/cameraFrame.js";
import { committedFaces, FALLBACK_FACES } from "../fonts.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const BIN_DIR = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fonts");

// A star's blob is a few px across, so the roundness measurement needs the stars
// resolved: these are the smallest frames at which the three aspects still yield
// enough blobs to take a median over.
const ROUND_FRAMES = [[420, 420], [840, 280], [280, 840]];
const STAR_LUMA_THRESHOLD = 40;  // above the night sky (which is pure black in this fixture)
const MIN_BLOB_PX = 4;           // ignore single-pixel specks: their aspect is always 1 and says nothing
const MIN_BLOBS = 6;             // a median over fewer than this is not a median
// Measured 1.00 at all three aspects after the fix, 0.67 / 1.50 / 5.00 before.
const ROUND_LO = 0.8, ROUND_HI = 1.25;

// LAW 1(b): the same camera, two box sizes about one centre.
const BOX_FRAME_W = 480, BOX_FRAME_H = 240;
const SMALL_BOX = 240, BIG_BOX_W = 480, BIG_BOX_H = 240;
const OVERLAP_MARGIN = 6;        // skip the smaller box's own AA boundary

// LAW 2a (the atan2 seam): measured 22.5–24.3 broken, 1.09–1.16 fixed, on this fixture.
// LAW 2b (the pow hard arc): measured 41.0–47.8 broken, 1.8–3.1 fixed, on this fixture.
const SEAM_W = 720, SEAM_H = 200;
const SEAM_RATIO_MAX = 3;
const EDGE_RATIO_MAX = 8;
// The widget's own AA boundary is a legitimate one-column step; it is not a seam.
const SEAM_EDGE_SKIP = 4;
// Inside the sweep, 0.25…0.75 are the timeOfDay values whose branch cut fell INSIDE
// the box; 0 and 0.95 are outside it and are the control that the statistic is not
// simply always high.
const SEAM_TIMES = [0, 0.5, 0.7, 0.95];
// THE SIGNAL FLOOR (BM). Both statistics are RATIOS against the frame's own 99th
// percentile, so they are only meaningful while there is a band in the frame to
// measure: divide a quantization step by a p99 that has collapsed to nothing and any
// frame scores high. That case is now REACHABLE, and it is correct behaviour rather
// than a defect. The Milky Way is a great circle at a fixed angle to the celestial
// pole, so once BM made the dome turn about that pole (instead of about the zenith,
// which kept the band permanently in view) the band genuinely swings out of a fixed
// window and back, exactly as the real one does over a night. MEASURED at 700×700 on
// the GALAXY_ONLY fixture, mean luma by timeOfDay: 9.13 at 0, 16.33 at 0.25, 2.57 at
// 0.5, 0.15 at 0.7, 6.64 at 0.95 — and at 0.7 the peak pixel is 7/255, i.e. the band
// is off-frame. Its "hard edge" there reads 1 against a p99 of 0.1: noise over noise.
// So a time whose frame carries no band is SKIPPED and SAID SO, rather than being
// silently tolerated by loosening EDGE_RATIO_MAX for everybody — which would have
// blinded the check at the times when it can actually see something.
const BAND_MEAN_LUMA_MIN = 1.0;

const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(BIN_DIR, f) });

/** Query→build (reads font files). The shared FontCollection (node_render.js recipe). */
function buildFontCollection() {
  const provider = CanvasKit.TypefaceFontProvider.Make();
  for (const { family, file } of [...committedFaces().map((f) => ({ family: f.cssFamily, file: f.file })), ...FALLBACK_FACES]) {
    const p = path.join(FONTS_DIR, file);
    if (fs.existsSync(p)) provider.registerFont(fs.readFileSync(p), family);
  }
  const fc = CanvasKit.FontCollection.Make();
  fc.setDefaultFontManager(provider);
  fc.enableFontFallback();
  return fc;
}
const fontCollection = buildFontCollection();
const registry = createRegistry();
registerAll(registry, createCommands());

/** Pure function. Plugin defaults + overrides (real params, never a mirrored fixture). */
const def = (type, over) => ({ ...registry.get(type).defaults, type, active: true, ...over });

/** The knobs that leave the STAR FIELD as the only thing in the frame — see the header. */
const STARS_ONLY = { milkyWay: 0, night: "#000000" };
/** The mirror image: the GALAXY alone, cranked. Stars off; the horizon pushed far
 *  below the box so the ground's own (legitimate) hard edge is not in frame eating
 *  the headroom of a statistic that is looking for illegitimate ones. */
const GALAXY_ONLY = { milkyWay: 3, starDensity: 0, night: "#000000", horizon: -3 };

/** Query→build. A one-slide doc: a camera of (frameW, frameH) and one sky box. */
function skyDoc(frameW, frameH, box, over) {
  return {
    meta: { name: "sky-laws", slideW: frameW, slideH: frameH },
    slides: [{
      id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: def("camera", { name: "Camera", x: 0, y: 0, w: frameW, h: frameH, z: 1000, background: "#000000" }),
          sky: def("sky", { name: "SKY", z: 10, ...box, ...over }),
        },
      },
    }],
  };
}

/** Command. Renders a doc at frameW×frameH on a fresh software surface; returns RGBA pixels. */
function render(rawDoc, frameW, frameH) {
  const { doc } = repairedDocument(deserialize(JSON.stringify(rawDoc)), registry);
  const state = evaluateState(foldState(doc, 0, 1), registry).state;
  const rect = cameraRect(state, doc.meta);
  const surface = CanvasKit.MakeSurface(frameW, frameH);
  if (!surface) throw new Error("sky_star_seam_test: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), cameraFrameIR(state, doc.meta, registry), fitRectView(rect, frameW, frameH, 1),
    { fontCollection, background: rect.background, makeSurface: (w, h) => CanvasKit.MakeSurface(w, h) });
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: frameW, height: frameH, colorType: CanvasKit.ColorType.RGBA_8888, alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB });
  img.delete();
  surface.dispose();
  return px;
}

/**
 * Pure function. Rec.709 luma of pixel `i` of an RGBA buffer.
 *
 * @example luma(new Uint8Array([255, 255, 255, 255]), 0) // 255
 * @example luma(new Uint8Array([0, 0, 0, 255]), 0) // 0
 */
function luma(px, i) { return 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]; }

/**
 * Pure function. The median WIDTH/HEIGHT of the connected components brighter than
 * `thr` — a star's blob shape, which is 1 when stars are round and the box aspect
 * (times a constant) when they are not.
 *
 * @param {Uint8Array} px - RGBA buffer, `W`×`H`
 * @returns {{n: number, median: number|null}} blob count and their median w/h
 *
 * @example // a 3x3 square of white on black, W=5 H=5 =>
 * // {n: 1, median: 1}
 * @example // a 6x2 bar of white on black =>
 * // {n: 1, median: 3}
 */
function blobAspects(px, W, H, thr) {
  const seen = new Uint8Array(W * H);
  const aspects = [];
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || luma(px, i) < thr) continue;
    let x0 = i % W, x1 = x0, y0 = (i / W) | 0, y1 = y0, n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(); n++;
      const x = j % W, y = (j / W) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - W, j + W]) {
        if (k < 0 || k >= W * H || seen[k]) continue;
        if (Math.abs((k % W) - x) > 1) continue; // do not wrap a row
        if (luma(px, k) < thr) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    if (n >= MIN_BLOB_PX) aspects.push((x1 - x0 + 1) / (y1 - y0 + 1));
  }
  aspects.sort((a, b) => a - b);
  return { n: aspects.length, median: aspects.length ? aspects[aspects.length >> 1] : null };
}

/**
 * Pure function. The seam statistic: the largest column-to-column luma step in the
 * frame, over the 99th percentile of those steps. See the header for why p99 and
 * not the median.
 *
 * @param {Uint8Array} px - RGBA buffer, `W`×`H`
 * @returns {{ratio: number, at: number, max: number, p99: number}}
 *
 * @example // a smooth horizontal gradient => ratio ≈ 1 (every column steps alike)
 * @example // the same gradient with one column replaced by black => ratio >> 1
 */
function seamScore(px, W, H) {
  const d = [];
  for (let x = SEAM_EDGE_SKIP; x < W - 1 - SEAM_EDGE_SKIP; x++) {
    let s = 0;
    for (let y = 0; y < H; y++) s += Math.abs(luma(px, y * W + x) - luma(px, y * W + x + 1));
    d.push(s / H);
  }
  const sorted = [...d].sort((a, b) => a - b);
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))];
  let max = 0, at = -1;
  d.forEach((v, k) => { if (v > max) { max = v; at = k + SEAM_EDGE_SKIP; } });
  return { ratio: max / Math.max(p99, 1e-9), at, max, p99 };
}

/**
 * Pure function. The hard-edge statistic: the largest per-pixel luma gradient in the
 * frame, over the 99th percentile of those gradients. Orientation-free, unlike
 * seamScore — which is why it exists: the second galaxy defect was an ARC, and a
 * column-wise statistic barely sees a curve.
 *
 * @param {Uint8Array} px - RGBA buffer, `W`×`H`
 * @returns {{ratio: number, max: number, p99: number}}
 *
 * @example // a smooth radial falloff => ratio ≈ 2 (the steepest pixel is like its peers)
 * @example // the same falloff clipped to zero over half the frame => ratio >> 10
 */
function hardEdgeScore(px, W, H) {
  const g = [];
  for (let y = SEAM_EDGE_SKIP; y < H - SEAM_EDGE_SKIP; y++)
    for (let x = SEAM_EDGE_SKIP; x < W - 1 - SEAM_EDGE_SKIP; x++) {
      const i = y * W + x;
      g.push(Math.max(Math.abs(luma(px, i) - luma(px, i + 1)), Math.abs(luma(px, i) - luma(px, i + W))));
    }
  g.sort((a, b) => a - b);
  const p99 = g[Math.min(g.length - 1, Math.floor(0.99 * g.length))];
  return { ratio: g[g.length - 1] / Math.max(p99, 1e-9), max: g[g.length - 1], p99 };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

console.log("sky screen-space laws:");

// ── LAW 1(a): stars are ROUND at every box aspect ────────────────────────────
test("stars are round at every box aspect (R6-9.1: they used to be the box's own ellipse)", () => {
  for (const [W, H] of ROUND_FRAMES) {
    const px = render(skyDoc(W, H, { x: 0, y: 0, w: W, h: H }, { ...STARS_ONLY, timeOfDay: 0.2 }), W, H);
    const b = blobAspects(px, W, H, STAR_LUMA_THRESHOLD);
    assert.ok(b.n >= MIN_BLOBS, `${W}×${H}: only ${b.n} star blobs found — the fixture is not showing stars, so this check is measuring nothing`);
    assert.ok(b.median >= ROUND_LO && b.median <= ROUND_HI,
      `${W}×${H} (box aspect ${(W / H).toFixed(2)}): median star blob is ${b.median.toFixed(2)} wide per unit tall, outside [${ROUND_LO}, ${ROUND_HI}] — the star lattice is tracking the box's aspect again`);
  }
});

// ── LAW 1(b): growing the box shows MORE stars, not BIGGER ones ──────────────
test("growing the box about its centre leaves the overlapping stars byte-identical", () => {
  const cx = BOX_FRAME_W / 2, cy = BOX_FRAME_H / 2;
  const small = { x: cx - SMALL_BOX / 2, y: cy - SMALL_BOX / 2, w: SMALL_BOX, h: SMALL_BOX };
  const big = { x: cx - BIG_BOX_W / 2, y: cy - BIG_BOX_H / 2, w: BIG_BOX_W, h: BIG_BOX_H };
  const over = { ...STARS_ONLY, timeOfDay: 0.2 };
  const a = render(skyDoc(BOX_FRAME_W, BOX_FRAME_H, small, over), BOX_FRAME_W, BOX_FRAME_H);
  const b = render(skyDoc(BOX_FRAME_W, BOX_FRAME_H, big, over), BOX_FRAME_W, BOX_FRAME_H);
  const x0 = Math.round(small.x) + OVERLAP_MARGIN, x1 = Math.round(small.x + small.w) - OVERLAP_MARGIN;
  const y0 = Math.round(small.y) + OVERLAP_MARGIN, y1 = Math.round(small.y + small.h) - OVERLAP_MARGIN;
  let differing = 0, maxDelta = 0, lit = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * BOX_FRAME_W + x;
      if (luma(a, i) >= STAR_LUMA_THRESHOLD) lit++;
      for (let c = 0; c < 4; c++) {
        const dch = Math.abs(a[i * 4 + c] - b[i * 4 + c]);
        if (dch !== 0) { differing++; if (dch > maxDelta) maxDelta = dch; }
      }
    }
  }
  assert.ok(lit >= MIN_BLOBS, `only ${lit} lit pixels in the overlap — the fixture is not showing stars, so this check is measuring nothing`);
  assert.equal(differing, 0,
    `${differing} bytes differ (max ${maxDelta}) between a ${SMALL_BOX}×${SMALL_BOX} sky and a ${BIG_BOX_W}×${BIG_BOX_H} one sharing a centre and a camera — the star field is still a function of the box's size, so resizing the widget rescales the stars instead of revealing more of them`);
});

// ── LAW 2: no galaxy seam at any time of day ─────────────────────────────────
test("the Milky Way has no seam and no hard edge at any time of day (R6-9.2)", () => {
  const worst = [], scores = [];
  let measured = 0;
  for (const tod of SEAM_TIMES) {
    const px = render(skyDoc(SEAM_W, SEAM_H, { x: 0, y: 0, w: SEAM_W, h: SEAM_H }, { ...GALAXY_ONLY, timeOfDay: tod }), SEAM_W, SEAM_H);
    // Is there a band in this frame at all? See BAND_MEAN_LUMA_MIN — after BM the dome
    // turns about the celestial pole, so the band swings out of the window and back.
    let sum = 0;
    for (let i = 0; i < SEAM_W * SEAM_H; i++) sum += luma(px, i);
    const meanLuma = sum / (SEAM_W * SEAM_H);
    if (meanLuma < BAND_MEAN_LUMA_MIN) {
      scores.push(`${tod}:off-frame(${meanLuma.toFixed(2)})`);
      continue;
    }
    measured++;
    const s = seamScore(px, SEAM_W, SEAM_H);
    const e = hardEdgeScore(px, SEAM_W, SEAM_H);
    scores.push(`${tod}:${s.ratio.toFixed(2)}/${e.ratio.toFixed(1)}`);
    if (s.ratio > SEAM_RATIO_MAX) worst.push(`timeOfDay ${tod}: a VERTICAL step ${s.ratio.toFixed(1)}× p99 at column ${s.at} — the atan2 branch cut is back in the noise domain (it tracks timeOfDay·TWO_PI − PI)`);
    if (e.ratio > EDGE_RATIO_MAX) worst.push(`timeOfDay ${tod}: a HARD EDGE, gradient ${e.max.toFixed(0)} against a 99th percentile of ${e.p99.toFixed(1)} — something is clipping the band along a curve, the way pow(gLat, 2.0) did by being undefined for gLat < 0`);
  }
  console.log(`      column-step / hard-edge statistic by timeOfDay (limits ${SEAM_RATIO_MAX} / ${EDGE_RATIO_MAX}): ${scores.join("  ")}`);
  // A sweep that skipped EVERY time would assert nothing while printing green, which is
  // the failure mode the signal floor could introduce if the band ever stopped rendering.
  assert.ok(measured >= 2,
    `only ${measured} of ${SEAM_TIMES.length} times had a band in frame — the seam statistic measured almost nothing, so this check is not testing the galaxy any more`);
  assert.equal(worst.length, 0,
    `${worst.length} discontinuit(ies) across ${measured} measured times of day:\n  ${worst.join("\n  ")}`);
});

// ── the new capability: star SIZE is independent of star DENSITY ─────────────
test("starSize is independent of starDensity (the coupling R6-9.1 asked to break)", () => {
  const [W, H] = ROUND_FRAMES[0];
  const box = { x: 0, y: 0, w: W, h: H };
  const sparse = blobAspects(render(skyDoc(W, H, box, { ...STARS_ONLY, starDensity: 40 }), W, H), W, H, STAR_LUMA_THRESHOLD);
  const dense = blobAspects(render(skyDoc(W, H, box, { ...STARS_ONLY, starDensity: 80 }), W, H), W, H, STAR_LUMA_THRESHOLD);
  assert.ok(dense.n > sparse.n, `doubling starDensity gave ${dense.n} blobs against ${sparse.n} — density must add stars`);
  const bigger = blobAspects(render(skyDoc(W, H, box, { ...STARS_ONLY, starDensity: 40, starSize: 2.5 }), W, H), W, H, STAR_LUMA_THRESHOLD);
  assert.ok(bigger.n >= sparse.n,
    `raising starSize alone dropped the blob count from ${sparse.n} to ${bigger.n} — size must not remove stars, which is exactly what the old single-grid coupling did`);
});

console.log(`\nPASS: sky screen-space laws (${passed} checks)`);
