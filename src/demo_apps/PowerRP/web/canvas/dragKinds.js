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
 *
 * ── THE ONE GEOMETRY-WRITE SEAM (R6-29) ──────────────────────────────────────
 * `geometryPairs` is the ONLY exported way to turn a desired geometry into item
 * writes, and every drag in the app goes through it: body drag, drag-all, nudge,
 * clone home, single resize, group resize, multi-resize, and all three modal
 * transforms. It does three things in a fixed order — PROJECT the desired record
 * onto what the constraint allows, keep only what actually CHANGED, then scope
 * the surviving keys to the item — and the first of those is THE HANDLE-CONSTRAINT
 * PROTOCOL (core/derive.js), the same `constrain(state, desired) → allowed` the
 * yellow-square modifier points have always declared.
 *
 * THE PROJECTION AND THE MINIMAL DELTA ARE THE SAME LAW, which is why they live
 * in one function rather than two. `diffState` drops a coordinate that HAPPENED
 * not to move, so its stored equation survives; `pinning` holds a coordinate at
 * its start value so it CANNOT move, and `diffState` then drops it for exactly
 * the same reason. Discovered stillness and imposed stillness are one mechanism.
 *
 * `itemGeometryPairs` is deliberately NOT exported. Enforcement by module
 * boundary is the difference between "we converted the call sites" and "a widget
 * cannot have its own dialect": a future call site physically cannot skip the
 * projection, rather than being trusted not to.
 */

import * as T from "../../core/transform.js";
import { stateXYForCenterPivotWorld, UNCONSTRAINED, pinning } from "../../core/derive.js";
import { diffState, getPath } from "../../core/deltas.js";

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
  // A GROUP resize is its own kind because it reads ONE of resize's two
  // modifiers, not both. groupResizeState forces `uniform` on — a group's
  // influence is a single scalar `scale`, and a per-axis group resize would
  // SHEAR its members, which the similarity contract forbids — so Shift is
  // already the only behaviour and a "Uniform scale" chip beside it announces a
  // key that changes nothing. Cmd (scale about the group centre) is real and
  // keeps its chip. Announcing resize's pair here was a HintBar lie of exactly
  // the kind this table exists to prevent, and it is the same defect the
  // multiresize omission was, one axis over: a kind whose true modifier set
  // differs from the kind it borrowed its announcement from.
  groupresize: Object.freeze(["symmetric"]),
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
 * @example DRAG_KINDS.length // 8
 */
export const DRAG_KINDS = Object.freeze(Object.keys(DRAG_KIND_MODIFIERS));

/**
 * THE AXIS-SUPPRESSION TABLE: which stored coordinates each gesture axis owns.
 *
 * WHY IT IS A TABLE AND NOT A COMMENT — the same reason DRAG_KIND_MODIFIERS
 * above it is one. "The x axis touches x and w" used to be spelled as two
 * booleans in `scalePairs` and as a `touch` object in `scaleMemberPairs`, so the
 * fact lived in two places and in neither of them by name. Declaring it once
 * means a fourth constraint source (equation lock, chain-linked aspect ratio,
 * a group scaling its children) reads the mapping instead of restating it.
 *
 * MATCHING IS BY THE COORDINATE'S LAST PATH SEGMENT, which is what lets ONE
 * table cover both record shapes the seam sees: a bbox widget's flat `w` and an
 * arrow's nested `from.y` are both decided by their leaf. `scale` (a group's
 * similarity factor) appears under NO axis, and that is correct rather than an
 * omission — a scalar has no handedness and no axis, which is the same reason
 * groupResizeState clamps it non-negative instead of letting it reflect.
 *
 * `factor` is the same axis in the gesture's OWN parameterization: a modal scale
 * constrained to x is a scale of (factor, 1), which is that axis's factor pinned
 * to its identity. Both suppressions are one projection applied in two spaces —
 * see scalePairs for why the record-space one alone is not sufficient.
 */
export const AXIS_COORDINATES = Object.freeze({
  x: Object.freeze({ leaves: Object.freeze(["x", "w"]), factor: "kx" }),
  y: Object.freeze({ leaves: Object.freeze(["y", "h"]), factor: "ky" }),
});

/** The scale factors a gesture starts from — the identity, one per axis. Pinning
 *  an axis's factor HERE is what "this axis does not scale" means in factor
 *  space, exactly as pinning its coordinates means it in record space. */
const IDENTITY_FACTORS = Object.freeze({ kx: 1, ky: 1 });

