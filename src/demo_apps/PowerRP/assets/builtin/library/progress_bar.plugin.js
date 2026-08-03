// progress_bar.plugin.js — A BUILT-IN PLUGIN ASSET (core/builtin_plugin_assets.js).
//
// PROGRESS BAR widget — a TRACK region and a FILL region PARTITIONING one rounded
// rect, split at `fraction` (0..1) of the track along its orientation. The value
// the widget is built around is `fraction`: an ordinary equation-bindable number,
// so it hooks to ANY live source through the universal `=` path — most usefully a
// video's progress export (`= @clip.progress`, from plugins/video_scrub.js),
// giving a scrubber a real progress readout.
//
// ── STATE ─────────────────────────────────────────────────────────────────────
// `fraction` (0..1, CLAMPED at render) drives the fill length. `orientation` is
// "horizontal" (fills left→right, default) or "vertical" (fills bottom→top, a
// rising bar). `fillColor` / `trackColor` paint the two regions — each a FULL
// paint slot (solid/gradient/material), not a plain color; `cornerRadius` rounds
// both (pill bars). The bbox w×h IS the track's size — the standard resize
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
// (`regionPathD` returns null). That is the histogram's empty-bin lesson: a
// zero-extent filled/stroked shape is not invisible — antialiasing and any stroke
// still lay down ink — so the only way to draw nothing is to emit nothing.
//
// ── TWO MATERIALS, PARTITIONED — NOT STACKED (user ruling) ───────────────────
// "I could actually have a striped pattern for one part of the loading bar and
// another part for the other... two sub-materials: top material and bottom
// material" (top/bottom is the visual description; the widget's own axes are
// FILL and TRACK, which stay correct under both orientations — see the
// orientation note below). The two regions PARTITION the track ring: the TRACK
// half is no longer a full w×h rect painted first and then covered by the fill —
// "instead of having one on top of the other" is the explicit ruling — it is the
// COMPLEMENT of the fill's clip rect, i.e. the same track ring clipped to
// [cut, far end] instead of [0, cut]. Both clips share ONE helper
// (`regionPathD`), so the partition is true by construction: fillBox ∪ trackBox
// is the whole progress-rect superset of the ring, and they share only their
// common edge (the cut line), which has zero area — no gap, no overlap, and
// translucent materials never double-darken the seam the way two stacked layers
// would.
//
// `fillColor`/`trackColor` are UNCHANGED KEYS (no document migration): they now
// take the FULL paint union (`paint: true`, the same Axis-1 seam `fill`/`stroke`/
// `background` already use) instead of a plain hex string, so a stored solid
// string is still exactly a solid (parsePaint's back-compat case) and every
// existing document paints byte-identically. The Inspector labels read "Fill
// material" / "Track material" per the brief; the storage keys stay
// `fillColor`/`trackColor` so old documents need no repair-pipeline migration.
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
// both regions are emitted as `ir.path` ops here, NOT by delegating to rect.js.

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

/**
 * Pure function. The TRACK rectangle {x, y, w, h}: the COMPLEMENT of `fillRect`
 * within the w×h box, along the same `orientation` axis. Horizontal: the region
 * to the RIGHT of the cut, [fraction·w, w]. Vertical: the region ABOVE the fill,
 * [0, h − fraction·h] (the fill rises from the bottom, so the unfilled remainder
 * sits at the top).
 *
 * fillRect(w,h,f,o) and complementRect(w,h,f,o) share exactly one edge (the cut
 * line, zero area) and together cover the whole box — the partition the two
 * materials paint into, with no third region and no overlap.
 *
 * @param {number} w - track width (local units)
 * @param {number} h - track height (local units)
 * @param {number} fraction - progress 0..1 (out-of-range clamped)
 * @param {string} orientation - "horizontal" | "vertical"
 * @returns {{x: number, y: number, w: number, h: number}} track rect, local coords
 *
 * @example complementRect(200, 20, 0.25, "horizontal") // {x: 50, y: 0, w: 150, h: 20}
 * @example complementRect(200, 20, 0.75, "horizontal") // {x: 150, y: 0, w: 50, h: 20}
 * @example complementRect(20, 200, 0.25, "vertical")   // {x: 0, y: 0, w: 20, h: 150}
 * @example complementRect(200, 20, 0, "horizontal")    // {x: 0, y: 0, w: 200, h: 20} (no fill yet: track is the whole box)
 * @example complementRect(200, 20, 1, "horizontal")    // {x: 200, y: 0, w: 0, h: 20} (full fill: track is empty)
 */
