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
 * Floating-point slack, in world units. After a snap correction, an aligned
 * distance is ~0 (real gaps are whole world-units), and a line's off-axis
 * direction component is ~0 relative to its length — this tolerance separates
 * "numerically zero" from a genuine miss. ONE value the whole solver shares
 * (was re-declared as a local `EPS = 1e-6` in solveSnap / solveEdgeSnap /
 * anchorSnapEquation — same number, same "float slack only" rationale).
 */
const SNAP_EPS = 1e-6;

/**
 * Shift-drag axis-lock hysteresis: how many times more dominant the OTHER axis
 * must be before it steals the lock from the currently-locked one (>1 means the
 * held axis is "sticky"). 1.5 = the other axis must be 50% larger to flip — big
 * enough to kill the per-frame flip-flop near 45° (the Pixel-Aligner bug
 * axisLock fixes) without feeling sluggish. Default for axisLock's `bias` arg.
 */
const AXIS_LOCK_HYSTERESIS = 1.5;

/**
 * Pure function. Parses a node-feature id ("<itemId>:<featureId>" — see
 * derive.nodeFeatures) into PROVENANCE: which item and which named
 * point/edge produced a snap correction (manifest ARCHITECTURE PLAN #4:
 * "The snap solver's results gain PROVENANCE"). itemId never contains ":"
 * (opaque ids from document.js), so the FIRST colon is the split point —
 * featureId itself may be a plugin-declared id containing anything else.
 * axis classifies the standard point/edge names for the anchor-snap release
 * logic (CanvasView): "tl"/"tr"/"bl"/"br"/"cm" are joint (both axes), "tm"/
 * "bm"/"top"/"bottom"/"hcenter" are y-only, "ml"/"mr"/"left"/"right"/
 * "vcenter" are x-only. Plugin-declared extras (snapFeatures) default to
 * "both" — a plugin may not follow the standard bbox naming, and "both" is
 * the conservative choice (never wrongly narrows which coordinate an
 * equation should track).
 *
 * @example snapProvenance("ab12cd34:tm") // {sourceItemId: "ab12cd34", sourceAnchorId: "tm", axis: "y"}
 * @example snapProvenance("ab12cd34:right") // {sourceItemId: "ab12cd34", sourceAnchorId: "right", axis: "x"}
 * @example snapProvenance("ab12cd34:cm") // {sourceItemId: "ab12cd34", sourceAnchorId: "cm", axis: "both"}
 */
export function snapProvenance(featureId) {
  const i = featureId.indexOf(":");
  const sourceItemId = i === -1 ? featureId : featureId.slice(0, i);
  const sourceAnchorId = i === -1 ? null : featureId.slice(i + 1);
  const Y_ONLY = new Set(["tm", "bm", "top", "bottom", "hcenter"]);
  const X_ONLY = new Set(["ml", "mr", "left", "right", "vcenter"]);
  const axis = Y_ONLY.has(sourceAnchorId) ? "y" : X_ONLY.has(sourceAnchorId) ? "x" : "both";
  return { sourceItemId, sourceAnchorId, axis };
}

/**
 * Pure function. Maps a snap-provenance `sourceAnchorId` to the CANONICAL
 * PRESET ANCHOR id an equation can actually reference (manifest ARCHITECTURE
 * PLAN #4: "write the EQUATION referencing the provenance anchor" —
 * expressions.js only resolves `@id_<anchorId>.x|y` against
 * `plugin.anchors(state)`, which are the 9 standard bbox points; the four
 * EDGE-LINE feature ids ("top"/"bottom"/"left"/"right") and the two CENTER-
 * LINE ids ("hcenter"/"vcenter") are snap/guide-only names with no anchor of
 * their own, so a resize edge snap needs a representative point anchor that
 * lies on the same line). The 9 standard point ids pass through unchanged
 * (already valid anchor ids — a move point-snap never needs this mapping).
 * Non-standard ids (a plugin's own snapFeatures extra) return null — the
 * caller falls back to a plain numeric commit rather than guessing.
 *
 * @example provenanceAnchorId("right") // "mr"
 * @example provenanceAnchorId("hcenter") // "cm"
 * @example provenanceAnchorId("tm") // "tm" (already a preset anchor)
 * @example provenanceAnchorId("some_plugin_extra") // null
 */
export function provenanceAnchorId(sourceAnchorId) {
  const EDGE_TO_ANCHOR = {
    top: "tm", bottom: "bm", left: "ml", right: "mr", hcenter: "cm", vcenter: "cm",
    tl: "tl", tm: "tm", tr: "tr", ml: "ml", cm: "cm", mr: "mr", bl: "bl", bm: "bm", br: "br",
  };
  return EDGE_TO_ANCHOR[sourceAnchorId] ?? null;
}

