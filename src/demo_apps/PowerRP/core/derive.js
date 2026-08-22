/**
 * Derivation stage: folded state → render tree.
 *
 * THE core invariant: RenderTree = pure(document, [[slide, alpha]]). The
 * render tree is never stored; parents, replicators, and symlink resolution
 * all live here (V1 implements the trivial identity chain — parents and
 * replicators arrive in a later version, but every downstream consumer
 * already sees only derived nodes, so they will slot in without breakage).
 *
 * A render node:
 *   { id,          // derived id — equals the stored item id in V1; replicated
 *                  //   copies would get "<replicatorId>/<index>"
 *     itemId,      // the STORED item this derives from (deltas target this)
 *     type, state, // folded item state
 *     world,       // similarity transform local→world (parent-composed later)
 *     mirror?,     // {x, y} booleans — present ONLY on a FLIPPED node (see below)
 *     plugin }
 *
 * THE FLIP NORMALIZATION (core/geometry.js flippedBox / unsignedState). A stored
 * w or h may be NEGATIVE: that is how a reflection is represented, because the
 * pose is a similarity and a similarity cannot carry one. Derivation is where
 * that sign STOPS: every node's state is normalized to a non-negative box and the
 * sign becomes `node.mirror`, so nothing downstream — no plugin `emit()`, no
 * `hitTest`, no shader half-extent, no exporter substrate — ever sees a negative
 * extent. `node.world` is built from that unsigned box too, so it carries no sign
 * either and a consumer mapping `T.apply(node.world, state.w / 2, ...)` is right as
 * written. Only two consumers read `mirror`: the render walk
 * (render_gpu/ports.js sceneIR, which wraps the node's commands in a local
 * reflection) and `hitNode` below (which reflects the probe point back). Because
 * the flip is an involution, a flipped node normalizes to the SAME geometry as its
 * unflipped self, so its footprint, snap features, anchors, AABB and cull result
 * are identical — the flip changes only which way its content faces.
 *
 * THE SAME MAP SERVES THE PRE-DERIVATION READERS, and must: `pointInNodeBox` and
 * `composedMemberInfluence` below, plus `anchors` / `closestAnchor` as called from
 * core/expressions.js, all read RAW item state because the expression pass runs
 * before any node exists — so each enters the seam explicitly. The contract as a
 * whole is stated once, in core/registry.js's plugin docblock, and pinned per
 * widget by tests/negative_size_test.js.
 */

import * as T from "./transform.js";
import { reportOnce } from "./report.js";
import { describeOwner, isConfigurationError, throwMessage } from "./paint_containment.js";
import { boxCenter, unionRect, unmirroredLocal, unsignedState } from "./geometry.js";
import { pluginAssetRefProps, resolveStateAssetRefs } from "./asset_ref.js";
import { allPaintModifierPoints, paintCapableKeys } from "./paint_handles.js";
import { contentMorphKeyFor, isContentMorphToken, isMorphToken, morphPairPolicy } from "./interp_modes.js";
import { MORPH_KEY, isUniversalMorphToken } from "./morph_property.js";
// THE NODE-GRAPH SEAM (see deriveRenderTree). One-way: nodeflow.js imports nothing
// from this module, so the port/type/connection layer stays independently testable
// in bare node with no derivation in the picture.
import { EXEC_KEY, evaluateNodeGraph, inputRefs, portLayout, resolveNode, topoOrder } from "./nodeflow.js";
// THE FRAME DOMAIN — per-frame triggers (core/exec_frame.js). Its step is driven from
// deriveRenderTree, the one pass that produces the picture; see the call site for why
// running several times per frame is safe rather than merely tolerated.
import { firedWireKeys, stepFrameDomain } from "./exec_frame.js";
import { beginSimulationStep, cameraMaxTimestep } from "./simulation_history.js";
import { particleTime } from "../render_gpu/particle_clock.js";

/**
 * Query (reads the registry; reports once on a refused pair). THE MORPH
 * RESOLUTION — a `type` leaf holding a mid-morph token (core/interp_modes.js
 * isMorphToken) → the ONE type this node derives as, plus the morph payload pair
 * the render walk needs.
 *
 * WHY THIS LIVES IN derive AND NOT IN ports. Resolving a morph needs BOTH
 * plugins, and derive is the one stage that holds the registry — ports.js walks
 * nodes that already carry a single resolved `.plugin`, and handing it a registry
 * so it could look up a second one would give the render walk a dependency the
 * whole no-plugin-imports-another fence exists to deny. So the pair is resolved
 * ONCE here, and ports sees a node with an ordinary plugin plus a `.morph` mark —
 * the same shape as `.mirror`, `.cropTarget` and `.subtreeMemberIds`, every one
 * of which is a cross-node fact derive resolved so the walker did not have to.
 *
 * THE FALLBACK IS THE TARGET TYPE, and it is the discrete switch the document
 * would have had before this feature: a pair that cannot morph (one side is a
 * video, or an icon has not fetched yet) derives as the INCOMING type at every
 * alpha > 0, byte-identically to `step`. That is not a swallow — the pair's
 * refusal REASON is reported once, naming the item and both types, because a
 * morph the author asked for and did not get is exactly the silent-wrong-picture
 * this codebase forbids.
 *
 * Args:
 *   type (*): the folded `type` leaf — a plain string, or a morph token
 *   state (object): the item's folded state
 *   registry (object): the plugin registry
 *   itemId (string): for the report line
 *
 * Returns:
 *   {type: string, morph: object|null} — `morph` is
 *   `{fromPlugin, toPlugin, fromState, toState, t}` when the pair really morphs
 *
 * @example resolveMorphType("rect", {}, {get: (t) => ({type: t})}, "a1") // {type: "rect", morph: null}
 * @example // an unmorphable pair falls back to the INCOMING type, exactly like `step`:
 * @example resolveMorphType({type: "~morph", fromType: "video", toType: "rect", t: 0.5}, {}, {get: (t) => ({type: t})}, "a1").type // "rect"
 */
/**
 * Pure function. The state bag with `type` guaranteed to be the RESOLVED type
 * string rather than a morph token.
 *
 * RETURNS THE VERY SAME OBJECT when nothing needs changing, and that identity is
 * load-bearing rather than a micro-optimization: derive's node `state` feeds the
 * evaluation memo and the fold cache, so a fresh object per frame for every
 * non-morphing item in the document would defeat both. Same argument
 * `unsignedState` makes for an unflipped item.
 *
 * @example morphedStateType({type: "rect", w: 10}, "rect").type // "rect"
 * @example // the identity that keeps the memo alive:
 * @example (() => { const s = {type: "rect"}; return morphedStateType(s, "rect") === s; })() // true
 * @example morphedStateType({type: {type: "~morph", fromType: "rect", toType: "circle", t: 0.5}}, "circle").type // "circle"
 */
export function morphedStateType(state, type) {
  return state.type === type ? state : { ...state, type };
}

export function resolveMorphType(type, state, registry, itemId) {
  if (!isMorphToken(type)) return { type, morph: null };
  const { fromType, toType, t } = type;
  const fromPlugin = registry.get(fromType), toPlugin = registry.get(toType);
  // BOTH SIDES READ THE SAME STATE BAG, and that is correct rather than a
  // shortcut: a morph is ONE item mid-retype, so there is exactly one bag. Each
  // plugin reads the keys it declares out of it — the shared-key carry that
  // core/retype.js's rule 2 already governs — and a key the outgoing type owned
  // and the incoming one does not is simply not read by the incoming plugin.
  const policy = morphPairPolicy(fromPlugin, toPlugin, state, state);
  if (!policy.ok) {
    reportOnce(
      `derive:morph:${itemId}:${fromType}>${toType}`,
      `PowerRP: item "${itemId}" is keyframed ${fromType} → ${toType} with interp "morph", but ${policy.reason}. ` +
      `It switches at the start of the transition instead (the same as "step"). Pick a different interp, or use two vector widgets.`,
    );
    return { type: toType, morph: null };
  }
  return { type: toType, morph: { fromPlugin, toPlugin, fromState: state, toState: state, t } };
}

/**
 * Query (reads the registry; reports once on a refused morph). THE CONTENT-MORPH
 * RESOLUTION — a state bag holding a mid-morph CONTENT token
 * (core/interp_modes.js isContentMorphToken) → the state to derive as, plus the
 * same `.morph` payload pair the type morph produces.
 *
 * ── THE ASYMMETRY WITH resolveMorphType, WHICH IS THE WHOLE DESIGN ───────────
 * A TYPE morph is TWO plugins over ONE state. A CONTENT morph is the exact
 * mirror: ONE plugin over TWO states. The widget is a `latex` on both sides of
 * the transition — nothing about its type changed, which is precisely why the
 * type morph never engages here (the user's sharpest catch: "I just edit the
 * equation between slides"). What changed is the leaf that DEFINES its ink, so
 * the two payloads come from asking the same plugin twice, once with the
 * outgoing source substituted in and once with the incoming one.
 *
 * Because the resulting mark has the IDENTICAL shape
 * (`{fromPlugin, toPlugin, fromState, toState, t}`), render_gpu/ports.js
 * `morphIR` needs no branch at all: it asks two plugins for two payloads and
 * blends, and here the two plugins simply happen to be the same object. That is
 * the reason this design was chosen over a second mark kind — the render seam,
 * the engine, the alignment memo and every backend are untouched.
 *
 * THE STATE THE NODE DERIVES AS is the TARGET content, matching the type morph's
 * "the fallback is the incoming type". So the Inspector, hit tests and anchors
 * see the equation the transition is heading toward, and only the ink is
 * mid-flight.
 *
 * THE FALLBACK IS THE TARGET CONTENT, reported once with its reason — a MathJax
 * typeset still in flight, a text widget on a build with no glyph-outline source.
 * Identical contract to the type morph's refusal, and for the identical reason: a
 * morph the author asked for and did not get must not be silent.
 *
 * Args:
 *   state (object): the item's folded state, possibly carrying a content token
 *   registry (object): the plugin registry
 *   itemId (string): for the report line
 *
 * Returns:
 *   {state: object, morph: object|null} — `state` has the token replaced by the
 *   target string; `morph` is the pair mark, or null when it cannot morph
 *
 * @example // a state with no token is returned UNTOUCHED, same object:
 * @example (() => { const s = {type: "latex", latex: "x^2"}; return resolveContentMorph(s, {get: () => ({})}, "a1").state === s; })() // true
 * @example resolveContentMorph({type: "latex", latex: "x^2"}, {get: () => ({})}, "a1").morph // null
 */
export function resolveContentMorph(state, registry, itemId) {
  // THE FAST PATH IS A TYPE CHECK ON ONE KNOWN KEY, not a scan of the bag. Every
  // item in the document passes through here on every frame, so walking every
  // leaf looking for a token would put an O(properties) search on the hot path
  // to serve a feature almost no item is using. The key is in the token's own
  // `key` field for exactly this reason — but we must find the token first, and
  // the content keys are a short closed list, so we check those.
  const key = contentMorphKeyOf(state);
  if (!key) return { state, morph: null };
  const token = state[key];
  const plugin = registry.get(state.type);
  // The two states differ in ONE leaf. Everything else — box, rotation, ink,
  // font, alignment — is shared, because it IS shared: those are ordinary
  // property state and have already tweened to their mid-transition values, and
  // the morph rides on top of the box the same way the type morph does.
  const fromState = { ...state, [key]: token.from };
  const toState = { ...state, [key]: token.to };
  const resolved = { ...state, [key]: token.to };
  const policy = morphPairPolicy(plugin, plugin, fromState, toState);
  if (!policy.ok) {
    reportOnce(
      `derive:morphContent:${itemId}:${key}`,
      `PowerRP: item "${itemId}" is keyframed with interp "morph" on its ${key}, but ${policy.reason}. ` +
      `It switches at the start of the transition instead (the same as "step").`,
    );
    return { state: resolved, morph: null };
  }
  // MATCHED PIECES, and this resolver is the ONLY place that asks for them. A
  // content morph is SAME-TYPE by construction — one plugin, one leaf changed —
  // so the two payloads are two renderings of the same kind of thing and a
  // congruent subpath on both sides really is the same glyph that moved
  // (core/morph_match.js). A TYPE morph (rect → gear) gets nothing here: its two
  // payloads share no pieces, so matching would be meaningless work, and
  // `morphPaths` defaults to the whole-shape path for it and for every other
  // caller.
  return { state: resolved, morph: { fromPlugin: plugin, toPlugin: plugin, fromState, toState, t: token.t, matchPieces: true } };
}

/**
 * Query (reads the registry; reports once on a refused morph). THE UNIVERSAL
 * MORPH RESOLUTION — a state bag whose `morph` leaf holds the endpoint-carrying
 * token (core/morph_property.js) → the state this node derives as, plus the same
 * `.morph` mark the two legacy resolvers produce.
 *
 * ── THIS IS THE ONE THAT KNOWS BOTH ENDPOINTS ────────────────────────────────
 * The legacy type/content resolvers reconstruct their two states from the
 * MID-TWEEN bag they are handed: `resolveMorphType` passes the same moving bag
 * twice, and `resolveContentMorph` substitutes one leaf into it. That is the
 * jiggle (workstream II) — alignment makes DISCRETE decisions (pairing, cyclic
 * start, winding), so re-deriving them from a moving state lets them FLIP between
 * adjacent frames, and every sampled point jumps to a new counterpart.
 *
 * This resolver reads the two endpoint bags STRAIGHT OUT OF THE TOKEN, where
 * core/deltas.mutBlendApply put them, fixed for the whole transition. So the pair
 * handed to the engine is identical on every frame, its content key is identical,
 * and core/morph.js's memo therefore holds ONE alignment for the entire
 * transition BY CONSTRUCTION rather than by luck. The per-frame work that remains
 * is the proven-linear part: lerp the fixed aligned pair and map it through the
 * node's CURRENT tweened box.
 *
 * ── WHAT `auto` DECIDES, AND WHERE ───────────────────────────────────────────
 * The mode was resolved at the mint (it steps at transition start); what is left
 * here is the CAPABILITY question, which needs the registry:
 *
 *   auto      morph when both endpoint outlines exist; CROSSFADE when either
 *             side cannot outline. Silent either way — auto promised to pick the
 *             sensible thing, and picking it is not a failure to report.
 *   morph     morph, and when the outlines are unavailable fall to CROSSFADE
 *             with the reason REPORTED. The author asked for something specific
 *             and did not get it, which this codebase does not do silently.
 *   crossfade never morph — cross-render both endpoint states unconditionally.
 *
 * Note `auto` reaching CROSSFADE rather than the discrete switch is the
 * difference from the legacy resolvers, and it is the user's own default: a pair
 * with no outlines still has two pictures, and dissolving them is strictly more
 * informative than blinking.
 *
 * Args:
 *   state (object): the item's folded state, possibly carrying the token
 *   registry (object): the plugin registry
 *   itemId (string): for the report line
 *
 * Returns:
 *   {state: object, morph: object|null} — `state` has the token replaced by the
 *   resolved mode string; `morph` is the mark, or null when nothing renders
 *
 * @example // no token: the very same object back, and no mark
 * @example (() => { const s = {type: "rect"}; return resolveUniversalMorph(s, {get: () => ({})}, "a1").state === s; })() // true
 */
export function resolveUniversalMorph(state, registry, itemId) {
  const token = state[MORPH_KEY];
  if (!isUniversalMorphToken(token)) return { state, morph: null };
  const { mode, from, to, t } = token;
  // The node derives as the TARGET endpoint, matching both legacy resolvers'
  // "the fallback is the incoming side": the Inspector, hit tests and anchors see
  // the widget the transition is heading toward, and only the ink is mid-flight.
  // The `morph` leaf itself resolves to the plain mode string — a token must
  // never be visible to a plugin, an equation or a row.
  const resolved = { ...state, [MORPH_KEY]: mode };
  const fromPlugin = registry.get(from.type), toPlugin = registry.get(to.type);
  if (mode === "crossfade")
    return { state: resolved, morph: crossfadeMark(fromPlugin, toPlugin, from, to, t) };
  const policy = morphPairPolicy(fromPlugin, toPlugin, from, to);
  if (!policy.ok) {
    // `auto` CHOOSING the crossfade is not a failure — it is the mode doing its
    // job, so it says nothing. An explicit `morph` that could not be honoured IS
    // a failure to report, named once with the reason and the item.
    if (mode === "morph")
      reportOnce(
        `derive:morphUniversal:${itemId}:${from.type}>${to.type}`,
        `PowerRP: item "${itemId}" is set to Morph across this transition, but ${policy.reason}. ` +
        `It CROSSFADES instead — both states are drawn and dissolved. Set Morph to Auto to silence this, or use two vector widgets.`,
      );
    return { state: resolved, morph: crossfadeMark(fromPlugin, toPlugin, from, to, t) };
  }
  return { state: resolved, morph: { fromPlugin, toPlugin, fromState: from, toState: to, t } };
}

