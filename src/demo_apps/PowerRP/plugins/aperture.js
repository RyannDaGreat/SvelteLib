/**
 * APERTURE — a camera IRIS DIAPHRAGM: N overlapping blades closing a circular
 * bore down to a polygonal opening, drawn as the mechanism AND as the thing the
 * mechanism produces (the bokeh polygon, and optionally the sunstar). R6-17.1,
 * feeding R6-3.4's "model SPECIFIC REAL CAMERAS AND LENSES" and R6-3.11's
 * cross-widget blade/ray consistency.
 *
 * ── THE GEOMETRY, AND WHY IT IS AN INTERSECTION AND NOT A POLYGON GENERATOR ───
 * A real iris is not "draw an N-gon". It is a round BORE with N leaves swinging
 * across it, so the opening is the INTERSECTION of the bore disc with N blade
 * regions — and every behaviour a photographer recognises falls out of that one
 * construction instead of being a knob:
 *
 *   · WIDE OPEN IS ROUND, whatever the blade count. At `stopDown` 0 the leaves
 *     sit clear of the bore and the barrel's own edge is the aperture, which is
 *     exactly what the sources say happens ("the blades recessed into the sides
 *     of the lens, allowing the interior edge of the lens barrel to effectively
 *     become the iris"). No preset has to ask for it. THE ONE EXCEPTION IS
 *     GEOMETRIC AND STATED RATHER THAN PAPERED OVER: an INWARDLY curved leaf
 *     bulges toward the centre by construction, so once its crossings are
 *     recessed to the barrel its middle is still inside — a concave iris shows
 *     concave sides at every stop, which is exactly why that lens looks the way
 *     it does.
 *   · THE "CIRCLE WITH FLATS" PHASE is real and narrow. The polygon only becomes
 *     the whole boundary once its CIRCUMradius clears the bore, i.e. once
 *     `stopDown > 1 − cos(π/N)` — 0.076 for eight blades, so a straight-bladed
 *     lens shows arcs between chords for about the first fraction of a stop and
 *     a hard polygon after. Emergent, not tuned.
 *   · CURVATURE IS THE BLADE'S EDGE, not a blend toward a circle. A rounded leaf
 *     has a genuinely circular inner edge, so `curvature` turns each blade's
 *     half-plane into a DISC through the same two crossings; at 1 the N discs
 *     coincide with the opening's own circumcircle and the opening is exactly
 *     round at every stop, which is what a "circular aperture" lens claims. It
 *     runs NEGATIVE too, because "inwardly curved" leaves are a real thing a
 *     0..1 knob cannot say: the Leica Summicron 90mm f/2 pre-ASPH has eleven of
 *     them, and its opening is a concave-sided star.
 *
 * Everything is a POLAR RADIAL FUNCTION about the pupil centre. That is legal
 * because every region involved is convex and contains the centre, so the
 * intersection's radial function is the MINIMUM of theirs — the bore clip is a
 * `Math.min`, not a clipping algorithm.
 *
 * ── WHAT IT DRAWS, IN ORDER ──────────────────────────────────────────────────
 *   1. THE PUPIL FILL — the light coming through the opening. This IS the bokeh
 *      polygon R6-3.4 asks for. `apodization` grades it to nothing before the
 *      rim (a radial-gradient paint, see apodizedPupilPaint).
 *   2. THE BLADES — the bbox-fitted outer ellipse with the opening as an
 *      even-odd HOLE, so a pupil fill of `none` leaves a real hole and the
 *      widget becomes an iris vignette over whatever is behind it. Drawn OVER
 *      the pupil fill, which is why an apodized highlight fades inward rather
 *      than bleeding over metal.
 *   3. THE SUNSTAR — off by default; see the parity note below.
 * ONE `path` op per layer, `subpathsPathD` + `fillRule: "evenodd"`, never a
 * triangle fan (plugins/donut.js's R6-11 write-up is the post-mortem on why).
 *
 * ── THE PARITY LAW IS NOT A KNOB (R6-3.11) ───────────────────────────────────
 * `sunstar` sets the rays' LENGTH. Their COUNT is derived by
 * core/optics.starburstRayAngles from `blades` alone and can never be authored:
 * an aperture is a real function, so its diffraction rays come in opposed pairs
 * and N blades give N rays when N is even and 2N when N is odd. There is no such
 * thing as an odd-numbered sunstar. The lens flare's `blades` row means the SAME
 * count under the SAME law (its shader doubles internally), so setting both
 * widgets to 9 describes one lens and draws eighteen rays in both.
 *
 * KNOWN CROSS-WIDGET OFFSET, quantified rather than hidden: rays leave a blade
 * EDGE along its normal, which this widget honours, while every shipped flare
 * preset writes `starburstRotation: 0` against `bladeRotation: 0` here. A
 * matching pair is therefore out of phase by 180/N degrees until someone rules on
 * it (recorded as G4 in .frenzy/round6/presets/optical_flare_aperture.md).
 *
 * ── SOURCES FOR THE PRESETS ──────────────────────────────────────────────────
 * Every blade count in PRESETS below is SOURCED — see the table's own header.
 * The research is `.frenzy/round6/presets/LENS_TABLE.md` (45 rows) and the
 * schema/preset design is `.frenzy/round6/presets/optical_flare_aperture.md`,
 * which this file implements rather than re-deriving.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { MIN_POLYGON_BLADES, NO_IRIS_BLADES, starburstRayAngles } from "../core/optics.js";
import { closestPointOnSegment, pointInOutlines } from "../core/outline.js";
import { paintModifierPoints } from "../core/paint_handles.js";
import { bundle, bundleNestedDefaults, defaults, props, UNIT_SPAN_SCRUB } from "../core/properties.js";
import { subpathsPathD } from "../core/shapes.js";
import * as T from "../core/transform.js";
import { isPaintOff, parseColor, paintSolidColor, path } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/** The blade count a fresh aperture starts at: eight is the commonest modern
 *  iris, and it is the same value the lens flare's `blades` row defaults to. */
