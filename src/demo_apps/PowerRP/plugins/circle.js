/**
 * Ellipse/circle widget. Its "closest" computed anchor is the requirements'
 * showcase case: an arrow bound to {item, anchor: "closest"} touches the
 * perimeter at the point nearest the arrow's other end (exact for circles,
 * radial approximation for ellipses).
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { paintModifierPoints } from "../core/paint_handles.js";
import { bundle, bundleNestedDefaults, defaults, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS } from "../core/properties.js";
import * as T from "../core/transform.js";
import { ellipse } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

// A circle has NO geometry knob — its shape is w/h, which a preset may not write —
// so everything below is about the OUTLINE: how much of it there is, and how much
// of it is drawn. Two families, because the key sets are disjoint and the two
// genuinely COMPOSE (tests/tool_groups_test.js enforces the disjointness): pick a
// heavy unfilled ring, then pick a three-quarter arc, and you get a heavy
// three-quarter arc. That composition is the reason for the split, not a side
// effect of it — and it is load-bearing for the arc family, whose presets are
// nearly invisible on the shipped 2-unit stroke over a filled disc.
const RING_FILL = "#f7768e";       // this widget's OWN default fill (see below)
const NO_FILL = "#00000000";       // the house transparent-fill spelling (plugins/cropbox.js:45)

// RING WEIGHT — the fill-and-weight of the outline, FULL over both its keys.
// A filled row must restore `fill` and an outline row must clear it, or an overlay
// leaves the previous hover's fill behind; so both keys appear in all five.
//
// THE ONE PAINT WRITE IN THIS FILE, flagged deliberately: the filled rows write
// this widget's OWN DEFAULT `#f7768e` rather than a chosen colour. Under an overlay
// there is no other way back from transparent, and the default is the least
// opinionated value available.
//
// A SIXTH ROW WAS CUT. "Outlined Disc" (`#f7768e` at strokeWidth 2) is exactly the
// widget's default and renders byte-identically to an untouched circle — measured
// 0.0000 whole-frame. Ledger C-16 prefers moving the default to keep a sourced
// preset, but nothing here is sourced: the row was a restatement of the default,
// so the row goes.
//
// strokeWidth is in ABSOLUTE canvas units, so these are calibrated to this widget's
// own 140-unit default diameter: 1 is a hairline, 6 reads across a room, 18 is a
// band about an eighth of the radius.
const RING_PRESETS = [
  { name: "Solid Dot", description: "A filled disc with the outline switched off — a bullet, a graph node, a plotted point.", props: { fill: RING_FILL, strokeWidth: 0 } },
  { name: "Hairline Ring", description: "No fill at all and the finest line the stroke will draw: an outline circle rather than a shape.", props: { fill: NO_FILL, strokeWidth: 1 } },
  { name: "Ring", description: "An unfilled circle at a weight that still reads at presentation size.", props: { fill: NO_FILL, strokeWidth: 6 } },
  { name: "Heavy Ring", description: "A thick unfilled annulus, the band about an eighth of the radius — and the right base to cut an arc out of.", props: { fill: NO_FILL, strokeWidth: 18 } },
  { name: "Filled Ring", description: "Filled and heavily outlined at once: the centre of a target rather than a ring around nothing.", props: { fill: RING_FILL, strokeWidth: 18 } },
];

// ARC — the STROKE-TRIM window and its two free ends, FULL over all five keys.
//
// WHY THIS FAMILY EXISTS AT ALL: the trim vocabulary turns a circle into a
// different object — a progress indicator, a spinner, a draw-on — and nothing in
// the UI hints at it. The rows were only recently declared on this widget (see the
// inspector comment below) and a hover-preview list is the one surface that can
// teach them. They are applied at the UNIVERSAL PORTS SEAM
// (render_gpu/ports.js:475 applyStrokeTrim), not in emit() below, which is why a
// bare emit() test shows no trim and the family's probe must call that seam.
//
// EVERY ROW SPELLS OUT ALL FIVE, phase and both caps included, so no pick inherits
// the previous hover's round ends or its rotation.
//
// NO "Full Ring" RESET ROW. An untrimmed circle is what absent trim keys already
// mean, so such a row renders byte-identically to the untouched widget — measured
// 0.000. The way back from a trimmed circle is the Inspector, or undo.
const ARC_PRESETS = [
  { name: "Three-Quarter Arc", description: "Three quarters of the way round with rounded ends — a progress indicator caught at seventy-five percent.", props: { strokeStart: 0, strokeEnd: 0.75, strokePhase: 0, strokeCapStart: "round", strokeCapEnd: "round" } },
  { name: "Half Arc", description: "A semicircular sweep, rounded at both ends.", props: { strokeStart: 0, strokeEnd: 0.5, strokePhase: 0, strokeCapStart: "round", strokeCapEnd: "round" } },
  { name: "Quarter Arc", description: "A single quadrant: a corner sweep, or the first step of a dial.", props: { strokeStart: 0, strokeEnd: 0.25, strokePhase: 0, strokeCapStart: "round", strokeCapEnd: "round" } },
  { name: "Spinner", description: "A short arc floating clear of the start — the travelling segment of a loading spinner.", props: { strokeStart: 0.1, strokeEnd: 0.35, strokePhase: 0, strokeCapStart: "round", strokeCapEnd: "round" } },
  { name: "Tapered Comet", description: "An arc that narrows to nothing at its leading end, the way a lifted brush does.", props: { strokeStart: 0, strokeEnd: 0.6, strokePhase: 0, strokeCapStart: "round", strokeCapEnd: "taper" } },
  { name: "Broken Ring", description: "A ring left open by a hairline gap — closed enough to read as a ring, open enough to show it is cut.", props: { strokeStart: 0.03, strokeEnd: 0.97, strokePhase: 0, strokeCapStart: "flat", strokeCapEnd: "flat" } },
  { name: "Turned Arc", description: "The same three-quarter sweep started a quarter turn along the outline, so the gap faces a different way.", props: { strokeStart: 0, strokeEnd: 0.75, strokePhase: 90, strokeCapStart: "round", strokeCapEnd: "round" } },
];

export const circlePlugin = {
  type: "circle",
  ephemeral: EPHEMERAL.NONE,
  title: "Circle",
  presetFamilies: [
    { id: "ring", title: "Ring weight", presets: RING_PRESETS },
    { id: "arc", title: "Arc", presets: ARC_PRESETS },
  ],
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "circle", x: 200, y: 200, w: 140, h: 140, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#f7768e", stroke: "#000000", strokeWidth: 2,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  // Rows COMPOSE from the SHARED PROPERTY REGISTRY: positioning + fill/stroke/
  // strokeWidth + opacity. NO cornerRadius — an ellipse has no square corners to
  // round (that's why circle composes the individual fill/stroke/strokeWidth
  // props, not the whole strokedBox bundle). strokeWidth default 2 (a visible
  // 2px border) overrides the registry's 0.
  inspector: [
    ...bundle("positioning"),
    ...props("fill", "stroke", "strokeWidth"),
    // THE UNIVERSAL STROKE-TRIM ROWS (Tier C adoption — this widget always HAD
    // render support at the ports seam; it just never declared the rows, which
    // is why a gear with a texture-brush stroke showed no phase/draw-on knobs).
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /** Pure function. State → display-list commands (local space) — THE render
   * API. Effects (shadow/bloom/blend — the shared EFFECTS BUNDLE,
   * render_gpu/effects.js) wrap the emitted ops; all-off = pass-through. */
  emit(s, _targetWorldIR, world) {
    return applyEffects([ellipse({
      cx: s.w / 2, cy: s.h / 2, rx: s.w / 2, ry: s.h / 2,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  hitTest(s, lx, ly) {
    const nx = (lx - s.w / 2) / (s.w / 2), ny = (ly - s.h / 2) / (s.h / 2);
    return nx * nx + ny * ny <= 1;
  },
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    // Radial point on the ellipse toward the target (exact when w === h).
    const local = T.apply(T.invert(world), wx, wy);
    const rx = state.w / 2, ry = state.h / 2;
    const theta = Math.atan2((local.y - ry) / ry, (local.x - rx) / rx);
    return { x: rx + rx * Math.cos(theta), y: ry + ry * Math.sin(theta) };
  },
  // GRADIENT HANDLES (core/paint_handles.js): center/direction beads for a
  // gradient FILL; none for a solid/material fill (byte-identical otherwise).
  modifierPoints: (s) => paintModifierPoints(s, "fill"),
  commands: [
    { id: "add-circle", title: "Add Circle", icon: "mdi:circle-outline", run: (app) => app.armCrosshairPlacement(circlePlugin) }, // crosshair bbox placement (manifest UNDEFERRAL SWEEP: crosshair placement for ALL Add buttons)
  ],
};
