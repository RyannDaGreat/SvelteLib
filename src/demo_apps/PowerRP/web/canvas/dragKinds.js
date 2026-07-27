/**
 * Drag-kind geometry — the PURE math shared by CanvasView's per-kind drag
 * handlers (move/resize/multi-resize/scale-modal). Extracted from CanvasView
 * (manifest UNDEFERRAL SWEEP: "CanvasView drag-machine extraction") so the
 * >2000-line component stops accreting geometry every wave and the math has ONE
 * DOM-free, doctested, node-testable home.
 *
 * SCOPE (a PARTIAL extraction, by design): only the STATELESS geometry lives
 * here — the functions that take explicit args and return values, with no
 * closure over the component's reactive `$state` (drag/guides/app/…). The
 * per-kind HANDLERS themselves (moveDrag/resizeDrag/multiResizeDrag/applyModal)
 * stay in CanvasView because they read and mutate component `$state` + call
 * `app.setPreview`; relocating those needs a mutable-state contract that would
 * be invasive to introduce while other agents are concurrently editing the same
 * component (the agent-scoping/shoelace rule). Those handlers now CALL these
 * pure functions — the shared record contract is: a `member`
 * ({itemId, plugin, rawItem, startX, startY, startWorld, startW, startH}) and a
 * bbox `base` ([x0,y0,x1,y1]) — so a future session can lift the handlers here
 * without changing this math.
 *
 * DOM-free: imports only core/transform + core/derive (also DOM-free), so this
 * module runs in bare node and is covered by tests/dragkinds_test.js.
 */

import * as T from "../../core/transform.js";
import { stateXYForCenterPivotWorld } from "../../core/derive.js";
import { diffState } from "../../core/deltas.js";

/**
 * THE drag-kind vocabulary: every value CanvasView may assign to `app.dragKind`,
 * mapped to the HELD MODIFIERS that kind reads (semantic ids, worded once in
 * core/shortcut_entries.js DRAG_MODIFIER_HINTS).
 *
 * WHY IT IS A TABLE AND NOT A COMMENT. This list was maintained by hand in TWO
 * places that both drifted: the HintBar's modifier hints were scoped to
 * "resize" only, and App.svelte's reachability prober walked a list that
 * contained "endpoint" (which nothing assigned back then — the endpoint drag set
 * only a LOCAL record, so it was invisible to every dragKind guard, which is how
 * a mid-drag Escape deselected under it) and omitted "multiresize" (which
 * everything did). Result: a multi-selection resize read Shift and Cmd, changed
 * the outcome, and announced NOTHING — and the guard meant to catch exactly that
 * was structurally blind to it. Both consumers now derive from here:
 *   - app.svelte.js's `dragKind` setter THROWS on a value not in DRAG_KINDS, so a
 *     new kind cannot exist without being declared; and
 *   - the hint entries and the prober are GENERATED from this map, so declaring
 *     a kind gets it probed, and declaring a modifier gets it a chip.
 *
 * A kind with NO modifiers still belongs here — it is a real drag state the
 * prober must walk. "endpoint" and "modifier" — the two single-point handle
 * grabs — read none (a lone point has nothing to relate to) and own ESCAPE
 * instead: CanvasView cancels either from its capture-phase listener
 * (ESC_CANCELABLE_DRAG_KINDS there lists exactly these two).
 */
export const DRAG_KIND_MODIFIERS = Object.freeze({
  move: Object.freeze(["axisLock"]),
  resize: Object.freeze(["uniform", "symmetric"]),
  multiresize: Object.freeze(["uniform", "symmetric"]),
  place: Object.freeze(["uniform", "symmetric"]),
  band: Object.freeze(["bandAdd", "bandRemove", "bandInvert"]),
  endpoint: Object.freeze([]),
  modifier: Object.freeze([]),
});

