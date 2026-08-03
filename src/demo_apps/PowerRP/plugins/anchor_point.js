/**
 * Anchor Point widget — manifest Round 10 "ANCHOR WIDGET": "a widget that does
 * NOTHING but own one draggable anchor — an invisible, movable reference point
 * other equations can target." It renders no fill of its own (emit() → []); its
 * whole purpose is to be a NAMED point on the canvas that equations point at
 * (`my_anchor.pt.x`, or an arrow endpoint dropped on its anchor).
 *
 * GHOST (manifest ARCHITECTURE PLAN #2 / Round 10): it has no rendered volume,
 * so it is a ghost (capabilities.ghost) — the editor draws its thin phantom
 * outline so it stays selectable, exactly like a crop box (core/derive.isGhost
 * Node; the crop box is the always-visible precedent this follows). Its single
 * anchor `pt` sits at the widget's CENTER and is what other equations reference
 * and what the anchor-toggle X/# glyph decorates.
 *
 * WHY A (SMALL) BBOX rather than a pure point: the widget reuses ALL the
 * standard machinery unchanged — body-drag translation (capabilities.transform
 * moves x/y), a grabbable hit target, the ghost-outline overlay, and the
 * standard anchor pipeline (derive.nodeAnchors wraps its `pt` through
 * worldTransform). A pure-point widget would need bespoke selection/drag code in
 * CanvasView (a different fence); a tiny bbox lets the point BE a first-class
 * draggable/referencable widget with zero core changes. The box is a GRAB
 * target only — it is never painted (emit() returns nothing), so it stays
 * "invisible" per the spec while remaining easy to grab.
 *
 * The default size is the standard anchor-glyph grab box; there is no linked
 * precedent for a widget's default grab size, so ANCHOR_GRAB_W/H are flagged
 * PENDING USER RATIFICATION (arbitrary-constants rule).
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";

// The default grab-box size for a new anchor point. No numeric precedent exists
// elsewhere for a widget's grab size (the resize-handle screen sizes live in
// CanvasView, in SCREEN px, not world units), so this is flagged PENDING USER
// RATIFICATION. 20 world units reads as a small, easy-to-hit target at the
// default zoom without visually dominating; the point of interest is the CENTER
// anchor, not the box.
const ANCHOR_GRAB_W = 20;
const ANCHOR_GRAB_H = 20;

export const anchorPointPlugin = {
  type: "anchor_point",
  ephemeral: EPHEMERAL.NONE,
  title: "Anchor Point",
  // ghost:true → no rendered volume (isGhostNode), so its phantom outline is
  // drawn for selection like a crop box. transform → body-drag moves x/y.
  // NOT resizable — its size is just the grab box, not a meaningful property.
  capabilities: { bbox: true, transform: true, resizable: false, backdrop: false, ghost: true },
  defaults: {
    type: "anchor_point", x: 300, y: 300, w: ANCHOR_GRAB_W, h: ANCHOR_GRAB_H, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about its own center (an equation — manifest Round 11),
    // same default as every transform widget; a lone point barely rotates, but
    // keeping the equation keeps the widget contract uniform.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    opacity: 1,
  },
  // Only the position is meaningful; x/y group into transform. No fill/stroke
  // rows — the widget paints nothing.
  inspector: [
    { key: "x", label: "X", kind: "number", category: "transform" },
    { key: "y", label: "Y", kind: "number", category: "transform" },
    { key: "z", label: "Z order", kind: "number", category: "transform" },
  ],
  /** Pure function. Paints NOTHING — the widget is an invisible reference point. */
  emit() {
    return [];
  },
  // The one referencable anchor: `pt` at the widget's center (its "position").
  // Also expose the standard bbox anchors so it composes with everything (arrow
  // drops, snap features) — but `pt` is the canonical name equations target.
  anchors(state) {
    const w = state.w ?? 0, h = state.h ?? 0;
    return [{ id: "pt", x: w / 2, y: h / 2 }, ...standardBBoxAnchors(state)];
  },
  commands: [
    { id: "add-anchor-point", title: "Add Anchor Point", icon: "mdi:vector-point", run: (app) => app.addItem(anchorPointPlugin.defaults) },
  ],
};
