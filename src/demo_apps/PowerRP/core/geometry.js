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
 * Pure function. The bbox {x, y, w, h} of a list of [x, y] points — a polygon's
 * gradient objectBoundingBox frame. An EMPTY list returns a zero rect rather
 * than an infinite one, so a caller may divide by w/h after a finite check.
 *
 * The point-list twin of unionRect, and it lives here for the same reason: it
 * was written TWICE under two names in a single commit (b0b289c) — `pointsBounds`
 * in the Skia painter and `pointsPathBounds` in the PDF backend — so age could
 * not separate them and usage did (5 call sites to 1; `plugins/donut.js` cites
 * the surviving name in prose).
 *
 * @example pointsBounds([[0, 0], [10, 0], [5, 8]]) // {x: 0, y: 0, w: 10, h: 8}
 * @example pointsBounds([[-2, 3], [4, -1]]) // {x: -2, y: -1, w: 6, h: 4}
 * @example pointsBounds([]) // {x: 0, y: 0, w: 0, h: 0}
 */
export function pointsBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Pure function. The LEFT unit normal of a tangent (tx, ty) — the tangent turned
 * a quarter turn counter-clockwise and normalized. A DEGENERATE zero tangent
 * returns [0, 0] rather than NaN, so a caller offsetting a point by it simply
 * does not move.
 *
 * The stroke family's shared perpendicular: a brush offsets a stamp by it, a
 * ribbon finds its inner/outer rail with it, a stroke material bands across it.
 * It lived in three files at once (`unitNormal`, `leftNormal`, `leftNormalTB`)
 * before landing here; this is the OLDEST of the three names, but deliberately
 * NOT in the oldest file — `render_gpu/skia/stroke_materials.js` imports the
 * other two brush modules, so a back-import would have cycled.
 *
 * @example unitNormal(1, 0) // [0, 1]
 * @example unitNormal(0, 2) // [-1, 0]
 * @example unitNormal(3, 4) // [-0.8, 0.6]
 * @example unitNormal(0, 0) // [0, 0]
 */
export function unitNormal(tx, ty) {
  const len = Math.hypot(tx, ty);
  if (!(len > 0)) return [0, 0];
  return [-ty / len, tx / len];
}

/**
 * Pure function. Scale-to-FIT: the largest content-aspect rectangle that fits
 * inside boxW×boxH, CENTERED (letterbox). Returns the UNIFORM scale (so the
 * content keeps its aspect — no squash) plus the top-left offset that centers
 * the scaled content in the box. The complement of a box→box stretch: used to
 * place a latex equation (or any fixed-aspect content) in an arbitrary widget
 * box without distortion.
 *
 * Args:
 *   contentW, contentH (number): the content's natural size (any units)
 *   boxW, boxH (number): the target box size (same-ish units)
 *
 * Returns:
 *   {scale, offsetX, offsetY} — draw the content at (offsetX, offsetY) scaled
 *   uniformly by `scale` to sit centered inside the box.
 *
 * @example fitBox(100, 50, 400, 400) // {scale: 4, offsetX: 0, offsetY: 100}
 * @example fitBox(50, 100, 400, 400) // {scale: 4, offsetX: 100, offsetY: 0}
 * @example fitBox(10, 10, 100, 100) // {scale: 10, offsetX: 0, offsetY: 0}
 */
