/**
 * OPTICS — the facts about an IRIS DIAPHRAGM that more than one module holds.
 *
 * ── WHY THIS MODULE EXISTS, AND WHY IT IS THIS SIZE ──────────────────────────
 * THREE places in this app describe the same physical object: `plugins/aperture.js`
 * draws the OPENING the diaphragm makes, `plugins/iris_blades.js` draws the LEAVES
 * that make it, and the lens flare draws the star that diaphragm produces
 * (`render_gpu/skia/lens_flare_shader.js`). R6-3.11 requires them to AGREE about
 * blade count, and no plugin may import another plugin (core/registry.js), so a
 * fact more than one of them needs lives in core. It holds exactly the facts with
 * TWO OR MORE REAL CONSUMERS — speculative generality is its own Tower of Babel,
 * so nothing is parked here "for later" (ledger C-1).
 *
 * ── THE TWO WIDGETS ARE ONE MECHANISM SEEN TWO WAYS ──────────────────────────
 * `aperture` draws the region light passes through; `iris_blades` draws the N
 * plates that bound it, and its opening is what EMERGES from their overlap. That
 * is only true if both read the SAME boundary function, which is why
 * `bladeRadialLimit` and `regularOpeningRadius` live here rather than in either
 * plugin. `tests/iris_blades_test.js` gates the consequence directly: at equal
 * `blades` / `stopDown` / `curvature` / `bladeRotation` the two widgets' openings
 * agree to floating-point, so retyping between them carries the hole exactly and
 * changes only the depiction.
 *
 * ── THE SUNSTAR PARITY LAW ───────────────────────────────────────────────────
 * THERE IS NO SUCH THING AS AN ODD-NUMBERED SUNSTAR. An aperture is a REAL
 * (not complex) transmission function, so its Fourier transform is HERMITIAN and
 * its intensity |F|² is CENTROSYMMETRIC: every diffraction ray has an equal,
 * opposite twin, for ANY aperture shape. A blade edge throws its spike along the
 * edge NORMAL, so the ray set is
 *
 *     {θ_0 + 2πk/N} ∪ {θ_0 + π + 2πk/N},   k = 0 … N−1
 *
 * and the parity result is what that union's SIZE happens to be — N when N is
 * even (the opposite of every normal is already a normal), 2N when N is odd.
 * BOTH OUTCOMES ARE EVEN. `starburstRayAngles` below builds that union and
 * `starburstRayCount` reads its length, so the law is a CONSEQUENCE of the
 * construction rather than a conditional written out a second time. Any preset,
 * label or help string promising a "seven-point star" describes something
 * physically impossible and must be rejected rather than tuned.
 *
 * THE SkSL COPY, AND THE GATE ON IT. The flare applies the same doubling on the
 * GPU (`lens_flare_shader.js`, the `spikeCount` line), which is a language this
 * module cannot reach — so it IS a mirror, and mirrors rot. `tests/aperture_test.js`
 * extracts that shader's own arithmetic FROM ITS SOURCE TEXT and evaluates it
 * against `starburstRayCount` for every count in range; if the shader's formula
 * changes, the gate goes red instead of the two widgets silently disagreeing.
 */

import { closestPointOnSegment } from "./outline.js";
import { UNIT_SPAN_SCRUB } from "./properties.js";
import * as T from "./transform.js";

/**
 * The fewest blades that can enclose a POLYGON, and therefore the fewest that
 * give an aperture a corner at all. Geometric, not a taste bound.
 *
 * SHARED, BECAUSE THE TWO WIDGETS MUST NOT DISAGREE ABOUT WHAT A BLADE COUNT
 * MEANS (R6-3.11): it is the floor of the flare's `blades` row
 * (render_gpu/skia/lens_flare_shader.js) AND the count at and above which
 * `plugins/aperture.js` has a polygon to round, a vertex to place a handle on,
 * and a `sec(π/N)` that is finite and positive. Below it an aperture still draws
 * — one or two blades cut a real circular segment out of the bore — but there is
 * no polygon, so blade CURVATURE has nothing to curve.
 */
export const MIN_POLYGON_BLADES = 3;

/**
 * The blade count that means THE LENS HAS NO IRIS — a mirror (catadioptric)
 * telephoto, a phone camera module, a pinhole. Not a degenerate value to guard
 * against: it is a real, sourced state of a real lens, and the opening is then
 * the bare entrance pupil.
 */
export const NO_IRIS_BLADES = 0;