const DEFAULT_BLADES = 8;

/**
 * The blade curvature a fresh aperture starts at. "SLIGHTLY ROUNDED" is what the
 * common modern lens actually has — reviewers' standing description of Canon's
 * house iris, and the middle of the four terms the literature uses (straight /
 * slightly rounded / rounded / inwardly curved) — so an untouched widget is the
 * COMMON CASE rather than one particular lens.
 *
 * It also has to be non-zero for a second, mechanical reason, and that is worth
 * writing down because it is how the value was found: at 0 the untouched widget
 * was BYTE-IDENTICAL to the "Straight Eight-Blade Prime" preset, and
 * tests/aperture_presets_probe.js correctly called that a dead row. The default
 * must not BE one of the shipped lenses.
 */
const DEFAULT_CURVATURE = 0.35;

/** A Reuleaux curve of constant width has THREE lobes by construction — it is
 *  built on an equilateral triangle — whatever the leaf count that forms it. */
const REULEAUX_LOBES = 3;

/**
 * The angular step the opening's boundary is sampled at, in degrees. Chosen from
 * the SAGITTA: a 5-degree chord on a 200 px radius departs from the true curve by
 * 200·(1 − cos 2.5°) = 0.19 px, under a quarter pixel, so the tessellation is
 * invisible at any size this widget is authored at. Polygon VERTICES are added
 * exactly on top of this sampling, so a corner stays a corner however coarse the
 * sampling is; only the smooth stretches are approximated.
 */
const BOUNDARY_CHORD_DEGREES = 5;

/**
 * The pupil-fill gradient's radius in objectBoundingBox units — 0.5 is the
 * opening's own edge, measured from its centre, which is where an apodized
 * transmission must reach zero. Not a tuning knob: it is what "the rim" means in
 * the coordinate space `parsePaint` defines for a radial paint.
 */
const PUPIL_GRADIENT_EDGE = 0.5;

/**
 * A diffraction ray's half-width where it is widest, as a fraction of its own
 * length, and where along the ray that widest point sits. A spike is a narrow
 * lobe that is brightest close to the source and tapers to a point, so the
 * profile is a kite with its waist near the base rather than a triangle.
 */
const RAY_HALF_WIDTH = 0.05;
const RAY_WAIST = 0.2;

/**
 * Pure function. `v` clamped to [lo, hi], with `fallback` standing in for an
 * absent value. shapeshifter.js's clamp reads an absent value as `lo`, which is
 * right only where `lo` IS the neutral value — every range there starts at 0.
 * `curvature` starts at −1, and that idiom read an unset knob as FULLY CONCAVE
 * (measured: a wide-open eight-blade opening came back at radius −3.08 instead
 * of 1). The fallback is therefore explicit here rather than positional.
 *
 * @example clamp(0.4, 0, 1) // 0.4
 * @example clamp(undefined, 0, 1) // 0
 * @example clamp(undefined, -1, 1, 0) // 0 (an unset signed knob is NEUTRAL, not the floor)
 */
const clamp = (v, lo, hi, fallback = lo) => Math.max(lo, Math.min(v ?? fallback, hi));

// Inline Inspector row builders — the donut.js precedent (rows declared in the
// plugin, not in the shared registry). Category "formatting" puts the iris knobs
// with fill/stroke, above the effects accordion.
const N = (key, label, extra = {}) => ({ key, label, kind: "number", category: "formatting", ...extra });
const SEL = (key, label, options, optionLabels, help) => ({ key, label, kind: "select", options, optionLabels, category: "formatting", help });

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
  const c = clamp(curvature, -1, 1, 0);
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
 * Pure function. The radial function of a REULEAUX curve of constant width whose
 * vertices sit at radius 1 from its centroid, at `phi` radians from vertex 0.
 * Each of its three arcs is centred on the OPPOSITE vertex with radius equal to
 * the side, so at every angle the boundary satisfies |P − A| = sqrt(3), giving
 *
 *     r = cos(d) + sqrt(cos(d)² + 2),   d = the angle to the most-opposite vertex
 *
 * This exists because a blade COUNT does not determine the opening's shape: the
 * 35mm ZEISS Super Speed Mk I closes its NINE leaves into a curved triangle, and
 * its photographed bokeh is a triangle. A schema that derived the polygon from
 * the count could not represent a real, shipped lens.
 *
 * @example Math.round(reuleauxRadialLimit(0) * 1e6) / 1e6 // 1 (a vertex)
 * @example Math.round(reuleauxRadialLimit(Math.PI) * 1e6) / 1e6 // 0.732051 (an arc's midpoint: sqrt(3) - 1)
 * @example Math.round(reuleauxRadialLimit((2 * Math.PI) / 3) * 1e6) / 1e6 // 1 (the next vertex)
 */
