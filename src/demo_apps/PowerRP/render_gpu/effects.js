/**
 * The RENDER half of the shared EFFECTS BUNDLE (manifest Round 12D: drop
 * shadow + bloom + blend mode — "ALL FOUR reuse one substrate ... the EFFECTS
 * BUNDLE joins the property registry; any widget composes it"). The property
 * half lives in core/properties.js (the `effects` bundle: shadow.{dx,dy,blur,
 * color,opacity}, bloom.{radius,strength}, blendMode, the mirrored INNER SHADOW
 * innerShadow.{dx,dy,blur,color,opacity} — a recess cast inside the widget
 * silhouette — SOFT EDGES `softEdges`, a canvas-unit amount that feathers
 * the widget's own coverage inward to transparency, PowerPoint-style, and BLUR
 * `gaussianBlur`, a canvas-unit Gaussian sigma applied to the widget's whole composite —
 * bloom's own blur primitive minus bloom's add-back over-glow); THIS
 * module gives every composing widget the matching
 * render composition (all of them ride ONE effectSubtree) — one shared
 * function each plugin's emit() calls, exactly like decorate.js's
 * decorateStrokedBox (the stroked-box bundle's render half, the direct
 * precedent for this module's shape).
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────────
 * Given a widget's OWN content ops plus its (evaluated) state, it returns the
 * content wrapped in ONE `effectSubtree` op (render_gpu/ir.js) when any
 * effect is ON, and returns the content UNCHANGED when none is. "None" is
 * `effectsOff()` below — the ONE gate, and it is SIX conditions, each reading
 * the property that makes its effect VISIBLE rather than the property that
 * softens it: shadow.opacity <= 0 AND bloom.strength <= 0 AND
 * innerShadow.opacity <= 0 AND softEdges <= 0 AND gaussianBlur <= 0 AND blendMode
 * (the manifest defaults: "Defaults = effect-off ... so every old doc is
 * byte-identical").
 * BLUR IS NOT A GATE: a blur-0 shadow at opacity 0.5 is a HARD-EDGED shadow and
 * is fully visible, which is the model manifest 14.8 exists to overturn. This
 * header claimed "shadow blur <= 0 AND bloom strength <= 0 AND blendMode normal"
 * for long enough that effectsOff's own doctests contradicted it, and this is the
 * header every widget's effects ride through.
 * The pass-through path is what makes an effectless widget render
 * byte-identically to before this bundle existed — the same discipline as
 * decorate.js's isUndecorated.
 *
 * The substrate itself (ONE offscreen render of the widget, then shadow /
 * widget / bloom composites under the chosen blend) is implemented by each
 * backend: AT RUNTIME by render_gpu/skia/paint_skia.js (`drawProxyEffect` — a
 * scratch surface plus image filters, on the browser's WebGL2 Skia surface and on
 * bare node's software surface alike), pdf_backend.js's emitEffect (the HYBRID
 * RULE: raster shadow PNG under vector content; bloom / non-normal blends
 * raster the widget region), svg_backend.js (raster region).
 *   SUPERSEDED — HISTORICAL: this paragraph used to answer "where is
 *   effectSubtree implemented at runtime" with gpu/compositor.js's "effect" batch
 *   (render-to-texture + blur + fixed-function blend pipelines). That file went
 *   with the retired prototype backend; see render_gpu/FINDINGS.md.
 *
 * ── WHICH WIDGETS COMPOSE THIS — now EVERY eligible one, by construction ──────
 * Eligibility used to be FOUR HAND-COPIED LINES per plugin
 * (bundleNestedDefaults("effects"), bundle("effects"), applyEffects(...) inside
 * emit, cullMargin: effectsCullMargin) and nothing enforced them: 28 of 74
 * plugins had ZERO effect rows, only three of them justifiably. The user's
 * verbatim complaint — "Why does Frosted Glass not have a soft edges option like
 * all the other things? ... Soft edges should be an option for everything that
 * we can give it to. As well as drop shadows, etc." — is that gap.
 *
 * The bundle is now UNIVERSAL and a plugin cannot forget it:
 *   PROPERTY half — core/registry.register() injects `bundle("effects")` rows +
 *     `bundleNestedDefaults("effects")` + `cullMargin: effectsCullMargin` into
 *     every ELIGIBLE plugin that does not already carry them, and marks the
 *     plugin `effectsInjected: true`.
 *   RENDER half — render_gpu/ports.js (the ONE walker every rendered node passes
 *     through) calls applyNodeEffects below for exactly those marked plugins.
 *     The 34 plugins that already call applyEffects inside emit() keep doing so
 *     and the walker leaves them alone, so there is never a double wrap.
 *
 * EXCLUDED, deliberately — the honest boundary (core/registry.effectsInjectable):
 *   - camera (capabilities.purgeable === false): the view/background
 *     definition, not a drawn widget.
 *   - cropbox + anchor_point (capabilities.ghost, no foldsSubtree): no rendered
 *     volume of their own — a crop box is a clip region (its TARGET carries
 *     effects; they ride into the crop content), an anchor point is editor
 *     chrome. A group is ALSO a ghost but folds a composited subtree, so it
 *     does compose the bundle (it always did).
 *   - blur + corkboardYarn (no bbox, no effectBounds hook): no local render
 *     footprint to bound the effect substrate. A full-screen backdrop blur has
 *     no geometry at all; a yarn curve has geometry but declares no bounds —
 *     it becomes injectable the day it declares an `effectBounds` hook.
 *     (The excluded `blur` PLUGIN is the backdrop-blur WIDGET, not the bundle's
 *     own `gaussianBlur` effect — the two are unrelated, which is exactly why
 *     the effect could not be named `blur`; see core/properties.js.)
 * A node kind that cannot honour an effect gets NO ROW — never a fake one.
 * (The ARROW FAMILY fails the same bbox test but is NOT excluded: each arrow
 * composes the bundle in its own emit() and passes paddedPointsBBox of its drawn
 * geometry, so the registry is never asked to do it for them.)
 *
 * BACKDROP SAMPLERS ARE NOT EXCLUDED ANY MORE. The old claim ("they have no
 * self-silhouette; re-rendering the widget alone would sample an empty
 * surface") was FALSE, and this file's own backend disproved it: a glass /
 * material / magnify op writes premultiplied ZERO outside its own SDF, so its
 * offscreen render's ALPHA *is* the panel silhouette — exactly what soft edges,
 * the drop shadow, the inner shadow and bloom need. The one real defect was
 * that the effect scratch surface was cleared transparent, so a nested
 * sampler's below-content read nothing (a dark smear: rgb(51,51,51) where
 * rgb(148,51,158) was correct). paint_skia.js now hands the scratch a `below`
 * context (the OUTER composite surface + the outer below-list + the region
 * offset), so a sampler inside an effect samples the real scene.
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

import { effectSubtree, pushTransform, popTransform, strokeOutwardReach, BLUR_SUPPORT_SIGMAS } from "./ir.js";
// THE BOUNDS PROTOCOL, read by effectBoundsOf below so a plugin declares its ink
// rect ONCE. core/view.js imports effectsCullMargin from this module in return, so
// the two form an import cycle — safe and intentional: both sides export only
// hoisted function declarations and neither calls the other at module-eval time,
// so whichever module is entered first the bindings are live by first call. (The
// render_gpu → core/view.js direction already had precedent in pdf_display.js.)
import { localBoundsOf } from "../core/view.js";

/**
 * The TOP-LEVEL item-state keys the render half below actually implements — one
 * per effect in the bundle. core/registry.js checks the property half
 * (core/properties.js BUNDLES.effects, expanded through bundleNestedDefaults)
 * against THIS list at import time, so a SIXTH effect added to the property
 * bundle without a render implementation fails at boot instead of shipping a
 * dead Inspector row (the render_settings.js "declared option with no
 * implementation throws at import" precedent).
 *
 * `gaussianBlur` IS THE ITEM-STATE KEY; the IR OP's field is plain `blur`. Those
 * are two different namespaces and the mismatch is deliberate: item state shares
 * ONE flat namespace with every plugin's own properties, where `blur` was already
 * taken by plugins/blur.js's backdrop radius (core/properties.js says why at
 * length), while an effectSubtree op has exactly one blur and nothing to collide
 * with. applyEffects below is the one place the two names meet.
 */