/**
 * Pure function. The `.morph` mark for a CROSS-RENDER — the same shape a real
 * morph mark has, plus `crossfade: true`.
 *
 * ONE MARK KIND, TWO BEHAVIORS, and that is deliberate: render_gpu/ports.js
 * already routes every `.morph` node away from its plugin's own emit(), and a
 * crossfade is the same cross-endpoint composition with a different blend law.
 * A separate mark would mean a second branch in the render walk, a second thing
 * derive can produce, and two places to keep the endpoint law.
 *
 * A crossfade needs NO outline capability at all — it draws the two endpoint
 * states through their own plugins' emit(). That is why it is the honest
 * fallback: it works for a video, a photo and a PDF page, none of which can
 * morph.
 *
 * @example crossfadeMark({}, {}, {type: "video"}, {type: "rect"}, 0.5).crossfade // true
 */
export function crossfadeMark(fromPlugin, toPlugin, fromState, toState, t) {
  return { fromPlugin, toPlugin, fromState, toState, t, crossfade: true };
}

/**
 * Pure function. The content key this state bag holds a mid-morph token on, or
 * null. Separated from the resolver so the "is anything morphing here" question
 * is one named test rather than a condition buried in a branch.
 *
 * @example contentMorphKeyOf({type: "latex", latex: "x^2"}) // null
 * @example contentMorphKeyOf({type: "latex", latex: {type: "~morphContent", key: "latex", from: "a", to: "b", t: 0.5}}) // "latex"
 * @example contentMorphKeyOf({type: "rect", w: 10}) // null (a shape has no content leaf)
 */
export function contentMorphKeyOf(state) {
  const key = contentMorphKeyFor(state.type);
  return key && isContentMorphToken(state[key]) ? key : null;
}

/**
 * Pure function. An item's LOCAL→WORLD similarity transform, with rotation
 * pivoted about its ROTATION ANCHOR (manifest Round 11: "rotating an object
 * rotates it relative to an anchor; the default rotation anchor is the object's
 * center — self.anchors.center").
 *
 * The rotation anchor is a world point stored as the equation-valued property
 * pair rotationAnchor.{x,y} (default `self.anchors.center.{x,y}`), which the
 * expression pass has already evaluated to numbers by derivation time. When
 * ABSENT — older documents predating rotation anchors, or the anchor was never
 * set — the pivot falls back to the item's geometric center (w/2, h/2 in the
 * rotation-zeroed base frame): this is EXACTLY what `self.anchors.center`
 * evaluates to, so a defaults-FALLBACK is byte-identical to load-time
 * injection while touching zero stored deltas (chosen over injection: the
 * default is a pure function of geometry, so there is nothing to persist, and
 * unrotated content — rotation 0 — is pixel-identical to before). Non-bbox
 * items (no w/h) fall back to the plain top-left pivot.
 *
 * The result is a plain {x,y,rotation,scale} similarity transform — every
 * consumer (compositor, GPU sceneIR wrap, hit-test invert, anchors, snap,
 * culling AABB) reads node.world unchanged.
 *
 * @example worldTransform({x: 100, y: 100, rotation: 0, scale: 1, w: 240, h: 140}) // {x: 100, y: 100, rotation: 0, scale: 1}
 * @example worldTransform({x: 100, y: 100, rotation: Math.PI / 2, scale: 1, w: 240, h: 140}) // {x: 290, y: 50, rotation: 1.5707963267948966, scale: 1}
 */
export function worldTransform(itemState) {
  const base = T.fromState(itemState);
  if ((itemState.rotation ?? 0) === 0) return base; // pivot is irrelevant at 0
  const ra = itemState.rotationAnchor;
  if (ra && typeof ra.x === "number" && typeof ra.y === "number")
    return T.aboutPivot(base, ra.x, ra.y);
  if (itemState.w == null || itemState.h == null) return base; // no bbox: top-left pivot
  const c = boxCenter(itemState);
  return T.aboutPivot(base, c.x, c.y);
}

/**
 * Pure function. The INVERSE of worldTransform for the default GEOMETRIC-CENTER
 * pivot: given a target world transform (rotation θ, scale s) and a box size
 * w×h, returns the stored {x, y} such that worldTransform({x, y, w, h,
 * rotation: θ, scale: s}) — evaluated with the default self-center pivot —
 * reproduces `target` exactly.
 *
 * WHY IT EXISTS (registry #1, rotated-resize): during a rotated resize the box
 * is laid out against a FIXED (pinned) pivot, so the "fixed" opposite edge
 * stays put in world (PPT semantics). But committing must keep the clean
 * `self.anchors.center` pivot equation (so future rotations orbit the NEW
 * center). This back-solves the x/y that makes the re-centered equation pivot
 * paint the identical world — no numeric rotationAnchor is ever persisted, and
 * the opposite-edge drift (24px measured) is eliminated by construction.
 *
 * Derivation: worldTransform maps local (0,0) → its own (.x,.y), and two
 * similarity transforms with equal θ,s are equal iff they agree there. With the
 * center pivot C=(x+s·w/2, y+s·h/2), worldTransform(state).x
 *   = x + s·w/2 − s·(cosθ·w/2 − sinθ·h/2). Setting it to target.x (and .y) and
 * solving for x (y) gives the closed forms below.
 *
 * @example stateXYForCenterPivotWorld({x: 100, y: 100, rotation: 0, scale: 1}, 200, 120) // {x: 100, y: 100} (rotation 0: x/y = target translation)
 * @example // A 90° 200×120 box at x=100,y=100 has center-pivot world translation
 * @example // (260, 60); back-solving that translation recovers x=100, y=100.
 * @example stateXYForCenterPivotWorld({x: 260, y: 60, rotation: Math.PI / 2, scale: 1}, 200, 120) // {x: 100, y: 100}
 */
export function stateXYForCenterPivotWorld(target, w, h) {
  const c = Math.cos(target.rotation), s = Math.sin(target.rotation);
  const k = target.scale;
  return {
    x: target.x - (k * w) / 2 + k * ((c * w) / 2 - (s * h) / 2),
    y: target.y - (k * h) / 2 + k * ((s * w) / 2 + (c * h) / 2),
  };
}

/**
 * Pure function. Is a world point inside an item's ORIENTED bounding box — the
 * rotation-aware rectangle the resize handles frame? Brings the point into the
 * item's local frame through invert(worldTransform(itemState)) — so the SAME
 * rotation-anchor pivot every consumer sees is honored — then tests it against
 * the local box [0..w]×[0..h] (worldTransform's own pivot math uses w/2,h/2,
 * confirming the top-left local origin). This is the WHOLE box, not the shape's
 * silhouette: the empty gaps a thin line / star / circle-corner / rotated rect
 * leave inside their handles all count as inside (selection-grab parity with
 * every design tool — a selected object is grabbable anywhere in its box).
 *
 * ONLY meaningful for bbox widgets (w AND h present). moveBy-only widgets
 * (arrows: no w/h) have no box, so the test returns false and callers keep the
 * shape hit-region for them. A degenerate scale-0 transform inverts to a
 * scale-0 map (transform.invert's documented finite choice), collapsing the box
 * to a point so nothing hits — a zero-area box has nothing to grab.
 *
 * @param {object} itemState - folded item state {x,y,rotation,scale,w,h,rotationAnchor?}
 * @param {number} wx - world-space x
 * @param {number} wy - world-space y
 * @returns {boolean}
 *
 * @example pointInNodeBox({x: 100, y: 100, w: 200, h: 120, rotation: 0, scale: 1}, 150, 160) // true (inside the axis-aligned box)
 * @example pointInNodeBox({x: 100, y: 100, w: 200, h: 120, rotation: 0, scale: 1}, 350, 160) // false (right of the box)
 * @example pointInNodeBox({x: 100, y: 100, w: 200, h: 4, rotation: 0, scale: 1}, 150, 102) // true (thin line: the empty sliver of its box IS grabbable)
 * @example // A 200×120 box rotated 90° about its center pivots to world center (200,160),
 * @example // NOT its stored (100,100) — so the test is rotation-anchor-aware:
 * @example pointInNodeBox({x: 100, y: 100, w: 200, h: 120, rotation: Math.PI / 2, scale: 1}, 200, 160) // true
 * @example pointInNodeBox({x: 100, y: 100, rotation: 0, scale: 1}, 100, 100) // false (no w/h: not a box)
 * @example // a FLIPPED box occupies the same footprint, so the same points hit it:
 * @example pointInNodeBox({x: 300, y: 100, w: -200, h: 120, rotation: 0, scale: 1}, 150, 160) // true
 */
export function pointInNodeBox(itemState, wx, wy) {
  if (itemState.w == null || itemState.h == null) return false;
  // Reads the RAW stored state (it is called on pre-derivation item states), so it
  // must enter the flip seam itself rather than inherit a node's. The reflection is
  // irrelevant to a rectangle test — only the SIGN is — so this needs the state map
  // (unsignedState), not unmirroredLocal.
  const box = unsignedState(itemState);
  const local = T.apply(T.invert(worldTransform(box)), wx, wy);
  return local.x >= 0 && local.x <= box.w && local.y >= 0 && local.y <= box.h;
}

/**
 * Pure function. Derives the z-sorted render tree from a folded state.
 * Sort: ascending z (default 0), ties broken by id for determinism.
 * Callers pass an EVALUATED state (core/expressions.evaluateState — the
 * derivation-stage expression pass), so every numeric property is a number.
 *
 * ── THE ASSET-REF RESOLUTION SEAM (core/asset_ref.js) ────────────────────────
 * `project` is the name of the project that OWNS this document, and it is what
 * turns a RELATIVE `src` ("clip.mp4") into the absolute `/asset/<project>/clip.mp4`
 * every downstream reader already understands. THIS is the one seam, for two
 * reasons that between them rule out every other candidate:
 *
 *   1. IT IS UPSTREAM OF `emit()`. Two registries are fed from INSIDE emit —
 *      `plugins/svg.js` calls `ensureSvgSource(s.svgUrl)` and
 *      `core/plugin_assets.js assetText` calls `ensureTextAsset(url)` — so an
 *      op-level rewrite in render_gpu/ports.js (which runs on emit's OUTPUT)
 *      would resolve the image and video ops and leave those two fetching the
 *      unresolved string. Resolving the node's STATE fixes every consumer at
 *      once, including a plugin asset that invents its own ref property.
 *   2. IT IS THE ONE PLACE EVERY PIXEL CONSUMER PASSES. The editor canvas, the
 *      presenter, thumbnails, PNG/PDF/SVG export, the bare-node CLI still and
 *      the headless render-job page all reach paint through deriveRenderTree.
 *      There is no second path to keep in sync.
 *
 * The project is an EXPLICIT ARGUMENT, never a global the walker reaches into —
 * the same discipline `web/cameraFrame.evaluationAt` follows for `meta.script`,
 * and for the same reason: a render must stay a pure function of what it was
 * handed, or a frame rendered on a worker differs from one rendered in the tab.
 * `web/cameraFrame.js` threads it for the whole browser/CLI family, exactly as it
 * threads the script.
 *
 * OMITTING IT IS SAFE AND MEANS "this state holds no relative refs". Every
 * all-absolute document — i.e. every document written before this grammar — derives
 * byte-identically with no project, and so do the ~60 test call sites that predate
 * it. A state that DOES hold a relative ref and gets no project throws from
 * resolveAssetRef naming the ref, which is the loud failure the silent-blank-video
 * bug earned.
 *
 * ── WHY THE THIRD ARGUMENT MAY ALSO BE A FUNCTION ────────────────────────────
 * The project-NAME form resolves a ref only as far as the ABSOLUTE `/asset/…`
 * path, because that is the whole answer WHEN A SERVER EXISTS TO ANSWER IT. In
 * STATIC mode nothing does, and the measured consequence was precise and awful:
 * the import worked, the bytes were in IndexedDB, the Explorer tiles drew — and
 * the canvas showed nothing, because the derived `src` reaching
 * render_gpu/gpu/video_registry.js was a dead `/asset/RobotSim/Video_….mp4` that
 * the browser reported as `MediaError code 4: Format error`. A missing file
 * masquerading as a corrupt one is the worst possible diagnostic.
 *
 * So the third argument generalizes to `project | resolver`, where a RESOLVER is
 * `(ref) => url` and gets the LAST word on every ref-bearing property. The
 * string form is kept, is the default, and is EXACTLY equivalent to passing
 * `(ref) => resolveAssetRef(ref, project)` — so bare-node callers, cli/render.js
 * and the ~60 pre-existing test call sites are untouched by construction.
 *
 * CORE STAYS DOM-FREE: the resolver is INJECTED, never imported. The one that
 * knows about blob: URLs and IndexedDB lives in web/cameraFrame.js, which is
 * already the module that threads `project` and `meta.script` for every pixel
 * consumer. This module keeps knowing only the grammar.
 *
 * @param {object} state - EVALUATED folded state ({items, vars})
 * @param {object} registry - plugin registry
 * @param {string|function} [project] - the OWNING project's name, OR a
 *   `(ref) => url` resolver that gets the final say (see above)
 * @returns {object[]} z-sorted render nodes
 */
