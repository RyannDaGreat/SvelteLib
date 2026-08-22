/**
 * SHAPESHIFTER — generalized parametric shape FAMILIES with draggable yellow-box
 * handles. ONE data-driven family registry (FAMILIES below) where each family is
 * a single parametric shape that SUBSUMES many concrete shapes:
 *
 *   radialSweep  circle · ellipse · disc · donut/ring · pie · arc/block-arc ·
 *                letter-C · chord · semicircle · gauge/progress-ring
 *   polygonStar  triangle … N-gon · diamond · 4–many-point star · burst · badge
 *   arrow        right arrow · double arrow · pentagon · chevron · curved &
 *                near-circular arrow · notched-tail arrow
 *   cornerRect   rectangle · rounded-rect · pill · snipped/chamfered card
 *   quadWedge    rectangle · parallelogram · trapezoid · triangle · rhombus/kite
 *   crossPlus    plus · thin/thick cross · medical cross · rounded plus
 *   frame        picture frame · half-frame (U) · L-shape · bar
 *   gear         gear/cog · sprocket · settings icon · starburst · toothed ring
 *   callout      rect/rounded speech bubble · leader/pointer callout
 *   banner       flat banner · forked-end ribbon
 *   bracket      square bracket "[" (thin ↔ thick)
 *
 * ── ARCHITECTURE ──────────────────────────────────────────────────────────────
 * The geometry lives as PURE param → OUTLINE generators in core/outline.js
 * (tessellated polylines — NO `A` arcs, so the ONE `path` IR op round-trips
 * through GPU raster + SVG + PDF, holes via fillRule "evenodd"). This module is
 * thin glue: each family declares its param seed, inline Inspector rows, an
 * `outline(state)` (→ the generator) and `modifierPoints(state)` (the yellow
 * handles). `makeFamilyPlugin(fam)` builds a standard bbox plugin from that data
 * — so every family is bbox-resizable, effects-complete (shadow/bloom/blend ride
 * the shared bundle exactly like rect/circle), tween-able and equation-bindable
 * (every param is a plain numeric state slot) for free.
 *
 * WHY per-family plugin objects (not one "shapeshifter" type with a `family`
 * field): the Inspector reads `plugin.inspector` as a STATIC array (App.svelte /
 * Inspector.svelte both iterate it directly; a per-state function is
 * unsupported). One type would therefore have to show the UNION of every
 * family's rows on every item (a gear showing "tail width"). Per-family plugins
 * give each shape a clean Inspector of only its own knobs — the impl-design
 * doc's "inspectorRows (inline), per family" intent. All families share ONE
 * factory + ONE data table, so this is still one data-driven system, and no
 * plugin imports another (composition is through core/* only).
 *
 * Type ids are NAMESPACED with an `ss_` prefix (ss_radialSweep, ss_arrow, …) so
 * a family NEVER collides with a top-level plugin type (e.g. the existing
 * `arrow` widget) — a duplicate type throws in registry.registerAll.
 *
 * On-canvas handles are per-family and fully dynamic (modifierPoints is a
 * function of state), so only the relevant yellow squares ever appear.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS, STROKE_SPACE_KEYS } from "../core/properties.js";
import * as T from "../core/transform.js";
import {
  ringSectorOutline, polygonStarOutline, cornerRectOutline, quadWedgeOutline,
  crossPlusOutline, frameOutline, gearOutline, calloutOutline, bannerOutline,
  bracketOutline, arrowOutline, pointInOutlines, closestPointOnOutlines,
  closestPointOnSegment, closestPointOnAxisRange, cloudOutline, heartOutline,
  boltOutline, screwOutline, screwHeadOutline,
  scrollOutline, scrollPairOutline, ironFinialOutline,
} from "../core/outline.js";
import { subpathsPathD } from "../core/shapes.js";
import { morphPayloadFromPaths, statePaint } from "../core/morph_payload.js";
import { path } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v ?? lo, hi));

// Inline Inspector row builders (the donut.js precedent — rows declared in the
// plugin, NOT in core/properties.js, so this whole family system needs zero
// edit to the shared registry). Category "formatting" places the shape knobs
// with fill/stroke, before the effects accordion.
const N = (key, label, extra = {}) => ({ key, label, kind: "number", category: "formatting", ...extra });
// A HEADING row: the rotary dial (web/AngleField.svelte). NO `display` — this
// family stores its angles in raw DEGREES (converted with DEG only at emit, see
// `outline` below), so the dial shows exactly what is stored.
//
// BUG FIXED HERE (2026-07-27): these rows used to be N(..., {display: "degrees"}),
// which asks the field to convert RADIANS→degrees. The values are already degrees,
// so the Inspector multiplied them by 180/π and the default -90° start angle read
// as "-5156.6°" — and typing a real angle back divided it by the same factor.
// `display` is for a row whose STORAGE differs from what it shows (`rotation`,
// which really is radians); it is not a unit label.
const ANGLE = (key, label, extra = {}) => ({ key, label, kind: "angle", category: "formatting", ...extra });
const SEL = (key, label, options, optionLabels, help) => ({ key, label, kind: "select", options, optionLabels, category: "formatting", help });
const BOOL = (key, label, help) => ({ key, label, kind: "boolean", category: "formatting", help });

// Local ellipse geometry (bbox-inscribed), shared by the radial/star/gear
// handle math — the same rx=w/2, ry=h/2 convention circle.js/donut.js use.
const ellipseGeom = (s) => ({ cx: s.w / 2, cy: s.h / 2, rx: s.w / 2, ry: s.h / 2 });
// Angle (radians) of a local point about the ellipse center, in the ellipse's
// normalized frame (so an elliptical bbox still reads the right angle).
const angleAt = (g, x, y) => Math.atan2((y - g.cy) / g.ry, (x - g.cx) / g.rx);
// Normalized radial distance (0=center, 1=rim) of a local point projected onto
// the direction `a` — donut's radial-handle projection, generalized to any dir.
const radialT = (g, x, y, a) => ((x - g.cx) / g.rx) * Math.cos(a) + ((y - g.cy) / g.ry) * Math.sin(a);

// ── The families' shared CONSTRAINT vocabulary ────────────────────────────────
// THE HANDLE-CONSTRAINT PROTOCOL (core/derive.js): every handle declares
// `constrain(state, desired) → allowed`, the projection onto its allowed set, and
// `apply(state, allowed)` then only reads that point back as a number. The
// ellipse-fitted families' handles all ride either a RADIAL segment or the RIM,
// so both projections are declared ONCE here.
//
// "NEAREST" for these two is nearest in the ellipse's NORMALIZED frame — the same
// frame angleAt/radialT already read — which coincides with nearest-in-local
// exactly when rx === ry. That is the established house convention for elliptical
// closest-point maps (donut.js's and circle.js's closestAnchor say the same
// thing: "identical convention to circle.js, exact when w === h"), and it is the
// right frame because the PARAMETER these handles write is defined in it.

/** Pure function. The ellipse point at normalized radius `t` and angle `a` (rad).
 *  @example ellipsePoint({cx: 100, cy: 50, rx: 100, ry: 50}, 1, 0) // {x: 200, y: 50} */
const ellipsePoint = (g, t, a) => ({ x: g.cx + g.rx * t * Math.cos(a), y: g.cy + g.ry * t * Math.sin(a) });

/** Pure function. Nearest point on the RADIAL SEGMENT at angle `a`, normalized
 *  radius t ∈ [tMin, tMax] — the allowed set of every "ratio of the radius" handle.
 *  @example radialConstrain({cx: 100, cy: 100, rx: 100, ry: 100}, 0, {x: 999, y: 40}, 0, 1) // {x: 200, y: 100} */
const radialConstrain = (g, a, p, tMin, tMax) => ellipsePoint(g, clamp(radialT(g, p.x, p.y, a), tMin, tMax), a);

/** Pure function. Nearest point on the ellipse RIM (t = 1, any angle) — the allowed
 *  set of every handle that only sets an ANGLE.
 *  @example rimConstrain({cx: 100, cy: 100, rx: 100, ry: 100}, {x: 140, y: 100}) // {x: 200, y: 100} */
const rimConstrain = (g, p) => ellipsePoint(g, 1, angleAt(g, p.x, p.y));

/** Pure function. Read a number out of the ellipse frame — or KEEP the stored one
 *  when the box has no extent to read it from (angleAt/radialT divide by rx and ry,
 *  so a zero-extent axis yields ±Infinity or NaN). Same reasoning as ratioOf below:
 *  a collapsed allowed set has nothing to say, so the stored value stands.
 *  @example readOrKeep({rx: 100, ry: 50}, () => 0.25, 0.9) // 0.25
 *  @example readOrKeep({rx: 0, ry: 50}, () => 0.25, 0.9) // 0.9 (no extent — the stored value stands) */
const readOrKeep = (g, read, held) => (g.rx > 0 && g.ry > 0 ? read() : held);

/** Pure function. A ratio read from an extent — or the value it ALREADY had when
 *  the extent is 0. A zero-extent box has no length to take a fraction OF, so
 *  there is nothing to read and the stored value stands: the zero-extent KEEP
 *  precedent (polygon.js, quoting lens_flare — "a technical guard on division,
 *  not a bound on any value"). It replaces two `|| 1` fallbacks that silently
 *  divided by a fabricated extent of one pixel.
 *  @example ratioOf(30, 120, 0.9) // 0.25
 *  @example ratioOf(30, 0, 0.9) // 0.9 (no extent — the stored value stands) */
const ratioOf = (numer, extent, existing) => (extent > 0 ? numer / extent : existing);

// A sweep under this many degrees draws nothing at all, so the `end` handle's
// parameterization reads it as a FULL turn instead — the allowed set of that
// handle is the rim MINUS this sliver past the start angle (a genuine discrete
// step, not a clamp). Pre-existing behaviour, named here rather than inline.
const MIN_SWEEP_DEG = 1;
const FULL_SWEEP_DEG = 360;
// A star/polygon COUNT comes from the angular gap between two adjacent points, so
// a gap this small or smaller would divide out to an unbounded count; it is the
// floor on that gap. Pre-existing behaviour, named here rather than inline.
const MIN_POINT_GAP_RAD = 1e-3;

/** Pure function. The sweep (degrees, [MIN_SWEEP_DEG, FULL_SWEEP_DEG]) that a rim
 *  point at `angleDeg` describes from `startDeg` — ONE reading shared by the `end`
 *  handle's constraint and its write, so the discrete step cannot drift between them.
 *  @example sweepFromAngle(-90, 30) // 120
 *  @example sweepFromAngle(-90, -90) // 360 (a vanishing sweep reads as a full turn) */
const sweepFromAngle = (startDeg, angleDeg) => {
  const sw = (((angleDeg - startDeg) % FULL_SWEEP_DEG) + FULL_SWEEP_DEG) % FULL_SWEEP_DEG;
  return sw < MIN_SWEEP_DEG ? FULL_SWEEP_DEG : sw;
};

/** Pure function. The point COUNT a rim point at angle `a` (rad) describes as the
 *  gap from `startRad` — ONE reading shared by the `points` handle's constraint and
 *  its write. Rounds in COUNT (never below 3), which is why the resulting rim point
 *  is the nearest ALLOWED COUNT rather than the nearest allowed ANGLE.
 *  @example pointCountFromAngle(0, Math.PI / 2) // 4
 *  @example pointCountFromAngle(0, Math.PI) // 3 (a half-turn gap wants 2 points; the count floors at 3)
 *  @example pointCountFromAngle(0, 0) // 6283 (a vanishing gap floors at MIN_POINT_GAP_RAD, giving 2π/1e-3 points) */
