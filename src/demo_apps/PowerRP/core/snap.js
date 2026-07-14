/**
 * The generic snap protocol.
 *
 * Widgets never know about each other: plugins emit FEATURES (world-space
 * points and infinite lines, via derive.nodeFeatures), the dragged widget
 * emits PROBES (its own features), and this pure solver finds the best
 * correction. One protocol serves drag-snapping, anchors, and alignment
 * guides. Guides render through geometry.clipLineToRect — always infinite.
 */

import { dist2 } from "./geometry.js";

/**
 * Pure function. Solves snapping for a drag.
 *
 * Args:
 *   probes   — world-space features of the dragged thing, ALREADY at the
 *              proposed (post-drag) position. Points only (V1 probes).
 *   features — world-space features of every OTHER node (points + lines).
 *   tol      — snap distance in WORLD units (screen px / zoom).
 *
 * Returns {dx, dy, guides}: the correction to add to the proposed position,
 * and guide descriptors to render:
 *   {kind:"point", x, y} or {kind:"line", x, y, dx, dy}.
 *
 * X and Y solve independently for line features (align-to-edge), jointly for
 * point features (corner-to-corner beats two separate line snaps).
 *
 * @example
 * // A probe 3px left of a vertical line at x=100 snaps onto it:
 * // solveSnap([{kind:"point",x:97,y:50,id:"p"}],
 * //           [{kind:"line",x:100,y:0,dx:0,dy:1,id:"e"}], 5)
 * // → {dx: 3, dy: 0, guides: [{kind:"line",...}]}
 */
export function solveSnap(probes, features, tol) {
  let best = { dx: 0, dy: 0, guides: [] };
  let bestPoint = null; // {d2, dx, dy, feature}
  let bestX = null, bestY = null; // {d, correction, feature}

  for (const probe of probes) {
    for (const f of features) {
      if (f.kind === "point") {
        const d2 = dist2(probe.x, probe.y, f.x, f.y);
        if (d2 <= tol * tol && (!bestPoint || d2 < bestPoint.d2))
          bestPoint = { d2, dx: f.x - probe.x, dy: f.y - probe.y, feature: f };
      } else if (f.kind === "line") {
        // Signed distance from probe to the infinite line.
        const len = Math.hypot(f.dx, f.dy);
        if (len === 0) continue;
        const nx = -f.dy / len, ny = f.dx / len; // unit normal
        const dist = (probe.x - f.x) * nx + (probe.y - f.y) * ny;
        if (Math.abs(dist) > tol) continue;
        // Split the correction into x/y so axis-ish lines align that axis.
        const cx = -dist * nx, cy = -dist * ny;
        if (Math.abs(nx) > 1e-9 && (!bestX || Math.abs(dist) < bestX.d))
          bestX = { d: Math.abs(dist), correction: cx, feature: f };
        if (Math.abs(ny) > 1e-9 && (!bestY || Math.abs(dist) < bestY.d))
          bestY = { d: Math.abs(dist), correction: cy, feature: f };
      }
    }
  }

  if (bestPoint) {
    // A point snap wins outright — it pins both axes coherently.
    return {
      dx: bestPoint.dx,
      dy: bestPoint.dy,
      guides: [{ kind: "point", x: bestPoint.feature.x, y: bestPoint.feature.y }],
    };
  }
  if (bestX) best.dx = bestX.correction;
  if (bestY) best.dy = bestY.correction;

  // "Snap to BOTH" (manifest): one deterministic correction, then EVERY line
  // that the corrected probes land on becomes a guide — top+bottom+middle
  // light up together instead of flickering between winners. EPS is float
  // slack only: aligned distances are ~0 after correction, misaligned ones
  // are real world-unit gaps.
  if (bestX || bestY) {
    const EPS = 1e-6;
    const seen = new Set();
    for (const f of features) {
      if (f.kind !== "line" || seen.has(f.id)) continue;
      const len = Math.hypot(f.dx, f.dy);
      if (len === 0) continue;
      const nx = -f.dy / len, ny = f.dx / len;
      for (const probe of probes) {
        const dist = (probe.x + best.dx - f.x) * nx + (probe.y + best.dy - f.y) * ny;
        if (Math.abs(dist) < EPS) {
          best.guides.push({ kind: "line", ...pickLine(f) });
          seen.add(f.id);
          break;
        }
      }
    }
  }
  return best;
}

/** Pure function. Extracts the line fields of a feature for a guide descriptor. */
function pickLine(f) {
  return { x: f.x, y: f.y, dx: f.dx, dy: f.dy };
}

/**
 * Pure function. Shift-drag axis lock with hysteresis — the fix for
 * Pixel-Aligner's per-frame |dx|>|dy| flip-flop near 45°.
 *
 * Args:
 *   dx, dy    — cumulative drag vector (world units).
 *   prevAxis  — "x" | "y" | null (the currently locked axis).
 *   bias      — how dominant the OTHER axis must be to steal the lock (>1).
 *
 * Returns "x" or "y".
 *
 * @example axisLock(10, 2, null) // "x"
 * @example axisLock(10, 12, "x") // "x" (12 < 10*1.5 — keeps lock)
 * @example axisLock(10, 20, "x") // "y" (clearly dominant — steals lock)
 */
export function axisLock(dx, dy, prevAxis, bias = 1.5) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (prevAxis === "x") return ay > ax * bias ? "y" : "x";
  if (prevAxis === "y") return ax > ay * bias ? "x" : "y";
  return ax >= ay ? "x" : "y";
}