export function deriveRenderTree(state, registry, project = "") {
  const items = state.items ?? {};
  // The document's folded variables — injected into docVars-capable nodes below.
  const foldedVars = state.vars ?? {};
  // THE NODE-GRAPH SEAM (core/nodeflow.js). A NODE WIDGET's picture depends on
  // values arriving through its WIRES, not only on its own state: a display node
  // shows the number its input carries, and nothing in its own item state knows
  // that number. So the graph is evaluated ONCE per derive — a pure fold over the
  // same `items` map — and each node's resolved ports are injected onto its node
  // state as `nodePorts: {inputs, outputs}`, exactly as `docVars` is injected one
  // level down for the graph family. Same shape of seam, same reason: emit()'s
  // signature carries only the item state, and a value that crossed a wire is by
  // definition not in it.
  //
  // WHY ONCE, AND WHY HERE: the evaluation is topological, so doing it per-node
  // inside the map would be quadratic and would also have to re-derive its own
  // dependencies. Doing it here also means the graph is evaluated in the SAME pass
  // that produces the picture, so a node's readout and the wire feeding it can
  // never be one frame apart.
  //
  // COSTS NOTHING FOR A DOCUMENT WITH NO NODES: nodeGraphValues returns an empty
  // map (its topo walk finds no ports and skips every item), and the injection is
  // guarded on a plugin actually declaring ports — so every existing document
  // derives byte-identically, with the very same state objects.
  const nodeValues = evaluateNodeGraph(items, registry).values;
  // ── THE FRAME DOMAIN'S ONE DRIVER (core/exec_frame.js) ─────────────────────
  // Per-frame triggers step HERE, at the same seam the node graph resolves, for the
  // reason stated just above about the graph itself: a node's readout and the wire
  // feeding it must not be one frame apart, and this is the pass that produces the
  // picture. A Schmitt trigger's pulse and the counter's new tally therefore reach
  // the canvas on the frame they happened.
  //
  // CALLING IT FROM A FUNCTION THAT RUNS SEVERAL TIMES PER FRAME IS SAFE, AND THAT
  // IS THE WHOLE POINT OF THE DESIGN RATHER THAN AN OVERSIGHT. `stepFrameDomain`
  // reads `prev` and writes `cur` in core/simulation_history.js's two tables, which
  // roll ONLY when the clock moves — so the 2-3 derives web/CanvasView.svelte
  // performs on a hover produce the identical answer and leave the identical table
  // (pinned by tests/execframe_test.js's Δt = 0 check). A frozen consumer — a
  // thumbnail, the minimap, a PNG export — writes nothing at all, structurally.
  //
  // AND IT COSTS A DECK WITHOUT ONE NOTHING: `stateUsesFrameDomain` is a scan for a
  // plugin declaring `frameStep` and returns before allocating anything, so every
  // document that predates this derives byte-identically.
  // `beginSimulationStep`, NOT `simulationTimestep`, and the difference is the whole
  // mechanism rather than a choice between two spellings of "how long is this frame".
  // MEASURED: with `simulationTimestep` the deck never ticked. That function OBSERVES
  // the clock and never ROLLS the history tables (its own docblock is explicit —
  // "Query→value (observes the clock; never rolls the history)"), so `prev` was never
  // published, every node read `firstStep` as true forever, and every latch sat at its
  // initial condition while the clock ran. `beginSimulationStep` is the one that rolls
  // `prev ← cur` — and it rolls ONLY when the clock has moved, which is precisely what
  // makes calling it from a function that runs several times per frame correct.
  const frame = stepFrameDomain(items, registry, beginSimulationStep(particleTime(), cameraMaxTimestep(state)));
  // WHICH PINS PULSED, published for `deriveWires` to colour with. It is a module
  // cell rather than a return value because `deriveRenderTree` returns a NODE LIST
  // and every one of its ~20 callers destructures it as one; widening that signature
  // to thread a second value would touch every pixel consumer in the app, including
  // files other lanes hold open. The cell is written by the pass that computed it and
  // read by `deriveWires` moments later in the same walk — and it is REPLACED, never
  // mutated, so a reader either sees this frame's set or the previous one's, never a
  // half-built one. A deck with no frame nodes writes the same frozen empty set every
  // time, so nothing that predates this can observe the cell at all.
  lastFiredWires = frame.pulses > 0 ? firedWireKeys(frame.fired) : NO_FIRED_WIRES;
  for (const [id, outputs] of Object.entries(frame.outputs)) {
    // MERGED OVER the graph's own answer rather than replacing it: a frame node may
    // publish some ports statically (a threshold readout) and some per-step (a
    // tally), and every reader downstream — the display's `nodePorts`, an equation
    // reading `= counter.out` — should see one set of values.
    if (nodeValues[id]) nodeValues[id] = { ...nodeValues[id], outputs: { ...nodeValues[id].outputs, ...outputs } };
  }
  // AND THE CONSUMERS' INPUTS ARE RE-RESOLVED, because merging an output is only half
  // of it. `evaluateNodeGraph` above ran BEFORE the step, so a display wired to a
  // counter still holds the tally as it was at the START of this frame — MEASURED in
  // the browser: the counter climbed 0 → 1 → 2 while the display beside it read 0
  // forever, which looks exactly like a broken display rather than a stale read.
  // Re-resolving in topological order lets this frame's values propagate the length of
  // the chain, and it is skipped entirely when nothing stepped.
  if (Object.keys(frame.outputs).length > 0) {
    for (const id of topoOrder(items).order) {
      if (frame.outputs[id] || !nodeValues[id]) continue; // a stepper keeps what it published
      const re = resolveNode(items, registry, id, (srcId) => nodeValues[srcId]?.outputs);
      if (re) nodeValues[id] = re;
    }
  }
  // `active` is a universal widget property (default true). Delete in the UI
  // keyframes active:false — the item KEEPS its identity and properties and
  // simply isn't derived on slides where it's inactive (this is how objects
  // live on some slides and not others). "Purge" is the real removal.
  // Typeless items are NOT YET CREATED on this fold (their creation slide is
  // later in the deck — imaginary-slide semantics; see expressions.js) and
  // derive exactly like inactive ones: skipped, never an error.
  // A MID-MORPH `type` IS NOT A STRING — it is the token core/interp_modes.js
  // mints (isMorphToken), so the typeless-item test above must admit it or a
  // morphing widget would VANISH for the whole interior of its own transition and
  // reappear at the end. The token is admitted here and resolved to a real type
  // (with its payload pair) inside the map, where the registry is in hand.
  // MEMBERSHIP HIDING (groupHiddenMembers): an INACTIVE GROUP hides everything it
  // owns, transitively. Computed here rather than stored, so a member's own
  // `active` still records only what the author set on the member — see that
  // function's docblock. Empty set for every document with no inactive group, so
  // the filter below is byte-identical for them.
  const hiddenByGroup = groupHiddenMembers(items);
  const nodes = Object.entries(items).filter(([id, s]) => s.active !== false && !hiddenByGroup.has(id) && (typeof s.type === "string" || isMorphToken(s.type))).map(([id, itemState]) => {
    // THE FLIP SEAM (module docstring): a NEGATIVE w/h is a reflection. Split it
    // into a positive box + mirror flags here, so no consumer downstream can meet
    // a negative extent. `unsignedState` is THE map — shared verbatim with the
    // PRE-DERIVATION readers in core/expressions.js, which is what stops the two
    // halves of the anchor feature from disagreeing — and it allocates NOTHING for
    // an unflipped item, returning the very same object. That identity IS the sign
    // test: an unflipped node stays byte-identical (same `state` object, no
    // `mirror` key at all, exactly like the other optional node marks).
    const state = unsignedState(itemState);
    const mirror = state === itemState ? null : { x: (itemState.w ?? 0) < 0, y: (itemState.h ?? 0) < 0 };
    // THE MORPH SEAM. A plain `type` returns itself with `morph: null` and
    // allocates nothing, so every document that never morphs derives
    // byte-identically. A token resolves to the INCOMING type — so `plugin`,
    // `state.type`, hit tests, anchors and the Inspector all see one real widget
    // mid-transition rather than a token they would each have to decode — plus a
    // `.morph` mark carrying the pair. The payloads are read at PAINT time
    // (render_gpu/ports.js), not here: derive runs for hit tests and bounds too,
    // and building two outline payloads for a mouse-move would be pure waste.
    // Note this reads the UNSIGNED state: a flipped morphing widget hands the
    // engine the same geometry an unflipped one would, which the engine's own
    // geometry law requires (assertMorphPaths refuses a negative space).
    const resolvedType = resolveMorphType(itemState.type, state, registry, id);
    const plugin = registry.get(resolvedType.type);
    // THE CONTENT-MORPH SEAM, the mirror of the type seam above: ONE plugin over
    // TWO states, rather than two plugins over one. It is resolved SECOND and
    // only when the type morph found nothing, because the two cannot both be
    // running on one item — a retype and a re-edit in the same transition is a
    // morph between four things, and the honest answer to that is the retype (the
    // widget is literally becoming something else; the content it is leaving is
    // the outgoing type's business). A state with no token returns the very same
    // object, so every document that never content-morphs derives byte-identically.
    const contentMorph = resolvedType.morph ? { state, morph: null } : resolveContentMorph(state, registry, id);
    // THE UNIVERSAL MORPH SEAM, and it WINS over both legacy resolvers above.
    // The precedence is not a preference: the universal token is the only one
    // carrying the transition's real ENDPOINTS, so when it is present the other
    // two would be answering the same question from a mid-tween state — which is
    // exactly the jiggle. A document written before tonight has no `morph` leaf,
    // so this returns the very same object and the legacy path still runs; see
    // the migration note in core/morph_property.js.
    const universalMorph = resolveUniversalMorph(contentMorph.state, registry, id);
    // THE ASSET-REF RESOLUTION SEAM (see the function docblock). Every RELATIVE
    // ref in this item's own ref-bearing properties becomes absolute here, BEFORE
    // emit() runs — which is what lets the two registries fed from inside emit
    // (svg_source_registry via plugins/svg.js, text_asset_registry via
    // core/plugin_assets.assetText) see a resolvable string. Which properties hold
    // refs is the PLUGIN's answer (its `kind: "asset"` inspector rows, or an
    // explicit `assetRefProps`), never a central key list that would go stale the
    // day someone adds a widget. Returns the SAME object when there was nothing to
    // resolve, so an all-absolute document — every document written before this
    // grammar — keeps byte-identical node identity and the evaluation memo.
    const resolved = resolveStateAssetRefs(universalMorph.state, pluginAssetRefProps(plugin), project);
    // DOC-VARS INJECTION: a plugin whose capabilities declare `docVars: true`
    // samples an EQUATION inside emit() (the graph family's Monaco source) and
    // therefore needs the document's folded variables at emit time — emit's
    // signature carries only the item state, which is why the zoo's λ-morph
    // crashed "lambda is not defined". Injected as `docVars` on the node
    // state; the plugin spreads its item-local vars OVER it (per-widget vars
    // shadow document vars, the digest-09 scoping law). Undeclaring plugins
    // get the very same state object — byte-identical, no new key.
    return {
      id,
      itemId: id,
      type: resolvedType.type,
      // `state.type` must be the RESOLVED type too, not the token: every plugin
      // emit(), every hit test and every Inspector row reads the bag, and a token
      // sitting in `state.type` would be a value each of them has to know about.
      // Only the node's `.morph` mark carries the morph, exactly as `.mirror`
      // carries the flip.
      // TWO INJECTIONS, ONE EXPRESSION, and the order matters only in that neither
      // may clobber the other: `docVars` is the graph family's document variables,
      // `nodePorts` is this node's resolved wire values (see THE NODE-GRAPH SEAM
      // above). A plugin that declares neither gets the very same `resolved` object
      // back — byte-identical node state, no new key — which is what keeps both
      // seams free for every widget that predates them.
      state: morphedStateType(withDerivedInjections(resolved, plugin, foldedVars, nodeValues[id]), resolvedType.type),
      world: worldTransform(state),
      plugin,
      ...(mirror ? { mirror } : {}),
      // ONE `.morph` MARK, THREE WAYS TO EARN IT — and they all produce the
      // IDENTICAL shape, which is the point: render_gpu/ports.js `morphIR` asks
      // two plugins for two payloads and blends, and never needs to know which
      // kind it got. A type morph is two plugins over one state; a content morph
      // is one plugin over two states; the UNIVERSAL morph is the general case,
      // two plugins over two ENDPOINT states, and it takes precedence because it
      // is the only one whose states are not mid-tween (see resolveUniversalMorph).
      ...(universalMorph.morph ?? resolvedType.morph ?? contentMorph.morph
        ? { morph: universalMorph.morph ?? resolvedType.morph ?? contentMorph.morph }
        : {}),
    };
  });
  nodes.sort((a, b) => (a.state.z ?? 0) - (b.state.z ?? 0) || (a.id < b.id ? -1 : 1));
  return resolveMetaballScene(resolveSkyScene(resolveGroupSubtrees(resolveCropTargets(applyGroupParenting(nodes)))));
}

/**
 * Pure function. Marks GROUP nodes that FOLD their member subtree into one
 * composited unit — the subtree-effects gap. A group whose plugin says it carries
 * active effects and/or a crop (plugins/group.foldsSubtree) should have its whole
 * member subtree rendered into ONE texture so the effect/crop/blend applies to the
 * composite (a drop shadow cast by the GROUP silhouette; a blend mode compositing
 * the whole group; a crop clipping the whole group). For each such group this
 * records — IN Z-ORDER (the node list is already z-sorted) — the present member
 * node ids it wraps (`subtreeMemberIds`) and back-marks those members `foldedBy`
 * the group.
 *
 * It does NOT remove any node (unlike resolveCropTargets, which suppresses a crop
 * target): the members stay first-class render nodes so hit-testing / anchors /
 * snap / band-select still see them — ONLY the render walk (render_gpu/ports.
 * sceneIR) reads these marks, drawing the members INSIDE the group's effectSubtree/
 * cropSubtree instead of independently at the top level. A group that folds nothing
 * (no effects, no crop, or no present members) is returned untouched, so every
 * effect-free group is byte-identical to before this feature.
 *
 * A member claimed by two folding groups binds to the FIRST in node (z) order
 * (deterministic; nested/multi-group precedence stays out of the rough-draft
 * scope, matching applyGroupParenting/groupMembership). Groups render this subtree
 * via the SAME reused machinery a single vector object uses (effectSubtree /
 * cropSubtree) — no new render op.
 *
 * @example resolveGroupSubtrees([{itemId: "g", type: "group", state: {members: ["r"], blendMode: "multiply"}, plugin: {foldsSubtree: () => true}}, {itemId: "r", type: "rect", state: {}, plugin: {}}]).find((n) => n.itemId === "g").subtreeMemberIds // ["r"]
 * @example resolveGroupSubtrees([{itemId: "g", type: "group", state: {members: ["r"]}, plugin: {foldsSubtree: () => false}}, {itemId: "r", type: "rect", state: {}, plugin: {}}]).find((n) => n.itemId === "r").foldedBy // undefined (non-folding group → members untouched)
 * @example resolveGroupSubtrees([{itemId: "r", type: "rect", state: {}, plugin: {}}]).length // 1 (no groups: passthrough)
 */
export function resolveGroupSubtrees(nodes) {
  const folding = nodes.filter((n) => n.type === "group" && Array.isArray(n.state.members) && n.plugin?.foldsSubtree?.(n.state));
  if (folding.length === 0) return nodes;
  const foldedBy = new Map();       // memberId → owning group id (first claimer)
  const membersByGroup = new Map(); // groupId → [memberId] in z-order
  for (const g of folding) {
    // Present member nodes in the node list's (z-sorted) order — the draw order
    // inside the composite, not the members-list declaration order. Skip the
    // group itself and any member already claimed by an earlier folding group.
    const ids = nodes
      .filter((n) => n.itemId !== g.itemId && !foldedBy.has(n.itemId) && g.state.members.includes(n.itemId))
      .map((n) => n.itemId);
    if (ids.length === 0) continue; // no present members → the group stays a pure ghost
    for (const id of ids) foldedBy.set(id, g.itemId);
    membersByGroup.set(g.itemId, ids);
  }
  if (membersByGroup.size === 0) return nodes;
  return nodes.map((n) =>
    membersByGroup.has(n.itemId) ? { ...n, subtreeMemberIds: membersByGroup.get(n.itemId) }
      : foldedBy.has(n.itemId) ? { ...n, foldedBy: foldedBy.get(n.itemId) }
        : n);
}

/**
 * Pure function. A GROUP's parent INFLUENCE — the similarity transform that,
 * composed onto a member's OWN world transform, reproduces "the member as
 * re-posed by the group moving from its bind pose to its current pose"
 * (manifest "Bind state (ground-zero stack)": a parent's influence on a child
 * = the parent's current state RELATIVE TO its bind state).
 *
 * influence = current ∘ invert(bind). Two properties this guarantees:
 *   - RE-POSE INVARIANCE: current === bind ⇒ influence === identity (a group
 *     sitting exactly at its creation pose does not move its members at all).
 *   - COMPOSABILITY: the result is a plain similarity, so member.world' =
 *     compose(influence, member.world) is itself a similarity that every
 *     downstream consumer (sceneIR wrap, hit-test invert, snap/anchor features,
 *     culling AABB, band-select AABB) reads with no special cases.
 *
 * `current` and `bind` are the group's WORLD transforms (rotation already
 * pivoted about the group's rotation anchor by worldTransform on both sides —
 * so a group rotated about its center orbits its members about that same
 * center, per the 45° tests).
 *
 * @example groupInfluence({x: 150, y: 120, rotation: 0, scale: 1}, {x: 100, y: 100, rotation: 0, scale: 1}) // {x: 50, y: 20, rotation: 0, scale: 1}
 * @example groupInfluence({x: 100, y: 100, rotation: 0, scale: 1}, {x: 100, y: 100, rotation: 0, scale: 1}) // {x: 0, y: 0, rotation: 0, scale: 1}
 */
export function groupInfluence(current, bind) {
  return T.compose(current, T.invert(bind));
}