export const EFFECT_STATE_KEYS = ["shadow", "bloom", "blendMode", "innerShadow", "softEdges", "gaussianBlur"];

/**
 * Pure function. Is a widget's effects state visually a no-op? True iff the
 * shadow is off (OPACITY <= 0 — the manifest 14.8 gate: "shadow opacity = 0
 * gates whether we render it") AND bloom is off (strength <= 0) AND the blend
 * mode is normal/absent AND the inner shadow is off (opacity <= 0) AND soft
 * edges are off (amount <= 0) AND the blur is off (gaussianBlur radius <= 0). Absent keys are
 * OFF (old documents predate the bundle), so a pre-effects document is
 * byte-identical by construction.
 *
 * SOFT EDGES and BLUR gate on the AMOUNT itself (there is no separate opacity):
 * a 0 feather is a crisp, unchanged edge and a 0-sigma Gaussian is the identity,
 * so softEdges 0 and gaussianBlur 0 are off.
 *
 * THIS IS ALSO WHAT MAKES A BLURRED GROUP FOLD ITS SUBTREE. plugins/group.js
 * groupFoldsSubtree is `groupCropRect(s) !== null || !effectsOff(s)`, so the
 * moment a group's blur goes above 0 this returns false, the group composites its
 * whole member subtree to ONE texture, and the blur is applied to that composite —
 * the members smear TOGETHER as one silhouette rather than each blurring alone.
 *
 * BLUR IS NOT PART OF THE GATE (manifest 14.8, user verbatim: "blur should be
 * allowed to be 0 and still visible"). blur 0 with opacity > 0 is a legal,
 * VISIBLE shadow: a crisp, hard-edged tinted offset silhouette (no softening).
 * Only opacity turns the shadow on/off.
 *
 * THE GATE IS ONE-SIDED — `> 0`, with NO upper test, and that is now load-bearing
 * rather than incidental: shadow/innerShadow opacity have no ceiling
 * (core/properties.js "SHADOW OPACITY HAS NO CEILING"), so an OVERDRIVEN shadow
 * (opacity above 1, driving the penumbra to full coverage) is simply an on
 * shadow here and rides the same effectSubtree unchanged.
 *
 * Args:
 *   state (object): evaluated widget state (shadow/bloom/blendMode read here)
 *
 * Returns:
 *   boolean
 *
 * @example effectsOff({}) // true
 * @example effectsOff({shadow: {dx: 0, dy: 0, blur: 0, color: "#000", opacity: 0}}) // true (opacity 0 = shadow off — the default)
 * @example effectsOff({shadow: {dx: 3, dy: 3, blur: 4, color: "#000", opacity: 0}}) // true (opacity 0 paints nothing)
 * @example effectsOff({shadow: {dx: 3, dy: 3, blur: 0, color: "#000", opacity: 0.5}}) // false (blur 0 but opacity>0 = a HARD-edged shadow, visible)
 * @example effectsOff({shadow: {dx: 3, dy: 3, blur: 4, color: "#000", opacity: 0.5}}) // false
 * @example effectsOff({shadow: {dx: 3, dy: 3, blur: 4, color: "#000", opacity: 3}}) // false (an OVERDRIVEN shadow is just an on shadow — there is no upper gate)
 * @example effectsOff({bloom: {radius: 10, strength: 0.8}}) // false
 * @example effectsOff({bloom: {radius: 10, strength: 0}}) // true (strength 0 = bloom off)
 * @example effectsOff({blendMode: "multiply"}) // false
 * @example effectsOff({blendMode: "normal"}) // true
 * @example effectsOff({innerShadow: {dx: 0, dy: 0, blur: 4, color: "#000", opacity: 0}}) // true (opacity 0 = inner shadow off — the default)
 * @example effectsOff({innerShadow: {dx: 2, dy: 2, blur: 4, color: "#000", opacity: 0.6}}) // false
 * @example effectsOff({softEdges: 0}) // true (0 feather = crisp edge — the default)
 * @example effectsOff({softEdges: 8}) // false (an 8-unit feather is a live effect)
 * @example effectsOff({gaussianBlur: 0}) // true (0 sigma = the identity Gaussian — the default)
 * @example effectsOff({gaussianBlur: 6}) // false (a 6-unit blur is a live effect)
 */
