/**
 * THE GEOMETRIC-SHAPE PRESET GATE — bare node, real Skia, real pixels.
 * Run: node src/demo_apps/PowerRP/tests/shape_presets_test.js
 *
 * Covers `polygon`, `donut`, `circle` (two families) and the ten shapeshifter
 * families listed below. Every subject here is PURE VECTOR — path, polyline,
 * ellipse — which is exactly what cli/render.js's software Skia surface exists
 * for, so this needs no Chrome and carries no capture-hang risk.
 * tests/arrow_presets_test.js is the structural template.
 *
 * ── WHAT IT PROVES ───────────────────────────────────────────────────────────
 *  1. No two presets in a family render the same picture, and none renders the
 *     same picture as the widget's own UNTOUCHED DEFAULT (ledger C-16: a preset
 *     that reproduces the default is a dead row, and no preset-vs-preset
 *     comparison can see it because the default is not a preset). Two real dead
 *     rows were found this way during authoring and cut — see the plugin files.
 *  2. Every preset in a family writes the IDENTICAL key set. Application is an
 *     OVERLAY, so a key one row omits keeps whatever the previously HOVERED row
 *     left behind; in a family with an on/off switch in it (`closed`, a
 *     transparent fill, a round cap) that is not a subtlety, it is a wrong
 *     picture.
 *  3. The circle's ARC family is stamped at the seam that really stamps it.
 *
 * ── (3) THE METHODOLOGICAL TRAP, because it nearly cost this file its point ──
 * `circle.emit()` does NOT apply the stroke-trim window. render_gpu/ports.js does,
 * for every node, AFTER emit(). So a bare `plugin.emit()` comparison of seven arc
 * presets returns seven IDENTICAL full rings and would report the whole family
 * dead. This file calls the same three stamps ports.js does, in the same order.
 *
 * ── THE REDUCTION IS CHOSEN PER FAMILY, AND MEASURED, NOT PICKED BY REPUTATION ─
 * `litSetDistance` restricts the comparison to pixels either frame inks, which is
 * the right answer for a THIN subject whose coverage is roughly CONSTANT across
 * the family. It is the WRONG answer when the coverage itself moves with the
 * knob, because then it renormalises every frame by a different divisor and the
 * ranking inverts. Measured on `donut`: a pair I reject by eye (`inner` 0.2 vs
 * 0.219, two nearly identical holes) reads 2.70 lit levels while an obviously
 * different pair (0.024 vs 0.125, a pinprick against a hole) reads 1.53, and at
 * the thin end 0.92 vs 0.94 reads 62.3 — the lit set has collapsed to the rim.
 * Same inversion on the circle's RING family: strokeWidth 6 vs 7 on an unfilled
 * ring reads 31.0 while the default against a solid dot reads 5.81.
 *
 * So: `polygon` and the arc family use the lit set (coverage is stable), the ring
 * family uses the whole frame, and `donut` is gated GEOMETRICALLY plus the pixel
 * floor — see ringSeparation.
 *
 * ── EVERY BOUND SITS BETWEEN TWO MEASURED ANCHORS ────────────────────────────
 * The shared module ships only the derivable floor (one 8-bit code value). "Far
 * enough apart to be worth a separate row" is a judgement, so each family below
 * carries a pair it REJECTS and the narrowest pair it KEEPS, both measured on
 * this fixture, with the bound between them.
 *
 * ── THE FRAME MUST CONTAIN THE SHAPE, AND THE BOX MUST BE THE AUTHORED ONE ───
 * A bound measured on a CLIPPED subject is a bound on the fixture, not on the
 * family, and it reads exactly like a tight family — which is how ss_banner came
 * to carry a bound of 2. Its outward forks (negative notchDepth) span −0.45·w to
 * 1.45·w, so at the default box "Outward Fork" and "Sharp Outward Points" had
 * their whole left flare off-canvas and met the gate on a 40px band: a measured
 * 2.78 that was an artifact of the crop. So a family whose geometry leaves its
 * box declares its own `world` (the rect the camera frames) — the shape shrinks,
 * every pixel of it is present, and the number means what it says.
 *
 * The same applies to the BOX. ss_callout's tail tip is stored in absolute
 * box-local pixels, and every one of its presets picked those numbers against the
 * plugin's own 200×200 seed (plugins/shapeshifter.js says so at its defaults).
 * Rendered at the 280×280 default box, `tailY: 220` lands 1.6px below a body that
 * now ends at 218.4 — a tail nobody authored, and two presets differing only in
 * tail width collapse onto each other. It declares `box` and is measured where it
 * was drawn. A family whose knobs are all FRACTIONS of the box (every other one
 * here) is scale-free and needs neither override.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, imageDistance, litSetDistance, indistinguishable } from "./imageDistinctness.js";
import { applyStrokeTrim, applyStrokeOffset, applyStrokeJoin } from "../render_gpu/ir.js";
import { fitRectView } from "../core/view.js";
import { presetFamiliesOf } from "../core/registry.js";
import { builtinRoster } from "../plugins/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const roster = builtinRoster();
const W = 320;
const WORLD = { x: 0, y: 0, w: W, h: W };     // the world rect the camera frames
const VIEW = fitRectView(WORLD, W, W);
const BOX = { x: 0, y: 0, w: 280, h: 280 };   // the subject, inset in the canvas
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
// An empty scene is the background everywhere, so BLANK is the same image under
// any view — one is enough for the per-family worlds below.
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: W }));

/** Query (renders). One frame from a plugin state, through `stamp` if the family
 *  needs a post-emit seam, under `view` (the family's frame — see the header). */
