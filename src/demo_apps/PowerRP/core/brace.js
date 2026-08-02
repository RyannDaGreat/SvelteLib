/**
 * BRACE GEOMETRY — the curly `{` and the square `[`, as ONE skeleton.
 *
 * User, 2026-08-02: "add a curly brace shape and brace shape … that has two
 * points on either end in the same way that an arrow does, and a third point that
 * can also be anchored. So it's a three-point thing where the points are all like
 * arrow points … the third one determines where the pointy bit of this curly
 * bracket is, and that also determines how it's flipped, and it's always
 * orthogonal to the other two, but can be shifted right or left."
 *
 * ── THE THREE POINTS ARE FREE, AND THAT IS THE WHOLE DESIGN ──────────────────
 * `from`, `to` and `tip` are ordinary world points, exactly like an arrow's
 * endpoints — so all three are draggable, anchorable and `=`-bindable through the
 * SAME core/endpoints.js machinery, with no new handle kind and no `constrain`.
 *
 * "ALWAYS ORTHOGONAL" DESCRIBES THE CONSTRUCTION, NOT A RESTRICTION ON THE TIP.
 * The brace is built in the axis frame of from→to, and the tip is READ in that
 * frame: its component ALONG the axis says where the pointy bit sits ("shifted
 * right or left"), its PERPENDICULAR component says how far the brace bulges, and
 * THE SIGN OF THAT COMPONENT IS THE FLIP. So the nub is always perpendicular to
 * the span by construction, while the point that controls it stays completely
 * free — which is what lets it be bound to another item's anchor and still
 * produce a well-formed brace.
 *
 * Reading a free point in a local frame rather than storing (along, out) scalars
 * is deliberate: scalars could not be anchored to anything, and the user asked
 * for a point "in the same way that an arrow does".
 *
 * ── ONE SKELETON, TWO SHAPES ─────────────────────────────────────────────────
 * A curly brace and a square bracket are the SAME seven-point skeleton — serif,
 * arm, nub, arm, serif — differing only in whether the four corners are rounded.
 * `curl` (0..1) is that difference and nothing else, so the two widgets cannot
 * drift apart in where their arms run or where their nub points.
 *
 *              tip (nub, at `out` from the axis)
 *                        ▲
 *      shoulder ─────────┴───────── shoulder      ← the arms, at out/2
 *      │                                    │
 *      from                                to     ← the two ends, ON the axis
 *
 * ── BACKEND CONTRACT ─────────────────────────────────────────────────────────
 * The emitted `d` uses ONLY M / L / C. render_gpu/ir.js's `path` docblock states
 * that pdf_backend's svgPathToPdfOps accepts M L H V C Q T Z and THROWS on `A`,
 * so no elliptical arc appears here — the rounded corners are cubics on the same
 * KAPPA basis core/svg_paths.js uses for exactly this reason.
 */

/**
 * Quarter-turn cubic constant: a control point KAPPA·r along the tangent makes a
 * cubic match a circular quarter-arc to within ~0.02%. Same value and same reason
 * as core/svg_paths.js — a corner here is a quarter-turn like an ellipse's.
 */
const KAPPA = (4 / 3) * (Math.SQRT2 - 1);

/**
 * How much of the available run each rounded corner may consume. At 1 the arms
 * would vanish into pure curve and a short brace would look like a blob; half
 * leaves a visible straight arm at every proportion, which is what makes a brace
 * read as a brace rather than as a wave.
 */
const MAX_CORNER_FRACTION = 0.5;

/** Where along the first arm the SHOULDER handle sits, as a fraction of the arm.
 *  Not 0.5 — see handleSegments: the two limit profiles are equal at the midpoint,
 *  so a handle there cannot move. A quarter gives |out|/4 of travel. */
const SHOULDER_SAMPLE_T = 0.25;