/**
 * Pure function. The angles (radians) of the diffraction rays an N-blade
 * aperture throws, as the union described in this module's header: one ray along
 * each blade edge's NORMAL, plus each of their OPPOSITES. Duplicates are removed
 * on an EXACT integer index (every ray is `rotation + π·m/N` for an integer m in
 * [0, 2N)), so no angular tolerance is involved and the even/odd parity falls out
 * of the set's size rather than being asserted.
 *
 * Sorted by increasing offset from `rotation`. A count below one has no edges and
 * therefore no rays: the empty list, which is the honest answer for a lens with
 * no iris.
 *
 * Args:
 *   blades (number): blade count; rounded, negatives read as none
 *   rotation (number): the first blade normal's heading, radians
 *
 * Returns:
 *   number[]: ray headings in radians, length N (N even) or 2N (N odd)
 *
 * @example starburstRayAngles(4).map((a) => Math.round((a * 180) / Math.PI)) // [0, 90, 180, 270]
 * @example starburstRayAngles(3).map((a) => Math.round((a * 180) / Math.PI)) // [0, 60, 120, 180, 240, 300]
 * @example starburstRayAngles(6).length // 6
 * @example starburstRayAngles(0) // []
 * @example starburstRayAngles(2, Math.PI / 2).map((a) => Math.round((a * 180) / Math.PI)) // [90, 270]
 */
export function starburstRayAngles(blades, rotation = 0) {
  const n = Math.max(0, Math.round(blades ?? 0));
  if (n < 1) return [];
  const indices = new Set();
  for (let k = 0; k < n; k++) {
    indices.add((2 * k) % (2 * n)); // blade k's edge normal
    indices.add((2 * k + n) % (2 * n)); // its opposite — the centrosymmetry
  }
  return [...indices].sort((a, b) => a - b).map((m) => rotation + (Math.PI * m) / n);
}

/**
 * Pure function. How many diffraction rays an N-blade aperture throws: N when N
 * is even, 2N when N is odd, 0 when there is no iris. Never odd — see the parity
 * law in this module's header.
 *
 * Args:
 *   blades (number): blade count; rounded, negatives read as none
 *
 * Returns:
 *   number: the ray count, always even
 *
 * @example starburstRayCount(8) // 8
 * @example starburstRayCount(9) // 18
 * @example starburstRayCount(13) // 26
 * @example starburstRayCount(6) // 6
 * @example starburstRayCount(0) // 0 (no iris — no edges to diffract at)
 */
export function starburstRayCount(blades) {
  return starburstRayAngles(blades).length;
}

/**
 * The blade count a fresh iris widget starts at: eight is the commonest modern
 * iris, and it is the same value the lens flare's `blades` row defaults to. Shared
 * so the three widgets cannot drift apart on the number that means "an ordinary
 * lens".
 */
export const DEFAULT_BLADES = 8;

/**
 * The angular step an iris boundary is sampled at, in degrees. Chosen from the
 * SAGITTA: a 5-degree chord on a 200 px radius departs from the true curve by
 * 200·(1 − cos 2.5°) = 0.19 px, under a quarter pixel, so the tessellation is
 * invisible at any size these widgets are authored at. Polygon VERTICES are added
 * exactly on top of this sampling, so a corner stays a corner however coarse the
 * sampling is; only the smooth stretches are approximated.
 */
export const BOUNDARY_CHORD_DEGREES = 5;

/**
 * Pure function. `v` clamped to [lo, hi], with `fallback` standing in for an
 * absent value. The shapeshifter `clamp` idiom reads an absent value as `lo`,
 * which is right only where `lo` IS the neutral value — every range there starts
 * at 0. `curvature` starts at −1, and that idiom read an unset knob as FULLY
 * CONCAVE (measured: a wide-open eight-blade opening came back at radius −3.08
 * instead of 1). The fallback is therefore explicit here rather than positional.
 * Ledger C-15; it lives here because every iris knob is read through it.
 *
 * @example clampKnob(0.4, 0, 1) // 0.4
 * @example clampKnob(undefined, 0, 1) // 0
 * @example clampKnob(undefined, -1, 1, 0) // 0 (an unset signed knob is NEUTRAL, not the floor)
 * @example clampKnob(5, 0, 1) // 1
 */
export const clampKnob = (v, lo, hi, fallback = lo) => Math.max(lo, Math.min(v ?? fallback, hi));

/**
 * Pure function. The BORE — the bbox-fitted ellipse the blades close across, and
 * the diaphragm body's outer edge. Same rx = w/2, ry = h/2 convention
 * circle.js/donut.js use, so a non-square box gives an elliptical iris.
 *
 * @example boreGeom({w: 240, h: 240}) // {cx: 120, cy: 120, rx: 120, ry: 120}
 * @example boreGeom({w: 200, h: 100}) // {cx: 100, cy: 50, rx: 100, ry: 50}
 */