async function frame(plugin, state, stamp, view) {
  const ops = stamp(state, plugin.emit(state, null, IDENTITY));
  return readPng(await renderToPng(ops, view, { width: W, height: W }));
}

/** Pure function. No post-emit seam — most widgets draw everything in emit(). */
const asEmitted = (_state, ops) => ops;

/** Pure function. render_gpu/ports.js:475's three universal stroke stamps, in its
 *  order. The circle's arc family lives entirely in these. */
const asPorted = (state, ops) => applyStrokeJoin(state, applyStrokeOffset(state, applyStrokeTrim(state, ops)));

/** Pure function. Whole-frame per-channel mean absolute difference. */
const wholeFrame = (a, b) => imageDistance(a, b);

/** Pure function. Mean absolute difference over the pixels either frame inks. */
const litSet = (a, b) => litSetDistance(a, b, BLANK);

/**
 * THE FOUR FAMILIES, each with its own reduction, its own bound, and the two
 * measured anchors that bracket that bound. `base` is applied under every preset
 * so the family is measured where it is actually legible: the arc family composes
 * with the ring family by design (disjoint keys), and a trim window on the
 * shipped 2-unit stroke over a filled disc shows nothing at all.
 */
const FAMILIES = [
  {
    type: "polygon", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    bound: 17,
    // 11.26 — the right triangle against the same triangle with one vertex moved
    //         2% of the box. A REAL COLLISION: one shape, imperceptibly nudged.
    // 24.32 — Swallowtail Banner against Speech Tag, the narrowest KEEP, and two
    //         obviously different silhouettes on the contact sheet.
    anchors: "reject 11.26 (a vertex nudged 2%) / keep 24.32 (Swallowtail Banner vs Speech Tag)",
  },
  {
    type: "circle", familyId: "presets.ring", base: {}, stamp: asEmitted, distance: wholeFrame, metric: "whole-frame",
    bound: 2.8,
    // 2.06 — an unfilled ring at strokeWidth 6 against 7. A REAL COLLISION.
    // 3.56 — the default against Solid Dot, the narrowest KEEP: the same pink disc
    //        with and without its 2-unit black rim, which reads immediately.
    anchors: "reject 2.06 (strokeWidth 6 vs 7) / keep 3.56 (DEFAULT vs Solid Dot)",
  },
  {
    type: "circle", familyId: "presets.arc", base: { fill: "#00000000", strokeWidth: 18 }, stamp: asPorted, distance: litSet, metric: "lit-set",
    bound: 12,
    // 7.99 — the same three-quarter arc at phase 0 against phase 5 degrees. A REAL
    //        COLLISION: the gap has barely moved.
    // 16.55 — the untrimmed ring against Broken Ring, the narrowest KEEP: a
    //         hairline gap, and the whole point of that row is that you see it.
    anchors: "reject 7.99 (phase 0 vs 5) / keep 16.55 (DEFAULT vs Broken Ring)",
  },
  // ── THE TEN R7-39 SHAPESHIFTER FAMILIES (plugins/shapeshifter.js) ────────────
  // Every subject here is the SAME `path` IR op the rest of this file already
  // covers (subpathsPathD of a pure core/outline.js generator), so no new stamp
  // or reduction is needed — asEmitted + litSet, exactly like `polygon`. Bounds
  // are MEASURED per family (not copied from polygon's 17): a shape whose look is
  // dominated by a large filled body (cornerRect) separates far less per-pixel
  // than a thin silhouette family even when the geometry is genuinely different,
  // because the differing region — a corner — is a small share of a big filled
  // area. Each bound sits below its measured narrowest KEEP with margin, and
  // above zero — the anchors are the real narrowest pair found by a full pairwise
  // sweep over (DEFAULT + all presets), not a picked pair.
  //
  // THAT ARGUMENT USED TO NAME `callout` BESIDE cornerRect, AND IT WAS COVER FOR
  // A DEFECT. Its rows measured 0.80 apart not because a tail sliver is small but
  // because the corner radius never rendered (core/outline.js roundedVerts); the
  // sentence was true-sounding and made a bound of 0.5 look calibrated. With the
  // radius drawing, that family's narrowest pair is 7.05 — the widest floor of
  // any shapeshifter family here. A low bound is a symptom to chase first.
  {
    type: "ss_arrow", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    bound: 20,
    // Narrowest KEEP measured: 32.06 (DEFAULT vs Right Arrow, a bolder head/shaft
    // than the plugin default). No collision anywhere near this bound.
    anchors: "keep 32.06 (DEFAULT vs Right Arrow) — narrowest pair in the family",
  },
  {
    type: "ss_banner", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    // THE WHOLE BANNER, flares included: a negative notchDepth forks the ends
    // OUTWARD to -0.45·w .. 1.45·w at the deepest preset (-126 .. 406 for the
    // 280 box), so the default 0..320 frame cut both flares off. See the header.
    world: { x: -130, y: -120, w: 540, h: 540 },
    bound: 4,
    // 3.08 — notchDepth -0.20 against -0.21, one notch 2.8px deeper than the
    //        other. A REAL COLLISION: the same ribbon, imperceptibly deeper.
    // 5.05 — Flat Banner against Barely Notched, the narrowest KEEP: no notch at
    //        all against the family's deliberately faintest one (0.02 = 5.6px).
    // THIS FAMILY'S BRACKET IS THE TIGHTEST HERE, and that is a property of the
    // preset list, not of the fixture: "Barely Notched" exists to sit just off
    // flat, so a rejectable pair only 0.01 of depth apart measures 4.70 and would
    // pass. The gate still does its job (a duplicate row measures ~0); it just
    // cannot also police fine spacing in a family that ships a near-flat row.
    anchors: "reject 3.08 (notchDepth -0.20 vs -0.21) / keep 5.05 (Flat Banner vs Barely Notched)",
  },
  {
    type: "ss_callout", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    // THE AUTHORED BOX (the plugin's own 200x200 seed, which every preset's
    // absolute tailX/tailY was picked against) and a frame that contains the
    // tails: they reach local x -60..340, y -20..340, and do NOT scale with the
    // box. Both stated in the header.
    box: { x: 0, y: 0, w: 200, h: 200 },
    world: { x: -70, y: -50, w: 420, h: 420 },
    bound: 5,
    // 3.61 — the same bubble with its tail tip moved 2% of the box (tailX 55 vs
    //        59). A REAL COLLISION; the finer knob nudges are nearer still
    //        (cornerRadius 0.30 vs 0.32 = 0.48, tailWidth 0.30 vs 0.32 = 1.47).
    // 7.05 — the DEFAULT against Speech Bubble, the narrowest KEEP: a rounder
    //        body with a wider tail one step down-left.
    // THIS BOUND USED TO BE 0.5, and the reason is worth keeping: the corner
    // radius did not render at all (core/outline.js roundedVerts capped every
    // corner by the polygon's shortest edge, which the tail base makes tiny or
    // ZERO), so the family's widest visual axis was inert and every pair
    // collapsed. The number was then explained by "a rounded corner is a small
    // share of a large filled body" — a true-sounding sentence for a picture that
    // was never drawn. A bound that low is a symptom to chase, not a calibration.
    anchors: "reject 3.61 (tail tip nudged 2% of the box) / keep 7.05 (DEFAULT vs Speech Bubble)",
  },
  {
    type: "ss_cornerRect", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    bound: 1,
    // Narrowest KEEP measured: 1.76 (DEFAULT vs Rounded Rect). Same reasoning as
    // callout: a rounded/snipped CORNER is a small fraction of a filled rect's
    // silhouette, so real differences read small under a lit-set pixel mean.
    anchors: "keep 1.76 (DEFAULT vs Rounded Rect) — narrowest pair in the family",
  },
  {
    type: "ss_crossPlus", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    bound: 1.5,
    // Narrowest KEEP measured: 2.23 (Chunky Cross vs Fat Rounded Tick — both
    // near-maximal arm thickness, differing only in corner rounding).
    anchors: "keep 2.23 (Chunky Cross vs Fat Rounded Tick) — narrowest pair in the family",
  },
  {
    type: "ss_frame", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    bound: 15,
    // Narrowest KEEP measured: 22.66 (DEFAULT vs Half-Frame U — a full frame
    // against the same thickness with the top edge removed).
    anchors: "keep 22.66 (DEFAULT vs Half-Frame U) — narrowest pair in the family",
  },
  {
    type: "ss_gear", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    bound: 10,
    // Narrowest KEEP measured: 14.46 (DEFAULT vs Settings Icon — same tooth
    // count, wider root and hole).
    anchors: "keep 14.46 (DEFAULT vs Settings Icon) — narrowest pair in the family",
  },
  {
    type: "ss_polygonStar", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    bound: 12,
    // Narrowest KEEP measured: 16.33 (Sheriff Badge vs Rounded Pentagon — a
    // five-point star at 0.75 inner ratio against a five-sided polygon, both
    // gently rounded).
    anchors: "keep 16.33 (Sheriff Badge vs Rounded Pentagon) — narrowest pair in the family",
  },
  {
    type: "ss_quadWedge", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    bound: 8,
    // Narrowest KEEP measured: 10.57 (Rectangle vs Funnel — taper 1 against a
    // flared top wider than the base).
    anchors: "keep 10.57 (Rectangle vs Funnel) — narrowest pair in the family",
  },
  {
    type: "ss_radialSweep", familyId: "presets", base: {}, stamp: asEmitted, distance: litSet, metric: "lit-set",
    bound: 12,
    // Narrowest KEEP measured: 15.85 (Pac-Man vs Full Disc — a wide-mouth solid
    // wedge against the same disc with the gap closed to a full circle).
    anchors: "keep 15.85 (Pac-Man vs Full Disc) — narrowest pair in the family",
  },
];

