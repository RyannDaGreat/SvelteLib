/**
 * The RENDER half of the shared EFFECTS BUNDLE (manifest Round 12D: drop
 * shadow + bloom + blend mode — "ALL FOUR reuse one substrate ... the EFFECTS
 * BUNDLE joins the property registry; any widget composes it"). The property
 * half lives in core/properties.js (the `effects` bundle: shadow.{dx,dy,blur,
 * color,opacity}, bloom.{radius,strength}, blendMode); THIS module gives
 * every composing widget the matching render composition — one shared
 * function each plugin's emit() calls, exactly like decorate.js's
 * decorateStrokedBox (the stroked-box bundle's render half, the direct
 * precedent for this module's shape).
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────────
 * Given a widget's OWN content ops plus its (evaluated) state, it returns the
 * content wrapped in ONE `effectSubtree` op (render_gpu/ir.js) when any
 * effect is ON, and returns the content UNCHANGED when none is. "None" =
 * shadow blur <= 0 AND bloom strength <= 0 AND blendMode normal (the manifest
 * defaults: "Defaults = effect-off ... so every old doc is byte-identical").
 * The pass-through path is what makes an effectless widget render
 * byte-identically to before this bundle existed — the same discipline as
 * decorate.js's isUndecorated.
 *
 * The substrate itself (ONE offscreen render of the widget, then shadow /
 * widget / bloom composites under the chosen blend) is implemented by each
 * backend: gpu/compositor.js's "effect" batch (render-to-texture + blur +
 * fixed-function blend pipelines), pdf_backend.js's emitEffect (the HYBRID
 * RULE: raster shadow PNG under vector content; bloom / non-normal blends
 * raster the widget region), svg_backend.js (raster region).
 *
 * ── WHICH WIDGETS COMPOSE THIS (and which are EXCLUDED, loudly) ───────────────
 * COMPOSED by every DRAWN widget: rect, circle, text, image, video,
 * filmstrip, donut, arrow, elbow_arrow, curved_arrow, fancy_arrow (and any
 * future drawn widget — compose the bundle, never re-implement).
 * EXCLUDED, deliberately (manifest Round 12D "justify any exclusion loudly"):
 *   - magnifier + blur: BACKDROP SAMPLERS (capabilities.backdrop). They have
 *     no self-silhouette to shadow or bloom — their pixels ARE the scene
 *     below them — and re-rendering "the widget alone" to a texture is
 *     ill-defined for an op whose content is everything beneath it.
 *   - cropbox + group: GHOSTS (capabilities.ghost). No rendered volume of
 *     their own — a crop box is a clip region (its TARGET can carry effects;
 *     they ride into the crop content), a group renders nothing.
 *   - camera: the view/background definition, not a drawn widget.
 *
 * ── ORDER vs decorateStrokedBox ───────────────────────────────────────────────
 * Effects wrap OUTSIDE the stroked-box decoration:
 *   applyEffects(decorateStrokedBox(quad, style, world), state, world, bbox)
 * so the shadow silhouettes the DECORATED widget (border + rounded corners
 * included) and bloom glows the frame too — a bordered photo's shadow is the
 * shadow of the framed photo, not of the bare bitmap.
 *
 * DOM-free pure JS (bare-node testable, like ir.js and decorate.js).
 */

import { effectSubtree, pushTransform, popTransform } from "./ir.js";

/**
 * Pure function. Is a widget's effects state visually a no-op? True iff the
 * shadow is off (blur <= 0 — the manifest's effect-off definition; opacity 0
 * also counts, it paints nothing) AND bloom is off (strength <= 0) AND the
 * blend mode is normal/absent. Absent keys are OFF (old documents predate the
 * bundle), so a pre-effects document is byte-identical by construction.
 *
 * Args:
 *   state (object): evaluated widget state (shadow/bloom/blendMode read here)
 *
 * Returns:
 *   boolean
 *
 * @example effectsOff({}) // true
 * @example effectsOff({shadow: {dx: 3, dy: 3, blur: 0, color: "#000", opacity: 0.5}}) // true (blur 0 = shadow off)
 * @example effectsOff({shadow: {dx: 3, dy: 3, blur: 4, color: "#000", opacity: 0}}) // true (opacity 0 paints nothing)
 * @example effectsOff({shadow: {dx: 3, dy: 3, blur: 4, color: "#000", opacity: 0.5}}) // false
 * @example effectsOff({bloom: {radius: 10, strength: 0.8}}) // false
 * @example effectsOff({bloom: {radius: 10, strength: 0}}) // true (strength 0 = bloom off)
 * @example effectsOff({blendMode: "multiply"}) // false
 * @example effectsOff({blendMode: "normal"}) // true
 */
export function effectsOff(state) {
  const shadowOn = (state.shadow?.blur ?? 0) > 0 && (state.shadow?.opacity ?? 0) > 0;
  const bloomOn = (state.bloom?.strength ?? 0) > 0;
  const blendOn = (state.blendMode ?? "normal") !== "normal";
  return !shadowOn && !bloomOn && !blendOn;
}

