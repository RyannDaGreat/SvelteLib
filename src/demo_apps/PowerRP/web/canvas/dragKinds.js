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

/**
 * Pure function. The path/value preview pairs that translate one member by a
 * world delta (dx, dy) — the ONE translation rule shared by DRAG-ALL body drags
 * and the modal grab. A moveBy widget (arrow) translates only its FREE numeric
 * coordinates via its plugin hook (bound endpoints stay anchored); a
 * bbox/transform widget writes plain numeric x/y (direct manipulation replaces
 * any equation on x/y outright — the established body-drag rule).
 *
 * @example // translationPairs({itemId: "r", plugin: {}, startX: 10, startY: 20}, 5, 3)
 * //   → [[["items","r","x"], 15], [["items","r","y"], 23]]
 */
export function translationPairs(member, dx, dy) {
  if (member.plugin.moveBy)
    return member.plugin.moveBy(member.rawItem, dx, dy)
      .map(([p, v]) => [["items", member.itemId, ...p], v]);
  return [
    [["items", member.itemId, "x"], member.startX + dx],
    [["items", member.itemId, "y"], member.startY + dy],
  ];
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
 * untouched axis alone). A bbox/transform widget scales its w/h AND repositions
 * its x/y — EXACTLY, including rotated / non-unit-scale members
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
  const pairs = [];
  if (touch.x) pairs.push([["items", member.itemId, "x"], nb.x]);
  if (touch.y) pairs.push([["items", member.itemId, "y"], nb.y]);
  if (touch.x && hasW) pairs.push([["items", member.itemId, "w"], nb.w]);
  if (touch.y && hasH) pairs.push([["items", member.itemId, "h"], nb.h]);
  return pairs;
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