/**
 * Pure function. The projection a gesture AXIS CONSTRAINT imposes: every
 * coordinate belonging to the OTHER axis is pinned, so only the constrained
 * axis's coordinates can be written. `null` (unconstrained) is UNCONSTRAINED
 * itself, the protocol's own default.
 *
 * This IS the old `doX`/`doY` pair, and the equality is exact rather than
 * approximate: "suppress this axis's writes" and "hold this axis's coordinates
 * at their start values" produce the same delta, because a coordinate held at
 * its start value is dropped by the same minimal-delta rule that drops one which
 * merely did not move. Expressing it as a projection is what lets it COMPOSE
 * with a per-item constraint the gesture knows nothing about.
 *
 * The pinned key set is read off the record it is handed, so a bbox record and
 * an arrow's endpoint record are both covered with no branch here.
 *
 * @param {("x"|"y"|null)} axis - the axis the gesture is constrained to
 * @returns {function} a `constrain(state, desired) → allowed`
 *
 * @example axisPinning("x")({y: 20, h: 50}, {x: 7, y: 8, w: 300, h: 999}) // {x: 7, y: 20, w: 300, h: 50}
 * @example axisPinning("y")({x: 1, w: 100}, {x: 9, y: 8, w: 300, h: 99}) // {x: 1, y: 8, w: 100, h: 99}
 * @example // a nested leaf obeys the same table — an arrow's y coordinates are its endpoints':
 * @example axisPinning("x")({"from.y": 6}, {"from.x": 5, "from.y": 99}) // {"from.x": 5, "from.y": 6}
 * @example axisPinning(null)({x: 1}, {x: 9}) // {x: 9} (unconstrained is the protocol's own identity)
 */
export function axisPinning(axis) {
  const off = axis === "x" ? "y" : axis === "y" ? "x" : null;
  if (!off) return UNCONSTRAINED;
  const owned = AXIS_COORDINATES[off].leaves;
  return (state, desired) =>
    pinning(Object.keys(desired).filter((k) => owned.includes(k.split(".").pop())))(state, desired);
}

/**
 * Pure function. Turns a flat geometry delta {key: value, …} (as diffState
 * returns) into the item-scoped [path, value] preview pairs CanvasView commits
 * — the bridge from a MINIMAL delta to app.setPreview's pair list. A key is a
 * DOTTED PATH within the item, so "w" scopes to ["items", id, "w"] and "from.x"
 * to ["items", id, "from", "x"]; an EMPTY delta yields no pairs (nothing changed
 * → nothing to write, so no stored equation is disturbed).
 *
 * NOT EXPORTED, deliberately: geometryPairs is the only door, so a call site
 * cannot reach the writes without passing the projection. See THE ONE
 * GEOMETRY-WRITE SEAM in this file's header.
 *
 * @example // itemGeometryPairs("r", {x: 15, w: 120})
 * @example //   → [[["items","r","x"],15],[["items","r","w"],120]]
 * @example // itemGeometryPairs("a", {"from.x": 5}) → [[["items","a","from","x"],5]]
 */
function itemGeometryPairs(itemId, delta) {
  return Object.entries(delta).map(([k, v]) => [["items", itemId, ...k.split(".")], v]);
}

/**
 * Pure function. THE ONE GEOMETRY-WRITE SEAM: project a DESIRED stored geometry
 * onto what the constraint allows, keep only the coordinates that actually
 * changed, and scope those to the item. Every drag in the app ends here.
 *
 * `start` is the RESOLVED start pose (what the coordinate SHOWED at grab time),
 * `desired` is what the gesture asks for, and the keys compared are `desired`'s
 * own — a gesture that does not mention a coordinate cannot write it, which is
 * how a group resize touches {scale, x, y} and nothing else with no key list to
 * maintain.
 *
 * Args:
 *   itemId    (string): the item being written
 *   start     (object): resolved start values, keyed by dotted path within the item
 *   desired   (object): the gesture's requested values, same keys
 *   constrain (function): THE HANDLE-CONSTRAINT PROTOCOL projection
 *     (core/derive.js), defaulted to UNCONSTRAINED so an unrestricted gesture
 *     needs to say nothing — the same defaulting nodeModifierPoints does for
 *     the yellow squares.
 *
 * Returns:
 *   [path, value][]: the preview pairs app.setPreview takes
 *
 * @example // an east-only stretch writes w ALONE, so equations on x/y/h survive:
 * @example geometryPairs("r", {x: 10, y: 20, w: 100, h: 50}, {x: 10, y: 20, w: 120, h: 50}) // [[["items","r","w"],120]]
 * @example // the SAME drag constrained to the x axis writes w and refuses h:
 * @example geometryPairs("r", {y: 20, w: 100, h: 50}, {y: 99, w: 120, h: 999}, axisPinning("x")) // [[["items","r","w"],120]]
 * @example // a gesture that changed nothing writes nothing:
 * @example geometryPairs("r", {x: 10}, {x: 10}) // []
 */