/**
 * Pure function. Wraps a widget's own content ops in the shared effects
 * composition (ONE effectSubtree op carrying shadow/bloom/blend), or returns
 * `content` UNCHANGED when all effects are off (effectsOff) — the
 * byte-identical pass-through.
 *
 * `bbox` is the widget's LOCAL render bounds {x, y, w, h} — a bbox widget
 * passes {x: 0, y: 0, w: s.w, h: s.h}; an arrow-family widget (no bbox state;
 * world == identity) passes the AABB of its drawn geometry (endpointsBBox).
 *
 * Content follows decorate.js's ABSOLUTE-WORLD CONTRACT: effectSubtree's
 * `content` is independently flattened by every backend, so it is wrapped in
 * pushTransform(world) here — which is why `world` (sceneIR's 3rd emit
 * argument) is required on the effected path. The pass-through path never
 * needs it (sceneIR's outer wrap alone is correct), exactly like
 * decorateStrokedBox.
 *
 * OPACITY: the widget's opacity stays on its own content ops (or its
 * decorated cropSubtree) — the effect texture then holds the faded widget, so
 * a translucent widget casts a fainter shadow and blooms dimmer, which is the
 * physically-consistent reading; the op adds no second fade.
 *
 * Args:
 *   content (object[]): the widget's own IR ops in LOCAL space
 *   state (object): evaluated widget state (shadow/bloom/blendMode)
 *   world ({x, y, rotation, scale}): the node's ABSOLUTE world transform —
 *     required only when an effect is on
 *   bbox ({x, y, w, h}): the widget's LOCAL render bounds
 *
 * Returns:
 *   object[]: either `content` unchanged, or [effectSubtree(...)] wrapping it
 *
 * @example applyEffects([{op: "rect"}], {}, {x: 0, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 10}) // [{op: "rect"}] (all off → pass-through)
 * @example applyEffects([{op: "rect"}], {shadow: {dx: 3, dy: 3, blur: 4, color: "#000000", opacity: 0.5}}, {x: 0, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 10})[0].op // "effectSubtree"
 * @example applyEffects([{op: "rect"}], {blendMode: "multiply"}, {x: 0, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 10})[0].blend // "multiply"
 */
export function applyEffects(content, state, world, bbox) {
  if (effectsOff(state)) return content;
  if (!world) throw new Error("applyEffects: an effected widget needs the node's absolute `world` (sceneIR passes it as emit's 3rd arg); got undefined");
  const shadowOn = (state.shadow?.blur ?? 0) > 0 && (state.shadow?.opacity ?? 0) > 0;
  const bloomOn = (state.bloom?.strength ?? 0) > 0;
  return [effectSubtree({
    x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h,
    shadow: shadowOn ? {
      dx: state.shadow.dx ?? 0, dy: state.shadow.dy ?? 0, blur: state.shadow.blur,
      color: state.shadow.color ?? "#000000", opacity: state.shadow.opacity,
    } : null,
    bloom: bloomOn ? { radius: state.bloom.radius ?? 0, strength: state.bloom.strength } : null,
    blend: state.blendMode ?? "normal",
    content: [pushTransform(world), ...content, popTransform()],
  })];
}

/**
 * Pure function. The world-unit CULL-BOUNDS margin a widget's effects add
 * around its bbox (manifest Round 12D: "an effect enlarges the node's
 * effective AABB by blur radius + offset — extend the cull bounds"). The
 * same 3σ-support + offset-length halo effectSubtree computes as `margin`,
 * duplicated here as a pure function of STATE because culling
 * (core/view.js defaultCanSkip via the plugin `cullMargin` hook) runs before
 * any IR exists. Zero when all effects are off — the default culling is then
 * untouched.
 *
 * Plugins composing the effects bundle declare `cullMargin: effectsCullMargin`
 * (one line); core/view.js multiplies by node.world.scale to inflate the
 * conservative AABB.
 *
 * @example effectsCullMargin({}) // 0
 * @example effectsCullMargin({shadow: {dx: 3, dy: 4, blur: 2, color: "#000", opacity: 0.5}}) // 11 (3·2 blur spill + 5 offset length)
 * @example effectsCullMargin({bloom: {radius: 5, strength: 1}}) // 15 (3·5 bloom spill)
 * @example effectsCullMargin({blendMode: "multiply"}) // 0 (blend alone adds no halo)
 */
export function effectsCullMargin(state) {
  // 3σ = the Gaussian kernel's support bound each side (gpu/shaders.js
  // MAX_HALF_KERNEL's own derivation — sigma·3), matching effectSubtree's
  // build-time margin exactly.
  const BLUR_SUPPORT_SIGMAS = 3;
  const shadowOn = (state.shadow?.blur ?? 0) > 0 && (state.shadow?.opacity ?? 0) > 0;
  const bloomOn = (state.bloom?.strength ?? 0) > 0;
  return Math.max(
    shadowOn ? state.shadow.blur * BLUR_SUPPORT_SIGMAS + Math.hypot(state.shadow.dx ?? 0, state.shadow.dy ?? 0) : 0,
    bloomOn ? (state.bloom.radius ?? 0) * BLUR_SUPPORT_SIGMAS : 0,
  );
}

/**
 * Pure function. The LOCAL AABB of a set of points, padded on every side —
 * the arrow-family widgets' effect bbox (they have no w/h state; their drawn
 * extent is their endpoints plus stroke/head geometry). `pad` should cover
 * the half stroke width and any head overhang; being conservative only grows
 * the effect texture region slightly, never clips.
 *
 * Args:
 *   points ({x, y}[]): the geometry's defining points (endpoints, elbow
 *     corner, bezier control, head tips...)
 *   pad (number): per-side padding in local units
 *
 * Returns:
 *   {x, y, w, h}
 *
 * @example paddedPointsBBox([{x: 10, y: 20}, {x: 110, y: 60}], 5) // {x: 5, y: 15, w: 110, h: 50}
 * @example paddedPointsBBox([{x: 0, y: 0}], 2) // {x: -2, y: -2, w: 4, h: 4}
 */
export function paddedPointsBBox(points, pad) {
  if (!Array.isArray(points) || points.length === 0) throw new Error(`paddedPointsBBox: need >= 1 point, got ${JSON.stringify(points)}`);
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  return { x: minX, y: minY, w: Math.max(...xs) + pad - minX, h: Math.max(...ys) + pad - minY };
}
