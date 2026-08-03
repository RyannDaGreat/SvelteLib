/**
 * sceneIR — render tree → flat display-list IR via each plugin's emit().
 *
 * emit(state) is paint(ctx, state)'s IR twin: same geometry, no ctx — the
 * device-independent display list that the WebGPU and vector backends
 * consume (manifest "RENDER MODES DECISION"). The prototype's port bodies
 * moved INTO the plugins (plugins/*.js emit()); this module keeps only the
 * scene walker and the future video plugin's emit body.
 *
 * Plugins emit LOCAL-space commands; sceneIR wraps every node's commands in
 * its world transform. Widgets with no transform state (arrow, blur) get an
 * IDENTITY world from T.fromState, so the wrap is uniform — no world-space
 * special cases.
 *
 * Callers pass a render tree derived from an EVALUATED state
 * (core/expressions.evaluateState) — equations are already numbers.
 *
 * DOM-free pure JS (bare-node testable).
 */

import { video, pushTransform, popTransform, signedCompose, isMaterialPaint, isCrossfadePaint, isPaintOff, applyStrokeTrim, applyStrokeOffset, applyStrokeJoin, parsePaint, isPaintableFrame, rect, text, path } from "./ir.js";
import { morphPaths, payloadToPathD, assertMorphPaths, midMorphFillRule } from "../core/morph.js";
import { statePaint, STATE_PAINT_MARK } from "../core/morph_payload.js";
import { isVisibleFxToken, visibleLevel, isPaintShaped, modeParams, CROSSFADE_PAINT_TYPE } from "../core/interp_modes.js";
import { deepEqual } from "../core/deltas.js";
import { MANIM_SKETCH_STROKE_WIDTH, manimDrawPlan, sketchStrokePaint, trimSubpathByLength } from "../core/manim_draw.js";
import { interpolate } from "../core/interpolators.js";
import { applyNodeEffects, withEffectsStripped } from "./effects.js";
import { resolveMaterialPaint } from "./skia/materials.js";
import { hasStrokeMaterial } from "./skia/stroke_materials.js"; // the STROKE-material roster — WHICH materials can be a stroke at all (canStrokeWithPaint)
import { reportOnce, warnOnce } from "../core/report.js";
import { errorAffordanceArgs, errorBoxExtent, errorMessage, describeOwner, throwMessage, isConfigurationError, configurationError } from "../core/paint_containment.js";

/**
 * Pure function (the report sink aside). Ops with every MATERIAL paint RESOLVED,
 * in ALL FOUR slots an op can carry one — `fill`, `stroke`, a text op's `color`,
 * and a rich text op's per-RUN `color` — from schema defaults ⊕ the paint's
 * sparse stored params ⊕ the material's optional sceneParams hook (sky reads its
 * sibling suns there).
 * THE one resolution site: painters require `resolvedParams` and throw
 * without it, so a path that skipped this pass fails loudly instead of
 * rendering with half its knobs missing. Recurses into subtree ops' `content`
 * (crop/effect subtrees are flattened independently and would otherwise
 * escape). Ops without material fills pass through IDENTICALLY (same object,
 * zero cost on the common path).
 *
 * @param {object[]} cmds - a node's emitted ops
 * @param {object} node - the emitting render node (scene hooks read it)
 * @param {Map} nodesById - itemId → node (scene hooks read siblings)
 * @returns {object[]}
 *
 * @example resolveMaterialFillPaints([{op: "rect", fill: "#fff"}], null, null)[0].fill // "#fff"
 * @example resolveMaterialFillPaints([{op: "rect", fill: {type: "material", material: {id: "comic"}}}], null, null)[0].fill.resolvedParams.mode // "cmyk"
 * @example resolveMaterialFillPaints([{op: "text", color: {type: "material", material: {id: "comic"}}}], null, null)[0].color.resolvedParams.mode // "cmyk"
 * @example resolveMaterialFillPaints([{op: "text", color: "#000"}], null, null)[0].color // "#000" (untouched)
 * @example resolveMaterialFillPaints([{op: "rect", fill: {type: "crossfade", from: "#f00", to: {type: "material", material: {id: "comic"}}, t: 0.5}}], null, null)[0].fill.to.resolvedParams.mode // "cmyk" (resolved THROUGH the crossfade)
 */
/**
 * Query (reads registries; reports once on unknown knobs). The camera
 * BACKGROUND as a PAINTER-READY fill: parsed, and — when it is a MATERIAL
 * paint — resolved against the scene. THE ONE PAINT SLOT emitNode's resolution
 * cannot reach: the background rect is hand-assembled by web/cameraFrame.js and
 * web/CanvasView.svelte OUTSIDE sceneIR (no emitting node exists for it), so a
 * material background used to reach the painter UNRESOLVED and threw on every
 * frame — the app wedged, and persisted across reloads because the paint is
 * stored in the doc (the camera-background freeze, user-reported live).
 * A non-material background returns parsePaint's result byte-identically.
 *
 * AND IT GOES THROUGH resolvedPaint, WHICH IS THE SIXTH SLOT OF THAT HELPER'S
 * FIVE. This function used to test `isMaterialPaint` inline, which is exactly
 * the bug resolvedPaint was written to kill: a background mid-`blend` is the
 * `{type: "crossfade", from, to, t}` wrapper, that test answers FALSE, and both
 * material sides reached the painter unresolved. The user hit it on the slot AC's
 * five-slot fix could not reach, because the background is not an op slot at all
 * (2026-08-02): "when interpolating from material to material, blend does not
 * seem to do what it's supposed to do… It just gives me a big error when I
 * interpolate and I fade between two materials on the background."
 * THE LESSON, since this is the second time: a bare `isMaterialPaint` test on
 * paint that came out of the FOLD is a latent crossfade bug. Foldable paint can
 * always arrive wrapped, so every such site is either resolvedPaint or wrong.
 *
 * @param {*} background - the camera's stored background paint
 * @param {Array|null} nodes - the derived render nodes (scene hooks read them)
 * @returns {*} a fill the painters accept
 *
 * @example resolvedBackgroundFill("#123f5a", []) // [0.070..., 0.247..., 0.352..., 1]
 * @example resolvedBackgroundFill({type: "material", material: {id: "comic", params: {}}}, []).resolvedParams.mode // "cmyk"
 * @example resolvedBackgroundFill({type: "crossfade", from: {type: "material", material: {id: "sky"}}, to: {type: "material", material: {id: "comic"}}, t: 0.5}, []).to.resolvedParams.mode // "cmyk" (resolved THROUGH the crossfade)
 */
export function resolvedBackgroundFill(background, nodes) {
  const byId = new Map((nodes ?? []).map((n) => [n.itemId, n]));
  const camera = (nodes ?? []).find((n) => n.type === "camera") ?? null;
  // parsePaint FIRST, so a non-material background is byte-identical to before
  // (the contract above). resolvedPaint returns anything that is neither a
  // material nor a crossfade by identity, so that result passes straight out.
  // Foreign-knob carry-over inside is intended and lossless — warn, never error.
  return resolvedPaint(parsePaint(background), camera, byId);
}

/**
 * Pure function (the report sink aside). ONE PAINT, resolved — and resolved
 * THROUGH A CROSSFADE, which is the whole reason this exists as a named helper
 * rather than six inline `isMaterialPaint` tests. (Five when it was written —
 * the sixth is resolvedBackgroundFill above, which had its own inline test, and
 * which the user's material→material background blend broke the day after. That
 * is the argument for the helper restated as evidence: the count grows, and a
 * respelled test is a bug waiting for the slot it was respelled into.)
 *
 * A CROSSFADE IS A PAINT THAT CONTAINS PAINTS. Mid-transition the `blend` interp
 * mode replaces a slot's value with `{type: "crossfade", from, to, t}` — and that
 * wrapper is NOT a material paint, so every `isMaterialPaint(slot)` test answers
 * FALSE and a material hidden on either side went UNRESOLVED. The painter's
 * contract is that it throws on absent `resolvedParams`, so the whole op was
 * caught by paint containment and drawn as the red "failed to paint" box on
 * exactly the interior frames of a transition — the user's report (2026-08-02):
 * "unknown item failed to paint when i am tweening… one of which has a linear
 * gradient and one of which has the sky shader… is this a generalized problem".
 * It was: measured, EVERY from × to pair with a material on EITHER side errored,
 * including material→material and material→solid. Only gradient→gradient and
 * solid→solid survived, which is precisely why it read as "fine with going from
 * a gradient to a gradient".
 *
 * WHY THE FIX IS HERE AND NOT IN THE PAINTER'S ROUTER. The router
 * (paint_skia.js "THE CROSSFADE ROUTER") is correct as written: crossfadeSide
 * hands back an ORDINARY op that re-enters the op loop, so a material side
 * reaches handleMaterialPaintShape and a backdrop-class material reaches
 * handleMaterialBackdrop with its below-content supply intact. Verified by
 * pre-resolving the operands by hand — sky, crt, frosted, metal and
 * vector_pattern all paint correctly through that path. The router never needed
 * the fix; resolution simply never reached the operands. Resolving here keeps the
 * "THE one resolution site" promise the docblock above makes, and every slot and
 * every backend inherits it at once.
 *
 * Non-crossfade paints take the original path byte-identically, and a crossfade
 * whose sides need no resolution is returned BY IDENTITY (no allocation).
 *
 * @param {*} paint - any paint value, or undefined
 * @returns {*} the paint with any material inside it resolved
 *
 * @example resolvedPaint("#fff", null, null) // "#fff" (untouched, same value)
 * @example resolvedPaint({type: "material", material: {id: "comic"}}, null, null).resolvedParams.mode // "cmyk"
 * @example resolvedPaint({type: "crossfade", from: "#f00", to: {type: "material", material: {id: "comic"}}, t: 0.5}, null, null).to.resolvedParams.mode // "cmyk"
 */
function resolvedPaint(paint, node, nodesById) {
  if (isMaterialPaint(paint)) return resolveMaterialPaint(paint, node, nodesById, warnOnce);
  if (!isCrossfadePaint(paint)) return paint;
  const from = resolvedPaint(paint.from, node, nodesById);
  const to = resolvedPaint(paint.to, node, nodesById);
  return from === paint.from && to === paint.to ? paint : { ...paint, from, to };
}

export function resolveMaterialFillPaints(cmds, node, nodesById) {
  return cmds.map((cmd) => {
    let out = cmd;
    // Each slot goes through resolvedPaint, which handles BOTH a bare material
    // and one wrapped in a mid-transition crossfade. Identity return on the
    // common path keeps a non-material op allocation-free, as before.
    const fill = resolvedPaint(cmd.fill, node, nodesById);
    if (fill !== cmd.fill) out = { ...out, fill };
    const stroke = resolvedPaint(cmd.stroke, node, nodesById);
    if (stroke !== cmd.stroke) out = { ...out, stroke }; // same as the fill above
    // TEXT INK IS A THIRD PAINT SLOT, and it is not called `fill`. A text op
    // carries its ink on `color` (ir.js text()), and a RICH text op additionally
    // carries a per-RUN `color` — so a material ink on either would reach the
    // painter unresolved and throw, exactly the way a material camera background
    // did before resolvedBackgroundFill existed. The two slots are resolved here
    // rather than at a text-specific seam because this IS the one resolution site
    // the docblock above promises; a second one would be the drift it warns about.
    const color = resolvedPaint(cmd.color, node, nodesById);
    if (color !== cmd.color) out = { ...out, color };
    // THE GLYPH OUTLINE is a FOURTH paint slot (N2): an outline traced around the
    // letterforms of a text box or an equation, which is not `stroke` because on a
    // latexVector op `stroke` already means the BOX BORDER. Same argument as the
    // text ink above — an unresolved material here reaches the painter and throws.
    const glyphStroke = resolvedPaint(cmd.glyphStroke, node, nodesById);
    if (glyphStroke !== cmd.glyphStroke) out = { ...out, glyphStroke };
    if (Array.isArray(cmd.rich?.runs)) {
      const runs = cmd.rich.runs.map((r) => {
        const c = resolvedPaint(r.color, node, nodesById);
        return c === r.color ? r : { ...r, color: c };
      });
      if (runs.some((r, i) => r !== cmd.rich.runs[i])) out = { ...out, rich: { ...cmd.rich, runs } };
    }
    if (Array.isArray(cmd.content)) {
      const content = resolveMaterialFillPaints(cmd.content, node, nodesById);
      if (content.some((c, i) => c !== cmd.content[i])) out = { ...out, content };
    }
    return out;
  });
}

/**
 * Pure function. The REFLECTION push that realizes a flipped node's mirror, or
 * null for an unflipped node — the render half of the flip (core/derive.js splits
 * a negative stored w/h into a positive box + `node.mirror`; this is where that
 * flag becomes visible ink).
 *
 * The reflection is about the box's own CENTER LINE, so it is `translate(w) then
 * negate x`: local x ↦ w − x maps the box onto itself with its content reversed.
 * That is why a flipped widget occupies the SAME screen rect as its unflipped self
 * — the mirror is an isometry of its own box.
 *
 * Emitted INSIDE pushTransform(node.world), so it composes as a local frame and no
 * plugin's emitted geometry has to know about it. Both axes at once is a point
 * reflection through the center (equivalently a 180° turn), which is exactly what
 * a doubly-flipped box means.
 *
 * KNOWN BOUND — A PROCEDURAL MATERIAL'S PATTERN DOES NOT MIRROR. Vector geometry,
 * raster images and TEXT GLYPHS all mirror correctly, because they ride the canvas
 * CTM this frame becomes (render_gpu/skia/paint_skia.js applyView, pdf
 * cmSimilarity, svg similarityTransform). The per-pixel MATERIAL and BACKDROP
 * handlers do not ride it: they compute their own device-space region and evaluate
 * SkSL at the device root. Their REGION is correct — the center is the mirror's
 * fixed point and `signedApply` places it, and their half-extents are positive
 * because core/derive normalized the sign away — but the pattern inside is
 * generated from (center, half-extents, angle) with no handedness term, so flipping
 * a corkboard or a sky mirrors its BOX and not its grain. For most of these
 * materials that is invisible (they are statistically symmetric); for a directional
 * one it is a real difference. Fixing it means giving `material.pack` a handedness
 * uniform and honouring it per shader — deliberately NOT done here, because it is a
 * change to every material's uniform contract rather than to the flip.
 *
 * @param {object} node - a derive render node; only `.mirror` and `.state.w/h` are read
 * @returns {object|null} a pushTransform op, or null
 *
 * @example mirrorPush({state: {w: 100, h: 50}}) // null (no .mirror: nothing to reflect)
 * @example mirrorPush({mirror: {x: true, y: false}, state: {w: 100, h: 50}}) // {op: "pushTransform", x: 100, y: 0, rotation: 0, scale: 1, signX: -1}
 * @example mirrorPush({mirror: {x: false, y: true}, state: {w: 100, h: 50}}) // {op: "pushTransform", x: 0, y: 50, rotation: 0, scale: 1, signY: -1}
 */