/**
 * Every legal `app.dragKind` value (null aside — null means "no drag"), derived
 * from DRAG_KIND_MODIFIERS so the two can never disagree.
 *
 * @example DRAG_KINDS.includes("multiresize") // true
 * @example DRAG_KINDS.length // 7
 */
export const DRAG_KINDS = Object.freeze(Object.keys(DRAG_KIND_MODIFIERS));

/**
 * Pure function. Turns a flat geometry delta {key: value, …} (as diffState
 * returns) into the item-scoped [path, value] preview pairs CanvasView commits
 * — the bridge from a MINIMAL delta to app.setPreview's pair list. Each key maps
 * to a flat state path ["items", itemId, key]; an EMPTY delta yields no pairs
 * (nothing changed → nothing to write, so no stored equation is disturbed).
 *
 * @example itemGeometryPairs("r", {x: 15, w: 120}) // [[["items","r","x"],15],[["items","r","w"],120]]
 * @example itemGeometryPairs("r", {}) // []
 */
export function itemGeometryPairs(itemId, delta) {
  return Object.entries(delta).map(([k, v]) => [["items", itemId, k], v]);
}

/**
 * Pure function. The path/value preview pairs that translate one member by a
 * world delta (dx, dy) — the ONE translation rule shared by DRAG-ALL body drags
 * and the modal grab. A moveBy widget (arrow) translates only its FREE numeric
 * coordinates via its plugin hook (bound endpoints stay anchored); a
 * bbox/transform widget writes plain numeric x/y, but ONLY on the axis that
 * actually moved (diffState) — a pure-horizontal drag (dy === 0) writes x alone
 * and leaves any equation stored on y untouched. Grabbing an axis that DID move
 * replaces its equation with the new literal (the established body-drag rule).
 *
 * @example // dragged on both axes → both written:
 * @example translationPairs({itemId: "r", plugin: {}, startX: 10, startY: 20}, 5, 3) // [[["items","r","x"], 15], [["items","r","y"], 23]]
 * @example // pure-horizontal drag → only x (y OMITTED, its equation survives):
 * @example translationPairs({itemId: "r", plugin: {}, startX: 10, startY: 20}, 5, 0) // [[["items","r","x"], 15]]
 */
export function translationPairs(member, dx, dy) {
  if (member.plugin.moveBy)
    return member.plugin.moveBy(member.rawItem, dx, dy)
      .map(([p, v]) => [["items", member.itemId, ...p], v]);
  const start = { x: member.startX, y: member.startY };
  const next = { x: member.startX + dx, y: member.startY + dy };
  return itemGeometryPairs(member.itemId, diffState(start, next, ["x", "y"]));
}

/**
 * Pure function. The grabbed point and fixed (anchor) point of a handle resize,
 * in the box's local frame — ONE computation shared by the resize math
 * (resizedBox) and the uniform diagonal guide, so they never disagree.
 *
 * gx/gy is the grabbed corner (on an axis with no grabbed edge it holds the far
 * coordinate, unused there); fx/fy is the point the resize is anchored to — the
 * opposite corner/edge, or the box CENTER when `symmetric` (Cmd).
 *
 * @example resizeAnchors([0, 0, 100, 50], {east: true, south: true}, {}) // {gx: 100, gy: 50, fx: 0, fy: 0, cx: 50, cy: 25, xActive: true, yActive: true}
 * @example resizeAnchors([0, 0, 100, 50], {east: true}, {symmetric: true}).fx // 50
 */
export function resizeAnchors([x0, y0, x1, y1], edges, mods) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return {
    gx: edges.west ? x0 : x1,
    gy: edges.north ? y0 : y1,
    fx: mods.symmetric ? cx : edges.west ? x1 : x0,
    fy: mods.symmetric ? cy : edges.north ? y1 : y0,
    cx, cy,
    xActive: !!(edges.east || edges.west),
    yActive: !!(edges.north || edges.south),
  };
}