export function boreGeom(s) {
  return { cx: (s.w ?? 0) / 2, cy: (s.h ?? 0) / 2, rx: (s.w ?? 0) / 2, ry: (s.h ?? 0) / 2 };
}

/**
 * Pure function. The ENTRANCE PUPIL's radii — the bore, squeezed on one axis by
 * `pupilAspect`. Above 1 is a horizontal oval, below 1 a vertical one; the pupil
 * always stays INSIDE the bore, so the squeeze shortens the other axis rather
 * than lengthening one past the box. An anamorphic lens's pupil really is oval,
 * which is why this cannot be expressed by resizing the widget: a preset may not
 * write w/h, and an oval no preset can name is not a modelled lens.
 *
 * @example pupilGeom({w: 200, h: 200, pupilAspect: 1}) // {cx: 100, cy: 100, rx: 100, ry: 100}
 * @example pupilGeom({w: 200, h: 200, pupilAspect: 0.5}) // {cx: 100, cy: 100, rx: 50, ry: 100}
 * @example pupilGeom({w: 200, h: 200, pupilAspect: 2}) // {cx: 100, cy: 100, rx: 100, ry: 50}
 */
export function pupilGeom(s) {
  const g = boreGeom(s);
  const a = Math.max(0, s.pupilAspect ?? 1);
  if (a >= 1) return { ...g, ry: a > 0 ? g.ry / a : 0 };
  return { ...g, rx: g.rx * a };
}

/**
 * Pure function. ONE blade's radial limit, in units of the blade-edge distance:
 * how far the opening may reach at `delta` radians off that blade's edge normal.
 *
 * A STRAIGHT leaf (curvature 0, or fewer blades than can make a polygon) is a
 * half-plane, so the limit is sec(delta) ahead of the edge and unbounded behind
 * it. A CURVED leaf is a genuine circular arc through the two crossings its
 * neighbours make with it, which as a REGION is a disc — centre `h` along the
 * normal, radius `rho` — so the limit is that disc's radial function:
 *
 *     r(delta) = h·cos(delta) ± sqrt(rho² − h²·sin²(delta))
 *
 * with `h` fixed by requiring the circle to pass through the polygon's own
 * vertices (radius sec(π/N)) while its nearest point sits at
 * `1 + c·(sec(π/N) − 1)`.
 *
 *   c = 1  forces h = 0 and rho = sec(π/N): the circle IS the circumcircle, so
 *          the opening is exactly round at every stop — a "circular aperture".
 *   c → 0  runs the centre off to infinity and the expression tends to
 *          sec(delta), which is why the straight case is a branch on the
 *          degenerate value rather than a different model.
 *   c < 0  puts the centre on the FAR side and the blade region becomes the
 *          OUTSIDE of the circle — an INWARDLY CURVED leaf, whose edge bulges
 *          into the opening and leaves concave sides. That is the MINUS root,
 *          and where the ray misses the circle entirely the leaf simply does not
 *          reach: Infinity, and a neighbour takes over.
 *
 * THE COMPLEMENT IS A LEAF. `plugins/aperture.js` reads this as the region light
 * may occupy; `plugins/iris_blades.js` reads the SAME function as the plate that
 * excludes it — everything at a bearing where the limit is finite and beyond
 * `edge · limit` is metal. One function, two readings, so the two widgets cannot
 * disagree about where a blade is.
 *
 * Args:
 *   delta (number): radians off this blade's edge normal
 *   blades (number): the blade count (sets the vertex angle π/N)
 *   curvature (number): −1 concave … 0 straight … 1 fully round, clamped
 *
 * Returns:
 *   number: the limit in units of the blade-edge distance (Infinity where this
 *   leaf does not reach, which constrains nothing)
 *
 * @example bladeRadialLimit(0, 6, 0) // 1 (a straight edge, at its own distance)
 * @example Math.round(bladeRadialLimit(Math.PI / 6, 6, 0) * 1e6) / 1e6 // 1.154701 (the hexagon's vertex, sec(30 deg))
 * @example bladeRadialLimit(Math.PI, 6, 0) // Infinity (behind the blade — no limit)
 * @example Math.round(bladeRadialLimit(0, 6, 1) * 1e6) / 1e6 // 1.154701 (fully curved: the circumcircle, same radius everywhere)
 * @example Math.round(bladeRadialLimit(Math.PI / 6, 6, 1) * 1e6) / 1e6 // 1.154701
 * @example Math.round(bladeRadialLimit(0, 6, -1) * 1e6) / 1e6 // 0.845299 (concave: the edge bulges IN, to 2 - sec(30 deg))
 * @example Math.round(bladeRadialLimit(Math.PI / 6, 6, -1) * 1e6) / 1e6 // 1.154701 (the vertex is unmoved — the crossings are fixed)
 */