export function mirrorPush(node) {
  if (!node.mirror) return null;
  return pushTransform({
    x: node.mirror.x ? node.state.w : 0,
    y: node.mirror.y ? node.state.h : 0,
    signX: node.mirror.x ? -1 : 1,
    signY: node.mirror.y ? -1 : 1,
  });
}

/**
 * Pure function. Video widget state → IR (local space). `ref` names an entry
 * in the backend's media registry (a <video> element for raster backends).
 * This is the FUTURE video-player plugin's emit body — proven against the
 * GPU external-texture pipeline by bench/video.html; it lives here until
 * that plugin exists.
 *
 * @example videoIR({ref: "clip1", w: 320, h: 180})[0].op // "video"
 */
export function videoIR(s) {
  return [video({ ref: s.ref, x: 0, y: 0, w: s.w, h: s.h, opacity: s.opacity ?? 1 })];
}

/**
 * Pure function. A full render tree (core/derive.js nodes of an evaluated
 * state, already z-sorted) → one flat IR command list: each node's emitted
 * commands wrapped in its world transform. The display-list analogue of the
 * canvas compositor's per-node save/transform/paint/restore loop.
 *
 * A crop-box node (core/derive.resolveCropTargets attaches `.cropTarget`, a
 * full render node or null) is the ONE exception to "plugin.emit() alone
 * decides a node's IR": sceneIR — the one place that sees the WHOLE node
 * list — builds its target subtree's commands here (the crop box plugin
 * can't reach another node) and hands them to the plugin as an argument so
 * cropbox.js still owns the fill/border/region IR shape (manifest fence:
 * derive.js does suppression + ordering, the plugin file owns the box's own
 * visual properties).
 *
 * IMPORTANT: the target's commands are wrapped in its own ABSOLUTE
 * `.world` transform (pushTransform(node.cropTarget.world)), NOT a transform
 * relative to the crop box. cropSubtree's `content` is a SEPARATE,
 * self-contained, independently-flattened IR list (both backends
 * flattenIR() it fresh, from identity — render_gpu/skia/paint_skia.js's
 * cropSubtree case and pdf_backend.js's emitRegion never nest it inside the crop
 * box's own pushTransform), so it must carry the SAME absolute world every
 * other node's commands do — that is what lets the crop box's re-render use
 * the SAME outer view/camera mapping as the rest of the scene (no relative-
 * transform math needed, and no risk of double-composing against the box's
 * own transform).
 *
 * RENDER-TIME DISPLAY CONTEXT (manifest RENDER PIVOT 2026-07-23): a display
 * surface that knows the live view (CanvasView, PresentMode) may pass
 * `pdfDisplay` — a Map<itemId, descriptor> built by the PDF re-raster pre-pass
 * (render_gpu/pdf_display.preRasterizePdfPages). sceneIR looks up THIS node's
 * descriptor and hands it to emit() as a 4th argument (a per-node render
 * context `{pdfDisplay, mapTiles}`). The MAP tile pre-pass
 * (render_gpu/map_display.prepareMapTiles) rides the same seam for the same
 * reason: a map's tile DEPTH follows the camera and its tile LIST follows the
 * visible crop, neither of which emit() may see. The THIRD, `scene3d`
 * (render_gpu/scene3d_display.prepareScene3dViews), is the same shape once more:
 * a 3D viewport's render RESOLUTION follows the camera and its sub-frustum follows
 * the visible crop. This is the ONLY view-derived data emit ever sees,
 * and only pdf_page reads it (to draw the crisp visible-region raster instead of
 * a whole-page bitmap); every other plugin ignores the 4th arg. Surfaces with no
 * pre-pass (export, thumbnails, CLI, tests) pass nothing → emit takes its
 * camera-free fallback (vector for export, whole-page raster otherwise). emit
 * stays PURE (same args → same output); the map is a plain argument, never a
 * global the walker reaches into.
 *
 * `live` RIDES THE SAME SEAM AND IS NOT A PRE-PASS. It is one boolean answering
 * one question: WILL THIS SURFACE REPAINT when an asynchronous raster lands? The
 * editor canvas will (it subscribes to image_registry.onImageLoad); a thumbnail,
 * a PNG export and the CLI hook will not — they capture once. A widget whose
 * raster is not ready yet can therefore show a STALE frame on the first kind of
 * surface, where it is a few milliseconds of slightly-old picture instead of a
 * transparent hole, and must NOT on the second, where it would be the shipped
 * picture. render_gpu/gpu/scene3d_raster.scene3dDrawRef is the first reader; the
 * flag is general because the question is (any async-raster widget has it), and
 * `false` — every existing caller — is byte-identical to before it existed.
 *
 * Args:
 *   nodes (object[]): deriveRenderTree output (nodes carry .plugin)
 *   ctx ({pdfDisplay?: Map, mapTiles?: Map, scene3d?: Map, live?: boolean}): optional render-time display context (see above)
 *
 * Returns:
 *   object[]: IR commands (z-ordered because nodes are)
 *
 * @example // sceneIR(deriveRenderTree(evaluateState(state, registry).state, registry)) → [pushTransform, rect, popTransform, ...]
 * @example sceneIR([]) // []
 */
export function sceneIR(nodes, ctx = {}) {
  // ONE normalized display context travels down the walk, rather than one
  // positional argument per pre-pass. Two of them were already threaded through
  // three function signatures by hand; a third (`live`) and the fourth this
  // widget family will need would make that a five-argument recursion whose call
  // sites have to be edited in lockstep — the hand-maintained-mirror shape the
  // convention ledger names as this codebase's worst recurring defect.
  const display = {
    pdfDisplay: ctx.pdfDisplay ?? null,
    mapTiles: ctx.mapTiles ?? null,
    scene3d: ctx.scene3d ?? null,
    live: ctx.live === true,
  };
  const byId = new Map(nodes.map((n) => [n.itemId, n]));
  const out = [];
  for (const node of nodes) {
    // A FOLDED GROUP MEMBER (core/derive.resolveGroupSubtrees marked it foldedBy)
    // is NOT drawn at the top level — it renders INSIDE its owning group's
    // composited subtree (built by emitNode below), so the group's shadow/bloom/
    // blend/crop wraps it as one unit. Every non-folded node draws normally.
    if (node.foldedBy) continue;
    out.push(...emitNode(node, byId, display));
  }
  return out;
}

/**
 * Pure function. The names of the transform fields that are NOT finite, in the
 * order `pushTransform` validates them — what the error affordance and the report
 * line say instead of a bare "something is NaN".
 *
 * @param {object} t - a transform-ish {x, y, rotation, scale}
 * @returns {string[]} the offending field names (empty when the frame is fine)
 *
 * @example nonFiniteFrameFields({x: 5, y: 6, rotation: 0, scale: 1})
 * []
 * @example // the live defect: a zero-size canvas made both translation terms NaN
 * nonFiniteFrameFields({x: NaN, y: NaN, rotation: 0, scale: 1})
 * [ 'x', 'y' ]
 * @example nonFiniteFrameFields({x: 0, y: 0, rotation: 0, scale: Infinity})
 * [ 'scale' ]
 */
export function nonFiniteFrameFields(t) {
  const { x = 0, y = 0, rotation = 0, scale = 1 } = t ?? {};
  return Object.entries({ x, y, rotation, scale })
    .filter(([, v]) => typeof v !== "number" || !Number.isFinite(v))
    .map(([k]) => k);
}

/**
 * Pure function. THE CONTAINMENT AFFORDANCE for a node whose world transform is
 * not paintable: a red-bordered box naming the item and the offending fields,
 * emitted at the IDENTITY frame.
 *
 * WHY IDENTITY AND NOT node.world: the node's own world is precisely the thing
 * that cannot be pushed. Drawing the affordance through it would rethrow, which
 * is the crash this function exists to prevent. So the box lands at the world
 * origin — visible, findable, and honest that the widget has no usable position.
 *
 * @param {object} node - the render node (reads .itemId, .state.name/.type/.w/.h)
 * @param {string[]} fields - the non-finite field names (nonFiniteFrameFields)
 * @returns {object[]} rect + text IR, already at identity (no push/pop needed)
 *
 * @example // a text item whose x/y evaluated to NaN draws a named red box:
 * nonFiniteAffordanceIR({itemId: "cf17cc12", state: {type: "text", w: 260, h: 48}}, ["x", "y"]).length
 * 2
 * @example nonFiniteAffordanceIR({itemId: "a1", state: {type: "rect", w: 10, h: 10}}, ["x"])[0].op
 * 'rect'
 */
export function nonFiniteAffordanceIR(node, fields) {
  const s = node.state ?? {};
  // Built through the REAL IR builders, never as raw literals: every backend
  // requires parsePaint'd colours, and a hand-written "#c0392b" produces an op
  // that silently draws NOTHING (measured — see core/paint_containment.js).
  const a = errorAffordanceArgs(
    errorBoxExtent(s.w),
    errorBoxExtent(s.h),
    errorMessage(s.name || s.type || node.itemId, `${fields.join("/")} is not a finite number`),
  );
  return [rect(a.rect), text(a.text)];
}

/**
 * Near-pure function (reportOnce logs to console on failure — see below).
 * Emits ONE render node's IR (its emitted ops wrapped in its world
 * transform), resolving the two cross-node subtree seams sceneIR owns:
 *
 *   CROP BOX — the target's own IR (wrapped in the target's ABSOLUTE world), or
 *     null, handed to cropbox.emit() as arg 2 (see the sceneIR doc for why the
 *     target carries its own absolute world, not one relative to the box).
 *   GROUP SUBTREE (the subtree-effects gap) — a group folding its member subtree
 *     into one composited unit: its members' ABSOLUTE-world IR (each recursively
 *     emitted — already wrapped in pushTransform(member.world)), handed to
 *     group.emit() through the SAME arg-2 seam, which nests it in ONE
 *     effectSubtree / cropSubtree. core/derive attaches subtreeMemberIds
 *     (z-ordered, present members only); the members carry foldedBy so the
 *     top-level walk skips them, but emitNode itself never skips — a member
 *     looked up here always renders (nested folding groups fall out naturally).
 *
 * @param {object} node - a derive render node (carries .plugin/.state/.world)
 * @param {Map} byId - itemId → node, for folded-member lookup
 * @param {Map|null} pdfDisplay - per-node PDF re-raster descriptors (or null)
 * @returns {object[]} IR (empty when the node emits nothing — a pure ghost)
 *
 * ── THE EMIT-TIME CONTAINMENT BOUNDARY ──────────────────────────────────────
 * The paint-time boundary (render_gpu/skia/paint_skia.js paintNodeRun) stops a
 * throw at the PAINTER; this is its twin one seam EARLIER, at the point a
 * plugin's own emit() runs. Both are needed: paintNodeRun cannot catch a throw
 * that never reaches paint at all, because emitNode's own return value (the IR
 * list) is what feeds paintFlat, sceneIR's PDF/SVG callers, and every
 * cameraFrame consumer alike — a throw HERE, before any of them, used to take
 * the whole scene down with it (a plugin's emit() calling a validator that
 * rejects a NaN param, e.g. "materialBackdrop: param lightOffsetX is a
 * non-finite number", live in demo_god_rays). One try wraps this node's WHOLE
 * contribution — its own emit(), the material-fill resolution, and (for a crop
 * box) its target's inline emit() — because all of it is one node's ops from
 * the caller's point of view, exactly the run paintNodeRun already treats as
 * the unit. A GROUP's folded members recurse through emitNode itself, so each
 * member gets its OWN boundary for free — a poisoned member costs itself, not
 * its siblings or the group.
 *
 * Reported ONCE per node+message (reportOnce — this runs every frame). A
 * BACKEND-CONFIGURATION failure (isConfigurationError) is the caller's wiring,
 * broken for the whole surface, and escapes untouched — the same line
 * paintNodeRun draws, applied at the seam one step earlier.
 */
function emitNode(node, byId, display) {
  try {
    return emitNodeBody(node, byId, display);
  } catch (e) {
    if (isConfigurationError(e)) throw e;
    const msg = throwMessage(e);
    const who = describeOwner({ itemId: node.itemId, type: node.type, state: node.state });
    if (reportOnce(
      `ports:emit:${node.itemId}:${msg}`,
      `PowerRP: item ${who} failed to EMIT — ${msg}. It is drawn as an error box; the rest of the scene still paints. Delete or fix that item to clear it.`,
    )) console.error(e); // the real stack, once — a determinism bug must stay diagnosable
    const a = errorAffordanceArgs(errorBoxExtent(node.state?.w), errorBoxExtent(node.state?.h), errorMessage(who, `failed to emit — ${msg}`));
    const owner = ownerTag(node);
    // THE MIRROR STILL APPLIES. Unlike node.world (which the non-finite branch
    // above must draw at IDENTITY because the world itself may be the poison),
    // mirrorPush only reads node.mirror/state.w/h — never anything the throwing
    // emit() touched — so it is safe here, and skipping it would make a flipped
    // widget's own error box fail the sign-blindness contract every other
    // affordance honours (tests/negative_size_test.js: "the signed spellings
    // must emit a REFLECTED transform").
    const mirror = mirrorPush(node);
    return mirror
      ? [{ ...pushTransform(node.world), owner }, mirror, rect(a.rect), text(a.text), popTransform(), popTransform()]
      : [{ ...pushTransform(node.world), owner }, rect(a.rect), text(a.text), popTransform()];
  }
}

/**
 * Near-pure function (reportOnce logs to console and remembers the key —
 * see core/report.js). emitNode's happy path, split out so the boundary above
 * can wrap the WHOLE thing in one try without the try itself hiding in the
 * middle of the logic it protects.
 *
 * @param {object} node - a derive render node (carries .plugin/.state/.world)
 * @param {Map} byId - itemId → node, for folded-member lookup
 * @param {{pdfDisplay: Map|null, mapTiles: Map|null, live: boolean}} display - the normalized render-time display context sceneIR built
 * @returns {object[]} IR (empty when the node emits nothing — a pure ghost)
 */