export function effectsOff(state) {
  const shadowOn = (state.shadow?.opacity ?? 0) > 0;
  const bloomOn = (state.bloom?.strength ?? 0) > 0;
  const blendOn = (state.blendMode ?? "normal") !== "normal";
  const innerOn = (state.innerShadow?.opacity ?? 0) > 0; // mirror of the drop-shadow gate (14.8): opacity turns it on
  const softOn = (state.softEdges ?? 0) > 0; // soft edges gate on the amount itself (0 = crisp/off)
  const blurOn = (state.gaussianBlur ?? 0) > 0; // same shape as soft edges: the radius IS the gate
  return !shadowOn && !bloomOn && !blendOn && !innerOn && !softOn && !blurOn;
}

/**
 * Pure function. The same state with every effects-bundle key STRIPPED, so a
 * self-effecting plugin's own applyEffects call is the pass-through. Returns the
 * VERY SAME object when there was nothing to strip.
 *
 * ── WHO NEEDS THIS: THE CROSSFADE'S TWO ENDPOINT EMITS (WORKSTREAM AV) ───────
 * ports.crossfadeIR draws BOTH endpoint states through their OWN plugins' emit()
 * and dissolves them. 34 plugins compose the effects bundle inside emit(), so
 * without this each side would carry ITS ENDPOINT'S effects — two discrete looks
 * cross-dissolving — AND the walker's tweened wrap would land on top, a double
 * composition of the same shadow. Stripping the keys at the endpoint emits makes
 * the walker's ONE tweened wrap the only effects composition on the node, which
 * is the AV law: the morph seam owns shape, the ordinary seams own the rest.
 *
 * Deleting rather than zeroing, because `effectsOff` reads absent-as-off and the
 * defaults are effect-off — so the stripped bag is exactly what a plugin sees for
 * an un-effected widget, with no invented zero to disagree about.
 *
 * @param {object} state - an evaluated widget state
 * @returns {object} the state itself, or a copy with the effect keys removed
 *
 * @example (() => { const s = {w: 10}; return withEffectsStripped(s) === s; })() // true (nothing to strip — identity)
 * @example withEffectsStripped({w: 10, gaussianBlur: 8, bloom: {strength: 1}}) // {w: 10}
 * @example effectsOff(withEffectsStripped({shadow: {opacity: 0.9, blur: 4}})) // true
 */