/**
 * Pure function. Solves snapping for a drag.
 *
 * Args:
 *   probes   — world-space features of the dragged thing, ALREADY at the
 *              proposed (post-drag) position. Points only (V1 probes).
 *   features — world-space features of every OTHER node (points + lines).
 *   tol      — snap distance in WORLD units (screen px / zoom).
 *
 * Returns {dx, dy, guides, provenance}: the correction to add to the
 * proposed position, guide descriptors to render:
 *   {kind:"point", x, y} or {kind:"line", x, y, dx, dy},
 * and PROVENANCE (manifest ARCHITECTURE PLAN #4) — pure data, no behavior
 * change: which source feature(s) produced the correction, one entry per
 * axis actually applied — [{sourceItemId, sourceAnchorId, axis}]. A point
 * snap yields ONE "both"-axis entry (it pins x and y together); a line snap
 * yields up to two entries (one per axis, from the winning line on that
 * axis — "snap to BOTH" may light up several guides, but only the WINNING
 * line per axis is the equation-write source). Empty when no correction
 * applied (dx === 0 && dy === 0).
 *
 * X and Y solve independently for line features (align-to-edge), jointly for
 * point features (corner-to-corner beats two separate line snaps).
 *
 * @example
 * // A probe 3px left of a vertical line at x=100 snaps onto it:
 * // solveSnap([{kind:"point",x:97,y:50,id:"p"}],
 * //           [{kind:"line",x:100,y:0,dx:0,dy:1,id:"e:right"}], 5)
 * // → {dx: 3, dy: 0, guides: [{kind:"line",...}], provenance: [{sourceItemId:"e",sourceAnchorId:"right",axis:"x"}]}
 */
