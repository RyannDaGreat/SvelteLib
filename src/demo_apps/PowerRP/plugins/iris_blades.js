/**
 * IRIS BLADES — the diaphragm's BLADE ASSEMBLY: the N overlapping plates
 * themselves, each one its own stroked leaf, with the opening left as whatever
 * their overlap fails to cover. Todo #248.
 *
 * ── WHY THIS EXISTS BESIDE plugins/aperture.js, AND HOW IT DIFFERS ───────────
 * `aperture` draws THE OPENING: one region, one outline, a disc with a polygon
 * subtracted. That is optically correct and it is not what a camera aperture
 * LOOKS like. The user, on seeing it: *"Not just a hole with a shape, a circle
 * with a shape inside of it. An aperture is like geometry that has STROKES that
 * are kind of beautiful because they go all over the place. It looks like a photo
 * aperture symbol or Aperture Science."*
 *
 * So this widget draws the MECHANISM. The difference is structural, not
 * cosmetic: the opening here is not drawn at all — it is what EMERGES from N
 * overlapping plates.
 *
 * ── THE CONSTRUCTION, AND WHY THE SPIRAL IS FREE ─────────────────────────────
 * core/optics.bladeRadialLimit says how far the opening may reach at a bearing
 * off one blade's edge normal. `aperture` reads it as the region light may
 * occupy. THIS widget reads the SAME function as its COMPLEMENT: leaf k is
 *
 *     { p in the bore : |p| > edge · bladeRadialLimit(δ_k(p), N, curvature) }
 *
 * — a lune between the bore rim and that blade's own working edge, which is
 * exactly what a real leaf is. A CC BY-SA technical drawing of a 12-blade iris
 * (`.frenzy/round6/w4j_refs/`) confirms the shape rather than suggesting it: each
 * blade's working edge fits a circular arc to 0.006 units on a 122-unit housing,
 * about 0.005%, and the leaf runs from the opening out past the pivot circle.
 *
 * EACH LEAF IS BOUNDED BY THE ONE THAT LAPS IT, so every leaf shows exactly ONE
 * extension arm and they are all on the same rotational side. That is the spiral
 * of a photographed iris and of the Aperture Science mark.
 *
 * ── THIS PARAGRAPH USED TO SAY THE OPPOSITE, AND THE REVERSAL IS THE LESSON ──
 * The original construction ran every leaf out to the bore rim and relied on PAINT
 * ORDER (k = 0 … N−1, each filled then stroked) to carve the arms: leaf k+1's fill
 * buried leaf k's outer end. The docblock defended the seam that leaves behind —
 * "the cyclic overlap does not close … that is not a bug to route around, a real
 * iris has the same impossible stack".
 *
 * THAT DEFENCE WAS WRONG, and the user said so twice: *"there's one blade on the
 * top right that is like on top of all the others … the whole point of an Iris is
 * that you can't really z order it, you got to do the geometry correctly."* The
 * first clause is the symptom and the second is the diagnosis, exactly. The stack
 * IS cyclic — leaf k laps k+1 for every k, including N−1 lapping 0 — and precisely
 * because no painter's-algorithm order can express a cycle, an ordered paint must
 * break it somewhere. With the default reach of two pitches the break is TWO
 * leaves wide, which is why it read as one blade sitting above all the others
 * rather than as a subtle seam. Appealing to a real iris was the error: a real
 * diaphragm resolves the cycle in the THIRD dimension, with a helical stack, and a
 * flat drawing has no third dimension to spend.
 *
 * So the leaves are now DISJOINT — leaf k stops where leaf k+1's working edge
 * crosses it (`lappedBound`, `leafVisibleEnd`) — and with disjoint regions there
 * is no order left to be wrong. Every seam is the same seam, the wrap included.
 * MEASURED both ways over a grid of 19 600 samples: the old construction put
 * 52.27% of them inside two or more leaves, the new one under 0.5% (only the
 * shared edges, which two neighbours legitimately both touch).
 *
 * THE UNION IS UNCHANGED, which is what made the change safe rather than a
 * redesign: subtracting leaf k+1 from leaf k removes only points another leaf
 * still covers. So the opening is byte-for-byte what it was, and the whole
 * aperture-parity sweep below kept passing untouched — the assertion that this is
 * a change of OWNERSHIP, not of geometry. Shadows between blades were considered
 * and are deliberately NOT built (user: *"don't worry about the shadows, that's
 * too complicated, but you can at least do the math"*).
 *
 * ── THE OPENING IS BYTE-COMPATIBLE WITH THE SIBLING, AND THAT IS GATED ───────
 * Because both widgets read one boundary function, at equal `blades` /
 * `stopDown` / `curvature` / `bladeRotation` the hole this one leaves and the
 * hole `aperture` draws are the SAME hole. `tests/iris_blades_test.js` asserts it
 * over a sweep instead of trusting it, and asserts the retype round trip that
 * makes it useful: aperture → iris_blades → aperture returns every value
 * unchanged, so an author can switch depiction without losing the lens. The rows
 * that carry it are declared once, in core/optics.irisRow, never copied.
 *
 * ── WHAT IT DRAWS, IN ORDER ──────────────────────────────────────────────────
 *   1. THE PUPIL FILL — the light through the opening, under everything. Set it
 *      transparent and the opening becomes a real hole.
 *   2. THE LEAVES — one `path` op each, filled and stroked. One op per leaf is
 *      required, not incidental: the strokes ARE the subject, and a leaf's stroke
 *      must be covered by its successor's fill. Batching them into one op would
 *      draw every stroke on top of every fill and destroy the overlap. This is
 *      not the case tests/triangulated_paint_ban_test.js guards — that bans
 *      splitting ONE shape into abutting fills, and these are N distinct shapes
 *      that OVERLAP rather than abut (see `bladeReach`'s floor for the one place
 *      they can merely touch).
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import {
  BOUNDARY_CHORD_DEGREES, IRIS_SHARED_DEFAULTS, MIN_POLYGON_BLADES, NO_IRIS_BLADES,
  bladeAngle, bladeRadialLimit, boreClosestAnchor, boreGeom, clampKnob, cornerBoundaryAngles,
  irisPolygonHandles, irisRow, pupilGeom, pupilPoint, regularOpeningRadius, rimConstrain,
  stopDownHandle,
} from "../core/optics.js";
import { pointInOutlines, radialOutline } from "../core/outline.js";
import { morphPayloadFromPaths, statePaint } from "../core/morph_payload.js";
import { bundle, bundleNestedDefaults, defaults, props, STROKE_JOIN_KEYS, STROKE_TRIM_KEYS } from "../core/properties.js";
import { subpathsPathD } from "../core/shapes.js";
import { isPaintOff, path } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/**
 * The fewest blade pitches a leaf may span. GEOMETRIC, not taste: two adjacent
 * leaves meet at the bearing halfway between their normals, where each covers
 * from the polygon's own vertex radius outward. A leaf spanning one full pitch
 * reaches exactly that far, so at 1 the leaves TOUCH and the assembly is
 * light-tight; below 1 they part and the iris leaks a radial slit at every pitch.
 */