export function geometryPairs(itemId, start, desired, constrain = UNCONSTRAINED) {
  const allowed = constrain(start, desired);
  return itemGeometryPairs(itemId, diffState(start, allowed, Object.keys(desired)));
}

/**
 * Pure function. The path/value preview pairs that translate one member by a
 * world delta (dx, dy) — the ONE translation rule shared by DRAG-ALL body drags,
 * the modal grab, arrow-key nudge AND the clone home (paste + Duplicate). A
 * moveBy widget (arrow) translates only its FREE numeric coordinates via its
 * plugin hook (bound endpoints stay anchored); a bbox/transform widget writes
 * plain numeric x/y, but ONLY on the axis that actually moved (diffState) — a
 * pure-horizontal drag (dy === 0) writes x alone and leaves any equation stored
 * on y untouched. Grabbing an axis that DID move replaces its equation with the
 * new literal (the established body-drag rule).
 *
 * ONLY A FREE NUMBER IS TRANSLATED, on both branches. A drag never sees anything
 * else (CanvasView resolves `n.state.x ?? 0` before building the member), but the
 * CLONE home hands over RAW stored state, where a coordinate can be an EQUATION
 * STRING or simply ABSENT — an arrow keeps its position in from/to and has no x
 * at all. Arithmetic on those answers `"circle.x + 10" + 16` (a concatenation)
 * and `undefined + 16` (NaN), so both are left exactly as they are and emit no
 * pair. This is the same `typeof v === "number"` gate core/endpoints.js
 * endpointMoveBy already applies on the other branch, which is what makes the two
 * one rule rather than two.
 *
 * `constrain` is THE HANDLE-CONSTRAINT PROTOCOL projection (geometryPairs), and
 * it is where a PER-MEMBER restriction enters. The gesture-level axis lock does
 * not need it — moveDrag zeroes the suppressed component before calling, which
 * is the identical projection applied one space earlier (translation is a
 * bijection between delta space and position space, so pinning the delta and
 * pinning the coordinate agree exactly; tests/universal_constraints_test.js pins
 * that equality). A per-member restriction cannot be expressed that way, because
 * a drag-all shares ONE delta across members that may be locked differently.
 *
 * @example // dragged on both axes → both written:
 * @example translationPairs({itemId: "r", plugin: {}, startX: 10, startY: 20}, 5, 3) // [[["items","r","x"], 15], [["items","r","y"], 23]]
 * @example // pure-horizontal drag → only x (y OMITTED, its equation survives):
 * @example translationPairs({itemId: "r", plugin: {}, startX: 10, startY: 20}, 5, 0) // [[["items","r","x"], 15]]
 * @example // the SAME two-axis drag with the y coordinate constrained away:
 * @example translationPairs({itemId: "r", plugin: {}, startX: 10, startY: 20}, 5, 3, axisPinning("x")) // [[["items","r","x"], 15]]
 * @example // a widget with no x/y gains none — no phantom transform:
 * @example translationPairs({itemId: "a", plugin: {}, rawItem: {}}, 16, 16) // []
 */