const pointCountFromAngle = (startRad, a) => {
  const gap = Math.max(MIN_POINT_GAP_RAD, (((a - startRad) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
  return Math.max(3, Math.round((2 * Math.PI) / gap));
};

/**
 * THE FAMILY REGISTRY. Each entry: identity + a param seed (defaults) + inline
 * Inspector rows + `outline(state)` (the pure core generator, degrees→radians
 * converted here) + `modifierPoints(state)` (yellow handles; each `apply`
 * projects the dragged LOCAL point onto ONE constrained trajectory and returns a
 * partial-state write, exactly like donut.js). `fillRule "evenodd"` marks the
 * families that can carry a hole (ring/frame/gear).
 */
export const FAMILIES = [
  {
    type: "ss_radialSweep", title: "Radial Sweep", icon: "mdi:chart-arc", fill: "#7dcfff", fillRule: "evenodd",
    defaults: { inner: 0.5, startAngle: -90, sweep: 300, cap: "pie" },
    rows: [
      N("inner", "Inner ratio", { min: 0, max: 1, help: "The hole's size as a fraction of the outer radius: 0 is a solid pie/disc, higher hollows it into a ring or arc band. Drag the inner yellow handle." }),
      ANGLE("startAngle", "Start angle", { help: "Where the slice begins, in degrees clockwise from 3 o'clock. Drag the dial (or the start handle on the rim) to rotate the whole slice." }),
      // NOT a dial: `sweep` is an EXTENT, not a heading. On a dial 0° and 360°
      // point the same way, but a sweep of 0 draws nothing and a sweep of 360
      // draws a whole ring — one needle position, two opposite meanings. A
      // scrubber that reads "300" says what it means.
      N("sweep", "Sweep", { help: "How many degrees the slice covers: 360 is a full circle/ring, less carves a pie or gauge; beyond 360 wraps to a full ring and a negative sweep runs the slice the other way. Drag the end handle around the rim." }),
      SEL("cap", "Cap", ["pie", "chord"], { pie: "Pie (radial)", chord: "Chord (flat)" }, "How a solid partial slice closes: pie draws two straight edges to the center, chord draws a single straight line across the opening."),
    ],
    presets: [
      { name: "Pac-Man", description: "A wide mouth wedge cut from a solid disc — the arcade icon.", props: { inner: 0, startAngle: 40, sweep: 280, cap: "pie" } },
      { name: "Pie Timer", description: "A quarter-eaten solid pie, the classic countdown-timer wedge.", props: { inner: 0, startAngle: -90, sweep: 270, cap: "pie" } },
      { name: "Half Pie", description: "An exact half-disc, cut with a straight radial edge.", props: { inner: 0, startAngle: -90, sweep: 180, cap: "pie" } },
      { name: "Full Disc", description: "No hole, no gap: a plain filled circle.", props: { inner: 0, startAngle: -90, sweep: 360, cap: "pie" } },
      { name: "Ring", description: "A full hollow ring: the hole rides most of the way to the rim.", props: { inner: 0.7, startAngle: -90, sweep: 360, cap: "pie" } },
      { name: "Donut", description: "A softer full ring with a modest hole — a chart-style donut.", props: { inner: 0.55, startAngle: -90, sweep: 360, cap: "pie" } },
      { name: "Gauge Arc", description: "A three-quarter progress-ring band, hollow, open at the bottom.", props: { inner: 0.75, startAngle: -215, sweep: 250, cap: "pie" } },
      { name: "Loading Arc", description: "A thin spinner arc: mostly hollow, a short bright sweep.", props: { inner: 0.82, startAngle: 0, sweep: 90, cap: "pie" } },
      { name: "Fan Blade", description: "A narrow solid sliver — one blade of a fan or pinwheel.", props: { inner: 0, startAngle: -90, sweep: 40, cap: "pie" } },
      { name: "Letter C", description: "A thick ring with a wide gap — reads as the letter C.", props: { inner: 0.45, startAngle: 30, sweep: 300, cap: "pie" } },
      { name: "Crescent Sliver", description: "A very thin hollow band with a wide open gap — a crescent moon reading.", props: { inner: 0.88, startAngle: -60, sweep: 190, cap: "pie" } },
      { name: "Flat Chord Wedge", description: "A solid wedge closed by a straight chord instead of two radii — a guitar-pick silhouette.", props: { inner: 0, startAngle: -90, sweep: 200, cap: "chord" } },
      { name: "Chord Gauge", description: "A hollow gauge band closed with a flat chord end — a speedometer face.", props: { inner: 0.6, startAngle: -240, sweep: 240, cap: "chord" } },
    ],
    outline: (s) => ringSectorOutline({ ...ellipseGeom(s), inner: s.inner ?? 0.5, a0: (s.startAngle ?? -90) * DEG, a1: ((s.startAngle ?? -90) + (s.sweep ?? 360)) * DEG, cap: s.cap ?? "pie" }),
    // inner rides the RADIAL SEGMENT along the start angle (t ∈ [0, 1]); start and
    // end ride the RIM (any angle), end's rim punctured by MIN_SWEEP_DEG.
    modifierPoints(s) {
      const g = ellipseGeom(s);
      const a0 = (s.startAngle ?? -90) * DEG, a1 = a0 + (s.sweep ?? FULL_SWEEP_DEG) * DEG;
      const inner = clamp(s.inner, 0, 1);
      const startOf = (st) => st.startAngle ?? -90;
      return [
        {
          id: "inner", x: g.cx + g.rx * inner * Math.cos(a0), y: g.cy + g.ry * inner * Math.sin(a0),
          constrain: (st, p) => radialConstrain(ellipseGeom(st), startOf(st) * DEG, p, 0, 1),
          apply: (st, p) => {
            const gg = ellipseGeom(st);
            return { inner: readOrKeep(gg, () => radialT(gg, p.x, p.y, startOf(st) * DEG), clamp(st.inner, 0, 1)) };
          },
        },
        {
          id: "start", x: g.cx + g.rx * Math.cos(a0), y: g.cy + g.ry * Math.sin(a0),
          constrain: (st, p) => rimConstrain(ellipseGeom(st), p),
          apply: (st, p) => {
            const gg = ellipseGeom(st);
            return { startAngle: readOrKeep(gg, () => angleAt(gg, p.x, p.y) / DEG, startOf(st)) };
          },
        },
        {
          id: "end", x: g.cx + g.rx * Math.cos(a1), y: g.cy + g.ry * Math.sin(a1),
          constrain: (st, p) => {
            const gg = ellipseGeom(st);
            return ellipsePoint(gg, 1, (startOf(st) + sweepFromAngle(startOf(st), angleAt(gg, p.x, p.y) / DEG)) * DEG);
          },
          apply: (st, p) => {
            const gg = ellipseGeom(st);
            return { sweep: readOrKeep(gg, () => sweepFromAngle(startOf(st), angleAt(gg, p.x, p.y) / DEG), st.sweep ?? FULL_SWEEP_DEG) };
          },
        },
      ];
    },
  },
  {
    type: "ss_polygonStar", title: "Polygon / Star", icon: "mdi:star-outline", fill: "#bb9af7",
    defaults: { points: 5, innerRatio: 0.5, cornerRadius: 0, startAngle: 0 },
    rows: [
      N("points", "Points / sides", { min: 3, help: "Number of points on a star, or sides on a polygon (three or more; no upper cap). Drag the count handle around the rim, or type an exact value." }),
      N("innerRatio", "Inner ratio", { min: 0, max: 1, help: "How far the notches cut in: 1 is a regular polygon, lower makes a sharper star, near 0 a spiky burst. Drag the inner handle." }),
      N("cornerRadius", "Corner radius", { min: 0, max: 0.5, help: "Rounds every point/notch by this fraction of the radius. 0 is sharp; higher gives a rounded polygon or blob." }),
      ANGLE("startAngle", "Rotation", { help: "Spins the shape about its center, in degrees. 0 puts the first point straight up." }),
    ],
    presets: [
      { name: "Triangle", description: "The simplest polygon: three even sides, no notches.", props: { points: 3, innerRatio: 1, cornerRadius: 0, startAngle: 0 } },
      { name: "Square", description: "A regular four-sided polygon, sharp corners.", props: { points: 4, innerRatio: 1, cornerRadius: 0, startAngle: 45 } },
      { name: "Hexagon", description: "A regular six-sided polygon — the honeycomb cell.", props: { points: 6, innerRatio: 1, cornerRadius: 0, startAngle: 0 } },
      { name: "Diamond", description: "A four-point star at full inner ratio, rotated square — the kite/rhombus reading.", props: { points: 4, innerRatio: 1, cornerRadius: 0, startAngle: 0 } },
      { name: "Sheriff Badge", description: "A blunt five-point star with shallow notches — a lawman's badge, not a spike.", props: { points: 5, innerRatio: 0.75, cornerRadius: 0.08, startAngle: 0 } },
      { name: "Classic 5-Star", description: "The familiar sharp five-point star.", props: { points: 5, innerRatio: 0.38, cornerRadius: 0, startAngle: 0 } },
      { name: "Sparkle 4", description: "A thin four-point sparkle/twinkle burst — deep notches, needle points.", props: { points: 4, innerRatio: 0.15, cornerRadius: 0, startAngle: 0 } },
      { name: "Compass 8", description: "An eight-point compass-rose star, moderate depth.", props: { points: 8, innerRatio: 0.45, cornerRadius: 0, startAngle: 0 } },
      { name: "Starburst 16", description: "A dense many-point starburst / sun icon.", props: { points: 16, innerRatio: 0.6, cornerRadius: 0, startAngle: 0 } },
      { name: "Seal", description: "A round many-point rosette seal, shallow notches so it reads nearly circular.", props: { points: 20, innerRatio: 0.85, cornerRadius: 0, startAngle: 0 } },
      { name: "Rounded Pentagon", description: "A five-sided polygon with softened corners — a friendly badge shape.", props: { points: 5, innerRatio: 1, cornerRadius: 0.3, startAngle: 0 } },
      { name: "Ninja Star", description: "A four-point shuriken: sharp deep points, no rounding.", props: { points: 4, innerRatio: 0.2, cornerRadius: 0, startAngle: 45 } },
      { name: "Gear Blank", description: "A many-point shallow burst that reads as a toothed disc silhouette.", props: { points: 24, innerRatio: 0.9, cornerRadius: 0, startAngle: 0 } },
    ],
    outline: (s) => polygonStarOutline(s.w, s.h, { points: s.points ?? 5, innerRatio: s.innerRatio ?? 0.5, cornerRadius: s.cornerRadius ?? 0, startAngle: (s.startAngle ?? 0) * DEG }),
    // innerRatio rides the RADIAL SEGMENT along the first notch's angle; points rides
    // a DISCRETE set of rim points, one per whole achievable count (pointCountFromAngle).
    modifierPoints(s) {
      const g = ellipseGeom(s);
      const p = Math.max(2, Math.round(s.points ?? 5));
      const inner = clamp(s.innerRatio, 0, 1);
      const startOf = (st) => -Math.PI / 2 + (st.startAngle ?? 0) * DEG;
      const notchAngleOf = (st) => startOf(st) + Math.PI / Math.max(2, Math.round(st.points ?? 5));
      const start = startOf(s);
      const innerA = start + Math.PI / p, countA = start + (2 * Math.PI) / p;
      return [
        {
          id: "innerRatio", x: g.cx + g.rx * inner * Math.cos(innerA), y: g.cy + g.ry * inner * Math.sin(innerA),
          constrain: (st, pt) => radialConstrain(ellipseGeom(st), notchAngleOf(st), pt, 0, 1),
          apply: (st, pt) => {
            const gg = ellipseGeom(st);
            return { innerRatio: readOrKeep(gg, () => radialT(gg, pt.x, pt.y, notchAngleOf(st)), clamp(st.innerRatio, 0, 1)) };
          },
        },
        {
          id: "points", x: g.cx + g.rx * Math.cos(countA), y: g.cy + g.ry * Math.sin(countA),
          constrain: (st, pt) => {
            const gg = ellipseGeom(st);
            return ellipsePoint(gg, 1, startOf(st) + (2 * Math.PI) / pointCountFromAngle(startOf(st), angleAt(gg, pt.x, pt.y)));
          },
          apply: (st, pt) => {
            const gg = ellipseGeom(st);
            return { points: readOrKeep(gg, () => pointCountFromAngle(startOf(st), angleAt(gg, pt.x, pt.y)), Math.max(3, Math.round(st.points ?? 5))) };
          },
        },
      ];
    },
  },
  {
    type: "ss_cornerRect", title: "Corner Rectangle", icon: "mdi:rounded-corner", fill: "#7aa2f7",
    defaults: { r0: 0.3, r1: 0.3, r2: 0.3, r3: 0.3, cornerStyle: "round" },
    rows: [
      N("r0", "Top-left", { min: 0, max: 1, help: "Radius of the top-left corner as a fraction of half the shorter side. Drag its handle along the top edge." }),
      N("r1", "Top-right", { min: 0, max: 1, help: "Radius of the top-right corner as a fraction of half the shorter side. Drag its handle." }),
      N("r2", "Bottom-right", { min: 0, max: 1, help: "Radius of the bottom-right corner as a fraction of half the shorter side. Drag its handle." }),
      N("r3", "Bottom-left", { min: 0, max: 1, help: "Radius of the bottom-left corner as a fraction of half the shorter side. Drag its handle." }),
      SEL("cornerStyle", "Corner style", ["round", "snip"], { round: "Round", snip: "Snip / chamfer" }, "How non-zero corners are cut: round is a smooth fillet, snip is a straight diagonal chamfer."),
    ],
    presets: [
      { name: "Sharp Rectangle", description: "No rounding at all — a plain right-angled rectangle.", props: { r0: 0, r1: 0, r2: 0, r3: 0, cornerStyle: "round" } },
      { name: "Rounded Rect", description: "Even, moderate rounding on all four corners — the everyday UI card.", props: { r0: 0.25, r1: 0.25, r2: 0.25, r3: 0.25, cornerStyle: "round" } },
      { name: "Pill", description: "Maximum rounding on all corners — a full stadium/pill shape.", props: { r0: 1, r1: 1, r2: 1, r3: 1, cornerStyle: "round" } },
      { name: "Chamfered Card", description: "Even diagonal snips on every corner — a machined chamfered plate.", props: { r0: 0.2, r1: 0.2, r2: 0.2, r3: 0.2, cornerStyle: "snip" } },
      { name: "Top Tab", description: "Rounded top corners over sharp bottom ones — a folder or browser tab.", props: { r0: 0.4, r1: 0.4, r2: 0, r3: 0, cornerStyle: "round" } },
      { name: "Speech Tag", description: "One deeply sharp corner (bottom-left) among fully rounded ones, reading as a tag or label flag.", props: { r0: 0.7, r1: 0.7, r2: 0.7, r3: 0, cornerStyle: "round" } },
      { name: "Ticket Stub", description: "Fully snipped corners at a moderate depth — a torn-ticket read.", props: { r0: 0.45, r1: 0.45, r2: 0.45, r3: 0.45, cornerStyle: "snip" } },
      { name: "Single Round Corner", description: "Only the top-left corner rounds, deeply — an accent card.", props: { r0: 0.9, r1: 0, r2: 0, r3: 0, cornerStyle: "round" } },
      { name: "Diagonal Cut Corner", description: "One deep snip on the top-right, the rest sharp — a folded-corner note.", props: { r0: 0, r1: 0.85, r2: 0, r3: 0, cornerStyle: "snip" } },
      { name: "Bevel Plate", description: "Deep even snips on all corners — a strongly beveled metal plate.", props: { r0: 0.35, r1: 0.35, r2: 0.35, r3: 0.35, cornerStyle: "snip" } },
      { name: "Left Pill Cap", description: "Full rounding on the left corners, sharp on the right — a rounded-start bar.", props: { r0: 1, r1: 0, r2: 0, r3: 1, cornerStyle: "round" } },
      { name: "Octagon Frame", description: "Deep even snips near the geometric maximum — reads close to an octagon.", props: { r0: 0.95, r1: 0.95, r2: 0.95, r3: 0.95, cornerStyle: "snip" } },
    ],
    outline: (s) => cornerRectOutline(s.w, s.h, { r0: s.r0 ?? 0, r1: s.r1 ?? 0, r2: s.r2 ?? 0, r3: s.r3 ?? 0, cornerStyle: s.cornerStyle ?? "round" }),
    // Each corner's handle slides from its vertex along the edge toward the next
    // vertex, as far as the geometric maximum radius (half the shorter side): an
    // AXIS-ALIGNED SEGMENT, so the projection is the plain metric one.
    modifierPoints(s) {
      const keys = ["r0", "r1", "r2", "r3"];
      const armOf = (st, i) => {
        const bx = [[0, 0], [st.w, 0], [st.w, st.h], [0, st.h]];
        const v = { x: bx[i][0], y: bx[i][1] }, next = bx[(i + 1) % 4];
        const dx = next[0] - v.x, dy = next[1] - v.y, len = Math.hypot(dx, dy);
        const maxR = Math.min(st.w, st.h) / 2;
        const u = len > 0 ? { x: dx / len, y: dy / len } : { x: 0, y: 0 };
        return { v, u, maxR, end: { x: v.x + u.x * maxR, y: v.y + u.y * maxR } };
      };
      return keys.map((key, i) => {
        const a = armOf(s, i);
        const rr = clamp(s[key], 0, 1) * a.maxR;
        return {
          id: key, x: a.v.x + a.u.x * rr, y: a.v.y + a.u.y * rr,
          constrain(st, pt) { const q = armOf(st, i); return closestPointOnSegment(q.v, q.end, pt); },
          apply(st, pt) {
            const q = armOf(st, i);
            return { [key]: ratioOf((pt.x - q.v.x) * q.u.x + (pt.y - q.v.y) * q.u.y, q.maxR, clamp(st[key], 0, 1)) };
          },
        };
      });
    },
  },
  {
    type: "ss_quadWedge", title: "Quad / Wedge", icon: "mdi:vector-square", fill: "#e0af68",
    defaults: { taper: 0.6, shear: 0, topOffset: 0, cornerRadius: 0 },
    rows: [
      N("taper", "Top width", { min: 0, help: "Top edge width relative to the base: 1 is a rectangle, 0 is a triangle apex, above 1 flares outward into an ever-wider funnel (no upper cap)." }),
      N("shear", "Shear", { scrub: 0.01, help: "Slants the top edge sideways to make a parallelogram, as a fraction of the width. 0 is upright; magnitudes past 1 lean the top beyond the base." }),
      N("topOffset", "Top offset", { scrub: 0.01, help: "Shifts the top edge's center sideways for a right-trapezoid or keystone, as a fraction of the width; values past 1 push the top clear of the base." }),
      N("cornerRadius", "Corner radius", { min: 0, max: 0.5, help: "Rounds all four corners by this fraction of half the shorter side." }),
    ],
    presets: [
      { name: "Rectangle", description: "No taper, no shear, no offset — a plain right rectangle.", props: { taper: 1, shear: 0, topOffset: 0, cornerRadius: 0 } },
      { name: "Triangle", description: "Top edge collapsed to a point — a full-width triangle.", props: { taper: 0, shear: 0, topOffset: 0, cornerRadius: 0 } },
      { name: "Trapezoid", description: "A symmetric narrowed top edge, centered — the classic lampshade trapezoid.", props: { taper: 0.5, shear: 0, topOffset: 0, cornerRadius: 0 } },
      { name: "Right Trapezoid", description: "A narrowed top edge pushed to one side, leaving one vertical edge.", props: { taper: 0.55, shear: 0, topOffset: 0.225, cornerRadius: 0 } },
      { name: "Parallelogram", description: "Full-width top edge slid sideways — a slanted parallelogram.", props: { taper: 1, shear: 0.4, topOffset: 0, cornerRadius: 0 } },
      { name: "Rhombus / Kite", description: "A narrow sheared top over a wide base — a kite-like rhombus.", props: { taper: 0.4, shear: 0.3, topOffset: 0, cornerRadius: 0 } },
      { name: "Funnel", description: "Top edge flared wider than the base — an inverted, ever-wider funnel mouth.", props: { taper: 1.6, shear: 0, topOffset: 0, cornerRadius: 0 } },
      { name: "Keystone", description: "A narrow centered top over a wide base with soft rounded corners — an architectural keystone.", props: { taper: 0.35, shear: 0, topOffset: 0, cornerRadius: 0.15 } },
      { name: "Chevron Lean", description: "A strongly sheared narrow top — a dramatic slanted wedge.", props: { taper: 0.6, shear: 0.75, topOffset: 0, cornerRadius: 0 } },
      { name: "Rounded Parallelogram", description: "A full-width sheared parallelogram with softened corners.", props: { taper: 1, shear: 0.35, topOffset: 0, cornerRadius: 0.2 } },
      { name: "Steep Wedge", description: "A near-triangle with a hint of top edge left, corners slightly rounded.", props: { taper: 0.08, shear: 0, topOffset: 0, cornerRadius: 0.05 } },
      { name: "Offset Tab", description: "A narrow tab-like top pushed hard to one side over a wide base.", props: { taper: 0.25, shear: 0, topOffset: 0.375, cornerRadius: 0.1 } },
    ],
    outline: (s) => quadWedgeOutline(s.w, s.h, { taper: s.taper ?? 1, shear: s.shear ?? 0, topOffset: s.topOffset ?? 0, cornerRadius: s.cornerRadius ?? 0 }),
    // Both handles ride the TOP EDGE (y = 0): taper along the RAY running +x from the
    // top edge's centre (a width has a floor of 0 and no cap), shear along the whole
    // LINE (it leans either way, unbounded).
    modifierPoints(s) {
      const topW = Math.max(0, s.taper ?? 1) * s.w;
      const taperBase = (st) => ({ x: st.w / 2 + ((st.topOffset ?? 0) + (st.shear ?? 0)) * st.w, y: 0 });
      const shearBase = (st) => ({ x: st.w / 2 + (st.topOffset ?? 0) * st.w, y: 0 });
      const cxTop = s.w / 2 + (s.topOffset ?? 0) * s.w + (s.shear ?? 0) * s.w;
      return [
        {
          id: "taper", x: cxTop + topW / 2, y: 0,
          constrain: (st, pt) => closestPointOnAxisRange(taperBase(st), { x: 1, y: 0 }, pt, 0),
          apply: (st, pt) => ({ taper: ratioOf(2 * (pt.x - taperBase(st).x), st.w, Math.max(0, st.taper ?? 1)) }),
        },
        {
          id: "shear", x: cxTop, y: 0,
          constrain: (st, pt) => closestPointOnAxisRange(shearBase(st), { x: 1, y: 0 }, pt),
          apply: (st, pt) => ({ shear: ratioOf(pt.x - shearBase(st).x, st.w, st.shear ?? 0) }),
        },
      ];
    },
  },
  {
    type: "ss_crossPlus", title: "Cross / Plus", icon: "mdi:plus-thick", fill: "#f7768e",
    defaults: { armThickness: 0.34, armLengthRatio: 1, cornerRadius: 0 },
    rows: [
      N("armThickness", "Arm thickness", { min: 0, max: 1, help: "How thick the arms are as a fraction of the box. 0 is a hairline plus, large a chunky cross. Drag the inner-corner handle." }),
      N("armLengthRatio", "Vertical length", { min: 0, max: 1, help: "Shortens the vertical arm: 1 is a symmetric Greek cross, lower makes a squat plus. Drag the top handle." }),
      N("cornerRadius", "Corner radius", { min: 0, max: 0.5, help: "Rounds the twelve corners by this fraction of half the shorter side." }),
    ],
    // TWO ROWS BELOW ASK FOR THE RADIUS THEY ALWAYS RENDERED, not the one they
    // used to store. core/outline.js roundedVerts capped every corner by the
    // WHOLE polygon's shortest edge, so on a thin cross the arm's width flattened
    // the four ARMPITS too: "Delicate Cross" stored 0.5 and drew 0.14, "Add Icon"
    // stored 0.5 and drew 0.28. Now that each corner is capped by its own edges
    // the armpits would take 0.43 and 0.36 — a four-point sparkle, not the
    // "jewelry-style pendant cross" and small-size "plus" these rows describe. So
    // they state the radius that produces the picture they were tuned to. Measured
    // against the pre-fix generator at a 200x200 box: "Add Icon" is bit-for-bit
    // identical (0 of its 108 samples move), and "Delicate Cross" moves 44 of its
    // 108 by at most 2.9e-14 px — the two clamps reach the same 14px by different
    // arithmetic. Not "byte-identical", said exactly, because the claim is cheap
    // to make and expensive to be wrong about.
    presets: [
      { name: "Greek Cross", description: "The classic even-armed plus, symmetric both ways, slightly bolder arms than the plugin default.", props: { armThickness: 0.4, armLengthRatio: 1, cornerRadius: 0 } },
      { name: "Medical Cross", description: "A thick, bold plus sign — the red-cross proportions.", props: { armThickness: 0.5, armLengthRatio: 1, cornerRadius: 0 } },
      { name: "Hairline Plus", description: "A very thin crosshair plus.", props: { armThickness: 0.08, armLengthRatio: 1, cornerRadius: 0 } },
      { name: "Rounded Plus", description: "A soft, rounded-corner plus icon, medium weight.", props: { armThickness: 0.36, armLengthRatio: 1, cornerRadius: 0.4 } },
      { name: "Squat Plus", description: "A shortened vertical arm on a normal-thickness cross — a wide, low plus.", props: { armThickness: 0.4, armLengthRatio: 0.55, cornerRadius: 0 } },
      { name: "Thin Cross", description: "A slim, understated crucifix-style cross — thin arms, full height.", props: { armThickness: 0.16, armLengthRatio: 1, cornerRadius: 0 } },
      { name: "Chunky Cross", description: "Very thick arms nearly filling the box — a bold blocky cross.", props: { armThickness: 0.85, armLengthRatio: 1, cornerRadius: 0 } },
      { name: "Rounded Medical", description: "Thick and rounded — a friendly, soft medical-cross icon.", props: { armThickness: 0.48, armLengthRatio: 1, cornerRadius: 0.25 } },
      { name: "Add Icon", description: "A compact plus tuned to read cleanly at small icon sizes.", props: { armThickness: 0.28, armLengthRatio: 1, cornerRadius: 0.28 } },
      { name: "Low Plus", description: "A very squat cross with a barely-there vertical arm.", props: { armThickness: 0.3, armLengthRatio: 0.2, cornerRadius: 0 } },
      { name: "Fat Rounded Tick", description: "Near-maximum thickness with full rounding — almost a rounded diamond.", props: { armThickness: 0.9, armLengthRatio: 1, cornerRadius: 0.5 } },
      { name: "Delicate Cross", description: "Thin arms with soft rounded ends — a jewelry-style pendant cross.", props: { armThickness: 0.14, armLengthRatio: 1, cornerRadius: 0.14 } },
    ],
    outline: (s) => crossPlusOutline(s.w, s.h, { armThickness: s.armThickness ?? 1 / 3, armLengthRatio: s.armLengthRatio ?? 1, cornerRadius: s.cornerRadius ?? 0 }),
    // armThickness's handle is the arms' INNER CORNER, so thickening moves it right AND
    // up: its allowed set is a DIAGONAL segment, and the drag reads only x — an OBLIQUE
    // retraction onto that segment (the corner tracks the cursor's x and rides the
    // diagonal), NOT the metric nearest point. Deliberate and pre-existing: the reading
    // is "how thick", which is a horizontal measurement.
    // armLengthRatio's handle is the vertical arm's top, a VERTICAL segment from the box
    // top down to the arm's own crotch — the plain metric projection.
    modifierPoints(s) {
      const t = clamp(s.armThickness, 0, 1), half = t / 2;
      const x2 = (0.5 + half) * s.w, y1 = (0.5 - half) * s.h;
      const lr = clamp(s.armLengthRatio, 0, 1), top = (1 - lr) * (0.5 - half) * s.h;
      const [LO, HI] = [0, 1]; // the `armThickness` row's declared bounds
      // The x-fraction that reads back as the stored thickness, so a box with no width
      // (nothing to take a fraction of) leaves the value exactly where it was.
      const heldFraction = (st) => 0.5 + clamp(st.armThickness, LO, HI) / 2;
      const thicknessAt = (st, x) => clamp(2 * ratioOf(x, st.w, heldFraction(st)) - 1, LO, HI);
      // The vertical arm's available room: zero when the arms already fill the box
      // (armThickness 1), which is a single-point allowed set — the handle cannot move.
      const roomOf = (st) => (0.5 - clamp(st.armThickness, LO, HI) / 2) * st.h;
      return [
        {
          id: "armThickness", x: x2, y: y1,
          constrain(st, pt) { const th = thicknessAt(st, pt.x) / 2; return { x: (0.5 + th) * st.w, y: (0.5 - th) * st.h }; },
          apply: (st, pt) => ({ armThickness: 2 * ratioOf(pt.x, st.w, heldFraction(st)) - 1 }),
        },
        {
          id: "armLengthRatio", x: s.w / 2, y: top,
          constrain: (st, pt) => closestPointOnSegment({ x: st.w / 2, y: 0 }, { x: st.w / 2, y: roomOf(st) }, pt),
          apply: (st, pt) => ({ armLengthRatio: 1 - ratioOf(pt.y, roomOf(st), 1 - clamp(st.armLengthRatio, 0, 1)) }),
        },
      ];
    },
  },
  {
    type: "ss_frame", title: "Frame / L-shape", icon: "mdi:crop-square", fill: "#9ece6a", fillRule: "evenodd",
    defaults: { thickness: 0.15, sides: "frame" },
    rows: [
      N("thickness", "Border thickness", { min: 0, max: 0.5, help: "Width of the border as a fraction of the shorter side. Drag the inner-corner handle to set it." }),
      SEL("sides", "Sides", ["frame", "half", "corner", "bar"], { frame: "Full frame", half: "Half-frame (U)", corner: "L-shape", bar: "Single bar" }, "Which edges the border keeps: a full frame (hole in the middle), a three-sided U, an L corner, or one bar."),
    ],
    presets: [
      { name: "Picture Frame", description: "A moderate even border all around — the everyday photo frame.", props: { thickness: 0.12, sides: "frame" } },
      { name: "Thin Mat", description: "A slim border, like a mat board around a print.", props: { thickness: 0.05, sides: "frame" } },
      { name: "Chunky Border", description: "A heavy, near-maximum-thickness frame border.", props: { thickness: 0.42, sides: "frame" } },
      { name: "Gallery Frame", description: "A wide gallery-style mat, deep but not overwhelming.", props: { thickness: 0.25, sides: "frame" } },
      { name: "Half-Frame U", description: "Three sides only, open at the top — a shelf or bracket U.", props: { thickness: 0.15, sides: "half" } },
      { name: "Deep Half-Frame", description: "A thick three-sided U — a tray or cradle.", props: { thickness: 0.3, sides: "half" } },
      { name: "L Bracket", description: "A single L-shaped corner border, thin.", props: { thickness: 0.1, sides: "corner" } },
      { name: "Heavy L Corner", description: "A thick L-shaped corner, reading as a structural bracket.", props: { thickness: 0.35, sides: "corner" } },
      { name: "Single Bar Thin", description: "Just one bar along the top edge, thin.", props: { thickness: 0.06, sides: "bar" } },
      { name: "Single Bar Bold", description: "One thick bar — an underline or header rule.", props: { thickness: 0.28, sides: "bar" } },
      { name: "Hairline Frame", description: "The thinnest legal full frame — a fine hairline border.", props: { thickness: 0.02, sides: "frame" } },
      { name: "Corner Tick", description: "A very thin L corner — a registration/crop-mark tick.", props: { thickness: 0.03, sides: "corner" } },
    ],
    outline: (s) => frameOutline(s.w, s.h, { thickness: s.thickness ?? 0.15, sides: s.sides ?? "frame" }),
    // The border's INNER CORNER, so thickening moves it right AND down: a DIAGONAL
    // allowed set read by x alone — the same OBLIQUE retraction the cross's inner
    // corner uses (a thickness is a horizontal measurement), not the metric nearest.
    modifierPoints(s) {
      const [LO, HI] = [0, 0.5]; // the `thickness` row's declared bounds
      const shortSide = (st) => Math.min(st.w, st.h);
      const thicknessAt = (st, x) => clamp(ratioOf(x, shortSide(st), clamp(st.thickness, LO, HI)), LO, HI);
      const b = clamp(s.thickness, LO, HI) * shortSide(s);
      return [{
        id: "thickness", x: b, y: b,
        constrain(st, pt) { const q = thicknessAt(st, pt.x) * shortSide(st); return { x: q, y: q }; },
        apply: (st, pt) => ({ thickness: ratioOf(pt.x, shortSide(st), clamp(st.thickness, LO, HI)) }),
      }];
    },
  },
  {
    type: "ss_gear", title: "Gear / Cog", icon: "mdi:cog-outline", fill: "#7dcfff", fillRule: "evenodd",
    defaults: { teeth: 8, innerRatio: 0.72, toothWidth: 0.5, holeRatio: 0 },
    rows: [
      N("teeth", "Teeth", { min: 3, help: "Number of teeth around the gear (three or more; no upper cap). Type an exact count." }),
      N("innerRatio", "Root radius", { min: 0, max: 1, help: "How deep the valleys between teeth cut in, as a fraction of the outer radius. 0 collapses the valleys to the center (a toothed star); 1 rises to meet the tips (a plain circle — no depth left to cut). Drag the root handle." }),
      N("toothWidth", "Tooth width", { min: 0, max: 1, help: "Angular width of each tooth top as a fraction of the pitch: 0 collapses each tooth to a point (a sharp starburst), 1 merges adjacent teeth into a smooth ring. Drag the tooth handle." }),
      N("holeRatio", "Center hole", { min: 0, max: 0.9, help: "Radius of a hole through the center as a fraction of the outer radius. 0 is solid. Capped just inside the root radius — a hole cannot punch through the teeth." }),
    ],
    presets: [
      { name: "Clock Escapement", description: "Many fine, shallow teeth on a delicate wheel — a watch escapement gear.", props: { teeth: 24, innerRatio: 0.88, toothWidth: 0.4, holeRatio: 0.15 } },
      { name: "Bike Sprocket", description: "Wide, blunt teeth with a large mounting hole — a bicycle chainring.", props: { teeth: 20, innerRatio: 0.82, toothWidth: 0.6, holeRatio: 0.55 } },
      { name: "Industrial Cog", description: "Fewer, deep, chunky teeth — a heavy machine gear.", props: { teeth: 10, innerRatio: 0.62, toothWidth: 0.5, holeRatio: 0.3 } },
      { name: "Sawblade", description: "Many sharp narrow teeth on a wide ring — a circular-saw silhouette.", props: { teeth: 32, innerRatio: 0.75, toothWidth: 0.15, holeRatio: 0.1 } },
      { name: "Watch Pinion", description: "A tiny-toothed dense pinion gear, thin center hole.", props: { teeth: 14, innerRatio: 0.9, toothWidth: 0.3, holeRatio: 0.08 } },
      { name: "Settings Icon", description: "The rounded-looking UI gear icon: moderate teeth, generous root, wide hole.", props: { teeth: 8, innerRatio: 0.72, toothWidth: 0.5, holeRatio: 0.4 } },
      { name: "Toothed Ring", description: "Very shallow teeth on an almost-solid ring — a ring gear / internal gear reading.", props: { teeth: 40, innerRatio: 0.95, toothWidth: 0.55, holeRatio: 0.7 } },
      { name: "Starburst Gear", description: "Deep, spiky teeth with no root left — a toothed starburst rather than a machine gear.", props: { teeth: 12, innerRatio: 0.05, toothWidth: 0.35, holeRatio: 0 } },
      { name: "Solid Cog", description: "No center hole at all — a solid gear blank.", props: { teeth: 10, innerRatio: 0.68, toothWidth: 0.5, holeRatio: 0 } },
      { name: "Fine Ratchet", description: "Many narrow asymmetric-reading teeth, small hole — a ratchet wheel.", props: { teeth: 28, innerRatio: 0.7, toothWidth: 0.2, holeRatio: 0.2 } },
      { name: "Wide Hub Gear", description: "Few wide-topped teeth around a large open hub.", props: { teeth: 6, innerRatio: 0.65, toothWidth: 0.75, holeRatio: 0.6 } },
      { name: "Steampunk Cog", description: "Bold deep teeth, thick root, dramatic large hole for a shaft.", props: { teeth: 9, innerRatio: 0.55, toothWidth: 0.55, holeRatio: 0.45 } },
    ],
    outline: (s) => gearOutline(s.w, s.h, { teeth: s.teeth ?? 8, innerRatio: s.innerRatio ?? 0.7, toothWidth: s.toothWidth ?? 0.5, holeRatio: s.holeRatio ?? 0 }),
    // innerRatio rides the RADIAL SEGMENT straight up (t ∈ [0, 1] — the full
    // mathematical range, no floor: see gearOutline's docblock for what each end
    // renders). toothWidth rides the RIM, but its reading is the ABSOLUTE angular
    // gap from 12 o'clock, so — like the fancy arrow's half-widths — it MIRRORS a
    // point on the far side onto the one side the handle is drawn (a tooth is
    // symmetric about its centre line): an idempotent retraction, not the metric
    // nearest point.
    modifierPoints(s) {
      const TOOTH_TOP = -Math.PI / 2; // the reference tooth is centred at 12 o'clock
      const g = ellipseGeom(s);
      const root = clamp(s.innerRatio, 0, 1);
      const tw = clamp(s.toothWidth, 0, 1);
      const pitchOf = (st) => (2 * Math.PI) / Math.max(3, Math.round(st.teeth ?? 8));
      // Half the tooth top's angular width, from an angle on the rim.
      const halfTopAt = (st, a) => {
        const pitch = pitchOf(st);
        return clamp((2 * Math.min(Math.abs(TOOTH_TOP - a), pitch / 2)) / pitch, 0, 1) * pitch / 2;
      };
      const halfTop = (tw * pitchOf(s)) / 2;
      return [
        {
          id: "innerRatio", x: g.cx + g.rx * root * Math.cos(TOOTH_TOP), y: g.cy + g.ry * root * Math.sin(TOOTH_TOP),
          constrain: (st, pt) => radialConstrain(ellipseGeom(st), TOOTH_TOP, pt, 0, 1),
          apply: (st, pt) => {
            const gg = ellipseGeom(st);
            return { innerRatio: readOrKeep(gg, () => radialT(gg, pt.x, pt.y, TOOTH_TOP), clamp(st.innerRatio, 0, 1)) };
          },
        },
        {
          id: "toothWidth", x: g.cx + g.rx * Math.cos(TOOTH_TOP - halfTop), y: g.cy + g.ry * Math.sin(TOOTH_TOP - halfTop),
          constrain: (st, pt) => {
            const gg = ellipseGeom(st);
            return ellipsePoint(gg, 1, TOOTH_TOP - halfTopAt(st, angleAt(gg, pt.x, pt.y)));
          },
          apply: (st, pt) => {
            const gg = ellipseGeom(st);
            return { toothWidth: readOrKeep(gg, () => (2 * halfTopAt(st, angleAt(gg, pt.x, pt.y))) / pitchOf(st), clamp(st.toothWidth, 0, 1)) };
          },
        },
      ];
    },
  },
  {
    type: "ss_callout", title: "Callout / Bubble", icon: "mdi:message-outline", fill: "#e0af68",
    defaults: { cornerRadius: 0.25, tailWidth: 0.22, tailX: 40, tailY: 200 },
    rows: [
      N("cornerRadius", "Corner radius", { min: 0, max: 1, help: "Rounds the bubble body's corners, from a sharp rectangle to a soft rounded bubble." }),
      N("tailWidth", "Tail width", { min: 0, max: 0.9, help: "How wide the tail's base is as a fraction of the body width. 0 is a needle-thin pointer, wide is a speech-bubble beak." }),
    ],
    // tailX/tailY are box-local pixel coordinates (declared in `defaults`, no
    // Inspector row — see the family's `modifierPoints` above), so every preset
    // below picks them relative to the DEFAULT box (w:200,h:200 — makeFamilyPlugin's
    // seed) the same way the family's own default already does.
    presets: [
      { name: "Speech Bubble", description: "A softly rounded body with a modest tail pointing down-left — the everyday chat bubble.", props: { cornerRadius: 0.3, tailWidth: 0.3, tailX: 55, tailY: 215 } },
      { name: "Sharp Callout", description: "A square-cornered body with a wide tail — a comic-panel dialogue box.", props: { cornerRadius: 0, tailWidth: 0.5, tailX: 60, tailY: 220 } },
      { name: "Thought Tail", description: "A very narrow needle tail off the bottom-right — reads like a thought trail's first link.", props: { cornerRadius: 0.4, tailWidth: 0.04, tailX: 190, tailY: 260 } },
      { name: "Shout Spike", description: "A sharp square body with a thin spiked tail centered low — an exclamation/shout callout.", props: { cornerRadius: 0, tailWidth: 0.08, tailX: 100, tailY: 280 } },
      { name: "Pill Bubble", description: "A fully rounded pill-shaped body with a small tail — a friendly SMS-style bubble.", props: { cornerRadius: 1, tailWidth: 0.18, tailX: 50, tailY: 210 } },
      { name: "Wide Beak", description: "A broad speech-bubble beak dominating one side.", props: { cornerRadius: 0.2, tailWidth: 0.85, tailX: 100, tailY: 215 } },
      { name: "Top Pointer", description: "The tail points up and out of the top of the box instead of the bottom.", props: { cornerRadius: 0.3, tailWidth: 0.25, tailX: 100, tailY: -20 } },
      { name: "Side Pointer", description: "The tail points out to the right side of the box — an annotation flag.", props: { cornerRadius: 0.3, tailWidth: 0.25, tailX: 230, tailY: 100 } },
      { name: "Caption Box", description: "A barely-rounded body with a stubby centered tail — a captioned-diagram label.", props: { cornerRadius: 0.08, tailWidth: 0.3, tailX: 100, tailY: 205 } },
      { name: "Off-Screen Pointer", description: "A long far-flung tail well outside the body — pointing at something distant.", props: { cornerRadius: 0.25, tailWidth: 0.15, tailX: 340, tailY: 340 } },
      { name: "Whisper Bubble", description: "A lightly rounded body with the thinnest visible tail, far off to the left — a quiet aside.", props: { cornerRadius: 0.6, tailWidth: 0.02, tailX: -60, tailY: 300 } },
      { name: "Blunt Corner Tag", description: "Sharp corners with a wide near-flush tail — a price tag / label callout.", props: { cornerRadius: 0, tailWidth: 0.7, tailX: 150, tailY: 220 } },
    ],
    outline: (s) => calloutOutline(s.w, s.h, { cornerRadius: s.cornerRadius ?? 0.2, tailX: s.tailX, tailY: s.tailY, tailWidth: s.tailWidth ?? 0.22 }),
    // The tail tip goes ANYWHERE (a speech bubble may point off its own box), so this
    // handle declares NO `constrain`: the identity default is the truthful statement.
    modifierPoints(s) {
      return [{ id: "tail", x: s.tailX ?? s.w * 0.25, y: s.tailY ?? s.h, apply: (_st, pt) => ({ tailX: pt.x, tailY: pt.y }) }];
    },
  },
  // ── ORGANIC FAMILIES ────────────────────────────────────────────────────────
  // The two silhouettes the legacy preset table drew as FIXED bezier art with no
  // knobs at all. They are families rather than more fixed paths because each has
  // an obvious thing an author varies — a cloud's puff count, a heart's cleft —
  // and a shape you cannot adjust is the complaint this whole consolidation is
  // answering.
  {
    type: "ss_cloud", title: "Cloud", icon: "mdi:cloud-outline", fill: "#c0caf5",
    // w/h are declared here (the hardware/scroll families' precedent) so the seed
    // state is a COMPLETE, drawable state on its own: a family whose defaults omit
    // the box hands its generator an undefined extent, and every vertex comes back
    // NaN. A cloud is wider than it is tall.
    defaults: { bumps: 6, lobeDepth: 0.28, flatten: 0.35, w: 260, h: 180 },
    rows: [
      N("bumps", "Puffs", { min: 3, help: "How many lobes ring the cloud (three or more; no upper cap). Few reads as a cartoon cloud, many as foam or a thought bubble. Drag the puff handle around the rim." }),
      N("lobeDepth", "Puff depth", { min: 0, max: 1, help: "How far each lobe bulges past the body: 0 is a plain ellipse, high is a billowing cumulus. Drag the depth handle." }),
      N("flatten", "Flat bottom", { min: 0, max: 1, help: "Pulls the lower lobes toward a straight base: 0 is a round all-over cloud, 1 a flat-bottomed one sitting on a line." }),
    ],
    presets: [
      { name: "Cartoon Cloud", description: "Few fat puffs on a flat base — the storybook cloud.", props: { bumps: 5, lobeDepth: 0.34, flatten: 0.6 } },
      { name: "Thought Bubble", description: "Many even puffs all round, no flattening — the classic thought balloon.", props: { bumps: 11, lobeDepth: 0.26, flatten: 0 } },
      { name: "Cumulus", description: "A billowing weather cloud: deep lobes, strongly flat-bottomed.", props: { bumps: 8, lobeDepth: 0.45, flatten: 0.85 } },
      { name: "Soft Blob", description: "Shallow lobes on a round body — nearly an ellipse, just barely puffy.", props: { bumps: 7, lobeDepth: 0.1, flatten: 0.2 } },
      { name: "Trefoil Puff", description: "The fewest lobes a cloud can have: three fat puffs, round underneath.", props: { bumps: 3, lobeDepth: 0.5, flatten: 0 } },
      { name: "Storm Front", description: "A long run of deep lobes over a hard flat base — a squall line.", props: { bumps: 13, lobeDepth: 0.55, flatten: 1 } },
      { name: "Sea Foam", description: "Many shallow puffs, no flattening: froth rather than weather.", props: { bumps: 16, lobeDepth: 0.14, flatten: 0 } },
      { name: "Fair-Weather Cumulus", description: "The small tidy daytime cloud: moderate lobes on a level base.", props: { bumps: 7, lobeDepth: 0.3, flatten: 0.7 } },
      { name: "Speech Puff", description: "Round, even and unflattened — a comic-strip speech cloud.", props: { bumps: 9, lobeDepth: 0.3, flatten: 0 } },
      { name: "Anvil Head", description: "Deep billows with a partly flattened underside — a thunderhead.", props: { bumps: 6, lobeDepth: 0.6, flatten: 0.45 } },
      { name: "Popcorn", description: "Maximum lobe depth at a middling count — knobbly and irregular-reading.", props: { bumps: 8, lobeDepth: 1, flatten: 0.3 } },
      { name: "Mist Bank", description: "Barely-there lobes flattened almost to a bar — low-lying haze.", props: { bumps: 12, lobeDepth: 0.06, flatten: 1 } },
    ],
    outline: (s) => cloudOutline(s.w, s.h, { bumps: s.bumps ?? 6, lobeDepth: s.lobeDepth ?? 0.28, flatten: s.flatten ?? 0.35 }),
    // `bumps` rides the RIM as a discrete count (the polygonStar precedent: the
    // nearest allowed COUNT, not the nearest allowed angle); `lobeDepth` rides the
    // RADIAL segment straight up, the direction the top lobe bulges.
    modifierPoints(s) {
      const g = ellipseGeom(s);
      const TOP = -Math.PI / 2;
      const n = Math.max(3, Math.round(s.bumps ?? 6));
      const depth = clamp(s.lobeDepth, 0, 1);
      return [
        {
          id: "bumps", x: g.cx + g.rx * Math.cos(TOP + (2 * Math.PI) / n), y: g.cy + g.ry * Math.sin(TOP + (2 * Math.PI) / n),
          constrain: (st, pt) => {
            const gg = ellipseGeom(st);
            return ellipsePoint(gg, 1, TOP + (2 * Math.PI) / pointCountFromAngle(TOP, angleAt(gg, pt.x, pt.y)));
          },
          apply: (st, pt) => {
            const gg = ellipseGeom(st);
            return { bumps: readOrKeep(gg, () => pointCountFromAngle(TOP, angleAt(gg, pt.x, pt.y)), Math.max(3, Math.round(st.bumps ?? 6))) };
          },
        },
        {
          id: "lobeDepth", x: g.cx + g.rx * depth * Math.cos(TOP), y: g.cy + g.ry * depth * Math.sin(TOP),
          constrain: (st, pt) => radialConstrain(ellipseGeom(st), TOP, pt, 0, 1),
          apply: (st, pt) => {
            const gg = ellipseGeom(st);
            return { lobeDepth: readOrKeep(gg, () => radialT(gg, pt.x, pt.y, TOP), clamp(st.lobeDepth, 0, 1)) };
          },
        },
      ];
    },
  },
  {
    type: "ss_heart", title: "Heart", icon: "mdi:heart-outline", fill: "#f7768e",
    defaults: { cleft: 0.22, lobeWidth: 1, tipSharpness: 0.45, w: 200, h: 200 },
    rows: [
      N("cleft", "Cleft depth", { min: 0, max: 0.9, help: "How deep the notch between the two lobes cuts, as a fraction of the height. 0 is a domed top; deep turns the heart toward a spade." }),
      N("lobeWidth", "Lobe width", { min: 0, max: 1, help: "How wide each lobe is, as a fraction of the width. 0 collapses to a hairline, wide a squat one." }),
      N("tipSharpness", "Tip sharpness", { min: 0, max: 1, help: "How drawn-out the bottom point is: 0 is a round bottom, 1 a long tapering spike." }),
    ],
    presets: [
      { name: "Valentine", description: "The classic proportions: a moderate cleft over full-width lobes with a soft point.", props: { cleft: 0.22, lobeWidth: 1, tipSharpness: 0.45 } },
      { name: "Sweetheart", description: "A shallow cleft and fat lobes — a plump, friendly heart.", props: { cleft: 0.12, lobeWidth: 1, tipSharpness: 0.25 } },
      { name: "Spade", description: "A deep cleft between narrow lobes with a long sharp tail — the card-suit reading.", props: { cleft: 0.42, lobeWidth: 0.66, tipSharpness: 0.95 } },
      { name: "Locket", description: "Small round lobes over a long tapering point, sized for a pendant.", props: { cleft: 0.2, lobeWidth: 0.6, tipSharpness: 0.8 } },
      { name: "Dome", description: "Almost no cleft: the two lobes merge into a single arch over a soft point.", props: { cleft: 0.03, lobeWidth: 1, tipSharpness: 0.4 } },
      { name: "Gothic Heart", description: "A deep notch and a drawn-out spike — tall, severe, ecclesiastical.", props: { cleft: 0.55, lobeWidth: 0.8, tipSharpness: 1 } },
      { name: "Slim Pendant", description: "Narrow lobes and a long taper: a heart that reads at small sizes in a row.", props: { cleft: 0.25, lobeWidth: 0.42, tipSharpness: 0.9 } },
      { name: "Candy Heart", description: "Squat and blunt — wide lobes, shallow cleft, a nearly round bottom.", props: { cleft: 0.15, lobeWidth: 1, tipSharpness: 0 } },
      { name: "Folk Motif", description: "Even, geometric proportions suited to a stencil or embroidery repeat.", props: { cleft: 0.3, lobeWidth: 0.85, tipSharpness: 0.6 } },
      { name: "Cleaved", description: "The cleft cut almost to the tip, splitting the lobes into two near-separate arcs.", props: { cleft: 0.75, lobeWidth: 0.9, tipSharpness: 0.7 } },
      { name: "Balloon", description: "Fat round lobes with a stubby point — a party-balloon heart.", props: { cleft: 0.1, lobeWidth: 0.95, tipSharpness: 0.15 } },
      { name: "Hairline Heart", description: "Minimal: the narrowest lobes and a fine long point, for a delicate accent.", props: { cleft: 0.28, lobeWidth: 0.3, tipSharpness: 1 } },
    ],
    outline: (s) => heartOutline(s.w, s.h, { cleft: s.cleft ?? 0.25, lobeWidth: s.lobeWidth ?? 0.5, tipSharpness: s.tipSharpness ?? 0.5 }),
    // ONE handle, deliberately: the cleft is the knob that changes what the shape
    // READS as (valentine ↔ spade), and it rides the vertical centre line, which is
    // exactly where the notch lives. Lobe width and tip sharpness are Inspector
    // knobs — neither has a trajectory a user would find by dragging.
    modifierPoints(s) {
      const [LO, HI] = [0, 0.9]; // the `cleft` row's declared bounds
      return [{
        id: "cleft", x: s.w / 2, y: clamp(s.cleft, LO, HI) * s.h,
        constrain: (st, pt) => closestPointOnSegment({ x: st.w / 2, y: LO * st.h }, { x: st.w / 2, y: HI * st.h }, pt),
        apply: (st, pt) => ({ cleft: ratioOf(pt.y, st.h, clamp(st.cleft, LO, HI)) }),
      }];
    },
  },
  {
    type: "ss_banner", title: "Banner / Ribbon", icon: "mdi:flag-outline", fill: "#bb9af7",
    defaults: { endStyle: "forked", notchDepth: 0.15 },
    rows: [
      SEL("endStyle", "End style", ["flat", "forked"], { flat: "Flat", forked: "Forked" }, "The banner's ends: flat cuts them straight, forked cuts a chevron notch into each end (a ribbon)."),
      N("notchDepth", "Notch depth", { help: "How deep the forked notch cuts in, as a fraction of the width; a negative value forks the ends outward instead, and past ~0.5 the chevrons cross into a bowtie. Drag the notch handle." }),
    ],
    presets: [
      { name: "Flat Banner", description: "A plain rectangle banner, ends cut straight across.", props: { endStyle: "flat", notchDepth: 0 } },
      { name: "Ribbon", description: "A classic forked-end ribbon with a somewhat deeper chevron notch than the plugin default.", props: { endStyle: "forked", notchDepth: 0.22 } },
      { name: "Shallow Swallowtail", description: "A gentle, barely-there fork — a subtle swallowtail flag.", props: { endStyle: "forked", notchDepth: 0.05 } },
      { name: "Deep Swallowtail", description: "A dramatic deep V-notch at each end — a pennant swallowtail.", props: { endStyle: "forked", notchDepth: 0.4 } },
      { name: "Bowtie", description: "The notch cut past the crossover point — the ends fold into a bowtie silhouette.", props: { endStyle: "forked", notchDepth: 0.6 } },
      { name: "Outward Fork", description: "A negative notch depth: the ends flare outward into arrowhead points instead of cutting in.", props: { endStyle: "forked", notchDepth: -0.2 } },
      { name: "Sharp Outward Points", description: "A deeper outward fork — pronounced arrow-like flared ends.", props: { endStyle: "forked", notchDepth: -0.45 } },
      { name: "Barely Notched", description: "The faintest legal notch, just off flat — a near-rectangle with a hint of a fork.", props: { endStyle: "forked", notchDepth: 0.02 } },
      { name: "Award Ribbon", description: "A deep, narrow-reading fork proportioned like a medal award ribbon.", props: { endStyle: "forked", notchDepth: 0.3 } },
      { name: "Crossed Bowtie Extreme", description: "The notch cut well past crossover — a tightly pinched bowtie/hourglass silhouette.", props: { endStyle: "forked", notchDepth: 0.75 } },
      { name: "Minimal Outward Nudge", description: "The gentlest outward flare, barely distinguishable from flat but pointed.", props: { endStyle: "forked", notchDepth: -0.05 } },
      { name: "Half-Cross Bowtie", description: "The notch sitting exactly at the crossover boundary — the tightest fork before it becomes a bowtie.", props: { endStyle: "forked", notchDepth: 0.5 } },
    ],
    outline: (s) => bannerOutline(s.w, s.h, { endStyle: s.endStyle ?? "forked", notchDepth: s.notchDepth ?? 0.15 }),
    // The notch's point, on the banner's horizontal midline: the allowed set is that
    // whole LINE (notchDepth is unbounded either way — it forks outward when negative
    // and crosses into a bowtie past ~0.5, both documented as legal).
    modifierPoints(s) {
      if ((s.endStyle ?? "forked") !== "forked") return [];
      const nd = (s.notchDepth ?? 0.15) * s.w;
      return [{
        id: "notchDepth", x: s.w - nd, y: s.h / 2,
        constrain: (st, pt) => closestPointOnAxisRange({ x: st.w, y: st.h / 2 }, { x: 1, y: 0 }, pt),
        apply: (st, pt) => ({ notchDepth: ratioOf(st.w - pt.x, st.w, st.notchDepth ?? 0.15) }),
      }];
    },
  },
  {
    type: "ss_bracket", title: "Bracket", icon: "mdi:code-brackets", fill: "#9ece6a",
    defaults: { thickness: 0.22, armDepth: 0.12, armLength: 1, w: 90, h: 220 },
    // THREE thicknesses, THREE handles (user: "the one part could be skinnier than
    // the other"). The spine, the arms' depth and the arms' reach are separate
    // measurements on a real bracket, and each gets its own knob and its own yellow
    // square: one handle for three numbers could only ever write one of them.
    rows: [
      N("thickness", "Spine width", { min: 0, max: 0.9, help: "Width of the bracket's vertical bar as a fraction of the width. 0 is a hairline spine. Drag the spine handle. Rotate the widget to orient the bracket." }),
      N("armDepth", "Arm depth", { min: 0, max: 0.45, help: "Thickness of the top and bottom arms as a fraction of the height — independent of the spine, so the arms can be skinnier or chunkier than the bar. 0 is hairline arms." }),
      N("armLength", "Arm reach", { min: 0, max: 1, help: "How far the arms reach across, as a fraction of the width. 1 is a full bracket; 0 pulls the arms all the way back to the spine (a plain vertical bar)." }),
    ],
    presets: [
      { name: "Square Bracket", description: "The plain typographic \"[\": even spine and arms, arms reaching the full width.", props: { thickness: 0.22, armDepth: 0.12, armLength: 1 } },
      { name: "Hairline Rule", description: "A thin editorial bracket — skinny spine, skinnier arms, full reach.", props: { thickness: 0.08, armDepth: 0.04, armLength: 1 } },
      { name: "Heavy Spine", description: "A thick structural bar with light arms — the spine dominates.", props: { thickness: 0.55, armDepth: 0.07, armLength: 1 } },
      { name: "Deep Serif", description: "A slim bar under deep slab arms, the inverse weighting of Heavy Spine.", props: { thickness: 0.12, armDepth: 0.34, armLength: 1 } },
      { name: "Stub Corner", description: "Full-weight spine with arms pulled back to a third of the reach — a corner tick.", props: { thickness: 0.3, armDepth: 0.16, armLength: 0.35 } },
      { name: "Slab Brace", description: "Everything heavy: a thick spine under thick arms at full reach.", props: { thickness: 0.45, armDepth: 0.35, armLength: 1 } },
      { name: "Tick Mark", description: "A short thin bracket that reads as a corner registration mark.", props: { thickness: 0.1, armDepth: 0.06, armLength: 0.4 } },
      { name: "Wide Staple", description: "A skinny spine with long deep arms — a staple laid on its side.", props: { thickness: 0.09, armDepth: 0.28, armLength: 1 } },
      { name: "Column Rule", description: "A near-bare vertical rule: full spine, arms barely present.", props: { thickness: 0.3, armDepth: 0.03, armLength: 0.15 } },
      { name: "Display Bracket", description: "Bold and even, scaled for a pull-quote or a title flank.", props: { thickness: 0.28, armDepth: 0.2, armLength: 0.8 } },
      { name: "Chevron Stub", description: "A thick spine with short deep arms — compact and blocky.", props: { thickness: 0.5, armDepth: 0.4, armLength: 0.6 } },
      { name: "Fine Serif", description: "A hairline spine with slightly heavier arms — the most delicate of the set.", props: { thickness: 0.05, armDepth: 0.09, armLength: 0.7 } },
      { name: "Half Frame", description: "Maximum arms at full reach over a mid spine — nearly a three-sided frame.", props: { thickness: 0.2, armDepth: 0.45, armLength: 1 } },
    ],
    outline: (s) => bracketOutline(s.w, s.h, { thickness: s.thickness ?? 0.2, armDepth: s.armDepth, armLength: s.armLength }),
    // Three handles, each on its own axis-aligned SEGMENT (the plain metric
    // projection): the spine's inner edge slides along the horizontal midline, the
    // top arm's inner edge slides down the left of the opening, and the arm tip
    // slides along the top edge.
    modifierPoints(s) {
      const [LO, HI] = [0, 0.9];       // the `thickness` row's declared bounds
      const [DLO, DHI] = [0, 0.45];    // the `armDepth` row's declared bounds
      const [RLO, RHI] = [0, 1];       // the `armLength` row's declared bounds
      const depthOf = (st) => clamp(st.armDepth ?? st.thickness, DLO, DHI);
      const reachOf = (st) => clamp(st.armLength ?? 1, RLO, RHI);
      return [
        {
          id: "thickness", x: clamp(s.thickness, LO, HI) * s.w, y: s.h / 2,
          constrain: (st, pt) => closestPointOnSegment({ x: LO * st.w, y: st.h / 2 }, { x: HI * st.w, y: st.h / 2 }, pt),
          apply: (st, pt) => ({ thickness: ratioOf(pt.x, st.w, clamp(st.thickness, LO, HI)) }),
        },
        {
          id: "armDepth", x: clamp(s.thickness, LO, HI) * s.w, y: depthOf(s) * s.h,
          constrain: (st, pt) => closestPointOnSegment(
            { x: clamp(st.thickness, LO, HI) * st.w, y: DLO * st.h },
            { x: clamp(st.thickness, LO, HI) * st.w, y: DHI * st.h }, pt),
          apply: (st, pt) => ({ armDepth: ratioOf(pt.y, st.h, depthOf(st)) }),
        },
        {
          id: "armLength", x: reachOf(s) * s.w, y: depthOf(s) * s.h / 2,
          constrain: (st, pt) => closestPointOnSegment(
            { x: RLO * st.w, y: depthOf(st) * st.h / 2 },
            { x: RHI * st.w, y: depthOf(st) * st.h / 2 }, pt),
          apply: (st, pt) => ({ armLength: ratioOf(pt.x, st.w, reachOf(st)) }),
        },
      ];
    },
  },
  {
    type: "ss_arrow", title: "Arrow", icon: "mdi:arrow-right-thick", fill: "#f7768e",
    defaults: { headRatio: 0.4, headWidth: 0.6, shaftRatio: 0.4, tailNotch: 0, curvature: 0, doubleHead: false },
    rows: [
      N("headRatio", "Head length", { min: 0, max: 1, help: "How much of the arrow's length is the head, as a fraction. 0 is all shaft (no head), 1 is a pentagon with no shaft." }),
      N("headWidth", "Head width", { min: 0, max: 1, help: "How wide the arrowhead's barbs are as a fraction of the length. 0 collapses the whole arrow to a flat line." }),
      N("shaftRatio", "Shaft thickness", { min: 0, max: 1, help: "Shaft thickness as a fraction of the head width. 0 is a shaftless outline, near 1 fills the head." }),
      N("tailNotch", "Tail notch", { min: 0, max: 0.9, help: "Cuts a chevron notch into the flat tail: 0 is a flat back, higher turns the tail into a chevron / striped arrow." }),
      N("curvature", "Curvature", { min: 0, scrub: 0.01, help: "Bends the arrow along an arc: 0 is straight, higher curves it, near 1 wraps it into a near-circular arrow, and beyond 1 keeps winding it tighter into overlapping loops (no upper cap)." }),
      BOOL("doubleHead", "Double head", "Adds a second arrowhead at the tail (a double-headed arrow)."),
    ],
    presets: [
      { name: "Right Arrow", description: "Balanced proportions with a slightly bolder head than the plugin default — a clean directional pointer.", props: { headRatio: 0.45, headWidth: 0.7, shaftRatio: 0.45, tailNotch: 0, curvature: 0, doubleHead: false } },
      { name: "Double Arrow", description: "Arrowheads at both ends, symmetric — a bidirectional/exchange arrow.", props: { headRatio: 0.35, headWidth: 0.65, shaftRatio: 0.4, tailNotch: 0, curvature: 0, doubleHead: true } },
      { name: "Chevron", description: "Almost all head, barely any shaft — a bold chevron pointer.", props: { headRatio: 0.85, headWidth: 0.8, shaftRatio: 0.7, tailNotch: 0, curvature: 0, doubleHead: false } },
      { name: "Pentagon", description: "Head ratio at maximum with a full-width shaft — collapses to a pentagon (no visible shaft break).", props: { headRatio: 1, headWidth: 0.6, shaftRatio: 1, tailNotch: 0, curvature: 0, doubleHead: false } },
      { name: "Thin Shaft Arrow", description: "A slim shaft under a modest head — a delicate directional pointer.", props: { headRatio: 0.3, headWidth: 0.5, shaftRatio: 0.15, tailNotch: 0, curvature: 0, doubleHead: false } },
      { name: "Fletched Tail", description: "A chevron notch cut into the flat tail — a striped/fletched arrow.", props: { headRatio: 0.35, headWidth: 0.55, shaftRatio: 0.4, tailNotch: 0.5, curvature: 0, doubleHead: false } },
      { name: "Curved Arrow", description: "Bent along a gentle arc — a turn or redo indicator.", props: { headRatio: 0.35, headWidth: 0.6, shaftRatio: 0.35, tailNotch: 0, curvature: 0.5, doubleHead: false } },
      { name: "Near-Circular Arrow", description: "Wound almost into a full loop — a refresh/cycle icon.", props: { headRatio: 0.3, headWidth: 0.6, shaftRatio: 0.3, tailNotch: 0, curvature: 0.95, doubleHead: false } },
      { name: "Overwound Loop", description: "Curved past a full turn into overlapping loops — a spiral/repeat icon.", props: { headRatio: 0.3, headWidth: 0.55, shaftRatio: 0.3, tailNotch: 0, curvature: 1.6, doubleHead: false } },
      { name: "Flat Line Arrow", description: "Head width collapsed to a hairline — the whole arrow reads as a flat line with a tick.", props: { headRatio: 0.2, headWidth: 0.05, shaftRatio: 0.5, tailNotch: 0, curvature: 0, doubleHead: false } },
      { name: "Notched Double Head", description: "A double-headed arrow with a fletched tail notch on top — a barbed two-way arrow.", props: { headRatio: 0.3, headWidth: 0.7, shaftRatio: 0.45, tailNotch: 0.35, curvature: 0, doubleHead: true } },
      { name: "Wide Barb Arrow", description: "An exaggerated wide arrowhead barb over a thin shaft.", props: { headRatio: 0.45, headWidth: 1, shaftRatio: 0.2, tailNotch: 0, curvature: 0, doubleHead: false } },
    ],
    outline: (s) => arrowOutline(s.w, s.h, { headRatio: s.headRatio ?? 0.4, headWidth: s.headWidth ?? 0.6, shaftRatio: s.shaftRatio ?? 0.4, tailNotch: s.tailNotch ?? 0, curvature: s.curvature ?? 0, doubleHead: s.doubleHead ?? false }),
    // Arrow params are Inspector-driven (its bbox-fitted, arc-bent geometry has
    // no single well-conditioned handle trajectory across the full straight↔
    // circular range). On-canvas handles are BACKBURNER — the shape still fully
    // shapeshifts and tweens via its param slots.
    modifierPoints: () => [],
  },
  // ── HARDWARE FAMILIES (manifest #56) ────────────────────────────────────────
  // Metal fasteners. Pure vector silhouettes with the chamfers / recesses a metal
  // material's silhouette-SDF shading reads as facets and drive slots; the shadow
  // effects bundle casts the drop shadow. Inspector-driven (no on-canvas handles —
  // the same BACKBURNER stance as ss_arrow; the shapes still fully shapeshift and
  // tween through their param slots).
  {
    type: "ss_bolt", title: "Bolt", icon: "mdi:screw-machine-flat-top", fill: "#b8c0cc",
    defaults: { headWidth: 0.74, headHeight: 0.2, chamfer: 0.24, shankWidth: 0.42, threads: 8, threadDepth: 0.14, washer: false, washerWidth: 0.6, washerHeight: 0.05, w: 120, h: 260 },
    rows: [
      N("headWidth", "Head width", { min: 0, max: 1, help: "Width of the hex head across the flats, as a fraction of the box. 0 is a headless bolt." }),
      N("headHeight", "Head height", { min: 0, max: 0.8, help: "Height of the head as a fraction of the box. 0 collapses the head to a flat line." }),
      N("chamfer", "Head bevel", { min: 0, max: 0.9, help: "Bevels the head's corners — the chamfer of a hex head read side-on. 0 is a plain rectangle head." }),
      N("shankWidth", "Shank width", { min: 0, max: 1, help: "Width of the threaded shank as a fraction of the box. 0 is a hairline shank." }),
      N("threads", "Threads", { min: 0, help: "Number of thread turns down the shank; 0 is a smooth (unthreaded) shank." }),
      N("threadDepth", "Thread depth", { min: 0, max: 0.95, help: "How deep each thread cuts into the shank, as a fraction of its half-width." }),
      BOOL("washer", "Washer", "Inserts a wider washer collar between the head and the shank."),
      N("washerWidth", "Washer width", { min: 0, max: 1, help: "Width of the washer as a fraction of the box (only with Washer on). 0 collapses the washer to nothing." }),
      N("washerHeight", "Washer height", { min: 0, max: 0.3, help: "Thickness of the washer as a fraction of the box (only with Washer on)." }),
    ],
    // Real fastener catalog first (DIN/ISO/ASME proportions — they teach the
    // knobs), then decorative/steampunk extremes. All values within declared ranges.
    presets: [
      { name: "Hex Cap Screw", description: "The everyday machine bolt (DIN 933 / ISO 4017): full thread, forged corner chamfer, no washer.", props: { headWidth: 0.62, headHeight: 0.24, chamfer: 0.18, shankWidth: 0.40, threads: 9, threadDepth: 0.12, washer: false } },
      { name: "Heavy Hex Structural", description: "Oversized heavy-hex head for steel connections (ASTM A325): flat chamfer, thick hardened washer, few coarse threads.", props: { headWidth: 0.78, headHeight: 0.32, chamfer: 0.10, shankWidth: 0.50, threads: 6, threadDepth: 0.08, washer: true, washerWidth: 0.90, washerHeight: 0.09 } },
      { name: "Lag Bolt", description: "Hex-head wood lag (ANSI B18.2.1): thick shank, deep coarse wood-grade threads, utilitarian minimal chamfer.", props: { headWidth: 0.50, headHeight: 0.26, chamfer: 0.05, shankWidth: 0.62, threads: 5, threadDepth: 0.32, washer: false } },
      { name: "Carriage Bolt", description: "Smooth low dome head (DIN 603): no flats, high chamfer rounds the head, smooth shank below.", props: { headWidth: 0.85, headHeight: 0.14, chamfer: 0.75, shankWidth: 0.34, threads: 7, threadDepth: 0.10, washer: false } },
      { name: "Grub / Set Screw", description: "Headless set screw (DIN 916): head collapsed to shank width, fine full-length thread.", props: { headWidth: 0.30, headHeight: 0.06, chamfer: 0.00, shankWidth: 0.30, threads: 14, threadDepth: 0.22, washer: false } },
      { name: "Flange Bolt", description: "Integral serrated flange (DIN 6921): the washer collar spreads to the full head width.", props: { headWidth: 0.68, headHeight: 0.20, chamfer: 0.12, shankWidth: 0.42, threads: 8, threadDepth: 0.12, washer: true, washerWidth: 1.00, washerHeight: 0.05 } },
      { name: "Masonry Wedge Anchor", description: "Thick shank for a drilled hole, few coarse threads, a thick load plate under the head.", props: { headWidth: 0.55, headHeight: 0.30, chamfer: 0.05, shankWidth: 0.70, threads: 4, threadDepth: 0.15, washer: true, washerWidth: 0.85, washerHeight: 0.18 } },
      { name: "UNF Fine-Thread", description: "The Hex Cap's fine-pitch twin: more thread turns down the same length, shallower crests.", props: { headWidth: 0.60, headHeight: 0.22, chamfer: 0.18, shankWidth: 0.38, threads: 16, threadDepth: 0.06, washer: false } },
      { name: "Shoulder Bolt", description: "Precision ground shoulder nearly head-wide, used as a bearing/pivot post; low head, short thread.", props: { headWidth: 0.35, headHeight: 0.35, chamfer: 0.05, shankWidth: 0.85, threads: 3, threadDepth: 0.06, washer: false } },
      { name: "British Coach Bolt", description: "Hybrid of hex and carriage: a shallow dome over faint flats, square washer under the head.", props: { headWidth: 0.70, headHeight: 0.18, chamfer: 0.50, shankWidth: 0.36, threads: 8, threadDepth: 0.12, washer: true, washerWidth: 0.70, washerHeight: 0.06 } },
      { name: "Steampunk Chonker", description: "Oversized head, brutal chamfer, fat washer collar — reads as a boiler-plate rivet.", props: { headWidth: 0.95, headHeight: 0.6, chamfer: 0.85, shankWidth: 0.85, threads: 6, threadDepth: 0.9, washer: true, washerWidth: 1.0, washerHeight: 0.28 } },
      { name: "Hairline Rivet", description: "Minimal: thin head, no chamfer drama, no threads, no washer — nearly a plain peg.", props: { headWidth: 0.3, headHeight: 0.08, chamfer: 0.05, shankWidth: 0.12, threads: 0, threadDepth: 0, washer: false } },
      { name: "Cartoon Stub", description: "Playful stubby fat bolt: enormous soft head, almost no chamfer, shank nearly as wide as the head.", props: { headWidth: 1.0, headHeight: 0.75, chamfer: 0.1, shankWidth: 0.95, threads: 3, threadDepth: 0.3, washer: false } },
      { name: "Cathedral Bolt", description: "Tall chamfered head over a long run of fine Gothic thread ribbing, bold washer beneath.", props: { headWidth: 0.6, headHeight: 0.35, chamfer: 0.6, shankWidth: 0.5, threads: 20, threadDepth: 0.6, washer: true, washerWidth: 0.85, washerHeight: 0.15 } },
      { name: "Geometric Facet", description: "Minimal: max chamfer for crisp flat facets, perfectly smooth shank, no washer.", props: { headWidth: 0.7, headHeight: 0.25, chamfer: 0.9, shankWidth: 0.6, threads: 0, threadDepth: 0, washer: false } },
      { name: "Giant Washer Wheel", description: "The washer dominates: small head, thin shank, washer maxed on both width and height.", props: { headWidth: 0.5, headHeight: 0.15, chamfer: 0.2, shankWidth: 0.3, threads: 5, threadDepth: 0.2, washer: true, washerWidth: 1.0, washerHeight: 0.3 } },
      { name: "Threadstorm", description: "Chunky-thread steampunk: wide shank, maxed thread depth, thirty turns for a corrugated look.", props: { headWidth: 0.4, headHeight: 0.12, chamfer: 0.15, shankWidth: 0.9, threads: 30, threadDepth: 0.95, washer: false } },
      { name: "Poster Bolt", description: "Composition-ready: bold high-contrast proportions that stay legible as a corner accent.", props: { headWidth: 0.85, headHeight: 0.45, chamfer: 0.4, shankWidth: 0.7, threads: 4, threadDepth: 0.5, washer: true, washerWidth: 0.9, washerHeight: 0.1 } },
    ],
    outline: (s) => boltOutline(s.w, s.h, { headWidth: s.headWidth ?? 0.74, headHeight: s.headHeight ?? 0.2, chamfer: s.chamfer ?? 0.24, shankWidth: s.shankWidth ?? 0.42, threads: s.threads ?? 8, threadDepth: s.threadDepth ?? 0.14, washer: s.washer ?? false, washerWidth: s.washerWidth ?? 0.6, washerHeight: s.washerHeight ?? 0.05 }),
    modifierPoints: () => [],
  },
  {
    type: "ss_screw", title: "Screw", icon: "mdi:screw-lag", fill: "#b8c0cc",
    defaults: { headStyle: "flat", headWidth: 0.72, headHeight: 0.16, shankWidth: 0.36, threads: 11, threadDepth: 0.2, taper: 0.5, w: 120, h: 280 },
    rows: [
      SEL("headStyle", "Head style", ["flat", "pan", "round"], { flat: "Flat / countersunk", pan: "Pan", round: "Round / dome" }, "The screw-head profile seen from the side: a countersunk cone, a low pan, or a full dome."),
      N("headWidth", "Head width", { min: 0, max: 1, help: "Width of the head as a fraction of the box. 0 is a headless screw." }),
      N("headHeight", "Head height", { min: 0, max: 0.6, help: "Height of the head as a fraction of the box. 0 collapses the head to a flat line." }),
      N("shankWidth", "Shank width", { min: 0, max: 1, help: "Width of the body at the top, as a fraction of the box. 0 is a hairline body." }),
      N("threads", "Threads", { min: 0, help: "Number of thread turns down the tapered body; 0 is a smooth body." }),
      N("threadDepth", "Thread depth", { min: 0, max: 0.95, help: "How deep each thread cuts, as a fraction of the shank half-width." }),
      N("taper", "Point taper", { min: 0, max: 1, help: "Fraction of the body length over which it narrows to the point: large is a long cone, 0 is a blunt straight body with no point at all." }),
    ],
    presets: [
      { name: "Flat-Head Machine Screw", description: "Flush-seating countersunk cone head (ASME B18.6.3), blunt point for a tapped hole.", props: { headStyle: "flat", headWidth: 0.70, headHeight: 0.22, shankWidth: 0.36, threads: 12, threadDepth: 0.14, taper: 0.15 } },
      { name: "Pan-Head Machine Screw", description: "Low rounded-top pan profile, nearly flat blunt tip.", props: { headStyle: "pan", headWidth: 0.68, headHeight: 0.14, shankWidth: 0.38, threads: 12, threadDepth: 0.14, taper: 0.10 } },
      { name: "Round-Head Wood Screw", description: "Traditional tall domed head, deep coarse wood threads, moderate gimlet point.", props: { headStyle: "round", headWidth: 0.66, headHeight: 0.30, shankWidth: 0.30, threads: 9, threadDepth: 0.28, taper: 0.55 } },
      { name: "Countersunk Wood Screw", description: "Wide flush head over a thin tapered body, aggressive wood thread down a long taper.", props: { headStyle: "flat", headWidth: 0.78, headHeight: 0.20, shankWidth: 0.28, threads: 8, threadDepth: 0.32, taper: 0.70 } },
      { name: "Drywall Screw", description: "Shallow bugle head, thin shank, many fine deep threads, an almost fully self-piercing body.", props: { headStyle: "flat", headWidth: 0.55, headHeight: 0.10, shankWidth: 0.24, threads: 18, threadDepth: 0.40, taper: 0.95 } },
      { name: "Sheet-Metal Screw", description: "Self-tapping, sharp full-length taper for piercing thin metal, low pan head.", props: { headStyle: "pan", headWidth: 0.60, headHeight: 0.15, shankWidth: 0.32, threads: 16, threadDepth: 0.35, taper: 0.90 } },
      { name: "Fine-Thread Machine Screw", description: "Many fine shallow turns, blunt flat tip (machine screws are not pointed).", props: { headStyle: "round", headWidth: 0.50, headHeight: 0.18, shankWidth: 0.26, threads: 20, threadDepth: 0.08, taper: 0.05 } },
      { name: "Deck Screw", description: "Coarse aggressive wood grip with a sharp type-17-style cutting point for pre-drill-free decking.", props: { headStyle: "flat", headWidth: 0.72, headHeight: 0.16, shankWidth: 0.26, threads: 10, threadDepth: 0.38, taper: 0.85 } },
      { name: "Heavy Gimlet Wood Screw", description: "Larger, fewer, coarser threads on a thick body with only a moderate taper.", props: { headStyle: "round", headWidth: 0.60, headHeight: 0.26, shankWidth: 0.42, threads: 6, threadDepth: 0.30, taper: 0.40 } },
      { name: "Self-Drilling Teks", description: "Wide washer-like pan head, essentially untapered blunt tip, fine deep threads.", props: { headStyle: "pan", headWidth: 0.80, headHeight: 0.12, shankWidth: 0.34, threads: 14, threadDepth: 0.30, taper: 0.05 } },
      { name: "Nouveau Dome", description: "Round head blown into a dramatic dome, long slow taper, generous threading.", props: { headStyle: "round", headWidth: 0.9, headHeight: 0.55, shankWidth: 0.5, threads: 18, threadDepth: 0.7, taper: 0.9 } },
      { name: "Steampunk Gimlet", description: "Deep flat countersunk head, thick shank, heavy thread, short sharp gimlet point.", props: { headStyle: "flat", headWidth: 0.95, headHeight: 0.5, shankWidth: 0.8, threads: 8, threadDepth: 0.9, taper: 0.15 } },
      { name: "Whisper Pin", description: "Minimal: tiny pan head, smooth shank, taper maxed to the longest slender spike.", props: { headStyle: "pan", headWidth: 0.25, headHeight: 0.06, shankWidth: 0.15, threads: 0, threadDepth: 0, taper: 1.0 } },
      { name: "Cartoon Lollipop", description: "Huge round head on a stubby fat body, near-zero taper so the point barely exists.", props: { headStyle: "round", headWidth: 1.0, headHeight: 0.6, shankWidth: 0.9, threads: 2, threadDepth: 0.2, taper: 0.05 } },
      { name: "Cathedral Point", description: "Flat head, slender long-tapered body, fine dense threading — a wrought spike.", props: { headStyle: "flat", headWidth: 0.5, headHeight: 0.2, shankWidth: 0.3, threads: 25, threadDepth: 0.5, taper: 1.0 } },
      { name: "Pan Flat Nouveau", description: "Pan head, near-max thread depth for heavy ribbed texture, moderate taper.", props: { headStyle: "pan", headWidth: 0.7, headHeight: 0.3, shankWidth: 0.6, threads: 15, threadDepth: 0.85, taper: 0.6 } },
      { name: "Geometric Countersink", description: "Minimal: flat head, no threads, short blunt taper — a clean cone-and-cylinder.", props: { headStyle: "flat", headWidth: 0.6, headHeight: 0.16, shankWidth: 0.5, threads: 0, threadDepth: 0, taper: 0.1 } },
      { name: "Plaque Screw Bold", description: "Composition-ready: round head, high-contrast proportions sized for a small plaque accent.", props: { headStyle: "round", headWidth: 0.8, headHeight: 0.4, shankWidth: 0.55, threads: 6, threadDepth: 0.4, taper: 0.3 } },
    ],
    outline: (s) => screwOutline(s.w, s.h, { headStyle: s.headStyle ?? "flat", headWidth: s.headWidth ?? 0.72, headHeight: s.headHeight ?? 0.16, shankWidth: s.shankWidth ?? 0.36, threads: s.threads ?? 11, threadDepth: s.threadDepth ?? 0.2, taper: s.taper ?? 0.5 }),
    modifierPoints: () => [],
  },
  {
    type: "ss_screwHead", title: "Screw Head (top)", icon: "mdi:screw-flat-top", fill: "#b8c0cc", fillRule: "evenodd",
    defaults: { drive: "phillips", driveSize: 0.55, barWidth: 0.16, w: 200, h: 200 },
    rows: [
      SEL("drive", "Drive", ["slot", "phillips", "hex", "torx"], { slot: "Slotted", phillips: "Phillips", hex: "Hex socket", torx: "Torx" }, "The drive recess punched into the head, seen from the top: a single slot, a Phillips cross, a hex socket, or a six-lobe Torx."),
      N("driveSize", "Recess size", { min: 0, max: 1, help: "Radius of the drive recess as a fraction of the head radius. 0 is a smooth head with no recess." }),
      N("barWidth", "Bar width", { min: 0, max: 0.9, help: "Width of the slot/cross bar as a fraction of the head radius (ignored for hex/torx). 0 collapses the bar to a hairline." }),
    ],
    // barWidth is omitted on hex/torx presets (the family ignores it there).
    presets: [
      { name: "Slotted", description: "Standard flat-blade drive, the oldest common recess: one wide slot, narrow bar.", props: { drive: "slot", driveSize: 0.70, barWidth: 0.14 } },
      { name: "Phillips #2", description: "The most common cross recess (ANSI B18.6.3 Type I): moderate recess and arm width.", props: { drive: "phillips", driveSize: 0.55, barWidth: 0.22 } },
      { name: "Phillips #0", description: "Small precision/electronics cross: proportionally smaller, finer recess.", props: { drive: "phillips", driveSize: 0.35, barWidth: 0.12 } },
      { name: "Hex Socket (Allen)", description: "Deep wide hex recess for high-torque driving (ISO 4762 socket-head cap screw).", props: { drive: "hex", driveSize: 0.60 } },
      { name: "Security Torx", description: "Tamper-resistant torx (e.g. T15S): a tighter recess than a standard torx of the same head.", props: { drive: "torx", driveSize: 0.30 } },
      { name: "Standard Torx", description: "T25, typical on structural/deck screws: a larger recess sized against cam-out.", props: { drive: "torx", driveSize: 0.62 } },
      { name: "Combo Drive", description: "Phillips/slot combination recess common on appliance screws: wide flat cross arms.", props: { drive: "phillips", driveSize: 0.50, barWidth: 0.30 } },
      { name: "Large Slotted Wood", description: "Traditional heavy wood screw where the slot spans nearly the whole head.", props: { drive: "slot", driveSize: 0.85, barWidth: 0.20 } },
      { name: "Micro Hex Socket", description: "Small set-screw hex (DIN 913/916 grub screws): a small recess relative to head size.", props: { drive: "hex", driveSize: 0.25 } },
      { name: "Deep Impact Hex", description: "Very wide, very deep hex for a bit driver: maximum torque transfer on framing screws.", props: { drive: "hex", driveSize: 0.80 } },
      { name: "Steampunk Slot", description: "A deep, wide slot cut almost across the whole head.", props: { drive: "slot", driveSize: 0.85, barWidth: 0.35 } },
      { name: "Cartoon Hex Face", description: "Hex socket blown up to nearly fill the head — playful oversized proportions.", props: { drive: "hex", driveSize: 0.92 } },
      { name: "Torx Star Burst", description: "A large torx recess for a dramatic six-lobe star.", props: { drive: "torx", driveSize: 0.85 } },
      { name: "Minimal Slot Line", description: "A small, clean, thin single line — the most restrained head in the family.", props: { drive: "slot", driveSize: 0.4, barWidth: 0.06 } },
      { name: "Nouveau Cross", description: "Phillips with wide ornamental bars, reading as a cross-and-circlet motif.", props: { drive: "phillips", driveSize: 0.75, barWidth: 0.5 } },
    ],
    outline: (s) => screwHeadOutline(s.w, s.h, { drive: s.drive ?? "phillips", driveSize: s.driveSize ?? 0.55, barWidth: s.barWidth ?? 0.16 }),
    modifierPoints: () => [],
  },
  // ── VICTORIAN SCROLL-WORK FAMILIES (manifest #57) ───────────────────────────
  // Wrought-iron ornament. Logarithmic-spiral ribbons that read as fence-post /
  // lamp-post curls, generously parameterized (turns, growth, ribbon width, taper,
  // symmetry, stem, volute count). Inspector-driven, like the arrow.
  {
    type: "ss_scroll", title: "Iron Scroll", icon: "mdi:vector-curve", fill: "#3b3b42",
    defaults: { turns: 2.25, growth: 2, ribbonWidth: 0.16, taper: 0.6, w: 200, h: 200 },
    rows: [
      N("turns", "Turns", { min: 0, scrub: 0.02, help: "How many revolutions the scroll coils through. 0 collapses to a point at the eye; more turns wind a tighter eye." }),
      N("growth", "Growth per turn", { min: 1.0001, scrub: 0.02, help: "How fast the coil expands each turn: 1.0001 is nearly a plain circle, larger flares open into a loose volute. Held just above 1 — the underlying log-spiral math is undefined at growth 0 or below." }),
      N("ribbonWidth", "Bar width", { min: 0, max: 0.6, help: "Thickness of the iron bar as a fraction of the coil's outer radius. 0 is a hairline." }),
      N("taper", "Eye taper", { min: 0, max: 1, help: "Narrows the bar toward the eye: 0 is a uniform ribbon, 1 tapers the eye to a point (the classic volute)." }),
    ],
    presets: [
      { name: "Classic Volute", description: "Ionic-volute proportions, the generic Victorian gate scroll: even, moderately tapered coil.", props: { turns: 2.5, growth: 1.7, ribbonWidth: 0.14, taper: 0.85 } },
      { name: "Pig-Tail", description: "Tight small terminal coil at a bar end, a Victorian railing terminator: minimal expansion, fine tip.", props: { turns: 3.2, growth: 1.15, ribbonWidth: 0.10, taper: 0.90 } },
      { name: "Open Gate", description: "Loose large spiral, French Second-Empire gate style: rapid expansion, thick even ribbon.", props: { turns: 1.4, growth: 2.6, ribbonWidth: 0.20, taper: 0.30 } },
      { name: "Gooseneck", description: "A single dominant curl atop a fence post — the generic 'one big curl' motif.", props: { turns: 1.75, growth: 2.0, ribbonWidth: 0.18, taper: 0.60 } },
      { name: "Ram's Horn", description: "Tight inward coil, thick bar — heavy Baroque ironwork.", props: { turns: 2.8, growth: 1.3, ribbonWidth: 0.28, taper: 0.50 } },
      { name: "Rosette", description: "Dense multi-turn coil resembling a rose boss: many tight turns, near-uniform thickness.", props: { turns: 4.0, growth: 1.12, ribbonWidth: 0.22, taper: 0.20 } },
      { name: "Fine Filigree", description: "Delicate decorative infill on lighter Regency railings: very thin bar, strong taper.", props: { turns: 2.0, growth: 1.9, ribbonWidth: 0.05, taper: 0.75 } },
      { name: "Heavy Balustrade", description: "Thick structural scroll on a staircase balustrade: very thick bar, little taper.", props: { turns: 1.9, growth: 2.2, ribbonWidth: 0.40, taper: 0.15 } },
      { name: "Barley-Twist", description: "Slender tight coil evoking a barley-sugar baluster terminal: many tight turns, slim ribbon.", props: { turns: 3.5, growth: 1.25, ribbonWidth: 0.09, taper: 0.40 } },
      { name: "Acanthus Base", description: "Broad thick-based scroll evoking an acanthus-leaf ironwork base: thick ribbon, loose coil.", props: { turns: 1.6, growth: 2.3, ribbonWidth: 0.35, taper: 0.70 } },
      { name: "Nouveau Whip", description: "Many tight turns with strong flare, hairline ribbon tapering to a point — an Art Nouveau whip.", props: { turns: 4.5, growth: 2.8, ribbonWidth: 0.08, taper: 0.9 } },
      { name: "Steampunk Coil", description: "Thick chunky ribbon with an aggressive expansion rate — a coiled boiler spring.", props: { turns: 2, growth: 3.5, ribbonWidth: 0.5, taper: 0.2 } },
      { name: "Hairline Curl", description: "Minimal: a tight single-turn curl, thin delicate ribbon, modest taper.", props: { turns: 0.75, growth: 1.3, ribbonWidth: 0.03, taper: 0.3 } },
      { name: "Cartoon Snail", description: "Playful: fat stubby ribbon coiled tight, uniform — reads like a snail shell.", props: { turns: 1.25, growth: 1.5, ribbonWidth: 0.55, taper: 0 } },
      { name: "Victorian Volute Storm", description: "Extreme ornament: five turns, full taper to a needle point.", props: { turns: 5, growth: 1.6, ribbonWidth: 0.14, taper: 1.0 } },
      { name: "Geometric Spiral", description: "Minimal: one even turn, near-flat growth, uniform ribbon, zero taper — the cleanest scroll.", props: { turns: 1, growth: 1.15, ribbonWidth: 0.2, taper: 0 } },
      { name: "Corner Piece Mini", description: "Composition-ready: few turns, thick bold ribbon, moderate taper — a small corner accent.", props: { turns: 1.5, growth: 2.2, ribbonWidth: 0.4, taper: 0.5 } },
      { name: "Fern Frond", description: "Botanical: many gentle slow-growth turns with a soft taper, more organic than mechanical.", props: { turns: 4, growth: 1.35, ribbonWidth: 0.1, taper: 0.75 } },
    ],
    outline: (s) => scrollOutline(s.w, s.h, { turns: s.turns ?? 2.25, growth: s.growth ?? 2, ribbonWidth: s.ribbonWidth ?? 0.16, taper: s.taper ?? 0.6 }),
    modifierPoints: () => [],
  },
  {
    type: "ss_scrollPair", title: "S / C Scroll", icon: "mdi:vector-bezier", fill: "#3b3b42",
    defaults: { symmetry: "S", stemLength: 1.4, turns: 1.5, growth: 2.1, ribbonWidth: 0.13, taper: 0.55, w: 300, h: 180 },
    rows: [
      SEL("symmetry", "Symmetry", ["S", "C"], { S: "S-scroll (opposite curls)", C: "C-scroll (mirrored curls)" }, "How the two coils relate: an S curls in opposite directions (rotational symmetry); a C curls the same way (mirror symmetry) — the two classic wrought-iron units."),
      N("stemLength", "Stem length", { min: 0, scrub: 0.02, help: "Length of the straight bar joining the two coils, as a multiple of a coil's radius." }),
      N("turns", "Turns", { min: 0, scrub: 0.02, help: "Revolutions in each coil. 0 collapses to a point." }),
      N("growth", "Growth per turn", { min: 1.0001, scrub: 0.02, help: "How fast each coil expands per turn. Held just above 1 — the log-spiral math is undefined at 0 or below." }),
      N("ribbonWidth", "Bar width", { min: 0, max: 0.6, help: "Iron bar thickness as a fraction of a coil's outer radius. 0 is a hairline." }),
      N("taper", "Eye taper", { min: 0, max: 1, help: "Narrows the bar toward each eye (1 tapers to a point)." }),
    ],
    presets: [
      { name: "Classic S-Scroll", description: "The textbook gate-infill 'S' repeat unit (Parisian balcony ironwork): opposite-curl pairing.", props: { symmetry: "S", stemLength: 1.2, turns: 1.6, growth: 2.0, ribbonWidth: 0.14, taper: 0.50 } },
      { name: "Classic C-Scroll", description: "The same proportions mirror-symmetric — the corner/finial pairing.", props: { symmetry: "C", stemLength: 1.2, turns: 1.6, growth: 2.0, ribbonWidth: 0.14, taper: 0.50 } },
      { name: "Long-Stem S", description: "Elongated connecting unit for wide Georgian railing panels: long straight bar, smaller coils.", props: { symmetry: "S", stemLength: 2.8, turns: 1.3, growth: 1.8, ribbonWidth: 0.12, taper: 0.45 } },
      { name: "Tight Double-Volute C", description: "Compact bracket scroll (under a lamp bracket): almost no stem, tight coils.", props: { symmetry: "C", stemLength: 0.4, turns: 2.2, growth: 1.4, ribbonWidth: 0.18, taper: 0.65 } },
      { name: "Baroque Heavy S", description: "Dramatic thick curls, 17th-century French gate ironwork: minimal taper, loose growth.", props: { symmetry: "S", stemLength: 1.0, turns: 1.9, growth: 2.4, ribbonWidth: 0.30, taper: 0.35 } },
      { name: "Delicate Fillet C", description: "Fine light ironwork, Regency balcony railings: thin ribbon, strong taper.", props: { symmetry: "C", stemLength: 1.6, turns: 1.4, growth: 1.9, ribbonWidth: 0.06, taper: 0.70 } },
      { name: "Kissing Scrolls", description: "'Love-knot' style pair where the coils meet directly with no connecting bar.", props: { symmetry: "S", stemLength: 0.05, turns: 1.7, growth: 1.6, ribbonWidth: 0.15, taper: 0.50 } },
      { name: "Grand Entrance C", description: "Large, loose, dramatic double-volute for a grand estate gate: long stem, open coils.", props: { symmetry: "C", stemLength: 2.0, turns: 1.1, growth: 2.8, ribbonWidth: 0.22, taper: 0.25 } },
      { name: "Balcony Rail C", description: "Mid-size mirrored unit meant to tile along a long balcony run: even, repeatable proportions.", props: { symmetry: "C", stemLength: 1.5, turns: 1.5, growth: 1.7, ribbonWidth: 0.11, taper: 0.50 } },
      { name: "Stair Bracket S", description: "Short thick bracket scroll used under stair treads: short stem, thick load-bearing ribbon.", props: { symmetry: "S", stemLength: 0.6, turns: 1.8, growth: 1.6, ribbonWidth: 0.24, taper: 0.40 } },
      { name: "Nouveau S-Whip", description: "S-symmetry, long stem, many turns, strong flare — the most Art Nouveau of the pairs.", props: { symmetry: "S", stemLength: 2.5, turns: 3.5, growth: 2.6, ribbonWidth: 0.09, taper: 0.85 } },
      { name: "Steampunk C-Clamp", description: "Almost no stem, thick chunky ribbon, aggressive growth — a mechanical clamp bracket.", props: { symmetry: "C", stemLength: 0.3, turns: 1.75, growth: 3.2, ribbonWidth: 0.45, taper: 0.15 } },
      { name: "Hairline Bracket", description: "Minimal: short stem, tight turns, thin ribbon — the most restrained pair.", props: { symmetry: "S", stemLength: 0.5, turns: 0.75, growth: 1.25, ribbonWidth: 0.03, taper: 0.2 } },
      { name: "Cartoon Bowtie", description: "Playful: zero stem so the coils touch, fat stubby ribbon, no taper — reads like a bowtie.", props: { symmetry: "C", stemLength: 0, turns: 1.25, growth: 1.6, ribbonWidth: 0.5, taper: 0 } },
      { name: "Victorian Balustrade", description: "Long elegant stem with ornate full taper — the classic fence/balustrade unit.", props: { symmetry: "S", stemLength: 3, turns: 2.25, growth: 1.8, ribbonWidth: 0.12, taper: 0.95 } },
      { name: "Geometric Twin", description: "Minimal: moderate stem, one even turn, uniform ribbon, zero taper.", props: { symmetry: "C", stemLength: 1, turns: 1, growth: 1.15, ribbonWidth: 0.18, taper: 0 } },
      { name: "Plaque Header Bold", description: "Composition-ready: short stem for tight framing, bold thick strokes for small-scale legibility.", props: { symmetry: "S", stemLength: 0.6, turns: 1.5, growth: 2, ribbonWidth: 0.35, taper: 0.5 } },
      { name: "Gate Scroll Grand", description: "Very long stem spanning a wide gap between two loose, large coils — gatework scale.", props: { symmetry: "C", stemLength: 4, turns: 2.5, growth: 2.4, ribbonWidth: 0.15, taper: 0.7 } },
    ],
    outline: (s) => scrollPairOutline(s.w, s.h, { symmetry: s.symmetry ?? "S", stemLength: s.stemLength ?? 1.4, turns: s.turns ?? 1.5, growth: s.growth ?? 2.1, ribbonWidth: s.ribbonWidth ?? 0.13, taper: s.taper ?? 0.55 }),
    modifierPoints: () => [],
  },
  {
    type: "ss_ironFinial", title: "Iron Finial", icon: "mdi:fleur-de-lis", fill: "#3b3b42",
    defaults: { profile: "spear", voluteCount: 2, voluteSize: 0.9, ribbonWidth: 0.16, turns: 1.4, growth: 2.1, taper: 0.6, w: 180, h: 300 },
    rows: [
      SEL("profile", "Profile", ["spear", "fleur"], { spear: "Spear / lance", fleur: "Fleur-de-lis" }, "The central finial blade: a pointed spear head or a fleur-de-lis bud."),
      N("voluteCount", "Volutes per side", { min: 0, help: "Number of scroll volutes flanking each side of the base (mirrored left/right). 0 is a bare blade." }),
      N("voluteSize", "Volute size", { min: 0, max: 2, scrub: 0.02, help: "Size of each flanking volute coil. 0 collapses it to nothing." }),
      N("ribbonWidth", "Volute bar width", { min: 0, max: 0.6, help: "Thickness of the volute iron bar as a fraction of its outer radius. 0 is a hairline." }),
      N("turns", "Volute turns", { min: 0, scrub: 0.02, help: "Revolutions in each flanking volute. 0 collapses to a point." }),
      N("growth", "Volute growth", { min: 1.0001, scrub: 0.02, help: "How fast each flanking volute expands per turn. Held just above 1 — the log-spiral math is undefined at 0 or below." }),
      N("taper", "Volute taper", { min: 0, max: 1, help: "Narrows each volute bar toward its eye." }),
    ],
    // Exactly one bare spear + one bare fleur: with voluteCount 0 the volute knobs
    // do nothing, so extra bare blades would be identical silhouettes.
    presets: [
      { name: "Standard Spear-Point", description: "The common mass-market ornamental fence-picket top: a bare spear blade, no volutes.", props: { profile: "spear", voluteCount: 0, voluteSize: 0.9, ribbonWidth: 0.16, turns: 1.4, growth: 2.1, taper: 0.60 } },
      { name: "Fleur-de-Lis", description: "A classic French-style gate-post cap: a bare fleur bud, no volutes.", props: { profile: "fleur", voluteCount: 0, voluteSize: 0.9, ribbonWidth: 0.16, turns: 1.4, growth: 2.1, taper: 0.60 } },
      { name: "Spear + Double Volutes", description: "The traditional Victorian gate-post finial: a spear blade flanked by one scroll per side.", props: { profile: "spear", voluteCount: 2, voluteSize: 0.85, ribbonWidth: 0.15, turns: 1.5, growth: 2.0, taper: 0.55 } },
      { name: "Fleur + Quad Volutes", description: "An elaborate estate-gate-post finial with four flanking scrolls.", props: { profile: "fleur", voluteCount: 4, voluteSize: 0.70, ribbonWidth: 0.14, turns: 1.3, growth: 1.9, taper: 0.50 } },
      { name: "Heavy Baroque Fleur", description: "A dense ornate gate-pier finial: large volutes, thick bar.", props: { profile: "fleur", voluteCount: 3, voluteSize: 1.15, ribbonWidth: 0.22, turns: 1.5, growth: 1.9, taper: 0.40 } },
      { name: "Single-Volute Cottage", description: "A modest garden-gate spear with one small scroll per side.", props: { profile: "spear", voluteCount: 1, voluteSize: 0.60, ribbonWidth: 0.18, turns: 1.6, growth: 2.3, taper: 0.65 } },
      { name: "Oversized Loose-Volute Fleur", description: "A Second-Empire estate gate-pier finial with large decorative scrolls (volute size near max).", props: { profile: "fleur", voluteCount: 2, voluteSize: 2.00, ribbonWidth: 0.20, turns: 1.1, growth: 2.8, taper: 0.30 } },
      { name: "Twin-Spear Wide Flat Volutes", description: "A garden-trellis finial with broad low flanking scrolls.", props: { profile: "spear", voluteCount: 2, voluteSize: 1.10, ribbonWidth: 0.10, turns: 1.2, growth: 2.5, taper: 0.60 } },
      { name: "Cathedral Spear", description: "Spear blade with large volutes both sides and high taper — the most ecclesiastical finial.", props: { profile: "spear", voluteCount: 2, voluteSize: 1.8, ribbonWidth: 0.1, turns: 2.5, growth: 2.2, taper: 0.9 } },
      { name: "Steampunk Fleur", description: "Fleur with chunky thick volutes, few turns — riveted/mechanical rather than wrought.", props: { profile: "fleur", voluteCount: 2, voluteSize: 1.2, ribbonWidth: 0.5, turns: 1, growth: 1.6, taper: 0.1 } },
      { name: "Cartoon Trefoil", description: "Playful: a fleur with a single fat stubby volute pair, no taper — soft and rounded.", props: { profile: "fleur", voluteCount: 1, voluteSize: 0.6, ribbonWidth: 0.45, turns: 0.75, growth: 1.3, taper: 0 } },
      { name: "Victorian Grand Finial", description: "A spear with four volutes per side — maximal Victorian ornament.", props: { profile: "spear", voluteCount: 4, voluteSize: 1.4, ribbonWidth: 0.12, turns: 3, growth: 1.9, taper: 0.85 } },
      { name: "Corner Fleur Mini", description: "Composition-ready: a fleur with one bold thick volute pair, tuned as a small corner ornament.", props: { profile: "fleur", voluteCount: 1, voluteSize: 1.0, ribbonWidth: 0.4, turns: 1.25, growth: 2, taper: 0.4 } },
      { name: "Hairline Lance", description: "A spear with a single small delicate volute, thin ribbon, tight curls — the most restrained.", props: { profile: "spear", voluteCount: 1, voluteSize: 0.4, ribbonWidth: 0.06, turns: 2, growth: 1.4, taper: 0.3 } },
      { name: "Fleur Royale", description: "A fleur with three volutes per side, loose flowing growth and ornate taper — the most opulent.", props: { profile: "fleur", voluteCount: 3, voluteSize: 1.6, ribbonWidth: 0.14, turns: 1.8, growth: 2.5, taper: 0.75 } },
    ],
    outline: (s) => ironFinialOutline(s.w, s.h, { profile: s.profile ?? "spear", voluteCount: s.voluteCount ?? 2, voluteSize: s.voluteSize ?? 0.9, ribbonWidth: s.ribbonWidth ?? 0.16, turns: s.turns ?? 1.4, growth: s.growth ?? 2.1, taper: s.taper ?? 0.6 }),
    modifierPoints: () => [],
  },
];

/**
 * Near-pure function (constructs a plugin object; no I/O). Builds ONE standard
 * bbox plugin from a family descriptor. The plugin is bbox-resizable, effects-
 * complete, hit-tested by even-odd containment of the family outline, and
 * exposes the family's yellow handles. `emit` renders the family's outline as
 * the ONE `path` IR op (fill/stroke/fillRule/opacity), wrapped in the shared
 * effects bundle — identical machinery to shape.js.
 *
 * @example makeFamilyPlugin(FAMILIES[0]).type // "ss_radialSweep"
 * @example makeFamilyPlugin(FAMILIES[0]).emit({w: 100, h: 100, inner: 0.5, startAngle: 0, sweep: 360, fill: "#fff", strokeWidth: 0}, null, {x: 0, y: 0, rotation: 0, scale: 1})[0].op // "path"
 */
export function makeFamilyPlugin(fam) {
  const plugin = {
    type: fam.type,
    title: fam.title,
    // Declared ONCE for the whole family, in the factory that mints them: a
    // shapeshifter is parametric vector geometry with no cheap tier and no async
    // source, so it is correct on its first frame. Putting it here rather than on
    // each FAMILIES entry means a family added tomorrow inherits the right answer
    // instead of being caught by the registration gate.
    ephemeral: EPHEMERAL.NONE,
    // IT IS A SHAPE, AND IT SAYS SO ITSELF (core/registry.js INSERT_MENUS). The
    // Add Shape grid used to be defined as "the shapeshifter families", so this
    // line changes nothing about which families appear — what it changes is that
    // the menu now asks the widget rather than the module, which is what lets a
    // standalone shape plugin join without being a family.
    insertMenu: "shape",
    // A family declares no `commands` of its own (see the note where this factory
    // returns), so web/App.svelte SYNTHESIZES its insert entry — which needs a
    // glyph, and the glyph is the family's. `icon` is only meaningful on a plugin
    // whose insert command is synthesized; every widget that writes its own
    // command puts the icon there instead.
    icon: fam.icon,
    // THE TILE. Optional everywhere: a shape that cannot draw its own silhouette
    // gets its command's icon in the grid instead, which is how `aperture` and
    // `iris_blades` join without owning a path generator. Taking it from the
    // PLUGIN rather than from FAMILIES is the whole point — the picker asks the
    // widget, so a future non-family shape can answer too.
    shapePreview: (dim) => ({
      d: subpathsPathD(fam.outline({ ...fam.defaults, w: dim, h: dim })),
      fillRule: fam.fillRule ?? "nonzero",
    }),
    // GEOMETRY PRESETS (the presets mantra, manifest item 70): a family may
    // declare `presets: [{name, description, props}]` — passed through so
    // core/registry.presetFamiliesOf surfaces them in the Tools pane exactly
    // like any hand-written plugin's. Families without presets are untouched.
    ...(fam.presets ? { presets: fam.presets } : {}),
    capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
    defaults: {
      type: fam.type, x: 120, y: 120, w: 200, h: 200, z: 0, rotation: 0, scale: 1,
      rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
      fill: fam.fill ?? "#7dcfff", stroke: "#000000", strokeWidth: 2,
      ...defaults("opacity"),
      ...bundleNestedDefaults("effects"),
      ...fam.defaults,
    },
    inspector: [
      ...bundle("transform"),
      ...fam.rows,
      ...props("fill", "stroke", "strokeWidth"),
      // THE UNIVERSAL STROKE ROWS (Tier C adoption — this widget always HAD
      // render support at the ports seam; it just never declared the rows, which
      // is why a gear with a texture-brush stroke showed no phase knobs).
      // STROKE_SPACE_KEYS is here for the SAME reason and arrived late: the
      // screen-space flag is stamped onto every stroked op at the ports seam
      // (applyStrokeSpace), so all 19 families rendered it correctly and none of
      // them offered the checkbox — the feature existed and was unreachable.
      // It travels with the other two; a widget carrying one list and not the
      // others is the drift tests/shapeshifter-paint_fix_test.js now pins. Row
      // order follows the two bundles and the four widgets fixed before this
      // one: the flag modifies strokeWidth, declared on the line above.
      ...props(...STROKE_SPACE_KEYS, ...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
      ...props("opacity"),
      ...bundle("effects"),
    ],
    /** Pure function. State → display-list: the family outline as ONE path op,
     * effects-wrapped (all-off = pass-through). Zero-size widget emits nothing. */
    emit(s, _targetWorldIR, world) {
      if ((s.w ?? 0) <= 0 || (s.h ?? 0) <= 0) return [];
      const d = subpathsPathD(fam.outline(s));
      return applyEffects([path({
        d, fill: s.fill,
        stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
        strokeWidth: s.strokeWidth ?? 0,
        fillRule: fam.fillRule ?? "nonzero",
        opacity: s.opacity ?? 1,
      })], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
    },
    /**
     * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths`
     * protocol) — this family's silhouette as cubic contours in box space, so a
     * keyframed `type` change flows into another shape instead of snapping.
     *
     * ONE DECLARATION COVERS EVERY FAMILY, which is the point of it living in the
     * factory: each family already computes its exact silhouette to DRAW and to
     * HIT-TEST itself (`fam.outline`), so the morph reads that same outline and a
     * family added tomorrow is morphable the day it is written, with no line here
     * changing. It is also why the multi-contour families work for free — a gear
     * with a hole and an evenodd frame both hand over their subpaths, and the
     * engine pairs contour to contour.
     */
    morphPaths(s) {
      if ((s.w ?? 0) <= 0 || (s.h ?? 0) <= 0) return { space: { w: 0, h: 0 }, subpaths: [], fillRule: fam.fillRule ?? "nonzero" };
      return morphPayloadFromPaths(
        [{ d: subpathsPathD(fam.outline(s)), paint: statePaint(s) }],
        { w: s.w ?? 0, h: s.h ?? 0 },
        fam.fillRule ?? "nonzero",
      );
    },
    /** Pure function. Why this shape cannot morph YET, or null — a degenerate box
     * has no silhouette to hand over, and an empty payload would pair a real
     * contour against nothing. The mermaid/iconify shatterNotReady precedent. */
    morphNotReady(s) {
      return (s.w ?? 0) > 0 && (s.h ?? 0) > 0 ? null : "a shape with a non-zero width and height (this one is collapsed)";
    },
    cullMargin: effectsCullMargin,
    hitTest(s, lx, ly) {
      if ((s.w ?? 0) <= 0 || (s.h ?? 0) <= 0) return false;
      return pointInOutlines(fam.outline(s), lx, ly);
    },
    anchors: standardBBoxAnchors,
    // THE RIM IS THE INK, not the box around it. This used to be
    // closestPointOnRoundedRect(w, h, 0, …) — the bounding box — which returns
    // the SAME answer for a diamond as for the rectangle around it, so an arrow
    // bound with `closest` met a 200x120 diamond at (200, 0): an empty corner.
    // The family already computes its exact silhouette to draw and to hit-test
    // itself, so the rim is that same outline read through the general
    // closest-point map. Every family is fixed by this one line and so is the
    // next one added, because nothing here names a shape.
    //
    // The `cm` fallback is the box centre: a family whose params collapse it to
    // no geometry at all has no rim to answer with, and the centre is the point
    // every other consumer of a degenerate box already uses.
    closestAnchor(state, wx, wy, world) {
      const local = T.apply(T.invert(world), wx, wy);
      const centre = { x: (state.w ?? 0) / 2, y: (state.h ?? 0) / 2 };
      return closestPointOnOutlines(fam.outline(state), local.x, local.y, centre);
    },
    // The family's OWN parametric handles, and ONLY those. The gradient beads are
    // appended AFTER them by core/derive.js nodeModifierPoints, for every
    // paint-capable widget rather than only the ones that remembered to spread —
    // see core/paint_handles.js.
    // Spread CONDITIONALLY so a family with no handles leaves the key ABSENT
    // rather than present-and-undefined: `pointListEditable` and the crosshair
    // gesture both probe `typeof plugin.modifierPoints === "function"`, and an
    // absent key is the shape every other handle-free plugin has.
    ...(fam.modifierPoints ? { modifierPoints: (s) => fam.modifierPoints(s) } : {}),
  };
  // No per-family top-level command: the `add-ss_*` ids are surfaced ONLY as
  // children of the single `insert-shape` submenu, which web/App.svelte
  // SYNTHESIZES for every registered plugin that declares `insertMenu: "shape"`
  // and no insert command of its own. Re-adding a `plugin.commands` here would
  // register each id twice (top-level AND submenu child) and registerFlat throws
  // on a duplicate — which is also exactly why a plugin that DOES write its own
  // add command (aperture, iris_blades) keeps it top-level and is only added to
  // the GRID: one action, one id, one home.
  return plugin;
}

/** The registered shapeshifter plugins (one per family), for plugins/index.js. */
export const shapeshifterPlugins = FAMILIES.map(makeFamilyPlugin);