/**
 * Pure function. The resized box for a handle drag with modifiers, in the box's
 * local frame (`base` = the box at the last modifier rebase). Also serves the
 * MULTI-resize collective box (which is world-axis-aligned, so its "local" frame
 * IS world — same math).
 *
 * Modifier semantics (manifest "Drag/resize modifiers — CONFIRMED mapping"):
 *   uniform (Shift)  — ONE scale factor K for both dimensions. A corner rides
 *     the diagonal through the anchor (the pointer projects onto it); an edge
 *     handle drives K from its own axis, and the passive axis scales about its
 *     center — the only symmetric-neutral choice for an axis with no grabbed
 *     edge (Figma's Shift+edge precedent).
 *   symmetric (Cmd)  — the anchor is the box CENTER, so both sides move
 *     (PowerPoint's Ctrl-resize precedent). Composes with uniform: the corner
 *     then rides the FULL diagonal, scaling about the center.
 *
 * Sizes never invert (MIN_SIZE = 0, the mathematical bound): K clamps at 0
 * (collapse onto the anchor); free edges stop at theirs.
 *
 * Args:
 *   base  (number[4]): [x0, y0, x1, y1] box at the last modifier rebase
 *   d     ({x, y}):    local pointer movement since that rebase
 *   edges (object):    {west, east, north, south} — edges the handle moves
 *   mods  (object):    {uniform, symmetric}
 *
 * Returns:
 *   number[4]: the new [x0, y0, x1, y1]
 *
 * @example resizedBox([0,0,100,50], {x:20,y:0}, {east:true}, {}) // [0, 0, 120, 50]
 * @example resizedBox([0,0,100,50], {x:20,y:0}, {east:true}, {symmetric:true}) // [-20, 0, 120, 50]
 * @example resizedBox([0,0,100,50], {x:100,y:0}, {east:true,south:true}, {uniform:true}) // [0, 0, 180, 90]
 * @example resizedBox([0,0,100,50], {x:-200,y:0}, {east:true}, {}) // [0, 0, 0, 50]
 */
export function resizedBox(base, d, edges, mods) {
  const [bx0, by0, bx1, by1] = base;
  const { gx, gy, fx, fy, cx, cy, xActive, yActive } = resizeAnchors(base, edges, mods);

  if (mods.uniform) {
    const ux = gx - fx, uy = gy - fy;
    const len2 = xActive && yActive ? ux * ux + uy * uy : xActive ? ux * ux : uy * uy;
    if (len2 > 0) {
      const K = Math.max(0, (xActive && yActive
        ? (gx + d.x - fx) * ux + (gy + d.y - fy) * uy
        : xActive ? (gx + d.x - fx) * ux : (gy + d.y - fy) * uy) / len2);
      const ax = xActive ? fx : cx, ay = yActive ? fy : cy;
      return [ax + K * (bx0 - ax), ay + K * (by0 - ay), ax + K * (bx1 - ax), ay + K * (by1 - ay)];
    }
    // Zero extent along the drive: no aspect to preserve — fall through.
  }

  let x0 = bx0, y0 = by0, x1 = bx1, y1 = by1;
  if (edges.east) x1 += d.x;
  if (edges.west) x0 += d.x;
  if (edges.south) y1 += d.y;
  if (edges.north) y0 += d.y;
  if (mods.symmetric) {
    // The opposite edge mirrors the moved one about the center.
    if (edges.east) x0 = 2 * cx - x1;
    if (edges.west) x1 = 2 * cx - x0;
    if (edges.south) y0 = 2 * cy - y1;
    if (edges.north) y1 = 2 * cy - y0;
  }
  if (x1 < x0) x0 = x1 = mods.symmetric ? cx : fx;
  if (y1 < y0) y0 = y1 = mods.symmetric ? cy : fy;
  return [x0, y0, x1, y1];
}