/**
 * Pure function. A point in the from→to AXIS FRAME: how far ALONG the span it
 * sits, and how far PERPENDICULAR — the decomposition the whole widget is built
 * on. `along` is in the same units as the span (not normalized) and `out` is
 * SIGNED, its sign being which side of the span the point is on.
 *
 * A DEGENERATE SPAN (from == to) HAS NO AXIS, so there is no honest frame to
 * report and both components are 0. Callers must treat that as "draw nothing"
 * rather than dividing by it.
 *
 * @param {{x: number, y: number}} from - span start
 * @param {{x: number, y: number}} to - span end
 * @param {{x: number, y: number}} p - the point to read
 * @returns {{along: number, out: number, len: number, ux: number, uy: number, nx: number, ny: number}}
 *
 * @example axisFrame({x: 0, y: 0}, {x: 10, y: 0}, {x: 5, y: -3})
 * // {along: 5, out: -3, len: 10, ux: 1, uy: 0, nx: 0, ny: 1}
 * @example axisFrame({x: 0, y: 0}, {x: 10, y: 0}, {x: 2, y: 4}).out // 4 (other side → opposite sign → the FLIP)
 * @example axisFrame({x: 0, y: 0}, {x: 0, y: 0}, {x: 1, y: 1}) // {along: 0, out: 0, len: 0, ux: 1, uy: 0, nx: 0, ny: 1}
 */
export function axisFrame(from, to, p) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return { along: 0, out: 0, len: 0, ux: 1, uy: 0, nx: 0, ny: 1 };
  const ux = dx / len, uy = dy / len;
  // RIGHT normal of (ux, uy) in a y-DOWN screen frame.
  const nx = -uy, ny = ux;
  const vx = p.x - from.x, vy = p.y - from.y;
  return { along: vx * ux + vy * uy, out: vx * nx + vy * ny, len, ux, uy, nx, ny };
}

/**
 * Pure function. The corner radius a brace may use, in span units: bounded by the
 * bulge it has to turn through AND by the shorter of its two arms, so the corners
 * of a squat or lopsided brace shrink instead of overlapping each other.
 *
 * @param {number} out - signed perpendicular bulge
 * @param {number} along - the nub's position along the span
 * @param {number} len - the span length
 * @returns {number} a non-negative radius
 *
 * @example cornerRadius(40, 50, 100) // 10  (bounded by |out|/2 · 0.5)
 * @example cornerRadius(100, 50, 100) // 25  (now bounded by the 50-long arms)
 * @example cornerRadius(40, 2, 100) // 1   (a nub crowded against one end)
 * @example cornerRadius(0, 50, 100) // 0   (no bulge, no corner to round)
 */
export function cornerRadius(out, along, len) {
  const arms = Math.min(Math.max(along, 0), Math.max(len - along, 0));
  return Math.max(0, Math.min(Math.abs(out) / 2, arms) * MAX_CORNER_FRACTION);
}

/**
 * Pure function. THE SEVEN SKELETON POINTS, in the axis frame (s along the span,
 * w perpendicular). Every brace — curly or square, flipped or not — is these
 * seven points; `curl` only decides whether the turns between them are rounded.
 *
 * The two ends sit ON the axis (w = 0), the arms run at HALF the bulge, and the
 * nub reaches the full bulge — which is the proportion that makes a `{` read as a
 * `{` rather than as a bracket with a bump.
 *
 * @param {number} along - the nub's position along the span
 * @param {number} out - signed perpendicular bulge (sign = the flip)
 * @param {number} len - the span length
 * @returns {{s: number, w: number}[]} seven points, from end 1 to end 2
 *
 * @example braceSkeleton(50, 40, 100).length // 7
 * @example braceSkeleton(50, 40, 100)[0] // {s: 0, w: 0}      (end 1, on the axis)
 * @example braceSkeleton(50, 40, 100)[3] // {s: 50, w: 40}    (the nub, at full bulge)
 * @example braceSkeleton(50, 40, 100)[6] // {s: 100, w: 0}    (end 2, on the axis)
 * @example braceSkeleton(50, -40, 100)[3].w // -40 (flipped: the nub is on the other side)
 */
