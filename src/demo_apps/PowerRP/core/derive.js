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
import { unmirroredLocal, unsignedState } from "./geometry.js";

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
  const c = T.apply({ ...base, rotation: 0 }, itemState.w / 2, itemState.h / 2);
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
 */
export function deriveRenderTree(state, registry) {
  const items = state.items ?? {};
  // `active` is a universal widget property (default true). Delete in the UI
  // keyframes active:false — the item KEEPS its identity and properties and
  // simply isn't derived on slides where it's inactive (this is how objects
  // live on some slides and not others). "Purge" is the real removal.
  // Typeless items are NOT YET CREATED on this fold (their creation slide is
  // later in the deck — imaginary-slide semantics; see expressions.js) and
  // derive exactly like inactive ones: skipped, never an error.
  const nodes = Object.entries(items).filter(([, s]) => s.active !== false && typeof s.type === "string").map(([id, itemState]) => {
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
    return {
      id,
      itemId: id,
      type: itemState.type,
      state,
      world: worldTransform(state),
      plugin: registry.get(itemState.type),
      ...(mirror ? { mirror } : {}),
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
 * influence measures a pure current-vs-bind delta. Missing bind ⇒ identity
 * (a group with no bind never moves its members — the safe default; a
 * freshly-created group always has one).
 *
 * @example groupBindWorld({bind: {x: 100, y: 100, rotation: 0, scale: 1}, w: 200, h: 100}) // {x: 100, y: 100, rotation: 0, scale: 1}
 * @example groupBindWorld({w: 200, h: 100}) // {x: 0, y: 0, rotation: 0, scale: 1}
 */
export function groupBindWorld(groupState) {
  const b = groupState.bind;
  if (!b) return T.identity();
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
  for (const g of groups) {
    const influence = groupInfluence(g.world, groupBindWorld(g.state));
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
  return map;
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
// consumers become possible.
//
// CONVENTION (the documented reading, not something the mechanism enforces):
// `constrain` returns the NEAREST point of the handle's allowed set, so it is a
// metric projection and therefore IDEMPOTENT — which is what licenses composing
// it with an `apply` that constrains again internally, and what makes
// constraintPull below a free second consumer instead of a second declaration.
// The signature is deliberately GENERIC (a point → a point in the same space),
// so a future non-projection use is a new convention, not a violation.
//
// COORDINATE SPACE: LOCAL units, always. nodeModifierPoints wraps a handle's
// position local→world and CanvasView inverts the SAME world back before calling
// either hook, so rotation and scale are correct BY CONSTRUCTION and no plugin
// reasons about them. One consequence to state out loud because it is a design
// choice and not an oversight: under NON-UNIFORM scale, nearest-in-local is not
// nearest-in-world. The constraint is a statement about the widget's own
// parameters (a donut's inner radius runs along ITS x axis), so LOCAL is where it
// is meaningful and where "nearest" is defined. Do not "fix" this into world
// space — that would make a squashed donut's handle answer a question nobody
// asked.

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
 * Pure function. How far the constraint PULLED a desired point: the distance
 * from `desired` to the nearest allowed point, |p − constrain(p)|. Zero exactly
 * when the point was already allowed.
 *
 * This is the projection's free second consumer — the same declaration answers
 * "how far did the constraint drag my pointer" (a resisted drag) and "which
 * handle is nearest what I am pointing at" (hit-testing among handles), with no
 * second thing for a widget to declare or keep in sync.
 *
 * @example constraintPull({constrain: (s, p) => ({x: p.x, y: 0})}, {}, {x: 5, y: 3}) // 3
 * @example constraintPull({constrain: UNCONSTRAINED}, {}, {x: 5, y: 3}) // 0
 */
export function constraintPull(mp, state, desired) {
  const allowed = mp.constrain(state, desired);
  return Math.hypot(desired.x - allowed.x, desired.y - allowed.y);
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
 *     widget's handles render byte-identically.
 *   `stem` — an OPTIONAL LOCAL point this handle tethers to (its anchor), wrapped
 *     to WORLD here exactly like x/y so a dashed GHOST line can be drawn from it to
 *     the handle. Absent → no tether line.
 *
 * @example nodeModifierPoints({world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {}, plugin: {}}) // []
 * @example nodeModifierPoints({world: {x: 5, y: 0, rotation: 0, scale: 1}, state: {}, plugin: {modifierPoints: () => [{id: "a", x: 1, y: 2}]}}) // [{id: "a", x: 6, y: 2, element: null, active: true, apply: undefined, constrain: UNCONSTRAINED, shape: null, stem: null}]
 */
export function nodeModifierPoints(node) {
  return (node.plugin.modifierPoints?.(node.state) ?? []).map((m) => {
    const p = T.apply(node.world, m.x, m.y);
    const stem = m.stem ? T.apply(node.world, m.stem.x, m.stem.y) : null;
    return { id: m.id, x: p.x, y: p.y, element: m.element ?? null, active: m.active !== false, apply: m.apply, constrain: m.constrain ?? UNCONSTRAINED, shape: m.shape ?? null, stem: stem ? { x: stem.x, y: stem.y } : null };
  });
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
 * Pure function. Does a world point hit this node? Converts to local space
 * and asks the plugin's hitTest, falling back to the bbox. Plugins may
 * instead define hitTestWorld(node, wx, wy, nodesById) for widgets whose
 * geometry lives in world space (arrows).
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
  if (plugin.capabilities.bbox)
    return local.x >= 0 && local.x <= (state.w ?? 0) && local.y >= 0 && local.y <= (state.h ?? 0);
  return false;
}

/**
 * Pure function. Topmost node hit by a world point (nodes are z-ascending,
 * so scan from the end), or null. `tol` is a WORLD-unit grab tolerance
 * (screen px / zoom) forwarded to plugin hitTests — border-grab widgets like
 * the camera keep a constant screen-space feel at any zoom.
 */
export function pickNode(nodes, wx, wy, tol = 0) {
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  for (let i = nodes.length - 1; i >= 0; i--)
    if (hitNode(nodes[i], wx, wy, nodesById, tol)) return nodes[i];
  return null;
}

// NOTE: resolveBinding ({item, anchor} endpoint bindings) lived here until
// THE UNIFICATION replaced binding objects with equation strings evaluated in
// the derivation stage — see core/expressions.js (withBindingsMigrated
// converts legacy documents on load).
