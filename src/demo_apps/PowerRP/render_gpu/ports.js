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

import { video, pushTransform, popTransform } from "./ir.js";

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
 * flattenIR() it fresh, from identity — render_gpu/gpu/compositor.js's
 * packList and pdf_backend.js's emitRegion never nest it inside the crop
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
 * context `{pdfDisplay}`). This is the ONLY view-derived data emit ever sees,
 * and only pdf_page reads it (to draw the crisp visible-region raster instead of
 * a whole-page bitmap); every other plugin ignores the 4th arg. Surfaces with no
 * pre-pass (export, thumbnails, CLI, tests) pass nothing → emit takes its
 * camera-free fallback (vector for export, whole-page raster otherwise). emit
 * stays PURE (same args → same output); the map is a plain argument, never a
 * global the walker reaches into.
 *
 * Args:
 *   nodes (object[]): deriveRenderTree output (nodes carry .plugin)
 *   ctx ({pdfDisplay?: Map}): optional render-time display context (see above)
 *
 * Returns:
 *   object[]: IR commands (z-ordered because nodes are)
 *
 * @example // sceneIR(deriveRenderTree(evaluateState(state, registry).state, registry)) → [pushTransform, rect, popTransform, ...]
 * @example sceneIR([]) // []
 */
export function sceneIR(nodes, ctx = {}) {
  const pdfDisplay = ctx.pdfDisplay ?? null;
  const byId = new Map(nodes.map((n) => [n.itemId, n]));
  const out = [];
  for (const node of nodes) {
    // A FOLDED GROUP MEMBER (core/derive.resolveGroupSubtrees marked it foldedBy)
    // is NOT drawn at the top level — it renders INSIDE its owning group's
    // composited subtree (built by emitNode below), so the group's shadow/bloom/
    // blend/crop wraps it as one unit. Every non-folded node draws normally.
    if (node.foldedBy) continue;
    out.push(...emitNode(node, byId, pdfDisplay));
  }
  return out;
}

/**
 * Pure function. Emits ONE render node's IR (its emitted ops wrapped in its world
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
 */
function emitNode(node, byId, pdfDisplay) {
  if (!node.plugin?.emit) throw new Error(`sceneIR: plugin "${node.type}" has no emit()`);
  // GROUP SUBTREE: build the folded members' absolute-world IR (recursively).
  const subtreeIR = node.type === "group" && Array.isArray(node.subtreeMemberIds) && node.subtreeMemberIds.length
    ? node.subtreeMemberIds.flatMap((id) => (byId.has(id) ? emitNode(byId.get(id), byId, pdfDisplay) : []))
    : null;
  const targetWorldIR = node.type === "cropbox" && node.cropTarget
    ? [pushTransform(node.cropTarget.world), ...node.cropTarget.plugin.emit(node.cropTarget.state), popTransform()]
    : null;
  const renderCtx = pdfDisplay ? { pdfDisplay: pdfDisplay.get(node.itemId) ?? null } : null;
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
  const cmds = node.plugin.emit(node.state, subtreeIR ?? targetWorldIR, node.world, renderCtx);
  if (cmds.length === 0) return [];
  return [pushTransform(node.world), ...cmds, popTransform()];
}