export function bladeRadialLimit(delta, blades, curvature) {
  const n = Math.round(blades);
  const c = clampKnob(curvature, -1, 1, 0);
  const cosD = Math.cos(delta);
  if (c === 0 || n < MIN_POLYGON_BLADES) return cosD > 0 ? 1 / cosD : Infinity;
  const half = Math.PI / n;
  const sec = 1 / Math.cos(half);
  const near = 1 + c * (sec - 1); // the edge's nearest point, lerped through the crossings
  const h = (near * near - sec * sec) / (2 * (near - 1)); // circle centre, along the normal
  const rho = Math.abs(near - h);
  const sinD = Math.sin(delta);
  const under = rho * rho - h * h * sinD * sinD;
  if (c > 0) return h * cosD + Math.sqrt(Math.max(0, under));
  // CONCAVE: the leaf's region is the OUTSIDE of the circle, so the limit is the
  // NEAR intersection — and only where there is one. `rho >= h` means the circle
  // has swallowed the opening's own centre, which happens exactly when the
  // leaves meet (three blades at curvature −1); the iris is then shut, and
  // saying so is better than the negative radius the algebra hands back. A
  // MISSED ray (no real root, or the root behind the centre) is a leaf that does
  // not reach here at all, so it constrains nothing and a neighbour takes over.
  if (rho >= h) return 0;
  const root = h * cosD - Math.sqrt(Math.max(0, under));
  return under < 0 || root <= 0 ? Infinity : root;
}

/**
 * Pure function. Blade `k`'s edge NORMAL bearing in the pupil's normalized frame
 * — the one place the rotational repetition `bladeRotation + 2πk/N` is written
 * down, so no consumer can space the leaves differently from the opening.
 *
 * @example bladeAngle({blades: 4, bladeRotation: 0}, 1) // 1.5707963267948966
 * @example bladeAngle({blades: 8, bladeRotation: 0}, 0) // 0
 * @example bladeAngle({bladeRotation: 0}, 1) // 0.7853981633974483 (an absent count reads as DEFAULT_BLADES)
 */
export function bladeAngle(s, k) {
  const n = Math.max(1, Math.round(s.blades ?? DEFAULT_BLADES));
  return (s.bladeRotation ?? 0) + (2 * Math.PI * k) / n;
}

/**
 * Pure function. The opening's boundary radius at frame angle `theta` for a
 * REGULAR (N-sided) iris, as a FRACTION of the pupil radius: 0 shut … 1 the bare
 * bore. The intersection of the bore with every blade region, which for convex
 * regions containing the centre is just the minimum of their radial functions.
 *
 * A form that is not the regular polygon — the Reuleaux iris — is NOT here: it
 * has one consumer, so it stays in `plugins/aperture.js` (ledger C-1).
 *
 * Args:
 *   theta (number): angle in the pupil's normalized frame, radians
 *   s (object): item state — blades, stopDown, curvature, bladeRotation
 *
 * Returns:
 *   number: boundary radius in [0, 1]
 *
 * @example regularOpeningRadius(0, {blades: 0, stopDown: 0.5}) // 1 (no iris — the bare bore, whatever the stop)
 * @example regularOpeningRadius(0, {blades: 8, stopDown: 0}) // 1 (wide open: the blades are clear of the bore)
 * @example regularOpeningRadius(0, {blades: 8, stopDown: 0.5}) // 0.5 (on a blade normal: the edge itself)
 * @example Math.round(regularOpeningRadius(Math.PI / 8, {blades: 8, stopDown: 0.5}) * 1e6) / 1e6 // 0.541196 (the octagon's vertex)
 * @example Math.round(regularOpeningRadius(Math.PI / 8, {blades: 8, stopDown: 0.05}) * 1e6) / 1e6 // 1 (still clipped by the bore this close to wide open)
 */
export function regularOpeningRadius(theta, s) {
  const n = Math.max(0, Math.round(s.blades ?? 0));
  if (n < 1) return 1; // NO_IRIS_BLADES (and any negative) — the bare entrance pupil
  const edge = clampKnob(1 - (s.stopDown ?? 0), 0, 1);
  const c = clampKnob(s.curvature, -1, 1, 0);
  const rot = s.bladeRotation ?? 0;
  let r = 1;
  for (let k = 0; k < n; k++) {
    const limit = bladeRadialLimit(theta - rot - (2 * Math.PI * k) / n, n, c);
    // An INFINITE limit is a leaf that does not reach this bearing, so it never
    // enters the product: a shut iris has `edge` 0, and 0 × Infinity is NaN.
    if (Number.isFinite(limit)) r = Math.min(r, edge * limit);
  }
  return r;
}