function emitNodeBody(node, byId, display) {
  // A plugin registered with no emit() is a BROKEN REGISTRY ENTRY, not document
  // poison — no document authored the missing method, so no red box on one item
  // describes it honestly. Branded so the emit-time boundary below rethrows it,
  // exactly like the "no rasterize callback" case at export time.
  if (!node.plugin?.emit) throw configurationError(new Error(`sceneIR: plugin "${node.type}" has no emit()`));
  // ── THE NON-FINITE CONTAINMENT SEAM ────────────────────────────────────────
  // A BROKEN WIDGET COSTS ITSELF, NEVER THE FRAME — the plugin-emit red-box rule
  // (50a50bc), applied to the other way a node can be unpaintable: its numbers.
  // This is the ONE place a derived node's evaluated transform enters paint, so
  // one test here covers every pixel consumer (canvas, minimap, thumbnails,
  // exporters) — they all walk this function.
  //
  // WHAT IT PREVENTS, MEASURED (live user report, 2026-07-30): a text item added
  // while the canvas was still 0×0 evaluated to a NaN x/y (fitRectView divides by
  // the canvas size → zoom 0 → a non-finite screen→world conversion). pushTransform
  // correctly refused it — but it refused it EVERY rAF tick, uncaught, so the whole
  // canvas stopped painting over one widget's bad number. The refusal was right;
  // its BLAST RADIUS was wrong.
  //
  // Reported ONCE per item+fields (reportOnce): this runs in a frame loop, so an
  // un-deduped line would be the same console flood by another name. The item and
  // the offending properties are named, in the console AND on the canvas, because a
  // silently-skipped widget would be the silent failure this codebase forbids.
  const badFields = nonFiniteFrameFields(node.world);
  if (badFields.length) {
    reportOnce(
      `ports:nonfinite:${node.itemId}:${badFields.join(",")}`,
      `PowerRP: item "${node.itemId}" (${node.state?.type}) has a non-finite world transform (${badFields.join(", ")}) — it is drawn as an error box and the rest of the scene still paints. An equation or a placement produced NaN/Infinity.`,
    );
    return nonFiniteAffordanceIR(node, badFields);
  }
  // GROUP SUBTREE: build the folded members' absolute-world IR (recursively).
  const subtreeIR = node.type === "group" && Array.isArray(node.subtreeMemberIds) && node.subtreeMemberIds.length
    ? node.subtreeMemberIds.flatMap((id) => (byId.has(id) ? emitNode(byId.get(id), byId, display) : []))
    : null;
  const targetWorldIR = node.type === "cropbox" && node.cropTarget
    ? [pushTransform(node.cropTarget.world), ...node.cropTarget.plugin.emit(node.cropTarget.state), popTransform()]
    : null;
  // The per-node RENDER CONTEXT: each view-aware pre-pass's descriptor FOR THIS
  // NODE, plus the surface-wide `live` answer. Null when the caller supplied
  // NEITHER a pre-pass NOR `live` (export, thumbnails, the CLI, tests), which is
  // the signal every consuming plugin reads to take its camera-free fallback.
  // `live` participates in that test so a surface that repaints but happens to
  // hold no PDF and no map still reaches its widgets — without it, the flag would
  // silently evaporate on exactly the scenes it matters for.
  const renderCtx = display.pdfDisplay || display.mapTiles || display.scene3d || display.live
    ? {
        pdfDisplay: display.pdfDisplay?.get(node.itemId) ?? null,
        mapTiles: display.mapTiles?.get(node.itemId) ?? null,
        scene3d: display.scene3d?.get(node.itemId) ?? null,
        live: display.live,
      }
    : null;
  // emit() gets a subtree as arg 2 (a group's members' IR, or a crop box's target
  // IR — mutually exclusive) and its ABSOLUTE world as arg 3 (the SHARED
  // STROKED-BOX BUNDLE seam — manifest "SHARED STYLE BUNDLES"): a box-like media
  // widget (image/video/filmstrip) decorates its content with a cropSubtree
  // border/rounded-clip via render_gpu/decorate.js, and both a cropSubtree's and
  // an effectSubtree's `content` is flattened INDEPENDENTLY (from identity), so it
  // must carry its own absolute world — the outer pushTransform(node.world) wrap
  // below reaches the emitted ops but NOT into a subtree op's separately-flattened
  // content. Plugins that don't decorate ignore these args (they destructure only
  // `state`); cropbox + group use arg 2, decorators use arg 3.
  // THE FLIP (mirrorPush above). The reflection wraps EVERYTHING the node draws,
  // effects included — a flipped widget's drop shadow falls on its flipped side,
  // which is the behaviour a flip means (and matches PowerPoint). That is why the
  // mirror is folded into the world handed to emit() as arg 3 as well: an effected
  // or decorated widget's `content` is flattened INDEPENDENTLY from identity (see
  // the arg-3 note below), so the outer push below cannot reach it and the mirror
  // has to travel with the absolute world instead.
  // THE GROW RAMP (WORKSTREAM BS, core/interp_modes.js `grow`), resolved HERE
  // because the world transform is the deepest seam a shader structurally cannot
  // opt out of — see growScaledWorld for the ruling and why the state and the ops
  // are both wrong places for it. It is the FIRST thing computed from node.world
  // so that EVERY later use is the grown one: the outer push below, the emitWorld
  // handed to emit() as arg 3 (a decorated widget's `content` is flattened
  // independently, so the outer push cannot reach it), and the mirror composition
  // in between. Returns node.world BY IDENTITY for every node that is not
  // mid-grow, so this line is free everywhere else.
  const grownWorld = growScaledWorld(node.world, node.state);
  const mirror = mirrorPush(node);
  const emitWorld = mirror ? signedCompose(grownWorld, mirror) : grownWorld;
  // THE MORPH SEAM. A node core/derive.js marked `.morph` is mid-retype between
  // two vector widgets, and its ink is the BLEND of their outlines rather than
  // either plugin's own emit() — see morphIR. This is deliberately a REPLACEMENT
  // and not a wrap: at t = 0.4 the widget is neither a rect nor a circle, so
  // drawing either endpoint's own ops (or both) would show a shape the transition
  // does not pass through. Everything downstream is untouched, because a morph
  // emits ordinary `path` ops: the effects seam, the three stroke seams and the
  // fade seam all apply exactly as they do to any other widget, and every backend
  // — Skia, PDF, SVG and the bare-node CLI — already paints `path`.
  // THE NAMED-VISIBILITY STATE, resolved BEFORE emit() and used for every seam
  // below it (core/interp_modes.js `~visibleFx`). A `blurFade` node's DEFOCUS
  // rides the widget's own `gaussianBlur` effect leaf, and it has to be in the
  // state the PLUGIN sees, not only the state the walker sees: 34 plugins call
  // applyEffects inside their own emit() and the registry injects it for the
  // rest, so composing later would reach the injected half only — a widget whose
  // plugin effects itself would fade without ever defocusing, with no error.
  // Returns `node.state` BY IDENTITY for every other node, which is what keeps
  // the evaluation memo alive and this line free everywhere else.
  const fxState = blurFadeState(node.state);
  const fxNode = fxState === node.state ? node : { ...node, state: fxState };
  const cmds = resolveMaterialFillPaints(
    node.morph ? morphIR(node) : node.plugin.emit(fxState, subtreeIR ?? targetWorldIR, emitWorld, renderCtx),
    node, byId,
  );
  if (cmds.length === 0) return [];
  // THE UNIVERSAL EFFECTS SEAM. This is the ONE place every rendered node passes
  // through, so the shared effects bundle (shadow / bloom / blend / inner shadow
  // / soft edges) is applied HERE for every plugin core/registry.js injected it
  // into — a plugin CANNOT forget it, which is the whole point (28 of 74 plugins
  // had no effect rows when eligibility was four hand-copied lines per file).
  // applyNodeEffects returns `cmds` untouched both for the 34 plugins that call
  // applyEffects inside their own emit() (never a double wrap) and whenever every
  // effect is off (byte-identical to before this seam existed).
  // THE UNIVERSAL STROKE-TRIM SEAM (manifest E.12-15), the exact sibling of the
  // effects seam above: every stroked box inherits strokeStart/End/Phase + caps
  // from its state here, stamped onto its own stroked ops (render_gpu/ir.js
  // applyStrokeTrim). A node with no trim (every existing document) returns `body`
  // untouched and byte-identical, and it never reaches a foreign group member /
  // crop target (they carry no trim and the stamp does not recurse crop content).
  // THE UNIVERSAL STROKE-ALIGNMENT SEAM, stacked on the same choke point: the
  // inner/outer knob (strokeOffset) is stamped for every stroked box exactly as
  // the trim fields are, and is likewise absent-when-centered — so this line adds
  // nothing to any existing document's ops.
  // THE UNIVERSAL STROKE-JOIN SEAM, the third on the same choke point: how a
  // stroke turns a CORNER (strokeJoin + strokeMiter), stamped for every stroked
  // box exactly as the two above are, and likewise absent at the identity
  // (miter, STROKE_MITER_LIMIT) — so this line too adds nothing to any existing
  // document's ops.
  // THE UNIVERSAL FADE SEAM, stacked on the same choke point as the three
  // stroke seams above and for the same reason: it must reach every plugin and no
  // plugin may be able to forget it. `active` is normally a boolean, but a leaf
  // whose interp mode is `fade` (core/interp_modes.js) folds to a FRACTION on the
  // strictly-interior frames of a transition — active: 0.3 means "this item is
  // 30% faded in". applyActiveFade multiplies that fraction into every op's
  // opacity. A boolean `active` (every document that does not use the mode, and
  // both endpoints of every one that does) returns `body` UNTOUCHED and
  // byte-identically, so this line adds nothing to any existing picture.
  // THE NAMED-VISIBILITY INK, the other half of the seam `fxState` opened above:
  // a `manim` node's ops are its half-traced OUTLINE rather than its own emit()
  // (manimIR). Every seam below is untouched — a half-drawn widget's effects,
  // stroke trim, join and fade all apply exactly as they do to any other, because
  // what manimIR emits is ordinary `path` ops.
  // `byId` rides along because the sketch STROKE is read out of state, not out of
  // an op, so resolveMaterialFillPaints above never saw it — manimIR resolves it
  // itself, and a scene-sampling material needs the scene (manimSketchStroke).
  const inked = manimIR(node, cmds, byId);
  const body = applyActiveFade(fxState, applyStrokeJoin(fxState, applyStrokeOffset(fxState, applyStrokeTrim(fxState, applyNodeEffects(fxNode, inked)))));
  // THE OWNER TAG — this node's identity, hung on the ONE push that opens its op
  // run, so the PAINT-TIME boundary can name the item it had to contain
  // (render_gpu/skia/paint_skia.js paintFlat; flattenIR carries the tag down onto
  // every op emitted under it). It rides the push rather than each op because
  // that is O(1) per node instead of O(ops), and because a node's ops are
  // EXACTLY the run between its push and its matching pop — the grouping the
  // boundary needs is already in the structure.
  const owner = ownerTag(node);
  return mirror
    ? [{ ...pushTransform(grownWorld), owner }, mirror, ...body, popTransform(), popTransform()]
    : [{ ...pushTransform(grownWorld), owner }, ...body, popTransform()];
}

/**
 * Pure function. THE MORPH EMIT — a mid-morph node's ops: the two endpoint
 * outlines blended by core/morph.js and drawn as ONE path op per subpath, in
 * place of either endpoint plugin's own emit().
 *
 * ── WHY HERE AND NOT IN A PLUGIN ─────────────────────────────────────────────
 * A morph is inherently about TWO widget types, and no plugin may import another
 * (the registry fence). ports.js is the one place a node's ops are decided and it
 * already owns exactly this kind of cross-node composition — the crop box's
 * target subtree and the group's folded members are both built here for the same
 * reason. core/derive.js resolved WHICH two plugins (it holds the registry); this
 * function asks them for their outlines and blends.
 *
 * ── THE UNIT-SPACE MAPPING, WHICH IS THE WHOLE TRAP ──────────────────────────
 * `morphPaths` returns UNIT-space output BY DESIGN (core/morph.js's `space`
 * note). The two widgets have different boxes and those boxes ALREADY tween as
 * ordinary property state through core/interpolators.js — the node this function
 * is handed is already at its tweened w/h. So the morphed outline is scaled by
 * the NODE'S CURRENT BOX and nothing else:
 *
 *     screen-local = unit × {w, h} of the node
 *
 * Interpolating the two payloads in their own box-local coordinates instead
 * would count the box change TWICE — the geometry would carry the size change
 * and the box would carry it again, so a 100→200 wide morph would land at 400.
 * That is the easiest mistake available here, so it is pinned by a test whose
 * whole job is to catch it (tests/morph_mode_test.js: two IDENTICAL squares in
 * DIFFERENT boxes must render exactly the tweened box's square).
 *
 * ── PAINT ───────────────────────────────────────────────────────────────────
 * The engine carries per-subpath paint UNTOUCHED (it never blends colour — see
 * its header), so the pairing happens here, through core/interpolators.js
 * `interpolate`, which already lerps hex colours including the alpha channel and
 * already snaps unlike-shaped values discretely. Hand-rolling a colour lerp is
 * how the two would diverge. A MATERIAL or GRADIENT pair has no numeric midpoint
 * and `interpolate` snaps it to the target — the honest answer at this seam,
 * since the crossfade machinery composites two whole DRAWS of one op and a
 * morphing path is a different op on every frame.
 *
 * @param {object} node - a derive render node carrying `.morph`
 * @returns {object[]} ops in local space (an empty list when either side draws nothing)
 */
