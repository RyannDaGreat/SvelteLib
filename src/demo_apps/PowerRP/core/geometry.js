/**
 * Pure 2D geometry helpers. Notably the infinite-guide-line clipper: guides
 * are represented as true infinite lines (point + direction) and clipped
 * analytically against the viewport AABB — the fix for Pixel-Aligner's
 * window.innerWidth-bounded guides that "didn't always go infinitely".
 */

/**
 * Pure function. Clips the infinite line through (px,py) with direction
 * (dx,dy) against an axis-aligned rect. Returns [x1,y1,x2,y2] endpoints of
 * the visible segment, or null if the line misses the rect. (Liang-Barsky.)
 *
 * @example clipLineToRect(5, 5, 1, 0, {x: 0, y: 0, w: 10, h: 10}) // [0, 5, 10, 5]
 * @example clipLineToRect(5, 5, 0, 1, {x: 0, y: 0, w: 10, h: 10}) // [5, 0, 5, 10]
 * @example clipLineToRect(50, 50, 1, 0, {x: 0, y: 0, w: 10, h: 10}) // null
 */
export function clipLineToRect(px, py, dx, dy, rect) {
  let t0 = -Infinity, t1 = Infinity;
  const checks = [
    [-dx, px - rect.x],
    [dx, rect.x + rect.w - px],
    [-dy, py - rect.y],
    [dy, rect.y + rect.h - py],
  ];
  for (const [denom, dist] of checks) {
    if (denom === 0) {
      if (dist < 0) return null; // parallel and outside
    } else {
      const t = dist / denom;
      if (denom < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
  }
  return [px + dx * t0, py + dy * t0, px + dx * t1, py + dy * t1];
}

/**
 * Pure function. Squared distance between two points.
 *
 * @example dist2(0, 0, 3, 4) // 25
 */
export function dist2(x1, y1, x2, y2) {
  return (x2 - x1) ** 2 + (y2 - y1) ** 2;
}

/**
 * Pure function. Closest point on rect border to an outside point — the
 * "closest" computed anchor for bbox widgets. Clamps to border.
 *
 * @example closestPointOnRectBorder({x: 0, y: 0, w: 10, h: 10}, 25, 5) // {x: 10, y: 5}
 * @example closestPointOnRectBorder({x: 0, y: 0, w: 10, h: 10}, 5, -8) // {x: 5, y: 0}
 */
export function closestPointOnRectBorder(rect, px, py) {
  const cx = Math.max(rect.x, Math.min(px, rect.x + rect.w));
  const cy = Math.max(rect.y, Math.min(py, rect.y + rect.h));
  if (cx > rect.x && cx < rect.x + rect.w && cy > rect.y && cy < rect.y + rect.h) {
    // Inside: project to nearest edge.
    const dl = cx - rect.x, dr = rect.x + rect.w - cx, dt = cy - rect.y, db = rect.y + rect.h - cy;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { x: rect.x, y: cy };
    if (m === dr) return { x: rect.x + rect.w, y: cy };
    if (m === dt) return { x: cx, y: rect.y };
    return { x: cx, y: rect.y + rect.h };
  }
  return { x: cx, y: cy };
}

/**
 * Pure function. Border-band ("hollow bbox") hit test: is LOCAL point (lx, ly)
 * within a `s.w`×`s.h` rect's OUTER edge (padded by `tol`) but OUTSIDE its INNER
 * edge (inset by `tol`) — i.e. within `tol` of the border, not deep in the
 * interior? The shared "click the outline, not the fill" test for volume-less
 * framing widgets (camera, group) whose interior clicks fall through to the
 * content underneath. Missing w/h default to 0 (a zero-size frame is all
 * border), so a caller that always has w/h is unaffected.
 *
 * @example borderBandHit({w: 100, h: 100}, 3, 50, 6) // true (near the left edge)
 * @example borderBandHit({w: 100, h: 100}, 50, 50, 6) // false (deep interior)
 * @example borderBandHit({w: 100, h: 100}, -3, 50, 6) // true (just outside the edge, within tol)
 */
export function borderBandHit(s, lx, ly, tol) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const inOuter = lx >= -tol && lx <= w + tol && ly >= -tol && ly <= h + tol;
  const inInner = lx >= tol && lx <= w - tol && ly >= tol && ly <= h - tol;
  return inOuter && !inInner;
}

/**
 * Pure function. The union AABB {x, y, w, h} of a list of rects. Used to find
 * a multi-selection's collective extreme edges/center — the shared basis for
 * BOTH align (extreme-edge match) and mirror (reflect about center).
 *
 * @example unionRect([{x: 0, y: 0, w: 10, h: 10}, {x: 20, y: 5, w: 10, h: 10}]) // {x: 0, y: 0, w: 30, h: 15}
 * @example unionRect([{x: 5, y: 5, w: 10, h: 10}]) // {x: 5, y: 5, w: 10, h: 10}
 */
export function unionRect(rects) {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Pure function. The target top-left `x` (or `y`, by passing h/height in
 * place of w/width) that makes a box of size `size` share the given `edge`
 * of a selection's union AABB span `[lo, hi]` (lo = union.x, hi = union.x+w
 * for horizontal; lo = union.y, hi = union.y+h for vertical). `edge` is one
 * of "min" (left/top), "max" (right/bottom), "center" (centered in the span).
 * THE one-axis primitive both alignLeft/Right/Top/Bottom and
 * alignCenterHorizontal/Vertical reduce to — see `alignedPosition` for the
 * per-command wrapper.
 *
 * @example alignedCoord(10, 40, 20, "min") // 10 (left/top edge matches lo)
 * @example alignedCoord(10, 40, 20, "max") // 20 (right/bottom edge matches hi: 40 - 20)
 * @example alignedCoord(0, 30, 10, "center") // 10 (centered: (0+30)/2 - 10/2)
 */
export function alignedCoord(lo, hi, size, edge) {
  if (edge === "min") return lo;
  if (edge === "max") return hi - size;
  return (lo + hi) / 2 - size / 2; // "center"
}

/**
 * Pure function. Target {x, y} for one bbox item aligning to a selection's
 * union AABB, given which edge to align on which axis. `axis` is "x" or "y"
 * (which coordinate moves); `edge` is "min"|"max"|"center" (see
 * alignedCoord). The untouched axis passes through unchanged — align-left
 * only ever moves x, never y.
 *
 * @example alignedPosition({x: 5, y: 5, w: 10, h: 10}, {x: 0, y: 0, w: 100, h: 50}, "x", "min") // {x: 0, y: 5}
 * @example alignedPosition({x: 5, y: 5, w: 10, h: 10}, {x: 0, y: 0, w: 100, h: 50}, "x", "max") // {x: 90, y: 5}
 * @example alignedPosition({x: 5, y: 5, w: 10, h: 10}, {x: 0, y: 0, w: 100, h: 50}, "y", "center") // {x: 5, y: 20}
 */
export function alignedPosition(box, union, axis, edge) {
  if (axis === "x") return { x: alignedCoord(union.x, union.x + union.w, box.w, edge), y: box.y };
  return { x: box.x, y: alignedCoord(union.y, union.y + union.h, box.h, edge) };
}

/**
 * Pure function. Target {x, y} for one bbox item's LAYOUT MIRROR: reflects
 * the box's POSITION about the selection union AABB's center axis, keeping
 * its w/h (and thus its own content) untouched — items swap sides but are
 * not themselves flipped. This is the layout-only mirror (see the module
 * docstring for why): PowerRP's transform is a similarity {x,y,rotation,
 * scale} with a single scalar scale, so a true per-item content flip
 * (negative axis scale) isn't representable without extending the model.
 * `axis` "x" reflects horizontally (mirror-left-right, flips x positions);
 * "y" reflects vertically (mirror-up-down, flips y positions).
 *
 * @example mirroredPosition({x: 0, y: 5, w: 10, h: 10}, {x: 0, y: 0, w: 100, h: 50}, "x") // {x: 90, y: 5}
 * @example mirroredPosition({x: 45, y: 5, w: 10, h: 10}, {x: 0, y: 0, w: 100, h: 50}, "x") // {x: 45, y: 5} (centered item stays put)
 * @example mirroredPosition({x: 5, y: 0, w: 10, h: 10}, {x: 0, y: 0, w: 100, h: 50}, "y") // {x: 5, y: 40}
 */
export function mirroredPosition(box, union, axis) {
  if (axis === "x") {
    const mirroredCenter = 2 * (union.x + union.w / 2) - (box.x + box.w / 2);
    return { x: mirroredCenter - box.w / 2, y: box.y };
  }
  const mirroredCenter = 2 * (union.y + union.h / 2) - (box.y + box.h / 2);
  return { x: box.x, y: mirroredCenter - box.h / 2 };
}
