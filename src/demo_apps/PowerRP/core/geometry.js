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
 * Pure function. Is point inside rect {x,y,w,h}?
 *
 * @example pointInRect(5, 5, {x: 0, y: 0, w: 10, h: 10}) // true
 * @example pointInRect(15, 5, {x: 0, y: 0, w: 10, h: 10}) // false
 */
export function pointInRect(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

/**
 * Pure function. Closest point on a circle's perimeter to an outside point —
 * the arrow's "closest" computed anchor on circles. Degenerate (point at
 * center) returns the rightmost perimeter point.
 *
 * @example closestPointOnCircle(0, 0, 10, 20, 0) // {x: 10, y: 0}
 * @example closestPointOnCircle(0, 0, 5, 0, -20) // {x: 0, y: -5}
 */
export function closestPointOnCircle(cx, cy, r, px, py) {
  const dx = px - cx, dy = py - cy;
  const d = Math.hypot(dx, dy);
  if (d === 0) return { x: cx + r, y: cy };
  return { x: cx + (dx / d) * r, y: cy + (dy / d) * r };
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