export function solveSnap(probes, features, tol) {
  let best = { dx: 0, dy: 0, guides: [], provenance: [] };
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
    const prov = snapProvenance(bestPoint.feature.id);
    return {
      dx: bestPoint.dx,
      dy: bestPoint.dy,
      guides: [{ kind: "point", x: bestPoint.feature.x, y: bestPoint.feature.y }],
      provenance: [{ ...prov, axis: "both" }],
    };
  }
  if (bestX) { best.dx = bestX.correction; best.provenance.push({ ...snapProvenance(bestX.feature.id), axis: "x" }); }
  if (bestY) { best.dy = bestY.correction; best.provenance.push({ ...snapProvenance(bestY.feature.id), axis: "y" }); }

  // "Snap to BOTH" (manifest): one deterministic correction, then EVERY line
  // that the corrected probes land on becomes a guide — top+bottom+middle
  // light up together instead of flickering between winners. SNAP_EPS is float
  // slack only: aligned distances are ~0 after correction, misaligned ones
  // are real world-unit gaps.
  if (bestX || bestY) {
    const seen = new Set();
    for (const f of features) {
      if (f.kind !== "line" || seen.has(f.id)) continue;
      const len = Math.hypot(f.dx, f.dy);
      if (len === 0) continue;
      const nx = -f.dy / len, ny = f.dx / len;
      for (const probe of probes) {
        const dist = (probe.x + best.dx - f.x) * nx + (probe.y + best.dy - f.y) * ny;
        if (Math.abs(dist) < SNAP_EPS) {
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
 * Pure function. 1D snap for a resize drag: the moving EDGES of a box snap to
 * other nodes' infinite line features. Where solveSnap corrects a whole
 * dragged item (point + line probes), this corrects an axis-aligned resize —
 * each moving edge is a single coordinate on one axis, snapping only to lines
 * perpendicular to it (a vertical left/right edge snaps in x to vertical
 * lines; a horizontal top/bottom edge snaps in y to horizontal lines).
 *
 * Rotated boxes are NOT axis-aligned, so the caller skips this for them —
 * edge-as-single-coordinate has no meaning under rotation (documented in
 * CanvasView.resizeDrag).
 *
 * Args:
 *   edges    — moving edges: [{axis: "x"|"y", pos}] in WORLD units.
 *   features — world-space line features of every OTHER node (from
 *              derive.nodeFeatures); non-line features are ignored.
 *   tol      — snap distance in WORLD units (screen px / zoom).
 *
 * Returns {dx, dy, guides, provenance}: the world-space correction to add to
 * the moving edge coordinates (dx for x-axis edges, dy for y-axis edges), the
 * guide descriptors that ended up aligned, and PROVENANCE (manifest
 * ARCHITECTURE PLAN #4) — [{sourceItemId, sourceAnchorId, axis}], one entry
 * per axis whose edge actually snapped (the WINNING line on that axis — the
 * equation-write source for the anchor-snap release). Like solveSnap, once a
 * correction is chosen EVERY line the corrected edges land on becomes a
 * guide ("snap to BOTH" — top+bottom+middle light up together instead of
 * flickering). SNAP_EPS is float slack only: aligned distances are ~0 after
 * correction.
 *
 * @example
 * // A right edge 3px left of a vertical line at x=100 snaps onto it:
 * // solveEdgeSnap([{axis:"x",pos:97}],
 * //               [{kind:"line",x:100,y:0,dx:0,dy:1,id:"e:right"}], 5)
 * // → {dx: 3, dy: 0, guides: [{kind:"line",x:100,y:0,dx:0,dy:1}], provenance: [{sourceItemId:"e",sourceAnchorId:"right",axis:"x"}]}
 * @example
 * // Out of tolerance → no correction, no guides, no provenance:
 * // solveEdgeSnap([{axis:"x",pos:80}],
 * //               [{kind:"line",x:100,y:0,dx:0,dy:1,id:"e:right"}], 5)
 * // → {dx: 0, dy: 0, guides: [], provenance: []}
 */
export function solveEdgeSnap(edges, features, tol) {
  const best = { dx: 0, dy: 0, guides: [], provenance: [] };
  let bestX = null, bestY = null; // {d, correction, feature}

  for (const edge of edges) {
    for (const f of features) {
      if (f.kind !== "line") continue;
      const len = Math.hypot(f.dx, f.dy);
      if (len === 0) continue;
      // A line is "vertical" when its direction has ~no x-component (its
      // constant coordinate is x); "horizontal" when ~no y-component.
      const vertical = Math.abs(f.dx) < SNAP_EPS * len;
      const horizontal = Math.abs(f.dy) < SNAP_EPS * len;
      if (edge.axis === "x" && vertical) {
        const d = f.x - edge.pos;
        if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < bestX.d))
          bestX = { d: Math.abs(d), correction: d, feature: f };
      } else if (edge.axis === "y" && horizontal) {
        const d = f.y - edge.pos;
        if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < bestY.d))
          bestY = { d: Math.abs(d), correction: d, feature: f };
      }
    }
  }
  if (bestX) { best.dx = bestX.correction; best.provenance.push({ ...snapProvenance(bestX.feature.id), axis: "x" }); }
  if (bestY) { best.dy = bestY.correction; best.provenance.push({ ...snapProvenance(bestY.feature.id), axis: "y" }); }

  if (bestX || bestY) {
    const seen = new Set();
    for (const f of features) {
      if (f.kind !== "line" || seen.has(f.id)) continue;
      const len = Math.hypot(f.dx, f.dy);
      if (len === 0) continue;
      const vertical = Math.abs(f.dx) < SNAP_EPS * len;
      const horizontal = Math.abs(f.dy) < SNAP_EPS * len;
      for (const edge of edges) {
        const corrected = edge.pos + (edge.axis === "x" ? best.dx : best.dy);
        const dist = edge.axis === "x" && vertical ? corrected - f.x
          : edge.axis === "y" && horizontal ? corrected - f.y : Infinity;
        if (Math.abs(dist) < SNAP_EPS) {
          best.guides.push({ kind: "line", ...pickLine(f) });
          seen.add(f.id);
          break;
        }
      }
    }
  }
  return best;
}

/**
 * Pure function. Which candidate items' dimension MATCHES a given size, within
 * tolerance (the Figma-style matching-dimension indicator query). Snap-size
 * uses this: while resizing, an in-progress width that lands within `tol` of
 * another visible item's width snaps EXACTLY to it and both get a two-way
 * arrow. A single deterministic target (the nearest, then lowest-id) supplies
 * the exact snapped value; all items sharing that value are returned so every
 * match is indicated.
 *
 * Args:
 *   size       — the in-progress dimension (world units).
 *   candidates — [{id, size}] other visible items' same-axis dimension.
 *   tol        — match tolerance in WORLD units (screen px / zoom) — the SAME
 *                tolerance move/resize snapping uses (no new constant).
 *
 * Returns {value, ids} when a match exists (value = the exact size to snap to;
 * ids = every candidate equal to it), else null.
 *
 * @example
 * // Width 178 near a candidate of 180 (tol 5) snaps to 180; two items share it:
 * // sizeMatches(178, [{id:"a",size:180},{id:"b",size:180},{id:"c",size:90}], 5)
 * // → {value: 180, ids: ["a", "b"]}
 * @example
 * // Nothing within tolerance:
 * // sizeMatches(150, [{id:"a",size:180}], 5) // → null
 */
export function sizeMatches(size, candidates, tol) {
  let best = null; // {d, value}
  for (const c of candidates) {
    const d = Math.abs(c.size - size);
    if (d <= tol && (!best || d < best.d || (d === best.d && c.size < best.value)))
      best = { d, value: c.size };
  }
  if (!best) return null;
  const ids = candidates.filter((c) => c.size === best.value).map((c) => c.id);
  return { value: best.value, ids };
}

/**
 * Pure function. The STORED equation string for an ANCHOR SNAP release
 * (manifest ARCHITECTURE PLAN #4): "@id_anchor.x form via the expressions
 * API [+ numeric offset when the correction wasn't exact-point]". Compares
 * `finalValue` (what the plain numeric commit would have written) against
 * `anchorValue` (the source anchor's CURRENT evaluated coordinate on `coord`)
 * and emits the bare reference when they coincide (within float slack — an
 * exact-point snap, e.g. dragging one item's own top-left onto another's),
 * else appends a signed offset so the equation reproduces `finalValue`
 * exactly. The offset direction matters for readability only (both "+ -3"
 * and "- 3" evaluate identically); this always emits the shorter, natural
 * "-" form for a negative offset.
 *
 * @example anchorSnapEquation("ab12cd34", "mr", "x", 150, 150) // "@ab12cd34_mr.x"
 * @example anchorSnapEquation("ab12cd34", "mr", "x", 158, 150) // "@ab12cd34_mr.x + 8"
 * @example anchorSnapEquation("ab12cd34", "tm", "y", 142, 150) // "@ab12cd34_tm.y - 8"
 */
export function anchorSnapEquation(sourceItemId, anchorId, coord, finalValue, anchorValue) {
  const ref = `@${sourceItemId}_${anchorId}.${coord}`;
  const offset = finalValue - anchorValue;
  if (Math.abs(offset) < SNAP_EPS) return ref;
  return offset > 0 ? `${ref} + ${offset}` : `${ref} - ${-offset}`;
}

/**
 * Pure function. The STORED equation for a RESIZE EDGE anchor-snap release
 * (manifest ARCHITECTURE PLAN #4: "the snapped edge writes the stretching
 * equation — edge tracks the target"). The MOVING edge's world coordinate is
 * `worldFixed + sign * scale * size` (worldTransform at rotation 0 — resize
 * edge snapping is already gated to unrotated items in CanvasView, so this
 * is exact, not an approximation); solving `= anchorRef` for `size` gives:
 *   size = sign * (anchorRef − worldFixed) / scale
 * `sign` is +1 for an east/south (max-side) edge, −1 for a west/north
 * (min-side) edge — the SAME edge convention CanvasView.resizeDrag already
 * uses (`drag.east`/`drag.west` etc.). `scale === 1` (the overwhelmingly
 * common case — resize never itself changes `scale`) emits the simpler
 * division-free form; a non-1 scale (the item was previously S-modal-scaled)
 * divides through explicitly via `self.scale` so the equation stays exact.
 *
 * Args:
 *   sourceItemId, anchorId, coord — the provenance anchor (coord: "x"|"y").
 *   sign     — +1 (east/south moving edge) | −1 (west/north moving edge).
 *   worldFixed — the world coordinate of the FIXED opposite edge (its
 *                current numeric value — never itself rewritten).
 *   scale    — the resized item's world.scale (drag.world.scale).
 *
 * Returns the stored equation string for the size property (`w` or `h`).
 *
 * @example
 * // East edge (sign +1) snapped to x=300; fixed left edge at world x=100, scale 1:
 * // resizeEdgeEquation("ab12cd34", "mr", "x", 1, 100, 1) // "@ab12cd34_mr.x - self.x"
 * @example
 * // West edge (sign -1) snapped to x=50; fixed right edge at world x=300, scale 2:
 * // resizeEdgeEquation("ab12cd34", "ml", "x", -1, 300, 2) // "(300 - @ab12cd34_ml.x) / self.scale"
 */
export function resizeEdgeEquation(sourceItemId, anchorId, coord, sign, worldFixed, scale) {
  const ref = `@${sourceItemId}_${anchorId}.${coord}`;
  const selfProp = coord === "x" ? "self.x" : "self.y";
  const numerator = sign > 0 ? `${ref} - ${selfProp}` : `${worldFixed} - ${ref}`;
  return scale === 1 ? numerator : `(${numerator}) / self.scale`;
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
export function axisLock(dx, dy, prevAxis, bias = AXIS_LOCK_HYSTERESIS) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (prevAxis === "x") return ay > ax * bias ? "y" : "x";
  if (prevAxis === "y") return ax > ay * bias ? "x" : "y";
  return ax >= ay ? "x" : "y";
}