for (const spec of FAMILIES) {
  const plugin = roster.find((p) => p.type === spec.type);
  assert.ok(plugin, `${spec.type} is not registered`);
  const family = presetFamiliesOf(plugin).find((f) => f.id === spec.familyId);
  assert.ok(family?.presets?.length, `${spec.type}/${spec.familyId} declares no presets — every assertion below would be vacuous`);

  // `world`/`box` default to the shared fixture; a family overrides one only for
  // the reason stated in the header (geometry outside the box / absolute coords).
  const view = spec.world ? fitRectView(spec.world, W, W) : VIEW;
  const base = { ...plugin.defaults, ...(spec.box ?? BOX), ...spec.base };
  const frames = [{ name: "(DEFAULT)", png: await frame(plugin, base, spec.stamp, view) }];
  for (const preset of family.presets)
    frames.push({ name: preset.name, png: await frame(plugin, { ...base, ...preset.props }, spec.stamp, view) });

  test(`${spec.type}/${spec.familyId}: ${family.presets.length} presets and the default all render a DIFFERENT picture`, () => {
    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = spec.distance(frames[i].png, frames[j].png);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= spec.bound,
          `${spec.type}/${spec.familyId}: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} ${spec.metric} levels apart (< ${spec.bound}) — the same row twice. Bound calibrated: ${spec.anchors}`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  ${spec.metric} mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs}` +
      (narrowest.d.coverage === undefined ? "" : ` lit=${(narrowest.d.coverage * 100).toFixed(1)}%`));
  });
}

// ── donut: a MONOTONE ONE-KNOB family, which no pixel mean can rank ───────────
/**
 * Pure function. How far apart two donut ring proportions are, as the LARGER of
 * the two ratios a reader can use: the HOLE radius and the RING width. 1.0 means
 * the two rings are identical; bigger is further apart.
 *
 * WHY A RATIO AND NOT A DIFFERENCE, and why the larger of two. A pixel mean
 * measures how MUCH ink moved, and the eye here measures how much the ring
 * CHANGED PROPORTION — which is why the pixel metric ranks this family backwards
 * (see the header). Which proportion carries the read swaps along the axis: at the
 * fat end the hole is the small quantity and governs (0.024 -> 0.125 is a hole
 * five times bigger, and obvious), while at the thin end the hole barely moves and
 * the RING width governs (0.92 -> 0.965 is a hole 1.05x bigger and a ring 2.3x
 * thinner, and is equally obvious). Taking the larger ratio is what makes one
 * number cover both ends.
 *
 * @param {number} a - a donut `inner`, hole radius as a fraction of the outer, 0..1
 * @param {number} b - the other `inner`
 * @returns {number} the separation ratio, >= 1
 *
 * @example ringSeparation(0.2, 0.219).toFixed(3) // '1.095' (two nearly identical holes — REJECTED)
 * @example ringSeparation(0.024, 0.125).toFixed(3) // '5.208' (a pinprick against a hole)
 * @example ringSeparation(0.92, 0.965).toFixed(3) // '2.286' (the HOLE barely moves; the RING halves)
 * @example ringSeparation(0.5, 0.5) // 1
 * @example ringSeparation(0, 0.4) // Infinity (a full disc is not a ring at all)
 */
function ringSeparation(a, b) {
  const ratio = (p, q) => (Math.min(p, q) === 0 ? Infinity : Math.max(p, q) / Math.min(p, q));
  return Math.max(ratio(a, b), ratio(1 - a, 1 - b));
}

/** Two ring proportions closer than this are one row. Bracketed by two measured
 *  rejects — 1.095 (a bagel at 0.2 against a forty-five's 0.219) and 1.053 (the
 *  charting 50% cutout against an ISO flat washer's 0.525), both of which are one
 *  picture on the contact sheet — against the narrowest KEEP, 1.199 (the disc data
 *  ring at 0.417 against the widget's own 0.5 default). */
const MIN_RING_SEPARATION = 1.15;

{
  const donut = roster.find((p) => p.type === "donut");
  assert.ok(donut, "donut is not registered — it is a BUILT-IN PLUGIN ASSET (assets/builtin/library/donut.plugin.js), not a plugins/ module, and an identically named dead twin exists");
  const presets = presetFamiliesOf(donut).flatMap((f) => f.presets);
  assert.ok(presets.length > 0, "donut declares no presets — every assertion below would be vacuous");

  const base = { ...donut.defaults, ...BOX };
  const rows = [{ name: "(DEFAULT)", inner: base.inner }, ...presets.map((p) => ({ name: p.name, inner: p.props.inner }))];
  const frames = [];
  for (const row of rows) frames.push({ name: row.name, png: await frame(donut, { ...base, inner: row.inner }, asEmitted, VIEW) });

  test(`donut: ${presets.length} presets and the default are separated as RINGS, not as pixel means`, () => {
    let narrowest = null;
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const sep = ringSeparation(rows[i].inner, rows[j].inner);
        if (!narrowest || sep < narrowest.sep) narrowest = { a: rows[i].name, b: rows[j].name, sep };
        assert.ok(sep >= MIN_RING_SEPARATION,
          `donut: "${rows[i].name}" (inner ${rows[i].inner}) and "${rows[j].name}" (inner ${rows[j].inner}) are ${sep.toFixed(3)}x apart in hole radius and ring width (< ${MIN_RING_SEPARATION}) — the same ring twice`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  ${narrowest.sep.toFixed(3)}x`);
  });

  test("donut: and no two of those rings are the same PICTURE either (the derivable floor)", () => {
    // The geometric rule above is the family's real bar; this is the floor nothing
    // may fall through, and it is what caught the shipped design's dead row — a
    // "Doughnut Chart" at inner 0.5 measured 0.0000 against the widget's default.
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++)
        assert.ok(!indistinguishable(imageDistance(frames[i].png, frames[j].png)),
          `donut: "${frames[i].name}" and "${frames[j].name}" differ by less than one 8-bit code value — no display can show them apart`);
  });
}