/**
 * Pure function. A group's BIND-pose world transform. The group stores its
 * bind as flat {x, y, rotation, scale} captured at creation (Group Selection
 * time — see web/app.svelte.js groupSelection); this reads it through the SAME
 * worldTransform pivot machinery the CURRENT pose uses (passing the group's
 * live w/h/rotationAnchor so both poses pivot about the same anchor), so
 * influence measures a pure current-vs-bind delta.
 *
 * A MISSING BIND THROWS, and this used to return the identity and call that "the
 * safe default". It is not safe, it is the loudest possible wrong answer said
 * quietly: influence = current ∘ invert(bind), so an identity bind makes the
 * influence the group's FULL world instead of its delta from bind — a group minted
 * at (500, 300) teleports every member by (500, 300) the moment it appears, and
 * nothing anywhere reports it. `bind` is part of the group SCHEMA
 * (plugins/group.js defaults), so its absence is a MALFORMED ITEM, categorically
 * unlike applyGroupParenting's tolerance for a member that is merely absent from
 * this slide — that is a scene condition and has a correct answer (skip); this has
 * none. Every real writer supplies one: the defaults, groupSelection, and
 * core/retype.js (which fills a new type's defaults for absent keys).
 *
 * @example groupBindWorld({bind: {x: 100, y: 100, rotation: 0, scale: 1}, w: 200, h: 100}) // {x: 100, y: 100, rotation: 0, scale: 1}
 * @example // groupBindWorld({w: 200, h: 100}) throws: group has no bind pose (bind: undefined) — …
 */
export function groupBindWorld(groupState) {
  const b = groupState.bind;
  if (!b || typeof b.x !== "number" || typeof b.y !== "number")
    throw new Error(`group has no bind pose (bind: ${JSON.stringify(b)}) — a group's bind is its creation pose and is what its influence is measured against, so without one every member would be re-posed by the group's whole world transform`);
  // Re-pose the bind pose through worldTransform using the group's CURRENT box
  // geometry + rotation anchor (bind pose differs only in x/y/rotation/scale).
  return worldTransform({ ...groupState, x: b.x, y: b.y, rotation: b.rotation, scale: b.scale });
}

/**
 * Pure function. Applies every group node's parent influence to its members'
 * world transforms (the manifest's armature-shaped derivation, first instance).
 * A GROUP is a widget whose state carries `members: [itemId]`; each member
 * remains a STORED, independently-derived node (deltas still target it directly
 * — moving a member alone still works) whose world is RE-COMPOSED here:
 *   member.world' = compose(groupInfluence(group.world, groupBind), member.world)
 *
 * Order/precedence (the "two parents compose in stack order" clause of the
 * bind-state design): influences are applied in the node list's order (already
 * z-sorted), so a member caught by two groups picks up both, composed
 * outer-most-last. NESTED groups (a group that is itself a member of another
 * group) fall out of this same pass because a group node's OWN world is
 * re-composed before it is read as a parent for its own members ONLY IF the
 * outer group precedes it — full nested-group ordering is OUT OF SCOPE for the
 * rough draft (flagged: the single pass does not topologically sort parents).
 *
 * Groups themselves render nothing (plugins/group.js emit() → []); this pass
 * only rewrites `.world` on the members, never removes or reorders nodes.
 *
 * @example // one rect member at world (200,200); its group moved +50,+20 from bind:
 * @example applyGroupParenting([{itemId: "g", type: "group", state: {members: ["r"], bind: {x: 100, y: 100, rotation: 0, scale: 1}}, world: {x: 150, y: 120, rotation: 0, scale: 1}, plugin: {}}, {itemId: "r", type: "rect", state: {}, world: {x: 200, y: 200, rotation: 0, scale: 1}, plugin: {}}]).find((n) => n.itemId === "r").world // {x: 250, y: 220, rotation: 0, scale: 1}
 * @example applyGroupParenting([{itemId: "r", type: "rect", state: {}, world: {x: 5, y: 5, rotation: 0, scale: 1}, plugin: {}}]).length // 1 (no groups: passthrough)
 */
export function applyGroupParenting(nodes) {
  const groups = nodes.filter((n) => n.type === "group" && Array.isArray(n.state.members));
  if (groups.length === 0) return nodes;
  const byId = new Map(nodes.map((n) => [n.itemId, n]));
  // Mutate a shallow-cloned world per touched node so the input nodes stay pure.
  const cloned = new Map();
  const worldOf = (n) => cloned.get(n.itemId) ?? n.world;
  // ── OUTERMOST GROUP FIRST (#302) ─────────────────────────────────────────
  // A group that is itself a MEMBER of another group must be moved by its owner
  // BEFORE it moves its own members, or the inner group's box slides away and its
  // contents stay behind. Measured before this ordering existed: with O owning I
  // owning rect a, moving O by +100 put O and I at 100 and left `a` at 10.
  // A stable topological sort: a group is emitted only once every group that owns
  // it has been. A CYCLE (a group that is its own ancestor) cannot starve the
  // loop — whatever remains after a pass that placed nothing is emitted as-is,
  // so a malformed document renders rather than hanging.
  const memberOf = new Set(groups.flatMap((g) => g.state.members));
  const ordered = [];
  const placed = new Set();
  let remaining = groups;
  while (remaining.length > 0) {
    const ready = remaining.filter((g) => !groups.some((o) => o !== g && o.state.members.includes(g.itemId) && !placed.has(o.itemId)));
    if (ready.length === 0) { ordered.push(...remaining); break; } // cycle: emit and move on
    for (const g of ready) { ordered.push(g); placed.add(g.itemId); }
    remaining = remaining.filter((g) => !placed.has(g.itemId));
  }
  // ── A KNOWN BOUND: DIAMOND ANCESTRY DOUBLE-COUNTS. FOUND, NOT FIXED. ──────
  // Outer group O owns I AND J, and both list the same leaf. Each of I and J has
  // already been moved by O by this point, so each hands the leaf O's move again
  // and it travels twice as far — MEASURED at 200 where 100 is right, by a sweep
  // written to falsify the nesting work above (the ten tests in
  // tests/nested_groups_test.js all passed while this was broken, because none had
  // two paths to one ancestor).
  //
  // I TRIED THE OBVIOUS FIX AND REVERTED IT, which is the part worth recording.
  // Applying only ONE owner per member removes the double-count and CONTRADICTS a
  // tested, deliberate rule: tests/group_test.js "composedMemberInfluence: two
  // groups compose later-outermost (matches derive order)" pins that a member
  // listed by two INDEPENDENT groups receives BOTH influences composed, and that
  // this path and the expression path agree about it. Single-owner broke that
  // agreement, which is a worse and much more common defect than the diamond.
  //
  // The two cases are genuinely different and want different answers: two
  // unrelated groups SHOULD compose, a shared ancestor should be counted once.
  // Telling them apart needs each owner's LOCAL influence (excluding what it
  // inherited) plus a walk of the ancestry DAG — a real restructure of this
  // function and composedMemberInfluence together, not a guard. A diamond is also
  // a pathological document: it takes one item deliberately listed by two groups
  // that share a parent. Recorded here with its reproduction so the next author
  // starts from the measurement instead of rediscovering it.
  for (const g of ordered) {
    // worldOf(g), NOT g.world: an inner group has already been moved by its owner
    // at this point, and its influence on its own members must include that. For a
    // TOP-LEVEL group the two are identical, so every un-nested document is
    // byte-identical to before.
    const influence = groupInfluence(worldOf(g), groupBindWorld(g.state));
    for (const memberId of g.state.members) {
      const m = byId.get(memberId);
      if (!m) continue; // member purged / not on this slide / not created yet — skip
      cloned.set(memberId, T.compose(influence, worldOf(m)));
    }
  }
  return nodes.map((n) => (cloned.has(n.itemId) ? { ...n, world: cloned.get(n.itemId) } : n));
}

/**
 * Pure function. The COMPOSED group influence for ONE member of a folded /
 * evaluated state, or null if it is controlled by no group. Reads ONLY that
 * member's owning group transforms (not the whole scene), so a caller mid-way
 * through incremental evaluation gets a correct answer as long as those groups
 * are settled — which the expression pass guarantees via dependency edges
 * (Round 17). Composition order matches applyGroupParenting (later group
 * outermost). `ownerIds` is memberOwnerGroups(state).get(id) (the member's
 * owning group ids in z-order); passed in so the caller computes the owner map
 * once.
 *
 * @example // member "r" owned only by group "g" (moved +50,+20 from bind):
 * @example composedMemberInfluence(["g"], {items: {g: {type: "group", members: ["r"], bind: {x: 100, y: 100, rotation: 0, scale: 1}, x: 150, y: 120, rotation: 0, scale: 1, w: 80, h: 60}}}) // {x: 50, y: 20, rotation: 0, scale: 1}
 * @example composedMemberInfluence(undefined, {items: {}}) // null (ungrouped)
 */
export function composedMemberInfluence(ownerIds, state) {
  if (!ownerIds || ownerIds.length === 0) return null;
  const items = state.items ?? {};
  let composed = null;
  for (const gid of ownerIds) {
    const raw = items[gid];
    if (!raw || !Array.isArray(raw.members)) continue;
    // RAW pre-derivation state (this runs inside the expression pass), so it enters
    // the flip seam here — applyGroupParenting reads the group's ALREADY-unsigned
    // node.state, and a group with a signed box would otherwise place its members
    // one box-width away from where the render puts them.
    const g = unsignedState(raw);
    const influence = groupInfluence(worldTransform(g), groupBindWorld(g));
    composed = composed ? T.compose(influence, composed) : influence;
  }
  return composed;
}

/**
 * Pure function. itemId → [groupId] for every group whose `members` list names
 * it (a folded/evaluated state), in the SAME z-sorted order applyGroupParenting
 * visits groups (later group last — the order composedMemberInfluence composes).
 * Used by the expression pass to add the dependency edges that make a group's
 * transform evaluate BEFORE any equation referencing a grouped member's anchor
 * (Round 17 — otherwise Kahn could evaluate the anchor first and read a stale,
 * pre-influence group transform). Non-members are absent.
 *
 * @example memberOwnerGroups({items: {g: {type: "group", members: ["a"], z: 0}, a: {type: "rect", z: 1}}}).get("a") // ["g"]
 * @example memberOwnerGroups({items: {r: {type: "rect"}}}).size // 0
 */
/**
 * Pure function. The itemIds an INACTIVE GROUP takes down with it: every member,
 * transitively through nested groups (user, 2026-08-03: "If a group is not
 * visible... then neither should its children be").
 *
 * WHY THIS IS A DERIVE-TIME LAW AND NOT A DOCUMENT EDIT. `active` is stored
 * PER ITEM, so a member's own `active: true` is the honest record of what the
 * author set on the MEMBER; the group hiding it is a fact about the GROUP. Writing
 * `active: false` onto the members instead would destroy that distinction — showing
 * the group again could not know which members the author had hidden individually.
 * So membership hiding is COMPUTED here, every derive, and the members' stored
 * state is never touched.
 *
 * IT MUST NOT DEPEND ON groupFoldsSubtree. An effect-free group is a pure ghost
 * whose members render independently (plugins/group.js SUBTREE EFFECTS); a group
 * carrying effects composites them as a subtree. Those are two different RENDER
 * shapes for the same VISIBILITY fact, so this reads only `active` + `members` and
 * runs before either path — an invisible group hides its children whether or not it
 * happens to carry a shadow.
 *
 * TRANSITIVE, because groups nest (memberOwnerGroups' #302 block): an inactive
 * OUTER group hides an inner group AND everything the inner group owns. Cycle-safe
 * via the visited set — a malformed document naming a cycle terminates rather than
 * hanging.
 *
 * @param {object} items - folded/evaluated `state.items`
 * @returns {Set<string>} itemIds hidden BY MEMBERSHIP (never the groups themselves)
 *
 * @example groupHiddenMembers({g: {type: "group", members: ["a"], active: false}, a: {type: "rect"}}) // Set {"a"}
 * @example groupHiddenMembers({g: {type: "group", members: ["a"], active: true}, a: {type: "rect"}}).size // 0 (a visible group hides nothing)
 * @example // transitive: an inactive OUTER group hides the inner group's members too
 * @example [...groupHiddenMembers({o: {type: "group", members: ["g"], active: false}, g: {type: "group", members: ["a"]}, a: {type: "rect"}})].sort() // ["a", "g"]
 */
export function groupHiddenMembers(items) {
  const hidden = new Set();
  const swallow = (id) => {
    if (hidden.has(id)) return; // cycle-safe, and each subtree walked once
    hidden.add(id);
    const s = items[id];
    if (s?.type === "group" && Array.isArray(s.members)) for (const m of s.members) swallow(m);
  };
  for (const [id, s] of Object.entries(items))
    if (s?.type === "group" && s.active === false && Array.isArray(s.members))
      for (const m of s.members) swallow(m);
  return hidden;
}

export function memberOwnerGroups(state) {
  const items = state.items ?? {};
  const groups = Object.entries(items)
    .filter(([, s]) => s.type === "group" && Array.isArray(s.members) && s.active !== false)
    .sort(([aId, a], [bId, b]) => (a.z ?? 0) - (b.z ?? 0) || (aId < bId ? -1 : 1));
  const map = new Map();
  for (const [gid, g] of groups)
    for (const memberId of g.members) {
      if (!map.has(memberId)) map.set(memberId, []);
      map.get(memberId).push(gid);
    }
  // ── TRANSITIVE: A GROUP INSIDE A GROUP CARRIES ITS MEMBERS WITH IT (#302) ──
  // User: "i selected 3 groups. why can't i group them into a bigger group" →
  // "make this obviousness possible."
  //
  // MEASURED BEFORE THIS EXISTED: with outer group O owning inner group I owning
  // rect a, moving O by +100 moved O and I correctly and left `a` at its original
  // 10 — the inner group's BOX would slide away while its contents stayed behind.
  // So nesting was not merely disallowed by canGroup(); the derivation could not
  // express it, and simply removing that refusal would have shipped that picture.
  //
  // The cause is one line up in composedMemberInfluence: it reads each owner's RAW
  // state, so a nested group contributes its own un-influenced transform and its
  // owner's movement is never seen. Walking the chain here fixes it at the source,
  // and CANNOT double-count for exactly that reason — each level's influence is
  // computed from independent raw state, so O contributes +100 and I contributes
  // its own 0.
  //
  // ── INNERMOST FIRST, AND THE ORDER IS NOT COSMETIC ───────────────────────
  // composedMemberInfluence folds with `compose(next, composed)`, putting each
  // successive owner on the OUTSIDE, so the outermost ancestor must arrive LAST.
  //
  // THIS SAID "OUTERMOST FIRST" AND WAS WRONG, for a reason worth keeping. I
  // justified it by the sibling rule ("later group last"), which is about Z-ORDER
  // between two INDEPENDENT groups and says nothing about nesting depth. The two
  // orderings agree for a pure translation and diverge the moment an ancestor is
  // ROTATED OR SCALED, because composition does not commute. MEASURED on
  // O(rot 30°, scale 1.5) → I(rot 0.4, scale 1.2) → rect: the render put the leaf
  // at (265.9, 349.1) and the expression path at (296.5, 394.1) — 54.3 units
  // apart, with rotation and scale agreeing exactly and only translation wrong,
  // which is the signature of a swapped compose order. So an equation reading a
  // nested member's anchor disagreed with the pixel it was drawn at.
  //
  // ALL TEN NESTED TESTS PASSED THROUGHOUT: every one of them translated, and
  // translations commute. tests/group_test.js's rotate+scale agreement test was
  // one group deep, so it could not see this either. The gap was the INTERSECTION
  // of the two — nested AND rotated — which is now pinned below.
  const owners = (id, seen) => {
    const direct = map.get(id);
    if (!direct || direct.length === 0) return [];
    const out = [];
    for (const gid of direct) {
      if (seen.has(gid)) continue; // a cycle: a group that is its own ancestor
      seen.add(gid);
      out.push(gid, ...owners(gid, seen));
    }
    return out;
  };
  const transitive = new Map();
  for (const memberId of map.keys()) {
    const chain = owners(memberId, new Set([memberId]));
    // Deduped: two branches of the chain can reach one ancestor, and applying it
    // twice is the drift this whole comment exists to prevent.
    transitive.set(memberId, [...new Set(chain)]);
  }
  return transitive;
}

