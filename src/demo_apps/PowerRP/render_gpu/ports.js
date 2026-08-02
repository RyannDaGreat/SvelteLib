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

import { video, pushTransform, popTransform, signedCompose, isMaterialPaint, applyStrokeTrim, applyStrokeOffset, applyStrokeJoin, parsePaint, isPaintableFrame, rect, text } from "./ir.js";
import { applyNodeEffects } from "./effects.js";
import { resolveMaterialPaint } from "./skia/materials.js";
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
 * @param {*} background - the camera's stored background paint
 * @param {Array|null} nodes - the derived render nodes (scene hooks read them)
 * @returns {*} a fill the painters accept
 *
 * @example resolvedBackgroundFill("#123f5a", []) // [0.070..., 0.247..., 0.352..., 1]
 * @example resolvedBackgroundFill({type: "material", material: {id: "comic", params: {}}}, []).resolvedParams.mode // "cmyk"
 */
export function resolvedBackgroundFill(background, nodes) {
  const p = parsePaint(background);
  if (!isMaterialPaint(p)) return p;
  const byId = new Map((nodes ?? []).map((n) => [n.itemId, n]));
  const camera = (nodes ?? []).find((n) => n.type === "camera") ?? null;
  return resolveMaterialPaint(p, camera, byId, warnOnce); // foreign-knob carry-over is intended and lossless — warn, never error
}

export function resolveMaterialFillPaints(cmds, node, nodesById) {
  return cmds.map((cmd) => {
    let out = cmd;
    if (isMaterialPaint(cmd.fill))
      out = { ...out, fill: resolveMaterialPaint(cmd.fill, node, nodesById, warnOnce) };
    if (isMaterialPaint(cmd.stroke))
      out = { ...out, stroke: resolveMaterialPaint(cmd.stroke, node, nodesById, warnOnce) }; // same as the fill above
    // TEXT INK IS A THIRD PAINT SLOT, and it is not called `fill`. A text op
    // carries its ink on `color` (ir.js text()), and a RICH text op additionally
    // carries a per-RUN `color` — so a material ink on either would reach the
    // painter unresolved and throw, exactly the way a material camera background
    // did before resolvedBackgroundFill existed. The two slots are resolved here
    // rather than at a text-specific seam because this IS the one resolution site
    // the docblock above promises; a second one would be the drift it warns about.
    if (isMaterialPaint(cmd.color))
      out = { ...out, color: resolveMaterialPaint(cmd.color, node, nodesById, warnOnce) };
    if (Array.isArray(cmd.rich?.runs) && cmd.rich.runs.some((r) => isMaterialPaint(r.color))) {
      const runs = cmd.rich.runs.map((r) =>
        isMaterialPaint(r.color) ? { ...r, color: resolveMaterialPaint(r.color, node, nodesById, warnOnce) } : r);
      out = { ...out, rich: { ...cmd.rich, runs } };
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
  const mirror = mirrorPush(node);
  const emitWorld = mirror ? signedCompose(node.world, mirror) : node.world;
  const cmds = resolveMaterialFillPaints(
    node.plugin.emit(node.state, subtreeIR ?? targetWorldIR, emitWorld, renderCtx),
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
  const body = applyActiveFade(node.state, applyStrokeJoin(node.state, applyStrokeOffset(node.state, applyStrokeTrim(node.state, applyNodeEffects(node, cmds)))));
  // THE OWNER TAG — this node's identity, hung on the ONE push that opens its op
  // run, so the PAINT-TIME boundary can name the item it had to contain
  // (render_gpu/skia/paint_skia.js paintFlat; flattenIR carries the tag down onto
  // every op emitted under it). It rides the push rather than each op because
  // that is O(1) per node instead of O(ops), and because a node's ops are
  // EXACTLY the run between its push and its matching pop — the grouping the
  // boundary needs is already in the structure.
  const owner = ownerTag(node);
  return mirror
    ? [{ ...pushTransform(node.world), owner }, mirror, ...body, popTransform(), popTransform()]
    : [{ ...pushTransform(node.world), owner }, ...body, popTransform()];
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