test("EVERY preset in a family writes the IDENTICAL key set", () => {
  // The overlay contract, mechanically. A key one row omits keeps whatever the
  // previously HOVERED row left there — so a `closed: true` shape picked after
  // "Check Mark" would draw as an unfilled line, and a filled circle picked after
  // "Hairline Ring" would keep the transparent fill.
  const KEY_SET_TYPES = ["polygon", "donut", "circle", ...FAMILIES.map((f) => f.type).filter((t) => t.startsWith("ss_"))];
  for (const type of new Set(KEY_SET_TYPES)) {
    const plugin = roster.find((p) => p.type === type);
    for (const family of presetFamiliesOf(plugin)) {
      const sets = new Set(family.presets.map((p) => Object.keys(p.props).sort().join(",")));
      assert.equal(sets.size, 1, `${type}/${family.id} presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
    }
  }
});

test("no polygon preset writes the list COMPANION, which may not exist until something is hidden", () => {
  // tests/polygon_test.js:759 pins "no companion is minted when nothing was
  // hidden". The design wave proposed writing `pointsActive: []` in every preset to
  // clear a stale hide; declaring it to satisfy the preset contract takes that
  // assertion RED, measured. So the rule is the reverse of what it proposed, and
  // this is the pin that stops someone re-deriving it.
  for (const preset of roster.find((p) => p.type === "polygon").presets)
    assert.equal("pointsActive" in preset.props, false,
      `polygon "${preset.name}" writes pointsActive — the companion list is minted by hiding a vertex and by nothing else`);
});

console.log(`\n${passed} geometric-shape preset tests passed`);