/**
 * Pure function. The EXACT new stored {x, y, w, h} for a bbox member whose whole
 * shape is scaled by PER-AXIS world factors (kx, ky) about world point (ax, ay).
 * ROTATION-AWARE — THE shared core of both the S-modal scale (kx == ky about the
 * collective center) and multi-resize-by-handles (per-axis about the collective
 * box's fixed anchor).
 *
 * The math works in the member's FOLDED world frame (`member.startWorld`, which
 * already includes the rotation pivot), never the stored base-frame x/y (those
 * differ for rotated items — the old approximation bug): scale the box's LOCAL
 * w/h by (kx, ky), move its WORLD CENTER about (ax, ay) per axis, rebuild the
 * target world transform (same rotation & scale, new size, new center), then
 * back-solve the stored x/y with stateXYForCenterPivotWorld — the exact inverse
 * of worldTransform's self-center pivot, so the committed item paints the scaled
 * pose byte-for-byte and keeps its clean center-pivot equation.
 *
 * For an UNROTATED member this is the identity back-solve, so new w = kx·w, new
 * x = ax + kx·(x − ax) — the plain proportional scale. For a rotated member,
 * kx/ky scale its LOCAL width/height by the world-axis factors (the no-shear,
 * PPT-consistent reading — a true world-axis non-uniform scale would shear a
 * rotated box, which the similarity-transform model forbids). When kx == ky
 * (uniform / Shift) the result IS exact under any rotation.
 *
 * @example // a rotation-0, scale-1 box at (10,20) size 100x50 scaled x2 about (0,0):
 * @example scaledBoxAboutPoint({startWorld: {x:10, y:20, rotation:0, scale:1}, startW:100, startH:50}, 2, 2, 0, 0) // {x: 20, y: 40, w: 200, h: 100}
 */
export function scaledBoxAboutPoint(member, kx, ky, ax, ay) {
  const W = member.startWorld, w = member.startW, h = member.startH;
  const kw = kx * w, kh = ky * h;
  const oldCenter = T.apply(W, w / 2, h / 2); // world center (pivot-folded)
  const ncx = ax + kx * (oldCenter.x - ax);
  const ncy = ay + ky * (oldCenter.y - ay);
  // Target world transform: same rotation & scale, new size, center at (ncx,ncy).
  // Its world TRANSLATION (local (0,0)) = center − R·s·(kw/2, kh/2).
  const cs = Math.cos(W.rotation), sn = Math.sin(W.rotation), s = W.scale;
  const target = {
    x: ncx - s * (cs * (kw / 2) - sn * (kh / 2)),
    y: ncy - s * (sn * (kw / 2) + cs * (kh / 2)),
    rotation: W.rotation,
    scale: W.scale,
  };
  const { x, y } = stateXYForCenterPivotWorld(target, kw, kh);
  return { x, y, w: kw, h: kh };
}

/**
 * Pure function. Preview pairs that scale one member by PER-AXIS world factors
 * (kx, ky) about world point (ax, ay). `touch` ({x, y} booleans) selects which
 * axes are written (a constrained modal or an edge-only resize leaves the
 * untouched axis alone), and of those, only the keys that actually CHANGED
 * (diffState) — so a single-axis scale on an unrotated member never clobbers
 * the still axis's stored equation. A bbox/transform widget scales its w/h AND
 * repositions its x/y — EXACTLY, including rotated / non-unit-scale members
 * (scaledBoxAboutPoint). A moveBy widget (arrow) scales each FREE numeric
 * endpoint about (ax, ay) per axis; equation-bound endpoints stay put. THE ONE
 * scale rule shared by the S-modal and multi-resize-by-handles.
 *
 * @example // a rect member {itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startW:100, startH:50} scaled x2 about (0,0):
 * @example scaleMemberPairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startW:100, startH:50}, 2, 2, 0, 0) // [[["items","r","x"],20],[["items","r","y"],40],[["items","r","w"],200],[["items","r","h"],100]]
 */