function complementRect(w, h, fraction, orientation) {
  const f = clamp01(fraction);
  const W = w ?? 0, H = h ?? 0;
  if (orientation === "vertical") {
    const fh = H * f;
    return { x: 0, y: 0, w: W, h: H - fh };
  }
  return { x: W * f, y: 0, w: W - W * f, h: H };
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
 * Pure function. THE SHARED CLIP: the SVG path data for the track's rounded rim
 * (roundedRectRing) clipped to an arbitrary axis-aligned `box`, or `null` when the
 * intersection encloses no area (a zero-size bar, a zero-size box, or a
 * fully-clipped-away sliver) and must therefore emit NOTHING.
 *
 * Both the fill region (box = fillRect) and the track region (box =
 * complementRect) go through this ONE function — that is what makes the
 * partition true by construction: the two boxes share only their common edge (the
 * cut line, zero area), so the two clipped rings can never overlap and, together,
 * their vertices span the whole track ring.
 *
 * @param {number} w - track width
 * @param {number} h - track height
 * @param {number} r - corner radius
 * @param {{x: number, y: number, w: number, h: number}} box - the region to clip to
 * @returns {string|null} SVG path data, or null for "draw nothing"
 *
 * @example regionPathD(200, 20, 0, {x: 0, y: 0, w: 100, h: 20}) // "M0 0 L100 0 L100 20 L0 20 Z"
 * @example regionPathD(200, 20, 10, {x: 0, y: 0, w: 0, h: 20}) // null (a zero-width box encloses no area)
 * @example regionPathD(0, 0, 0, {x: 0, y: 0, w: 0, h: 0}) // null (a zero-size bar has no interior)
 * @example regionPathD(200, 20, 10, {x: 0, y: 0, w: 2, h: 20}).includes("A") // false (arcs are pre-sampled — PDF-export-safe)
 */
// The stroke-style keys the outline forwards verbatim to the IR: the trim window,
// the offset, and the join framework (#215). They are declared as Inspector rows
// with NO default ON PURPOSE (core/properties.js:1568 — "absent-is-legacy, so
// composing them changes no widget's stored state or rendering until a knob
// moves"), and the IR treats each as ABSENT AT ITS IDENTITY (render_gpu/ir.js:46).
// So this list must forward only the keys actually present: writing `undefined`
// is not the same as omitting, and a widget that materialises identities here
// would stop being byte-identical to one that never touched the knobs.
const STROKE_STYLE_KEYS = [
  "strokeOffset",
  "strokeStart", "strokeEnd", "strokePhase", "strokeCapStart", "strokeCapEnd",
  "strokeJoin", "strokeMiter",
];

/**
 * Pure function. The subset of `s`'s stroke-style keys that are actually set,
 * ready to spread into an IR op.
 *
 * Args:
 *   s (object): the folded item state
 *
 * Returns:
 *   object: {} when no knob has moved
 *
 * @example strokeStyleFields({strokeWidth: 4}) // {} — width is not a STYLE key, and nothing else is set
 * @example strokeStyleFields({strokeJoin: "round", strokeMiter: 6}) // {"strokeJoin":"round","strokeMiter":6}
 * @example strokeStyleFields({strokeStart: 0.25, strokeEnd: 0.75}) // {"strokeStart":0.25,"strokeEnd":0.75}
 */
function strokeStyleFields(s) {
  const out = {};
  for (const k of STROKE_STYLE_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

/**
 * Pure function. The SVG path data for the bar's OUTLINE — its whole rounded rim,
 * as one closed figure.
 *
 * This is deliberately NOT either region's path. The fill and the track PARTITION
 * the bar, so stroking them would draw the progress cut down the middle of the bar
 * as a second visible line; a border belongs to the BAR, not to its two halves.
 *
 * Args:
 *   w, h (number): the track box in local units
 *   r (number): corner radius, capped to the bar's half-thickness upstream
 *
 * Returns:
 *   string: SVG path data
 *
 * @example outlinePathD(200, 20, 0).startsWith("M") // true
 * @example outlinePathD(200, 20, 0) === outlinePathD(200, 20, 0) // true (pure)
 */
function outlinePathD(w, h, r) {
  return shapes.polygonPathD(roundedRectRing(w, h, r, CORNER_SEGMENTS));
}

function regionPathD(w, h, r, box) {
  const ring = clipRingToRect(
    roundedRectRing(w, h, r, CORNER_SEGMENTS),
    box.x, box.y, box.x + box.w, box.y + box.h,
  );
  if (ring.length < 3 || ringDoubleArea(ring) === 0) return null;
  return shapes.polygonPathD(ring);
}

/**
 * Pure function. The SVG path data for the FILL region, or `null` when it encloses
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
  return regionPathD(w, h, r, fillRect(w, h, fraction, orientation));
}

/**
 * Pure function. The SVG path data for the TRACK region (the unfilled remainder),
 * or `null` when it encloses no area and must therefore emit NOTHING (fraction 1,
 * a zero-size bar) — the fill's empty-at-zero rule, mirrored: "draw nothing" means
 * emit nothing on EITHER side of the partition, not just the fill's.
 *
 * The figure is the intersection of the COMPLEMENT rect (complementRect) with the
 * track's rounded rim — the same clip fillPathD uses, over the other half of the
 * cut, so the two regions partition the ring with no gap and no overlap (see the
 * module docstring, "TWO MATERIALS, PARTITIONED").
 *
 * @param {number} w - track width
 * @param {number} h - track height
 * @param {number} r - corner radius
 * @param {number} fraction - progress 0..1 (clamped)
 * @param {string} orientation - "horizontal" | "vertical"
 * @returns {string|null} SVG path data, or null for "draw nothing"
 *
 * @example trackPathD(200, 20, 0, 0.5, "horizontal") // "M100 0 L200 0 L200 20 L100 20 Z"
 * @example trackPathD(200, 20, 10, 1, "horizontal") // null (fully filled: no track ink left)
 * @example trackPathD(200, 20, 10, 0, "horizontal") === trackPathD(200, 20, 10, 0, "horizontal") // true (empty fill: track is the whole rim)
 * @example trackPathD(0, 0, 0, 0.5, "horizontal") // null (a zero-size bar has no interior)
 */
function trackPathD(w, h, r, fraction, orientation) {
  return regionPathD(w, h, r, complementRect(w, h, fraction, orientation));
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

// A corner radius the widget is GUARANTEED to clamp down to half the shorter side
// (effectiveRadius above), which is what makes a pill at EVERY bar size instead of
// at one. Four times the default slide's long edge, so no bar that fits on a slide
// has a half-side anywhere near it. A literal rather than an equation, on purpose:
// binding a knob the user sets by hand to an equation installs a kind of state they
// did not ask for, and a value the renderer is guaranteed to clamp gets the same
// picture with none of that.
const PILL_RADIUS = 4000;

// The effect-OFF values, spelled once. Every preset in the look family names all
// three effects because on THIS widget they constitute the look (a sunken groove IS
// an inner shadow, a lit channel IS a bloom, a card-mounted stat bar IS a drop
// shadow), and the overlay rule then forces the ones that do NOT use an effect to
// switch it off explicitly. Naming the off-values once keeps that from being nine
// hand-copied object literals that can silently disagree.
const NO_SHADOW = { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 };
const NO_BLOOM = { radius: 10, strength: 0 };
const FLAT = { shadow: NO_SHADOW, bloom: NO_BLOOM, innerShadow: NO_SHADOW };

// NO OUTLINE — spread into every look preset, and it is not decoration.
//
// `applyPreset` is an OVERLAY, so a look knob a preset OMITS keeps whatever the
// previously hovered row left there (SPEC §4). The moment this widget composed
// bundle("strokedBorder") for the user's outline request, `strokeWidth` became a
// look knob — and ten presets designed before it existed suddenly said nothing
// about it. Hover an outlined preset, then hover "System Track", and the outline
// would have stayed. Every one of the ten was designed WITHOUT a border, so each
// now says so explicitly rather than inheriting an answer.
//
// SEPARATE FROM `FLAT` DELIBERATELY: FLAT means "no DEPTH" (shadow/bloom/inner
// shadow) and three presets opt out of it to draw a recess, a lift or a glow.
// None of them wants an outline, so folding these two keys into FLAT would have
// made the three spell out a border they do not have — the same completeness
// problem one level down.
//
// THE GENERAL LESSON, because this cost a red gate: ADDING A ROW BUNDLE TO A
// WIDGET THAT ALREADY SHIPS PRESETS INVALIDATES EVERY ONE OF ITS PRESETS. The
// roster-wide suites cannot catch it — a universal completeness check would be a
// false gate for the sparse families SPEC §4 also permits — so only the family's
// OWN suite knows, and the author growing the schema has no reason to run it.
// Top up the presets in the SAME commit as the bundle.
const NO_OUTLINE = { stroke: "#000000", strokeWidth: 0 };

/**
 * THE TEN BARS, FLATTEST FIRST — the "Bar looks" family.
 *
 * THE ORDER IS THE CONTENT: it runs from the contemporary system indicator (flat,
 * fully rounded, no depth) through the media and desktop bars to the physically
 * modelled ones (a cell, a slot, a lit channel), and ends on the single gradient.
 *
 * TWO KNOBS DECIDE THE ERA AND THEY MOVE TOGETHER. A pill radius over a
 * low-contrast container track is the current system look; radius 0 over a visible
 * groove is the older desktop one. That is not taste — the mainstream component
 * library's own determinate indicator defaults changed from a square-ended 4dp bar
 * to a 50%-radius track with a gap and a stop indicator, and it now marks the square
 * form legacy and not recommended. So a square-ended preset here is DATED ON PURPOSE.
 *
 * EVERY PRESET SETS ALL SIX LOOK KNOBS — fillColor, trackColor, cornerRadius and the
 * three effects — because application is an overlay. `orientation` is NOT among
 * them: it is not a look, it is an AXIS, and the axis is meaningless without the box
 * (this widget's own docblock: "a horizontal bar is wide-and-short, a vertical one
 * tall-and-narrow"). A preset cannot set w/h, so writing `vertical` onto a
 * wide-and-short bar produces a wide band filling upward — the "someone who sized a
 * box then lost that fit" complaint exactly. Cost: no thermometer, no VU meter, no
 * rising level. `fraction` is NOT among them either: that is the READING, usually
 * bound to a scrubber's progress export, and a literal write would unbind it.
 *
 * THE TRACK CARRIES THE WHOLE FAMILY AT fraction 0. At the default reading the fill
 * emits NOTHING (see the header), so a set separated only by fill colour would
 * collapse on a freshly-placed bar. Every trackColor below is therefore unique too.
 */
const PRESETS = [
  { name: "System Track", description: "The current system determinate indicator: a fully-rounded bar over a low-contrast container track, flat, with no depth of any kind.", props: { fillColor: "#6750a4", trackColor: "#e8def8", cornerRadius: PILL_RADIUS, ...FLAT, ...NO_OUTLINE } },
  { name: "Page Loader", description: "The thin strip that crawls across the top of a loading page: one saturated accent, square ends, and no track behind it at all.", props: { fillColor: "#29d398", trackColor: "#ffffff00", cornerRadius: 0, ...FLAT, ...NO_OUTLINE } },
  { name: "Media Scrubber", description: "The playback bar over a video: white played time on a translucent white remainder, fully rounded, with the frame showing through the track.", props: { fillColor: "#ffffff", trackColor: "#ffffff33", cornerRadius: PILL_RADIUS, ...FLAT, ...NO_OUTLINE } },
  { name: "Buffering", description: "The buffered-ahead tone: a half-transparent level over a dark scrim, so the two regions read as two states of one stream rather than as ink on a groove.", props: { fillColor: "#ffffff66", trackColor: "#00000080", cornerRadius: PILL_RADIUS, ...FLAT, ...NO_OUTLINE } },
  { name: "Sunken Groove", description: "The desktop download bar: square ends and a pale track cut into the dialog, its recess drawn by a hard inner shadow along the top-left edge.", props: { fillColor: "#2f6fd0", trackColor: "#c9ccd1", cornerRadius: 0, shadow: NO_SHADOW, bloom: NO_BLOOM, innerShadow: { dx: 1, dy: 1, blur: 2, color: "#000000", opacity: 0.45 }, ...NO_OUTLINE } },
  { name: "Battery Meter", description: "The charge cell: a green level sitting in a dark hollow behind a slightly rounded case, flat and unlit the way a printed indicator is.", props: { fillColor: "#3ddc84", trackColor: "#1b1f23", cornerRadius: 3, ...FLAT, ...NO_OUTLINE } },
  { name: "Skill Bar", description: "The stat bar off a game overlay or a resume card: a saturated amber level in a dark slot, lifted clear of the card by a soft drop shadow.", props: { fillColor: "#f2b134", trackColor: "#2b2f38", cornerRadius: 4, shadow: { dx: 0, dy: 2, blur: 4, color: "#000000", opacity: 0.35 }, bloom: NO_BLOOM, innerShadow: NO_SHADOW, ...NO_OUTLINE } },
  { name: "Neon Charge", description: "The energy meter: a cyan level blooming hard against a near-black channel, fully rounded, so the bar reads as lit rather than painted.", props: { fillColor: "#00e5ff", trackColor: "#0a1014", cornerRadius: PILL_RADIUS, shadow: NO_SHADOW, bloom: { radius: 18, strength: 0.9 }, innerShadow: NO_SHADOW, ...NO_OUTLINE } },
  { name: "Blueprint Gauge", description: "The technical-drawing readout: a pale cyan level on deep drafting blue, square-ended, with no shadow, no glow and no rounding.", props: { fillColor: "#7fd7ff", trackColor: "#0b2545", cornerRadius: 0, ...FLAT, ...NO_OUTLINE } },
  {
    name: "Sunrise Gradient",
    description: "The widget's two-material headline: a warm gradient running the length of the fill against a flat brown channel, so the level changes colour as it grows.",
    props: {
      // The ONE paint OBJECT in this table, and it is here because two materials are
      // this widget's headline capability — a library that never exercised it would
      // fail to teach the widget. `angle: 0` runs the axis left to right, i.e. along
      // a horizontal bar's length. The `solid` sibling is not decoration: a paint
      // slot stores a MULTI-SUB-STATE object remembering every mode at once, so
      // without it a user who switched this slot back to solid would find no
      // remembered colour waiting (parsePaint's solid branch reads exactly this key).
      fillColor: {
        type: "linearGradient",
        solid: "#ffb347",
        linear: { stops: [{ offset: 0, color: "#ffb347" }, { offset: 1, color: "#ff5e62" }], angle: 0 },
      },
      trackColor: "#3a2b1f", cornerRadius: PILL_RADIUS, ...FLAT, ...NO_OUTLINE,
    },
  },
];

/**
 * Pure function. The equation for a bar that fills ONCE over `seconds` and then
 * holds full — the standard loading beat for a slide making one point.
 *
 * @param {number} seconds - how long the single sweep takes
 * @returns {string} an "="-marked equation over the presentation clock
 *
 * @example sweepOver(5) // "= Math.min(time / 5, 1)"   (0.4 at t=2, 1 from t=5 on)
 */
function sweepOver(seconds) {
  return `= Math.min(time / ${seconds}, 1)`;
}

/**
 * Pure function. The equation for a bar that fills over `seconds`, snaps back to
 * empty and repeats — a sawtooth.
 *
 * @param {number} seconds - the period
 * @returns {string} an "="-marked equation over the presentation clock
 *
 * @example loopOver(3) // "= (time % 3) / 3"   (0.667 at t=2, 0 at t=3)
 */
function loopOver(seconds) {
  return `= (time % ${seconds}) / ${seconds}`;
}

/**
 * Pure function. The equation for a bar that fills over `seconds` then DRAINS over
 * `seconds`, forever, turning smoothly at both ends instead of snapping — a
 * triangle wave of period 2·seconds. Written as a helper rather than inline because
 * the doubled period is a relationship between two of the four numbers in the
 * expression, and a hand-typed version can get it wrong invisibly.
 *
 * @param {number} seconds - the time for ONE direction (half the period)
 * @returns {string} an "="-marked equation over the presentation clock
 *
 * @example pingPongOver(6) // "= 1 - Math.abs(((time % 12) - 6) / 6)"   (0.333 at t=2, 1 at t=6)
 */
function pingPongOver(seconds) {
  return `= 1 - Math.abs(((time % ${2 * seconds}) - ${seconds}) / ${seconds})`;
}

/**
 * TIMING: what DRIVES the level, as opposed to what it looks like.
 *
 * A preset here IS an equation the author could have typed, which is the pattern the
 * video scrubber's eleven presets already ship (ready-made equations over the
 * presentation clock written verbatim onto a numeric row) and the one case where an
 * equation is genuinely a preset's whole content rather than a knob being silently
 * rebound. `fraction` is DISJOINT from all six look keys, so a look and a timing
 * COMPOSE instead of clobbering — which is what makes two families legal here and
 * illegal within the looks.
 *
 * EVERY VALUE CARRIES THE "=" MARKER. The bare form is correct only because
 * `fraction` happens to be a numeric slot; on any other row it would store a silent
 * literal — no error, no equation, the bar simply never binds. The marked form has
 * no silent failure mode at all.
 *
 * "Half Full" is a LITERAL on purpose and it is not filler: application is an
 * overlay, so once a timing equation is on the item there is otherwise no row in the
 * pane that gets you back to a static bar. A family that can only be entered is a
 * trap.
 *
 * THE FOUR SPANS ARE STAGE TIMINGS, not sourced numbers, and they are deliberately
 * ALL DIFFERENT rather than variations on one beat. That is a legibility
 * requirement, not decoration: the editor's clock is FROZEN at a fixed time, so an
 * author only ever hover-previews these at ONE instant, and four presets sharing a
 * five-second beat produced three IDENTICAL bars at that instant (measured: 0.4,
 * 0.4, 0.4). At 5 / 15 / 3 / 6 they read 0.400 / 0.133 / 0.667 / 0.333 against Half
 * Full's 0.500 — five different bars in the pane.
 */
const TIMING_PRESETS = [
  { name: "Slide Timer", description: "Fills once over five seconds and holds full — the standard loading beat for a slide that is making one point.", props: { fraction: sweepOver(5) } },
  { name: "Long Hold", description: "The same single sweep paced over fifteen seconds, for a bar that has to last as long as somebody is talking over it.", props: { fraction: sweepOver(15) } },
  { name: "Looping Fill", description: "Fills over three seconds, snaps back to empty and repeats — the scrubber's Loop applied to a level rather than to a clip.", props: { fraction: loopOver(3) } },
  { name: "Ping-Pong", description: "Fills over six seconds then drains over six, forever, turning smoothly at both ends instead of snapping back.", props: { fraction: pingPongOver(6) } },
  { name: "Half Full", description: "Not time-driven at all — a plain half. The way back to a static bar once a timing preset has bound the level to the clock.", props: { fraction: 0.5 } },
];

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
    // cornerRadius:0 (square), opacity:1, stroke:#000000, strokeWidth:0.
    // strokeWidth 0 IS "no outline", so every document written before the bar had
    // one renders byte-identically. The other stroke-style keys (trim/offset/join)
    // deliberately get NO default — see STROKE_STYLE_KEYS.
    ...defaults("cornerRadius", "opacity", "stroke", "strokeWidth"),
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("positioning"),
    { key: "fraction", label: "Fraction", kind: "number", min: 0, max: 1, category: CAT, help: "How full the bar is, 0 to 1. Type a number, or bind it with '=' to a live value — most usefully a video scrubber's progress: = @clip.progress. Keyframe it across slides to animate the fill. Values outside 0..1 are clamped." },
    { key: "orientation", label: "Orientation", kind: "select", options: ORIENTATIONS, optionLabels: ORIENTATION_LABELS, category: CAT, help: "Horizontal fills left to right; vertical fills bottom to top (a rising bar). The bbox size sets the track: make it wide and short for horizontal, tall and narrow for vertical." },
    // FULL PAINT ROWS (Axis-1, `paint: true` — the same seam as rect's fill/stroke
    // and the camera's background): the Inspector renders PaintField instead of a
    // plain ColorField, so each slot takes solid / linear / radial gradient / matte
    // / shader / equation, and patterns when the sibling material lands. A stored
    // plain hex string is still exactly a solid (parsePaint's back-compat case),
    // so an existing document's trackColor/fillColor keeps painting byte-identically
    // — only the widening is new, not the storage.
    { key: "fillColor", label: "Fill material", kind: "color", paint: true, category: CAT, help: "What paints the FILLED portion of the bar — solid, gradient, or a material (matte/shader/pattern). Lower a color's alpha for translucency; the fill never overdraws the track, so a translucent fill shows the camera/backdrop behind it, not a double-darkened track." },
    { key: "trackColor", label: "Track material", kind: "color", paint: true, category: CAT, help: "What paints the UNFILLED remainder of the bar — the empty groove behind the fill. Takes the same paint options as Fill material. The two regions are clipped to partition the bar exactly, so nothing here is ever drawn UNDER the fill." },
    // THE OUTLINE ROWS, as the shared `strokedBorder` bundle rather than a
    // hand-written stroke/strokeWidth pair — the same eleven rows rect and the
    // shapeshifters get, so join/miter (#215), the trim window and the offset all
    // arrive at once and spell "stroke" exactly one way across the app. The bundle
    // OWNS cornerRadius (an outline follows the rim it traces), so this replaces
    // the standalone row rather than sitting beside it; its label and help are
    // carried over verbatim so nothing the user reads changes.
    ...bundle("strokedBorder", {
      cornerRadius: { label: "Corner radius", category: CAT, help: "Rounds the corners of both the track and the fill — set it near half the bar's thickness for a pill." },
      stroke: { category: CAT, help: "Colour of the outline drawn around the WHOLE bar. It traces the track's rim once, over both the filled and unfilled regions, so it never draws a line down the middle at the progress cut. Set Stroke width above zero to see it." },
      strokeWidth: { category: CAT, help: "Thickness of the bar's outline in canvas units. Zero (the default) means no outline at all, and emits nothing." },
    }),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  // TWO families, not one flat table, because their key sets are DISJOINT — the ten
  // looks write {fillColor, trackColor, cornerRadius, shadow, bloom, innerShadow}
  // and the five timings write {fraction} — so picking one from each COMPOSES
  // rather than clobbers, which is the only split core/registry.js permits. It also
  // buys the two real headings a generic "Presets" would not. The ten looks
  // themselves CANNOT be split: they are alternative whole looks over the same six
  // keys, and any division of them would overlap on every one.
  presetFamilies: [
    { id: "looks", title: "Bar looks", presets: PRESETS },
    { id: "timing", title: "Timing", presets: TIMING_PRESETS },
  ],
  /**
   * Pure function. State → display-list commands (local space): the FILL region
   * and the TRACK region, each an ir.path whose figure is the track's rounded rim
   * CLIPPED to its own half of the progress cut (fillPathD / trackPathD). The two
   * PARTITION the track ring — "instead of having one on top of the other" (user
   * ruling) — so there is no base coat and no overdraw: a translucent material on
   * either side shows whatever is BEHIND the widget, never the other region's
   * paint doubled up. Effects (the shared EFFECTS BUNDLE) wrap both ops; all-off =
   * pass-through.
   *
   * Either op is OMITTED entirely when its clip encloses no area (the fill at
   * fraction 0, the track at fraction 1, or a zero-size bar), because a
   * zero-extent filled path still lays down antialiased ink — "draw nothing" has
   * to mean "emit nothing". TRACK IS EMITTED FIRST so a fill material that paints
   * OVER the cut line by a sub-pixel antialiasing sliver reads as intentional
   * layering order, never as the fill hiding under the track.
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
    const orientation = s.orientation ?? "horizontal";
    const ops = [];
    const trackD = trackPathD(w, h, cornerRadius, s.fraction, orientation);
    if (trackD !== null) ops.push(path({ d: trackD, fill: s.trackColor, opacity }));
    const fillD = fillPathD(w, h, cornerRadius, s.fraction, orientation);
    if (fillD !== null) ops.push(path({ d: fillD, fill: s.fillColor, opacity }));
    // THE OUTLINE, once and LAST. Once, because a border belongs to the BAR and
    // stroking the two partition halves would also ink the progress cut as a line
    // down the middle. Last, so neither region's antialiased edge lies over it.
    // strokeWidth defaults to 0, so a document that has never touched these knobs
    // emits exactly the ops it emitted before.
    const strokeWidth = s.strokeWidth ?? 0;
    if (strokeWidth > 0 && s.stroke)
      ops.push(path({
        d: outlinePathD(w, h, cornerRadius),
        fill: null, stroke: s.stroke, strokeWidth, opacity,
        ...strokeStyleFields(s),
      }));
    return applyEffects(ops, s, world, { x: 0, y: 0, w, h });
  },
  /**
   * Pure function. THE MORPH OUTLINE (core/registry.js's `morphPaths` protocol):
   * the bar's two REGIONS as cubic contours, from the SAME `trackPathD` /
   * `fillPathD` pair emit() draws with — so a bar at 40% morphs from the picture
   * at 40%, its partition where the author put it.
   *
   * BOTH REGIONS, NOT THE OUTLINE. emit() draws the track, the fill, and then
   * ONCE a whole-bar border — and the border is drawn separately precisely because
   * stroking the two partition halves would ink the progress cut as a line down
   * the middle. The payload carries the two REGIONS because they are the bar's
   * ink and they are what carries `fraction`; a payload of the outline alone would
   * morph a full-length rounded rect regardless of how full the bar is, which is
   * the one thing about this widget an author is looking at.
   *
   * Either region can be ABSENT — `trackPathD` returns null at fraction 1 and
   * `fillPathD` at fraction 0 — and both are dropped here exactly as emit() drops
   * them, so an empty or a full bar hands over the one contour it actually shows.
   */
  morphPaths(s) {
    const w = s.w ?? 0, h = s.h ?? 0;
    const cornerRadius = s.cornerRadius ?? 0;
    const orientation = s.orientation ?? "horizontal";
    const opacity = s.opacity ?? 1;
    const trackD = trackPathD(w, h, cornerRadius, s.fraction, orientation);
    const fillD = fillPathD(w, h, cornerRadius, s.fraction, orientation);
    const sources = [];
    if (trackD !== null) sources.push({ d: trackD, paint: { fill: s.trackColor ?? null, stroke: null, strokeWidth: 0, opacity } });
    if (fillD !== null) sources.push({ d: fillD, paint: { fill: s.fillColor ?? null, stroke: null, strokeWidth: 0, opacity } });
    return morphPayloadFromPaths(sources, { w, h });
  },
  /** Pure function. Why this bar cannot morph YET, or null — emit()'s own
   * "nothing to draw" case: a zero-size bar has neither region. */
  morphNotReady(s) {
    return (s.w ?? 0) > 0 && (s.h ?? 0) > 0 ? null : "a bar with extent (this one has zero size)";
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
  // The bbox border, square corners (the rect convention). It used to CLAMP the
  // query into the box, which is a different map: a clamp returns an INTERIOR
  // query unchanged, so closest_to_rim against an overlapping widget answered
  // with a point inside the bar instead of on its edge. G.closestPointOnRectBorder
  // is the projection the comment already claimed, and it is the same one five
  // source widgets call. Pinned by tests/anchor_ink_test.js section 7.
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return G.closestPointOnRectBorder({ x: 0, y: 0, w: state.w ?? 0, h: state.h ?? 0 }, local.x, local.y);
  },
};