/**
 * Pure function. itemId → the itemId of the GROUP that owns it, for every
 * member of every group node in the tree (manifest Round-12B box-select rule:
 * band select grabs TOP-LEVEL GROUPS only, never members; a member and its
 * group are never both selected). A member listed by two groups maps to the
 * LAST group in node order (deterministic; nested-group precedence is out of
 * the rough-draft scope). Non-members are absent from the map.
 *
 * @example groupMembership([{itemId: "g", type: "group", state: {members: ["a", "b"]}}, {itemId: "a", type: "rect", state: {}}]).get("a") // "g"
 * @example groupMembership([{itemId: "r", type: "rect", state: {}}]).size // 0
 */
export function groupMembership(nodes) {
  const map = new Map();
  for (const n of nodes)
    if (n.type === "group" && Array.isArray(n.state.members))
      for (const memberId of n.state.members) map.set(memberId, n.itemId);
  return map;
}

/**
 * Pure function. The set of itemIds a DRAGGED item must NOT snap to (manifest
 * 15.7 SNAP EXCLUSION: "no need to snap things inside the group to the group
 * itself or vice versa"). Generalizes the long-standing "an item never snaps
 * to itself" precedent (the `n.itemId !== drag.itemId` filter at every snap
 * call site) to the whole GROUP RELATION, both directions:
 *   - always the dragged item itself (self-snap is meaningless);
 *   - if the dragged item is a MEMBER: its owning group (its outline/anchors
 *     move relative to the member as the member drags — a stale, jittery
 *     candidate);
 *   - if the dragged item is a GROUP: every one of its members (they move
 *     WITH the group through applyGroupParenting, so their features track the
 *     group rigidly — snapping the group to its own moving members is
 *     nonsensical).
 * Snapping to OTHER groups/items is unaffected — only the dragged item's own
 * group relation is excluded. `membership` is groupMembership(nodes) (the
 * memberId→groupId map); `nodes` supplies a dragged group's member list.
 *
 * @example snapExclusionSet("a", new Map([["a", "g"]]), [{itemId: "g", type: "group", state: {members: ["a", "b"]}}]) // Set {"a", "g"} (member excludes itself + its group)
 * @example [...snapExclusionSet("g", new Map([["a", "g"], ["b", "g"]]), [{itemId: "g", type: "group", state: {members: ["a", "b"]}}])].sort() // ["a", "b", "g"] (group excludes itself + all members)
 * @example snapExclusionSet("r", new Map(), [{itemId: "r", type: "rect", state: {}}]) // Set {"r"} (ungrouped item: just itself — the plain self-exclusion)
 */
export function snapExclusionSet(draggedId, membership, nodes) {
  const excluded = new Set([draggedId]);
  const ownGroup = membership.get(draggedId);
  if (ownGroup) excluded.add(ownGroup); // dragged member → its group
  const draggedNode = nodes.find((n) => n.itemId === draggedId);
  if (draggedNode?.type === "group" && Array.isArray(draggedNode.state.members))
    for (const memberId of draggedNode.state.members) excluded.add(memberId); // dragged group → its members
  return excluded;
}

/**
 * Pure function. Is this render node a GHOST (manifest ARCHITECTURE PLAN #2)?
 * A ghost has no rendered volume of its own: crop boxes ALWAYS (a crop box
 * with a dangling target renders nothing but its clip fill/border still
 * counts as content — it stays a ghost so its phantom outline is always
 * clickable per the spec: "A crop box is ALWAYS a ghost"), plus any plugin
 * that declares the STATIC `capabilities.ghost` or the DYNAMIC `isGhost(state)`
 * hook (e.g. an empty text box — text.js may opt in later; absent → never a
 * ghost, so every existing plugin is unaffected).
 *
 * @example isGhostNode({type: "cropbox", state: {}, plugin: {capabilities: {}}}) // true
 * @example isGhostNode({type: "rect", state: {}, plugin: {capabilities: {}}}) // false
 * @example isGhostNode({type: "text", state: {text: ""}, plugin: {capabilities: {}, isGhost: (s) => !s.text}}) // true
 */
export function isGhostNode(node) {
  if (node.type === "cropbox") return true;
  if (node.plugin.capabilities.ghost) return true;
  return node.plugin.isGhost ? !!node.plugin.isGhost(node.state) : false;
}

/**
 * Pure function. Resolves crop-box `target` references against the SAME
 * z-sorted node list (manifest ARCHITECTURE PLAN #3): the target's own render
 * is SUPPRESSED at its normal z-slot, and the resolved target node is
 * attached to the crop box as `.cropTarget` (a full render node — sceneIR
 * wraps its `.world`/`.plugin.emit(.state)` inside the crop box's clip). A
 * crop box is NOT itself a valid target (crop boxes render no subtree of
 * their own to embed — a self/mutual reference is nonsensical, not merely
 * unbounded) and a target that doesn't resolve (purged, wrong slide, or a
 * crop-box target) yields `.cropTarget = null` plus ONE console note
 * (reportOnce — the spec's "dangling target → ghost outline only, loud
 * console note once"). Non-crop-box nodes pass through unchanged.
 *
 * Suppression removes the target from the returned array entirely (it is
 * NOT independently painted, per spec: "the target's own render is
 * SUPPRESSED") — sceneIR/hit-testing/anchors all see only the crop box.
 *
 * @example resolveCropTargets([{id: "r1", itemId: "r1", type: "rect", state: {}, plugin: {capabilities: {}}}, {id: "cb", itemId: "cb", type: "cropbox", state: {target: "r1"}, plugin: {capabilities: {}}}]).length // 1 (r1 suppressed, folded into cb)
 * @example resolveCropTargets([{id: "cb", itemId: "cb", type: "cropbox", state: {target: "missing"}, plugin: {capabilities: {}}}])[0].cropTarget // null
 */
export function resolveCropTargets(nodes) {
  const byId = new Map(nodes.map((n) => [n.itemId, n]));
  const suppressed = new Set();
  const withTargets = nodes.map((n) => {
    if (n.type !== "cropbox") return n;
    const targetId = n.state.target;
    const target = typeof targetId === "string" ? byId.get(targetId) : null;
    if (targetId && (!target || target.type === "cropbox")) {
      reportOnce(`cropbox-dangling-${n.itemId}`, `PowerRP: crop box "${n.itemId}" target "${targetId}" is missing or is itself a crop box — showing ghost outline only`);
    }
    if (target && target.type !== "cropbox") suppressed.add(target.itemId);
    return { ...n, cropTarget: target && target.type !== "cropbox" ? target : null };
  });
  return withTargets.filter((n) => !suppressed.has(n.itemId));
}

/**
 * Pure function. THE SKY-ARCHETYPE SIBLING QUERY (the `sky*` family's crux). Scans
 * the derived, z-sorted render nodes for active LIGHT/OBJECT sources — nodes whose
 * plugin declares `capabilities.skyLight` ("sun" | "moon") — and returns a
 * WORLD-space scene summary the `sky`/`skyClouds`/`skyMoon` readers react to:
 *
 *   { suns:  [{ x, y, color, intensity, size }],   // x,y = world CENTRE
 *     moons: [{ x, y, phase }] }
 *
 * Each source's world CENTRE is its local box centre (w/2, h/2) mapped through the
 * node's final `world` transform (so group parenting, which runs earlier in
 * deriveRenderTree, is already baked in). The lists are sorted by itemId so the
 * summary is a deterministic pure function of the folded state (RenderTree =
 * pure(document, [[slide, alpha]])) — a reader shader fed from it stays byte-stable.
 * A widget reading its siblings is otherwise impossible (emit sees only its own
 * state); collecting it HERE — the one stage that sees the whole node list — is the
 * same seam crop boxes/groups already use.
 *
 * The summary field set IS the sky family's shared contract (like the "cropbox"/
 * "group" types this module already knows). Colour is left as the stored string
 * (a reader parses it); intensity/size/phase carry their neutral fallbacks so a
 * source that omits a knob still resolves.
 *
 * @param {object[]} nodes - derived render nodes (each carries plugin/state/world)
 * @returns {{suns: object[], moons: object[]}}
 *
 * @example collectSkyScene([]) // {suns: [], moons: []}
 * @example collectSkyScene([{itemId: "s1", state: {w: 100, h: 100, color: "#ffddaa", intensity: 2}, world: {x: 40, y: 60, rotation: 0, scale: 1}, plugin: {capabilities: {skyLight: "sun"}}}]) // {suns: [{x: 90, y: 110, color: "#ffddaa", intensity: 2, size: 1}], moons: []}
 * @example collectSkyScene([{itemId: "m1", state: {w: 200, h: 200, phase: 0.25}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {skyLight: "moon"}}}]) // {suns: [], moons: [{x: 100, y: 100, phase: 0.25}]}
 */
export function collectSkyScene(nodes) {
  const suns = [], moons = [];
  const sources = nodes
    .filter((n) => n.plugin?.capabilities?.skyLight === "sun" || n.plugin?.capabilities?.skyLight === "moon")
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  for (const n of sources) {
    const c = T.apply(n.world, (n.state.w ?? 0) / 2, (n.state.h ?? 0) / 2); // world centre
    if (n.plugin.capabilities.skyLight === "sun")
      suns.push({ x: c.x, y: c.y, color: n.state.color ?? "#ffffff", intensity: n.state.intensity ?? 1, size: n.state.size ?? 1 });
    else
      moons.push({ x: c.x, y: c.y, phase: n.state.phase ?? 0.5 });
  }
  return { suns, moons };
}

/**
 * Pure function. Feeds the SKY SIBLING QUERY to its readers. Computes
 * collectSkyScene(nodes) ONCE and attaches it as a derived `state.skyScene` field
 * to every node whose plugin declares `capabilities.skyReader` (the `sky`,
 * `skyClouds`, `skyMoon` widgets) — so their emit() can map the world-space suns/
 * moons into their own local frame (via the `world` arg emit already receives) and
 * pack them as shader uniforms. State is SHALLOW-CLONED, so the input nodes stay
 * pure. Non-reader nodes pass through untouched, and — like resolveCropTargets /
 * resolveGroupSubtrees — a scene with NO reader node is returned byte-identical (so
 * every non-sky document is completely unaffected).
 *
 * @param {object[]} nodes - derived render nodes
 * @returns {object[]} nodes, with readers carrying state.skyScene
 *
 * @example resolveSkyScene([{itemId: "r", type: "rect", state: {}, plugin: {capabilities: {}}}]).length // 1 (no reader: passthrough)
 * @example resolveSkyScene([{itemId: "sky", state: {}, plugin: {capabilities: {skyReader: true}}}, {itemId: "s1", state: {w: 2, h: 2}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {skyLight: "sun"}}}]).find((n) => n.itemId === "sky").state.skyScene.suns.length // 1
 * @example resolveSkyScene([{itemId: "r", type: "rect", state: {a: 1}, plugin: {capabilities: {}}}])[0].state.skyScene // undefined (untouched)
 */
export function resolveSkyScene(nodes) {
  if (!nodes.some((n) => n.plugin?.capabilities?.skyReader)) return nodes;
  const scene = collectSkyScene(nodes);
  return nodes.map((n) => (n.plugin?.capabilities?.skyReader ? { ...n, state: { ...n.state, skyScene: scene } } : n));
}

/**
 * Pure function. THE METABALL-ARCHETYPE SIBLING QUERY — the metaball family's crux,
 * the exact twin of collectSkyScene. Metaballs are an ARCHETYPE that must INTERACT:
 * every metaball widget's field FUSES with every other's on the slide (copy-paste
 * two, they melt together). A widget reading its siblings is otherwise impossible
 * (emit sees only its own state), so — like the sky suns — the balls are gathered
 * HERE, the one stage that sees the whole z-sorted node list.
 *
 * Scans for active metaball SOURCES (nodes whose plugin declares
 * `capabilities.metaball` AND exposes a pure `localBalls(state)` hook returning its
 * ball in LOCAL widget units) and lifts every ball into WORLD space via the node's
 * final `world` transform (group parenting — which runs earlier in deriveRenderTree
 * — is already baked in). A LOCAL ball is `{type, cx, cy, r, len, ang}` (centre +
 * radius/half-length in local px, angle radians); its world image is:
 *
 *   centre → world.apply(cx, cy);   r,len → ·world.scale;   ang → +world.rotation
 *
 * (a similarity scales lengths uniformly and adds rotation). Each world ball also
 * carries its OWNING widget's FLUID APPEARANCE — `fluidColor` (a color string) and
 * `refraction` (a number), read from the source's folded state and attached ONLY
 * when present (a geometry-only source stays a pure `{type,x,y,r,len,ang}`). These
 * are the material knobs the shader BLENDS per pixel across a merge (a red drop
 * meeting a blue drop → a purple neck), so they travel with each widget's ball into
 * the shared scene instead of being one global leader value. The list is sorted by
 * source itemId so the summary is a deterministic pure function of the folded state
 * — RenderTree = pure(document, [[slide, alpha]]) — and the leader's shader stays
 * byte-stable.
 *
 *   { balls: [{ type, x, y, r, len, ang, fluidColor?, refraction? }] }   // world coords/lengths/radians
 *
 * @param {object[]} nodes - derived render nodes (each carries plugin/state/world)
 * @returns {{balls: object[]}}
 *
 * @example collectMetaballScene([]) // {balls: []}
 * @example collectMetaballScene([{itemId: "m", state: {}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {metaball: true}, localBalls: () => [{type: "sphere", cx: 100, cy: 100, r: 50, len: 0, ang: 0}]}}]) // {balls: [{type: "sphere", x: 100, y: 100, r: 50, len: 0, ang: 0}]}
 * @example collectMetaballScene([{itemId: "m", state: {}, world: {x: 10, y: 0, rotation: 0, scale: 2}, plugin: {capabilities: {metaball: true}, localBalls: () => [{type: "sphere", cx: 5, cy: 0, r: 3, len: 0, ang: 0}]}}]) // {balls: [{type: "sphere", x: 20, y: 0, r: 6, len: 0, ang: 0}]} (world.scale 2 → centre and radius scale)
 */
export function collectMetaballScene(nodes) {
  const balls = [];
  const sources = nodes
    .filter((n) => n.plugin?.capabilities?.metaball && typeof n.plugin.localBalls === "function")
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  for (const n of sources) {
    const scale = n.world?.scale ?? 1, rot = n.world?.rotation ?? 0;
    for (const b of n.plugin.localBalls(n.state)) {
      const c = T.apply(n.world ?? { x: 0, y: 0, rotation: 0, scale: 1 }, b.cx, b.cy);
      const ball = { type: b.type, x: c.x, y: c.y, r: b.r * scale, len: b.len * scale, ang: b.ang + rot };
      // Carry the owning widget's fluid material ALONGSIDE geometry (attached only
      // when present, so a geometry-only source stays a bare geometry ball).
      if (n.state?.fluidColor !== undefined) ball.fluidColor = n.state.fluidColor;
      if (n.state?.refraction !== undefined) ball.refraction = n.state.refraction;
      balls.push(ball);
    }
  }
  return { balls };
}

/**
 * Pure function. Feeds the METABALL SIBLING QUERY to its readers — the twin of
 * resolveSkyScene. Computes collectMetaballScene(nodes) ONCE and attaches it as a
 * derived `state.metaballScene` field to every metaball node, plus a boolean
 * `state.metaballLeader` marking the SINGLE leader (the first metaball in the
 * already-z-sorted list — lowest z, ties by id). The leader's emit() maps the
 * world-space balls into its own local frame and renders ONE backdrop over their
 * union region; every non-leader emits nothing (a pure ghost, but still a draggable
 * widget — its frame comes from the widget system, not emit). State is
 * SHALLOW-CLONED so the input nodes stay pure; a scene with NO metaball node is
 * returned byte-identical (every non-metaball document is unaffected).
 *
 * @param {object[]} nodes - derived render nodes (z-sorted)
 * @returns {object[]} nodes, with metaball nodes carrying state.metaballScene + state.metaballLeader
 *
 * @example resolveMetaballScene([{itemId: "r", type: "rect", state: {}, plugin: {capabilities: {}}}]).length // 1 (no metaball: passthrough)
 * @example resolveMetaballScene([{itemId: "m", state: {}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {metaball: true}, localBalls: () => []}}])[0].state.metaballLeader // true
 * @example // The FIRST metaball in the (already z-then-id-sorted) list is the leader; the rest get false:
 * @example resolveMetaballScene([{itemId: "a", state: {}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {metaball: true}, localBalls: () => []}}, {itemId: "b", state: {}, world: {x: 0, y: 0, rotation: 0, scale: 1}, plugin: {capabilities: {metaball: true}, localBalls: () => []}}]).map((n) => n.state.metaballLeader) // [true, false]
 */