/**
 * Pure function. The angles (radians) an iris boundary is sampled at: a uniform
 * sweep at BOUNDARY_CHORD_DEGREES, PLUS the exact corner angles so a corner stays
 * a corner however coarse the sweep is. Sorted, one full turn, open at the end
 * (the path closes itself).
 *
 * Args:
 *   corners (number): how many corners the opening has (0 = none to add)
 *   rotation (number): the blade set's heading, radians
 *   offset (number): where corner 0 sits relative to `rotation` — π/N for a
 *     regular polygon (a vertex sits halfway between two blade normals), 0 for a
 *     lobed form whose lobe sits ON a normal
 *
 * Returns:
 *   number[]: sample angles, ascending
 *
 * @example cornerBoundaryAngles(0, 0, 0).length // 72 (a full turn at 5 degrees, no corners to add)
 * @example cornerBoundaryAngles(8, 0, Math.PI / 8).length // 80 (72 + eight vertices)
 * @example cornerBoundaryAngles(3, 0, 0).length // 75 (72 + three lobes)
 * @example cornerBoundaryAngles(2, 0, Math.PI / 2).length // 72 (two blades make no polygon vertex)
 */
export function cornerBoundaryAngles(corners, rotation, offset) {
  const steps = Math.round(360 / BOUNDARY_CHORD_DEGREES);
  const out = [];
  for (let i = 0; i < steps; i++) out.push((2 * Math.PI * i) / steps);
  if (corners >= MIN_POLYGON_BLADES)
    for (let k = 0; k < corners; k++) out.push(rotation + offset + (2 * Math.PI * k) / corners);
  return out.sort((a, b) => a - b);
}

// ── HANDLES ──────────────────────────────────────────────────────────────────
// THE HANDLE-CONSTRAINT PROTOCOL (core/derive.js): every handle declares
// `constrain(state, desired) → allowed`, a pure projection onto its allowed set,
// and `apply(state, allowed)` reads a number back out of an ALREADY-allowed
// point. "Nearest" is measured in the ellipse's NORMALIZED frame — the frame the
// parameters are defined in, and the established house convention for
// ellipse-fitted widgets (donut.js / circle.js closestAnchor: exact when w === h;
// tests/handle_constraints_test.js ELLIPSE_NORMALIZED lists the families).
//
// THE FOUR BELOW ARE SHARED because the two iris widgets drive the SAME four
// parameters and a handle is where a parameter is spatial. They are placed so no
// two can ever coincide: `stopDown` on blade zero's edge NORMAL, `curvature` on
// blade TWO's, `bladeRotation` on the VERTEX bearing and `blades` one pitch round
// from blade zero. Each widget composes them with its own extra handles.

/** Pure function. A LOCAL point at normalized radius `t` and angle `a` on the
 *  pupil ellipse.
 *  @example pupilPoint({w: 200, h: 200}, 0.5, 0) // {x: 150, y: 100} */
export function pupilPoint(s, t, a) {
  const g = pupilGeom(s);
  return { x: g.cx + g.rx * t * Math.cos(a), y: g.cy + g.ry * t * Math.sin(a) };
}

/** Pure function. The normalized radial coordinate of a LOCAL point along the
 *  direction `a` — pupilPoint's inverse, and 0 when the pupil has no extent to
 *  take a fraction of (a division guard, not a bound: the stored value stands).
 *  @example pupilRadialT({w: 200, h: 200}, {x: 150, y: 100}, 0) // 0.5 */
export function pupilRadialT(s, p, a) {
  const g = pupilGeom(s);
  if (!(g.rx > 0) || !(g.ry > 0)) return 0;
  return ((p.x - g.cx) / g.rx) * Math.cos(a) + ((p.y - g.cy) / g.ry) * Math.sin(a);
}

/** Pure function. The nearest point on the RADIAL SEGMENT between normalized
 *  radii `tMin` and `tMax` along `a`, measured in the normalized frame.
 *  @example radialConstrain({w: 200, h: 200}, 0, 0, 1, {x: 300, y: 100}) // {x: 200, y: 100} */
