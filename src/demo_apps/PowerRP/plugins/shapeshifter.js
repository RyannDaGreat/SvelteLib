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
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import {
  ringSectorOutline, polygonStarOutline, cornerRectOutline, quadWedgeOutline,
  crossPlusOutline, frameOutline, gearOutline, calloutOutline, bannerOutline,
  bracketOutline, arrowOutline, pointInOutlines, closestPointOnRoundedRect,
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
    modifierPoints(s) {
      const g = ellipseGeom(s);
      const a0 = (s.startAngle ?? -90) * DEG, a1 = a0 + (s.sweep ?? 360) * DEG;
      const inner = clamp(s.inner, 0, 1);
      return [
        { id: "inner", x: g.cx + g.rx * inner * Math.cos(a0), y: g.cy + g.ry * inner * Math.sin(a0), apply(st, p) { const gg = ellipseGeom(st); return { inner: clamp(radialT(gg, p.x, p.y, (st.startAngle ?? -90) * DEG), 0, 1) }; } },
        { id: "start", x: g.cx + g.rx * Math.cos(a0), y: g.cy + g.ry * Math.sin(a0), apply(st, p) { const gg = ellipseGeom(st); return { startAngle: angleAt(gg, p.x, p.y) / DEG }; } },
        { id: "end", x: g.cx + g.rx * Math.cos(a1), y: g.cy + g.ry * Math.sin(a1), apply(st, p) { const gg = ellipseGeom(st); let sw = ((angleAt(gg, p.x, p.y) / DEG - (st.startAngle ?? -90)) % 360 + 360) % 360; return { sweep: sw < 1 ? 360 : sw }; } },
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
    modifierPoints(s) {
      const g = ellipseGeom(s);
      const p = Math.max(2, Math.round(s.points ?? 5));
      const inner = clamp(s.innerRatio, 0, 1);
      const start = -Math.PI / 2 + (s.startAngle ?? 0) * DEG;
      const innerA = start + Math.PI / p, countA = start + (2 * Math.PI) / p;
      return [
        { id: "innerRatio", x: g.cx + g.rx * inner * Math.cos(innerA), y: g.cy + g.ry * inner * Math.sin(innerA), apply(st, pt) { const gg = ellipseGeom(st); const pp = Math.max(2, Math.round(st.points ?? 5)); const a = -Math.PI / 2 + (st.startAngle ?? 0) * DEG + Math.PI / pp; return { innerRatio: clamp(radialT(gg, pt.x, pt.y, a), 0, 1) }; } },
        { id: "points", x: g.cx + g.rx * Math.cos(countA), y: g.cy + g.ry * Math.sin(countA), apply(st, pt) { const gg = ellipseGeom(st); const s0 = -Math.PI / 2 + (st.startAngle ?? 0) * DEG; let da = (angleAt(gg, pt.x, pt.y) - s0) % (2 * Math.PI); da = (da + 2 * Math.PI) % (2 * Math.PI); if (da < 1e-3) da = 1e-3; return { points: Math.max(3, Math.round((2 * Math.PI) / da)) }; } },
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
    modifierPoints(s) {
      const box = [[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]];
      const keys = ["r0", "r1", "r2", "r3"];
      const maxR = Math.min(s.w, s.h) / 2;
      return box.map((v, i) => {
        const next = box[(i + 1) % 4];
        const dx = next[0] - v[0], dy = next[1] - v[1], len = Math.hypot(dx, dy) || 1;
        const rr = clamp(s[keys[i]], 0, 1) * maxR;
        return {
          id: keys[i], x: v[0] + (dx / len) * rr, y: v[1] + (dy / len) * rr,
          apply(st, pt) {
            const bx = [[0, 0], [st.w, 0], [st.w, st.h], [0, st.h]];
            const vv = bx[i], nx = bx[(i + 1) % 4];
            const ddx = nx[0] - vv[0], ddy = nx[1] - vv[1], l = Math.hypot(ddx, ddy) || 1;
            const t = ((pt.x - vv[0]) * ddx + (pt.y - vv[1]) * ddy) / l;
            return { [keys[i]]: clamp(t / (Math.min(st.w, st.h) / 2), 0, 1) };
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
      N("shear", "Shear", { help: "Slants the top edge sideways to make a parallelogram, as a fraction of the width. 0 is upright; magnitudes past 1 lean the top beyond the base." }),
      N("topOffset", "Top offset", { help: "Shifts the top edge's center sideways for a right-trapezoid or keystone, as a fraction of the width; values past 1 push the top clear of the base." }),
      N("cornerRadius", "Corner radius", { min: 0, max: 0.5, help: "Rounds all four corners by this fraction of half the shorter side." }),
    ],
    outline: (s) => quadWedgeOutline(s.w, s.h, { taper: s.taper ?? 1, shear: s.shear ?? 0, topOffset: s.topOffset ?? 0, cornerRadius: s.cornerRadius ?? 0 }),
    modifierPoints(s) {
      const topW = Math.max(0, s.taper ?? 1) * s.w;
      const cxTop = s.w / 2 + (s.topOffset ?? 0) * s.w + (s.shear ?? 0) * s.w;
      return [
        { id: "taper", x: cxTop + topW / 2, y: 0, apply(st, pt) { const base = st.w / 2 + ((st.topOffset ?? 0) + (st.shear ?? 0)) * st.w; return { taper: Math.max(0, (2 * (pt.x - base)) / st.w) }; } },
        { id: "shear", x: cxTop, y: 0, apply(st, pt) { const off = st.w / 2 + (st.topOffset ?? 0) * st.w; return { shear: (pt.x - off) / st.w }; } },
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
    modifierPoints(s) {
      const t = clamp(s.armThickness, 0.02, 1), half = t / 2;
      const x2 = (0.5 + half) * s.w, y1 = (0.5 - half) * s.h;
      const lr = clamp(s.armLengthRatio, 0, 1), top = (1 - lr) * (0.5 - half) * s.h;
      return [
        { id: "armThickness", x: x2, y: y1, apply(st, pt) { return { armThickness: clamp(2 * (pt.x / st.w - 0.5), 0.05, 1) }; } },
        { id: "armLengthRatio", x: s.w / 2, y: top, apply(st, pt) { const h2 = clamp(st.armThickness, 0.02, 1) / 2; const denom = (0.5 - h2) * st.h || 1; return { armLengthRatio: clamp(1 - pt.y / denom, 0, 1) }; } },
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
    modifierPoints(s) {
      const b = clamp(s.thickness, 0, 0.5) * Math.min(s.w, s.h);
      return [{ id: "thickness", x: b, y: b, apply(st, pt) { return { thickness: clamp(pt.x / (Math.min(st.w, st.h) || 1), 0, 0.5) }; } }];
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
    modifierPoints(s) {
      const g = ellipseGeom(s);
      const root = clamp(s.innerRatio, 0.05, 0.98);
      const tw = clamp(s.toothWidth, 0.02, 0.98);
      const N_ = Math.max(3, Math.round(s.teeth ?? 8));
      const halfTop = (tw * (2 * Math.PI / N_)) / 2, c0 = -Math.PI / 2;
      return [
        { id: "innerRatio", x: g.cx + g.rx * root * Math.cos(c0), y: g.cy + g.ry * root * Math.sin(c0), apply(st, pt) { const gg = ellipseGeom(st); return { innerRatio: clamp(radialT(gg, pt.x, pt.y, -Math.PI / 2), 0.05, 0.98) }; } },
        { id: "toothWidth", x: g.cx + g.rx * Math.cos(c0 - halfTop), y: g.cy + g.ry * Math.sin(c0 - halfTop), apply(st, pt) { const gg = ellipseGeom(st); const nn = Math.max(3, Math.round(st.teeth ?? 8)); const pitch = 2 * Math.PI / nn; const da = Math.min(Math.abs(-Math.PI / 2 - angleAt(gg, pt.x, pt.y)), pitch / 2); return { toothWidth: clamp((2 * da) / pitch, 0.02, 0.98) }; } },
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
    modifierPoints(s) {
      return [{ id: "tail", x: s.tailX ?? s.w * 0.25, y: s.tailY ?? s.h, apply(_st, pt) { return { tailX: pt.x, tailY: pt.y }; } }];
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
    modifierPoints(s) {
      if ((s.endStyle ?? "forked") !== "forked") return [];
      const nd = (s.notchDepth ?? 0.15) * s.w;
      return [{ id: "notchDepth", x: s.w - nd, y: s.h / 2, apply(st, pt) { return { notchDepth: (st.w - pt.x) / st.w }; } }];
    },
  },
  {
    type: "ss_bracket", title: "Bracket", icon: "mdi:code-brackets", fill: "#9ece6a",
    defaults: { thickness: 0.22, w: 90, h: 220 },
    rows: [
      N("thickness", "Thickness", { min: 0.02, max: 0.9, help: "Width of the bracket's bar and arms as a fraction of the width. Drag the inner handle. Rotate the widget to orient the bracket." }),
    ],
    outline: (s) => bracketOutline(s.w, s.h, { thickness: s.thickness ?? 0.2 }),
    modifierPoints(s) {
      const t = clamp(s.thickness, 0.02, 0.9) * s.w;
      return [{ id: "thickness", x: t, y: s.h / 2, apply(st, pt) { return { thickness: clamp(pt.x / (st.w || 1), 0.02, 0.9) }; } }];
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
      N("curvature", "Curvature", { min: 0, help: "Bends the arrow along an arc: 0 is straight, higher curves it, near 1 wraps it into a near-circular arrow, and beyond 1 keeps winding it tighter into overlapping loops (no upper cap)." }),
      BOOL("doubleHead", "Double head", "Adds a second arrowhead at the tail (a double-headed arrow)."),
    ],
    outline: (s) => arrowOutline(s.w, s.h, { headRatio: s.headRatio ?? 0.4, headWidth: s.headWidth ?? 0.6, shaftRatio: s.shaftRatio ?? 0.4, tailNotch: s.tailNotch ?? 0, curvature: s.curvature ?? 0, doubleHead: s.doubleHead ?? false }),
    // Arrow params are Inspector-driven (its bbox-fitted, arc-bent geometry has
    // no single well-conditioned handle trajectory across the full straight↔
    // circular range). On-canvas handles are BACKBURNER — the shape still fully
    // shapeshifts and tweens via its param slots.
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
    modifierPoints: fam.modifierPoints,
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
