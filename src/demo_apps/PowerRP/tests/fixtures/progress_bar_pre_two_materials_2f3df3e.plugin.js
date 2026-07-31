// progress_bar.plugin.js — A BUILT-IN PLUGIN ASSET (core/builtin_plugin_assets.js).
//
// PROGRESS BAR widget — literally two boxes. A TRACK rectangle (the full bbox)
// and a FILL rectangle whose length is `fraction` (0..1) of the track along its
// orientation. The value the widget is built around is `fraction`: an ordinary
// equation-bindable number, so it hooks to ANY live source through the universal
// `=` path — most usefully a video's progress export (`= @clip.progress`, from
// plugins/video_scrub.js), giving a scrubber a real progress readout.
//
// ── STATE ─────────────────────────────────────────────────────────────────────
// `fraction` (0..1, CLAMPED at render) drives the fill length. `orientation` is
// "horizontal" (fills left→right, default) or "vertical" (fills bottom→top, a
// rising bar). `trackColor` / `fillColor` paint the two boxes; `cornerRadius`
// rounds both (pill bars). The bbox w×h IS the track's size — the standard resize
// handles size the bar, so there is no separate width/height/thickness prop (a
// horizontal bar is wide-and-short, a vertical one tall-and-narrow).
//
// ── WHY A PLAIN NUMBER, NOT A PRESET RANGE ────────────────────────────────────
// `fraction` is a normal numeric slot (equation-capable, keyframable). Binding it
// to a video scrubber's `progress` export is exactly the "combination of two
// boxes with some equations" the widget is for; keyframing it across slides
// animates a fill on its own. Out-of-range values are clamped at emit (fillRect)
// rather than rejected, so a bound value that briefly overshoots reads as full/
// empty instead of erroring.
//
// ── THE FILL IS A CLIP, NOT A SECOND ROUNDED BOX (user report) ────────────────
// The fill used to be its OWN ir.rect carrying its OWN cornerRadius, and at low
// progress that reads wrong in two visible ways at once: a narrow fill rounds all
// four of its corners, so it floats as a detached PILL instead of a groove filled
// from the left; and because the fill box is a plain rectangle while the track is
// rounded, the fill's square top-left/bottom-left corners paint OUTSIDE the
// track's arc. Capping the radius at half the fill's short side (the old
// `fillRadius` line) makes the blob smaller — it does not make it the right SHAPE.
//
// The correct figure is stated geometrically, not approximated: the fill is the
// INTERSECTION of the progress rect with the TRACK'S ROUNDED-RECT. That is one
// convex region (a rounded rect is convex, a rect is convex, and the intersection
// of convex sets is convex), so it is exactly a Sutherland–Hodgman clip of the
// track ring against four half-planes — `clipRingToRect` below. Every property
// the report asked for falls out of the definition rather than being special-
// cased: the fill can never leave the track (it is a subset of it), it inherits
// the track's left cap at every width because those arc vertices are simply not
// clipped away, and the right edge is the straight cut at x = fraction·w.
//
// At fraction 0 the intersection is EMPTY and the widget emits NO fill op at all
// (`fillPathD` returns null). That is the histogram's empty-bin lesson: a
// zero-extent filled/stroked shape is not invisible — antialiasing and any stroke
// still lay down ink — so the only way to draw nothing is to emit nothing.
//
// ── WHY THIS IS AN ASSET AND NOT plugins/progress_bar.js ANY MORE ─────────────
// It was the simplest widget on the roster whose whole vocabulary — ir ops, the
// shared property registry, the effects bundle, standardBBoxAnchors — was ALREADY
// in the sandbox's provided API with nothing added. So it is the batch-1
// baseline: if this file cannot register, the built-in plugin-asset path is
// broken, and the parity test in tests/builtin_plugin_assets_test.js says so
// against the exact op list the source module used to emit.
//
// No plugin imports another (composition is through document state + equations):
// the fill is emitted as an `ir.path` op here, NOT by delegating to rect.js.