export function reuleauxRadialLimit(phi) {
  let cosD = 1;
  for (let k = 0; k < REULEAUX_LOBES; k++)
    cosD = Math.min(cosD, Math.cos(phi - (2 * Math.PI * k) / REULEAUX_LOBES));
  return cosD + Math.sqrt(cosD * cosD + 2);
}

/**
 * Pure function. The opening's boundary radius at world-frame angle `theta`, as a
 * FRACTION of the pupil radius (0 shut … 1 the bare bore). The intersection of
 * the bore with every blade region, which for convex regions containing the
 * centre is just the minimum of their radial functions.
 *
 * Args:
 *   theta (number): angle in the pupil's normalized frame, radians
 *   s (object): item state — blades, stopDown, curvature, bladeForm, bladeRotation
 *
 * Returns:
 *   number: boundary radius in [0, 1]
 *
 * @example openingRadius(0, {blades: 0, stopDown: 0.5}) // 1 (no iris — the bare bore, whatever the stop)
 * @example openingRadius(0, {blades: 8, stopDown: 0}) // 1 (wide open: the blades are clear of the bore)
 * @example openingRadius(0, {blades: 8, stopDown: 0.5}) // 0.5 (on a blade normal: the edge itself)
 * @example Math.round(openingRadius(Math.PI / 8, {blades: 8, stopDown: 0.5}) * 1e6) / 1e6 // 0.541196 (the octagon's vertex)
 * @example Math.round(openingRadius(Math.PI / 8, {blades: 8, stopDown: 0.05}) * 1e6) / 1e6 // 1 (still clipped by the bore this close to wide open)
 */