export function translationPairs(member, dx, dy, constrain = UNCONSTRAINED) {
  if (member.plugin.moveBy) {
    const moved = member.plugin.moveBy(member.rawItem, dx, dy);
    const start = {}, desired = {};
    for (const [path, value] of moved) {
      const key = path.join(".");
      start[key] = getPath(member.rawItem, path);
      desired[key] = value;
    }
    return geometryPairs(member.itemId, start, desired, constrain);
  }
  const start = { x: member.startX, y: member.startY };
  const desired = {
    x: typeof start.x === "number" ? start.x + dx : start.x,
    y: typeof start.y === "number" ? start.y + dy : start.y,
  };
  return geometryPairs(member.itemId, start, desired, constrain);
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
 * SIZES INVERT — dragging a handle past the opposite edge FLIPS the widget, the
 * PowerPoint/Figma behaviour, and it costs nothing: the box simply keeps going and
 * comes out the other side with a negative extent, which is what a reflection IS
 * (core/geometry.js "THE FLIP"). Under `uniform` a negative K is a point reflection
 * through the anchor, so a corner dragged past it flips BOTH axes at once — again
 * the established behaviour.
 *
 * CORRECTING THE RECORD (this docstring previously said the opposite). It claimed
 * "Sizes never invert (MIN_SIZE = 0, the mathematical bound): K clamps at 0", and
 * the code clamped in two places to match. Zero is NOT a mathematical bound on a
 * dimension — a negative dimension is a well-defined reflection — so that was a
 * DESIGN DECISION wearing the costume of a law, which is the one thing a comment
 * must never do (a reader cannot argue with a law, so the clamp survived unexamined
 * through the pass that deleted the other arbitrary limits). The `MIN_SIZE = 0`
 * lineage is real but narrower than it read: the manifest records only that Claude
 * invented MIN_SIZE = 8 and the user replaced it with 0. Zero was the right value
 * for "the smallest size you can drag TO"; it was never a proof that you cannot
 * drag THROUGH.
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
 * @example // dragging the east edge PAST the fixed west edge inverts the box — a flip:
 * @example resizedBox([0,0,100,50], {x:-200,y:0}, {east:true}, {}) // [0, 0, -100, 50]
 * @example // exactly ON the anchor is the degenerate zero-width box, not a flip:
 * @example resizedBox([0,0,100,50], {x:-100,y:0}, {east:true}, {}) // [0, 0, 0, 50]
 * @example // uniform corner past the anchor: K < 0 point-reflects, flipping BOTH axes:
 * @example resizedBox([0,0,100,50], {x:-200,y:-100}, {east:true,south:true}, {uniform:true}) // [0, 0, -100, -50]
 */
export function resizedBox(base, d, edges, mods) {
  const [bx0, by0, bx1, by1] = base;
  const { gx, gy, fx, fy, cx, cy, xActive, yActive } = resizeAnchors(base, edges, mods);

  if (mods.uniform) {
    const ux = gx - fx, uy = gy - fy;
    const len2 = xActive && yActive ? ux * ux + uy * uy : xActive ? ux * ux : uy * uy;
    if (len2 > 0) {
      // K is SIGNED — see the flip note in the docstring. A negative K reflects the
      // box through the anchor rather than clamping onto it.
      const K = (xActive && yActive
        ? (gx + d.x - fx) * ux + (gy + d.y - fy) * uy
        : xActive ? (gx + d.x - fx) * ux : (gy + d.y - fy) * uy) / len2;
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
  // NO inversion clamp: an inverted [x0, y0, x1, y1] is a FLIPPED box and is
  // returned as-is (the pair of `x1 < x0` collapses that used to live here is what
  // the docstring's "CORRECTING THE RECORD" paragraph is about). The grabbed edge
  // keeps tracking the cursor straight through the anchor, so the negative extent
  // the caller stores is anchored exactly where the fixed edge was.
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
 * (kx, ky) about world point (ax, ay). A bbox/transform widget scales its w/h
 * AND repositions its x/y — EXACTLY, including rotated / non-unit-scale members
 * (scaledBoxAboutPoint). A moveBy widget (arrow) scales each FREE numeric
 * endpoint about (ax, ay) per axis; equation-bound endpoints stay put. THE ONE
 * scale rule shared by the S-modal and multi-resize-by-handles.
 *
 * `constrain` REPLACES the old `touch` ({x, y} booleans) parameter, which said
 * "these axes may be written" in a vocabulary only this file spoke. It is the
 * protocol's projection (geometryPairs), so a constrained modal passes
 * axisPinning(axis) and a per-item lock passes its own — and the axis case comes
 * out byte-identical, because a coordinate held at its start value is dropped by
 * the same minimal-delta rule that dropped an untouched one.
 *
 * @example // a rect member {itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startW:100, startH:50} scaled x2 about (0,0):
 * @example scaleMemberPairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startW:100, startH:50}, 2, 2, 0, 0) // [[["items","r","x"],20],[["items","r","y"],40],[["items","r","w"],200],[["items","r","h"],100]]
 * @example // the same member scaled in x only: y/h are pinned, so only x/w are written
 * @example scaleMemberPairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startX:10, startY:20, startW:100, startH:50}, 2, 1, 0, 0, axisPinning("x")) // [[["items","r","x"],20],[["items","r","w"],200]]
 */
