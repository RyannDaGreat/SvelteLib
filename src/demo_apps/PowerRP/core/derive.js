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
 * Pure function. Derives the z-sorted render tree from a folded state.
 * Sort: ascending z (default 0), ties broken by id for determinism.
 */
export function deriveRenderTree(state, registry) {
  const items = state.items ?? {};
  // `active` is a universal widget property (default true). Delete in the UI
  // keyframes active:false — the item KEEPS its identity and properties and
  // simply isn't derived on slides where it's inactive (this is how objects
  // live on some slides and not others). "Purge" is the real removal.
  const nodes = Object.entries(items).filter(([, s]) => s.active !== false).map(([id, itemState]) => ({
    id,
    itemId: id,
    type: itemState.type,
    state: itemState,
    world: T.fromState(itemState),
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
 * geometry needs resolved bindings (arrows).
 */
export function hitNode(node, wx, wy, nodesById) {
  const { plugin, state } = node;
  if (plugin.hitTestWorld) return plugin.hitTestWorld(node, wx, wy, nodesById);
  const local = T.apply(T.invert(node.world), wx, wy);
  if (plugin.hitTest) return plugin.hitTest(state, local.x, local.y);
  if (plugin.capabilities.bbox)
    return local.x >= 0 && local.x <= (state.w ?? 0) && local.y >= 0 && local.y <= (state.h ?? 0);
  return false;
}

/**
 * Pure function. Topmost node hit by a world point (nodes are z-ascending,
 * so scan from the end), or null.
 */
export function pickNode(nodes, wx, wy) {
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  for (let i = nodes.length - 1; i >= 0; i--)
    if (hitNode(nodes[i], wx, wy, nodesById)) return nodes[i];
  return null;
}

/**
 * Pure function. Resolves an arrow-endpoint binding to a world point.
 * Binding forms:
 *   {x, y}                      → free point
 *   {item, anchor: "<presetId>"} → that anchor on that item
 *   {item, anchor: "closest"}    → plugin's computed closest-point anchor
 *     toward `towardX/Y` (e.g. the arrow's other endpoint) — the circle
 *     closest-point case from the requirements.
 * Returns {x, y} or null when the bound item is absent on this slide.
 */
export function resolveBinding(binding, nodesById, towardX, towardY) {
  if (binding == null) return null;
  if (binding.item === undefined) return { x: binding.x, y: binding.y };
  const node = nodesById[binding.item];
  if (!node) return null;
  if (binding.anchor === "closest" && node.plugin.closestAnchor) {
    const local = node.plugin.closestAnchor(node.state, towardX, towardY, node.world);
    return T.apply(node.world, local.x, local.y);
  }
  const anchor = nodeAnchors(node).find((a) => a.id === binding.anchor);
  return anchor ? { x: anchor.x, y: anchor.y } : null;
}