export function braceSkeleton(along, out, len, shoulder = 1) {
  // THE RADIUS IS NOT SCALED BY `shoulder`, and an earlier version's mistake in
  // doing so is worth recording: it made a chevron's APEX unroundable, so "curl"
  // had no effect at shoulder 0 and the Straight and Soft Chevron presets
  // rendered IDENTICALLY — caught by tests/arrow_presets_test.js, which renders
  // every preset and refuses two that look the same. A chevron genuinely has no
  // SERIF corners (its arm meets its end along a straight line, so that turn
  // straightens out on its own through the lerp below), but its apex is a corner
  // like any other and rounding it is exactly what a soft chevron is.
  const r = cornerRadius(out, along, len);
  // THE SECOND AXIS. `shoulder` slides the arms between two limits, continuously:
  //   1 — the arms run at HALF the bulge, the classic bracket profile.
  //   0 — every intermediate point lies ON the straight line from its end to the
  //       nub, so the whole shape collapses to a plain chevron ∧. Not a special
  //       case in the code: at 0 the lerp below simply lands on that line.
  // This is what makes "curly ⇄ straight-liney ⇄ right-angle" ONE continuous
  // space rather than three separate widgets, and it is why the corner radius is
  // scaled by it too: a chevron has no corner to round.
  const k = clamp01(shoulder);
  const half = out / 2;
  /** w on the straight end→nub line at position s (the shoulder-0 profile). */
  const lineW = (s, endS) => (along === endS ? out : (out * (s - endS)) / (along - endS));
  const lerp = (s, endS) => ({ s, w: k * half + (1 - k) * lineW(s, endS) });
  return [
    { s: 0, w: 0 },              // end 1
    lerp(r, 0),                  // shoulder after the first serif
    lerp(along - r, 0),          // shoulder before the nub
    { s: along, w: out },        // THE NUB
    lerp(along + r, len),        // shoulder after the nub
    lerp(len - r, len),          // shoulder before the last serif
    { s: len, w: 0 },            // end 2
  ];
}

/**
 * Pure function. Where a point falls along a segment, as 0..1 — the shared half
 * of both look handles. `t` is the projection onto a→b clamped to the segment, so
 * a handle dragged past either end pins there instead of running away.
 *
 * A ZERO-LENGTH SEGMENT RETURNS 0, because there is no direction to measure along
 * and 0 is the value that leaves the property where it was.
 *
 * @param {{x: number, y: number}} a - segment start (t = 0)
 * @param {{x: number, y: number}} b - segment end (t = 1)
 * @param {{x: number, y: number}} p - the dragged point
 * @returns {number} 0..1
 *
 * @example segmentT({x: 0, y: 0}, {x: 10, y: 0}, {x: 5, y: 3}) // 0.5 (perpendicular offset is ignored)
 * @example segmentT({x: 0, y: 0}, {x: 10, y: 0}, {x: -4, y: 0}) // 0   (clamped, not negative)
 * @example segmentT({x: 0, y: 0}, {x: 10, y: 0}, {x: 99, y: 0}) // 1   (clamped, not >1)
 * @example segmentT({x: 3, y: 3}, {x: 3, y: 3}, {x: 9, y: 9}) // 0   (no direction to measure)
 */
export function segmentT(a, b, p) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return 0;
  return clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2);
}

/**
 * Pure function. Point at parameter `t` along a segment — `segmentT`'s inverse,
 * so a handle's DRAWN position and the value it reads back agree by construction
 * rather than by two hand-kept formulas.
 *
 * @param {{x: number, y: number}} a - segment start
 * @param {{x: number, y: number}} b - segment end
 * @param {number} t - 0..1 (clamped)
 * @returns {{x: number, y: number}}
 *
 * @example segmentAt({x: 0, y: 0}, {x: 10, y: 0}, 0.5) // {x: 5, y: 0}
 * @example segmentAt({x: 0, y: 0}, {x: 10, y: 20}, 1) // {x: 10, y: 20}
 */