// ── defaults (no magic numbers) ───────────────────────────────────────────────
const DEFAULT_W = 240;          // a wide, short horizontal bar by default
const DEFAULT_H = 20;
// Black groove (the shared INK default): it is the UNFILLED part of the bar, so
// it must stay visible against the white default camera background — white here
// would make an empty bar disappear.
const DEFAULT_TRACK_COLOR = "#000000";
const DEFAULT_FILL_COLOR = "#7aa2f7";  // accent (matches rect's default fill)
const ORIENTATIONS = ["horizontal", "vertical"];
const ORIENTATION_LABELS = { horizontal: "Horizontal", vertical: "Vertical" };
const CAT = "formatting"; // groups the bar knobs in the Inspector accordion

/**
 * Pure function. Clamps a progress value to the unit interval [0, 1].
 *
 * @param {number} v - a (possibly out-of-range or missing) fraction
 * @returns {number} v clamped to [0, 1]; 0 for a missing/NaN value
 *
 * @example clamp01(0.25) // 0.25
 * @example clamp01(1.5)  // 1
 * @example clamp01(-3)   // 0
 */
function clamp01(v) {
  return Math.max(0, Math.min(1, v ?? 0));
}

/**
 * Pure function. The FILL rectangle {x, y, w, h} covering `fraction` (clamped to
 * 0..1) of a w×h track, laid out along `orientation`, in LOCAL (top-left-origin)
 * coordinates. Horizontal fills from the LEFT (width = fraction·w). Vertical fills
 * from the BOTTOM upward (height = fraction·h, origin y dropped to h − fillH), so
 * a rising bar grows toward the top the way a thermometer / volume meter reads.
 *
 *   fillLength = fraction · trackLength(axis)
 *
 * @param {number} w - track width (local units)
 * @param {number} h - track height (local units)
 * @param {number} fraction - progress 0..1 (out-of-range clamped)
 * @param {string} orientation - "horizontal" | "vertical"
 * @returns {{x: number, y: number, w: number, h: number}} fill rect, local coords
 *
 * @example fillRect(200, 20, 0.25, "horizontal") // {x: 0, y: 0, w: 50, h: 20}
 * @example fillRect(200, 20, 0.75, "horizontal") // {x: 0, y: 0, w: 150, h: 20}
 * @example fillRect(20, 200, 0.25, "vertical")   // {x: 0, y: 150, w: 20, h: 50}
 * @example fillRect(200, 20, 5, "horizontal")    // {x: 0, y: 0, w: 200, h: 20} (clamped to 1)
 * @example fillRect(200, 20, -1, "horizontal")   // {x: 0, y: 0, w: 0, h: 20}   (clamped to 0)
 */
function fillRect(w, h, fraction, orientation) {
  const f = clamp01(fraction);
  if (orientation === "vertical") {
    const fh = (h ?? 0) * f;
    return { x: 0, y: (h ?? 0) - fh, w: w ?? 0, h: fh };
  }
  return { x: 0, y: 0, w: (w ?? 0) * f, h: h ?? 0 };
}

// Samples per rounded corner when the track's rim is walked as a vertex ring.
// Matches core/outline.js CORNER_SEGMENTS: a corner turns at most 90 degrees here
// and reads as round at widget sizes well before this. The ring is a POLYLINE and
// never an SVG `A` command, which is the backend-safe convention the whole shape
// family uses (pdf_backend's svgPathToPdfOps rejects arcs).
const CORNER_SEGMENTS = 8;
const QUARTER_TURN = Math.PI / 2;

/**
 * Pure function. The effective corner radius of a w×h rounded rect: the requested
 * radius, floored at 0 and capped at half the SHORT side (beyond that the two
 * corners on a side would overlap and the outline would self-intersect).
 *
 * @param {number} w - rect width
 * @param {number} h - rect height
 * @param {number} r - requested corner radius
 * @returns {number} the radius actually drawable
 *
 * @example effectiveRadius(200, 20, 6) // 6
 * @example effectiveRadius(200, 20, 40) // 10 (capped at h/2 — a pill)
 * @example effectiveRadius(200, 20, -5) // 0
 */