export function scaleMemberPairs(member, kx, ky, ax, ay, touch = { x: true, y: true }) {
  if (member.plugin.moveBy) {
    const s = member.rawItem ?? {};
    const pairs = [];
    for (const end of ["from", "to"])
      for (const coord of ["x", "y"]) {
        if (coord === "x" ? !touch.x : !touch.y) continue;
        const v = s[end]?.[coord];
        if (typeof v === "number") {
          const k = coord === "x" ? kx : ky;
          const a = coord === "x" ? ax : ay;
          pairs.push([["items", member.itemId, end, coord], a + k * (v - a)]);
        }
      }
    return pairs;
  }
  const rawItem = member.rawItem ?? {};
  const hasW = typeof rawItem.w === "number";
  const hasH = typeof rawItem.h === "number";
  const nb = scaledBoxAboutPoint(member, kx, ky, ax, ay);
  // Only the touched axes are candidates; of those, only the keys whose value
  // actually changed are written (diffState) — a single-axis multi-resize
  // (ky === 1 on an unrotated member) leaves that axis's stored equation intact.
  const keys = [];
  if (touch.x) keys.push("x");
  if (touch.y) keys.push("y");
  if (touch.x && hasW) keys.push("w");
  if (touch.y && hasH) keys.push("h");
  const start = { x: member.startX, y: member.startY, w: member.startW, h: member.startH };
  return itemGeometryPairs(member.itemId, diffState(start, nb, keys));
}

/**
 * Pure function. Preview pairs that scale one member by `factor` about world
 * center `c`, optionally constrained to one `axis` (the G/S modal's scale). Thin
 * adapter over scaleMemberPairs: a uniform factor on both axes about `c`, with
 * the constrained axis's factor pinned to 1 and its writes suppressed.
 *
 * @example scalePairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startW:100, startH:50}, 2, {x:0,y:0}) // [[["items","r","x"],20],[["items","r","y"],40],[["items","r","w"],200],[["items","r","h"],100]]
 */
export function scalePairs(member, factor, c, axis = null) {
  const doX = axis !== "y"; // x-axis constraint (or unconstrained) touches x/w
  const doY = axis !== "x"; // y-axis constraint (or unconstrained) touches y/h
  return scaleMemberPairs(member, doX ? factor : 1, doY ? factor : 1, c.x, c.y, { x: doX, y: doY });
}

/**
 * Pure function. The group's own {scale, x, y} for a handle resize (manifest
 * 15.7 GROUP RESIZE). A GROUP is an armature: its members follow its
 * {x, y, rotation, scale} SIMILARITY through core/derive.applyGroupParenting —
 * NOT its w/h (worldTransform never reads w/h into the transform; groupInfluence
 * is a pure {x,y,rotation,scale} delta-from-bind). So resizing a group must
 * drive the group's `scale` (which members inherit), never its w/h — writing
 * w/h alone is a no-op on members (the rough-draft bug this fixes).
 *
 * WHY UNIFORM-ONLY (the design fork, manifest-sanctioned "resize handles drive
 * group scale about the grab's opposite anchor"): the influence is a single
 * uniform `scale`. A per-axis (non-uniform) box resize has NO representation in
 * the similarity model — it would SHEAR members, which the transform contract
 * forbids (core/transform.js: "similarity ∘ similarity = similarity, never
 * shear"). So a group ALWAYS resizes uniformly; `resizedBox` is called with
 * `uniform` forced, so corner handles ride the diagonal and edge handles drive
 * one uniform K from their axis — the SAME resizedBox math single-item and
 * multi-resize already use, just with the modifier pinned on.
 *
 * The mapping (verified numerically — scratchpad group_resize_via_box/rot):
 *   K            = new local box width / old (uniform: equal on both axes)
 *   worldOrigin  = the resized box's local (0,0) mapped through the group's
 *                  START world transform — where the group's origin now sits
 *   scale        = startScale · K
 *   x, y         = back-solved (stateXYForCenterPivotWorld) so worldTransform
 *                  reproduces {worldOrigin, rotation, newScale} EXACTLY, keeping
 *                  the group's clean center-pivot equation (the SAME rotated-
 *                  resize inverse single-item resize uses at rotation != 0; at
 *                  rotation 0 it is the identity, so x/y = worldOrigin).
 * w/h are UNCHANGED — the visual hull is scale·w, so growing `scale` grows the
 * hull; touching w/h too would double-count K. Members scale about the grabbed
 * handle's FIXED opposite corner (resizeAnchors' fx/fy), which `resizedBox`
 * pins by construction — zero per-member writes, fully keyframable.
 *
 * Args:
 *   gState  — the group's start state ({x, y, w, h, rotation, scale, ...}).
 *   gWorld  — worldTransform(gState) (the rotation-pivoted start world).
 *   edges   — {west, east, north, south} the grabbed handle moves.
 *   mods    — {uniform, symmetric}; `uniform` is forced true internally, so
 *             only `symmetric` (Cmd — scale about the group CENTER) varies.
 *   dLocal  — pointer movement since the last modifier rebase, in the group's
 *             LOCAL frame (the same delta resizeDrag feeds resizedBox).
 *
 * Returns {scale, x, y} — the group's new own transform (w/h stay put).
 *
 * @example // BR corner grab, unrotated 200x100 group at (100,100) scale 1, drag +200/+100 local → scale 2 about the fixed top-left (100,100):
 * @example groupResizeState({x:100,y:100,w:200,h:100,rotation:0,scale:1}, {x:100,y:100,rotation:0,scale:1}, {east:true,south:true}, {}, {x:200,y:100}) // {scale: 2, x: 100, y: 100}
 */