export function withEffectsStripped(state) {
  if (!EFFECT_STATE_KEYS.some((k) => k in state)) return state;
  const out = { ...state };
  for (const k of EFFECT_STATE_KEYS) delete out[k];
  return out;
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
 * @example applyEffects([{op: "rect"}], {shadow: {dx: 3, dy: 3, blur: 4, color: "#000000", opacity: 3}}, {x: 0, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 10})[0].shadow.opacity // 3 (an OVERDRIVEN opacity passes through UNCAPPED to the renderer)
 * @example applyEffects([{op: "rect"}], {blendMode: "multiply"}, {x: 0, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 10})[0].blend // "multiply"
 * @example applyEffects([{op: "rect"}], {softEdges: 6}, {x: 0, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 10})[0].softEdges // 6 (soft edges alone wraps in an effectSubtree)
 * @example applyEffects([{op: "rect"}], {gaussianBlur: 5}, {x: 0, y: 0, rotation: 0, scale: 1}, {x: 0, y: 0, w: 10, h: 10})[0].blur // 5 (blur alone wraps in an effectSubtree)
 */
export function applyEffects(content, state, world, bbox) {
  if (effectsOff(state)) return content;
  if (!world) throw new Error("applyEffects: an effected widget needs the node's absolute `world` (sceneIR passes it as emit's 3rd arg); got undefined");
  const shadowOn = (state.shadow?.opacity ?? 0) > 0; // 14.8: opacity is the gate, blur 0 stays visible
  const bloomOn = (state.bloom?.strength ?? 0) > 0;
  const innerOn = (state.innerShadow?.opacity ?? 0) > 0; // same gate as the drop shadow (blur 0 stays visible)
  const softOn = (state.softEdges ?? 0) > 0; // soft edges gate on the amount (0 = off)
  const blurOn = (state.gaussianBlur ?? 0) > 0; // the blur radius IS its gate (0 = off)
  return [effectSubtree({
    x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h,
    shadow: shadowOn ? {
      dx: state.shadow.dx ?? 0, dy: state.shadow.dy ?? 0, blur: state.shadow.blur,
      color: state.shadow.color ?? "#000000", opacity: state.shadow.opacity,
    } : null,
    bloom: bloomOn ? { radius: state.bloom.radius ?? 0, strength: state.bloom.strength } : null,
    blend: state.blendMode ?? "normal",
    // INNER SHADOW rides the SAME effectSubtree (the render half of the effects
    // bundle's fourth effect); the Skia backend darkens the widget's interior
    // edge. Off (opacity 0) ⇒ null, so an inner-shadow-free widget is byte-identical.
    innerShadow: innerOn ? {
      dx: state.innerShadow.dx ?? 0, dy: state.innerShadow.dy ?? 0, blur: state.innerShadow.blur,
      color: state.innerShadow.color ?? "#000000", opacity: state.innerShadow.opacity,
    } : null,
    // SOFT EDGES rides the SAME effectSubtree (the bundle's fifth effect): the
    // Skia backend feathers the widget's coverage inward BEFORE the other
    // composites. Off (0) ⇒ 0, so a crisp widget is byte-identical.
    softEdges: softOn ? state.softEdges : 0,
    // BLUR (the bundle's sixth effect): a plain Gaussian on the widget's own
    // composite — bloom's blur primitive without bloom's add-back over-glow. Off
    // (0) ⇒ 0, so a sharp widget is byte-identical.
    blur: blurOn ? state.gaussianBlur : 0,
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
 * OPACITY IS DELIBERATELY ABSENT FROM THE MARGIN, and that survives an
 * OVERDRIVEN shadow (opacity above 1 — core/properties.js). Overdrive is a
 * coverage MULTIPLIER, so the obvious worry is that it makes a previously
 * negligible blur tail visible and the halo too small. It cannot: coverage is
 * stored in an 8-bit channel, and a Gaussian-blurred edge's profile
 * ½·erfc(d/(σ√2)) is 0.00135 at d = 3σ = BLUR_SUPPORT_SIGMAS·σ, which quantizes
 * to byte 0 — a pixel holding zero coverage stays zero under any multiplier. The
 * saturated shadow's visible edge lands where the byte first reaches 1, at
 * ½·erfc(d/(σ√2)) = 0.5/255 ⇒ d ≈ 2.89σ, INSIDE the existing margin. So the
 * halo is right for every opacity and needs no opacity term.
 *
 * THE STROKE'S OUTWARD REACH IS COUNTED HERE TOO, and it is not an effect —
 * it is admitted deliberately, because this function is THE shared reach seam
 * (culling and the copy/export capture rect both come through it) and a
 * bbox widget's `localBounds` is its bare {0,0,w,h} box, which has never included
 * stroke ink. A CENTERED stroke reaching w/2 outside that box was already
 * tolerated as slop; an OUTER stroke reaches the FULL width, which is enough to
 * cull a visible border at the viewport edge or clip it out of an exported PNG.
 * Adding the reach here fixes both consumers at once, exactly as the docblock
 * above instructs ("update the reach function... not the callers"). It stays 0
 * for an unstroked or fully-inner widget, so nothing existing widens.
 *
 * @example effectsCullMargin({}) // 0
 * @example effectsCullMargin({shadow: {dx: 3, dy: 4, blur: 2, color: "#000", opacity: 0.5}}) // 11 (3·2 blur spill + 5 offset length)
 * @example effectsCullMargin({stroke: "#000", strokeWidth: 12}) // 0 (a CENTERED stroke keeps the historical margin — unchanged to the bit)
 * @example effectsCullMargin({stroke: "#000", strokeWidth: 12, strokeOffset: 1}) // 6 (a fully OUTER stroke reaches 6 past what a centered one did)
 * @example effectsCullMargin({stroke: "#000", strokeWidth: 12, strokeOffset: -1}) // 0 (fully INNER: no ink outside the box at all)
 * @example effectsCullMargin({shadow: {dx: 3, dy: 4, blur: 2, color: "#000", opacity: 3}}) // 11 (an OVERDRIVEN shadow needs no wider halo — see above)
 * @example effectsCullMargin({shadow: {dx: 3, dy: 4, blur: 0, color: "#000", opacity: 0.5}}) // 5 (blur 0 = no spill, but the offset silhouette still reaches 5)
 * @example effectsCullMargin({bloom: {radius: 5, strength: 1}}) // 15 (3·5 bloom spill)
 * @example effectsCullMargin({blendMode: "multiply"}) // 0 (blend alone adds no halo)
 * @example effectsCullMargin({gaussianBlur: 4}) // 12 (3·4 — the widget's own ink smears outward)
 * @example effectsCullMargin({softEdges: 40}) // 0 (a feather only ERODES inward — no halo, however wide)
 * @example effectsCullMargin({glyphStroke: "#000", glyphStrokeWidth: 10}) // 5 (an outline around the LETTERFORMS reaches its full half-width past the ink)
 * @example effectsCullMargin({glyphStrokeWidth: 10}) // 0 (a width with no paint draws nothing)
 */
export function effectsCullMargin(state) {
  // BLUR_SUPPORT_SIGMAS·σ = the Gaussian kernel's support bound each side (the
  // shared ir.js constant), matching effectSubtree's build-time margin exactly.
  const shadowOn = (state.shadow?.opacity ?? 0) > 0; // 14.8: opacity gates; a blur-0 shadow still offsets by (dx,dy)
  const bloomOn = (state.bloom?.strength ?? 0) > 0;
  // The stroke term is the EXCESS over the centered stroke's w/2, never the whole
  // reach: w/2 of slop was always tolerated (a bbox widget's localBounds excludes
  // it), so counting only what an offset adds ON TOP leaves every centered-stroke
  // widget's margin at exactly its historical value.
  const strokeOn = state.stroke != null && (state.strokeWidth ?? 0) > 0;
  const strokeExcess = strokeOn
    ? Math.max(0, strokeOutwardReach(state.strokeWidth, state.strokeOffset) - state.strokeWidth / 2)
    : 0;
  // THE PLAIN BLUR SPILLS, and it is the one gate here that needs no `On` flag:
  // the radius IS the gate, so a 0 radius contributes 0 by arithmetic. Same 3σ
  // support bound as the bloom radius above — it is the same Gaussian, applied to
  // the widget's own ink instead of to a bright copy of it. (softEdges is still
  // absent by design: a feather only erodes coverage INWARD.)
  // THE GLYPH OUTLINE (N2) reaches its FULL half-width past the ink, and unlike the
  // box stroke above there is no historical slop to subtract. The difference is
  // that a box stroke runs along the widget's own bbox, which localBounds already
  // reports; a glyph outline runs along the LETTERFORMS, and for a text widget
  // localBounds is the laid-out ink rect (plaintextInkBounds) which the outline
  // genuinely sits outside of. So the whole half-width counts — otherwise a heavy
  // outline on type near the viewport edge is culled or clipped out of an export,
  // which is the exact defect the stroke term above was added to fix for boxes.
  const glyphStrokeOn = state.glyphStroke != null && (state.glyphStrokeWidth ?? 0) > 0;
  return Math.max(
    shadowOn ? state.shadow.blur * BLUR_SUPPORT_SIGMAS + Math.hypot(state.shadow.dx ?? 0, state.shadow.dy ?? 0) : 0,
    bloomOn ? (state.bloom.radius ?? 0) * BLUR_SUPPORT_SIGMAS : 0,
    Math.max(0, state.gaussianBlur ?? 0) * BLUR_SUPPORT_SIGMAS,
    strokeExcess,
    glyphStrokeOn ? state.glyphStrokeWidth / 2 : 0,
  );
}

/**
 * Pure function (LOGS via the injected `warn` — diagnostic only, never read
 * back, so this is near-pure in the same sense a reportOnce call is). THE
 * LANDING BAR for any material-emitting plugin whose params can carry a
 * WORLD-COORDINATE knob (a light position bound by equation to another item,
 * e.g. god_rays/lens_flare's lightWorldX/Y): every numeric param is checked
 * finite before it reaches materialBackdrop/materialFill's own validator
 * (render_gpu/ir.js), which THROWS on the first non-finite param it finds —
 * correctly so (that check stays strict for every OTHER widget's genuine bugs;
 * this function's job is to make sure a plugin never hands it a value that
 * SHOULDN'T be non-finite in the first place). A non-finite entry is replaced
 * by `fallback[key]` (or 0 if that key has no declared fallback) and logged
 * ONCE per call, naming the item and the field, so the cause is findable
 * instead of a red box with no history.
 *
 * Home: here, not in either plugin, because "no plugin may import another
 * plugin" (manifest) and both god_rays and lens_flare need the identical
 * guard — this module is already the shared render-half every material-
 * composing widget imports (effectsCullMargin's same reasoning).
 *
 * @param {object} params - a plugin's evaluated numeric knob map (as passed to materialBackdrop/materialFill's `params`)
 * @param {object} fallback - same-shaped map of replacement values for a non-finite entry
 * @param {string} itemLabel - names the item in the console.warn (e.g. `"demo_god_rays a1"`)
 * @param {(msg: string) => void} [warn] - injected for testability; defaults to console.warn
 * @returns {object} same keys as `params`, every numeric value finite
 *
 * @example finiteGuardedParams({lightOffsetX: NaN, density: 0.9}, {lightOffsetX: 0}, "demo_god_rays a1", () => {}) // {lightOffsetX: 0, density: 0.9}
 * @example finiteGuardedParams({exposure: 0.4}, {}, "demo_god_rays a1", () => {}) // {exposure: 0.4} (already finite: untouched, no warning)
 * @example finiteGuardedParams({tint: "#ffffff", weight: Infinity}, {weight: 0.1}, "demo_god_rays a1", () => {}).tint // "#ffffff" (non-numbers pass through — the packer parses color strings itself)
 */
export function finiteGuardedParams(params, fallback, itemLabel, warn = console.warn) {
  const out = {};
  for (const [key, v] of Object.entries(params)) {
    if (typeof v === "number" && !Number.isFinite(v)) {
      const replacement = fallback[key] ?? 0;
      warn(`PowerRP "${itemLabel}": param "${key}" was ${v} (non-finite) — falling back to ${replacement}. Check the item's light position / knob equations.`);
      out[key] = replacement;
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Pure function. The PER-SIDE-inflated effect SOURCE rect (in device px) that a
 * backend must re-render the widget into, so the effect passes have valid source
 * texels on every side and an OFFSET silhouette's own body is captured.
 *
 * ── WHO CALLS IT ──────────────────────────────────────────────────────────────
 * The Skia backend's effectRegion (render_gpu/skia/paint_skia.js) — the rect it
 * returns, clamped to the surface, IS the offscreen every effect pass allocates,
 * instead of a full-device surface per pass. There the per-side split serves the
 * INNER SHADOW: its field is filled with opaque shadow colour, has the OFFSET
 * silhouette punched out, and is blurred with TileMode.Clamp, so the field's
 * boundary must clear that offset silhouette on the side it moves toward or the
 * clamp replicates the hole. (`reach` = the inner blur support + the AA slop;
 * `offDx/offDy` = the inner shadow offset.) The drop shadow and the bloom pass
 * nothing here — they are ImageFilters applied at BLIT time, and a filter's
 * output is drawn past the source image's rect, so their halo needs no source.
 *
 * ── WHY per-side, not a symmetric scalar (manifest 16.1) ──────────────────────
 * The offscreen texture holds ONE re-render of the widget; the separable
 * Gaussian then reads from it, spilling `reach` texels beyond each geometry
 * edge, and the shadow quad samples the SAME texture translated by the device
 * offset (offDx, offDy). If the source rect is only the widget footprint (the
 * pre-16.1 bug), the blur that should spill UP/LEFT of the geometry reads empty
 * texels → a hard straight cliff on the TOP and LEFT (the leading edges,
 * OPPOSITE the +dx/+dy offset), while the offset direction still looked soft
 * because the shifted shadow body extends past the footprint there.
 *
 * The correct source must expand by the FULL blur reach on ALL FOUR sides
 * (the widget's blurred silhouette spills `reach` every direction) PLUS the
 * shadow offset on the side the shadow moves TOWARD (its shifted body needs
 * source there). Left/top get max(0, -off); right/bottom get max(0, +off) —
 * so a positive dx grows the RIGHT source, a negative dx grows the LEFT.
 *
 * This is NOT a second definition of shadow reach: `reach` and `offDx/offDy`
 * are passed in by the compositor, derived from the SAME blur·3 + offset that
 * effectsCullMargin / effectSubtree.margin use (effectsCullMargin's scalar
 * contract is untouched — 16.1 coordination note, option 1). The scalar margin
 * (a symmetric bound) stays correct for CULLING and the composite QUAD size;
 * only the render-to-texture SOURCE needs the per-side split.
 *
 * Args:
 *   cx, cy (number): widget footprint center, device px
 *   halfW, halfH (number): rotation-aware half-extents of the footprint, device px
 *   reach (number): blur support (blur sigma · 3), device px, applied EVERY side
 *   offDx, offDy (number): shadow offset in device px (0 when no shadow)
 *
 * Returns:
 *   {x, y, w, h}: device-px source rect (may extend off-canvas; the caller
 *   intersects it with the inflated canvas bound and downscales to fit)
 *
 * @example effectSourceRect(100, 100, 20, 15, 0, 0, 0) // {x: 80, y: 85, w: 40, h: 30} (no effect halo → bare footprint)
 * @example effectSourceRect(100, 100, 20, 15, 30, 6, 6) // {x: 50, y: 55, w: 106, h: 96} (reach 30 every side; +6 offset grows right/bottom only)
 * @example effectSourceRect(100, 100, 20, 15, 30, -6, -6) // {x: 44, y: 49, w: 106, h: 96} (negative offset grows left/top instead)
 */
export function effectSourceRect(cx, cy, halfW, halfH, reach, offDx, offDy) {
  const left = reach + Math.max(0, -offDx);
  const right = reach + Math.max(0, offDx);
  const top = reach + Math.max(0, -offDy);
  const bottom = reach + Math.max(0, offDy);
  const x = cx - halfW - left, y = cy - halfH - top;
  return { x, y, w: halfW * 2 + left + right, h: halfH * 2 + top + bottom };
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

/**
 * Pure function. WHERE a render node's effect substrate lives: its LOCAL render
 * bbox plus the world its content must be wrapped in. The declarative seam for
 * the universal walker wrap, in the style of the existing `cullMargin` /
 * `canSkip` / `proxyFill` hooks:
 *
 *   effectBounds(state, world) → {bbox: {x, y, w, h}, world}
 *
 * DEFAULT (no hook): THE BOUNDS PROTOCOL — core/view.js localBoundsOf(node),
 * wrapped in the node's own world. That one function is already the app's single
 * answer to "what rect does this widget's ink occupy in its own coordinates"
 * (culling, rubber-band selection, the copy/export capture rect all read it), and
 * a plugin declares it ONCE as `localBounds(state)`. A `capabilities.bbox` widget
 * with no hook still resolves to {0, 0, w, h} — localBoundsOf's own fallback — so
 * every box widget's substrate is unchanged to the bit.
 *
 * WHY THIS IS THE DEFAULT (the duplication it removes). These two questions have
 * the same answer for every widget that can answer either: the effect substrate is
 * the offscreen the widget re-renders into, so an under-sized one CLIPS the widget
 * — it must cover exactly the ink. Before this, a widget whose ink escaped its box
 * had to say so TWICE, in two hooks, in two protocols (corkboard yarn:
 * `localBounds: yarnInkRect` AND `effectBounds: (s, world) => ({bbox:
 * yarnInkRect(s), world})`; polygon did the same with polygonInkRect), and nothing
 * caught a pair that drifted apart. Now one declaration feeds both.
 *
 * ORTHOGONAL TO `cullMargin` — do not collapse these. `localBounds` is the
 * widget's OWN INK; `cullMargin` is the EFFECT HALO that spills BEYOND that ink
 * (shadow offset + blur, bloom). The halo is deliberately NOT part of the
 * substrate rect: the substrate holds the widget's silhouette, and the compositor
 * grows its own source rect from there (effectSourceRect). A widget that inflated
 * `cullMargin` to cover ink instead of declaring `localBounds` is using the halo
 * hook to fake bounds — it over-reports on all four sides (a max, not per-side)
 * and it means the two numbers can no longer be reasoned about separately.
 *
 * A `effectBounds` hook still wins, and two uses remain legitimate:
 *   - a GROUP whose members are already ABSOLUTE-world IR must wrap them in
 *     T.identity() (not the group world) or they double-transform; only when a
 *     group-LOCAL crop op rides inside does it need the group world. The WORLD,
 *     not the bbox, is what the hook is for there.
 *   - a bbox-less widget uses the hook's PRESENCE as its effects-eligibility
 *     signal (core/registry.effectsInjectable tests `!caps.bbox &&
 *     !plugin.effectBounds`), so corkboard yarn must keep declaring it even
 *     though the default would now compute the same rect. Teaching that predicate
 *     the localBounds protocol too is a separate change.
 *
 * A node that answers neither has no footprint to bound, and
 * core/registry.effectsInjectable refuses to inject effect rows into such a plugin
 * — so this throw is unreachable through the registry and exists to keep a
 * hand-built node loud rather than silently unshadowed.
 *
 * @param {object} node - a core/derive render node ({plugin, state, world})
 * @returns {{bbox: {x: number, y: number, w: number, h: number}, world: object}}
 *
 * @example effectBoundsOf({plugin: {capabilities: {bbox: true}}, state: {w: 200, h: 150}, world: {x: 10, y: 20, rotation: 0, scale: 1}})
 * // {bbox: {x: 0, y: 0, w: 200, h: 150}, world: {x: 10, y: 20, rotation: 0, scale: 1}}
 * @example effectBoundsOf({plugin: {capabilities: {bbox: true}, effectBounds: () => ({bbox: {x: -5, y: -5, w: 10, h: 10}, world: {x: 0, y: 0, rotation: 0, scale: 1}})}, state: {}, world: {}}).bbox.w // 10 (the hook wins)
 * @example // the localBounds protocol supplies the bbox — no effectBounds hook needed:
 * @example effectBoundsOf({plugin: {capabilities: {bbox: false}, localBounds: () => ({x: -20, y: 0, w: 140, h: 100})}, state: {}, world: {x: 3, y: 4, rotation: 0, scale: 1}})
 * // {bbox: {x: -20, y: 0, w: 140, h: 100}, world: {x: 3, y: 4, rotation: 0, scale: 1}}
 */
export function effectBoundsOf(node) {
  if (node.plugin.effectBounds) return node.plugin.effectBounds(node.state, node.world);
  const bbox = localBoundsOf(node);
  if (!bbox)
    throw new Error(`effectBoundsOf: plugin "${node.plugin.type}" answers neither localBounds(state) nor capabilities.bbox, and has no effectBounds(state, world) hook, so its effect substrate has no local footprint`);
  return { bbox, world: node.world };
}

/**
 * Pure function. THE UNIVERSAL WALKER WRAP: one render node's emitted ops,
 * wrapped in the shared effects composition when the plugin does NOT compose the
 * bundle itself. Called from render_gpu/ports.js emitNode — the ONE place every
 * rendered node passes through — so eligibility is structural instead of four
 * hand-copied lines a plugin author can forget.
 *
 * Exactly one wrap, always:
 *   node.morph (WORKSTREAM AV) ⇒ the walker owns the render half NO MATTER WHAT
 *     the plugin does, because ports.emitNodeBody ROUTED THE PLUGIN'S emit() AWAY
 *     — morphIR/crossfadeIR produced these ops instead. See below.
 *   plugin.effectsInjected (set by core/registry.register when it injected the
 *     property half) ⇒ the walker owns the render half → wrap here.
 *   otherwise ⇒ the plugin already calls applyEffects inside emit() (the 34
 *     pre-universal call sites, which also own their own bbox/world choices) →
 *     return `cmds` untouched. Never both.
 *
 * ── WHY A MORPHED NODE IS THE FIRST CLAUSE, AND WHAT IT FIXES ────────────────
 * The user's ruling (2026-08-02, verbatim, WORKSTREAM AV): "If I have bloom at
 * zero strength and then another one at full strength in the middle of the morph,
 * just like anything else, in the middle of that morph, it should be
 * interpolating, just like it normally would if it wasn't morphing. This should be
 * the same for every single property."
 *
 * The old two-clause rule read the plugin's flag and NOTHING ELSE, so a morphing
 * SHAPE — rect, circle, latex, plaintext, the whole vector family, every one of
 * which is a SELF-EFFECTING plugin (`effectsInjected: false`) — took the third
 * clause and got NO EFFECT SUBTREE AT ALL. Its own emit() would have composed the
 * bundle, but morphIR replaced that emit(); the walker then declined to wrap
 * because the plugin "does it itself". Measured before this line existed: a
 * gaussianBlur of 10, tweened across a morph, produced ops with no effectSubtree
 * at every interior alpha and the full blur at the endpoints — which reads to an
 * author exactly as the reported "it just flicks on, like a step at the end".
 *
 * `node.state` is the TWEENED bag (core/derive.js resolves the morph token but
 * leaves every other leaf alone — measured identical to the same document with
 * morph off), so wrapping here gives the morphed ops precisely the effects a
 * NON-morphed node would carry at that alpha. That is the whole law: the morph
 * owns the shape, the ordinary seams own everything else.
 *
 * A CROSSFADE takes this clause too, and must. crossfadeIR calls both endpoint
 * plugins' emit() directly, so a self-effecting pair would compose each ENDPOINT's
 * effects from its ENDPOINT state — two discrete looks cross-dissolving, not one
 * tweened look. The wrap here is the tweened one, and it is the only one an
 * injected-effects plugin gets at all.
 *
 * The order the hand-written sites established — applyEffects OUTSIDE
 * decorateStrokedBox, so a bordered photo's shadow is the framed photo's shadow
 * — is preserved automatically: `cmds` is whatever emit() finally returned,
 * decoration included.
 *
 * BYTE-IDENTITY: effectsOff(state) short-circuits before any bounds are
 * computed, so an effect-free document produces the exact same IR it did before
 * the walker wrap existed — the established soft-edges precedent.
 *
 * @param {object} node - a core/derive render node ({plugin, state, world})
 * @param {object[]} cmds - the node's emitted LOCAL-space ops
 * @returns {object[]} `cmds`, or [effectSubtree(...)] wrapping it
 *
 * @example applyNodeEffects({plugin: {capabilities: {bbox: true}}, state: {softEdges: 8}, world: {}}, [{op: "rect"}]) // [{op: "rect"}] (plugin composes the bundle itself — not injected)
 * @example applyNodeEffects({plugin: {capabilities: {bbox: true}, effectsInjected: true}, state: {w: 10, h: 10}, world: {x: 0, y: 0, rotation: 0, scale: 1}}, [{op: "rect"}]) // [{op: "rect"}] (all effects off → byte-identical pass-through)
 * @example applyNodeEffects({plugin: {capabilities: {bbox: true}, effectsInjected: true}, state: {w: 10, h: 10, softEdges: 8}, world: {x: 0, y: 0, rotation: 0, scale: 1}}, [{op: "rect"}])[0].softEdges // 8
 * @example // AV: a MORPHING self-effecting plugin gets the wrap anyway — its emit() was replaced
 * @example applyNodeEffects({morph: {t: 0.5}, plugin: {capabilities: {bbox: true}}, state: {w: 10, h: 10, gaussianBlur: 6}, world: {x: 0, y: 0, rotation: 0, scale: 1}}, [{op: "path"}])[0].blur // 6
 */
export function applyNodeEffects(node, cmds) {
  // WORKSTREAM AV: a morphed node's plugin emit() was ROUTED AWAY (ports.morphIR /
  // crossfadeIR produced `cmds`), so whatever the plugin would have composed for
  // itself did not happen and the walker owns the render half unconditionally.
  if (!node.morph && !node.plugin.effectsInjected) return cmds;
  if (effectsOff(node.state)) return cmds;
  const { bbox, world } = effectBoundsOf(node);
  return applyEffects(cmds, node.state, world, bbox);
}
