/**
 * Demo Showcase — the reference DEMO WIDGET (manifest glossary "Demo widget").
 * It lives under plugins/demo/ (the showcase folder, kept out of the core
 * roster) and exists to prove ONE thing end to end: the CUSTOM per-widget
 * property mechanism ("self.*", Blender-style — core/properties.js customProps).
 *
 * It is otherwise a plain filled+stroked bbox box (composed exactly like
 * plugins/rect.js from the shared property registry), PLUS one custom property
 * it declares itself: `inset`. `inset` (canvas units) drives a second, inner
 * outline drawn `inset` in from every edge — so a declared custom prop visibly
 * affects the render. Because its default is a NUMBER it is fully equation-
 * capable: editable as a literal, as a bare arithmetic expression, or as a
 * universal `= …` equation, and referenceable from this widget's other
 * equations as `self.inset` — all through the EXISTING evaluation path
 * (core/expressions.evaluateState), with no engine changes.
 *
 * Surfaced ONLY through the "Insert Demo Widget" command-palette submenu
 * (web/App.svelte) — deliberately NO top-level `commands`, so the core palette
 * stays clean (the manifest's demo-widget organization intent).
 *
 * DOM-free / bare-node-safe at import time (mirrors rect.js's import set), so
 * plugins/index.js stays importable under `node tests/core_test.js`.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, bundleNestedDefaults, customProps, defaults, props } from "../../core/properties.js";
import { rect } from "../../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";

// The custom self.* property this demo widget declares — the whole point of the
// showcase. ONE number knob, `inset`, in the Inspector's "Custom" region.
const INSET_DEFAULT = 18; // canvas units the inner outline sits in from each edge — a visibly non-zero default gap
const CUSTOM = customProps([
  {
    name: "inset",
    kind: "number",
    default: INSET_DEFAULT,
    min: 0,
    help: "A CUSTOM self.* property this demo widget declares. Draws a second outline this many canvas units inside the box; edit it as a number or a `= self.w / 4`-style equation, and reference it elsewhere as self.inset.",
  },
]);

export const demoShowcasePlugin = {
  type: "demo_showcase",
  title: "Demo Showcase",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // Composes from the SHARED PROPERTY REGISTRY exactly as rect does (positioning
  // + full strokedBox + opacity + effects), then adds its OWN declared custom
  // prop's default. strokeWidth 2 (a visible border by default, rect's precedent)
  // so the inner inset outline shows out of the box.
  defaults: {
    type: "demo_showcase", x: 140, y: 140, w: 240, h: 160, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#9ece6a", stroke: "#1a1a2e", strokeWidth: 2,
    ...defaults("cornerRadius", "opacity"), // cornerRadius:0, opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
    ...CUSTOM.defaults, // inset — the custom self.* prop
  },
  inspector: [
    ...bundle("positioning"),
    ...bundle("strokedBox"),
    ...props("opacity"),
    ...CUSTOM.rows, // the custom self.* prop row (Inspector "Custom" category)
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (local space) — THE render API.
   * Draws the outer filled+stroked box, then (the custom prop in action) an inner
   * outline inset by `inset` on every edge when it still encloses a positive area
   * (an inset past the halfway point would invert the box, so it is skipped).
   * Effects (the shared bundle) wrap the emitted ops; all-off = pass-through.
   */
  emit(s, _targetWorldIR, world) {
    const inset = Math.max(0, s.inset ?? 0);
    const strokeW = s.strokeWidth ?? 0;
    const stroke = strokeW > 0 ? s.stroke : null;
    const cornerRadius = s.cornerRadius ?? 0;
    const opacity = s.opacity ?? 1;
    const ops = [rect({
      x: 0, y: 0, w: s.w, h: s.h,
      cornerRadius, fill: s.fill,
      stroke, strokeWidth: strokeW, opacity,
    })];
    const innerW = s.w - inset * 2, innerH = s.h - inset * 2;
    if (inset > 0 && innerW > 0 && innerH > 0) {
      ops.push(rect({
        x: inset, y: inset, w: innerW, h: innerH,
        // The inner corner arc shrinks with the inset (a concentric round rect).
        cornerRadius: Math.max(0, cornerRadius - inset),
        fill: null, stroke, strokeWidth: strokeW, opacity,
      }));
    }
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  // NO top-level `commands`: this widget is reachable ONLY via the "Insert Demo
  // Widget" submenu (web/App.svelte), keeping the core command palette clean.
};