export function openingRadius(theta, s) {
  const edge = clamp(1 - (s.stopDown ?? 0), 0, 1);
  const rot = s.bladeRotation ?? 0;
  const c = clamp(s.curvature, -1, 1, 0);
  if (s.bladeForm === "reuleaux") {
    // A Reuleaux curve is already all arcs, so curvature can only round it the
    // rest of the way to its circumcircle. A NEGATIVE value has nothing to mean
    // here — a concave-sided curve is no longer of constant width — so the form
    // reads it as straight rather than inventing a shape.
    const round = Math.max(0, c);
    const vertex = edge / Math.cos(Math.PI / REULEAUX_LOBES); // the curve's circumradius
    return Math.min(1, vertex * (round + (1 - round) * reuleauxRadialLimit(theta - rot)));
  }
  const n = Math.max(0, Math.round(s.blades ?? 0));
  if (n < 1) return 1; // NO_IRIS_BLADES (and any negative) — the bare entrance pupil
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
 * Pure function. The angles (radians) the opening's boundary is sampled at: a
 * uniform sweep at BOUNDARY_CHORD_DEGREES, PLUS the exact polygon vertex angles
 * so a corner stays a corner however coarse the sweep is. Sorted, one full turn,
 * open at the end (the path closes itself).
 *
 * @example boundaryAngles({blades: 0}).length // 72 (a full turn at 5 degrees, no corners to add)
 * @example boundaryAngles({blades: 8}).length // 80 (72 + eight vertices)
 * @example boundaryAngles({blades: 8, bladeForm: "reuleaux"}).length // 75 (72 + three lobes)
 * @example boundaryAngles({blades: 2}).length // 72 (two blades make no polygon vertex)
 */
export function boundaryAngles(s) {
  const steps = Math.round(360 / BOUNDARY_CHORD_DEGREES);
  const out = [];
  for (let i = 0; i < steps; i++) out.push((2 * Math.PI * i) / steps);
  const rot = s.bladeRotation ?? 0;
  const corners = s.bladeForm === "reuleaux" ? REULEAUX_LOBES : Math.max(0, Math.round(s.blades ?? 0));
  // A vertex sits halfway between two blade normals; a Reuleaux lobe sits ON one.
  const offset = s.bladeForm === "reuleaux" ? 0 : Math.PI / Math.max(1, corners);
  if (corners >= MIN_POLYGON_BLADES)
    for (let k = 0; k < corners; k++) out.push(rot + offset + (2 * Math.PI * k) / corners);
  return out.sort((a, b) => a - b);
}

/**
 * Pure function. A closed LOCAL-space point list on an ellipse's rim, scaled
 * radially by `radiusOf(theta)` — the one sampler both the opening and the plain
 * bore outline go through, so they cannot disagree about tessellation.
 *
 * Args:
 *   g ({cx, cy, rx, ry}): the ellipse
 *   angles (number[]): sample angles, radians
 *   radiusOf (function): theta → radius fraction in [0, 1]
 *
 * Returns:
 *   number[][]: closed point list [[x, y], ...] in LOCAL coords
 *
 * @example radialOutline({cx: 0, cy: 0, rx: 10, ry: 10}, [0, Math.PI / 2], () => 1) // [[10, 0], [6.123233995736766e-16, 10]]
 * @example radialOutline({cx: 5, cy: 5, rx: 4, ry: 4}, [0], () => 0.5) // [[7, 5]]
 */
export function radialOutline(g, angles, radiusOf) {
  return angles.map((a) => {
    const r = radiusOf(a);
    return [g.cx + g.rx * r * Math.cos(a), g.cy + g.ry * r * Math.sin(a)];
  });
}

/**
 * Pure function. The opening's closed outline in LOCAL coords — the BOKEH
 * POLYGON, scaled by `scale` (1 = the opening itself, `obstruction` = the
 * central obstruction's rim, which is the same shape concentrically shrunk, the
 * donut.js `inner` convention).
 *
 * @example openingOutline({w: 200, h: 200, blades: 0, stopDown: 0})[0] // [200, 100]
 * @example openingOutline({w: 200, h: 200, blades: 0, stopDown: 0}, 0.5)[0] // [150, 100]
 * @example openingOutline({w: 200, h: 200, blades: 8, stopDown: 0.5})[0] // [150, 100]
 */
export function openingOutline(s, scale = 1) {
  const g = pupilGeom(s);
  return radialOutline(g, boundaryAngles(s), (a) => scale * openingRadius(a, s));
}

/**
 * Pure function. The diaphragm BODY's two subpaths — the bbox-fitted bore, then
 * the opening as an even-odd hole. `null` when the opening already fills the
 * bore (wide open on a round pupil), because a body with no area must emit no op
 * rather than a degenerate one.
 *
 * @example bodySubpaths({w: 200, h: 200, blades: 8, stopDown: 0.5}).length // 2
 * @example bodySubpaths({w: 200, h: 200, blades: 8, stopDown: 0}) // null (wide open — the barrel edge IS the aperture)
 * @example bodySubpaths({w: 200, h: 200, blades: 0, stopDown: 0.9}) // null (no iris — nothing closes the bore)
 */
export function bodySubpaths(s) {
  const bore = boreGeom(s);
  const angles = boundaryAngles(s);
  const opening = openingOutline(s);
  const closed = angles.some((a) => openingRadius(a, s) < 1) || (s.pupilAspect ?? 1) !== 1;
  if (!closed) return null;
  return [radialOutline(bore, angles, () => 1), opening];
}

/**
 * Pure function. One diffraction ray as a closed KITE: from the pupil centre out
 * to `length`, widest at RAY_WAIST along its own run. Local coords, elliptical
 * frame, so a ray on a non-square box leans with the box exactly as the opening
 * does.
 *
 * @example rayOutline({cx: 0, cy: 0, rx: 100, ry: 100}, 0, 1).length // 4
 * @example rayOutline({cx: 0, cy: 0, rx: 100, ry: 100}, 0, 1)[2] // [100, 0] (the tip, on the bore rim)
 */
export function rayOutline(g, angle, length) {
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const at = (t, side) => [
    g.cx + g.rx * (length * t * ux - side * RAY_HALF_WIDTH * length * uy),
    g.cy + g.ry * (length * t * uy + side * RAY_HALF_WIDTH * length * ux),
  ];
  return [at(0, 0), at(RAY_WAIST, 1), at(1, 0), at(RAY_WAIST, -1)];
}

/**
 * Pure function. The pupil paint, graded by `apodization`: unchanged at 0, and
 * above it a radial gradient holding full transmission out to `1 − apodization`
 * of the way to the rim and falling to fully transparent AT the rim. That is the
 * apodizing element's whole effect — the highlight "fades smoothly to zero
 * intensity" instead of ending in a hard edge — and it is a real paint rather
 * than a mask blur so the SVG and PDF exporters draw the same picture the raster
 * backend does (a `path` op's `blur` field reaches neither).
 *
 * @example apodizedPupilPaint("#ffffff", 0) // "#ffffff"
 * @example apodizedPupilPaint("#ffffff", 0.5).type // "radialGradient"
 * @example apodizedPupilPaint("#ffffff", 0.5).stops[1].offset // 0.5
 * @example apodizedPupilPaint("#ffffff", 0.5).stops[2].color // [1, 1, 1, 0]
 */
export function apodizedPupilPaint(paint, apodization) {
  const a = clamp(apodization, 0, 1);
  if (a <= 0) return paint;
  const solid = typeof paint === "string" || Array.isArray(paint) ? paint : paintSolidColor(paint);
  const [r, g, b] = parseColor(solid);
  return {
    type: "radialGradient",
    center: { x: PUPIL_GRADIENT_EDGE, y: PUPIL_GRADIENT_EDGE },
    r: PUPIL_GRADIENT_EDGE,
    stops: [
      { offset: 0, color: solid },
      { offset: 1 - a, color: solid },
      { offset: 1, color: [r, g, b, 0] },
    ],
  };
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
// The five handles are placed so no two can ever coincide: `stopDown` on blade
// zero's edge NORMAL, `curvature` on blade ONE's (which exists only when there
// are at least MIN_POLYGON_BLADES, the same condition under which curvature has
// a polygon to round), `obstruction` on the OPPOSITE normal, and both rim
// handles on the VERTEX bearing, a further π/N away.

/** Pure function. The unit direction of blade `k`'s edge normal, in the pupil's
 *  normalized frame.
 *  @example bladeAngle({blades: 4, bladeRotation: 0}, 1) // 1.5707963267948966 */
function bladeAngle(s, k) {
  const n = Math.max(1, Math.round(s.blades ?? DEFAULT_BLADES));
  return (s.bladeRotation ?? 0) + (2 * Math.PI * k) / n;
}

/** Pure function. A LOCAL point at normalized radius `t` and angle `a` on the
 *  pupil ellipse.
 *  @example pupilPoint({w: 200, h: 200}, 0.5, 0) // {x: 150, y: 100} */
function pupilPoint(s, t, a) {
  const g = pupilGeom(s);
  return { x: g.cx + g.rx * t * Math.cos(a), y: g.cy + g.ry * t * Math.sin(a) };
}

/** Pure function. The normalized radial coordinate of a LOCAL point along the
 *  direction `a` — pupilPoint's inverse, and 0 when the pupil has no extent to
 *  take a fraction of (a division guard, not a bound: the stored value stands).
 *  @example pupilRadialT({w: 200, h: 200}, {x: 150, y: 100}, 0) // 0.5 */
function pupilRadialT(s, p, a) {
  const g = pupilGeom(s);
  if (!(g.rx > 0) || !(g.ry > 0)) return 0;
  return ((p.x - g.cx) / g.rx) * Math.cos(a) + ((p.y - g.cy) / g.ry) * Math.sin(a);
}

/** Pure function. The nearest point on the RADIAL SEGMENT between normalized
 *  radii `tMin` and `tMax` along `a`, measured in the normalized frame. */
function radialConstrain(s, a, tMin, tMax, desired) {
  const g = pupilGeom(s);
  const toN = (p) => ({ x: (p.x - g.cx) / (g.rx || 1), y: (p.y - g.cy) / (g.ry || 1) });
  const end = (t) => ({ x: t * Math.cos(a), y: t * Math.sin(a) });
  const n = closestPointOnSegment(end(tMin), end(tMax), toN(desired));
  return { x: g.cx + g.rx * n.x, y: g.cy + g.ry * n.y };
}

/** Pure function. The nearest point on the pupil RIM (t = 1, any angle), in the
 *  normalized frame — the allowed set of a handle that only sets an ANGLE. */
function rimConstrain(s, desired) {
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
function bladeCountFromAngle(rotation, a) {
  const gap = Math.max(1e-3, (((a - rotation) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
  return Math.max(MIN_POLYGON_BLADES, Math.round((2 * Math.PI) / gap));
}

export const aperturePlugin = {
  type: "aperture",
  title: "Aperture",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  /**
   * FOURTEEN LENSES, AND EVERY BLADE COUNT IS SOURCED. Not one count is an
   * inference from another number or a marketing phrase; where the research had
   * no sourced count for a lens worth modelling, the lens was dropped rather
   * than the cell filled. Full sourcing per row is
   * `.frenzy/round6/presets/LENS_TABLE.md`; the selection, the pruning and the
   * three near-collisions resolved on sourced grounds are
   * `.frenzy/round6/presets/optical_flare_aperture.md`.
   *
   * THE FAMILY WRITES GEOMETRY AND NOTHING ELSE. All eight constituting knobs
   * appear in every row (the shapeshifter cloud family's discipline), so hovering
   * down the list is order-independent; `fill`, `pupilFill`, `stroke` and
   * `sunstar` are never touched, because they are the author's presentation, not
   * the lens's geometry.
   *
   * WHERE AN APERTURE AND A FLARE PRESET MODEL THE SAME LENS THEY CARRY THE SAME
   * NAME — Circular-Aperture Portrait, Apodized Soft Focus, Single-Coated
   * Classic, Mirror Lens Donut. That is R6-3.11 expressed at the name level.
   * Mirror Lens Donut is the deliberate DISAGREEMENT: the flare writes a high
   * blade count there because its knob shapes a ghost polygon and a real mirror
   * lens's ghost is round, while this widget writes the lens's actual fact, which
   * is that it has no iris at all.
   */
  presets: [
    {
      name: "Three-Blade Cine Iris",
      description: "A modern cine prime fitted with its three-blade interchangeable iris, in the Angenieux Optimo Prime manner: the fewest leaves any iris can have, and the only opening here that is a plain triangle.",
      props: { blades: 3, stopDown: 0.5, curvature: 0, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Vintage TLR Pentagon",
      description: "A classic twin-lens reflex's five-leaf iris, as on the Rollei Magic II: the genuinely vintage five-blade lens, giving the pentagonal highlights that count is known for.",
      props: { blades: 5, stopDown: 0.55, curvature: 0, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Seventies Six-Blade Cine",
      description: "The 16mm ZEISS Super Speed, the one lens in that seventies line with a six-blade iris: a hard hexagon, and the six-point star that goes with it.",
      props: { blades: 6, stopDown: 0.5, curvature: 0, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Rounded Seven-Blade Prime",
      description: "A modern rounded seven-blade prime, the Canon EF 50mm f/1.8 STM: curved leaves keep the opening close to circular, and an odd count means the star it does make has fourteen rays, not seven.",
      props: { blades: 7, stopDown: 0.45, curvature: 0.6, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Straight Eight-Blade Prime",
      description: "Eight deliberately NON-rounded blades, as on the Canon EF 35mm f/1.4L: the crisp octagon and the clean eight-ray star that curved leaves give up.",
      props: { blades: 8, stopDown: 0.5, curvature: 0, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Circular-Aperture Portrait",
      description: "A circular-diaphragm portrait lens near wide open, the Canon EF 85mm f/1.2L II: eight leaves curved almost into a true circle, which is why it barely stars at all.",
      props: { blades: 8, stopDown: 0.35, curvature: 0.9, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Nine-Blade Single-Coated",
      description: "The later Helios-44's nine straight blades: a clean nine-sided opening whose odd count doubles into an eighteen-ray star.",
      props: { blades: 9, stopDown: 0.5, curvature: 0, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Reuleaux Triangle Iris",
      description: "The 35mm ZEISS Super Speed Mk I, whose nine blades close into a Reuleaux triangle rather than a nine-sided polygon: a curved triangle of constant width, and the reason a blade count alone cannot tell you the shape.",
      props: { blades: 9, stopDown: 0.6, curvature: 0, bladeForm: "reuleaux", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Apodized Soft Focus",
      description: "The Minolta/Sony STF 135mm on its ten-blade perfectly circular ring — the lens carries two irises — with the apodizing element grading transmission to nothing at the rim, so the opening has no hard edge at all.",
      props: { blades: 10, stopDown: 0.2, curvature: 1, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0.85 },
    },
    {
      name: "Inward-Curved Rangefinder Tele",
      description: "The pre-aspherical Leica Summicron 90mm f/2, whose eleven leaves curve INWARD rather than outward: the sides of the opening bow into it, and the odd count turns that into a twenty-two-ray star.",
      props: { blades: 11, stopDown: 0.55, curvature: -0.8, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Single-Coated Classic",
      description: "The 1958 Helios-44's thirteen straight blades: so many leaves that the opening reads almost round, and so many edges that its star is a twenty-six-ray glow.",
      props: { blades: 13, stopDown: 0.5, curvature: 0, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Fourteen-Blade Compact Prime",
      description: "A modern compact cine prime, the ZEISS CP.3: fourteen rounded leaves holding a near-circular opening well down the stop range.",
      props: { blades: 14, stopDown: 0.5, curvature: 0.6, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Fifteen-Blade Anamorphic Oval",
      description: "The ARRI/ZEISS Master Anamorphic's fifteen-blade iris: the count is high enough to be round, and the highlight is a vertical oval anyway, because the entrance pupil itself is oval.",
      props: { blades: 15, stopDown: 0.4, curvature: 0.7, bladeForm: "regular", bladeRotation: 0, pupilAspect: 0.5, obstruction: 0, apodization: 0 },
    },
    {
      name: "Sixteen-Blade Circular Cine",
      description: "The ZEISS Supreme Prime's sixteen-blade iris, which the maker states stays a full circle through every stop — the only opening here that never becomes a polygon.",
      props: { blades: 16, stopDown: 0.55, curvature: 1, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0, apodization: 0 },
    },
    {
      name: "Mirror Lens Donut",
      description: "A catadioptric mirror telephoto: no iris at all, and the secondary mirror blocks the middle of its own aperture, leaving a ring whose hole is just over half the outer diameter.",
      props: { blades: 0, stopDown: 0, curvature: 0, bladeForm: "regular", bladeRotation: 0, pupilAspect: 1, obstruction: 0.53, apodization: 0 },
    },
  ],
  defaults: {
    type: "aperture", x: 260, y: 160, w: 220, h: 220, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#414868", pupilFill: "#ffd7a3", stroke: "#1a1b26", strokeWidth: 2,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
    blades: DEFAULT_BLADES,
    stopDown: 0.5,
    curvature: DEFAULT_CURVATURE,
    bladeForm: "regular",
    bladeRotation: 0, // RADIANS, shown in degrees — see the row below
    pupilAspect: 1,
    obstruction: 0,
    apodization: 0,
    sunstar: 0,
  },
  inspector: [
    ...bundle("positioning"),
    N("blades", "Blades", {
      min: NO_IRIS_BLADES, step: 1,
      help: `Number of diaphragm leaves. ${NO_IRIS_BLADES} means the lens has NO IRIS — a mirror telephoto or a phone module — and the opening is the bare entrance pupil; one or two leaves cut a real circular segment out of it; ${MIN_POLYGON_BLADES} is the fewest that enclose a polygon. Diffraction physics: an EVEN count gives that many rays, an ODD count twice as many (9 blades give 18 rays), and the lens flare's blade count means the same thing under the same law.`,
    }),
    N("stopDown", "Stop down", {
      min: 0, max: 1,
      help: "How far the blades have closed: 0 is wide open, where the leaves sit clear of the bore and the opening is ROUND whatever the blade count, and 1 is shut. The polygon only takes over once its corners clear the bore, so a straight-bladed lens shows arcs between the flats for the first fraction of a stop. Drag the handle on the blade edge.",
    }),
    N("curvature", "Blade curvature", {
      min: -1, max: 1,
      help: "The shape of each leaf's inner edge: 0 is a straight-edged blade, which becomes a hard polygon as soon as it stops down, and 1 is a fully curved 'circular aperture' design that stays round at every stop. NEGATIVE is an inwardly curved leaf — real, and the reason a 0-to-1 knob is not enough: it bulges into the opening and leaves concave sides. Needs at least three blades to have a polygon to round. Drag the handle on the second blade's edge.",
    }),
    SEL("bladeForm", "Blade form", ["regular", "reuleaux"], { regular: "Regular polygon", reuleaux: "Reuleaux triangle" },
      "How the leaves close. Regular is the usual N-sided opening. Reuleaux is a curve of CONSTANT WIDTH with three lobes whatever the blade count — the 35mm ZEISS Super Speed Mk I closes nine leaves into a curved triangle, which is why a blade count alone cannot tell you the shape."),
    { key: "bladeRotation", label: "Blade rotation", kind: "angle", display: "degrees", category: "formatting",
      help: "Orientation of the blade set — which way the opening's flats and corners point. Stored in radians and shown in degrees, matching the lens flare's starburst rotation so the two widgets can be bound to one another. Uncapped: past 360 degrees keeps counting, so a keyframed value spins." },
    N("pupilAspect", "Pupil aspect", {
      min: 0, scrub: UNIT_SPAN_SCRUB,
      help: "Shape of the entrance pupil itself, independently of the widget's box: 1 is round, below 1 a vertical oval, above 1 a horizontal one. An anamorphic lens's pupil really is oval, so its highlight is oval at every aperture whatever the blades do. Floor 0 is technical — a pupil with no width has no shape.",
    }),
    N("obstruction", "Central obstruction", {
      min: 0, max: 1,
      help: "A hole through the middle of the opening, as a fraction of its radius — a mirror lens's secondary blocks the centre of its own aperture, which is what turns its highlights into rings. 0 is unobstructed. Drag the handle opposite the stop-down one.",
    }),
    N("apodization", "Apodization", {
      min: 0, max: 1,
      help: "How steeply transmission falls toward the rim: 0 is an ordinary hard-edged opening, and higher grades the light to nothing before the edge, the way an apodizing element makes a highlight fade out instead of ending in a rim. Needs a pupil fill to grade.",
    }),
    N("sunstar", "Sunstar length", {
      min: 0, max: 1,
      help: "Length of the diffraction rays, as a fraction of the aperture's radius; 0 draws none. The ray COUNT is not a knob — it is derived from the blade count, because an aperture is a real function and its rays therefore come in opposed pairs: an even count gives that many rays, an odd count twice as many. There is no such thing as an odd-numbered sunstar.",
    }),
    ...props("fill"),
    { key: "pupilFill", label: "Pupil fill", kind: "color", paint: true, category: "fillMaterial",
      help: "The light coming through the opening — this is the bokeh, so a polygonal opening gives a polygonal highlight. Set it fully transparent to leave a real HOLE instead, turning the widget into an iris vignette over whatever is behind it." },
    ...props("stroke", "strokeWidth"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (LOCAL space): the pupil fill,
   * then the blades over it, then the sunstar. ONE `path` op per layer — see this
   * file's header for why the body is an even-odd hole rather than a fan.
   */
  emit(s, _targetWorldIR, world) {
    const bore = boreGeom(s);
    if (!(bore.rx > 0) || !(bore.ry > 0)) return [];
    const opacity = s.opacity ?? 1;
    const ops = [];
    const obstruction = clamp(s.obstruction, 0, 1);
    if (!isPaintOff(s.pupilFill) && s.pupilFill != null) {
      const subpaths = [openingOutline(s)];
      if (obstruction > 0) subpaths.push(openingOutline(s, obstruction));
      ops.push(path({
        d: subpathsPathD(subpaths),
        fill: apodizedPupilPaint(s.pupilFill, s.apodization),
        fillRule: "evenodd",
        opacity,
      }));
    }
    const body = bodySubpaths(s);
    if (body) ops.push(path({
      d: subpathsPathD(body),
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      fillRule: "evenodd",
      opacity,
    }));
    const rays = clamp(s.sunstar, 0, 1);
    if (rays > 0 && !isPaintOff(s.pupilFill) && s.pupilFill != null) {
      const angles = starburstRayAngles(s.blades ?? 0, s.bladeRotation ?? 0);
      if (angles.length > 0) ops.push(path({
        d: subpathsPathD(angles.map((a) => rayOutline(bore, a, rays))),
        fill: s.pupilFill,
        fillRule: "nonzero",
        opacity,
      }));
    }
    if (ops.length === 0) return [];
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  /** Pure function. Inside the BORE — the widget's whole silhouette, whether the
   *  opening is filled with light or left as a hole (a click in the middle of an
   *  iris is a click on the iris). */
  hitTest(s, lx, ly) {
    const bore = boreGeom(s);
    if (!(bore.rx > 0) || !(bore.ry > 0)) return false;
    return pointInOutlines([radialOutline(bore, boundaryAngles(s), () => 1)], lx, ly);
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    // Radial point on the BORE toward the target — identical convention to
    // circle.js's and donut.js's closestAnchor (exact when w === h).
    const local = T.apply(T.invert(world), wx, wy);
    const { cx, cy, rx, ry } = boreGeom(state);
    const theta = Math.atan2((local.y - cy) / ry, (local.x - cx) / rx);
    return { x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) };
  },
  /**
   * Pure function. Up to five yellow squares, plus the fill and pupil-fill
   * gradient handles. Dynamic in the blade count: the two handles that read a
   * POLYGON (`curvature`, `blades`) appear only once there is one, which is the
   * same condition under which their parameters mean anything.
   */
  modifierPoints(s) {
    const n = Math.max(0, Math.round(s.blades ?? DEFAULT_BLADES));
    const stopT = clamp(1 - (s.stopDown ?? 0), 0, 1);
    const a0 = bladeAngle(s, 0);
    const out = [
      {
        id: "stopDown", ...pupilPoint(s, stopT, a0),
        constrain: (st, p) => radialConstrain(st, bladeAngle(st, 0), 0, 1, p),
        apply: (st, p) => ({ stopDown: 1 - clamp(pupilRadialT(st, p, bladeAngle(st, 0)), 0, 1) }),
      },
      {
        id: "obstruction",
        ...pupilPoint(s, clamp(s.obstruction, 0, 1) * openingRadius(a0 + Math.PI, s), a0 + Math.PI),
        constrain: (st, p) => radialConstrain(st, bladeAngle(st, 0) + Math.PI, 0, openingRadius(bladeAngle(st, 0) + Math.PI, st), p),
        apply: (st, p) => {
          const a = bladeAngle(st, 0) + Math.PI;
          const rim = openingRadius(a, st);
          // A shut opening has no radius to take a fraction OF — a division
          // guard, not a bound (the donut.js / lens_flare precedent).
          if (!(rim > 0)) return { obstruction: clamp(st.obstruction, 0, 1) };
          return { obstruction: clamp(pupilRadialT(st, p, a) / rim, 0, 1) };
        },
      },
    ];
    if (n < MIN_POLYGON_BLADES) return [...out, ...paintModifierPoints(s, "fill"), ...paintModifierPoints(s, "pupilFill")];
    const sec = 1 / Math.cos(Math.PI / n);
    const curveT = stopT * (1 + clamp(s.curvature, -1, 1, 0) * (sec - 1));
    const vertexOf = (st) => bladeAngle(st, 0) + Math.PI / Math.max(1, Math.round(st.blades ?? DEFAULT_BLADES));
    const secOf = (st) => 1 / Math.cos(Math.PI / Math.max(MIN_POLYGON_BLADES, Math.round(st.blades ?? DEFAULT_BLADES)));
    const spanOf = (st) => clamp(1 - (st.stopDown ?? 0), 0, 1) * (secOf(st) - 1);
    return [
      ...out,
      {
        // Blade TWO's edge midpoint. It travels from bulged-in through the flat
        // out to the circumcircle as the leaf's edge bows, which IS what
        // curvature means; the two ends of that run are curvature −1 and +1.
        // Blade TWO, not blade one: the `blades` handle below must sit on blade
        // ONE's normal (its reading IS the gap from blade zero), and at stopDown
        // 0 both would be on the rim at the same bearing.
        id: "curvature", ...pupilPoint(s, curveT, bladeAngle(s, 2)),
        constrain: (st, p) => {
          const edge = clamp(1 - (st.stopDown ?? 0), 0, 1);
          const span = spanOf(st);
          return radialConstrain(st, bladeAngle(st, 2), edge - span, edge + span, p);
        },
        apply: (st, p) => {
          const edge = clamp(1 - (st.stopDown ?? 0), 0, 1);
          const span = spanOf(st);
          // A shut opening has no span to read a fraction of — a division
          // guard, not a bound (the donut.js / lens_flare precedent).
          if (!(span > 0)) return { curvature: clamp(st.curvature, -1, 1, 0) };
          return { curvature: clamp((pupilRadialT(st, p, bladeAngle(st, 2)) - edge) / span, -1, 1) };
        },
      },
      {
        // The rim at the opening's VERTEX bearing: grab a corner and spin it.
        id: "bladeRotation", ...pupilPoint(s, 1, vertexOf(s)),
        constrain: (st, p) => rimConstrain(st, p),
        apply: (st, p) => {
          const g = pupilGeom(st);
          if (!(g.rx > 0) || !(g.ry > 0)) return { bladeRotation: st.bladeRotation ?? 0 };
          const a = Math.atan2((p.y - g.cy) / g.ry, (p.x - g.cx) / g.rx);
          return { bladeRotation: a - Math.PI / Math.max(1, Math.round(st.blades ?? DEFAULT_BLADES)) };
        },
      },
      {
        // A DISCRETE set: the count is rounded in COUNT, so this lands on the
        // nearest allowed COUNT rather than the nearest allowed angle (the
        // shapeshifter polygon/star precedent).
        id: "blades", ...pupilPoint(s, 1, a0 + (2 * Math.PI) / n),
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
      },
      ...paintModifierPoints(s, "fill"),
      ...paintModifierPoints(s, "pupilFill"),
    ];
  },
  // CROSSHAIR PLACEMENT: bbox placement — click-drag sizes the box, a plain click
  // places the default size (the donut.js precedent; bbox is the default kind).
  commands: [
    { id: "add-aperture", title: "Add Aperture", icon: "mdi:camera-iris", run: (app) => app.armCrosshairPlacement(aperturePlugin) },
  ],
};