export function radialConstrain(s, a, tMin, tMax, desired) {
  const g = pupilGeom(s);
  const toN = (p) => ({ x: (p.x - g.cx) / (g.rx || 1), y: (p.y - g.cy) / (g.ry || 1) });
  const end = (t) => ({ x: t * Math.cos(a), y: t * Math.sin(a) });
  const n = closestPointOnSegment(end(tMin), end(tMax), toN(desired));
  return { x: g.cx + g.rx * n.x, y: g.cy + g.ry * n.y };
}

/** Pure function. The nearest point on the pupil RIM (t = 1, any angle), in the
 *  normalized frame — the allowed set of a handle that only sets an ANGLE.
 *  @example rimConstrain({w: 200, h: 200}, {x: 150, y: 100}) // {x: 200, y: 100} */
export function rimConstrain(s, desired) {
  const g = pupilGeom(s);
  const a = Math.atan2((desired.y - g.cy) / (g.ry || 1), (desired.x - g.cx) / (g.rx || 1));
  return pupilPoint(s, 1, a);
}

/** Pure function. The blade COUNT a rim bearing describes as the gap from the
 *  first blade normal — ONE reading shared by the `blades` handle's constraint
 *  and its write, so the discrete step cannot drift between them. Floors at
 *  MIN_POLYGON_BLADES (below it there is no polygon for a rim handle to read).
 *  @example bladeCountFromAngle(0, Math.PI / 2) // 4
 *  @example bladeCountFromAngle(0, Math.PI) // 3 (a half-turn wants two blades; the count floors) */