export function scaleMemberPairs(member, kx, ky, ax, ay, constrain = UNCONSTRAINED) {
  if (member.plugin.moveBy) {
    const s = member.rawItem ?? {};
    const start = {}, desired = {};
    for (const end of ["from", "to"])
      for (const coord of ["x", "y"]) {
        const v = s[end]?.[coord];
        const k = coord === "x" ? kx : ky;
        const a = coord === "x" ? ax : ay;
        start[`${end}.${coord}`] = v;
        // NOT A FREE NUMBER ⇒ PINNED, by construction: an equation-bound endpoint
        // keeps its binding, which is the same "only a free number is
        // transformed" rule translationPairs states on its own branch.
        desired[`${end}.${coord}`] = typeof v === "number" ? a + k * (v - a) : v;
      }
    return geometryPairs(member.itemId, start, desired, constrain);
  }
  const rawItem = member.rawItem ?? {};
  const nb = scaledBoxAboutPoint(member, kx, ky, ax, ay);
  const start = { x: member.startX, y: member.startY, w: member.startW, h: member.startH };
  // A w/h the item does not STORE as a number is likewise pinned rather than
  // omitted from a key list — same rule, said once. (An item whose w is an
  // equation keeps it: scaling drives the equation's inputs, not its result.)
  const desired = {
    x: nb.x,
    y: nb.y,
    w: typeof rawItem.w === "number" ? nb.w : start.w,
    h: typeof rawItem.h === "number" ? nb.h : start.h,
  };
  return geometryPairs(member.itemId, start, desired, constrain);
}

/**
 * Pure function. Preview pairs that ROTATE one member by `angle` radians about
 * world point `c` — the R-modal's per-member write, and the exact sibling of
 * scalePairs. A bbox/transform widget adds `angle` to its own `rotation` AND
 * orbits its position about `c`; a moveBy widget (arrow) orbits each FREE
 * numeric endpoint, since it has no `rotation` of its own to turn.
 *
 * NO AXIS CONSTRAINT, and that is a fact about the plane rather than a missing
 * feature: Blender's `R X` picks one of three rotation axes, and in 2D there is
 * exactly one (the screen normal), so an X/Y constraint on rotate would have
 * nothing to choose between. Numeric entry does apply — an angle is a single
 * number — and it is entered in DEGREES, the unit every angle row in the app
 * shows (core/properties.js ROW_KINDS "angle"), converted at the one call site.
 *
 * AN ABSENT `rotation` IS WRITTEN, unlike an absent `w` in scaleMemberPairs, and
 * the asymmetry is real rather than an oversight: a widget with no `w` has no
 * width, so writing one would invent a property it does not have — but a widget
 * with no stored `rotation` is at rotation 0 (worldTransform reads `?? 0`), so
 * writing the turn is the only way to honour the gesture. An EQUATION-valued
 * rotation is still pinned, exactly as an equation-valued w is.
 *
 * Like scaledBoxAboutPoint it works in the member's FOLDED world frame and
 * back-solves the stored x/y with stateXYForCenterPivotWorld, so a rotated or
 * group-parented member lands exactly and keeps its clean center-pivot equation.
 *
 * @example // a 100x50 box at (10,20) turned a quarter turn about the origin:
 * @example rotationPairs({itemId: "r", plugin: {}, rawItem: {rotation: 0}, startWorld: {x: 10, y: 20, rotation: 0, scale: 1}, startW: 100, startH: 50, startRotation: 0}, Math.PI / 2, {x: 0, y: 0}).length // 3
 */