function effectiveRadius(w, h, r) {
  return Math.max(0, Math.min(r ?? 0, Math.min(w ?? 0, h ?? 0) / 2));
}

/**
 * Pure function. `segments+1` points along a CIRCULAR arc (center cx,cy, radius r)
 * from angle a0 to a1 inclusive. Radians, y-down screen convention: angle 0 is
 * 3-o'clock and increasing angle turns clockwise on screen.
 *
 * @param {number} cx - arc center x
 * @param {number} cy - arc center y
 * @param {number} r - arc radius
 * @param {number} a0 - start angle (radians)
 * @param {number} a1 - end angle (radians)
 * @param {number} segments - number of line segments (>= 1)
 * @returns {number[][]} segments+1 points [[x, y], ...]
 *
 * @example cornerArc(0, 0, 10, 0, Math.PI / 2, 2).map(([x, y]) => [Math.round(x), Math.round(y)]) // [[10, 0], [7, 7], [0, 10]]
 * @example cornerArc(0, 0, 10, 0, Math.PI / 2, 4).length // 5
 */
function cornerArc(cx, cy, r, a0, a1, segments) {
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const a = a0 + ((a1 - a0) * i) / segments;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/**
 * Pure function. The TRACK's rim as a closed CONVEX vertex ring, walked clockwise
 * from the top edge: a w×h rounded rect with top-left origin (0, 0) and corner
 * radius r. A zero radius returns the four square corners exactly, so an unrounded
 * bar is byte-identical to the plain rectangle it used to be.
 *
 * This is the polygon everything else here clips: the fill is a subset of THIS
 * ring, which is what structurally forbids the fill from painting outside the
 * track.
 *
 * @param {number} w - track width
 * @param {number} h - track height
 * @param {number} r - corner radius (capped by effectiveRadius)
 * @param {number} segments - samples per corner arc
 * @returns {number[][]} closed ring [[x, y], ...], clockwise, no repeated last point
 *
 * @example roundedRectRing(200, 20, 0, 8) // [[0, 0], [200, 0], [200, 20], [0, 20]]
 * @example roundedRectRing(200, 20, 10, 8).length // 41 (4 edge points + 4 arcs x 9 samples, arc ends coinciding with the edge points)
 * @example roundedRectRing(200, 20, 10, 8)[0] // [10, 0] (the top edge starts past the top-left fillet)
 * @example roundedRectRing(200, 20, 10, 8)[1] // [190, 0] (and ends where the top-right fillet begins)
 * @example roundedRectRing(200, 20, 40, 8)[0] // [10, 0] (radius capped at h/2 = 10: a pill)
 * @example roundedRectRing(100, 60, 12, 1).map(([x, y]) => [Math.round(x), Math.round(y)]) // [[12, 0], [88, 0], [88, 0], [100, 12], [100, 48], [100, 48], [88, 60], [12, 60], [12, 60], [0, 48], [0, 12], [0, 12], [12, 0]]
 */
function roundedRectRing(w, h, r, segments) {
  const rad = effectiveRadius(w, h, r);
  if (rad <= 0) return [[0, 0], [w, 0], [w, h], [0, h]];
  return [
    [rad, 0], [w - rad, 0],
    ...cornerArc(w - rad, rad, rad, -QUARTER_TURN, 0, segments),          // top-right
    [w, h - rad],
    ...cornerArc(w - rad, h - rad, rad, 0, QUARTER_TURN, segments),       // bottom-right
    [rad, h],
    ...cornerArc(rad, h - rad, rad, QUARTER_TURN, 2 * QUARTER_TURN, segments), // bottom-left
    [0, rad],
    ...cornerArc(rad, rad, rad, 2 * QUARTER_TURN, 3 * QUARTER_TURN, segments), // top-left
  ];
}

/**
 * Pure function. ONE Sutherland–Hodgman pass: clips a ring to a half-plane stated
 * as a signed test. `signedDepth(p)` is >= 0 for points to KEEP; a crossing edge
 * is split at the exact zero of that linear function, so the cut lands on the
 * boundary with no tolerance and no iteration.
 *
 * Correct for CONVEX rings only, which is all this widget clips (a rounded rect).
 *
 * @param {number[][]} ring - input ring [[x, y], ...]
 * @param {function} signedDepth - (point) => number, >= 0 means inside
 * @returns {number[][]} the clipped ring (possibly empty)
 *
 * @example clipRingToHalfPlane([[0, 0], [10, 0], [10, 10], [0, 10]], (p) => 5 - p[0]) // [[0, 0], [5, 0], [5, 10], [0, 10]]
 * @example clipRingToHalfPlane([[0, 0], [10, 0], [10, 10], [0, 10]], (p) => -1 - p[0]) // [] (everything is outside)
 * @example clipRingToHalfPlane([[0, 0], [10, 0], [10, 10], [0, 10]], (p) => 99 - p[0]).length // 4 (nothing is cut)
 */
function clipRingToHalfPlane(ring, signedDepth) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const da = signedDepth(a), db = signedDepth(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db); // the zero of the linear interpolant; da !== db here
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * Pure function. THE FILL FIGURE: a convex ring clipped to the axis-aligned rect
 * [x0, x1] x [y0, y1], as four half-plane passes. Applied to the track's ring with
 * the PROGRESS rect, this is exactly "the track's interior filled up to x", which
 * is the shape the widget is supposed to draw.
 *
 * @param {number[][]} ring - a CONVEX input ring
 * @param {number} x0 - clip rect left
 * @param {number} y0 - clip rect top
 * @param {number} x1 - clip rect right
 * @param {number} y1 - clip rect bottom
 * @returns {number[][]} the clipped ring (empty when the intersection is empty)
 *
 * @example clipRingToRect([[0, 0], [10, 0], [10, 10], [0, 10]], 0, 0, 4, 10) // [[0, 0], [4, 0], [4, 10], [0, 10]]
 * @example clipRingToRect([[0, 0], [10, 0], [10, 10], [0, 10]], 2, 2, 8, 8).length // 4 (a smaller square)
 * @example clipRingToRect([[0, 0], [10, 0], [10, 10], [0, 10]], 0, 0, 0, 10).map(([x]) => x) // [0, 0, 0, 0] (a zero-width slab: degenerate, no area)
 */
function clipRingToRect(ring, x0, y0, x1, y1) {
  let out = ring;
  out = clipRingToHalfPlane(out, (p) => p[0] - x0);
  out = clipRingToHalfPlane(out, (p) => x1 - p[0]);
  out = clipRingToHalfPlane(out, (p) => p[1] - y0);
  out = clipRingToHalfPlane(out, (p) => y1 - p[1]);
  return out;
}

/**
 * Pure function. Twice the SIGNED area of a ring (the shoelace sum). Used only for
 * its magnitude: a ring whose area is zero encloses no pixels, which is the test
 * for "emit no ink" (a degenerate ring is NOT invisible — a filled path still
 * antialiases along its edge).
 *
 * @param {number[][]} ring - a closed ring [[x, y], ...]
 * @returns {number} twice the signed area (positive clockwise in y-down screen space)
 *
 * @example ringDoubleArea([[0, 0], [10, 0], [10, 10], [0, 10]]) // 200
 * @example ringDoubleArea([[0, 0], [10, 0]]) // 0 (a degenerate two-point ring)
 * @example ringDoubleArea([]) // 0
 */
function ringDoubleArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/**
 * Pure function. The SVG path data for the fill, or `null` when the fill encloses
 * no area and must therefore emit NOTHING (fraction 0, a zero-size bar, or a
 * fully-clipped-away sliver).
 *
 * The figure is the intersection of the progress rect (fillRect) with the track's
 * rounded rim (roundedRectRing) — so the fill hugs the track's left cap (or bottom
 * cap, when vertical) at EVERY fraction, and can never paint outside the track.
 *
 * @param {number} w - track width
 * @param {number} h - track height
 * @param {number} r - corner radius
 * @param {number} fraction - progress 0..1 (clamped)
 * @param {string} orientation - "horizontal" | "vertical"
 * @returns {string|null} SVG path data, or null for "draw nothing"
 *
 * @example fillPathD(200, 20, 0, 0.5, "horizontal") // "M0 0 L100 0 L100 20 L0 20 Z"
 * @example fillPathD(200, 20, 10, 0, "horizontal") // null (fraction 0 emits NO ink)
 * @example fillPathD(200, 20, 10, 1, "horizontal") === fillPathD(200, 20, 10, 1.5, "horizontal") // true (clamped: a full bar)
 * @example fillPathD(0, 0, 0, 0.5, "horizontal") // null (a zero-size bar has no interior)
 * @example fillPathD(200, 20, 10, 0.01, "horizontal").includes("A") // false (arcs are pre-sampled — PDF-export-safe)
 */
function fillPathD(w, h, r, fraction, orientation) {
  const box = fillRect(w, h, fraction, orientation);
  const ring = clipRingToRect(
    roundedRectRing(w, h, r, CORNER_SEGMENTS),
    box.x, box.y, box.x + box.w, box.y + box.h,
  );
  if (ring.length < 3 || ringDoubleArea(ring) === 0) return null;
  return shapes.polygonPathD(ring);
}

/**
 * Pure function. Where the FRACTION HANDLE sits, in LOCAL coordinates: on the
 * fill's LEADING EDGE, at the midpoint of the track's cross-axis. Horizontal puts
 * it at (fraction·w, h/2); vertical at (w/2, h − fraction·h), matching the
 * bottom-up fill direction.
 *
 * It is defined for EVERY fraction including 0 and 1 — it is a function of the
 * box, not of the fill's ink — so the handle is grabbable at the track's left cap
 * even when the fill draws nothing at all.
 *
 * @param {number} w - track width
 * @param {number} h - track height
 * @param {number} fraction - progress 0..1 (clamped)
 * @param {string} orientation - "horizontal" | "vertical"
 * @returns {{x: number, y: number}} handle position, local coords
 *
 * @example handlePoint(200, 20, 0.5, "horizontal") // {x: 100, y: 10}
 * @example handlePoint(200, 20, 0, "horizontal") // {x: 0, y: 10} (at the left cap, where the fill has no ink)
 * @example handlePoint(200, 20, 1, "horizontal") // {x: 200, y: 10}
 * @example handlePoint(20, 200, 0.25, "vertical") // {x: 10, y: 150} (vertical fills upward from the bottom)
 */
function handlePoint(w, h, fraction, orientation) {
  const f = clamp01(fraction);
  if (orientation === "vertical") return { x: (w ?? 0) / 2, y: (h ?? 0) * (1 - f) };
  return { x: (w ?? 0) * f, y: (h ?? 0) / 2 };
}

/**
 * Pure function. The inverse of handlePoint: the `fraction` an ALLOWED handle
 * point denotes. Reads the coordinate along the fill axis as a proportion of the
 * track's length there, clamped to 0..1.
 *
 * A zero-length track has no length to take a proportion OF, so it reports 0 — a
 * division guard, not a bound on `fraction` (the donut `inner` precedent).
 *
 * @param {number} w - track width
 * @param {number} h - track height
 * @param {{x: number, y: number}} point - a local point on the fill axis
 * @param {string} orientation - "horizontal" | "vertical"
 * @returns {number} the fraction 0..1
 *
 * @example fractionAtPoint(200, 20, {x: 100, y: 10}, "horizontal") // 0.5
 * @example fractionAtPoint(200, 20, {x: -40, y: 10}, "horizontal") // 0 (clamped)
 * @example fractionAtPoint(200, 20, {x: 999, y: 10}, "horizontal") // 1 (clamped)
 * @example fractionAtPoint(20, 200, {x: 10, y: 150}, "vertical") // 0.25
 * @example fractionAtPoint(0, 0, {x: 5, y: 5}, "horizontal") // 0 (no length to take a proportion of)
 */
function fractionAtPoint(w, h, point, orientation) {
  if (orientation === "vertical") {
    const H = h ?? 0;
    return H <= 0 ? 0 : clamp01((H - point.y) / H);
  }
  const W = w ?? 0;
  return W <= 0 ? 0 : clamp01(point.x / W);
}

/**
 * Pure function. THE ALLOWED SET of the fraction handle, as a projection: the
 * nearest point of the segment the handle may occupy — from the fraction-0 end of
 * the track to the fraction-1 end, along the fill axis at the cross-axis midpoint.
 *
 * Stated as a segment projection (core/outline.js closestPointOnSegment) rather
 * than as an axis drop plus a clamp, because those are the SAME set and saying it
 * once is what lets any driver — a drag, an equation, an anchor binding — ask
 * where the handle may go without committing a write (THE HANDLE-CONSTRAINT
 * PROTOCOL, core/derive.js).
 *
 * @param {number} w - track width
 * @param {number} h - track height
 * @param {{x: number, y: number}} desired - the desired handle point, local coords
 * @param {string} orientation - "horizontal" | "vertical"
 * @returns {{x: number, y: number}} the nearest allowed point
 *
 * @example constrainHandle(200, 20, {x: 150, y: 99}, "horizontal") // {x: 150, y: 10} (pulled onto the fill axis)
 * @example constrainHandle(200, 20, {x: 900, y: 10}, "horizontal") // {x: 200, y: 10} (clamped to the track's far end)
 * @example constrainHandle(200, 20, {x: -50, y: 10}, "horizontal") // {x: 0, y: 10} (clamped to the left cap)
 * @example constrainHandle(20, 200, {x: 99, y: 150}, "vertical") // {x: 10, y: 150} (vertical: the axis runs up the middle)
 */
function constrainHandle(w, h, desired, orientation) {
  return outline.closestPointOnSegment(
    handlePoint(w, h, 0, orientation),
    handlePoint(w, h, 1, orientation),
    desired,
  );
}

return {
  type: "progress_bar",
  title: "Progress Bar",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "progress_bar", x: 100, y: 100, w: DEFAULT_W, h: DEFAULT_H, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation —
    // the rect precedent). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // THE bindable value: progress 0..1. A plain numeric slot (equation-capable),
    // so `= @clip.progress` (a video scrubber's export) drives the fill.
    fraction: 0,
    orientation: "horizontal",
    trackColor: DEFAULT_TRACK_COLOR,
    fillColor: DEFAULT_FILL_COLOR,
    ...defaults("cornerRadius", "opacity"), // cornerRadius:0 (square), opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("positioning"),
    { key: "fraction", label: "Fraction", kind: "number", min: 0, max: 1, category: CAT, help: "How full the bar is, 0 to 1. Type a number, or bind it with '=' to a live value — most usefully a video scrubber's progress: = @clip.progress. Keyframe it across slides to animate the fill. Values outside 0..1 are clamped." },
    { key: "orientation", label: "Orientation", kind: "select", options: ORIENTATIONS, optionLabels: ORIENTATION_LABELS, category: CAT, help: "Horizontal fills left to right; vertical fills bottom to top (a rising bar). The bbox size sets the track: make it wide and short for horizontal, tall and narrow for vertical." },
    { key: "trackColor", label: "Track color", kind: "color", category: CAT, help: "The color of the empty groove behind the fill." },
    { key: "fillColor", label: "Fill color", kind: "color", category: CAT, help: "The color of the filled portion." },
    ...props("cornerRadius", { cornerRadius: { label: "Corner radius", category: CAT, help: "Rounds the corners of both the track and the fill — set it near half the bar's thickness for a pill." } }),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (local space): the TRACK rect
   * (the full w×h bbox, an ir.rect with the requested cornerRadius) and then the
   * FILL — an ir.path whose figure is the track's rounded rim CLIPPED to the
   * progress rect (fillPathD). Effects (the shared EFFECTS BUNDLE) wrap both ops;
   * all-off = pass-through.
   *
   * The fill op is OMITTED entirely when the clip encloses no area (fraction 0, a
   * zero-size bar), because a zero-extent filled path still lays down antialiased
   * ink — "draw nothing" has to mean "emit nothing".
   *
   * @param {object} s - the folded, equation-evaluated item state
   * @param {*} _targetWorldIR - unused (bbox widget)
   * @param {object} world - the item's world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _targetWorldIR, world) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const cornerRadius = s.cornerRadius ?? 0;
    const opacity = s.opacity ?? 1;
    const ops = [rect({ x: 0, y: 0, w, h, cornerRadius, fill: s.trackColor, opacity })];
    const d = fillPathD(w, h, cornerRadius, s.fraction, s.orientation ?? "horizontal");
    if (d !== null) ops.push(path({ d, fill: s.fillColor, opacity }));
    return applyEffects(ops, s, world, { x: 0, y: 0, w, h });
  },
  /**
   * Pure function. ONE modifier point on the FILL'S LEADING EDGE — the "PPT yellow
   * square" that scrubs `fraction` by dragging along the bar. The Inspector field
   * and any `=` binding keep working untouched: this handle is a SURFACING of the
   * same property, not a second store, so it writes the identical key.
   *
   * THE HANDLE-CONSTRAINT PROTOCOL (core/derive.js):
   *   `constrain` — the allowed set is the SEGMENT spanning the track along its
   *     fill axis, at the cross-axis midpoint: {(t·w, h/2) : t in [0, 1]} when
   *     horizontal. Dropping the drag's cross-axis component IS the projection
   *     onto that line, and clamping to the segment's extent IS `fraction`'s
   *     0..1 domain — so both restrictions are that one declared set rather than
   *     imperative clamping inside `apply`.
   *   `apply` — reads the already-allowed point back as a proportion of the
   *     track's length (fractionAtPoint). No clamp of its own: the set said so.
   *
   * The point is a function of the BOX, not of the fill's ink, so it exists and is
   * grabbable at fraction 0 (sitting on the track's left/bottom cap, where the
   * fill draws nothing) and at fraction 1 alike. Rotation and scale live in
   * node.world — nodeModifierPoints wraps local→world for display and CanvasView
   * inverts back before calling either hook, so neither sees them.
   *
   * The hook's two halves are `handlePoint` (where it sits, and what `constrain`
   * projects onto) and `fractionAtPoint` (what `apply` stores); both are doctested
   * above, including the round trip that makes the handle honest:
   *
   * @param {object} s - the folded, equation-evaluated item state
   * @returns {object[]} one modifier point, LOCAL coords
   *
   * @example fractionAtPoint(200, 20, handlePoint(200, 20, 0.37, "horizontal"), "horizontal") // 0.37 (round trip: read back what the handle shows)
   * @example fractionAtPoint(20, 200, handlePoint(20, 200, 0.37, "vertical"), "vertical") // 0.37 (same, bottom-up)
   * @example fractionAtPoint(200, 20, constrainHandle(200, 20, {x: 900, y: 99}, "horizontal"), "horizontal") // 1 (constrain-then-apply: a drag off the end reads as a full bar)
   * @example fractionAtPoint(200, 20, constrainHandle(200, 20, {x: -60, y: 99}, "horizontal"), "horizontal") // 0 (and off the start reads as empty)
   */
  modifierPoints(s) {
    const orientation = s.orientation ?? "horizontal";
    const at = handlePoint(s.w ?? 0, s.h ?? 0, s.fraction, orientation);
    return [{
      id: "fraction",
      x: at.x,
      y: at.y,
      constrain(state, desired) {
        return constrainHandle(state.w ?? 0, state.h ?? 0, desired, state.orientation ?? "horizontal");
      },
      apply(state, allowed) {
        return { fraction: fractionAtPoint(state.w ?? 0, state.h ?? 0, allowed, state.orientation ?? "horizontal") };
      },
    }];
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  // Anchors sit on the bbox rim (the shared standard anchors) — the bar's
  // selectable frame IS its track bounding box.
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    const w = state.w ?? 0, h = state.h ?? 0;
    // Clamp the target to the bbox border (the rect convention, square corners).
    return { x: Math.max(0, Math.min(w, local.x)), y: Math.max(0, Math.min(h, local.y)) };
  },
};