export function groupResizeState(gState, gWorld, edges, mods, dLocal) {
  const box = resizedBox([0, 0, gState.w, gState.h], dLocal, edges, { ...mods, uniform: true });
  const K = gState.w > 1e-9 ? (box[2] - box[0]) / gState.w
    : gState.h > 1e-9 ? (box[3] - box[1]) / gState.h : 1;
  const newScale = (gState.scale ?? 1) * K;
  const worldOrigin = T.apply(gWorld, box[0], box[1]); // where local (0,0) lands
  const targetWorld = { x: worldOrigin.x, y: worldOrigin.y, rotation: gWorld.rotation, scale: newScale };
  const xy = stateXYForCenterPivotWorld(targetWorld, gState.w, gState.h);
  return { scale: newScale, x: xy.x, y: xy.y };
}

/**
 * Pure function. The world-space [x0, y0, x1, y1] box for a CROSSHAIR
 * CREATION drag (manifest 13.2 "CREATION-DRAG MODIFIERS"), point-anchored at
 * the drag's start (sx, sy) — as opposed to resizedBox's box-anchored resize,
 * which grabs a HANDLE on an existing box with a real opposite edge/corner.
 * A creation drag has no such box: any quadrant is a valid drag direction, so
 * this reads the SAME modifier semantics resizedBox documents (manifest
 * "Drag/resize modifiers — CONFIRMED mapping") but re-derives them for a
 * degenerate (zero-extent) base, where resizedBox's own uniform branch can't
 * find a driving axis to lock aspect against (verified: gx/gy/fx/fy all
 * collapse to the same start point, so its (gx−fx, gy−fy) drive vector is
 * zero — this is the reason a separate function exists rather than a call
 * into resizedBox with a collapsed base box).
 *
 *   uniform (Shift)   — BOTH dimensions get the SAME magnitude (the larger of
 *     |dx|, |dy| drives it), each keeping its own sign — a square/1:1-aspect
 *     box growing from the start point along the cursor's general direction
 *     (resize's "corner rides the diagonal through the anchor" reading, with
 *     the start point AS the anchor).
 *   symmetric (Cmd)   — the start point becomes the box CENTER: both edges on
 *     each axis move together, magnitude |dx|/|dy| each way (PowerPoint's
 *     Ctrl-resize precedent, identical interpretation to resizedBox's
 *     symmetric branch — there the anchor is forced to the box center; here
 *     the anchor (start point) simply IS the center already).
 * Composes exactly like resize: uniform+symmetric locks aspect AND centers.
 *
 * Args:
 *   sx, sy (number): the drag's start point (world).
 *   wx, wy (number): the live pointer position (world).
 *   mods   (object): {uniform, symmetric} — same shape as resizedBox's mods.
 *
 * Returns:
 *   number[4]: [x0, y0, x1, y1]
 *
 * @example creationRect(100, 100, 300, 50, {}) // [100, 50, 300, 100]
 * @example creationRect(100, 100, 50, 40, {}) // [50, 40, 100, 100]
 * @example creationRect(100, 100, 300, 130, { uniform: true }) // [100, 100, 300, 300]
 * @example creationRect(100, 100, 300, 150, { symmetric: true }) // [-100, 50, 300, 150]
 */