export function bladeCountFromAngle(rotation, a) {
  const gap = Math.max(1e-3, (((a - rotation) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
  return Math.max(MIN_POLYGON_BLADES, Math.round((2 * Math.PI) / gap));
}

/**
 * Pure function. The `stopDown` handle: blade zero's edge, dragged along its own
 * normal from the pupil centre (shut) to the rim (wide open).
 *
 * @example stopDownHandle({w: 200, h: 200, blades: 8, stopDown: 0.5}).id // "stopDown"
 * @example stopDownHandle({w: 200, h: 200, blades: 8, stopDown: 0.5}).x // 150
 */
export function stopDownHandle(s) {
  return {
    id: "stopDown", ...pupilPoint(s, clampKnob(1 - (s.stopDown ?? 0), 0, 1), bladeAngle(s, 0)),
    constrain: (st, p) => radialConstrain(st, bladeAngle(st, 0), 0, 1, p),
    apply: (st, p) => ({ stopDown: 1 - clampKnob(pupilRadialT(st, p, bladeAngle(st, 0)), 0, 1) }),
  };
}

/**
 * Pure function. The `curvature` handle: blade TWO's edge midpoint, which travels
 * from bulged-in through the flat out to the circumcircle as the leaf's edge bows
 * — that IS what curvature means, and the two ends of the run are −1 and +1.
 *
 * Blade TWO, not blade one: `bladesHandle` must sit on blade ONE's pitch (its
 * reading IS the gap from blade zero), and at stopDown 0 both would be on the rim
 * at the same bearing.
 *
 * @example curvatureHandle({w: 200, h: 200, blades: 8, stopDown: 0.5, curvature: 0}).id // "curvature"
 * @example Math.round(curvatureHandle({w: 200, h: 200, blades: 8, stopDown: 0.5, curvature: 0}).x) // 100
 */
export function curvatureHandle(s) {
  const secOf = (st) => 1 / Math.cos(Math.PI / Math.max(MIN_POLYGON_BLADES, Math.round(st.blades ?? DEFAULT_BLADES)));
  const spanOf = (st) => clampKnob(1 - (st.stopDown ?? 0), 0, 1) * (secOf(st) - 1);
  const edgeOf = (st) => clampKnob(1 - (st.stopDown ?? 0), 0, 1);
  return {
    id: "curvature",
    ...pupilPoint(s, edgeOf(s) * (1 + clampKnob(s.curvature, -1, 1, 0) * (secOf(s) - 1)), bladeAngle(s, 2)),
    constrain: (st, p) => radialConstrain(st, bladeAngle(st, 2), edgeOf(st) - spanOf(st), edgeOf(st) + spanOf(st), p),
    apply: (st, p) => {
      const span = spanOf(st);
      // A shut opening has no span to read a fraction of — a division guard, not
      // a bound (the donut.js / lens_flare precedent).
      if (!(span > 0)) return { curvature: clampKnob(st.curvature, -1, 1, 0) };
      return { curvature: clampKnob((pupilRadialT(st, p, bladeAngle(st, 2)) - edgeOf(st)) / span, -1, 1) };
    },
  };
}

/**
 * Pure function. The `bladeRotation` handle: the rim at the opening's VERTEX
 * bearing — grab a corner and spin it.
 *
 * @example bladeRotationHandle({w: 200, h: 200, blades: 4, bladeRotation: 0}).id // "bladeRotation"
 * @example bladeRotationHandle({w: 200, h: 200, blades: 4, bladeRotation: 0}).apply({w: 200, h: 200, blades: 4}, {x: 100, y: 200}) // {bladeRotation: 0.7853981633974483}
 */
export function bladeRotationHandle(s) {
  const vertexOf = (st) => bladeAngle(st, 0) + Math.PI / Math.max(1, Math.round(st.blades ?? DEFAULT_BLADES));
  return {
    id: "bladeRotation", ...pupilPoint(s, 1, vertexOf(s)),
    constrain: (st, p) => rimConstrain(st, p),
    apply: (st, p) => {
      const g = pupilGeom(st);
      if (!(g.rx > 0) || !(g.ry > 0)) return { bladeRotation: st.bladeRotation ?? 0 };
      const a = Math.atan2((p.y - g.cy) / g.ry, (p.x - g.cx) / g.rx);
      return { bladeRotation: a - Math.PI / Math.max(1, Math.round(st.blades ?? DEFAULT_BLADES)) };
    },
  };
}

/**
 * Pure function. The `blades` handle: the rim one PITCH round from blade zero, so
 * the gap the user drags IS the count. A DISCRETE set — the count is rounded in
 * COUNT, so the handle lands on the nearest allowed COUNT rather than the nearest
 * allowed angle (the shapeshifter polygon/star precedent).
 *
 * @example bladesHandle({w: 200, h: 200, blades: 4, bladeRotation: 0}).id // "blades"
 * @example bladesHandle({w: 200, h: 200, blades: 4, bladeRotation: 0}).apply({w: 200, h: 200, blades: 4}, {x: 100, y: 200}) // {blades: 4}
 */
export function bladesHandle(s) {
  const n = Math.max(1, Math.round(s.blades ?? DEFAULT_BLADES));
  return {
    id: "blades", ...pupilPoint(s, 1, bladeAngle(s, 0) + (2 * Math.PI) / n),
    constrain: (st, p) => {
      const g = pupilGeom(st);
      if (!(g.rx > 0) || !(g.ry > 0)) return pupilPoint(st, 1, bladeAngle(st, 0));
      const a = Math.atan2((p.y - g.cy) / g.ry, (p.x - g.cx) / g.rx);
      const rot = bladeAngle(st, 0);
      return pupilPoint(st, 1, rot + (2 * Math.PI) / bladeCountFromAngle(rot, a));
    },
    apply: (st, p) => {
      const g = pupilGeom(st);
      if (!(g.rx > 0) || !(g.ry > 0)) return { blades: Math.max(MIN_POLYGON_BLADES, Math.round(st.blades ?? DEFAULT_BLADES)) };
      const a = Math.atan2((p.y - g.cy) / g.ry, (p.x - g.cx) / g.rx);
      return { blades: bladeCountFromAngle(bladeAngle(st, 0), a) };
    },
  };
}

/**
 * Pure function. The three handles that only mean anything once the opening HAS a
 * polygon — curvature has an edge to bow, and both rim handles have a corner to
 * read. Below MIN_POLYGON_BLADES they are absent rather than inert, which is the
 * same condition under which their parameters mean nothing.
 *
 * @example irisPolygonHandles({w: 200, h: 200, blades: 8}).map((h) => h.id) // ["curvature", "bladeRotation", "blades"]
 * @example irisPolygonHandles({w: 200, h: 200, blades: 2}) // [] (two leaves make no polygon)
 */
export function irisPolygonHandles(s) {
  if (Math.max(0, Math.round(s.blades ?? DEFAULT_BLADES)) < MIN_POLYGON_BLADES) return [];
  return [curvatureHandle(s), bladeRotationHandle(s), bladesHandle(s)];
}

/**
 * Query→pure. The BORE's closest point to a WORLD target, in LOCAL coords — the
 * dynamic-anchor hook both iris widgets use. A radial point on the bore ellipse
 * toward the target: identical convention to circle.js's and donut.js's
 * closestAnchor, and exact when w === h.
 *
 * (Those two roll their own copies of this five-line body; consolidating all
 * four is a separate change in files this module's authors do not own. Recorded
 * rather than done.)
 *
 * @example boreClosestAnchor({w: 200, h: 200}, 500, 100, {x: 0, y: 0, rotation: 0, scale: 1}) // {x: 200, y: 100}
 * @example boreClosestAnchor({w: 200, h: 200}, 100, 500, {x: 0, y: 0, rotation: 0, scale: 1}).y // 200
 */
export function boreClosestAnchor(state, wx, wy, world) {
  const local = T.apply(T.invert(world), wx, wy);
  const { cx, cy, rx, ry } = boreGeom(state);
  const theta = Math.atan2((local.y - cy) / ry, (local.x - cx) / rx);
  return { x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) };
}

// ── THE SHARED ROW CONTRACTS ─────────────────────────────────────────────────
// `aperture` and `iris_blades` describe ONE diaphragm, so a value typed into one
// must survive being retyped into the other. `core/retype.js` carries a value
// only when both plugins declare the key AND the rows are kind-compatible, and
// `core/multiselect.sameRowContract` decides what "the same row" means: key,
// kind, min, max, step-free things like `display` and `paint` are CONTRACT;
// `label`, `help`, `category`, `step` and `scrub` are PRESENTATIONAL. A
// hand-copied second declaration would pass the day it was written and break
// silently the first time either side moved a contract aspect — the
// core/video_sampling.js lesson — so the contract is declared ONCE, here, and
// each widget supplies only its own `help`.

/**
 * The geometry both iris widgets share. Not a taste grouping: these are exactly
 * the values that describe the MECHANISM rather than its depiction, which is why
 * retyping between the two carries them and why the two widgets then draw the
 * same opening.
 */
export const IRIS_SHARED_KEYS = ["blades", "stopDown", "curvature", "bladeRotation", "pupilAspect", "pupilFill"];

const IRIS_ROW_CONTRACTS = {
  blades: { label: "Blades", kind: "number", min: NO_IRIS_BLADES, step: 1, category: "formatting" },
  stopDown: { label: "Stop down", kind: "number", min: 0, max: 1, category: "formatting" },
  curvature: { label: "Blade curvature", kind: "number", min: -1, max: 1, category: "formatting" },
  bladeRotation: { label: "Blade rotation", kind: "angle", display: "degrees", category: "formatting" },
  pupilAspect: { label: "Pupil aspect", kind: "number", min: 0, scrub: UNIT_SPAN_SCRUB, category: "formatting" },
  pupilFill: { label: "Pupil fill", kind: "color", paint: true, category: "fillMaterial" },
};

/**
 * Pure function. One shared Inspector row, with this widget's own `help`. The
 * caller supplies help and nothing else, because help is the ONLY aspect two
 * widgets modelling the same quantity may legitimately disagree about — an
 * aperture's `stopDown` closes an opening, an iris_blades' `stopDown` swings the
 * plates, and both sentences are true of the same number.
 *
 * Args:
 *   key (string): one of IRIS_SHARED_KEYS
 *   help (string): the widget's own explanation of the property
 *
 * Returns:
 *   object: an Inspector row
 *
 * @example irisRow("stopDown", "How far the leaves have swung.").kind // "number"
 * @example irisRow("stopDown", "How far the leaves have swung.").max // 1
 * @example irisRow("bladeRotation", "Which way the plates point.").display // "degrees"
 * @example irisRow("pupilFill", "The light coming through.").paint // true
 */
export function irisRow(key, help) {
  const contract = IRIS_ROW_CONTRACTS[key];
  // A typo here would silently produce a row with no kind, which the Inspector
  // renders as nothing at all — so it fails loudly instead.
  if (!contract) throw new Error(`irisRow: "${key}" is not a shared iris property (have: ${IRIS_SHARED_KEYS.join(", ")})`);
  return { key, ...contract, help };
}

/**
 * The shared geometry's default VALUES, so an untouched widget of either type
 * describes the same lens and retyping an untouched one changes nothing.
 *
 * `curvature` is 0.35 because "SLIGHTLY ROUNDED" is what the common modern lens
 * actually has — reviewers' standing description of Canon's house iris, and the
 * middle of the four terms the literature uses (straight / slightly rounded /
 * rounded / inwardly curved) — so an untouched widget is the COMMON CASE rather
 * than one particular lens. It also has to be non-zero for a mechanical reason
 * worth recording because it is how the value was found: at 0 the untouched
 * aperture was BYTE-IDENTICAL to its "Straight Eight-Blade Prime" preset, and
 * tests/aperture_presets_probe.js correctly called that a dead row (ledger C-16).
 * The default must not BE one of the shipped lenses, in EITHER family.
 */
export const IRIS_SHARED_DEFAULTS = {
  blades: DEFAULT_BLADES,
  stopDown: 0.5,
  curvature: 0.35,
  bladeRotation: 0, // RADIANS, shown in degrees — see the row contract
  pupilAspect: 1,
};