export function morphIR(node) {
  const { fromPlugin, toPlugin, fromState, toState, t } = node.morph;
  // THE CROSSFADE ARM — a cross-render rather than a reshape. core/derive.js marks
  // it when the universal Morph property says `crossfade`, and when `auto` meets a
  // pair that cannot outline (a video, a photo, a PDF page). See crossfadeIR.
  if (node.morph.crossfade) return crossfadeIR(node);
  const fromPayload = fromPlugin.morphPaths(fromState);
  const toPayload = toPlugin.morphPaths(toState);
  // LOUD, not lenient: a provider that hands over a negative space or a non-cubic
  // segment is a widget bug, and morphing on regardless would draw a shape
  // neither endpoint has. The emit-time containment boundary above turns this
  // into a named red box on the one item instead of a dead frame.
  assertMorphPaths(fromPayload, `${node.type} morph source`);
  assertMorphPaths(toPayload, `${node.type} morph target`);
  // `matchPieces` rides the mark, and ONLY core/derive.js resolveContentMorph
  // sets it — a same-type content morph, where a congruent subpath on both sides
  // is the same glyph that moved rather than a coincidence. Absent (every type
  // morph, every other caller) means the whole-shape morph, unchanged.
  const blended = morphPaths(fromPayload, toPayload, t, { matchPieces: !!node.morph.matchPieces });
  // THE MID-MORPH BOX. A bbox widget's is its own tweened w/h, straight off the
  // node. A BOXLESS CONNECTOR (arrow/line/brace/elbow: `bbox: false`, no w/h
  // state at all) has none, and reading `?? 0` collapsed the whole morph to
  // `M0 0C0 0…` — an invisible widget for the interior of its own transition,
  // with no error. See morphBox for the frame this substitutes instead.
  const { w, h, ox, oy } = morphBox(node, fromPayload, toPayload, t);
  // At the endpoints morphPaths short-circuits and returns an ORIGINAL payload,
  // which is in its own box space rather than unit space — so the scale is that
  // payload's own space, not the node box. Reading it off the result is what
  // makes this correct at every alpha with no branch on t.
  const sx = blended.space.w === 1 && blended.space.h === 1 ? w : w / (blended.space.w || 1);
  const sy = blended.space.w === 1 && blended.space.h === 1 ? h : h / (blended.space.h || 1);
  // ONE OP PER PAINT, NOT ONE PER SUBPATH — see morphPaintRuns. A fill rule is a
  // property of a WHOLE path, so a counter and its parent must share an op or the
  // counter is painted as a solid blob on top of the letter it should hole.
  // THE NODE'S OWN TWEENED INK (WORKSTREAM AV) — computed ONCE for the whole
  // widget because a widget has one ink, and handed to every run. Null for a
  // payload whose art the state does not describe (an SVG icon), which is exactly
  // where the endpoint blend remains the only available answer.
  const stateInk = morphStateInk(node.state, fromPayload, toPayload);
  return morphPaintRuns(blended.subpaths, (sp) => morphedPaint(fromPayload, toPayload, sp, t, stateInk)).flatMap(
    ({ subpaths, paint }) => {
      const placed = subpaths.map((sp) => offsetSubpath(scaledSubpath(sp, sx, sy), ox, oy));
      const d = payloadToPathD({ ...blended, subpaths: placed });
      if (!d) return [];
      return [path({
        d,
        fill: paint.fill,
        stroke: (paint.strokeWidth ?? 0) > 0 ? paint.stroke : null,
        strokeWidth: paint.strokeWidth ?? 0,
        // THE RULE IS ASKED OF THIS OP'S OWN CONTOURS (workstream AQ), because a
        // fill rule is a property of a WHOLE PATH and each run is now one path.
        // Asking it of the whole payload was right when the payload was one op;
        // with per-glyph ops it would let a DIFFERENT letter's crossing contours
        // disqualify evenodd for a glyph they are not in the path with — which is
        // the containment this split exists to give. `blended.fillRule` is the
        // payload's own declared rule and stays the fallback the predicate reads.
        fillRule: midMorphFillRule({ ...blended, subpaths }),
        opacity: paint.opacity ?? 1,
      })];
    });
}

/**
 * Pure function. THE MORPH'S OP GRAIN — a mid-morph subpath list split into the
 * fewest RUNS that each draw with one paint, so every run becomes ONE path op.
 *
 * ── WHY THIS EXISTS: A FILL RULE IS A PROPERTY OF A WHOLE PATH ───────────────
 * `morphIR` used to emit one op per subpath, and that made a counter physically
 * unexpressible. "6" has two contours — the bowl's outer and the hole inside it —
 * and a hole is punched by the OUTER and the COUNTER being evaluated together
 * under one fill rule. Split into two ops, the painter fills the outer solid and
 * then fills the counter solid ON TOP of it, in the same ink. Neither nonzero nor
 * evenodd can help: both are functions of one path's own contours, and each op
 * here had exactly one.
 *
 * MEASURED, on "6" → "8" through this very function's caller before the change:
 * ZERO hole pixels at every alpha sampled — 0.1, 0.25, 0.5, 0.75, 0.9 — over a
 * 160×112 raster of the node box. Not "a hole that flickers": no hole ever, in
 * any frame of any glyph morph. That is the picture the user photographed (the
 * ∞'s two counters as solid dots, the 6's counter filled), and it is why
 * core/morph_fill.js's rule appeared to do nothing: the rule was computed
 * correctly and handed to ops that could not act on it.
 *
 * ── WHY RUNS AND NOT ONE OP FOR EVERYTHING ───────────────────────────────────
 * Because per-subpath paint is REAL: an SVG icon's contours genuinely carry
 * different fills, which is the whole reason `morphedPaint` has its heterogeneous
 * carve-out. Merging those into one op would flatten a multi-coloured icon to a
 * single colour — trading this bug for a worse one. So the grain is the paint
 * itself: consecutive subpaths whose resolved paint is EQUAL share an op, and a
 * paint change starts a new one.
 *
 * CONSECUTIVE, never grouped-by-value across the list, because PAINT ORDER IS
 * SEMANTIC — a later op draws over an earlier one, and gathering all the reds
 * together would reorder a stack of overlapping shapes. A homogeneous payload (a
 * text box, an equation, any single-ink widget) is one run either way, which is
 * exactly the case that had the bug.
 *
 * ── THE SECOND REASON TO SPLIT: THE PIECE (workstream AQ) ────────────────────
 * Paint alone was the grain, and for a homogeneous string that made the WHOLE
 * WIDGET one fill computation — every letter of "hello" resolved together, so a
 * neighbouring glyph's outer drifting across an `o`'s counter added its winding
 * to the sum and closed the hole. AM's fix made a counter EXPRESSIBLE; it did not
 * make it CONTAINED, and the residual AM measured is exactly the cross-glyph
 * crossings this splits apart.
 *
 * Manim's grain is the VMobject: one glyph, one `ctx.fill()`
 * (`manim/camera/camera.py:781`). "The only contours that ever share a fill
 * computation are the contours of ONE glyph" is the whole of why its holes
 * survive a transform, and the research note calls it the single most valuable
 * thing to adopt (§1.4). So a `piece` change starts a new run, and the mid-morph
 * op count for an N-glyph string becomes N — the same count Manim issues, and the
 * same count WE issued before AM's fix, so it is measured-safe territory.
 *
 * A payload whose subpaths carry no `piece` (or all the same one) is unchanged:
 * one run per paint, exactly as before.
 *
 * NOT DONE, DELIBERATELY: re-merging adjacent same-paint pieces that provably do
 * not overlap. It would restore the old op count for the common case, but
 * correctness comes before op count and the merge condition is a per-frame
 * geometric test whose cost is unmeasured. Spec §2.3.9 says to measure before
 * optimizing; this is that decision, recorded rather than silently skipped.
 *
 * @param {object[]} subpaths - the mid-morph subpaths, in paint order
 * @param {function} paintFor - (subpath) → the resolved paint for it
 * @returns {object[]} `[{subpaths, paint}]`, in paint order
 *
 * @example
 * >>> // one ink, one piece (a glyph and its counter): ONE run, so the fill rule
 * >>> // can hole it — this is the case AM's fix exists for.
 * >>> morphPaintRuns([{start: [0, 0], piece: "0>0"}, {start: [1, 1], piece: "0>0"}],
 * ...   () => ({fill: "#000"})).length
 * 1
 * >>> // TWO GLYPHS in one ink: TWO runs, so neither letter's contours are in the
 * >>> // other's fill computation — Manim's one-fill-per-VMobject grain.
 * >>> morphPaintRuns([{start: [0, 0], piece: "0>0"}, {start: [1, 1], piece: "1>1"}],
 * ...   () => ({fill: "#000"})).length
 * 2
 * >>> // no piece stamped at all: paint is the only grain, exactly as before AQ
 * >>> morphPaintRuns([{start: [0, 0]}, {start: [1, 1]}], () => ({fill: "#000"})).length
 * 1
 * >>> // two inks (an SVG icon): two runs, so neither contour loses its colour
 * >>> morphPaintRuns([{start: [0, 0]}, {start: [1, 1]}],
 * ...   (sp) => ({fill: sp.start[0] ? "#00f" : "#f00"})).map((r) => r.paint.fill)
 * [ '#f00', '#00f' ]
 * >>> morphPaintRuns([], () => ({}))
 * []
 */
export function morphPaintRuns(subpaths, paintFor) {
  const runs = [];
  for (const sp of subpaths) {
    const paint = paintFor(sp);
    const piece = sp.piece;
    const last = runs[runs.length - 1];
    if (last && last.piece === piece && deepEqual(last.paint, paint)) last.subpaths.push(sp);
    else runs.push({ subpaths: [sp], paint, piece });
  }
  return runs;
}

/**
 * Pure function. THE CROSS-RENDER — both endpoint states drawn through their OWN
 * plugins' emit() and composited at complementary opacity, (1-t) over t.
 *
 * ── WHY THIS EXISTS AND WHAT IT IS FOR ───────────────────────────────────────
 * A morph needs two OUTLINES; a crossfade needs only two PICTURES. That is the
 * whole difference, and it is what makes this the honest fallback for the pairs a
 * morph structurally cannot serve — a video becoming a rect, a photo becoming an
 * equation, anything raster on either side. The universal Morph property reaches
 * it two ways: explicitly (`crossfade`), and as `auto`'s answer when either side
 * cannot produce an outline. `auto` picking it is silent (the mode promised to
 * choose sensibly); an explicit `morph` that has to fall back here is REPORTED at
 * core/derive.js, because the author asked for something specific.
 *
 * ── IT REUSES THE FADE SEAM RATHER THAN INVENTING A COMPOSITE ────────────────
 * `scaledOpacity` is the same function the universal fade seam uses to ramp a
 * fractional `active`, and it already recurses into subtree content so an
 * effected or grouped endpoint fades as ONE unit rather than per-op. So a
 * crossfade is two ordinary emits plus two opacity scales — no new op, no new
 * painter, nothing for the four backends to learn.
 *
 * ── THE ENDPOINT LAW HOLDS HERE TOO ──────────────────────────────────────────
 * Both states come from the mark, where core/deltas.mutBlendApply fixed them for
 * the whole transition. So at t → 0 this is the outgoing widget at full strength
 * and at t → 1 the incoming one, and neither endpoint's picture depends on the
 * mid-tween state. The op ORDER is outgoing-then-incoming so the widget being
 * revealed paints over the one being dissolved.
 *
 * ── BUT THE EFFECTS ARE STRIPPED FROM BOTH SIDES (WORKSTREAM AV) ─────────────
 * The endpoint law is about the SHAPE and the ink each side draws. It is NOT
 * about the effects bundle, which under the AV ruling must reach the picture
 * TWEENED, exactly as it would with no morph at all. 34 plugins compose the
 * bundle inside their own emit(), so an un-stripped crossfade would carry each
 * side's ENDPOINT effects into the dissolve — a bloom that is off on one side and
 * full on the other cross-dissolving between two discrete looks instead of
 * ramping — AND the walker's tweened wrap (effects.applyNodeEffects, which now
 * takes every morphed node) would compose the same shadow a second time on top.
 * `withEffectsStripped` returns each state BY IDENTITY when it carries no effect
 * keys, so an effect-free crossfade is byte-identical to before this line.
 *
 * @param {object} node - a derive render node whose `.morph` mark carries `crossfade`
 * @returns {object[]} ops in local space
 */
export function crossfadeIR(node) {
  const { fromPlugin, toPlugin, fromState, toState, t } = node.morph;
  const emitSide = (plugin, state) =>
    typeof plugin?.emit === "function" ? plugin.emit(withEffectsStripped(state), null, node.world, null) ?? [] : [];
  return [
    ...scaledOpacity(emitSide(fromPlugin, fromState), 1 - t),
    ...scaledOpacity(emitSide(toPlugin, toState), t),
  ];
}

/**
 * Pure function. THE MID-MORPH FRAME — the box the engine's unit output is
 * mapped through, plus the offset it is placed at.
 *
 * ── WHY A BOXLESS WIDGET NEEDS THIS AT ALL ───────────────────────────────────
 * Every bbox widget's answer is trivial: its own tweened `w`/`h`, and no offset,
 * because its emit() already draws in box-local coordinates under a world
 * transform that positions it.
 *
 * The whole arrow/line/brace/elbow family is the opposite (`bbox: false`,
 * `transform: false`): it stores ABSOLUTE endpoints, has NO `w`/`h` state, and
 * emits world coordinates under an IDENTITY world transform. So `node.state.w`
 * is `undefined`, `?? 0` made the scale zero, and the morph painted a degenerate
 * point — measured, not feared, and pinned as an expected failure by
 * tests/morph_connector_test.js until this function closed it.
 *
 * ── THE SUBSTITUTE FRAME IS THE TWEENED INK RECT ─────────────────────────────
 * core/morph_payload.js `morphPayloadFromConnector` already made the PAYLOAD
 * honest: a connector reports its ink rect as its `space` and its coordinates
 * rect-relative. This is the other half, and the fix its docblock names — the
 * tweened ink rect becomes the mid-morph node's box, AND the rect's ORIGIN
 * becomes the offset, because a payload measured from the rect's corner must be
 * placed back at that corner to land where the widget actually is.
 *
 * BOTH ARE TWEENED, from the two payloads' own spaces and origins, so the frame
 * moves continuously across the transition exactly as the shape does. The origins
 * come from the ENDPOINT payloads rather than from a live `localBounds` call for
 * the same reason the alignment does: an endpoint is fixed for the whole
 * transition, and a mid-tween re-derivation is what the jiggle was.
 *
 * A BBOX NODE IS UNTOUCHED — it takes the first branch, offset (0, 0), and every
 * existing morph renders byte-identically.
 *
 * @example morphBox({state: {w: 100, h: 60}}, {space: {w: 1, h: 1}}, {space: {w: 1, h: 1}}, 0.5)
 * { w: 100, h: 60, ox: 0, oy: 0 }
 * @example // a boxless pair: the tweened ink rect, origin included
 * @example morphBox({state: {}}, {space: {w: 200, h: 10}, origin: {x: 20, y: 5}}, {space: {w: 100, h: 50}, origin: {x: 0, y: 25}}, 0.5)
 * { w: 150, h: 30, ox: 10, oy: 15 }
 */