export function fitBox(contentW, contentH, boxW, boxH) {
  const scale = Math.min(boxW / contentW, boxH / contentH);
  return { scale, offsetX: (boxW - contentW * scale) / 2, offsetY: (boxH - contentH * scale) / 2 };
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

// ── THE FLIP: a reflection lives in the BOX, never in the transform ──────────
// WHY NEGATIVE w/h IS THE REPRESENTATION AND NOT A HACK. A widget's pose is a
// SIMILARITY, stored parametrically as {x, y, rotation, scale} (core/transform.js:
// "NO skew... similarity ∘ similarity = similarity"). A similarity with positive
// scale is ORIENTATION-PRESERVING, so it structurally CANNOT express a
// reflection: `scale` is one scalar, and negating it is a rotation by π, not a
// mirror. There is therefore nowhere in the transform to put a flip — which is
// exactly why the flip is expressed as a SIGNED BOX instead. A box whose `w` is
// negative spans local x from `w` up to 0 rather than 0 up to `w`: the same
// interval walked backwards, i.e. its content frame is reflected. `mirroredPosition`
// above is the sibling operation that reflects an item's PLACE without touching its
// content; these two reflect the content itself.
//
// (This also settles a claim the codebase carried twice: that 0 is a "mathematical
// bound" on a dimension. It is not. A negative dimension is a reflection, which is
// perfectly well defined — see web/canvas/dragKinds.js resizedBox, which used to
// clamp there.)

/**
 * Pure function. The TWO-LEAF write that flips a box's content along one axis:
 * negate the size and advance the origin to where it must sit for the box to
 * occupy the SAME footprint (the user's own formulation — "change the height and
 * width to negative and put the position to where it would have to be to
 * accommodate").
 *
 *   horizontal: w' = −w,  x' = x + scale·w
 *   vertical:   h' = −h,  y' = y + scale·h
 *
 * WHY NO ROTATION TERM (the non-obvious part — derived, not guessed). `x`/`y` is
 * the ROTATION-ZERO base translation: core/derive.js worldTransform builds
 * T.fromState(state) and then re-pivots it with T.aboutPivot, so the stored
 * origin is NOT the world position of the rotated corner and must not be advanced
 * along a rotated axis. A local offset of `w` is a base-frame offset of `scale·w`,
 * full stop. The rotation cancels because the pivot is re-derived from the new
 * box: worldTransform sends the box CENTER to (x + scale·w/2, y + scale·h/2), and
 * substituting (x + scale·w, −w) leaves that point unmoved — so the flipped box is
 * the same |w|×|h| rectangle, at the same center, at the same rotation. It holds
 * for an explicit `rotationAnchor` too (there the pivot is a stored world point,
 * and the origin shift and the size negation cancel inside the same expression).
 *
 * INVOLUTION: applying this twice is the exact identity, at any rotation or scale
 * (x + scale·w + scale·(−w) = x). `normalizedBox` is the same map, applied only
 * when the sign is negative.
 *
 * Args:
 *   state (object): needs the flipped axis's origin + size, and `scale` (default 1)
 *   axis  ("x"|"y"): "x" flips left↔right (writes x + w), "y" flips top↔bottom
 *
 * Returns:
 *   object: ONLY the two changed leaves — {x, w} or {y, h} — so a caller can hand
 *   it straight to a minimal-delta commit and leave the other axis alone.
 *
 * @example flippedBox({x: 10, y: 20, w: 100, h: 50}, "x") // {x: 110, w: -100}
 * @example flippedBox({x: 10, y: 20, w: 100, h: 50}, "y") // {y: 70, h: -50}
 * @example // flipping an already-flipped box restores it EXACTLY (involution):
 * @example flippedBox({x: 110, y: 20, w: -100, h: 50}, "x") // {x: 10, w: 100}
 * @example // scale multiplies the local offset, because x is a base-frame translation:
 * @example flippedBox({x: 10, y: 20, w: 100, h: 50, scale: 2}, "x") // {x: 210, w: -100}
 * @example // rotation contributes NOTHING (the pivot re-derivation cancels it):
 * @example flippedBox({x: 10, y: 20, w: 100, h: 50, rotation: Math.PI / 3}, "x") // {x: 110, w: -100}
 */
export function flippedBox(state, axis) {
  const scale = state.scale ?? 1;
  if (axis === "x") {
    const w = state.w ?? 0;
    return { x: (state.x ?? 0) + scale * w, w: -w };
  }
  const h = state.h ?? 0;
  return { y: (state.y ?? 0) + scale * h, h: -h };
}

/**
 * Pure function. Splits a possibly-SIGNED box into a POSITIVE box plus the
 * mirror flags that signed box denoted — THE seam that keeps a negative
 * dimension from leaking past the derivation stage.
 *
 * WHY THE SPLIT EXISTS. Everything downstream of derivation reads w/h as an
 * extent: plugin `emit()` bodies build `halfW = s.w / 2` for their shaders, plugin
 * `hitTest`s ask `0 <= p <= w`, `nodeFeatures` places snap points at `w/2`, and the
 * vector exporters size their substrates from it. A negative extent would break
 * every one of those (negative half-extents in an SkSL material are nonsense).
 * Normalizing here means NONE of them ever sees a negative number, and the whole
 * cost of the feature is the two flags the render seam and the hit test consume.
 *
 * It is `flippedBox` applied only when the sign is negative, which is what makes
 * the pair provably consistent: because the flip is an involution, normalizing a
 * flipped box returns the ORIGINAL box byte-for-byte (10, +100 → flip → 110, −100
 * → normalize → 10, +100). So a flipped widget derives to the identical geometry
 * as its unflipped self, and the ONLY difference in the render is the mirror —
 * which is precisely the property "a flip occupies the same screen rect, mirrored".
 *
 * Args:
 *   state (object): an item state that may carry a negative w and/or h
 *
 * Returns:
 *   {x, y, w, h, mirrorX, mirrorY} — a non-negative box + which axes were signed.
 *
 * @example normalizedBox({x: 10, y: 20, w: 100, h: 50}) // {x: 10, y: 20, w: 100, h: 50, mirrorX: false, mirrorY: false}
 * @example normalizedBox({x: 110, y: 20, w: -100, h: 50}) // {x: 10, y: 20, w: 100, h: 50, mirrorX: true, mirrorY: false}
 * @example normalizedBox({x: 110, y: 70, w: -100, h: -50}) // {x: 10, y: 20, w: 100, h: 50, mirrorX: true, mirrorY: true}
 * @example // scale is honoured, since it scales the origin shift:
 * @example normalizedBox({x: 210, y: 20, w: -100, h: 50, scale: 2}) // {x: 10, y: 20, w: 100, h: 50, mirrorX: true, mirrorY: false}
 */
export function normalizedBox(state) {
  const mirrorX = (state.w ?? 0) < 0;
  const mirrorY = (state.h ?? 0) < 0;
  const fx = mirrorX ? flippedBox(state, "x") : {};
  const fy = mirrorY ? flippedBox(state, "y") : {};
  return {
    x: fx.x ?? state.x ?? 0,
    y: fy.y ?? state.y ?? 0,
    w: fx.w ?? state.w ?? 0,
    h: fy.h ?? state.h ?? 0,
    mirrorX,
    mirrorY,
  };
}

/**
 * Pure function. THE SEAM, as a state→state map: an item state with any negative
 * extent replaced by the positive box it denotes (`normalizedBox`), and returned
 * UNTOUCHED — same object identity — when neither extent is signed.
 *
 * WHY IT IS A SEPARATE FUNCTION FROM normalizedBox. Two kinds of caller need this
 * map, and they need different halves of it. `deriveRenderTree` needs the mirror
 * FLAGS as well, because it is the render walk's job to realize the reflection; the
 * PRE-DERIVATION readers (core/expressions.js — the equation pass runs before any
 * node exists) need only the state, because an equation asks a geometric question
 * and the reflection is not part of the answer. Handing both the same map is what
 * makes them agree: before this existed, `@item.ml` evaluated against a RAW flipped
 * box and returned the box's RIGHT edge, while the `ml` anchor GLYPH the user clicks
 * to write that equation was drawn at the left edge by the derived path — the arrow
 * jumped the width of the widget on flip, which is the exact behaviour commit
 * 76fd076 claimed to have avoided. It had avoided it on the derived side only.
 *
 * THE OBJECT-IDENTITY GUARANTEE IS LOAD-BEARING, not an optimization: every item is
 * re-derived on every frame, and `deriveRenderTree` distinguishes "flipped" from
 * "not flipped" by `state !== itemState`, so an unflipped item must come back as the
 * very same object with no `mirror` mark at all.
 *
 * @param {object} state - an item state that may carry a negative w and/or h
 * @returns {object} `state` itself, or a shallow clone with x/y/w/h unsigned
 *
 * @example unsignedState({x: 10, y: 20, w: 100, h: 50}).w // 100
 * @example unsignedState({x: 110, y: 20, w: -100, h: 50}) // {x: 10, y: 20, w: 100, h: 50}
 * @example unsignedState({x: 110, y: 70, w: -100, h: -50, fill: "#f00"}) // {x: 10, y: 20, w: 100, h: 50, fill: "#f00"}
 * @example // an unflipped state is the SAME object, not a copy:
 * @example ((s) => unsignedState(s) === s)({x: 0, y: 0, w: 8, h: 8}) // true
 * @example // a widget with no box is untouched (nothing to unsign):
 * @example ((s) => unsignedState(s) === s)({from: {x: 0, y: 0}, to: {x: 1, y: 1}}) // true
 */
export function unsignedState(state) {
  if ((state.w ?? 0) >= 0 && (state.h ?? 0) >= 0) return state;
  const box = normalizedBox(state);
  return { ...state, x: box.x, y: box.y, w: box.w, h: box.h };
}

/**
 * Pure function. A box's CENTER in the ROTATION-ZEROED base frame — the same
 * frame x/y themselves live in (core/transform.js fromState pivots rotation
 * about the local origin; a base-frame point ignores rotation entirely). This
 * is `core/derive.js worldTransform`'s own default-pivot math
 * (`T.apply({...base, rotation: 0}, w/2, h/2)`), pulled out so BOTH the
 * pivot fallback and the cx/cy equation read (core/expressions.js) share one
 * formula instead of two hand-copies drifting apart.
 *
 * SIGN-INDEPENDENT BY CONSTRUCTION — no `unsignedState` call needed. A flip
 * (core/geometry.js "THE FLIP") writes {x: x+scale·w, w: -w}; substituting
 * into `x + scale·w/2` gives `x + scale·w - scale·w/2 = x + scale·w/2`, the
 * SAME value. THE FLIP repositions the box so it occupies the same footprint,
 * so of course its center doesn't move — this is that fact, checked by the
 * doctest below rather than asserted in prose.
 *
 * A widget with no w/h (an arrow, a two-point line) has no box and thus no
 * center; callers with such an item must not call this (the same "no bbox"
 * exclusion `pointInNodeBox` and `worldTransform`'s own pivot fallback use).
 *
 * @example boxCenter({x: 10, y: 20, w: 100, h: 50, scale: 1}) // {x: 60, y: 45}
 * @example // a flipped box (negative w) has the IDENTICAL center — same footprint:
 * @example boxCenter({x: 110, y: 20, w: -100, h: 50, scale: 1}) // {x: 60, y: 45}
 * @example // scale multiplies the half-extent, same as worldTransform's own pivot:
 * @example boxCenter({x: 10, y: 20, w: 100, h: 50, scale: 2}) // {x: 110, y: 70}
 * @example // rotation contributes NOTHING — this IS the rotation-zeroed frame:
 * @example boxCenter({x: 10, y: 20, w: 100, h: 50, scale: 1, rotation: Math.PI / 3}) // {x: 60, y: 45}
 */
export function boxCenter(state) {
  const scale = state.scale ?? 1;
  return {
    x: (state.x ?? 0) + (scale * (state.w ?? 0)) / 2,
    y: (state.y ?? 0) + (scale * (state.h ?? 0)) / 2,
  };
}

/**
 * Pure function. The INVERSE of `boxCenter` for x: given a desired center
 * cx and the box's w/scale, the stored x that makes `boxCenter` read back
 * exactly cx. This is what a cx WRITE solves — "type a center, store the
 * top-left" — mirroring `stateXYForCenterPivotWorld`'s back-solve shape but
 * for the plain (unrotated) base-frame center rather than a rotated pivot.
 *
 * ROUND-TRIP: `boxCenter({...state, x: xForBoxCenterX(cx, state.w, state.scale)}).x === cx`
 * for any state (including a flipped, negative w) — the two are exact
 * algebraic inverses, not an approximation.
 *
 * @example xForBoxCenterX(60, 100, 1) // 10
 * @example xForBoxCenterX(110, 100, 2) // 10
 * @example // inverse of boxCenter: solving for the read-back value is a no-op
 * @example xForBoxCenterX(boxCenter({x: 10, y: 20, w: 100, h: 50, scale: 1}).x, 100, 1) // 10
 */
export function xForBoxCenterX(cx, w, scale = 1) {
  return cx - (scale * w) / 2;
}

/**
 * Pure function. The INVERSE of `boxCenter` for y — see `xForBoxCenterX` for
 * the full rationale (identical shape, the other axis).
 *
 * @example yForBoxCenterY(45, 50, 1) // 20
 * @example yForBoxCenterY(70, 50, 2) // 20
 */
export function yForBoxCenterY(cy, h, scale = 1) {
  return cy - (scale * h) / 2;
}

/**
 * Pure function. Reflects a LOCAL point back through a node's mirror flags, so a
 * point expressed in the widget's on-screen (mirrored) frame lands in the
 * UNMIRRORED frame every plugin's own geometry is written in. The mirror is a
 * reflection about the box's center line, so this is its own inverse — one
 * function serves both directions.
 *
 * The consumer is hit testing (core/derive.js hitNode): a click arrives in world
 * space, the world transform inverts it into the mirrored local frame, and this
 * puts it back where `plugin.hitTest(state, lx, ly)` — which knows nothing about
 * flips and asks `0 <= lx <= w` — expects it.
 *
 * @example unmirroredLocal({x: 10, y: 5}, {w: 100, h: 50, mirrorX: false, mirrorY: false}) // {x: 10, y: 5}
 * @example unmirroredLocal({x: 10, y: 5}, {w: 100, h: 50, mirrorX: true, mirrorY: false}) // {x: 90, y: 5}
 * @example unmirroredLocal({x: 10, y: 5}, {w: 100, h: 50, mirrorX: true, mirrorY: true}) // {x: 90, y: 45}
 * @example // its own inverse: reflecting twice is the identity
 * @example unmirroredLocal(unmirroredLocal({x: 10, y: 5}, {w: 100, h: 50, mirrorX: true}), {w: 100, h: 50, mirrorX: true}) // {x: 10, y: 5}
 */
export function unmirroredLocal(local, box) {
  return {
    x: box.mirrorX ? box.w - local.x : local.x,
    y: box.mirrorY ? box.h - local.y : local.y,
  };
}