export function resolveMetaballScene(nodes) {
  const participants = nodes.filter((n) => n.plugin?.capabilities?.metaball);
  if (participants.length === 0) return nodes;
  const scene = collectMetaballScene(nodes);
  const leaderId = participants[0].itemId; // first in z-order (nodes already z-sorted)
  return nodes.map((n) =>
    n.plugin?.capabilities?.metaball
      ? { ...n, state: { ...n.state, metaballScene: scene, metaballLeader: n.itemId === leaderId } }
      : n);
}

/**
 * Pure function. A node's WORLD-space snap/anchor features.
 * Standard features for bbox widgets (corners, edge midpoints, center, and
 * the four infinite edge lines) plus any plugin-declared extras. Non-bbox
 * widgets contribute only what their plugin declares.
 *
 * Feature shapes:
 *   {kind: "point", x, y, id}
 *   {kind: "line",  x, y, dx, dy, id}   // infinite line: point + direction
 */
export function nodeFeatures(node) {
  const out = [];
  const { plugin, state, world } = node;
  if (plugin.capabilities.bbox) {
    const w = state.w ?? 0, h = state.h ?? 0;
    const pts = [
      ["tl", 0, 0], ["tm", w / 2, 0], ["tr", w, 0],
      ["ml", 0, h / 2], ["cm", w / 2, h / 2], ["mr", w, h / 2],
      ["bl", 0, h], ["bm", w / 2, h], ["br", w, h],
    ];
    for (const [id, lx, ly] of pts) {
      const p = T.apply(world, lx, ly);
      out.push({ kind: "point", x: p.x, y: p.y, id: `${node.id}:${id}` });
    }
    // Edge lines (infinite) — world-transformed directions.
    const o = T.apply(world, 0, 0), r = T.apply(world, w, 0), b = T.apply(world, 0, h), br = T.apply(world, w, h);
    const c = T.apply(world, w / 2, h / 2);
    out.push(
      { kind: "line", x: o.x, y: o.y, dx: r.x - o.x, dy: r.y - o.y, id: `${node.id}:top` },
      { kind: "line", x: b.x, y: b.y, dx: br.x - b.x, dy: br.y - b.y, id: `${node.id}:bottom` },
      { kind: "line", x: o.x, y: o.y, dx: b.x - o.x, dy: b.y - o.y, id: `${node.id}:left` },
      { kind: "line", x: r.x, y: r.y, dx: br.x - r.x, dy: br.y - r.y, id: `${node.id}:right` },
      { kind: "line", x: c.x, y: c.y, dx: r.x - o.x, dy: r.y - o.y, id: `${node.id}:hcenter` },
      { kind: "line", x: c.x, y: c.y, dx: b.x - o.x, dy: b.y - o.y, id: `${node.id}:vcenter` },
    );
  }
  for (const f of node.plugin.snapFeatures?.(state) ?? []) {
    const p = T.apply(world, f.x, f.y);
    out.push({ ...f, x: p.x, y: p.y, id: `${node.id}:${f.id}` });
  }
  return out;
}

/**
 * Pure function. A node's WORLD-space preset anchors: [{id, x, y}].
 * These are what arrows bind to and what renders as 50%-transparent X's.
 */
export function nodeAnchors(node) {
  return (node.plugin.anchors?.(node.state) ?? []).map((a) => {
    const p = T.apply(node.world, a.x, a.y);
    return { id: a.id, x: p.x, y: p.y };
  });
}

// ── THE HANDLE-CONSTRAINT PROTOCOL ───────────────────────────────────────────
// A constrained handle answers TWO separable questions, and welding them
// together is what kept modifier points drag-only:
//   WHERE may it go?  `constrain(state, desired) → allowed`  — the projection
//   HOW is that stored? `apply(state, allowed) → partial state` — the inverse
// Every constraint used to live IMPERATIVELY inside `apply` (each one clamped or
// dropped a coordinate on its way to writing a parameter), so only a mouse drag
// could drive a handle: nothing could ASK where a handle was allowed to be
// without also committing a write. Declaring the projection makes any source of
// a desired point a valid driver — a drag, an equation, or a BINDING TO ANOTHER
// ANCHOR (the reason this protocol exists) — exactly the move the activation
// registry made: take something imperative and buried, declare it, and N
// consumers become possible. (The protocol landed in commit b967325, whose
// SUBJECT is about selectable handles; the design essay that describes it rode a
// later commit. The SHA this file used to cite, 2a81b95, is not an ancestor of
// HEAD at all — a dangling pre-rebase object — and its live twin 169abe4 changes
// only list UI. Recorded because a citation nobody can resolve is worse than none.)
//
// ── ONE PROTOCOL, TWO RECORDS ────────────────────────────────────────────────
// `desired` and `allowed` are a COORDINATE RECORD: a flat object of named
// numbers, and NOT necessarily a two-dimensional point. Two families speak it:
//
//   MODIFIER POINTS   the record is a LOCAL {x, y} — the yellow square's own
//                     position. Eight plugins declare one.
//   BBOX DRAGS        the record is the item's STORED GEOMETRY, keyed by the
//                     path within the item: {x, y, w, h}, a group's {scale,x,y},
//                     an arrow's {"from.x", …}. See web/canvas/dragKinds.js
//                     geometryPairs, THE one seam every drag writes through.
//
// The bbox family used to express its restrictions as a pair of booleans
// (`doX`/`doY`) instead, which is the same mathematical object written twice:
// "height is locked" IS "project the desired (w, h) onto the nearest point of
// the line {(w, h₀)}". `pinning` below is that projection, and it is why there
// is now one answer to "where may this handle go" rather than two.
//
// NEAREST IS A LAW WITH DECLARED EXEMPTIONS, NOT AN UNCHECKED CONVENTION. This
// comment used to say the opposite ("the documented reading, not something the
// mechanism enforces"), and that was already stale when it was read for R6-29:
// tests/handle_constraints_test.js sweeps EVERY handle of EVERY registered
// widget for PURE / IDEMPOTENT / FIXED POINT / ROUND TRIP / NEAREST / PULL, and
// its NOT_NEAREST table holds the handles that are honestly RETRACTIONS rather
// than projections, each with its reason. tests/universal_constraints_test.js
// does the same for the bbox family. So: `constrain` returns the NEAREST point
// of the allowed set — hence a metric projection, hence IDEMPOTENT, which is
// what licenses composing it with an `apply` that constrains again internally
// and makes constraintPull a free second consumer rather than a second
// declaration. A map that is not nearest is allowed to exist, but it must be
// declared in one of those tables with a reason, and it fails the gate otherwise.
//
// COORDINATE SPACE: LOCAL units, always, for the modifier-point family.
// nodeModifierPoints wraps a handle's position local→world and CanvasView
// inverts the SAME world back before calling either hook, so rotation and scale
// are correct BY CONSTRUCTION and no plugin reasons about them. One consequence
// to state out loud because it is a design choice and not an oversight: under
// NON-UNIFORM scale, nearest-in-local is not nearest-in-world. The constraint is
// a statement about the widget's own parameters (a donut's inner radius runs
// along ITS x axis), so LOCAL is where it is meaningful and where "nearest" is
// defined. Do not "fix" this into world space — that would make a squashed
// donut's handle answer a question nobody asked. The bbox family's record is
// STORED state, which is that item's own frame by definition, so the same
// sentence holds there for the same reason.

/**
 * Pure function. THE DEFAULT constraint: the identity map — a handle with no
 * declared `constrain` allows EVERY point, so a desired point is already
 * allowed. Widgets override it only when they genuinely restrict a handle
 * (a polygon vertex goes anywhere; a donut's inner-radius handle does not).
 *
 * @example UNCONSTRAINED({}, {x: 3, y: 4}) // {x: 3, y: 4}
 */
export function UNCONSTRAINED(state, desired) {
  return desired;
}

/**
 * Pure function. THE AXIS-SUPPRESSION PROJECTION: builds a `constrain` that
 * holds the named coordinates at the values `state` already has and lets every
 * other coordinate through untouched. "Height is locked" is `pinning(["h"])`;
 * the G/S modal's X-axis constraint is `pinning(["y", "h"])`.
 *
 * THIS IS WHAT LETS THE BBOX DRAG FAMILY SPEAK THE PROTOCOL instead of
 * paralleling it. A boolean pair (the old `doX`/`doY`) says the same thing —
 * "this axis's writes are suppressed" — in a vocabulary exactly one call site
 * understands. As a projection it composes with every other constraint, and a
 * consumer that has never heard of axis locking can still ask where a drag is
 * allowed to land.
 *
 * IT IS PROVABLY THE NEAREST ALLOWED POINT, not merely a convenient one, so it
 * satisfies the protocol's law rather than needing an exemption. The allowed set
 * {v : v_k = state_k for every pinned k} is an axis-aligned affine subspace, and
 * squared Euclidean distance over a coordinate record is a SUM of independent
 * per-coordinate terms — so minimising the sum minimises each term alone: a
 * pinned coordinate has exactly one legal value and a free one keeps `desired`.
 * Nothing is traded off, which is why this needs no search, why it is trivially
 * idempotent, and why COMPOSING two pinnings (the union of their keys) is still
 * the nearest point.
 *
 * Pinning a coordinate the state does not carry is VACUOUS rather than an error:
 * the coordinate does not exist, so holding it still writes nothing downstream.
 *
 * @param {string[]} keys - the coordinates that may not move
 * @returns {function} a `constrain(state, desired) → allowed`
 *
 * @example pinning(["h"])({w: 100, h: 50}, {w: 300, h: 999}) // {w: 300, h: 50} (the height drag is refused, the width drag is not)
 * @example pinning(["y", "h"])({x: 0, y: 20, w: 100, h: 50}, {x: 7, y: 8, w: 300, h: 999}) // {x: 7, y: 20, w: 300, h: 50}
 * @example pinning([])({x: 1}, {x: 9}) // {x: 9} (nothing pinned — the identity, exactly UNCONSTRAINED)
 */
export function pinning(keys) {
  return (state, desired) => {
    const allowed = { ...desired };
    for (const key of keys) allowed[key] = state[key];
    return allowed;
  };
}

/**
 * Pure function. Drive a modifier point from a DESIRED local point: project it
 * onto what the handle allows, then ask the handle how to store THAT. The one
 * composed driver — every consumer (CanvasView's drag today, an anchor binding
 * tomorrow) goes through here rather than re-pairing the two hooks, so "constrain
 * then apply" is written down exactly once.
 *
 * Args:
 *   mp (object): a modifier point from nodeModifierPoints (constrain defaulted)
 *   state (object): the item's evaluated state
 *   desired ({x, y}): the desired handle position, LOCAL units
 *
 * Returns:
 *   object: the partial state write
 *
 * @example modifierWrite({constrain: (s, p) => ({x: p.x, y: 0}), apply: (s, p) => ({v: p.x + p.y})}, {}, {x: 5, y: 99}) // {v: 5} (the y the constraint removed cannot reach the write)
 * @example modifierWrite({constrain: UNCONSTRAINED, apply: (s, p) => ({v: p.y})}, {}, {x: 5, y: 99}) // {v: 99}
 */
export function modifierWrite(mp, state, desired) {
  return mp.apply(state, mp.constrain(state, desired));
}

/**
 * Pure function. How far the constraint PULLED a desired record: the distance
 * from `desired` to the nearest allowed record, |p − constrain(p)|. Zero exactly
 * when the record was already allowed.
 *
 * This is the projection's free second consumer — the same declaration answers
 * "how far did the constraint drag my pointer" (a resisted drag) and "which
 * handle is nearest what I am pointing at" (hit-testing among handles), with no
 * second thing for a widget to declare or keep in sync.
 *
 * THE METRIC IS OVER `desired`'s OWN COORDINATES, not over a hardcoded x and y.
 * That is not generality for its own sake: the protocol's record is {x, y} for a
 * modifier point but {x, y, w, h} for a bbox drag (see ONE PROTOCOL, TWO RECORDS
 * above), and a pull that only knew x/y would report 0 for a constraint that
 * moved `h` — a silent wrong answer in exactly the family that just joined.
 * A coordinate the projection ADDS is not measured: it was not asked for.
 *
 * `mp` is anything carrying a `constrain`, so the bbox family passes
 * `{constrain: pinning([…])}` rather than needing a second function.
 *
 * @example constraintPull({constrain: (s, p) => ({x: p.x, y: 0})}, {}, {x: 5, y: 3}) // 3
 * @example constraintPull({constrain: UNCONSTRAINED}, {}, {x: 5, y: 3}) // 0
 * @example constraintPull({constrain: pinning(["h"])}, {h: 50}, {w: 300, h: 53}) // 3 (the height was held 3 short of the drag)
 */