const MIN_BLADE_REACH = 1;

/**
 * How far a leaf lies across its neighbours by default, in blade pitches. Two
 * CHOSEN BY LOOKING, and the sweep is `.frenzy/round6/w4j_proto/sheet_reach.png`.
 * The two sourced numbers available are both far lower — the Aperture Science
 * mark's wedge spans 71.2° against a 45° pitch (1.58) and `mdi:camera-iris` is
 * built the same way — and they are the WRONG guide here, which is worth saying
 * rather than quietly ignoring: both are logos whose wedges also taper away from
 * the rim to a point, so a short span still reads as a blade. A plate that keeps
 * its full depth out to the rim does not: below about 3 pitches it reads as a PIE
 * SLICE, and only past 4 does the extension arm past the polygon vertex become
 * the long crossing stroke a photographed iris shows.
 *
 * At the shipped defaults the leaf's own edge reaches the bore at about 5.3
 * pitches, so 5 sits just inside the self-limit: the knob is LIVE at the default
 * (shortening it visibly retracts the plates) rather than parked in a dead zone,
 * and it is what stops an uncapped leaf at high curvature from wrapping the whole
 * bore into N identical rings with no visible assembly at all.
 */
const DEFAULT_BLADE_REACH = 5;

/**
 * A leaf's end is found by bisection, and it stops when the remaining
 * uncertainty is a nanoradian — about 32 halvings of a half-turn, each one a
 * handful of arithmetic.
 *
 * THE FIRST VALUE HERE WAS AN EIGHTH OF A BOUNDARY CHORD, on the argument that a
 * chord is already a sub-pixel departure, and `tests/iris_blades_test.js` §2a
 * caught it: the drawn leaf stops at the bisection's lower bound, so any
 * undershoot leaves a wedge up to that wide UNCOVERED wherever the neighbouring
 * leaf does not reach it (measured at 6 blades, curvature −1, stopDown 0.05,
 * where the plates genuinely do not meet). A sub-pixel bound on the ENDPOINT is
 * not a sub-pixel bound on the HOLE it can open, so the tolerance is set where
 * the question stops being about pixels at all.
 */
const LEAF_END_TOLERANCE = 1e-9;

/**
 * A plate cannot wrap past a half turn each way — beyond that it would overlap
 * itself and the extra span would mean nothing.
 *
 * This bound is also HALF OF THE PROOF that the `bladeReach` handle can never sit
 * on another handle; the other half is `leafInnerRadius`'s strictness. See
 * `bladeReachHandle`.
 */
const MAX_LEAF_HALF_SPAN = Math.PI;

/**
 * A plate shallower than this — measured at its deepest point, as a fraction of
 * the pupil radius — is not drawn at all. The value is the boundary sampling's
 * OWN sagitta, `1 − cos(BOUNDARY_CHORD_DEGREES / 2)` ≈ 0.00095, so the rule reads
 * "a plate thinner than the error the tessellation already has cannot be drawn
 * accurately, so it is not drawn". It is the same quarter-pixel argument
 * core/optics.js makes for the chord itself, applied to depth instead of width.
 *
 * It is not only tidiness. It is the step that makes the `bladeReach` handle
 * PROVABLY collision-free (see `bladeReachHandle`), and the exact-comparison
 * version of that argument does not survive floating point: at three blades,
 * curvature 1 and stopDown 0.5 the plate's depth is 2e-16 rather than 0, so a
 * strict `depth > 0` test called a zero-area plate real and the two handles
 * landed on the same pixel. `tests/iris_blades_test.js` §6b caught exactly that.
 */