export function morphBox(node, fromPayload, toPayload, t) {
  const w = node.state.w, h = node.state.h;
  if (typeof w === "number" && typeof h === "number") return { w, h, ox: 0, oy: 0 };
  const lerp = (a, b) => a + (b - a) * t;
  const from = fromPayload.origin ?? { x: 0, y: 0 }, to = toPayload.origin ?? { x: 0, y: 0 };
  return {
    w: typeof w === "number" ? w : lerp(fromPayload.space.w, toPayload.space.w),
    h: typeof h === "number" ? h : lerp(fromPayload.space.h, toPayload.space.h),
    ox: lerp(from.x, to.x),
    oy: lerp(from.y, to.y),
  };
}

/**
 * Pure function. One subpath translated by a fixed offset — how a connector's
 * rect-relative geometry is placed back at the rect's corner (see morphBox).
 *
 * Returns the VERY SAME object at the zero offset, so every bbox morph — which
 * is every morph that existed before the connector fix — allocates nothing and
 * renders byte-identically.
 *
 * @example offsetSubpath({start: [1, 2], curves: [[0, 0, 1, 1, 2, 2]]}, 10, 20).start
 * [ 11, 22 ]
 * @example // the identity that keeps every bbox morph byte-identical:
 * @example (() => { const sp = {start: [1, 2], curves: []}; return offsetSubpath(sp, 0, 0) === sp; })()
 * true
 */
export function offsetSubpath(sp, ox, oy) {
  if (!ox && !oy) return sp;
  return {
    ...sp,
    start: [sp.start[0] + ox, sp.start[1] + oy],
    curves: sp.curves.map((c) => [c[0] + ox, c[1] + oy, c[2] + ox, c[3] + oy, c[4] + ox, c[5] + oy]),
  };
}

/**
 * Pure function. One subpath's coordinates scaled out of unit space into the
 * node's box. A plain per-axis multiply: the engine's frame and the op's frame
 * are the same y-DOWN box-local frame, differing only in extent.
 *
 * @example scaledSubpath({start: [0, 0], curves: [[0, 0, 1, 1, 1, 1]], closed: true, winding: 1}, 10, 20).curves[0]
 * [ 0, 0, 10, 20, 10, 20 ]
 * @example scaledSubpath({start: [0.5, 0.5], curves: [], closed: false, winding: 1}, 100, 50).start
 * [ 50, 25 ]
 */
export function scaledSubpath(sp, sx, sy) {
  return {
    ...sp,
    start: [sp.start[0] * sx, sp.start[1] * sy],
    curves: sp.curves.map((c) => [c[0] * sx, c[1] * sy, c[2] * sx, c[3] * sy, c[4] * sx, c[5] * sy]),
  };
}

/**
 * Pure function. The paint one morphed subpath draws with — the two endpoint
 * payloads' paints routed through the ORDINARY paint pipeline.
 *
 * ── MORPH NEVER OWNS PAINT (user ruling, 2026-08-02, verbatim) ───────────────
 * "It's not the responsibility of morphing to handle any material properties,
 * it's only about shape properties." So this function decides NOTHING about how
 * two paints combine: it identifies the PAIR and hands it to `blendedPaintValue`,
 * which is the same tween/crossfade law any other property row gets. The morph
 * contributes the shape and nothing else, and a shader ink (a material, a
 * gradient) rides the morphed path op exactly as it rides any other path op —
 * ports.resolveMaterialFillPaints runs on morphIR's output like on any emit().
 *
 * WHY THE ENDPOINT PAYLOADS AND NOT THE BLENDED SUBPATH'S OWN `paint`: the
 * engine's alignment REORDERS and PADS subpaths, so a blended subpath carries
 * whichever operand's paint survived that process — correct for identifying the
 * contour, useless for blending. Reading the two payloads' FIRST subpath paint
 * instead gives a stable pair for the whole widget, which is the right grain
 * here: a widget has ONE ink, and both morphable widgets in a shape↔shape morph
 * carry it on every subpath they emit.
 *
 * ── WHAT THE MULTI-CONTOUR RULE BECAME, AND WHAT IT DID *NOT* CAUSE ──────────
 * It used to be a COUNT test — "more than two subpaths between the two payloads,
 * so keep the carried per-subpath paint". That is right for the case it was
 * written for (an SVG icon whose contours genuinely carry different fills) and
 * wrong as a PROXY for it: a multi-glyph equation or text box is also
 * multi-contour, and carries ONE widget ink repeated on each glyph.
 *
 * BE PRECISE ABOUT THE BLAME, because an earlier draft of this paragraph was not.
 * The count test was NOT the reported black — MEASURED, by re-instating it and
 * rendering the same material-inked text morph frame both ways: BYTE-IDENTICAL
 * brass. It is harmless whenever the engine's carry happens to equal the widget
 * ink, which is the common same-ink case. The black came from the OTHER half,
 * plugins/latex.js degrading a shader ink before the payload ever reached here.
 * The count test is a LATENT failure rather than a live one: it bites exactly
 * when the carry and the widget-level pair disagree — a same-type morph whose ink
 * ALSO changed across the transition, where the carry is one endpoint's ink and
 * the honest answer is the blended pair.
 *
 * The rule is now the thing the carve-out actually meant: keep per-subpath paint
 * only when a payload's subpaths DISAGREE with each other (`paintIsHeterogeneous`).
 * Homogeneous art of any contour count is a widget-level pair and blends as one.
 *
 * ── THE TWEENED STATE OUTRANKS THE ENDPOINT BLEND (WORKSTREAM AV) ────────────
 * `stateInk` is the node's own TWEENED paint, and where the state carries a slot
 * that slot WINS over anything computed here. That is AV's generalization of AG's
 * ruling: "in the middle of that morph, it should be interpolating, just like it
 * normally would if it wasn't morphing. This should be the same for EVERY SINGLE
 * PROPERTY." The endpoint blend below is an INDEPENDENT re-derivation of the fold,
 * and independent re-derivations disagree with the fold the moment the author
 * makes them: MEASURED, on a rect→circle with `fill~interp: "step"` — the folded
 * state said the target blue (step switches at alpha > 0), and the morph painted
 * `#800080`, a lerp of the endpoints, silently overriding the row's own interp
 * mode. Every interp mode, every equation-valued paint and every future paint law
 * has the same exposure, and reading the fold has none of it by construction.
 *
 * THE ENDPOINT BLEND STAYS as the fallback, for the payloads whose ink is not in
 * the state at all: an SVG icon's per-contour art, and any provider that paints
 * from its own asset. Those have nothing to read, and blending their two payloads
 * is the only answer available.
 *
 * @example morphedPaint({subpaths: [{paint: {fill: "#000000", strokeWidth: 0, opacity: 1}}]}, {subpaths: [{paint: {fill: "#ffffff", strokeWidth: 0, opacity: 1}}]}, {}, 0.5).fill
 * '#808080'
 * @example // AV: the node's own tweened fill WINS over the endpoint blend
 * @example morphedPaint({subpaths: [{paint: {fill: "#000000"}}]}, {subpaths: [{paint: {fill: "#ffffff"}}]}, {}, 0.5, {fill: "#0000ff"}).fill
 * '#0000ff'
 * @example // a MATERIAL on both sides survives the interior — it is one unchanged ink
 * @example morphedPaint({subpaths: [{paint: {fill: {type: "material", material: {id: "sky"}}}}, {paint: {fill: {type: "material", material: {id: "sky"}}}}]}, {subpaths: [{paint: {fill: {type: "material", material: {id: "sky"}}}}]}, {paint: {fill: "#000000"}}, 0.5).fill
 * { type: 'material', material: { id: 'sky' } }
 * @example // no paint on either side: the subpath's own carried paint, else nothing
 * @example morphedPaint({subpaths: []}, {subpaths: []}, {paint: {fill: "#f00"}}, 0.5).fill
 * '#f00'
 */
export function morphedPaint(fromPayload, toPayload, blendedSubpath, t, stateInk = null) {
  const a = fromPayload.subpaths[0]?.paint;
  const b = toPayload.subpaths[0]?.paint;
  if (!a || !b) return withStateInk(blendedSubpath.paint ?? {}, stateInk);
  // GENUINELY MULTI-COLOURED ART ONLY (an SVG icon): its contours disagree, the
  // engine already carried the aligned counterpart's paint through, and blending
  // one widget-level pair would flatten them all to a single colour. The state's
  // ink does NOT override here — this is exactly the art the state does not
  // describe, which is why the carve-out exists.
  if (blendedSubpath.paint && (paintIsHeterogeneous(fromPayload) || paintIsHeterogeneous(toPayload)))
    return blendedSubpath.paint;
  return withStateInk({
    ...interpolate(a, b, t),
    fill: blendedPaintValue(a.fill, b.fill, t),
    stroke: blendedPaintValue(a.stroke, b.stroke, t),
  }, stateInk);
}

/**
 * Pure function. THE MORPHED NODE'S OWN TWEENED INK — or null when this pair's
 * ink is not state-described and the endpoint blend must stand.
 *
 * ── WORKSTREAM AV: THE TWEENED BAG IS THE AUTHORITY ─────────────────────────
 * `state` is the ordinary tweened bag (core/derive.js resolves the morph token
 * and leaves every other leaf exactly where the fold put it — measured identical
 * to the same document with morph off), so `statePaint(state)` IS what the same
 * widget would paint with at this alpha with no morph active. Reading it is what
 * makes a morph obey every interp mode, every equation and every future paint law
 * for free, instead of re-deriving the fold from two endpoints and disagreeing
 * with it.
 *
 * ── THE GATE IS THE PAYLOADS' OWN MARK, NOT A KEY LIST HERE ─────────────────
 * BOTH endpoint payloads must have been built by `statePaint`
 * (core/morph_payload STATE_PAINT_MARK). That is the payload declaring "my ink IS
 * this widget's fill/stroke/strokeWidth/opacity", and only it makes rereading
 * them sound. plaintext and latex spend `stroke`/`strokeWidth` on their BOX
 * BORDER and carry glyph ink on `glyphStroke` instead, so an ungated reread would
 * paint an equation's letterforms with its frame's border width — the trap this
 * gate exists for. BOTH sides, because either payload's paint can survive the
 * alignment into the blended subpath.
 *
 * @param {object} state - the morphed node's evaluated, tweened state
 * @param {object} fromPayload - the outgoing endpoint's MorphPaths payload
 * @param {object} toPayload - the incoming endpoint's MorphPaths payload
 * @returns {object|null} a payload paint, or null when the pair is not state-inked
 *
 * @example // an SVG icon's per-contour art: unmarked, so the endpoint blend stands
 * @example morphStateInk({fill: "#00f"}, {subpaths: [{paint: {fill: "#f00"}}]}, {subpaths: [{paint: {fill: "#0f0"}}]}) // null
 * @example // both sides built by statePaint: the node's own tweened ink wins
 * @example morphStateInk({fill: "#0000ff", strokeWidth: 0}, {subpaths: [{paint: statePaint({fill: "#f00"})}]}, {subpaths: [{paint: statePaint({fill: "#0f0"})}]}).fill
 * '#0000ff'
 */
export function morphStateInk(state, fromPayload, toPayload) {
  if (!isStatePainted(fromPayload) || !isStatePainted(toPayload)) return null;
  return statePaint(state ?? {});
}

/** Does every subpath this payload paints carry `statePaint`'s mark? */
function isStatePainted(payload) {
  const subs = payload?.subpaths ?? [];
  return subs.length > 0 && subs.every((sp) => !sp.paint || sp.paint[STATE_PAINT_MARK]);
}

/**
 * Pure function. A computed morph paint with the node's own tweened ink laid over
 * it. `stateInk` null (a pair whose ink the state does not describe) returns the
 * computed paint BY IDENTITY, which is what keeps every icon and text morph
 * byte-identical to before WORKSTREAM AV.
 *
 * @example (() => { const p = {fill: "#808080"}; return withStateInk(p, null) === p; })() // true
 * @example withStateInk({fill: "#808080", strokeWidth: 6}, {fill: "#0000ff", strokeWidth: 2}).fill // '#0000ff'
 */
function withStateInk(paint, stateInk) {
  return stateInk ? { ...paint, ...stateInk } : paint;
}

/**
 * Pure function. Do THIS payload's subpaths carry paints that disagree with one
 * another? The question the morph's per-contour carve-out actually asks — an SVG
 * icon says yes, a 40-glyph equation under one ink says no (see morphedPaint).
 *
 * Compares against the FIRST subpath's paint rather than pair-wise, which is the
 * same answer for a fraction of the work: disagreeing with a common reference and
 * disagreeing with each other are equivalent for "are these all the same".
 *
 * @example paintIsHeterogeneous({subpaths: [{paint: {fill: "#f00"}}, {paint: {fill: "#f00"}}]})
 * false
 * @example paintIsHeterogeneous({subpaths: [{paint: {fill: "#f00"}}, {paint: {fill: "#00f"}}]})
 * true
 * @example paintIsHeterogeneous({subpaths: []})
 * false
 */
export function paintIsHeterogeneous(payload) {
  const first = payload.subpaths[0]?.paint;
  return payload.subpaths.some((sp) => !deepEqual(sp.paint ?? null, first ?? null));
}

/**
 * Pure function. ONE PAINT SLOT across a morph — the fill (or the stroke) the
 * interior frames draw with, decided by the paint machinery rather than by the
 * morph.
 *
 * TWO ARMS, AND THEY ARE THE APP'S EXISTING TWO. A pair `interpolate` can
 * genuinely blend — two hex colours, two same-shaped gradients, one unchanged
 * value — tweens, exactly as a colour row tweens. An UNLIKE pair (a solid
 * becoming a material, a gradient becoming a shader) has no midpoint, and this
 * returns the `{type: "crossfade", from, to, t}` paint core/interp_modes.js's
 * `blend` mode mints, which the painter draws by painting the op TWICE at
 * complementary alpha. Routing is all this does; the router is
 * render_gpu/ir.js + skia/paint_skia.js and is not touched here.
 *
 * WHY NOT `interpolate` ALONE, WHICH IS WHAT THIS SEAM USED TO CALL: it SNAPS a
 * structurally-unlike pair to the target. On a property row that is the honest
 * discrete answer; across a morph it means a red rect turning into a material
 * equation is fully material from the first interior frame, which is the same
 * "the morph decided about paint" mistake in the other direction.
 *
 * @example blendedPaintValue("#000000", "#ffffff", 0.5)
 * '#808080'
 * @example blendedPaintValue(null, null, 0.5)
 * null
 * @example // one unchanged shader ink: itself, with nothing to composite
 * @example blendedPaintValue({type: "material", material: {id: "sky"}}, {type: "material", material: {id: "sky"}}, 0.5)
 * { type: 'material', material: { id: 'sky' } }
 * @example // unlike pair → the crossfade paint, both sides preserved for the painter
 * @example blendedPaintValue("#ff0000", {type: "material", material: {id: "sky"}}, 0.25)
 * { type: 'crossfade', from: '#ff0000', to: { type: 'material', material: { id: 'sky' } }, t: 0.25 }
 */