export function constraintPull(mp, state, desired) {
  const allowed = mp.constrain(state, desired);
  let sum = 0;
  for (const key of Object.keys(desired)) {
    const d = desired[key] - allowed[key];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Pure function. A node's WORLD-space MODIFIER POINTS (manifest ARCHITECTURE
 * PLAN #1 — the "PPT yellow squares"): [{id, x, y, apply}]. A modifier point
 * is a highly-constrained draggable handle that writes ONE widget parameter
 * along a restricted trajectory — NOT an anchor (not referencable in
 * equations, not a snap feature). The plugin hook `modifierPoints(state)`
 * returns LOCAL-space {id, x, y, apply(state, localPoint) → partial state}
 * entries; this wraps their x/y through node.world for display/hit-testing,
 * exactly like nodeAnchors wraps anchors — so consumers (the CanvasView
 * overlay) never touch local space directly, and rotation is correct BY
 * CONSTRUCTION: the point is drawn/hit in world space, and the drag handler
 * inverts back through node.world before calling apply (see
 * CanvasView.modifierDrag) — no plugin ever reasons about rotation itself.
 *
 * `constrain(state, desired) → allowed` (THE HANDLE-CONSTRAINT PROTOCOL above)
 * rides along in the SAME local frame as `apply` and is DEFAULTED here to
 * UNCONSTRAINED, which is why a widget with no restricted handle needs no
 * change: omitting it declares "anywhere". This is the one place the default is
 * supplied, so every consumer can call `constrain` unconditionally.
 *
 * TWO OPTIONAL ASPECTS ride along untouched, because they are not geometry and
 * this function's job is the local→world wrap:
 *   `element: {list, index}` — the handle IS element `index` of a LIST property,
 *     and `list` is that property's DECLARATION (core/lists.js) carried BY
 *     REFERENCE — the very object core/properties.js owns, never a copy or a key to
 *     look up. That is what lets the UNIVERSAL handle actions (hide/show, purge)
 *     operate on a handle without knowing which widget it belongs to. A handle that
 *     controls a plain scalar parameter (a donut's inner radius) omits it and simply
 *     has no list actions.
 *   `active` — whether that element is VISIBLE (a plugin reads it through
 *     core/lists.elementActive, so absent means visible). Defaults to true here so
 *     a handle with no list element is never drawn as "hidden".
 *   `shape` — an OPTIONAL glyph name the canvas handle layer draws instead of the
 *     default square (e.g. "triangle" for a paint-path bezier handle, so the two
 *     handle roles read apart). Absent → the default square, so every existing
 *     widget's handles render byte-identically. SUPERSEDED BY `glyph` for anything
 *     new — see below; `shape` is kept because paint_path declares it and the two
 *     resolve to one picture.
 *   `glyph` — an OPTIONAL key into THE HANDLE GLYPH BANK (core/handle_glyphs.js):
 *     a closed vocabulary of {outline shape, inner mark, accent colour} looks, so
 *     handles of different ROLES on one widget read apart before you drag either
 *     ("does this belong to the shape or to the gradient?" — the user's question,
 *     2026-08-02). Carried through VERBATIM as a key, never resolved here: this
 *     function's job is the local→world wrap, and the look is the renderer's to
 *     interpret (core/ names the vocabulary, web/ draws it). Absent → the default
 *     square.
 *   `label` — an OPTIONAL short human sentence naming what this handle does
 *     ("Gradient centre"), shown as a HOVER TOOLTIP on the glyph. The other half
 *     of the same fix: the glyph is a look you must learn, the label is words on
 *     demand. Absent → no tooltip, which is every handle that predates this.
 *   `stem` — an OPTIONAL LOCAL point this handle tethers to (its anchor), wrapped
 *     to WORLD here exactly like x/y so a dashed GHOST line can be drawn from it to
 *     the handle. Absent → no tether line.
 *
 * THE GRADIENT BEADS ARE APPENDED HERE, FOR EVERY PAINT-CAPABLE WIDGET, and no
 * plugin declares them. A gradient's centre/direction handles are a function of
 * the PAINT and not of the shape (core/paint_handles.js), so making each plugin
 * SPREAD them — which is how it worked until 2026-08-02 — made the DEFAULT wrong:
 * exactly seven plugins ever did it, and a graph_line, a plaintext or a codeblock
 * with a gradient fill silently had no handles at all. The user reported precisely
 * that inconsistency. The keys come from the plugin's OWN `paint: true` Inspector
 * rows (paintCapableKeys), so nothing here names a property and a widget that adds
 * a paint row is covered the day it does. A widget whose paints are all
 * solid/material/absent contributes NO rows, so it is byte-identical to before.
 * The beads come AFTER the plugin's rows, and `node.state` is post-`unsignedState`,
 * so a FLIPPED widget's beads land on its ink with no per-plugin sign handling.
 *
 * @example nodeModifierPoints({world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {}, plugin: {}}) // []
 * @example nodeModifierPoints({world: {x: 5, y: 0, rotation: 0, scale: 1}, state: {}, plugin: {modifierPoints: () => [{id: "a", x: 1, y: 2}]}}) // [{id: "a", x: 6, y: 2, element: null, active: true, apply: undefined, constrain: UNCONSTRAINED, shape: null, glyph: null, label: null, stem: null}]
 * @example nodeModifierPoints({world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {}, plugin: {modifierPoints: () => [{id: "g", x: 0, y: 0, glyph: "boxedO", label: "Gradient centre"}]}})[0].glyph // "boxedO"
 * @example // AUTO-DERIVED gradient beads: the plugin declares a paint row and NO modifierPoints at all
 * @example nodeModifierPoints({world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 100, fill: {type: "radialGradient", radial: {stops: []}}}, plugin: {inspector: [{key: "fill", kind: "color", paint: true}]}}).map((m) => m.id) // ["fill-grad-center"]
 * @example nodeModifierPoints({world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 100, fill: "#f00"}, plugin: {inspector: [{key: "fill", kind: "color", paint: true}]}}) // [] (a solid fill earns no beads)
 */
/**
 * Near-pure function (reportOnce logs to console and remembers the key). THE
 * HANDLE-TIME CONTAINMENT BOUNDARY — this plugin's own `modifierPoints(state)`,
 * or an EMPTY LIST plus a loud report if it throws.
 *
 * This is the twin of render_gpu/ports.js's emit-time boundary, and it exists
 * because the two paths had different blast radii for the SAME bad state
 * (R7-31). A plugin throw inside `emit()` has been contained since that seam
 * was written — the item draws an error box and the rest of the scene paints.
 * The handle path had NO such boundary: `nodeModifierPoints` is called BARE
 * from web/CanvasView.svelte and web/app.svelte.js, so a throwing
 * `modifierPoints` became an app-level pageerror. Measured on the pptxPreset
 * widget, that was the difference between an error box and the editor going
 * down on SELECTING an item — 81 of 187 PowerPoint presets, because those are
 * the ones that also declare adjust handles.
 *
 * HANDLES ARE AN AFFORDANCE, SO DEGRADING TO NONE IS HONEST. An empty list
 * means the item shows no yellow diamonds — it is still selectable, movable,
 * resizable and deletable, so the user retains every route to fix or remove
 * it. That is strictly better than the alternative on offer, which is no
 * editor at all. The throw is NOT swallowed: the item and the message are
 * named on the console, once per node+message (this runs every frame), and the
 * real stack is logged so a determinism bug stays diagnosable.
 *
 * A BACKEND-CONFIGURATION failure escapes untouched — the same line
 * emitNode and paintNodeRun both draw: that class of error is the caller's
 * wiring, broken for the whole surface, and must not be reported per-item.
 *
 * @param {object} node - a derive render node (carries .plugin/.state)
 * @returns {object[]} the plugin's modifier points, or [] if it threw
 *
 * @example pluginModifierPoints({plugin: {}, state: {}}) // [] (no modifierPoints declared)
 * @example pluginModifierPoints({plugin: {modifierPoints: () => [{id: "a", x: 1, y: 2}]}, state: {}}) // [{id: "a", x: 1, y: 2}]
 * @example // a throwing plugin costs its own handles, not the app
 * @example pluginModifierPoints({itemId: "i1", type: "pptxPreset", plugin: {modifierPoints: () => { throw new Error("bad adj"); }}, state: {}}) // []
 */
function pluginModifierPoints(node) {
  try {
    return node.plugin.modifierPoints?.(node.state) ?? [];
  } catch (e) {
    if (isConfigurationError(e)) throw e;
    const msg = throwMessage(e);
    const who = describeOwner({ itemId: node.itemId, type: node.type, state: node.state });
    if (reportOnce(
      `derive:modifierPoints:${node.itemId}:${msg}`,
      `PowerRP: item ${who} failed to compute its EDIT HANDLES — ${msg}. It is shown without handles; the item is still selectable and editable. Fix or delete that item to restore them.`,
    )) console.error(e); // the real stack, once — a determinism bug must stay diagnosable
    return [];
  }
}

export function nodeModifierPoints(node) {
  // THE GRADIENT BEADS ARE DERIVED, NOT OPTED INTO (core/paint_handles.js). They
  // are a function of the PAINT, not the shape, so they are appended here for
  // EVERY paint-capable widget rather than spread by each plugin — seven plugins
  // ever spread them, which is why a graph_line with a gradient fill showed none
  // ("sometimes I see the handles for a gradient, and sometimes I don't" — user,
  // 2026-08-02). AFTER the plugin's own rows, so a widget's shape handles keep
  // their existing order and z (the beads draw on top, which is what the boxedO
  // glyph is for). `node.state` has ALREADY passed THE FLIP SEAM (unsignedState,
  // in deriveNodes), so the beads read the positive box — a flipped widget's
  // beads land on its ink with no per-plugin sign handling, which is exactly the
  // thing a single derive seam buys over seven spreads.
  const rows = [
    ...pluginModifierPoints(node),
    ...allPaintModifierPoints(node.state, paintCapableKeys(node.plugin)),
  ];
  return rows.map((m) => {
    const p = T.apply(node.world, m.x, m.y);
    const stem = m.stem ? T.apply(node.world, m.stem.x, m.stem.y) : null;
    return { id: m.id, x: p.x, y: p.y, element: m.element ?? null, active: m.active !== false, apply: m.apply, constrain: m.constrain ?? UNCONSTRAINED, shape: m.shape ?? null, glyph: m.glyph ?? null, label: m.label ?? null, stem: stem ? { x: stem.x, y: stem.y } : null };
  });
}

/**
 * Pure function. The TWO derive-time injections a node state may receive, applied
 * in one place so neither can silently clobber the other and so a plugin that
 * declares neither gets the VERY SAME OBJECT back (===), keeping every pre-existing
 * document byte-identical through this seam.
 *
 *   `docVars` — the document's folded variables, for a plugin whose capabilities
 *     declare `docVars: true` (the graph family samples an equation inside emit()).
 *   `nodePorts` — this node's RESOLVED port values ({inputs, outputs}) from the
 *     node-graph fold, for any plugin declaring `ports`. A value that arrived over
 *     a WIRE is not in the item's own state by definition, so a node widget whose
 *     picture shows what it received (a display, a meter) can only get it here.
 *
 * @param {object} resolved - the item's post-asset-ref state
 * @param {object} plugin - its plugin
 * @param {object} foldedVars - the document's folded variables
 * @param {object} [ports] - this item's evaluated {inputs, outputs}, if any
 * @returns {object} the state, possibly with injections
 *
 * @example withDerivedInjections({w: 1}, {}, {}, undefined) // {w: 1}
 * @example withDerivedInjections({w: 1}, {capabilities: {docVars: true}}, {k: 2}, undefined).docVars // {k: 2}
 * @example withDerivedInjections({w: 1}, {ports: () => ({inputs: [{key: "a", type: "number"}]})}, {}, {inputs: {a: 5}, outputs: {}}).nodePorts.inputs // {a: 5}
 */
export function withDerivedInjections(resolved, plugin, foldedVars, ports) {
  const wantsVars = plugin?.capabilities?.docVars === true;
  const wantsPorts = ports !== undefined && typeof plugin?.ports === "function";
  if (!wantsVars && !wantsPorts) return resolved;
  return {
    ...resolved,
    ...(wantsVars ? { docVars: foldedVars } : {}),
    ...(wantsPorts ? { nodePorts: ports } : {}),
  };
}

/**
 * Pure function. A node widget's PORT ANCHORS in WORLD space: every port's bead
 * position, its type, its side and its key, wrapped local→world through the node's
 * own transform — exactly as nodeModifierPoints wraps the yellow squares.
 *
 * THIS IS THE ONE GEOMETRY BOTH HALVES OF THE WIRE FEATURE READ (blueprint §5:
 * "Port anchor positions come from derivation so hit-testing and drawing share one
 * geometry"). The canvas hit layer asks it where a bead can be grabbed; the wire
 * layer asks it where a wire's two ends are. Because both answers come from one
 * call over one node.world, a rotated or scaled node's wires land on its beads with
 * no per-consumer trigonometry, and a wire cannot be drawn to a point that is not
 * grabbable.
 *
 * `node.state` has already passed THE FLIP SEAM (unsignedState), so a flipped node's
 * ports read off the positive box like everything else.
 *
 * A non-node widget answers `[]`, so every consumer may call it unconditionally.
 *
 * @param {object} node - a derived render node
 * @returns {object[]} [{key, type, label, side, x, y}] in WORLD coords
 *
 * @example nodePortAnchors({world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 80}, plugin: {}}) // []
 * @example nodePortAnchors({world: {x: 10, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 80}, plugin: {ports: () => ({outputs: [{key: "o", type: "number"}]})}})[0].x // 110
 * @example nodePortAnchors({world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 80}, plugin: {ports: () => ({inputs: [{key: "i", type: "audio"}]})}})[0].type // "audio"
 */
export function nodePortAnchors(node) {
  if (typeof node?.plugin?.ports !== "function") return [];
  return portLayout(node.plugin, node.state).map((p) => {
    const w = T.apply(node.world, p.x, p.y);
    // `color` and `multiple` ride along ONLY when declared, so every bead record
    // for an ordinary port is byte-identical to before they existed.
    return {
      key: p.key, type: p.type, label: p.label, side: p.side, x: w.x, y: w.y,
      ...(p.color !== undefined ? { color: p.color } : {}),
      ...(p.multiple ? { multiple: true } : {}),
    };
  });
}

/**
 * Pure function. Every WIRE to draw for a derived tree: one per resolved
 * connection, carrying both endpoints in WORLD space and the SOURCE port's type
 * (which is what colors it — a wire is the color of what flows through it, and
 * under a coercion that is what it LEAVES as, not what it arrives as).
 *
 * A connection whose source or destination node is not in the tree — deleted on
 * this slide, culled, or naming a port its plugin no longer declares — yields NO
 * wire and no error. A wire is derived output; if either end is not on the slide,
 * there is nothing to draw, and the connection leaf still survives in the document.
 *
 * WIRES ARE NOT WIDGETS (user ruling): this returns plain geometry records, never
 * render nodes, and nothing here ever enters the item map.
 *
 * ── THE FLASH IS AN ARGUMENT, NOT A LOOKUP (per-frame triggers) ─────────────
 * > *"On frames where triggers fire, the wires connecting them should change color
 * > to show that something happened."* (user, 2026-08-12)
 *
 * `firedKeys` is the set of `"<fromItem>.<fromPort>"` that pulsed THIS frame —
 * `core/exec_frame.firedWireKeys(...)` builds it from the frame domain's step. A wire
 * whose source pin is in the set carries `fired: true`, and
 * `core/node_chrome.wireOps` paints it in the flash colour.
 *
 * IT IS PASSED IN RATHER THAN READ, and that keeps this function PURE: whether a
 * trigger fired is a fact about a simulation STEP, and a `deriveWires` that consulted
 * the ambient history table would produce different geometry on two derives of one
 * frame — the exact thing `core/exec_frame.js` is shaped to prevent one level up.
 * Passing `undefined` (every existing caller) stamps nothing and returns the same
 * records it always did, so nothing that predates the frame domain changed.
 *
 * DERIVED, NEVER STORED: `plugins/node_display.js` states the rule and
 * `plugins/node_button.js` the sharp version — *"a moment is not a value"*. A
 * `fired` leaf in the document would be ephemeral state written to disk.
 *
 * @param {object[]} nodes - derived render nodes
 * @param {Set<string>} [firedKeys] - "<item>.<port>" for every exec pin that pulsed
 *   this frame (core/exec_frame.firedWireKeys), or undefined for none
 * @returns {object[]} [{from: {item, port, x, y}, to: {item, port, x, y}, type, color?, fired?}]
 *
 * @example deriveWires([]) // []
 * @example // a→b on a number port: one wire, colored by the SOURCE type
 * @example deriveWires([{itemId: "a", world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 80}, plugin: {ports: () => ({outputs: [{key: "o", type: "number"}]})}}, {itemId: "b", world: {x: 200, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 80, inputs: {i: {item: "a", port: "o"}}}, plugin: {ports: () => ({inputs: [{key: "i", type: "number"}]})}}]).length // 1
 * @example // AN EXEC WIRE IS STORED ON THE OTHER SIDE and draws identically:
 * @example deriveWires([{itemId: "a", world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 80, exec: {then: {item: "b", port: "run"}}}, plugin: {ports: () => ({outputs: [{key: "then", type: "exec"}]})}}, {itemId: "b", world: {x: 200, y: 0, rotation: 0, scale: 1}, state: {w: 100, h: 80}, plugin: {ports: () => ({inputs: [{key: "run", type: "exec"}]})}}])[0].type // "exec"
 */
/** The empty fired set, shared — so a deck with no frame nodes allocates nothing and
 *  every reader gets one identity to compare against. */
const NO_FIRED_WIRES = Object.freeze(new Set());

/** Which exec pins pulsed on the most recent `deriveRenderTree` pass. Written there,
 *  read by `deriveWires` — see the write site for why this is a cell rather than a
 *  return value, and why replacing (never mutating) it is what keeps it safe. */
let lastFiredWires = NO_FIRED_WIRES;

/**
 * Query. The exec pins that pulsed on the most recent derive — what `deriveWires`
 * colours with when no set is passed explicitly.
 *
 * @returns {Set<string>} "<item>.<port>" keys, empty when nothing fired
 *
 * @example // firedWiresThisFrame().size // 0 on a deck with no per-frame triggers
 */
export function firedWiresThisFrame() {
  return lastFiredWires;
}

export function deriveWires(nodes, firedKeys = lastFiredWires) {
  const anchorsByItem = new Map();
  for (const n of nodes ?? []) {
    if (typeof n.plugin?.ports !== "function") continue;
    anchorsByItem.set(n.itemId, nodePortAnchors(n));
  }
  const wires = [];
  const push = (src, dst, from, to) => {
    if (!src || !dst) return;
    // The wire is the colour of its SOURCE bead: the type's, or the port's own
    // `color` when it declared one (carried here so core/node_chrome.wireOps and
    // the exporters paint the cable the colour of the socket it leaves).
    // `fired` is stamped ONLY when true, so a wire on a frame with no pulse — which
    // is every wire on every frame of every deck that predates the frame domain — is
    // the byte-identical record it always was, with no new key. `color` follows the
    // same rule: absent unless the port declared one.
    const fired = firedKeys?.has(`${from.item}.${from.port}`) ? { fired: true } : null;
    wires.push({
      from: { ...from, x: src.x, y: src.y }, to: { ...to, x: dst.x, y: dst.y }, type: src.type,
      ...(src.color !== undefined ? { color: src.color } : {}),
      ...fired,
    });
  };
  for (const n of nodes ?? []) {
    const myAnchors = anchorsByItem.get(n.itemId) ?? [];
    const inputs = n.state?.inputs;
    if (inputs && typeof inputs === "object") {
      // ONE WIRE PER STORED REFERENCE — a `multiple` input's slot holds several
      // (core/nodeflow.inputRefs is the one reader of both slot shapes), and each
      // of them is a cable into the same bead.
      for (const port of Object.keys(inputs).sort()) {
        for (const c of inputRefs(n.state, port)) {
          push(
            (anchorsByItem.get(c.item) ?? []).find((a) => a.side === "output" && a.key === c.port),
            myAnchors.find((a) => a.side === "input" && a.key === port),
            { item: c.item, port: c.port }, { item: n.itemId, port }
          );
        }
      }
    }
    // THE EXEC MAP IS THE SAME PICTURE READ FROM THE OTHER END. An exec wire is
    // stored on the FIRING node (core/nodeflow.js EXEC WIRES: the cardinality
    // mirror), so here `n` holds the OUTPUT anchor and the referenced item holds
    // the INPUT anchor — the exact transpose of the loop above. Both produce the
    // same record shape, so nothing downstream (wireOps, the SVG overlay, the PDF
    // and SVG backends) needed to learn what an exec wire is: it is a wire whose
    // `type` is "exec", which is already how a wire gets its colour.
    const execWires = n.state?.[EXEC_KEY];
    if (execWires && typeof execWires === "object") {
      for (const port of Object.keys(execWires).sort()) {
        const c = execWires[port];
        if (!c || typeof c !== "object" || typeof c.item !== "string") continue;
        push(
          myAnchors.find((a) => a.side === "output" && a.key === port),
          (anchorsByItem.get(c.item) ?? []).find((a) => a.side === "input" && a.key === c.port),
          { item: n.itemId, port }, { item: c.item, port: c.port }
        );
      }
    }
  }
  return wires;
}

/**
 * Pure function. THE camera rect for a folded state: the first active camera
 * item (by id, deterministic), else the meta slide rect. The camera is a
 * bounding box that determines every rendered view — export aspect, per-slide
 * thumbnails, and the presentation viewport (manifest: THE CAMERA).
 *
 * The BACKGROUND comes from the camera too (user spec) — default white.
 *
 * @example cameraRect({items: {}}, {slideW: 1280, slideH: 720}) // {x: 0, y: 0, w: 1280, h: 720, background: "#ffffff"}
 * @example cameraRect({items: {c: {type: "camera", x: 5, y: 6, w: 100, h: 50}}}, {}).w // 100
 */
export function cameraRect(state, meta) {
  const cams = Object.entries(state.items ?? {})
    .filter(([, s]) => s.type === "camera" && s.active !== false)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (cams.length === 0) {
    // Repair (withCameraEnsured + withExtraCamerasDropped) guarantees THE
    // CAMERA in every loaded doc, so a folded state with no active camera means
    // the invariant was violated UPSTREAM (a doc derived without
    // repairedDocument, or a camera deactivated). Fall back to the meta slide
    // rect — still a usable view when meta carries dims (thumbnails, pre-fold
    // contexts). But if meta has no dims the result is a degenerate 0×0 blank
    // view: report it ONCE rather than silently painting nothing.
    const w = meta.slideW ?? 0, h = meta.slideH ?? 0;
    if (w === 0 || h === 0)
      reportOnce(
        "camerarect-degenerate",
        "PowerRP: cameraRect found no active camera and no meta slide dimensions — degenerate 0×0 view. The camera invariant (THE CAMERA) was violated upstream (document not run through repairedDocument?).",
      );
    return { x: 0, y: 0, w, h, background: "#ffffff" };
  }
  const s = cams[0][1];
  return { x: s.x ?? 0, y: s.y ?? 0, w: s.w ?? 0, h: s.h ?? 0, background: s.background ?? "#ffffff" };
}

/**
 * Pure function. The 9 standard bbox anchor points in LOCAL coords for a
 * state with w/h. The shared implementation plugins declare as `anchors`.
 *
 * @example standardBBoxAnchors({w: 10, h: 20}).find((a) => a.id === "cm") // {id: "cm", x: 5, y: 10}
 */
export function standardBBoxAnchors(state) {
  const w = state.w ?? 0, h = state.h ?? 0;
  return [
    { id: "tl", x: 0, y: 0 }, { id: "tm", x: w / 2, y: 0 }, { id: "tr", x: w, y: 0 },
    { id: "ml", x: 0, y: h / 2 }, { id: "cm", x: w / 2, y: h / 2 }, { id: "mr", x: w, y: h / 2 },
    { id: "bl", x: 0, y: h }, { id: "bm", x: w / 2, y: h }, { id: "br", x: w, y: h },
  ];
}

/**
 * The one standard anchor that is NOT a rim point: the box CENTRE. Named here
 * because the ink rule below is stated in terms of "every standard anchor except
 * this one", and that exception must be written down exactly once.
 */
export const BBOX_CENTER_ANCHOR = "cm";

/**
 * Pure function. The eight standard anchor ids that lie on the box's RIM —
 * standardBBoxAnchors minus the centre. DERIVED from that function rather than
 * listed, so a tenth standard anchor joins the ink rule by being added there and
 * nowhere else.
 *
 * @example standardRimAnchorIds() // ["tl", "tm", "tr", "ml", "mr", "bl", "bm", "br"]
 */
export function standardRimAnchorIds() {
  return standardBBoxAnchors({ w: 0, h: 0 }).map((a) => a.id).filter((id) => id !== BBOX_CENTER_ANCHOR);
}

/** The LOCAL→LOCAL frame: closestAnchor takes a WORLD query and returns a LOCAL
 *  point, so asking it about a point that is ALREADY local means handing it the
 *  identity world. */
const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

/**
 * Near-pure function (constructs a plugin object; no I/O). THE INK RULE:
 * AN ANCHOR LANDS ON THE INK. Returns the plugin with its eight standard RIM
 * anchors projected through the widget's OWN closest-point-on-rim map — the
 * same `closestAnchor` the equation function `closest_to_rim` uses, so a named
 * anchor and a live rim solve can never disagree about where the shape is.
 * `cm` is the CENTRE, not a rim point, and is never projected: the middle of a
 * donut's hole is exactly where a label belongs. A plugin-specific anchor
 * (`light`, `hotspot`, `staple`, `f0tl`) is left alone — the plugin put it
 * somewhere deliberate.
 *
 * WHY THIS EXISTS. Nine anchors derived from the BOUNDING BOX are correct for a
 * rectangle and wrong for everything else: a 200x120 diamond's `tr` sat at
 * (200, 0), which is empty space outside the shape, so anything bound there
 * floated off the ink. The user found it by shattering a Mermaid flowchart —
 * "it's just that diamonds don't have anchors in the right place."
 *
 * IT IS A GENERALISATION, NOT A NEW IDEA. plugins/rect.js already did exactly
 * this for ONE widget in Round 12 — "for a rounded rect the four corner anchors
 * slide onto their arcs … so arrows meet the painted rounded corner instead of
 * the empty square corner" — by mapping standardBBoxAnchors through
 * core/outline.js roundedRectAnchorPoint, which IS closestPointOnRoundedRect
 * applied to the anchor. That fix was one file away from every other widget with
 * the same defect for a whole round. This is the same map, applied by the
 * registry to every plugin that declares a rim, so the NEXT widget added gets it
 * with no edit and rect's own override is retired in the same commit.
 *
 * IT COSTS NOTHING WHERE IT IS NOT NEEDED. The projection is IDEMPOTENT: an
 * anchor already on the rim is a fixed point of it. So a rect, an image, a text
 * box or a bare rounded rect at r=0 is byte-identical, and only shapes whose
 * silhouette differs from their box move at all.
 *
 * A plugin with no `closestAnchor` has no rim to project onto and is returned
 * unchanged — a group, a text box and the camera keep their box anchors, which
 * is right: their "ink" is a layout box, not a silhouette.
 *
 * @param {object} plugin - a plugin, before registration
 * @returns {object} the plugin, or a copy whose `anchors` is ink-true
 *
 * @example withInkAnchors({type: "x", anchors: standardBBoxAnchors}).anchors === standardBBoxAnchors // true (no rim declared -> untouched)
 * @example // A widget whose rim is the unit circle inscribed in its box: `tl` leaves the empty corner and lands on the arc.
 * @example withInkAnchors({type: "c", anchors: standardBBoxAnchors, closestAnchor: (s, x, y) => ({x: 1 + Math.SQRT1_2 * Math.sign(x - 1), y: 1 + Math.SQRT1_2 * Math.sign(y - 1)})}).anchors({w: 2, h: 2}).find((a) => a.id === "tl") // {id: "tl", x: 0.2928932188134524, y: 0.2928932188134524}
 * @example withInkAnchors({type: "c", anchors: standardBBoxAnchors, closestAnchor: () => ({x: 99, y: 99})}).anchors({w: 2, h: 2}).find((a) => a.id === "cm") // {id: "cm", x: 1, y: 1} (the centre is never projected)
 */
export function withInkAnchors(plugin) {
  if (!plugin.anchors || !plugin.closestAnchor) return plugin;
  const declared = plugin.anchors;
  const rim = new Set(standardRimAnchorIds());
  return {
    ...plugin,
    anchors(state) {
      return declared(state).map((a) => (rim.has(a.id)
        ? { ...a, ...plugin.closestAnchor(state, a.x, a.y, IDENTITY_WORLD) }
        : a));
    },
  };
}

/**
 * Pure function. The LOCAL rect a bbox widget is CLICKABLE within: its property
 * box, UNIONED with its INK BOUNDS when the plugin declares them and they reach
 * outside that box.
 *
 * WHY THE UNION AND NOT SIMPLY THE INK (user, 2026-08-02: "when I click the text,
 * when the text is out of the box, it doesn't work"). Overflowing ink must become
 * clickable — that is the whole defect. But the property box must STAY clickable
 * too, and the two are not nested in either direction: a half-empty text box has
 * ink smaller than its box (its empty lower half is still a legitimate grab
 * target, and is where a user drags a box they are about to type into), while an
 * overflowing one has ink larger. Taking either rect alone would fix one report
 * by creating its mirror image. The union is the only rect that keeps both.
 *
 * A plugin with NO `localBounds` is unchanged to the bit: localBoundsOf's own
 * default for a bbox widget is exactly {0, 0, w, h}, so the union is the box.
 *
 * @param {object} node - a derived node whose plugin has capabilities.bbox
 * @returns {{x: number, y: number, w: number, h: number}} the local clickable rect
 *
 * @example clickableLocalRect({state: {w: 10, h: 20}, plugin: {capabilities: {bbox: true}}}) // {x: 0, y: 0, w: 10, h: 20} (no ink hook: the box)
 * @example // text overflowing its box downward stays grabbable across BOTH rects:
 * @example clickableLocalRect({state: {w: 10, h: 20}, plugin: {capabilities: {bbox: true}, localBounds: () => ({x: 0, y: 0, w: 10, h: 90})}}) // {x: 0, y: 0, w: 10, h: 90}
 * @example // ink SMALLER than the box does not shrink the grab target:
 * @example clickableLocalRect({state: {w: 100, h: 80}, plugin: {capabilities: {bbox: true}, localBounds: () => ({x: 0, y: 0, w: 12, h: 9})}}) // {x: 0, y: 0, w: 100, h: 80}
 */
export function clickableLocalRect(node) {
  const box = { x: 0, y: 0, w: node.state.w ?? 0, h: node.state.h ?? 0 };
  const ink = node.plugin.localBounds ? node.plugin.localBounds(node.state) : null;
  // A widget with nothing drawn (an empty text box reports a zero rect) must not
  // drag the union to the origin when its box is elsewhere — an empty rect
  // encloses nothing, so there is nothing to add.
  if (!ink || (ink.w <= 0 && ink.h <= 0)) return box;
  return unionRect([box, ink]);
}

/**
 * Pure function. Does a world point hit this node? Converts to local space
 * and asks the plugin's hitTest, falling back to the CLICKABLE RECT (the box
 * unioned with any declared ink bounds — clickableLocalRect). Plugins may
 * instead define hitTestWorld(node, wx, wy, nodesById) for widgets whose
 * geometry lives in world space (arrows).
 *
 * A plugin declaring its OWN `hitTest` still wins outright: that hook is a
 * silhouette test (a polygon's interior, a line's stroke corridor), and a widget
 * that has gone to the trouble of describing its exact shape must not have a
 * rectangle unioned back onto it.
 */
function hitNode(node, wx, wy, nodesById, tol = 0) {
  const { plugin, state } = node;
  if (plugin.hitTestWorld) return plugin.hitTestWorld(node, wx, wy, nodesById);
  // A FLIPPED node paints its content reflected about its box center, so the probe
  // point must be reflected back before any hitTest sees it — every one of them
  // (and the bbox default below) is written against the UNMIRRORED frame and asks
  // `0 <= p <= w`. One reflection here covers all of them; no plugin learns about
  // flips. Unflipped nodes carry no `mirror`, so they take the identity path.
  const local = node.mirror
    ? unmirroredLocal(T.apply(T.invert(node.world), wx, wy), { ...state, mirrorX: node.mirror.x, mirrorY: node.mirror.y })
    : T.apply(T.invert(node.world), wx, wy);
  if (plugin.hitTest) return plugin.hitTest(state, local.x, local.y, tol / node.world.scale);
  if (plugin.capabilities.bbox) {
    const r = clickableLocalRect(node);
    return local.x >= r.x && local.x <= r.x + r.w && local.y >= r.y && local.y <= r.y + r.h;
  }
  return false;
}

/**
 * Pure function. Topmost node hit by a world point (nodes are z-ascending,
 * so scan from the end), or null. `tol` is a WORLD-unit grab tolerance
 * (screen px / zoom) forwarded to plugin hitTests — border-grab widgets like
 * the camera keep a constant screen-space feel at any zoom.
 */
export function pickNode(nodes, wx, wy, tol = 0) {
  return pickNodeStack(nodes, wx, wy, tol)[0] ?? null;
}

/**
 * Pure function. EVERY node hit by a world point, topmost FIRST — the whole
 * stack under the cursor rather than just its lid. `pickNode` is this function's
 * first element and is defined as such, so the two can never disagree about what
 * "hit" means or about z-order.
 *
 * WHAT IT IS FOR: click-through cycling (user, 2026-08-01) — "if I click an
 * element and then I click it again and it's not fast enough to be a double
 * click, select the element under that, and then under that … so that I can
 * select objects that are under things that I can't normally reach". An occluded
 * object is otherwise unreachable by pointer at all; the only routes to it are the
 * Inspector's item picker and the keyboard. Topmost-first ordering means the
 * cycle's step N is simply `stack[N % stack.length]`, and index 0 is the plain
 * click everyone already expects.
 *
 * @param {object[]} nodes - the derived nodes, z-ASCENDING (as app.nodes() gives them)
 * @param {number} wx - world x
 * @param {number} wy - world y
 * @param {number} tol - world-unit grab tolerance, forwarded to plugin hitTests
 * @returns {object[]} the hit nodes, topmost first; empty when nothing is hit
 *
 * @example pickNodeStack([], 0, 0) // []
 * @example // two stacked rects, b drawn over a:
 * @example // pickNodeStack([a, b], 5, 5).map((n) => n.itemId) // ["b", "a"]
 * @example // pickNode is its lid:
 * @example // pickNodeStack(nodes, x, y)[0] === pickNode(nodes, x, y) // true
 */
export function pickNodeStack(nodes, wx, wy, tol = 0) {
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const hits = [];
  for (let i = nodes.length - 1; i >= 0; i--)
    if (hitNode(nodes[i], wx, wy, nodesById, tol)) hits.push(nodes[i]);
  return hits;
}

// NOTE: resolveBinding ({item, anchor} endpoint bindings) lived here until
// THE UNIFICATION replaced binding objects with equation strings evaluated in
// the derivation stage — see core/expressions.js (withBindingsMigrated
// converts legacy documents on load).
