/**
 * Crop box widget — manifest ARCHITECTURE PLAN #3. A box (x/y/w/h/cornerRadius/
 * stroke/strokeWidth/fill — the same shape as rect.js, sharing its geometry/
 * outline substrate so future box features apply automatically) that CROPS
 * exactly one target item's rendering to its rounded-rect region: fill
 * (background, painted first), the target's subtree clipped to the region,
 * then the border on top. It does NOT parent or transform the target — the
 * target keeps its own world transform; the crop box only clips+repositions
 * its VISUAL OUTPUT into the crop region (core/derive.resolveCropTargets +
 * render_gpu/ports.sceneIR do the cross-node composition; this file only
 * owns the box's own visual properties, per the fence).
 *
 * `target` is ONE itemId (a `select` row over the document's items — the
 * picker-style dropdown; simplified from a list by the user: "if you want,
 * you can put a group inside there" is future work, not v1). A crop box
 * whose target is absent/dangling/another crop box renders only its
 * fill+border (core/derive already reportOnce's the console note); it is
 * ALWAYS a ghost (core/derive.isGhostNode), so its phantom outline stays
 * selectable either way.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRoundedRect } from "../core/outline.js";
import { bundle, defaults, props } from "../core/properties.js";
import * as T from "../core/transform.js";
import { cropSubtree } from "../render_gpu/ir.js";

export const cropboxPlugin = {
  type: "cropbox",
  title: "Crop Box",
  // ghost: true is redundant with core/derive.isGhostNode's `type === "cropbox"`
  // special case (a crop box is ALWAYS a ghost, unconditionally) but declared
  // here too so the capability is discoverable from the plugin definition
  // alone, matching the registry doc's "capabilities... never on type" spirit.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false, ghost: true },
  // defaults + rows COMPOSE from the SHARED PROPERTY REGISTRY (core/properties.js):
  // the crop box IS a filled+stroked box (it shares rect's box shape), so it
  // composes positioning + the full strokedBox bundle + opacity, PLUS its own
  // `target` picker. strokeWidth default 2 (visible border, its long-standing
  // default) overrides the registry's 0; fill defaults to fully-transparent
  // (#00000000 — a crop box shows its target through, no background by default).
  defaults: {
    type: "cropbox", x: 100, y: 100, w: 240, h: 140, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    target: null, fill: "#00000000", stroke: "#000000", strokeWidth: 2,
    ...defaults("cornerRadius", "opacity"), // cornerRadius:0, opacity:1
  },
  // ID-VALUED STATE PATHS (core/document.js clonedItemStates): `target` holds a
  // raw itemId, NOT an equation, so the token rewriter that reroutes `@id`
  // references when a selection is cloned cannot see it. Same declarative seam
  // as `legacyKeys`; it must list every `optionsFrom: "items"` row's key (the
  // Inspector picker below is the OTHER face of the same fact — the drift is
  // guarded in tests/multipaste_test.js).
  itemRefs: [["target"]],
  inspector: [
    ...bundle("positioning"),
    // `options`/`optionLabels` are populated PER-DOCUMENT by the Inspector at
    // render time (transitions.js `curve` select precedent) — a plugin's static
    // inspector array has no document to enumerate. See web/Inspector.svelte's
    // cropTargetOptions seam. Plugin-specific row (not in the shared registry —
    // it's unique to the crop box).
    { key: "target", label: "Target", kind: "select", optionsFrom: "items", options: [], category: "crop", help: "The item this crop box clips to its region. Everything of the target outside the box is hidden; the target itself doesn't move." },
    ...bundle("strokedBox"),
    ...props("opacity"),
  ],
  /**
   * Pure function. State → display-list commands (local space). `targetWorldIR`
   * (sceneIR's extra argument — every other plugin ignores it) is the target's
   * OWN emit() output, wrapped in a pushTransform/popTransform pair carrying
   * the target's ABSOLUTE world transform (not relative to this box — see
   * ports.sceneIR's doc comment for why); absent (dangling/no target) means
   * "clip nothing" — the box still paints its fill/border, matching a plain
   * empty box.
   */
  emit(s, targetWorldIR) {
    return [cropSubtree({
      x: 0, y: 0, w: s.w, h: s.h,
      cornerRadius: s.cornerRadius ?? 0,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
      content: targetWorldIR ?? [],
    })];
  },
  // The corner anchors slide onto a rounded rim — THE INK RULE, applied to every
  // widget with a rim at registration (core/derive.js withInkAnchors) through
  // the closestAnchor below. This file used to carry its own copy of it; rect
  // and codeblock carried the same five lines.
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRoundedRect(state.w ?? 0, state.h ?? 0, state.cornerRadius ?? 0, local.x, local.y);
  },
  commands: [
    { id: "add-cropbox", title: "Add Crop Box", icon: "mdi:crop", run: (app) => app.armCrosshairPlacement(cropboxPlugin) }, // crosshair bbox placement (manifest UNDEFERRAL SWEEP)
  ],
};