export function blendedPaintValue(a, b, t) {
  if (deepEqual(a ?? null, b ?? null)) return a ?? null;
  // A pair with a SHADER on either side has no numeric midpoint. `null` is not
  // one — "no stroke" becoming a material is an appearance, and the fade seam
  // above already ramps an appearing widget; compositing against nothing would
  // draw the material at full strength from the first frame.
  if ((isPaintShaped(a) || isPaintShaped(b)) && a != null && b != null)
    return { type: CROSSFADE_PAINT_TYPE, from: a, to: b, t };
  return interpolate(a, b, t);
}

/**
 * Pure function. The minimal identity a paint-time error report needs: WHO the
 * ops belong to. Deliberately not the node itself — the tag is copied onto the
 * flattened op stream, and holding a whole render node there would keep its
 * entire evaluated state alive for the life of the display list.
 *
 * @param {object} node - a derive render node
 * @returns {{itemId: string, type: string, name: string|undefined}}
 *
 * @example ownerTag({itemId: "a1", type: "text", state: {name: "Title"}})
 * { itemId: 'a1', type: 'text', name: 'Title' }
 * @example ownerTag({itemId: "b2", type: "rect", state: {}})
 * { itemId: 'b2', type: 'rect', name: undefined }
 */
export function ownerTag(node) {
  return { itemId: node.itemId, type: node.type, name: node.state?.name };
}

/**
 * Pure function. THE FADE COMPOSITION — a FRACTIONAL `active` multiplied into
 * every op's opacity, recursing into subtree ops' `content` so an effected,
 * cropped or grouped widget fades as one unit rather than only at its outer
 * wrapper.
 *
 * WHY `active` CARRIES THIS AND NOT A SEPARATE KEY. The `fade` interp mode
 * (core/interp_modes.js) answers the user's "a fade interpolate option for
 * visible… bring it in and out between 0 to 100 opacity" by making the Visible
 * leaf itself fractional during a transition. A mode may only ever return a value
 * for the leaf it was asked about, so a fade that wrote `opacity` instead would
 * both break that contract and clobber whatever the author had put there. Making
 * the boolean fractional keeps the whole feature in one property.
 *
 * WHY IT COMPOSES BY MULTIPLICATION. A widget already at opacity 0.5, fading in,
 * should read 0.25 halfway — the fade is a coverage factor OVER the widget's own
 * opacity, not a replacement for it.
 *
 * WHY HERE AND NOT IN core/derive.js. derive's gate is `s.active !== false`,
 * which a fraction passes (so a mid-fade item is correctly still derived), but
 * derive builds nodes, not ops — there is no opacity to multiply yet. ports.js is
 * the one place every node's ops exist and every backend walks, so one
 * implementation here covers the editor canvas, thumbnails, the minimap, PNG
 * export, the PDF and SVG exporters and the CLI alike.
 *
 * A BOOLEAN (or absent) `active` returns `cmds` UNTOUCHED — the same array, not a
 * copy — so every document that does not use the mode, and both endpoints of
 * every document that does, is byte-identical to before this existed.
 *
 * @param {object} state - the node's evaluated state (only `active` is read)
 * @param {object[]} cmds - the node's ops
 * @returns {object[]} the ops, faded (or the very same array)
 *
 * @example applyActiveFade({active: true}, [{op: "rect", opacity: 1}]) // [{op: "rect", opacity: 1}] (same array — a boolean is not a fade)
 * @example applyActiveFade({}, [{op: "rect", opacity: 1}])[0].opacity // 1 (absent means visible)
 * @example applyActiveFade({active: 0.5}, [{op: "rect", opacity: 1}])[0].opacity // 0.5
 * @example applyActiveFade({active: 0.5}, [{op: "rect", opacity: 0.4}])[0].opacity // 0.2 (a coverage factor OVER the widget's own opacity)
 * @example applyActiveFade({active: 0.5}, [{op: "effectSubtree", opacity: 1, content: [{op: "rect", opacity: 1}]}])[0].content[0].opacity // 0.5 (a subtree fades as one unit)
 */
export function applyActiveFade(state, cmds) {
  const a = state?.active;
  // A NAMED VISIBILITY MODE (core/interp_modes.js `~visibleFx`) carries its
  // coverage in the token's `v`, and the opacity half of EVERY such mode is this
  // same multiplication — blurFade and Manim both fade, they just each do
  // something else as well. Reading the level through `visibleLevel` is what
  // keeps that one composition in one place instead of each mode re-deriving it.
  if (isVisibleFxToken(a)) {
    const k = growOpacityLevel(a);
    return k === 1 ? cmds : scaledOpacity(cmds, k);
  }
  if (typeof a !== "number") return cmds; // boolean or absent: not a fade
  return scaledOpacity(cmds, Math.max(0, Math.min(1, a)));
}

/**
 * Pure function. THE OPACITY a named visibility token contributes — its coverage
 * for every mode EXCEPT `grow`, which contributes none (1, i.e. fully opaque).
 *
 * WHY `grow` IS THE EXCEPTION, and why the exception lives HERE (WORKSTREAM BS).
 * `fade`, `blurFade` and `manim` are all ways of resolving INTO the picture, and
 * opacity is half of each of those gestures — which is why applyActiveFade could
 * treat "is a token" as "is a fade" for all of them. `grow` says the arrival with
 * SIZE instead: the widget is a small SOLID thing that becomes a big one. Fading
 * it as well would spend the first half of the entry on a barely-visible speck,
 * i.e. two entrance effects stacked where the author asked for one.
 *
 * It is a render-seam decision rather than a fold-time one for the same reason
 * blurFade's radius is: the fold may only return a value for the leaf it was
 * asked about, so the token carries a coverage and this file is where a coverage
 * becomes a specific picture. Reading the mode name here — rather than teaching
 * the token an extra "does this fade" scalar — keeps the token's standing rule
 * intact (it carries scalars, not a picture) and means a future mode declares its
 * opacity behaviour in ONE readable place.
 *
 * @example growOpacityLevel({type: "~visibleFx", mode: "fade", v: 0.25}) // 0.25
 * @example growOpacityLevel({type: "~visibleFx", mode: "blurFade", v: 0.4}) // 0.4
 * @example growOpacityLevel({type: "~visibleFx", mode: "manim", v: 0.4}) // 0.4
 * @example growOpacityLevel({type: "~visibleFx", mode: "grow", v: 0.25}) // 1 (it scales, it does not dissolve)
 */
function growOpacityLevel(token) {
  return token.mode === "grow" ? 1 : visibleLevel(token);
}

/**
 * Pure function. Every op's opacity scaled by `k`, recursing into `content`.
 * Split out from applyActiveFade so the recursion does not re-test the state's
 * `active` at every subtree level.
 *
 * @param {object[]} cmds - ops
 * @param {number} k - the multiplier, already clamped to [0, 1]
 * @returns {object[]}
 *
 * @example scaledOpacity([{op: "rect", opacity: 0.8}], 0.5)[0].opacity // 0.4
 * @example scaledOpacity([{op: "rect"}], 0.5)[0].opacity // 0.5 (an absent opacity IS 1)
 */
function scaledOpacity(cmds, k) {
  return cmds.map((cmd) => {
    // TRANSFORM BOOKKEEPING IS NOT INK. push/popTransform carry no opacity and
    // no backend reads one off them, so stamping a faded opacity onto them would
    // be inert noise in the display list — and inert noise is exactly what makes
    // a later reader believe a field means something. Left byte-identical.
    if (!opDrawsInk(cmd)) return cmd;
    const out = { ...cmd, opacity: (cmd.opacity ?? 1) * k };
    if (Array.isArray(cmd.content)) out.content = scaledOpacity(cmd.content, k);
    return out;
  });
}

/**
 * Pure function. Does this op DRAW (so an opacity on it means something), as
 * opposed to being transform bookkeeping? Phrased as a denylist of the two
 * structural ops rather than an allowlist of the ~30 drawing ones, so a NEW
 * drawing op fades by default and can never silently opt itself out of the seam.
 *
 * @example opDrawsInk({op: "rect"}) // true
 * @example opDrawsInk({op: "pushTransform"}) // false
 * @example opDrawsInk({op: "popTransform"}) // false
 */
function opDrawsInk(cmd) {
  return cmd.op !== "pushTransform" && cmd.op !== "popTransform";
}

// ── THE NAMED VISIBILITY MODES' RENDER HALF (WORKSTREAMS FF2 + JJ) ───────────
//
// core/interp_modes.js folds a `blurFade`/`manim` `visible` leaf to a token
// carrying a mode name and a coverage (`~visibleFx`). This is where that
// sentence becomes pixels — beside applyActiveFade above, because the OPACITY
// half of both modes IS that function and only the other half differs.

/**
 * THE BLUR-FADE DEFOCUS FALLBACK, in canvas units — the EXTRA blur a `blurFade`
 * widget starts with at v = 0, used when the token carries no `blur` parameter.
 *
 * IT IS NO LONGER A MODE CONSTANT (WORKSTREAM AP). The amount is the author's
 * knob now — core/interp_modes.js declares it as blurFade's `blur` parameter,
 * whose `default` is the single source of truth and is re-exported here so the
 * two cannot drift. Read that declaration for the sizing argument (why 64 and
 * not the 24 the user overruled as "too subtle"); this constant exists only so
 * this file's own fallback and every test that names a number read the SAME one.
 *
 * WHEN THE FALLBACK FIRES: a token minted before this parameter existed, or one
 * built by hand in a test. A token minted by the current fold always carries the
 * parameter, because core/deltas fills it from the declaration.
 */
export const BLUR_FADE_MAX_RADIUS = blurFadeDefaultAmount();

/**
 * Query (reads the interp-mode registry). blurFade's declared default extra
 * blur. Separate from the constant above so the lookup is named and testable
 * rather than an expression in an export.
 *
 * @example blurFadeDefaultAmount() // 64
 */
function blurFadeDefaultAmount() {
  const decl = modeParams("blurFade").find((p) => p.param === "blur");
  if (!decl) throw new Error("render_gpu/ports.js: blurFade must declare a `blur` parameter (core/interp_modes.js) — this file's defocus fallback reads its default");
  return decl.default;
}

/**
 * Pure function. THE BLUR-FADE COMPOSITION — a `blurFade` node's state with the
 * mode's defocus composed into its `gaussianBlur` effect leaf. Returns the VERY
 * SAME state object for every other node.
 *
 * ── WHY THE STATE AND NOT THE OPS (the seam choice) ──────────────────────────
 * The user's second message IS the design (2026-08-02: "BUT for that blur fade
 * thing we first need to have a 'blur' effect (accessible in the effects area of
 * all the widgets)") — this mode RIDES the universal blur rather than inventing
 * one, and the universal blur is a STATE KEY: render_gpu/effects.js applyEffects
 * reads `state.gaussianBlur` and folds the whole bundle into ONE effectSubtree.
 * So the composition point is the state, one step before the effects seam — and
 * the state is also the ONLY point that reaches both halves of the effects
 * architecture (34 plugins call applyEffects inside their own emit(); the
 * registry injects it for the rest). Composing the OPS would reach the injected
 * half alone, and a self-effecting widget would fade without ever defocusing,
 * with no error at all. That is why emitNodeBody resolves this BEFORE emit().
 *
 * ── IT ADDS, WHICH IS WHY IT LANDS ON THE WIDGET'S OWN TARGET BLUR ───────────
 * User, 2026-08-02, verbatim (WORKSTREAM AP): "the blur fade should be animating
 * from big blur to whatever blur is in the target. Right now it always animates
 * to zero blur, which is not the right move when the element has blur that it's
 * going towards."
 *
 * ADDING IS EXACTLY THAT BEHAVIOUR, and it is what this function has always
 * done: overwriting would make the transition END somewhere other than the
 * widget's settled look, while adding lands it on EXACTLY its authored blur at
 * v = 1, whatever that is. Measured across the real fold (repairedDocument →
 * tweenedState → evaluateState → sceneIR), a widget with `gaussianBlur: 10`
 * entering under this mode composes 74 → 10 monotonically and paints those exact
 * radii. So the arithmetic already converged to the target and the fix the user's
 * sentence needed was the SIZE OF THE APPROACH, not its destination — see the
 * amount parameter below.
 *
 * ONE THING COULD STILL MAKE AN AUTHOR SEE "converges to zero", and it is not
 * this function:
 *   1. HISTORICAL, FIXED BY WORKSTREAM AV — kept because it explains a real report
 *      and the reader should not re-attribute it here. `gaussianBlur` was not in
 *      core/deltas's morph denylist, so KEYFRAMING A BLUR ON THE ENTERING SLIDE —
 *      the natural way to give an appearing widget its look — armed the `auto`
 *      morph, and a morphed node was routed away from its plugin's emit() and
 *      painted with NO effect subtree at all (measured: `blur: 0` on the op, at
 *      every alpha), so the blur appeared only at the endpoints and read exactly
 *      as "it animated to zero and then popped". AV closed BOTH halves: an effect
 *      delta no longer arms a morph (MORPH_NON_SHAPE_KEYS), and a morphed node
 *      that IS morphing now takes the walker's effects wrap unconditionally.
 *   2. AUTHORING THE BLUR ON THE `blur` WIDGET rather than in the Effects rows.
 *      plugins/blur.js is a BACKDROP sampler with its own `blur` key — it blurs
 *      what is BEHIND it, is not the universal `gaussianBlur` effect, and is not
 *      what this mode rides. A widget blurred that way has no target blur for
 *      this function to converge to, correctly.
 *
 * ── THE CURVE, THE AMOUNT, AND THE EXACT ENDPOINT ────────────────────────────
 *     added = amount · (1 − v)
 * where `amount` is the mode's `blur` PARAMETER off the token (WORKSTREAM AP:
 * "It would be nice to be able to adjust it"), falling back to the declared
 * default. So the radius runs (target + amount) → target, linear in the coverage
 * so the picture sharpens at the same rate it solidifies and the two read as one
 * gesture rather than two effects racing. At v = 1 the added radius is 0 and the
 * state comes back BY IDENTITY, so the endpoint is byte-identical to the same
 * widget with no mode at all — the endpoint law, enforced here rather than
 * trusted to floating-point arithmetic. An `amount` of 0 is legal and returns by
 * identity at every v, degrading the mode to a plain fade.
 *
 * @param {object} state - the node's evaluated state
 * @returns {object} the state itself, or a copy with a raised `gaussianBlur`
 *
 * @example blurFadeState({active: true}).gaussianBlur // undefined (not a blurFade — the same object back)
 * @example blurFadeState({active: {type: "~visibleFx", mode: "manim", v: 0.5}}).gaussianBlur // undefined (a different named mode adds no blur)
 * @example blurFadeState({active: {type: "~visibleFx", mode: "blurFade", v: 0.5, blur: 64}}).gaussianBlur // 32 (half the amount, at half coverage)
 * @example blurFadeState({active: {type: "~visibleFx", mode: "blurFade", v: 0.5, blur: 64}, gaussianBlur: 4}).gaussianBlur // 36 (ADDED to the author's own 4, so v = 1 lands on 4)
 * @example blurFadeState({active: {type: "~visibleFx", mode: "blurFade", v: 0.5, blur: 8}}).gaussianBlur // 4 (a SMALL custom amount — the knob the user asked for)
 * @example blurFadeState({active: {type: "~visibleFx", mode: "blurFade", v: 1, blur: 64}}).gaussianBlur // undefined (v = 1 adds nothing — the endpoint is exact)
 * @example blurFadeState({active: {type: "~visibleFx", mode: "blurFade", v: 0.5}}).gaussianBlur // 32 (no parameter on the token = the declared default)
 * @example (() => { const s = {active: true}; return blurFadeState(s) === s; })() // true (identity for every other node)
 */
