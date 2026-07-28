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

import { standardBBoxAnchors } from "../core/derive.js";
import { paintModifierPoints } from "../core/paint_handles.js";
import { bundle, bundleNestedDefaults, defaults, props, STROKE_TRIM_KEYS } from "../core/properties.js";
import * as T from "../core/transform.js";
import {
  ringSectorOutline, polygonStarOutline, cornerRectOutline, quadWedgeOutline,
  crossPlusOutline, frameOutline, gearOutline, calloutOutline, bannerOutline,
  bracketOutline, arrowOutline, pointInOutlines, closestPointOnRoundedRect,
  closestPointOnSegment, closestPointOnAxisRange,
  boltOutline, screwOutline, screwHeadOutline,
  scrollOutline, scrollPairOutline, ironFinialOutline,
} from "../core/outline.js";
import { subpathsPathD } from "../core/shapes.js";
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
      N("armThickness", "Arm thickness", { min: 0.05, max: 1, help: "How thick the arms are as a fraction of the box. Small is a thin plus, large a chunky cross. Drag the inner-corner handle." }),
      N("armLengthRatio", "Vertical length", { min: 0, max: 1, help: "Shortens the vertical arm: 1 is a symmetric Greek cross, lower makes a squat plus. Drag the top handle." }),
      N("cornerRadius", "Corner radius", { min: 0, max: 0.5, help: "Rounds the twelve corners by this fraction of half the shorter side." }),
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
      const t = clamp(s.armThickness, 0.02, 1), half = t / 2;
      const x2 = (0.5 + half) * s.w, y1 = (0.5 - half) * s.h;
      const lr = clamp(s.armLengthRatio, 0, 1), top = (1 - lr) * (0.5 - half) * s.h;
      const [LO, HI] = [0.05, 1]; // the bounds the `armThickness` DRAG has always written within
      // The x-fraction that reads back as the stored thickness, so a box with no width
      // (nothing to take a fraction of) leaves the value exactly where it was.
      const heldFraction = (st) => 0.5 + clamp(st.armThickness, LO, HI) / 2;
      const thicknessAt = (st, x) => clamp(2 * ratioOf(x, st.w, heldFraction(st)) - 1, LO, HI);
      // The vertical arm's available room: zero when the arms already fill the box
      // (armThickness 1), which is a single-point allowed set — the handle cannot move.
      const roomOf = (st) => (0.5 - clamp(st.armThickness, 0.02, 1) / 2) * st.h;
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
      N("innerRatio", "Root radius", { min: 0.05, max: 0.98, help: "How deep the valleys between teeth cut in, as a fraction of the outer radius. Drag the root handle." }),
      N("toothWidth", "Tooth width", { min: 0.02, max: 0.98, help: "Angular width of each tooth top as a fraction of the pitch: near 0 becomes a spiky starburst, near 1 the teeth merge. Drag the tooth handle." }),
      N("holeRatio", "Center hole", { min: 0, max: 0.9, help: "Radius of a hole through the center as a fraction of the outer radius. 0 is solid." }),
    ],
    outline: (s) => gearOutline(s.w, s.h, { teeth: s.teeth ?? 8, innerRatio: s.innerRatio ?? 0.7, toothWidth: s.toothWidth ?? 0.5, holeRatio: s.holeRatio ?? 0 }),
    // innerRatio rides the RADIAL SEGMENT straight up (t ∈ [0.05, 0.98]). toothWidth
    // rides the RIM, but its reading is the ABSOLUTE angular gap from 12 o'clock, so —
    // like the fancy arrow's half-widths — it MIRRORS a point on the far side onto the
    // one side the handle is drawn (a tooth is symmetric about its centre line): an
    // idempotent retraction, not the metric nearest point.
    modifierPoints(s) {
      const TOOTH_TOP = -Math.PI / 2; // the reference tooth is centred at 12 o'clock
      const g = ellipseGeom(s);
      const root = clamp(s.innerRatio, 0.05, 0.98);
      const tw = clamp(s.toothWidth, 0.02, 0.98);
      const pitchOf = (st) => (2 * Math.PI) / Math.max(3, Math.round(st.teeth ?? 8));
      // Half the tooth top's angular width, from an angle on the rim.
      const halfTopAt = (st, a) => {
        const pitch = pitchOf(st);
        return clamp((2 * Math.min(Math.abs(TOOTH_TOP - a), pitch / 2)) / pitch, 0.02, 0.98) * pitch / 2;
      };
      const halfTop = (tw * pitchOf(s)) / 2;
      return [
        {
          id: "innerRatio", x: g.cx + g.rx * root * Math.cos(TOOTH_TOP), y: g.cy + g.ry * root * Math.sin(TOOTH_TOP),
          constrain: (st, pt) => radialConstrain(ellipseGeom(st), TOOTH_TOP, pt, 0.05, 0.98),
          apply: (st, pt) => {
            const gg = ellipseGeom(st);
            return { innerRatio: readOrKeep(gg, () => radialT(gg, pt.x, pt.y, TOOTH_TOP), clamp(st.innerRatio, 0.05, 0.98)) };
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
            return { toothWidth: readOrKeep(gg, () => (2 * halfTopAt(st, angleAt(gg, pt.x, pt.y))) / pitchOf(st), clamp(st.toothWidth, 0.02, 0.98)) };
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
      N("tailWidth", "Tail width", { min: 0.02, max: 0.9, help: "How wide the tail's base is as a fraction of the body width. Thin is a pointer, wide is a speech-bubble beak." }),
    ],
    outline: (s) => calloutOutline(s.w, s.h, { cornerRadius: s.cornerRadius ?? 0.2, tailX: s.tailX, tailY: s.tailY, tailWidth: s.tailWidth ?? 0.22 }),
    // The tail tip goes ANYWHERE (a speech bubble may point off its own box), so this
    // handle declares NO `constrain`: the identity default is the truthful statement.
    modifierPoints(s) {
      return [{ id: "tail", x: s.tailX ?? s.w * 0.25, y: s.tailY ?? s.h, apply: (_st, pt) => ({ tailX: pt.x, tailY: pt.y }) }];
    },
  },
  {
    type: "ss_banner", title: "Banner / Ribbon", icon: "mdi:flag-outline", fill: "#bb9af7",
    defaults: { endStyle: "forked", notchDepth: 0.15 },
    rows: [
      SEL("endStyle", "End style", ["flat", "forked"], { flat: "Flat", forked: "Forked" }, "The banner's ends: flat cuts them straight, forked cuts a chevron notch into each end (a ribbon)."),
      N("notchDepth", "Notch depth", { help: "How deep the forked notch cuts in, as a fraction of the width; a negative value forks the ends outward instead, and past ~0.5 the chevrons cross into a bowtie. Drag the notch handle." }),
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
    defaults: { thickness: 0.22, w: 90, h: 220 },
    rows: [
      N("thickness", "Thickness", { min: 0.02, max: 0.9, help: "Width of the bracket's bar and arms as a fraction of the width. Drag the inner handle. Rotate the widget to orient the bracket." }),
    ],
    outline: (s) => bracketOutline(s.w, s.h, { thickness: s.thickness ?? 0.2 }),
    // The bar's inner edge, on the bracket's horizontal midline: a horizontal SEGMENT
    // spanning the thickness bounds — the plain metric projection.
    modifierPoints(s) {
      const [LO, HI] = [0.02, 0.9]; // the `thickness` row's declared bounds
      return [{
        id: "thickness", x: clamp(s.thickness, LO, HI) * s.w, y: s.h / 2,
        constrain: (st, pt) => closestPointOnSegment({ x: LO * st.w, y: st.h / 2 }, { x: HI * st.w, y: st.h / 2 }, pt),
        apply: (st, pt) => ({ thickness: ratioOf(pt.x, st.w, clamp(st.thickness, LO, HI)) }),
      }];
    },
  },
  {
    type: "ss_arrow", title: "Arrow", icon: "mdi:arrow-right-thick", fill: "#f7768e",
    defaults: { headRatio: 0.4, headWidth: 0.6, shaftRatio: 0.4, tailNotch: 0, curvature: 0, doubleHead: false },
    rows: [
      N("headRatio", "Head length", { min: 0.05, max: 0.95, help: "How much of the arrow's length is the head, as a fraction. Small is a long shaft, large is mostly arrowhead (→ a pentagon at 1 with no shaft)." }),
      N("headWidth", "Head width", { min: 0.05, max: 1, help: "How wide the arrowhead's barbs are as a fraction of the length." }),
      N("shaftRatio", "Shaft thickness", { min: 0.05, max: 1, help: "Shaft thickness as a fraction of the head width. Thin is a slender arrow, near 1 fills the head." }),
      N("tailNotch", "Tail notch", { min: 0, max: 0.9, help: "Cuts a chevron notch into the flat tail: 0 is a flat back, higher turns the tail into a chevron / striped arrow." }),
      N("curvature", "Curvature", { min: 0, scrub: 0.01, help: "Bends the arrow along an arc: 0 is straight, higher curves it, near 1 wraps it into a near-circular arrow, and beyond 1 keeps winding it tighter into overlapping loops (no upper cap)." }),
      BOOL("doubleHead", "Double head", "Adds a second arrowhead at the tail (a double-headed arrow)."),
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
      N("headWidth", "Head width", { min: 0.1, max: 1, help: "Width of the hex head across the flats, as a fraction of the box." }),
      N("headHeight", "Head height", { min: 0.05, max: 0.8, help: "Height of the head as a fraction of the box." }),
      N("chamfer", "Head bevel", { min: 0, max: 0.9, help: "Bevels the head's corners — the chamfer of a hex head read side-on. 0 is a plain rectangle head." }),
      N("shankWidth", "Shank width", { min: 0.05, max: 1, help: "Width of the threaded shank as a fraction of the box." }),
      N("threads", "Threads", { min: 0, help: "Number of thread turns down the shank; 0 is a smooth (unthreaded) shank." }),
      N("threadDepth", "Thread depth", { min: 0, max: 0.95, help: "How deep each thread cuts into the shank, as a fraction of its half-width." }),
      BOOL("washer", "Washer", "Inserts a wider washer collar between the head and the shank."),
      N("washerWidth", "Washer width", { min: 0.1, max: 1, help: "Width of the washer as a fraction of the box (only with Washer on)." }),
      N("washerHeight", "Washer height", { min: 0, max: 0.3, help: "Thickness of the washer as a fraction of the box (only with Washer on)." }),
    ],
    outline: (s) => boltOutline(s.w, s.h, { headWidth: s.headWidth ?? 0.74, headHeight: s.headHeight ?? 0.2, chamfer: s.chamfer ?? 0.24, shankWidth: s.shankWidth ?? 0.42, threads: s.threads ?? 8, threadDepth: s.threadDepth ?? 0.14, washer: s.washer ?? false, washerWidth: s.washerWidth ?? 0.6, washerHeight: s.washerHeight ?? 0.05 }),
    modifierPoints: () => [],
  },
  {
    type: "ss_screw", title: "Screw", icon: "mdi:screw-lag", fill: "#b8c0cc",
    defaults: { headStyle: "flat", headWidth: 0.72, headHeight: 0.16, shankWidth: 0.36, threads: 11, threadDepth: 0.2, taper: 0.5, w: 120, h: 280 },
    rows: [
      SEL("headStyle", "Head style", ["flat", "pan", "round"], { flat: "Flat / countersunk", pan: "Pan", round: "Round / dome" }, "The screw-head profile seen from the side: a countersunk cone, a low pan, or a full dome."),
      N("headWidth", "Head width", { min: 0.1, max: 1, help: "Width of the head as a fraction of the box." }),
      N("headHeight", "Head height", { min: 0.05, max: 0.6, help: "Height of the head as a fraction of the box." }),
      N("shankWidth", "Shank width", { min: 0.05, max: 1, help: "Width of the body at the top, as a fraction of the box." }),
      N("threads", "Threads", { min: 0, help: "Number of thread turns down the tapered body; 0 is a smooth body." }),
      N("threadDepth", "Thread depth", { min: 0, max: 0.95, help: "How deep each thread cuts, as a fraction of the shank half-width." }),
      N("taper", "Point taper", { min: 0.05, max: 1, help: "Fraction of the body length over which it narrows to the point: large is a long cone, small is a straight body with a short gimlet point." }),
    ],
    outline: (s) => screwOutline(s.w, s.h, { headStyle: s.headStyle ?? "flat", headWidth: s.headWidth ?? 0.72, headHeight: s.headHeight ?? 0.16, shankWidth: s.shankWidth ?? 0.36, threads: s.threads ?? 11, threadDepth: s.threadDepth ?? 0.2, taper: s.taper ?? 0.5 }),
    modifierPoints: () => [],
  },
  {
    type: "ss_screwHead", title: "Screw Head (top)", icon: "mdi:screw-flat-top", fill: "#b8c0cc", fillRule: "evenodd",
    defaults: { drive: "phillips", driveSize: 0.55, barWidth: 0.16, w: 200, h: 200 },
    rows: [
      SEL("drive", "Drive", ["slot", "phillips", "hex", "torx"], { slot: "Slotted", phillips: "Phillips", hex: "Hex socket", torx: "Torx" }, "The drive recess punched into the head, seen from the top: a single slot, a Phillips cross, a hex socket, or a six-lobe Torx."),
      N("driveSize", "Recess size", { min: 0.05, max: 0.95, help: "Radius of the drive recess as a fraction of the head radius." }),
      N("barWidth", "Bar width", { min: 0.02, max: 0.9, help: "Width of the slot/cross bar as a fraction of the head radius (ignored for hex/torx)." }),
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
      N("turns", "Turns", { min: 0.25, scrub: 0.02, help: "How many revolutions the scroll coils through. More turns wind a tighter eye." }),
      N("growth", "Growth per turn", { min: 1.1, scrub: 0.02, help: "How fast the coil expands each turn: near 1 is a tight even coil, larger flares open into a loose volute." }),
      N("ribbonWidth", "Bar width", { min: 0.02, max: 0.6, help: "Thickness of the iron bar as a fraction of the coil's outer radius." }),
      N("taper", "Eye taper", { min: 0, max: 1, help: "Narrows the bar toward the eye: 0 is a uniform ribbon, 1 tapers the eye to a point (the classic volute)." }),
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
      N("turns", "Turns", { min: 0.25, scrub: 0.02, help: "Revolutions in each coil." }),
      N("growth", "Growth per turn", { min: 1.1, scrub: 0.02, help: "How fast each coil expands per turn." }),
      N("ribbonWidth", "Bar width", { min: 0.02, max: 0.6, help: "Iron bar thickness as a fraction of a coil's outer radius." }),
      N("taper", "Eye taper", { min: 0, max: 1, help: "Narrows the bar toward each eye (1 tapers to a point)." }),
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
      N("voluteSize", "Volute size", { min: 0.1, max: 2, scrub: 0.02, help: "Size of each flanking volute coil." }),
      N("ribbonWidth", "Volute bar width", { min: 0.02, max: 0.6, help: "Thickness of the volute iron bar as a fraction of its outer radius." }),
      N("turns", "Volute turns", { min: 0.25, scrub: 0.02, help: "Revolutions in each flanking volute." }),
      N("growth", "Volute growth", { min: 1.1, scrub: 0.02, help: "How fast each flanking volute expands per turn." }),
      N("taper", "Volute taper", { min: 0, max: 1, help: "Narrows each volute bar toward its eye." }),
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
      ...bundle("positioning"),
      ...fam.rows,
      ...props("fill", "stroke", "strokeWidth"),
      // THE UNIVERSAL STROKE-TRIM ROWS (Tier C adoption — this widget always
      // HAD render support at the ports seam; it just never declared the rows,
      // which is why a gear with a texture-brush stroke showed no phase knobs).
      ...props(...STROKE_TRIM_KEYS),
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
    cullMargin: effectsCullMargin,
    hitTest(s, lx, ly) {
      if ((s.w ?? 0) <= 0 || (s.h ?? 0) <= 0) return false;
      return pointInOutlines(fam.outline(s), lx, ly);
    },
    anchors: standardBBoxAnchors,
    closestAnchor(state, wx, wy, world) {
      const local = T.apply(T.invert(world), wx, wy);
      return closestPointOnRoundedRect(state.w ?? 0, state.h ?? 0, 0, local.x, local.y);
    },
    // The family's OWN parametric handles, PLUS the gradient FILL beads
    // (core/paint_handles.js) when the fill is a gradient — additive, the
    // "fill-grad-*" ids never collide with a family's handle ids. A solid/material
    // fill contributes none, so a non-gradient shapeshifter is byte-identical.
    modifierPoints: (s) => [...(fam.modifierPoints?.(s) ?? []), ...paintModifierPoints(s, "fill")],
  };
  // No per-family top-level command: the `add-ss_*` ids are surfaced ONLY as
  // children of the single `insert-shape` submenu (web/App.svelte), built from
  // FAMILIES — one source of truth for both the palette and the toolbar
  // ShapePicker. Re-adding a `plugin.commands` here would register each id
  // twice (top-level AND submenu child) and registerFlat throws on a duplicate.
  return plugin;
}

/** The registered shapeshifter plugins (one per family), for plugins/index.js. */
export const shapeshifterPlugins = FAMILIES.map(makeFamilyPlugin);