export const MIN_PLATE_DEPTH = 1 - Math.cos((Math.PI / 180) * (BOUNDARY_CHORD_DEGREES / 2));

/**
 * Pure function. Does leaf `k`'s plate cover anything at `delta` radians off its
 * own edge normal, and if so from what radius? The complement of
 * `bladeRadialLimit`, as a fraction of the pupil radius: `null` where the leaf
 * does not reach this bearing at all, or where its edge has already reached the
 * bore so there is no metal left to draw. AT the bore counts as none — a plate
 * whose working edge sits exactly on the rim has zero area, and emitting it would
 * be a degenerate op. That strictness is also load-bearing for the handles; see
 * `bladeReachHandle`.
 *
 * Args:
 *   delta (number): radians off this blade's edge normal
 *   edge (number): the blade edge's own distance, 1 − stopDown, in [0, 1]
 *   blades (number): the blade count
 *   curvature (number): −1 concave … 0 straight … 1 fully round
 *
 * Returns:
 *   number|null: the radius the plate starts at, or null where it does not reach
 *
 * @example leafInnerRadius(0, 0.5, 8, 0) // 0.5 (on its own normal: the edge itself)
 * @example leafInnerRadius(Math.PI, 0.5, 8, 0) // null (behind a straight blade — no plate)
 * @example Math.round(leafInnerRadius(Math.PI / 4, 0.5, 8, 0) * 1e6) / 1e6 // 0.707107 (45 deg off: sec(45 deg) of the edge distance)
 * @example leafInnerRadius(Math.PI / 2.5, 0.5, 8, 0) // null (72 deg off: the edge has passed the bore, so the plate has ended)
 */
export function leafInnerRadius(delta, edge, blades, curvature) {
  const limit = bladeRadialLimit(delta, blades, curvature);
  if (!Number.isFinite(limit)) return null;
  const r = edge * limit;
  return r >= 1 ? null : r;
}

/**
 * Pure function. Half a leaf's angular extent, radians. `bladeRadialLimit` is
 * EVEN in delta, so a leaf is symmetric about its own normal and one number
 * describes it.
 *
 * The extent is the SMALLEST of three bounds, and which one binds is the whole
 * behaviour of the widget:
 *   · the leaf's own working edge reaching the bore (`leafInnerRadius` → null),
 *     which is what happens at low curvature and is why the plate needs no knob
 *     to look right;
 *   · `bladeReach` pitches, which binds near curvature 1 where the edge never
 *     reaches the bore;
 *   · MAX_LEAF_HALF_SPAN, so a leaf cannot wrap onto itself.
 *
 * Found by bisection because the first bound has no closed form for a curved
 * leaf, and coverage is a PREFIX property in delta (the edge moves monotonically
 * outward away from its normal), so bisection is exact rather than a search.
 *
 * @example Math.round((leafHalfSpan({blades: 8, stopDown: 0.5, curvature: 0}) * 180) / Math.PI) // 60 (a straight blade meets the bore at arccos(0.5))
 * @example leafHalfSpan({blades: 8, stopDown: 0}) // 0 (wide open: the plates are clear of the bore)
 * @example leafHalfSpan({blades: 3, stopDown: 0.5, curvature: 1}) // 0 (a plate with no depth is not a plate)
 * @example Math.round((leafHalfSpan({blades: 8, stopDown: 0.5, curvature: 1, bladeReach: 2}) * 180) / Math.PI) // 45 (fully round: the reach binds, 2 pitches of 45 deg)
 */
