/**
 * Rubber-band (bounding-box) selection — DOM-free pure JS.
 *
 * Two modes (manifest "Bounding-box selection tool"):
 *   INNER — an object is selected only if COMPLETELY ENCLOSED by the box.
 *   OUTER — touching/intersecting the box is enough.
 *
 * The object's bounds for the test is its world AABB from
 * core/view.js::rotatedBBoxAABB — the widget's own declared LOCAL bounds
 * (localBoundsOf: its box, or a two-point widget's endpoint hull) mapped through
 * its world transform, conservative for rotated items (never smaller than the
 * true bounds, so a rotated item is treated by the box it would occupy
 * axis-aligned). This is the ONE geometry culling, band selection and the
 * copy/export capture rect all agree on; the predicates below reuse the same rect
 * algebra (rectContains mirrors rectsIntersect's edge-inclusive <= convention).
 */

import { localBoundsOf, rotatedBBoxAABB, rectsIntersect } from "./view.js";

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
 * Pure function. Is a render node band-selectable at all? A node qualifies when
 * it is BOUNDABLE (core/view.js localBoundsOf reports a local rect) AND is not
 * the camera. WHY exclude the camera: it is border-hit-only by design (clicks
 * inside pass through to content — plugins/camera.js hitTest), it is
 * non-purgeable and always present, and it frames the scene rather than being
 * scene content — band-selecting it on every drag would be noise.
 *
 * The gate used to be `capabilities.bbox === true`, which excluded every
 * TWO-POINT widget (line, arrow, elbow / curved / fancy arrow, tangent lines,
 * yarn) on the grounds that "there is nothing conservative to enclose". That
 * justification was true only of a full-canvas backdrop sampler and FALSE of a
 * line: a line's height and width are just the min/max of its endpoints, which
 * every one of those plugins already computes for its own effect substrate. They
 * now declare `localBounds` and band-select like anything else, in both modes.
 * blur remains excluded — honestly this time, because localBoundsOf reports null
 * for it (no geometry at all); it stays reachable via click / the item picker.
 *
 * @example bandSelectable({type: "rect", state: {w: 50, h: 50}, plugin: {capabilities: {bbox: true}}}) // true
 * @example bandSelectable({type: "camera", state: {w: 1280, h: 720}, plugin: {capabilities: {bbox: true, purgeable: false}}}) // false
 * @example bandSelectable({type: "line", state: {from: {x: 0, y: 0}, to: {x: 10, y: 10}}, plugin: {capabilities: {bbox: false}, localBounds: () => ({x: 0, y: 0, w: 10, h: 10})}}) // true
 * @example bandSelectable({type: "blur", state: {}, plugin: {capabilities: {bbox: false}}}) // false (unboundable)
 */
export function bandSelectable(node) {
  return localBoundsOf(node) !== null && node.type !== "camera";
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
 * Pure function. `dedupeGroupSelection`'s INVERSE: a selection set with every
 * GROUP in it replaced by its own members, each standing on its own.
 *
 * User, 2026-08-02: "we need to select in group that will select all objects
 * that are in a group individually." Selecting a group gives you ONE handle over
 * the whole box, which is what a group is for; this is how you get back down to
 * the things inside it without dissolving anything — Ungroup destroys the group,
 * this only changes what is selected.
 *
 * THE INVARIANT IS PRESERVED BY CONSTRUCTION, not by a second pass. The rule
 * (Round-12B) is that a group and its members are never both selected; here the
 * group is REPLACED, never added alongside, so the output cannot violate it. A
 * non-group id passes through untouched, so a mixed selection expands only its
 * groups and keeps everything else exactly where it was.
 *
 * ONE LEVEL PER CALL, DELIBERATELY. A member may itself be a group, and this
 * does not recurse into it — run the command again to go one level deeper. Two
 * reasons: it matches what the author can actually see (a group's own `members`
 * list is the thing on screen), and `core/derive.groupMembership` states that
 * nested-group precedence is out of scope, so silently flattening an arbitrary
 * depth would be inventing a semantics the rest of the system has not agreed to.
 * Repeating a step is also easier to undo in your head than one that went further
 * than you expected.
 *
 * @param {string[]} ids - the current selection
 * @param {Map<string, string[]>} membersOf - groupId → its member ids (absent for non-groups)
 * @returns {string[]} the expanded selection, order preserved, deduped
 *
 * @example expandGroupSelection(["g"], new Map([["g", ["a", "b"]]])) // ["a", "b"]
 * @example expandGroupSelection(["r", "g"], new Map([["g", ["a"]]])) // ["r", "a"]  (non-groups pass through)
 * @example expandGroupSelection(["r"], new Map()) // ["r"]  (nothing to expand)
 * @example expandGroupSelection(["g"], new Map([["g", []]])) // []  (an empty group expands to nothing)
 * @example expandGroupSelection(["g", "a"], new Map([["g", ["a", "b"]]])) // ["a", "b"]  (no duplicate from the already-selected member)
 */
export function expandGroupSelection(ids, membersOf) {
  const out = [];
  const seen = new Set();
  for (const id of ids)
    for (const next of membersOf.get(id) ?? [id])
      if (!seen.has(next)) { seen.add(next); out.push(next); }
  return out;
}

/**
 * Pure function. GO UP: a selection set with every MEMBER replaced by the group
 * that owns it. `expandGroupSelection`'s opposite direction, and the third
 * member of this file's group-selection trio.
 *
 * User, 2026-08-02: "'select parent group' should be a tool as well. It only
 * applies if it's a child of a group."
 *
 * `membership` is core/derive.groupMembership — the memberId → groupId map, the
 * SAME one dedupeGroupSelection takes, so going up and collapsing down read the
 * one relation rather than two views of it.
 *
 * WHY THIS CANNOT VIOLATE THE ROUND-12B INVARIANT even though it can produce a
 * group that was already selected: the member is REPLACED, and the dedupe by
 * `seen` means selecting a group plus one of its members yields just the group.
 * That is exactly what dedupeGroupSelection would have done to the same input,
 * so the two agree rather than fighting.
 *
 * A NON-MEMBER PASSES THROUGH. Selecting a loose rect and a grouped one and
 * going up gives you the loose rect and the group — the loose rect has no parent
 * to rise to, and dropping it would silently shrink the selection.
 *
 * ONE LEVEL PER CALL, matching its twin: a group that is itself a member of an
 * outer group rises one step, and running the tool again goes further.
 *
 * @param {string[]} ids - the current selection
 * @param {Map<string, string>} membership - memberId → owning groupId (absent for non-members)
 * @returns {string[]} the raised selection, order preserved, deduped
 *
 * @example selectParentGroups(["a"], new Map([["a", "g"]])) // ["g"]
 * @example selectParentGroups(["a", "b"], new Map([["a", "g"], ["b", "g"]])) // ["g"]  (both rise to the same group, once)
 * @example selectParentGroups(["a", "r"], new Map([["a", "g"]])) // ["g", "r"]  (the ungrouped rect stays)
 * @example selectParentGroups(["r"], new Map()) // ["r"]  (nothing has a parent)
 */
export function selectParentGroups(ids, membership) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const next = membership.get(id) ?? id;
    if (!seen.has(next)) { seen.add(next); out.push(next); }
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
