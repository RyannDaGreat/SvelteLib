/**
 * THE FROZEN LEGACY SHAPE WIDGET. A bbox widget whose render is ONE `path` IR op:
 * the preset generator (core/shapes.js) turns the widget's {shape, w, h, points,
 * innerRatio} into an SVG path `d` in bbox-local space, which paint_skia
 * rasterizes and svg_backend/pdf_backend export as real vector. Shadow / glow /
 * border ride the SHARED effects bundle exactly like rect, so all 17 presets are
 * shadow/bloom/blend-complete.
 *
 * ── RETIRED, NOT REMOVED ──────────────────────────────────────────────────────
 * This widget is NO LONGER INSERTABLE. The shapeshifter families
 * (plugins/shapeshifter.js) subsume every silhouette here and are genuinely
 * parametric, whereas 15 of these 17 presets IGNORE the shapePoints /
 * shapeInnerRatio knobs they advertise — an octagon at points 8 and points 5 is
 * byte-identical — and none has an on-canvas handle. That mismatch between what
 * the Inspector offered and what the geometry did is the defect the consolidation
 * closes, so `commands` is empty and web/ShapePicker.svelte no longer lists these
 * presets.
 *
 * It stays REGISTERED and byte-for-byte unchanged because OLD DECKS KEEP THEIR
 * INK: a document written before the split still carries `type: "shape"` items,
 * and those are entitled to draw exactly what they always drew. Stored documents
 * are NOT rewritten and these items are NOT re-rendered through a near-equivalent
 * family. tests/shape_legacy_freeze_test.js pins every preset's path bytes and
 * asserts the not-insertable half in the same file.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRoundedRect } from "../core/outline.js";
import { bundle, bundleNestedDefaults, defaults, props, STROKE_TRIM_KEYS, STROKE_JOIN_KEYS } from "../core/properties.js";
import { shapePath } from "../core/shapes.js";
import { morphPayloadFromPaths, statePaint } from "../core/morph_payload.js";
import * as T from "../core/transform.js";
import { path } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

export const shapePlugin = {
  type: "shape",
  ephemeral: EPHEMERAL.NONE,
  title: "Shape",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // Composes the SHARED PROPERTY REGISTRY like rect/circle: transform + the
  // shape selector/knobs + fill/stroke/strokeWidth (NO cornerRadius — a path has
  // no square corners to round) + opacity + the effects bundle. strokeWidth
  // default 2 (a visible border); shape default "star".
  defaults: {
    type: "shape", x: 100, y: 100, w: 200, h: 200, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (the shared
    // equation — manifest Round 11). Absent on old docs → derive falls to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    fill: "#bb9af7", stroke: "#000000", strokeWidth: 2,
    shape: "star", shapePoints: 5, shapeInnerRatio: 0.5,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  // Shape selector + knobs FIRST (the widget's identity), then the paint props.
  inspector: [
    ...bundle("transform"),
    ...bundle("shape"),
    ...props("fill", "stroke", "strokeWidth"),
    // THE UNIVERSAL STROKE-TRIM ROWS (Tier C adoption — this widget always HAD
    // render support at the ports seam; it just never declared the rows, which
    // is why a gear with a texture-brush stroke showed no phase/draw-on knobs).
    ...props(...STROKE_TRIM_KEYS, ...STROKE_JOIN_KEYS),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /** Pure function. State → display-list commands (local space) — THE render
   * API. The preset generator makes the path `d` for the widget's bbox; effects
   * (the shared EFFECTS BUNDLE) wrap the single path op, all-off = pass-through. */
  emit(s, _targetWorldIR, world) {
    const d = shapePath(s.shape ?? "star", s.w ?? 0, s.h ?? 0, {
      points: s.shapePoints,
      innerRatio: s.shapeInnerRatio,
    });
    return applyEffects([path({
      d,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity: s.opacity ?? 1,
    })], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * the preset's silhouette as cubic contours, read from the SAME `shapePath`
   * generator emit() draws with — so a frozen legacy shape morphs to exactly the
   * ink it renders, and this widget's freeze is not broken by giving it one.
   *
   * DECLARING IT ON A RETIRED WIDGET IS DELIBERATE. Old decks keep their `type:
   * "shape"` items and are entitled to every general feature that arrives later;
   * a retired widget is one nothing new can be CREATED as, not one that stops
   * gaining capabilities. The path bytes are untouched, so
   * tests/shape_legacy_freeze_test.js still pins what it always pinned.
   */
  morphPaths(s) {
    return morphPayloadFromPaths(
      [{ d: shapePath(s.shape ?? "star", s.w ?? 0, s.h ?? 0, { points: s.shapePoints, innerRatio: s.shapeInnerRatio }), paint: statePaint(s) }],
      { w: s.w ?? 0, h: s.h ?? 0 },
    );
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  // Anchors sit on the bbox rim (the shared standard anchors) — a shape's tight
  // silhouette varies per preset, so binding arrows to the bounding rim is the
  // sensible, predictable target (same choice circle makes for its bbox).
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    // Closest point on the bbox border (cornerRadius 0), like a plain rect.
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRoundedRect(state.w ?? 0, state.h ?? 0, 0, local.x, local.y);
  },
  // NO COMMANDS — this widget is RETIRED, not removed. It declares no Add entry,
  // so nothing in the palette, the toolbar or a keybinding can create a new one;
  // `insert-shape` (the shapeshifter families) is the only way to add a shape.
  // Everything above stays exactly as it was so a document that already contains
  // a `type: "shape"` item keeps loading, rendering, hit-testing and exporting
  // unchanged — see this file's header and tests/shape_legacy_freeze_test.js.
  commands: [],
};