export function blurFadeState(state) {
  const a = state?.active;
  if (!isVisibleFxToken(a) || a.mode !== "blurFade") return state;
  // The parameter rides the token as a scalar (core/interp_modes namedVisibleBlend).
  // A token without one predates the parameter or was built by hand, and takes
  // the declared default — the same number the fold would have put there.
  const amount = typeof a.blur === "number" && Number.isFinite(a.blur) ? Math.max(0, a.blur) : BLUR_FADE_MAX_RADIUS;
  const added = amount * (1 - visibleLevel(a));
  if (added <= 0) return state;
  return { ...state, gaussianBlur: (state.gaussianBlur ?? 0) + added };
}

// ── `grow`: THE SCALE RAMP, AND WHY IT IS ON THE WORLD TRANSFORM ─────────────
//
// User request, 2026-08-03, verbatim (WORKSTREAM BS): "Another intro... sorry,
// visible interp should be growing from nothing or shrinking back to nothing."
//
// ── THE EVERY-SHADER LAW DECIDES THE SEAM, NOT CONVENIENCE ──────────────────
// User ruling, 2026-08-03, verbatim (WORKSTREAM BQ): "There is no shader that
// shouldn't work with this. Every shader should work with this. It shouldn't be
// dependent on the type of shader."
//
// So the question this function had to answer FIRST is where a widget's size can
// be changed in a way a shader CANNOT opt out of. There are three candidate
// seams and only one of them is honest:
//
//   1. THE STATE (what blurFadeState does, one function up). Scaling `state.w/h`
//      or `state.scale` before emit() would be a LIE about the document — every
//      plugin reads those leaves to lay out its own content, so a text widget
//      would re-wrap its lines at each frame and a material would re-derive its
//      uniforms from a size the author never wrote. It also could not reach a
//      widget whose emit() ignores `scale` entirely.
//   2. THE OPS (what applyActiveFade does). A per-op geometric rewrite is
//      impossible in general: `materialFill` carries cx/cy/halfW/halfH, `text`
//      carries a font size, `video` carries a source rect, and a `path` carries
//      absolute coordinates. Rewriting all of them correctly is exactly the
//      per-op knowledge the law forbids depending on, and any op the walker had
//      not been taught about would silently not grow.
//   3. THE WORLD TRANSFORM — this one. Every node's ops are emitted INSIDE
//      exactly one `pushTransform(node.world)` (emitNodeBody's return, the only
//      exit this function has), and every backend — Skia, PDF, SVG, the bare-node
//      CLI — realizes that push as its own CTM. A shader cannot escape the CTM:
//      it does not get to choose where its quad lands, because the quad's
//      placement is applied by the painter around it, outside any shader's code.
//      That is a STRUCTURAL guarantee rather than a roster of cooperating
//      plugins, which is what the ruling asks for.
//
// So grow multiplies `node.world.scale`. Nothing downstream of this line knows
// the mode exists: the ops are byte-identical to the widget's own, and the
// picture changes because the frame they are painted in is smaller.
//
// ── THE ANCHOR IS THE ROTATION ANCHOR (its centre by default) ───────────────
// The founding block asks the implementer to state the choice: the fixed point is
// the item's ROTATION ANCHOR — `core/derive.worldTransform`'s pivot, which is the
// item's geometric centre unless the author moved it ("the default rotation
// anchor is the object's center — self.anchors.center", manifest Round 11).
//
// WHY THAT ONE. Growing from the box's local origin (the top-left) is the failure
// mode the block names: the widget appears to slide out of its own corner, which
// reads as a placement bug rather than an entrance. The centre is the point an
// author already understands as "where this widget is", AND reusing the ROTATION
// anchor specifically means the two transforms agree about where the widget's
// still point is: an author who moved the anchor to make a widget swing about its
// edge gets it growing from that same edge, which is the one answer consistent
// with what they already told us. A separate grow-anchor would be a second
// vocabulary for the same idea.
//
// ROTATION COMPOSES BECAUSE ONLY `scale` AND THE TRANSLATION MOVE. The output
// carries the input's rotation UNCHANGED, and the translation is the unique one
// that keeps the anchor a fixed point, so a rotated widget grows in place at a
// constant angle — it never sweeps an arc. (An implementation that re-derived the
// world through `T.aboutPivot` DOES sweep, measured: aboutPivot re-parametrizes
// about a pivot expressed in the PRE-scale frame, so at k = 1 it already moves
// the anchor. This function scales about a WORLD point instead, which is why it
// is its own two lines of arithmetic and not a call to that helper.)

/**
 * Pure function. THE GROW SCALE RAMP — a node's world transform with its scale
 * multiplied by the mode's coverage, about the item's rotation anchor. Returns
 * the VERY SAME transform object for every node that is not mid-`grow`.
 *
 * The coverage IS the scale factor (linear, no easing): at v = 0 the widget is a
 * point at its anchor, at v = 1 it is exactly its authored size. v = 1 returns by
 * IDENTITY, so the endpoint is byte-identical to the same widget with no mode at
 * all — the endpoint law, enforced here rather than trusted to floating point.
 *
 * @param {object} world - the node's world similarity {x, y, rotation, scale}
 * @param {object} state - the node's evaluated state (`active`, and the box the anchor comes from)
 * @returns {object} the transform itself, or a copy scaled about the anchor
 *
 * @example growScaledWorld({x: 0, y: 0, rotation: 0, scale: 1}, {active: true}).scale // 1 (not a grow — the same object back)
 * @example growScaledWorld({x: 0, y: 0, rotation: 0, scale: 1}, {active: {type: "~visibleFx", mode: "blurFade", v: 0.5}}).scale // 1 (a different named mode does not scale)
 * @example growScaledWorld({x: 0, y: 0, rotation: 0, scale: 1}, {active: {type: "~visibleFx", mode: "grow", v: 0.5}, w: 200, h: 100}).scale // 0.5
 * @example growScaledWorld({x: 0, y: 0, rotation: 0, scale: 1}, {active: {type: "~visibleFx", mode: "grow", v: 0.5}, w: 200, h: 100}).x // 50 (the centre (100,50) held fixed)
 * @example growScaledWorld({x: 0, y: 0, rotation: 0, scale: 1}, {active: {type: "~visibleFx", mode: "grow", v: 0}, w: 200, h: 100}) // {x: 100, y: 50, rotation: 0, scale: 0} (collapsed onto the anchor)
 * @example growScaledWorld({x: 0, y: 0, rotation: 0.7, scale: 1}, {active: {type: "~visibleFx", mode: "grow", v: 0.5}, w: 200, h: 100}).rotation // 0.7 (the angle is untouched — it grows in place, never sweeping an arc)
 * @example (() => { const w = {x: 0, y: 0, rotation: 0, scale: 1}; return growScaledWorld(w, {active: {type: "~visibleFx", mode: "grow", v: 1}, w: 200, h: 100}) === w; })() // true (v = 1 is the exact authored render)
 */
export function growScaledWorld(world, state) {
  const a = state?.active;
  if (!isVisibleFxToken(a) || a.mode !== "grow") return world;
  const k = visibleLevel(a);
  if (k === 1) return world; // the endpoint is the authored render, by identity
  const anchor = growAnchorWorld(world, state);
  // SCALE ABOUT A FIXED WORLD POINT: out = translate(P) ∘ scale(k) ∘ translate(-P)
  // applied to `world`. Because a similarity's scale acts about its own origin,
  // this is exactly "move the origin toward P by (1 - k)" — rotation untouched,
  // and P is a fixed point at every k INCLUDING k = 0 (where the whole widget
  // collapses onto it). `signX/signY` ride along in the spread: a flip is a
  // reflection, orthogonal to the size ramp, and must survive it.
  return {
    ...world,
    x: anchor.x + (world.x - anchor.x) * k,
    y: anchor.y + (world.y - anchor.y) * k,
    scale: world.scale * k,
  };
}

/**
 * Pure function. The WORLD point a `grow` ramp holds fixed: the item's rotation
 * anchor, falling back to its box centre, falling back to the transform's own
 * origin for a widget with no box.
 *
 * The three cases mirror `core/derive.worldTransform`'s pivot resolution exactly,
 * and deliberately so — the two must not be able to disagree about where a
 * widget's still point is. `rotationAnchor` is already a WORLD point (an
 * equation-valued property the expression pass evaluated to numbers before
 * derivation), so it is used as-is; the box centre is a base-frame point and has
 * to be carried through `world` to become one.
 *
 * A NON-FINITE ANCHOR CANNOT ARISE HERE: emitNodeBody's non-finite containment
 * seam runs BEFORE this and diverts a bad world to the error affordance, and the
 * box centre is arithmetic over leaves the same seam has already accepted.
 *
 * @example growAnchorWorld({x: 0, y: 0, rotation: 0, scale: 1}, {w: 200, h: 100}) // {x: 100, y: 50} (the box centre)
 * @example growAnchorWorld({x: 0, y: 0, rotation: 0, scale: 1}, {w: 200, h: 100, rotationAnchor: {x: 10, y: 20}}) // {x: 10, y: 20} (the author moved it — grow follows)
 * @example growAnchorWorld({x: 7, y: 9, rotation: 0, scale: 1}, {}) // {x: 7, y: 9} (no box: the transform's own origin)
 */
function growAnchorWorld(world, state) {
  const ra = state?.rotationAnchor;
  if (ra && Number.isFinite(ra.x) && Number.isFinite(ra.y)) return { x: ra.x, y: ra.y };
  if (state?.w == null || state?.h == null) return { x: world.x, y: world.y };
  // The centre in the item's LOCAL frame (the box is [0..w]×[0..h] there), mapped
  // out through the node's own world so rotation and scale are already accounted
  // for. Reading `state.w/h` is sign-blind-safe: core/derive normalizes a negative
  // extent away before a node exists (the NEGATIVE EXTENTS protocol).
  return applySimilarity(world, state.w / 2, state.h / 2);
}

/**
 * Pure function. A similarity transform applied to a local point — the one piece
 * of core/transform.js this file needs, inlined to keep render_gpu/ports.js's
 * import surface unchanged (it already imports nothing from core/transform.js).
 *
 * @example applySimilarity({x: 0, y: 0, rotation: 0, scale: 2}, 10, 5) // {x: 20, y: 10}
 * @example applySimilarity({x: 100, y: 0, rotation: Math.PI / 2, scale: 1}, 10, 0).y // 10
 */
function applySimilarity(t, lx, ly) {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  return {
    x: t.x + t.scale * (c * lx - s * ly),
    y: t.y + t.scale * (s * lx + c * ly),
  };
}