export function rotationPairs(member, angle, c, constrain = UNCONSTRAINED) {
  if (member.plugin.moveBy) {
    const s = member.rawItem ?? {};
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const start = {}, desired = {};
    for (const end of ["from", "to"]) {
      const px = s[end]?.x, py = s[end]?.y;
      const free = typeof px === "number" && typeof py === "number";
      // BOTH coordinates or NEITHER: a rotation mixes x and y, so turning a point
      // whose other half is anchored to an equation would move it off the circle.
      start[`${end}.x`] = px;
      start[`${end}.y`] = py;
      desired[`${end}.x`] = free ? c.x + cos * (px - c.x) - sin * (py - c.y) : px;
      desired[`${end}.y`] = free ? c.y + sin * (px - c.x) + cos * (py - c.y) : py;
    }
    return geometryPairs(member.itemId, start, desired, constrain);
  }
  const W = member.startWorld, w = member.startW, h = member.startH;
  const oldCenter = T.apply(W, w / 2, h / 2); // world center (pivot-folded)
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const ncx = c.x + cos * (oldCenter.x - c.x) - sin * (oldCenter.y - c.y);
  const ncy = c.y + sin * (oldCenter.x - c.x) + cos * (oldCenter.y - c.y);
  // Target world transform: same scale, rotation turned by `angle`, center orbited.
  const theta = W.rotation + angle;
  const ct = Math.cos(theta), st = Math.sin(theta), k = W.scale;
  const target = {
    x: ncx - k * (ct * (w / 2) - st * (h / 2)),
    y: ncy - k * (st * (w / 2) + ct * (h / 2)),
    rotation: theta,
    scale: W.scale,
  };
  const xy = stateXYForCenterPivotWorld(target, w, h);
  const rawItem = member.rawItem ?? {};
  const held = rawItem.rotation !== undefined && typeof rawItem.rotation !== "number";
  const start = { rotation: member.startRotation, x: member.startX, y: member.startY };
  const desired = {
    rotation: held ? start.rotation : member.startRotation + angle,
    x: xy.x,
    y: xy.y,
  };
  return geometryPairs(member.itemId, start, desired, constrain);
}

/**
 * Pure function. Preview pairs that scale one member by `factor` about world
 * center `c`, optionally constrained to one `axis` (the S modal's scale). Thin
 * adapter over scaleMemberPairs.
 *
 * THE AXIS CONSTRAINT IS ONE PROJECTION APPLIED IN TWO SPACES, and it has to be,
 * because the gesture and the stored record are different spaces that only
 * coincide when the member is unrotated:
 *   FACTOR SPACE — the constrained axis's factor is pinned to its IDENTITY (1),
 *     so the gesture asks for (factor, 1) rather than (factor, factor).
 *   RECORD SPACE — that axis's stored coordinates are pinned to their start
 *     values (axisPinning), so nothing on it is written.
 * On an unrotated member the second is implied by the first (the coordinates
 * simply do not change, and diffState drops them). On a ROTATED member it is
 * not: scaling the local width alone still moves the stored y, because the box's
 * origin swings, so without the record-space pin an x-constrained scale would
 * write a y. Both pins are `pinning` — the same function, once per space — which
 * is what makes "one mechanism" a fact about the code rather than a slogan.
 * This reproduces the old doX/doY pair exactly; the A/B grid in
 * tests/universal_constraints_test.js is the evidence.
 *
 * @example scalePairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startW:100, startH:50}, 2, {x:0,y:0}) // [[["items","r","x"],20],[["items","r","y"],40],[["items","r","w"],200],[["items","r","h"],100]]
 * @example // constrained to x: the height and the y position are both refused
 * @example scalePairs({itemId:"r", plugin:{}, rawItem:{w:100,h:50}, startWorld:{x:10,y:20,rotation:0,scale:1}, startX:10, startY:20, startW:100, startH:50}, 2, {x:0,y:0}, "x") // [[["items","r","x"],20],[["items","r","w"],200]]
 */
export function scalePairs(member, factor, c, axis = null) {
  const off = axis === "x" ? "y" : axis === "y" ? "x" : null;
  const k = pinning(off ? [AXIS_COORDINATES[off].factor] : [])(IDENTITY_FACTORS, { kx: factor, ky: factor });
  return scaleMemberPairs(member, k.kx, k.ky, c.x, c.y, axisPinning(axis));
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
  const signedK = gState.w > 1e-9 ? (box[2] - box[0]) / gState.w
    : gState.h > 1e-9 ? (box[3] - box[1]) / gState.h : 1;
  // K IS CLAMPED NON-NEGATIVE HERE, AND ONLY HERE — a TECHNICAL bound with a
  // derivation, not the arbitrary kind resizedBox just shed. A single item resizes
  // by its BOX, so a negative extent there is a reflection (core/geometry.js "THE
  // FLIP"). A group resizes by its similarity's SCALAR `scale`, and a scalar has no
  // handedness: negating it is a π-rotation, not a mirror, so it would silently
  // rotate the group instead of flipping it. Worse, `world.scale` is the MAGNITUDE
  // every length consumer multiplies by (blur sigma, stroke widths, material
  // half-extents — render_gpu/skia/paint_skia.js), and a negative one puts negative
  // lengths into the painter. To flip a group's CONTENTS, flip its members (the
  // flip-h/flip-v commands recurse into a group for exactly this reason).
  const K = Math.max(0, signedK);
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
