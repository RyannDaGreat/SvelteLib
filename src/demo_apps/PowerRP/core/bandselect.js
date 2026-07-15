/**
 * Rubber-band (bounding-box) selection — DOM-free pure JS.
 *
 * Two modes (manifest "Bounding-box selection tool"):
 *   INNER — an object is selected only if COMPLETELY ENCLOSED by the box.
 *   OUTER — touching/intersecting the box is enough.
 *
 * The object's bounds for the test is its world AABB from
 * core/view.js::rotatedBBoxAABB (conservative for rotated items — never
 * smaller than the true bounds, so a rotated item is treated by the box it
 * would occupy axis-aligned). This is the ONE geometry both culling and band
 * selection agree on; the predicates below reuse the same rect algebra
 * (rectContains mirrors rectsIntersect's edge-inclusive <= convention).
 */

import { rotatedBBoxAABB, rectsIntersect } from "./view.js";

/**
 * Pure function. Is rect `inner` fully contained by rect `outer`? Both are
 * (x,y,w,h). Edge-flush counts as contained (<=/>=), matching rectsIntersect's
 * touching-is-overlap convention — a box drawn exactly on an object's bounds
 * selects it in BOTH modes (no gap between inner/outer at the boundary).
 *
 * @example rectContains({x: 0, y: 0, w: 100, h: 100}, {x: 10, y: 10, w: 20, h: 20}) // true
 * @example rectContains({x: 0, y: 0, w: 100, h: 100}, {x: 90, y: 0, w: 20, h: 10}) // false
 * @example rectContains({x: 0, y: 0, w: 100, h: 100}, {x: 0, y: 0, w: 100, h: 100}) // true
 */
export function rectContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h;
}

/**
 * Pure function. Is a render node band-selectable at all? A node qualifies
 * only when it has a boundable world AABB (bbox capability) AND is not the
 * camera. WHY exclude the camera: it is border-hit-only by design (clicks
 * inside pass through to content — plugins/camera.js hitTest), it is
 * non-purgeable and always present, and it frames the scene rather than being
 * scene content — band-selecting it on every drag would be noise. Non-bbox
 * widgets (arrow, blur) have no world AABB to test against, so they are not
 * band-selectable (justified: rotatedBBoxAABB returns null for them — there is
 * nothing conservative to enclose; they remain selectable via click / picker).
 *
 * @example bandSelectable({type: "rect", plugin: {capabilities: {bbox: true}}}) // true
 * @example bandSelectable({type: "camera", plugin: {capabilities: {bbox: true, purgeable: false}}}) // false
 * @example bandSelectable({type: "blur", plugin: {capabilities: {bbox: false}}}) // false
 */
export function bandSelectable(node) {
  return node.plugin.capabilities.bbox === true && node.type !== "camera";
}

/**
 * Pure function. The itemIds of the render nodes selected by a world-space
 * band rect (x,y,w,h) in the given mode ("inner" | "outer"). Only
 * band-selectable nodes are considered (see bandSelectable). INNER keeps a
 * node whose world AABB is fully inside the box; OUTER keeps a node whose
 * world AABB intersects the box (edge touch counts). Deterministic (input node
 * order preserved).
 *
 * @example // one rect at world 100,100 size 50x50; box 90,90..200,200:
 * @example selectInBox([{itemId: "a", type: "rect", state: {w: 50, h: 50}, world: {x: 100, y: 100, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}], {x: 90, y: 90, w: 110, h: 110}, "inner") // ["a"]
 * @example // same rect, box 90,90..120,120 only touches it (partial overlap):
 * @example selectInBox([{itemId: "a", type: "rect", state: {w: 50, h: 50}, world: {x: 100, y: 100, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}], {x: 90, y: 90, w: 30, h: 30}, "inner") // []
 * @example selectInBox([{itemId: "a", type: "rect", state: {w: 50, h: 50}, world: {x: 100, y: 100, rotation: 0, scale: 1}, plugin: {capabilities: {bbox: true}}}], {x: 90, y: 90, w: 30, h: 30}, "outer") // ["a"]
 */