/**
 * Near-pure function (reportOnce logs the outline-less fallback). THE MANIM
 * DRAW-IN EMIT — a `manim`-moded node's ops mid-transition: its outline traced
 * partway as a SKETCH STROKE, with its real ink faded up underneath once the
 * trace completes. Returns `cmds` UNTOUCHED for every other node.
 *
 * ── THE MAPPING AS SHIPPED ───────────────────────────────────────────────────
 * core/manim_draw.js owns the law (phase split at v = 0.5, arc-length trim,
 * per-subpath stagger, double_smooth) and this owns its translation into ops.
 * Per subpath of the widget's `morphPaths` payload — the same currency every
 * vector widget here already speaks — the plan's `trims[i]` becomes a partial
 * path drawn with the sketch stroke and NO fill; the plan's `fillAlpha` becomes
 * the opacity of the widget's OWN emit() output, drawn underneath. Both are
 * present through phase 1, which is what makes the sketch hand off to the real
 * ink continuously instead of popping: the sketch fades out (`sketchWeight`) as
 * the fill rises, exactly as Manim's `interpolate_color` ramps stroke and fill
 * together over one sub-alpha (research §2.2).
 *
 * ── THE OUTLINE-LESS FALLBACK IS AUTOMATIC AND REPORTED ──────────────────────
 * A widget with no `morphPaths` (a photo, a video, a map) has no border to
 * trace. It takes a PLAIN FADE — which it already has, because applyActiveFade
 * reads the token's coverage for every named mode — so this function simply
 * returns `cmds` and the picture is a fade. It is REPORTED once, naming the
 * item and its type: the author asked for a specific animation and did not get
 * it, the same rule core/derive.js applies to a refused morph. It NEVER throws.
 *
 * ── THE SKETCH DRAWS WITH THE WIDGET'S REAL STROKE, MATERIALS INCLUDED ───────
 * The pen's colour is the first tier of `sketchPaintTiers` this renderer can
 * actually stroke with — a colour, a gradient, or a stroke MATERIAL, resolved
 * here through the same helper every op slot uses. That is WORKSTREAM AO's
 * ruling, and manimSketchStroke below carries it with its argument; the sketch
 * used to drop any non-string tier, which is why a material-inked widget traced
 * nothing at all.
 *
 * ── WHY THE REAL INK IS DRAWN AND NOT REBUILT FROM THE PAYLOAD ───────────────
 * A `morphPaths` payload is an OUTLINE, not a picture: it carries no material,
 * no gradient mapping, no image, no per-glyph text layout. Fading the widget's
 * own emit() is what makes "then the inside is filled" fill with the widget's
 * ACTUAL fill — a CRT shader, a linear gradient, a photograph — rather than a
 * flat approximation of it. The payload is used for the one thing it IS: the
 * path the pen follows.
 *
 * ── REVERSAL NEEDS NO CODE HERE ──────────────────────────────────────────────
 * `v` decreasing runs this identical function with a smaller number, so the fill
 * fades out first and the border un-traces below 0.5 — the same phase boundary
 * crossed the other way, which is precisely how Manim's own Unwrite/Uncreate
 * work (research §8.2). There is deliberately no direction flag to find here.
 *
 * @param {object} node - a derive render node
 * @param {object[]} cmds - the node's own emitted ops
 * @returns {object[]} the ops, or the sketch-plus-fill composition
 *
 * @example manimIR({state: {active: true}}, [{op: "rect"}]) // [{op: "rect"}] (not a manim node — the same array)
 * @example manimIR({state: {active: {type: "~visibleFx", mode: "blurFade", v: 0.5}}}, [{op: "rect"}]) // [{op: "rect"}] (a different named mode)
 * @example // at v = 0.3 the outline is partly traced and NOTHING is filled — every op is a sketch path:
 * @example manimIR({itemId: "a", type: "rect", plugin: {morphPaths: () => ({space: {w: 10, h: 10}, fillRule: "nonzero", subpaths: [{start: [0, 0], curves: [[3, 0, 7, 0, 10, 0]], closed: false, winding: 1, paint: {fill: "#f00", strokeWidth: 0}}]})}, state: {active: {type: "~visibleFx", mode: "manim", v: 0.3}, w: 10, h: 10, fill: "#f00"}}, [{op: "rect"}]).every((c) => c.op === "path") // true
 */
export function manimIR(node, cmds, nodesById = null) {
  const a = node.state?.active;
  if (!isVisibleFxToken(a) || a.mode !== "manim") return cmds;
  if (typeof node.plugin?.morphPaths !== "function") {
    // NO OUTLINE, NO TRACE — the fade fallback, named once. A mode the author
    // picked and did not get must not be silent (core/derive.js's refused morph
    // makes the identical promise). `morphNotReady` is deliberately NOT consulted
    // here: an icon still fetching has an outline COMING, and reporting a
    // permanent degradation for a transient wait would be the wrong sentence —
    // the empty-payload guard below covers that frame instead.
    reportOnce(
      `ports:manim:${node.itemId}:${node.type}`,
      `PowerRP: item "${node.itemId}" (${node.type}) has its Visible interp set to "Manim", but a ${node.type} has no outline to draw, so it fades in instead. Manim mode draws vector widgets — shapes, icons, equations, arrows.`,
    );
    return cmds;
  }
  const payload = node.plugin.morphPaths(node.state);
  const subpaths = payload?.subpaths ?? [];
  // AN EMPTY PAYLOAD IS A WAIT, NOT A REFUSAL — an icon mid-fetch, an equation
  // mid-typeset. The plain fade is the right frame for it and the next frame
  // will have the outline, so this is silent by design where the branch above is
  // loud: nothing is permanently degraded.
  if (!subpaths.length) return cmds;
  const plan = manimDrawPlan(visibleLevel(a), subpaths.length);
  // THE BOX. The payload lives in its own `space` and the node draws in its own
  // box, so the sketch is scaled by the ratio — 1 for every provider that
  // measured itself against the widget box, which is the overwhelming majority.
  // This is morphIR's unit mapping without its double-counting trap: there is
  // only ONE payload here and it is already in this widget's own space, so there
  // is no second tween of the box to accidentally count twice.
  const sx = (node.state.w ?? payload.space?.w ?? 1) / (payload.space?.w || 1);
  const sy = (node.state.h ?? payload.space?.h ?? 1) / (payload.space?.h || 1);
  const fill = plan.fillAlpha > 0 ? scaledOpacity(cmds, plan.fillAlpha) : [];
  // A FULLY HANDED-OFF SKETCH IS NOT DRAWN AT ALL, rather than drawn at opacity
  // 0. The two look identical, but an invisible op is still an op: it is a path
  // every backend tessellates and every reader of the display list has to
  // explain. This is also what makes v → 1 land on EXACTLY the widget's own ops,
  // which is the endpoint law the byte-identity test pins.
  const sketch = plan.sketchWeight <= 0 ? [] : subpaths.flatMap((sp, i) => {
    const trimmed = trimSubpathByLength(sp, plan.trims[i]);
    if (!trimmed) return [];
    const d = payloadToPathD({ ...payload, subpaths: [scaledSubpath(trimmed, sx, sy)] });
    if (!d) return [];
    // THE SKETCH PAINT'S TIER LADDER (research §2.1), over the subpath's own
    // paint when it has one — an SVG icon's contours genuinely differ — and the
    // widget's otherwise. See manimSketchStroke: the winner may be a colour, a
    // gradient OR a material, and it arrives RESOLVED.
    const stroke = manimSketchStroke(sp.paint ?? manimStatePaint(node.state), node, nodesById);
    if (stroke === null) return [];
    return [path({
      d,
      fill: null, // "fill is forced to 0 during phase 0" (§2.1) — and it stays off here, because the REAL fill is the layer below
      stroke,
      strokeWidth: MANIM_SKETCH_STROKE_WIDTH,
      fillRule: payload.fillRule,
      opacity: plan.sketchWeight,
    })];
  });
  // THE FILL GOES UNDER. The sketch stroke is what the eye follows, so it must
  // not be buried by the ink rising behind it.
  return [...fill, ...sketch];
}

/**
 * Pure function. THE WIDGET-STATE HALF OF THE SKETCH TIER LADDER — what a
 * widget's own state offers the Manim trace as `{fill, stroke, strokeWidth}`.
 *
 * It is core/morph_payload.statePaint WITH THE GLYPH ROW FOLDED IN, and that is
 * the whole reason it exists rather than being that function (WORKSTREAM AO,
 * item 3). `statePaint` reads `stroke`/`strokeWidth`, which on a TEXT widget mean
 * nothing at all — plugins/plaintext.js declares no `stroke` row, and
 * plugins/latex.js spends `stroke` on the BOX BORDER, not on the letterforms. So
 * for text and equations the ladder's middle tier read `null` and silently fell
 * through to the fill, and an author who had drawn a red outline around their
 * letterforms watched the sketch ignore it.
 *
 * THE TIER IS `glyphStroke`, GATED ON `glyphStrokeWidth`, exactly as the widgets'
 * own emit() gates it (both declare the pair, both treat width 0 as "no
 * outline"). A widget that has BOTH kinds — a bordered equation with a glyph
 * outline — prefers the GLYPH one, because the trace draws LETTERFORMS: the
 * payload it is trimming is the glyph outlines, and the paint that describes
 * those is `glyphStroke`. Its box border is not what is being drawn.
 *
 * A widget with no glyph row (every shape, icon, arrow) is byte-identical to
 * `statePaint`.
 *
 * @param {object} s - a widget state bag
 * @returns {{fill, stroke, strokeWidth}}
 *
 * @example manimStatePaint({fill: "#f00", stroke: "#00f", strokeWidth: 2}).stroke // '#00f' (a shape: statePaint, unchanged)
 * @example manimStatePaint({fill: "#000", glyphStroke: "#f00", glyphStrokeWidth: 3}).stroke // '#f00' (text: the LETTERFORM outline is the stroke tier)
 * @example manimStatePaint({fill: "#000", glyphStroke: "#f00", glyphStrokeWidth: 0}).stroke // null (width 0 = no outline, same gate emit() uses)
 * @example manimStatePaint({fill: "#000", stroke: "#0f0", strokeWidth: 2, glyphStroke: "#f00", glyphStrokeWidth: 3}).stroke // '#f00' (the glyph row wins: the trace draws letterforms, not the box)
 */
export function manimStatePaint(s) {
  const glyphWidth = s?.glyphStrokeWidth ?? 0;
  const base = statePaint(s ?? {});
  if (glyphWidth > 0 && s?.glyphStroke != null) return { ...base, stroke: s.glyphStroke, strokeWidth: glyphWidth };
  return base;
}

/**
 * Query (reads the material registries; reports once on a foreign knob). THE
 * SKETCH STROKE — the first tier of `sketchPaintTiers` this renderer can
 * ACTUALLY STROKE WITH, resolved and painter-ready. `null` when no tier is.
 *
 * ── THE RULING (WORKSTREAM AO, user, 2026-08-02) ─────────────────────────────
 *   "wouldn't it make sense to use the material stroke if provided for the manum
 *    entry effect instead of always using white? For example, if I select a red
 *    stroke, then the manum effect should use that stroke, or a material stroke,
 *    then manum should use that material stroke to draw."
 *
 * As shipped the tier's answer was DROPPED unless it was a string, on the
 * argument that "`stroke` takes a colour". That argument was simply false about
 * this codebase: `ir.path()` normalizes its `stroke` through `parsePaint`, which
 * passes materials, gradients and crossfades through by design, and
 * paint_skia.drawOpStroke has routed a material stroke to the stroke-material
 * framework since the framework existed. Nothing had to be built to honour the
 * ruling — a working seam was being bypassed, and the visible result was a
 * material-inked widget whose sketch was not drawn AT ALL.
 *
 * ── WHY A TIER CAN STILL BE REFUSED, AND WHAT THAT MUST NOT BE ───────────────
 * Not every material can be a STROKE. There are two registries: fill materials
 * (crt, sky, comic, glass…) and stroke materials (alongGradient, widthProfile,
 * dashes, wavy, brush, textureBrush). Handing a FILL-ONLY material to
 * getStrokeMaterial THROWS — that is the exact crash `d545ddc` shipped to contain
 * (core/paint_containment.js's third case: it bricked the app across reloads,
 * because autosave restored the poisoned document every boot). So a fill-only
 * material tier must never reach the painter as a stroke.
 *
 * IT MUST ALSO NOT END THE LADDER. The refusal is about THIS TIER, not about the
 * widget: a crt-filled star still has a fill tier to try, and before this change
 * an unusable tier produced no sketch at all. So `sketchStrokePaint` WALKS —
 * refuse a tier, take the next, and only a widget with nothing strokeable
 * anywhere gets no sketch (and then the real ink's own fade still tells the
 * story, which is the pre-existing behaviour for a paintless widget).
 *
 * ── RESOLUTION, AND WHY IT IS HERE AND NOT UPSTREAM ──────────────────────────
 * `resolveMaterialFillPaints` runs on the node's own emit() output BEFORE
 * manimIR, so it never sees this paint: the sketch's stroke is read out of STATE
 * (or a payload's own paint), not out of an op. An unresolved material reaching
 * the painter is a hard throw by contract, so it is resolved HERE, through the
 * same `resolvedPaint` helper every op slot uses — including THROUGH a crossfade,
 * because a widget mid-`blend` carries a `{type: "crossfade", from, to, t}` on
 * exactly the interior frames Manim mode is drawing on. A bare `isMaterialPaint`
 * test here would be the third instance of the bug that helper exists to kill.
 *
 * @param {object} paint - a tier source, {fill, stroke, strokeWidth}
 * @param {object|null} node - the render node (material scene params read it)
 * @param {Map|null} nodesById - the scene's nodes by id, for scene-sampling materials
 * @returns {*} a painter-ready stroke paint, or null
 *
 * @example manimSketchStroke({fill: "#f00", stroke: "#00f", strokeWidth: 2}) // '#00f'
 * @example manimSketchStroke({fill: "#f00"}) // '#f00'
 * @example manimSketchStroke({}) // null
 * @example // a STROKE material is used, and comes back RESOLVED:
 * @example !!manimSketchStroke({stroke: {type: "material", material: {id: "wavy"}}, strokeWidth: 2}).resolvedParams // true
 * @example // a FILL-ONLY material falls THROUGH to the next tier rather than crashing:
 * @example manimSketchStroke({fill: "#f00", stroke: {type: "material", material: {id: "crt"}}, strokeWidth: 2}) // '#f00'
 */
export function manimSketchStroke(paint, node = null, nodesById = null) {
  const winner = sketchStrokePaint(paint, canStrokeWithPaint);
  return winner === null ? null : resolvedPaint(winner, node, nodesById);
}

/**
 * Pure function. Can this renderer STROKE with this paint? The acceptance
 * predicate `sketchStrokePaint` walks the tier ladder with.
 *
 * A colour or a gradient: yes, always. A MATERIAL: only if it is in the STROKE
 * registry — see manimSketchStroke's docblock for why a fill-only material must
 * be refused rather than handed to getStrokeMaterial. A CROSSFADE is strokeable
 * iff BOTH its sides are, because the painter's crossfade router draws each side
 * as an ordinary op and a bad side would throw on its own pass.
 *
 * `{type: "none"}` is a paint that draws NOTHING, so it is not a tier: accepting
 * it would end the ladder on a stroke nobody can see, which is the "always white"
 * complaint wearing a different hat.
 *
 * @param {*} p - a candidate paint
 * @returns {boolean}
 *
 * @example canStrokeWithPaint("#ff0000") // true
 * @example canStrokeWithPaint({type: "material", material: {id: "wavy"}}) // true (a stroke material)
 * @example canStrokeWithPaint({type: "material", material: {id: "crt"}}) // false (fill-only — getStrokeMaterial would throw)
 * @example canStrokeWithPaint({type: "none"}) // false (draws nothing, so it is not a usable tier)
 * @example canStrokeWithPaint(null) // false
 */
export function canStrokeWithPaint(p) {
  if (p === null || p === undefined) return false;
  if (isPaintOff(p)) return false;
  if (isMaterialPaint(p)) return hasStrokeMaterial(p.material?.id);
  if (isCrossfadePaint(p)) return canStrokeWithPaint(p.from) && canStrokeWithPaint(p.to);
  return true;
}
