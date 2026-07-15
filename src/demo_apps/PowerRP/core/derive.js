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
 *     plugin }
 */

import * as T from "./transform.js";
import { reportOnce } from "./report.js";

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
  const nodes = Object.entries(items).filter(([, s]) => s.active !== false && typeof s.type === "string").map(([id, itemState]) => ({
    id,
    itemId: id,
    type: itemState.type,
    state: itemState,
    world: worldTransform(itemState),
    plugin: registry.get(itemState.type),
  }));
  nodes.sort((a, b) => (a.state.z ?? 0) - (b.state.z ?? 0) || (a.id < b.id ? -1 : 1));
  return resolveCropTargets(applyGroupParenting(nodes));
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
 * @example nodeModifierPoints({world: {x: 0, y: 0, rotation: 0, scale: 1}, state: {}, plugin: {}}) // []
 */
export function nodeModifierPoints(node) {
  return (node.plugin.modifierPoints?.(node.state) ?? []).map((m) => {
    const p = T.apply(node.world, m.x, m.y);
    return { id: m.id, x: p.x, y: p.y, apply: m.apply };
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
  if (cams.length === 0)
    return { x: 0, y: 0, w: meta.slideW ?? 0, h: meta.slideH ?? 0, background: "#ffffff" };
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
  const local = T.apply(T.invert(node.world), wx, wy);
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