export function creationRect(sx, sy, wx, wy, mods) {
  let dx = wx - sx, dy = wy - sy;
  if (mods.uniform) {
    const k = Math.max(Math.abs(dx), Math.abs(dy));
    // Math.sign(0) is 0, which would zero out a still axis under uniform —
    // fall back to +1 (an arbitrary but harmless tie-break: a zero-delta axis
    // has no direction of its own to preserve).
    dx = (Math.sign(dx) || 1) * k;
    dy = (Math.sign(dy) || 1) * k;
  }
  if (mods.symmetric) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    return [sx - ax, sy - ay, sx + ax, sy + ay];
  }
  return [Math.min(sx, sx + dx), Math.min(sy, sy + dy), Math.max(sx, sx + dx), Math.max(sy, sy + dy)];
}

/**
 * Pure function. The {x, y} endpoint for a CROSSHAIR CREATION drag of an
 * ENDPOINT-kind widget (the arrow family: `placement === "endpoints"` —
 * manifest 13.2), point-anchored at the drag's start exactly like
 * creationRect, but for a single free point rather than a box (no aspect to
 * preserve, so Shift is a plain AXIS LOCK — the same interpretation
 * moveDrag's shift-drag already uses for a moveBy widget with no bbox probe
 * features, snapping the point onto the horizontal/vertical through the
 * start) instead of resize's uniform-scale reading, which needs two
 * dimensions to relate.
 *
 *   uniform (Shift)   — axis-locks the live point to the horizontal or
 *     vertical THROUGH THE START (bigger |dx| vs |dy| decides — same
 *     dominant-axis rule as core/snap.js axisLock's first-frame case; no
 *     hysteresis here since the caller re-derives from raw pointer state on
 *     every move rather than tracking a "locked so far" axis).
 *   symmetric (Cmd)   — the start point becomes the segment's MIDPOINT: the
 *     other end mirrors the live point through it, so the shape grows both
 *     directions (PowerPoint's Ctrl-resize precedent, same interpretation as
 *     creationRect's symmetric branch).
 * Composes exactly like creationRect: uniform+symmetric axis-locks AND mirrors.
 *
 * Returns: {from: {x, y}, to: {x, y}} — the placed widget's two endpoints.
 *
 * @example creationEndpoint(100, 100, 300, 130, {}) // {from: {x: 100, y: 100}, to: {x: 300, y: 130}}
 * @example creationEndpoint(100, 100, 300, 130, { uniform: true }) // {from: {x: 100, y: 100}, to: {x: 300, y: 100}}
 * @example creationEndpoint(100, 100, 300, 130, { symmetric: true }) // {from: {x: -100, y: 70}, to: {x: 300, y: 130}}
 */
export function creationEndpoint(sx, sy, wx, wy, mods) {
  let dx = wx - sx, dy = wy - sy;
  if (mods.uniform) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0;
  }
  const to = { x: sx + dx, y: sy + dy };
  const from = mods.symmetric ? { x: sx - dx, y: sy - dy } : { x: sx, y: sy };
  return { from, to };
}