export function leafHalfSpan(s) {
  const n = Math.max(1, Math.round(s.blades ?? IRIS_SHARED_DEFAULTS.blades));
  const edge = clampKnob(1 - (s.stopDown ?? 0), 0, 1);
  const c = clampKnob(s.curvature, -1, 1, 0);
  const reach = Math.max(MIN_BLADE_REACH, s.bladeReach ?? DEFAULT_BLADE_REACH);
  const cap = Math.min(MAX_LEAF_HALF_SPAN, (reach * Math.PI) / n);
  const covers = (d) => leafInnerRadius(d, edge, n, c) !== null;
  // Wide open, or shallower than the tessellation can express: no plate at all.
  if (1 - (leafInnerRadius(0, edge, n, c) ?? 1) <= MIN_PLATE_DEPTH) return 0;
  if (covers(cap)) return cap;
  let lo = 0, hi = cap;
  while (hi - lo > LEAF_END_TOLERANCE) {
    const mid = (lo + hi) / 2;
    if (covers(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Pure function. Leaf `k`'s closed outline in LOCAL coords: its working edge out
 * to the bore, then the bore rim back. `null` when the leaf has no extent, which
 * is the honest answer for a wide-open iris — the leaves are withdrawn into the
 * barrel and there is nothing to draw.
 *
 * The inner edge is sampled at BOUNDARY_CHORD_DEGREES with no corner angles
 * added, deliberately: a single leaf's edge is one smooth arc. The opening's
 * corners are where two leaves CROSS, so they belong to no leaf's own boundary
 * and land exactly right anyway, as the intersection of two sampled curves whose
 * endpoints are exact.
 *
 * @example irisLeafOutline({w: 200, h: 200, blades: 8, stopDown: 0}, 0) // null (wide open)
 * @example irisLeafOutline({w: 200, h: 200, blades: 8, stopDown: 0.5}, 0)[0].map(Math.round) // [150, 13]
 * @example // every leaf is the same shape rotated, so they all have equal point counts:
 * @example irisLeafOutline({w: 200, h: 200, blades: 8, stopDown: 0.5}, 3).length === irisLeafOutline({w: 200, h: 200, blades: 8, stopDown: 0.5}, 0).length // true
 */
export function irisLeafOutline(s, k) {
  const half = leafHalfSpan(s);
  if (!(half > 0)) return null;
  const n = Math.max(1, Math.round(s.blades ?? IRIS_SHARED_DEFAULTS.blades));
  const edge = clampKnob(1 - (s.stopDown ?? 0), 0, 1);
  const c = clampKnob(s.curvature, -1, 1, 0);
  const own = (d) => leafInnerRadius(d, edge, n, c) ?? 1;
  const lapped = lappedBound(half, n, own);
  const end = leafVisibleEnd(half, own, lapped);
  const base = bladeAngle(s, k);
  const g = pupilGeom(s);
  const at = (d, r) => [g.cx + g.rx * r * Math.cos(base + d), g.cy + g.ry * r * Math.sin(base + d)];
  const step = (Math.PI / 180) * BOUNDARY_CHORD_DEGREES;
  const deltas = [-half];
  for (let d = -half + step; d < end; d += step) deltas.push(d);
  deltas.push(end);
  // Out along the leaf's OWN working edge, back along whatever bounds it: the
  // rim where nothing laps it, the successor's edge where something does.
  return [...deltas.map((d) => at(d, own(d))), ...[...deltas].reverse().map((d) => at(d, lapped(d)))];
}

/**
 * Pure function. The OUTER radial bound on a leaf at its own delta `d`: the bore
 * rim (1) where nothing laps it, else the SUCCESSOR's working edge.
 *
 * THIS FUNCTION IS THE FIX FOR THE LOPSIDED IRIS, so it is worth saying what it
 * replaced. Every leaf used to run all the way out to the rim and the leaves were
 * painted 0…N−1, so each one's fill buried its predecessor's outer end. That reads
 * correctly for N−1 of the seams and then fails at the wrap, where leaf 0 lies
 * under everything and the last leaf lies over everything — and with the default
 * reach of two pitches the anomaly is two leaves wide, which is why the user saw
 * "one blade on the top right that is on top of all the others" and said the whole
 * point of an iris is that you cannot z-order it.
 *
 * He is right, and the reason is that the physical stack is CYCLIC: leaf k laps
 * k+1 for every k, including k = N−1 lapping 0. No painter's-algorithm order can
 * express a cycle, so any paint order must break it somewhere. Bounding each leaf
 * by its successor's edge instead makes the drawn regions DISJOINT, and then no
 * order exists to be wrong — every seam is the same seam, the wrap included.
 *
 * THE UNION IS UNCHANGED, which is what makes this safe: removing L_(k+1) from
 * L_k removes only points another leaf still covers, so ∪L_k is identical and the
 * opening — the shape the leaves fail to cover — is byte-for-byte what it was.
 * That is why the aperture-parity sweep in tests/iris_blades_test.js keeps passing
 * without being touched, and it is the assertion that proves this is a change of
 * OWNERSHIP, not of geometry.
 *
 * @param {number} half - the leaf's half-span, radians
 * @param {number} n - blade count
 * @param {function} own - delta → this leaf's inner radius, 1 where it has no material
 * @returns {function} delta → the outer bound, in pupil-radius fractions
 *
 * @example lappedBound(0.4, 8, () => 0.5)(-0.4) // 1 (the trailing end is clear of the successor)
 * @example lappedBound(1.2, 8, () => 0.5)(0.9) // 0.5 (inside the successor's span, so its edge bounds it)
 */
export function lappedBound(half, n, own) {
  const pitch = (2 * Math.PI) / n;
  // The successor sits one pitch further round, so at this leaf's delta `d` its
  // OWN delta is d − pitch. Outside its span it has no material and imposes no
  // bound, which is the rim.
  return (d) => (Math.abs(d - pitch) <= half ? own(d - pitch) : 1);
}

/**
 * Pure function. The delta at which a leaf stops being visible — where its own
 * working edge meets the edge that laps it. Past this the successor's edge is
 * INSIDE this leaf's, so the leaf contributes nothing and drawing further would
 * fold the outline back on itself.
 *
 * Bisection for `leafHalfSpan`'s reason: `own` has no closed form for a curved
 * leaf, and visibility is a PREFIX property in delta (the leaf's own edge moves
 * outward away from its normal while the successor's moves inward toward it, so
 * the gap closes monotonically), which makes bisection exact rather than a search.
 *
 * @param {number} half - the leaf's half-span, radians
 * @param {function} own - delta → this leaf's inner radius
 * @param {function} lapped - delta → the outer bound (lappedBound)
 * @returns {number} the ending delta, in (−half, half]
 *
 * @example leafVisibleEnd(0.4, () => 0.5, () => 1) // 0.4 (nothing laps it: visible to its full span)
 * @example leafVisibleEnd(1, (d) => 0.5 + d, (d) => 1.5 - d) < 1 // true (the edges cross before the span ends)
 */
export function leafVisibleEnd(half, own, lapped) {
  if (own(half) < lapped(half)) return half;
  let lo = -half, hi = half;
  while (hi - lo > LEAF_END_TOLERANCE) {
    const mid = (lo + hi) / 2;
    if (own(mid) < lapped(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Pure function. The OPENING's closed outline in LOCAL coords — the shape the
 * leaves fail to cover, which is the same shape `plugins/aperture.js` draws
 * directly. Present here only so the pupil fill has something to fill; the
 * leaves never consult it.
 *
 * @example irisOpeningOutline({w: 200, h: 200, blades: 0, stopDown: 0})[0] // [200, 100]
 * @example irisOpeningOutline({w: 200, h: 200, blades: 8, stopDown: 0.5})[0] // [150, 100]
 */
export function irisOpeningOutline(s) {
  const n = Math.max(0, Math.round(s.blades ?? 0));
  const angles = cornerBoundaryAngles(n, s.bladeRotation ?? 0, Math.PI / Math.max(1, n));
  return radialOutline(pupilGeom(s), angles, (a) => regularOpeningRadius(a, s));
}

export const irisBladesPlugin = {
  type: "iris_blades",
  ephemeral: EPHEMERAL.NONE,
  title: "Iris Blades",
  // A SHAPE, declared by the widget (core/registry.js INSERT_MENUS): it joins the
  // Add Shape grid without any central list learning its name.
  insertMenu: "shape",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  /**
   * EVERY ROW'S GEOMETRY IS MEASURED, and the two logo rows are measured off the
   * vector sources rather than off a picture of them —
   * `.frenzy/round6/w4j_refs/REFERENCES.md` holds every URL, licence and number.
   * Where a value could not be measured it is DERIVED from one that was, and the
   * derivation is named in the description; nothing here is a guess dressed as a
   * fact.
   *
   * THE FAMILY WRITES GEOMETRY AND NOTHING ELSE. All five constituting knobs
   * appear in every row (the aperture family's discipline, which is the
   * shapeshifter cloud family's before that), so hovering down the list is
   * order-independent; `fill`, `pupilFill` and `stroke` are the author's
   * presentation and are never touched.
   */
  presets: [
    {
      name: "Aperture Science Mark",
      description: "The Portal logo's geometry, measured off the public-domain SVG: eight straight-edged wedges and an opening whose inradius is 0.578 of the outer circle. NOT a facsimile — the mark's wedges also taper to a point away from the rim, leaving the thin slivers it is known for, and these plates keep their full depth out to the rim instead.",
      props: { blades: 8, stopDown: 0.42, curvature: 0, bladeRotation: 0, bladeReach: 5 },
    },
    {
      name: "Interface Iris Glyph",
      description: "The photography aperture glyph as `mdi:camera-iris` draws it, read out of its path data: six straight plates stopped well down, the inner tip at 0.300 of the outer radius. The icon every camera app uses, at icon proportions.",
      props: { blades: 6, stopDown: 0.7, curvature: 0, bladeRotation: 0, bladeReach: 2.6 },
    },
    {
      name: "Twelve-Blade Sickle",
      description: "A real twelve-leaf diaphragm, fitted to a CC BY-SA technical drawing: the working edges are circular arcs to 0.005 percent, the opening sits at 0.419 of the bore, and the arc radius solves to a curvature of 0.36 — slightly rounded, not circular.",
      props: { blades: 12, stopDown: 0.58, curvature: 0.36, bladeRotation: 0, bladeReach: 6 },
    },
    {
      name: "Nineteen-Blade Sickle",
      description: "The many-leaf iris of a large-format or process lens: so many long thin sickles that the opening is round however far it stops down, and the assembly reads as a fan of edges rather than as plates.",
      props: { blades: 19, stopDown: 0.55, curvature: 0.8, bladeRotation: 0, bladeReach: 3 },
    },
    {
      name: "Barely Stopped Down",
      description: "The plates only just into the bore: short scallops around the rim and an opening still very nearly the full circle. What a fast lens looks like a third of a stop from wide open, and the state that shows how little metal it takes to shape a highlight.",
      props: { blades: 8, stopDown: 0.18, curvature: 0.2, bladeRotation: 0, bladeReach: 5 },
    },
    {
      name: "Stopped Right Down",
      description: "Eight straight leaves closed almost to a point: the plates dominate, the opening is a small hard octagon, and every extension arm runs the full radius. What a lens looks like at its minimum aperture.",
      props: { blades: 8, stopDown: 0.82, curvature: 0, bladeRotation: 0, bladeReach: 5 },
    },
    {
      name: "Circular-Aperture Assembly",
      description: "Fully curved leaves, whose edges together are exactly a circle at every stop — a 'circular aperture' design. The opening gives nothing away, so the only thing that says how many blades there are is the plates themselves, and their span is what makes them countable.",
      props: { blades: 10, stopDown: 0.5, curvature: 1, bladeRotation: 0, bladeReach: 3.5 },
    },
    {
      name: "Inward-Curved Star",
      description: "Eleven leaves curving INWARD, the pre-aspherical Leica Summicron 90mm arrangement: each edge bulges into the opening, so the hole is a concave-sided star and the plates read as scallops rather than as chords.",
      props: { blades: 11, stopDown: 0.55, curvature: -0.8, bladeRotation: 0, bladeReach: 5 },
    },
    {
      name: "Five-Leaf Shutter",
      description: "Five broad plates and a pentagonal hole, the arrangement a vintage leaf shutter uses. Few enough that one plate covers a large fraction of the bore, so the overlap — rather than the opening — is most of what you see.",
      props: { blades: 5, stopDown: 0.5, curvature: 0.25, bladeRotation: 0, bladeReach: 3 },
    },
  ],
  defaults: {
    type: "iris_blades", x: 260, y: 160, w: 220, h: 220, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#414868", pupilFill: "#ffd7a3", stroke: "#c0caf5", strokeWidth: 2,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
    ...IRIS_SHARED_DEFAULTS, // blades / stopDown / curvature / bladeRotation / pupilAspect
    bladeReach: DEFAULT_BLADE_REACH,
  },
  inspector: [
    ...bundle("positioning"),
    irisRow("blades", `Number of plates in the assembly. ${NO_IRIS_BLADES} means there is no iris at all and the bore is left bare; ${MIN_POLYGON_BLADES} is the fewest that can enclose an opening. The count is what you are looking at here — each plate is drawn, so a change is visible as plates rather than only as the shape of the hole. The aperture widget and the lens flare mean the same number.`),
    irisRow("stopDown", "How far the plates have swung across the bore: 0 is wide open, where the leaves are withdrawn into the barrel and nothing is drawn at all, and 1 is shut. Everything else about the picture follows from this — the arms lengthen, the crossings move inward, and the opening shrinks. Drag the handle on the first plate's edge."),
    irisRow("curvature", "The shape of each plate's working edge: 0 is a straight-edged leaf, 1 a fully curved one whose edges together make an exact circle, and NEGATIVE an inwardly curved leaf that bulges into the opening. Real leaves are arcs — a twelve-blade diaphragm measured off a technical drawing fits an arc to 0.005 percent — so 0 is the stylised case and the middle of the range is the common one. Drag the handle on the third plate's edge."),
    { key: "bladeReach", label: "Blade reach", kind: "number", min: MIN_BLADE_REACH, category: "formatting",
      help: `How far around the bore each plate lies, counted in blade pitches: ${MIN_BLADE_REACH} is the floor, where neighbouring plates only just touch, and larger values bury each plate deeper under the next. It has no effect wherever a plate's own edge reaches the rim first, which is most of the range; it takes over at high curvature, where an uncapped plate would wrap the whole bore and the assembly would read as plain rings. Drag the handle at the first plate's trailing end.` },
    irisRow("bladeRotation", "Orientation of the whole assembly — which way the plates and their arms point. Stored in radians and shown in degrees, matching the aperture widget's blade rotation and the lens flare's starburst rotation, so the three can be bound to one another. Uncapped: past 360 degrees keeps counting, so a keyframed value spins the mechanism."),
    irisRow("pupilAspect", "Shape of the bore itself, independently of the widget's box: 1 is round, below 1 a vertical oval, above 1 a horizontal one. An anamorphic lens's entrance pupil really is oval, and the plates then close across an oval. Floor 0 is technical — a bore with no width has no plates."),
    ...props("fill"),
    irisRow("pupilFill", "The light coming through the opening, drawn UNDER the plates. Set it fully transparent to leave a real hole instead, turning the assembly into an iris mask over whatever is behind it."),
    ...props("stroke", "strokeWidth"),
    // THE STROKES ARE THE SUBJECT of this widget, so the corner and end treatments
    // are exposed rather than left at their defaults: every leaf's outline turns a
    // sharp corner where its working edge meets the rim, which is exactly where a
    // miter, a round or a bevel look different from one another.
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (LOCAL space): the pupil fill,
   * then ONE `path` op per leaf, in order, each filled and stroked. The order is
   * load-bearing — see this file's header.
   */
  emit(s, _targetWorldIR, world) {
    const bore = boreGeom(s);
    if (!(bore.rx > 0) || !(bore.ry > 0)) return [];
    const opacity = s.opacity ?? 1;
    const ops = [];
    if (!isPaintOff(s.pupilFill) && s.pupilFill != null) ops.push(path({
      d: subpathsPathD([irisOpeningOutline(s)]),
      fill: s.pupilFill,
      fillRule: "nonzero",
      opacity,
    }));
    const n = Math.max(0, Math.round(s.blades ?? 0));
    for (let k = 0; k < n; k++) {
      const leaf = irisLeafOutline(s, k);
      if (!leaf) break; // every leaf is the same shape rotated: if one is empty, all are
      ops.push(path({
        d: subpathsPathD([leaf]),
        fill: s.fill,
        stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
        strokeWidth: s.strokeWidth ?? 0,
        fillRule: "nonzero",
        opacity,
      }));
    }
    if (ops.length === 0) return [];
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * every LEAF as its own cubic contour, from the SAME `irisLeafOutline` loop
   * emit() draws the mechanism with — so what morphs is what renders, at whatever
   * stop the blades are currently at.
   *
   * ONE SUBPATH PER LEAF, deliberately not merged. The aligner pairs subpaths, so
   * an eight-bladed iris morphing into an eight-pointed star pairs leaf-to-point;
   * merging them into one silhouette would throw that structure away and give the
   * engine a single blob to distribute. It is the same argument the QR provider
   * makes from the other direction (hundreds of modules, kept separate so they
   * collapse INDIVIDUALLY into a ring).
   *
   * THE PUPIL IS NOT INK, for the aperture widget's reason exactly: it is the
   * light coming through the hole the leaves leave, an author can turn it off
   * without changing the mechanism, and pairing a target's outline against a
   * widget's own negative space is not a morph anyone asked for.
   */
  morphPaths(s) {
    const n = Math.max(0, Math.round(s.blades ?? 0));
    const sources = [];
    for (let k = 0; k < n; k++) {
      const leaf = irisLeafOutline(s, k);
      if (!leaf) break; // emit()'s own rule: every leaf is one shape rotated
      sources.push({ d: subpathsPathD([leaf]), paint: statePaint(s) });
    }
    return morphPayloadFromPaths(sources, { w: s.w ?? 0, h: s.h ?? 0 });
  },
  /** Pure function. Why this iris cannot morph YET, or null — emit()'s own
   * guards: a zero bore draws nothing, and a bladeless or fully-open assembly has
   * no leaf outline to pair against. */
  morphNotReady(s) {
    const bore = boreGeom(s);
    if (!(bore.rx > 0) || !(bore.ry > 0)) return "a positive bore (this iris has zero size)";
    const n = Math.max(0, Math.round(s.blades ?? 0));
    return n > 0 && irisLeafOutline(s, 0) ? null : "blades with an outline (these draw nothing)";
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  /** Pure function. Inside the BORE — the whole assembly's silhouette, whether
   *  the opening is filled with light or left as a hole (a click in the middle of
   *  an iris is a click on the iris). */
  hitTest(s, lx, ly) {
    const bore = boreGeom(s);
    if (!(bore.rx > 0) || !(bore.ry > 0)) return false;
    return pointInOutlines([radialOutline(bore, cornerBoundaryAngles(0, 0, 0), () => 1)], lx, ly);
  },
  anchors: standardBBoxAnchors,
  closestAnchor: boreClosestAnchor,
  /**
   * Pure function. Five yellow squares. Four are the shared iris handles
   * (core/optics.js) so a drag means the same thing here as on the aperture;
   * `bladeReach` is this widget's own, and sits where the thing it controls IS —
   * the trailing end of the first plate, on the rim.
   *
   * The fill / pupilFill GRADIENT beads are NOT here any more: core/derive.js
   * nodeModifierPoints appends them after these rows for every `paint: true` row
   * this plugin declares.
   */
  modifierPoints(s) {
    return [
      stopDownHandle(s),
      ...irisPolygonHandles(s),
      // Absent rather than inert while there are no plates to reach — and that
      // gate is load-bearing for handle separation, see bladeReachHandle.
      ...(leafHalfSpan(s) > 0 ? [bladeReachHandle(s)] : []),
    ];
  },
  // CROSSHAIR PLACEMENT: bbox placement — click-drag sizes the box, a plain click
  // places the default size (the donut.js precedent; bbox is the default kind).
  commands: [
    { id: "add-iris-blades", title: "Add Iris Blades", // `tabler:aperture` IS this construction: a circle with N chords crossing.
      // The prefix has precedent (plugins/iconify.js's own DEFAULT_ICON), and the
      // sibling keeps `mdi:camera-iris` — two widgets, two glyphs.
      icon: "tabler:aperture", run: (app) => app.armCrosshairPlacement(irisBladesPlugin) },
  ],
};

/**
 * Pure function. The half-span the `bladeReach` knob ASKS for, clamped to the
 * range a plate may occupy — as opposed to `leafHalfSpan`, which is what the
 * plate actually gets once its own working edge has had its say.
 *
 * @example Math.round((requestedHalfSpan({blades: 8, bladeReach: 2}) * 180) / Math.PI) // 45
 * @example Math.round((requestedHalfSpan({blades: 8, bladeReach: 0.1}) * 180) / Math.PI) // 23 (clamped to the floor)
 * @example requestedHalfSpan({blades: 8, bladeReach: 99}) // 3.141592653589793 (clamped to a half turn)
 */
function requestedHalfSpan(s) {
  const n = Math.max(1, Math.round(s.blades ?? IRIS_SHARED_DEFAULTS.blades));
  const reach = Math.max(MIN_BLADE_REACH, s.bladeReach ?? DEFAULT_BLADE_REACH);
  return Math.min(MAX_LEAF_HALF_SPAN, (reach * Math.PI) / n);
}

/**
 * Pure function. The `bladeReach` handle: a rim point behind blade zero's normal
 * by the span the knob asks for. Behind, because that is the end its neighbour
 * does NOT bury, so the handle sits beside visible geometry.
 *
 * IT SHOWS WHAT THE KNOB ASKS FOR, NOT WHAT THE PLATE GOT. Where a plate's own
 * working edge reaches the bore first the knob is inert, and the handle then sits
 * on the rim past the plate's actual end. The alternative — parking it at the
 * real end — was tried and is a protocol violation:
 * `tests/handle_constraints_test.js` ROUND TRIP requires that writing from a
 * dragged point puts the handle AT that point, and a handle that silently snaps
 * back to a shorter self-limit does not.
 *
 * ── WHY IT CANNOT LAND ON ANOTHER HANDLE, WHICH IS NOT OBVIOUS ───────────────
 * It is the only handle whose BEARING moves, so it sweeps past the four fixed
 * ones and only its radius can keep it apart. `tests/iris_blades_test.js` §6b
 * found a real coincidence here before this argument existed, so:
 *
 *   · It sits at radius 1, and it EXISTS only while there are plates — the same
 *     "absent rather than inert" rule core/optics.irisPolygonHandles follows.
 *   · `bladeRotation` and `blades` are also on the rim, at π/N and 2π/N AHEAD of
 *     blade zero. Reaching them from behind needs a half-span of 2π − π/N or
 *     2π − 2π/N, both greater than MAX_LEAF_HALF_SPAN for every N ≥ 2.
 *   · `stopDown` sits at radius 1 − stopDown, which is 1 only wide open — where
 *     there are no plates and so no handle here.
 *   · `curvature` sits at radius `edge · (1 + c·(sec(π/N) − 1))`, which is EXACTLY
 *     the plate's own inner radius at its normal. Plates exist only when that is
 *     at least MIN_PLATE_DEPTH below the rim, so whenever this handle is on the
 *     screen the curvature handle is strictly inside it.
 *
 * The last two are why the handle is gated on `leafHalfSpan` rather than always
 * drawn, and why `leafInnerRadius` measures depth against MIN_PLATE_DEPTH instead
 * of against zero.
 *
 * @example bladeReachHandle({w: 200, h: 200, blades: 8, stopDown: 0.5, curvature: 0, bladeReach: 2}).id // "bladeReach"
 * @example Math.round(bladeReachHandle({w: 200, h: 200, blades: 8, stopDown: 0.5, curvature: 0, bladeReach: 2}).apply({w: 200, h: 200, blades: 8}, {x: 100, y: 0}).bladeReach) // 4
 */
function bladeReachHandle(s) {
  const bladeCount = (st) => Math.max(1, Math.round(st.blades ?? IRIS_SHARED_DEFAULTS.blades));
  /** The nearest allowed half-span to a dragged point, or null when the pupil has
   *  no extent to take a bearing in. Nearest on the ARC, so a point outside the
   *  allowed range projects to whichever END is angularly closer — the
   *  handle-constraint protocol's NEAREST property, which a plain clamp of the
   *  wrapped angle fails for a target just ahead of blade zero. */
  const nearestHalfSpan = (st, p) => {
    const g = pupilGeom(st);
    if (!(g.rx > 0) || !(g.ry > 0)) return null;
    const a = Math.atan2((p.y - g.cy) / g.ry, (p.x - g.cx) / g.rx);
    const behind = (((bladeAngle(st, 0) - a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const lo = (MIN_BLADE_REACH * Math.PI) / bladeCount(st);
    if (behind >= lo && behind <= MAX_LEAF_HALF_SPAN) return behind;
    const apart = (d) => Math.abs((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
    return apart(behind - lo) <= apart(behind - MAX_LEAF_HALF_SPAN) ? lo : MAX_LEAF_HALF_SPAN;
  };
  return {
    id: "bladeReach", ...pupilPoint(s, 1, bladeAngle(s, 0) - requestedHalfSpan(s)),
    constrain: (st, p) => {
      const half = nearestHalfSpan(st, p);
      return half === null ? rimConstrain(st, p) : pupilPoint(st, 1, bladeAngle(st, 0) - half);
    },
    apply: (st, p) => {
      const half = nearestHalfSpan(st, p);
      // A pupil with no extent has no bearing to read — the stored value stands
      // (the donut.js / lens_flare division-guard precedent).
      if (half === null) return { bladeReach: Math.max(MIN_BLADE_REACH, st.bladeReach ?? DEFAULT_BLADE_REACH) };
      return { bladeReach: (half * bladeCount(st)) / Math.PI };
    },
  };
}