export function selectInBox(nodes, boxRect, mode) {
  const hit = mode === "inner"
    ? (aabb) => rectContains(boxRect, aabb)
    : (aabb) => rectsIntersect(boxRect, aabb);
  const out = [];
  for (const node of nodes) {
    if (!bandSelectable(node)) continue;
    const aabb = rotatedBBoxAABB(node);
    if (aabb && hit(aabb)) out.push(node.itemId);
  }
  return out;
}

/**
 * Pure function. Rewrites a raw list of band-caught itemIds so a rubber band
 * grabs TOP-LEVEL GROUPS only, never members of a group (manifest Round-12B
 * box-select rule: "box select grabs TOP-LEVEL GROUPS only, never reaches
 * inside a group; you can never have a group AND its members selected
 * simultaneously"). `membership` is core/derive.groupMembership (memberId →
 * its group's itemId).
 *
 * Each caught id becomes: its GROUP's id if it is a member (so catching a
 * member selects the whole group), or itself if it is ungrouped (a group node
 * caught directly stays itself — it isn't a member). Deduped, first-appearance
 * order preserved. A member caught alongside its group both collapse to the
 * group id and dedupe to one entry — the group-and-members-never-both invariant
 * holds by construction.
 *
 * @example groupFilteredSelection(["a", "b"], new Map([["a", "g"], ["b", "g"]])) // ["g"]
 * @example groupFilteredSelection(["r", "a"], new Map([["a", "g"]])) // ["r", "g"]
 * @example groupFilteredSelection(["g", "a"], new Map([["a", "g"]])) // ["g"]
 */
export function groupFilteredSelection(caughtIds, membership) {
  const out = [];
  const seen = new Set();
  for (const id of caughtIds) {
    const top = membership.get(id) ?? id;
    if (!seen.has(top)) { seen.add(top); out.push(top); }
  }
  return out;
}

/**
 * Pure function. A selection set with the group-and-members-never-both
 * invariant enforced (manifest Round-12B): if a GROUP is present, every member
 * of that group is removed; a member whose group is NOT in the set is left
 * alone (a member may be selected on its own — e.g. a direct member click with
 * Show Ghosts off). `membership` is core/derive.groupMembership. Order
 * preserved; deduped.
 *
 * WHY the asymmetry (drop members-of-a-present-group, keep lone members): the
 * only way both a group and its member enter one set is a mixed gesture (e.g.
 * a band catching a group plus a shift-add of a member) — there the group is
 * the intended top-level handle and the member is redundant, so the group
 * wins. A member selected with NO group in the set is a deliberate
 * member-level selection and must survive.
 *
 * @example dedupeGroupSelection(["g", "a"], new Map([["a", "g"]])) // ["g"]
 * @example dedupeGroupSelection(["a"], new Map([["a", "g"]])) // ["a"]
 * @example dedupeGroupSelection(["g", "r"], new Map([["a", "g"]])) // ["g", "r"]
 */
export function dedupeGroupSelection(ids, membership) {
  const present = new Set(ids);
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const g = membership.get(id);
    if (g && present.has(g)) continue; // member whose group is also selected → drop the member
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/**
 * Pure function. Normalizes two world drag corners into a positive-size rect
 * (x,y,w,h). A rubber-band may be dragged in any direction; the band rect is
 * always the axis-aligned box between the two points.
 *
 * @example rectFromCorners({x: 100, y: 50}, {x: 20, y: 80}) // {x: 20, y: 50, w: 80, h: 30}
 * @example rectFromCorners({x: 0, y: 0}, {x: 10, y: 10}) // {x: 0, y: 0, w: 10, h: 10}
 */
export function rectFromCorners(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
