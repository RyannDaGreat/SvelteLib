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
  return nodes;
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