export function segmentAt(a, b, t) {
  const k = clamp01(t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/**
 * Pure function. THE TWO LOOK HANDLES' ENDPOINTS, in world space: for each of
 * `curl` and `shoulder`, the position the handle takes at 0 and at 1.
 *
 * Both handles are therefore ordinary points on a known segment — draw at
 * `segmentAt(...)`, read back with `segmentT(...)` — which is why neither needs
 * bespoke drag maths and why the handle can never drift from what it controls.
 *
 * SHOULDER runs across the first arm: at 0 the arm lies on the straight
 * end→nub chevron line, at 1 it runs at half the bulge.
 *
 * NOT SAMPLED AT THE ARM'S MIDPOINT, AND THE REASON IS A TRAP WORTH RECORDING:
 * the chevron line's offset is out·s/along, which at s = along/2 is EXACTLY out/2
 * — the bracket profile's offset. The two limits COINCIDE at the midpoint, so a
 * handle placed there has zero travel and silently always reads 0. (Measured: the
 * first implementation did exactly this and its round-trip test returned
 * shoulder 0 for both ends of the segment.) The gap grows toward the ends, so the
 * sample sits a quarter of the way along, where the travel is a healthy |out|/4
 * and the handle is still clearly ON the arm it controls.
 *
 * CURL runs from the nub's corner toward the nub itself: at 0 the corner is sharp
 * (the handle sits on it), at 1 it is fully rounded. "Pull the corner in to round
 * it" is the gesture.
 *
 * @param {object} s - widget state ({from, to, tip, shoulder})
 * @returns {{shoulder: [object, object], curl: [object, object]}|null} null for a degenerate span
 *
 * @example // handleSegments({from: {x:0,y:0}, to: {x:100,y:0}, tip: {x:50,y:40}, shoulder: 1}).curl[0]
 * // the sharp-corner position
 */
export function handleSegments(s) {
  const f = axisFrame(s.from, s.to, s.tip);
  if (f.len === 0 || f.out === 0) return null; // no axis, or no bulge to shape
  const W = (sp, w) => ({ x: s.from.x + f.ux * sp + f.nx * w, y: s.from.y + f.uy * sp + f.ny * w });
  const sample = f.along * SHOULDER_SAMPLE_T;
  // The arm's w at `sample` under each limit profile.
  const chevronW = f.along === 0 ? f.out : (f.out * sample) / f.along;
  const bracketW = f.out / 2;
  const r = cornerRadius(f.out, f.along, f.len) * clamp01(s.shoulder ?? 1);
  const cornerPivot = W(f.along, braceSkeleton(f.along, f.out, f.len, s.shoulder ?? 1)[2].w);
  const nub = W(f.along, f.out);
  return {
    shoulder: [W(sample, chevronW), W(sample, bracketW)],
    // At curl 1 the handle sits KAPPA of the way from the corner to the nub —
    // the same fraction the cubic's control point uses, so the handle is literally
    // showing where the curve is being pulled from rather than an invented scale.
    curl: [cornerPivot, segmentAt(cornerPivot, nub, (4 / 3) * (Math.SQRT2 - 1) * (r > 0 ? 1 : 0.5))],
  };
}

/** Pure function. Clamp to 0..1, treating a non-finite value as 0 rather than
 *  poisoning the geometry with NaN.
 *  @example clamp01(0.4) // 0.4
 *  @example clamp01(5) // 1
 *  @example clamp01(NaN) // 0 */
export function clamp01(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Pure function. An SVG path `d` for a brace between two points, bulging to a
 * third.
 *
 * @param {{x: number, y: number}} from - one end
 * @param {{x: number, y: number}} to - the other end
 * @param {{x: number, y: number}} tip - the nub-controlling point (free; read in the axis frame)
 * @param {number} [curl] - 0 = sharp corners, 1 = fully rounded. Clamped.
 * @param {number} [shoulder] - 1 = bracket arms at half the bulge, 0 = a straight chevron. Clamped.
 * @returns {string} a `d` using only M / L / C — never `A` (the PDF backend throws on arcs)
 *
 * @example bracePathD({x: 0, y: 0}, {x: 0, y: 0}, {x: 1, y: 1}) // "" (no span, no brace — never a divide by zero)
 * @example bracePathD({x: 0, y: 0}, {x: 100, y: 0}, {x: 50, y: 0}, 1) // "M 0 0 L 100 0" (no bulge → a plain line)
 * @example // a square bracket is straight segments only:
 * // bracePathD({x: 0, y: 0}, {x: 100, y: 0}, {x: 50, y: 40}, 0).includes("C") // false
 * @example // a curly brace rounds its four corners:
 * // bracePathD({x: 0, y: 0}, {x: 100, y: 0}, {x: 50, y: 40}, 1).includes("C") // true
 */
export function bracePathD(from, to, tip, curl = 1, shoulder = 1) {
  const f = axisFrame(from, to, tip);
  if (f.len === 0) return ""; // degenerate span: no axis, so no honest geometry
  const k = clamp01(curl);
  const pts = braceSkeleton(f.along, f.out, f.len, shoulder);
  // Axis frame → world. ONE mapping for every point, so a brace cannot disagree
  // with itself about where its own frame is.
  const W = (p) => ({ x: from.x + f.ux * p.s + f.nx * p.w, y: from.y + f.uy * p.s + f.ny * p.w });
  const n = (v) => (Math.round(v * 1000) / 1000);
  const world = pts.map(W);
  if (f.out === 0) return `M ${n(world[0].x)} ${n(world[0].y)} L ${n(world[6].x)} ${n(world[6].y)}`;

  // A corner turns from `prev` toward `next` around `corner`; at curl 0 the two
  // control points collapse onto the corner itself, which IS the sharp corner —
  // so the square bracket is the same expression at k = 0, not a second branch.
  const seg = (prev, corner, next) => {
    const c1 = { x: prev.x + k * KAPPA * (corner.x - prev.x), y: prev.y + k * KAPPA * (corner.y - prev.y) };
    const c2 = { x: next.x + k * KAPPA * (corner.x - next.x), y: next.y + k * KAPPA * (corner.y - next.y) };
    return k === 0
      ? `L ${n(corner.x)} ${n(corner.y)} L ${n(next.x)} ${n(next.y)}`
      : `C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(next.x)} ${n(next.y)}`;
  };
  const [e1, sh1, sh2, nub, sh3, sh4, e2] = world;
  // The corner each turn pivots about: the serif corners sit at the arm's level
  // directly above/below the end; the nub's two corners sit at the arm's level
  // directly beside the nub.
  // A corner pivots about the point where the two runs meeting there WOULD
  // cross. At shoulder 1 that is the arm's level; as the shoulder collapses the
  // corner slides onto the shoulder point itself and the turn straightens out —
  // so a chevron emits (nearly) straight segments without a second code path.
  const cornerAt = (s, at) => W({ s, w: at.w });
  return [
    `M ${n(e1.x)} ${n(e1.y)}`,
    seg(e1, cornerAt(0, pts[1]), sh1),
    `L ${n(sh2.x)} ${n(sh2.y)}`,
    seg(sh2, cornerAt(f.along, pts[2]), nub),
    seg(nub, cornerAt(f.along, pts[4]), sh3),
    `L ${n(sh4.x)} ${n(sh4.y)}`,
    seg(sh4, cornerAt(f.len, pts[5]), e2),
  ].join(" ");
}

/**
 * Pure function. The axis-aligned ink rect of a brace — the BOUNDS PROTOCOL
 * (core/registry.js): what culling, band select and the export capture rect read.
 * A three-point widget declares the hull of its own points, exactly as an arrow
 * declares its endpoint hull, so it is never treated as having no extent.
 *
 * The hull of the three POINTS is sufficient and not merely convenient: every
 * skeleton point lies between the axis and the nub in w, and between the two ends
 * in s, so the drawn curve cannot escape it. Stroke width is the caller's halo to
 * add, the same division of labour arrowInkRect uses.
 *
 * @param {{from: object, to: object, tip: object}} s - the widget's state
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example braceInkRect({from: {x: 0, y: 0}, to: {x: 100, y: 0}, tip: {x: 50, y: 40}})
 * // {x: 0, y: 0, w: 100, h: 40}
 * @example braceInkRect({from: {x: 10, y: 10}, to: {x: 10, y: 90}, tip: {x: -20, y: 50}})
 * // {x: -20, y: 10, w: 30, h: 80}
 */
export function braceInkRect(s) {
  const xs = [s.from.x, s.to.x, s.tip.x];
  const ys = [s.from.y, s.to.y, s.tip.y];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
