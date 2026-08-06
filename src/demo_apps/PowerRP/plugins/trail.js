/**
 * TRAIL widget — a streamer that follows a point for N seconds (manifest R7-15).
 *
 * USER, 2026-08-06, verbatim: *"the trail widget, which can like keep a trail for a
 * certain amount of time for n seconds, so that it can kind of draw a streamer… so
 * that we can put that on the end of the double pendulum with an anchor on the end
 * of the double pendulum, and then this trail widget will be anchored to it. That'll
 * make a great demo."* And: *"you have to use DT in order to simulate this property
 * properly."*
 *
 * ── IT IS SIMULATED STATE, AND IT SAYS SO IN ORDINARY DOCUMENT STATE ─────────
 * The trail's clock is one ordinary property, `age`, whose DEFAULT is the equation
 * `= @ + dt` — the user's own `dt` requirement, spelled in the app's own grammar
 * rather than in a mechanism of this widget's own. Everything follows from that one
 * choice and none of it is re-implemented here:
 *   · the camera's MAX TIMESTEP clamps it, so a tab-switch hitch cannot tear a
 *     multi-second gap across the streamer;
 *   · an export DICTATES `dt = 1/fps`, so a rendered video's trail is exactly
 *     reproducible where live playback is only approximately so;
 *   · `core/document.js documentIsSimulated` reads `@`/`dt` out of stored equations,
 *     so a deck containing a trail is ALREADY detected and `stridedShardRefusal`
 *     ALREADY refuses to strided-shard it — a trail gives up seekability, and
 *     nothing had to be taught that it does (pinned by tests/trail_test.js);
 *   · `resetSimulation()` clears the samples, because they live in the simulation
 *     history table (core/trail_history.js explains the whole store).
 * `age` is a REAL property, not a decoy: it is readable (`= trail1.age`), and its
 * authored value is the trail's INITIAL CONDITION, which is what a simulated slot's
 * stored value means everywhere else in this app.
 *
 * ── ANCHORING REUSES THE ORDINARY REFERENCE GRAMMAR ─────────────────────────
 * There is NO second anchor mechanism. `x` and `y` are equation-capable numbers, so
 * a trail follows a pendulum's free end by reading that item's INK anchor —
 * `x = rod2_br.x`, `y = rod2_br.y` in display grammar (the `@id_tl` convention:
 * `@id.x` is the BOX, `@id_tl` is the INK). The trail itself publishes `pt`, its own
 * anchor at the tip, so something else can hang off it in turn.
 *
 * ── APPEARANCE: A TAPERING, FADING RIBBON OF CONVEX QUADS ───────────────────
 * One `polygon` op per segment, offset either side of the path by a half-width that
 * follows the sample's AGE, and filled with the colour/opacity that age interpolates
 * to. Two consequences worth stating:
 *   TAPER AND FADE FOLLOW TIME, NOT SAMPLE COUNT. A point half a window old is drawn
 *   at half the taper whatever the frame rate did, which is the same framerate
 *   independence `dt` buys the trail's clock.
 *   THE QUADS BUTT, THEY DO NOT OVERLAP. Consecutive segments share their two edge
 *   vertices, so a semi-transparent trail does not double-blend at every joint —
 *   which is what a stack of independently-drawn round-capped strokes would do.
 * It is deliberately built from the EXISTING `polygon` op rather than a new Skia
 * mesh path: that op is already painted by Skia, PDF, SVG and the bare-node CLI, so
 * a trail exports to vector with zero backend work.
 * THE ONE BOUND: `polygon` is fan-triangulated and requires CONVEX input, and a
 * ribbon quad turns non-convex where the path bends more sharply than its own width
 * — a hairpin drawn very wide. At the default sampling (64 Hz across a 3 s window)
 * that needs a turn of ~90° between two consecutive samples; when it happens the
 * affected segment renders as a bowtie rather than throwing.
 *
 * ── THE EDITOR SHOWS A DOT, AND THAT IS THE RULING, NOT A GAP ───────────────
 * Presented time is frozen in the editor, so a simulated widget shows its initial
 * condition and does not move (manifest R7-9). A trail therefore has no history
 * there and draws its tip alone — exactly as the sparkler does not animate in the
 * editor. Preview by presenting.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { polygon, ellipse, parseColor, rgbaToCss } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { TRAIL_CLOCK_KEY, TRAIL_POINTS_KEY, TRAIL_SAMPLE_CAPACITY } from "../core/trail_history.js";

/** The Inspector section this widget's own rows file under. */
const TRAIL_CAT = "trail";
/** The section the trail's simulated clock files under — the SAME id the camera's
 *  max-timestep row uses (plugins/camera.js), because they are two halves of one
 *  subject and an author who found one should find the other in a section of the
 *  same name. */
const SIMULATION_CAT = "simulation";

/**
 * The trail's clock, in STORED grammar: `@@` is how the display marker `@` is
 * serialized (core/expressions.js PREV_STORED_MARKER), so this reads `= @ + dt` in
 * the Inspector and is what core/document.js documentIsSimulated matches on.
 *
 * IT IS INSERTED STATE, NOT A PLUGIN DEFAULT, AND THAT IS FORCED — a simulated
 * slot's PLUGIN DEFAULT is its INITIAL CONDITION. core/expressions.js fallbackFor
 * answers `@` on the first step with `getPath(plugin.defaults, path)`, so a default
 * that WAS this equation would make step one read the string "= @@ + dt" and
 * evaluate `"= @@ + dt" + 0` — a string-concatenated clock, silently, with no error
 * (measured, 2026-08-06). So `defaults.age` is the number 0 and the equation is
 * stamped by trailInsertState() into the document, exactly as an author's own
 * `rotation = @ + dt` on a rect is document state over a numeric default.
 */
const TRAIL_CLOCK_EQUATION = "= @@ + dt";

/** Seconds of history a new trail keeps. Three seconds of a swinging pendulum tip
 *  is about one and a half periods — long enough to read as a path rather than a
 *  smear, short enough that the figure does not fill with old ink. */
const TRAIL_SECONDS_DEFAULT = 3;
/** Canvas units across the streamer AT THE TIP. Matches the app's default stroke
 *  weight family (an arrow's shaft is 4, a bold rule ~8); a trail wants to read as a
 *  ribbon rather than a line, so it starts a little heavier. */
const TRAIL_HEAD_WIDTH_DEFAULT = 10;
/** Canvas units across the streamer at the OLDEST end. Zero is a taper to a point,
 *  which is what "streamer" means; raise it for a constant-width ribbon. */
const TRAIL_TAIL_WIDTH_DEFAULT = 0;
/** The tip's colour, and the tail's. Equal by default so the trail reads as ONE
 *  ribbon fading out (the opacity ramp does the fading); set them apart for a
 *  heat-map streamer. Sky-400, the app's cool accent. */
const TRAIL_COLOR_DEFAULT = "#38bdf8";
/** Opacity at the OLDEST end — 0, so a trail dissolves rather than stopping dead at
 *  the window edge. The TIP is always drawn at the widget's own `opacity`. */
const TRAIL_TAIL_OPACITY_DEFAULT = 0;

/** The direction the width handles offset along when the trail has no history to
 *  take a tangent from — straight UP the local axes, so a fresh trail's handle is
 *  where the eye expects it rather than at an angle nothing explains. */
const HANDLE_FALLBACK_NORMAL = { x: 0, y: -1 };

/**
 * Pure function. Linear interpolation, `t` unclamped.
 *
 * @param {number} a - value at t = 0
 * @param {number} b - value at t = 1
 * @param {number} t - parameter
 * @returns {number}
 *
 * @example lerp(0, 10, 0.25) // 2.5
 * @example lerp(4, 4, 0.9) // 4
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Pure function. A trail's injected history → LOCAL polyline points, oldest first,
 * paired with the taper parameter `t` each one is drawn at: 0 at the far edge of the
 * window, 1 at the live tip.
 *
 * WORLD → LOCAL is a subtraction of the widget's own position, because a trail
 * declares no rotation and no scale: its node world is a pure translation to (x, y),
 * so the tip is always local (0, 0) and the history trails off behind it.
 *
 * `t` IS A FUNCTION OF AGE, not of index — a point half a window old is drawn at
 * half the taper however many samples happen to sit beside it.
 *
 * @param {object[]} points - [{x, y, age}] world-space, oldest first (TRAIL_POINTS_KEY)
 * @param {object} state - the evaluated trail state (x, y, age, seconds)
 * @returns {{p: number[], t: number}[]} local [x, y] plus taper parameter, oldest first
 *
 * @example // a two-sample trail whose tip is at (10, 10) and whose oldest point is a
 * @example // full second back in a 2 s window:
 * @example trailLocalPath([{x: 4, y: 10, age: 3}, {x: 10, y: 10, age: 4}], {x: 10, y: 10, age: 4, seconds: 2})
 * @example // [{p: [-6, 0], t: 0.5}, {p: [0, 0], t: 1}]
 */
export function trailLocalPath(points, state) {
  const tipAge = state[TRAIL_CLOCK_KEY];
  const window = state.seconds;
  return points.map((point) => ({
    p: [point.x - state.x, point.y - state.y],
    t: Math.min(1, Math.max(0, 1 - (tipAge - point.age) / window)),
  }));
}

/**
 * Pure function. The UNIT NORMAL at each point of a polyline — the direction the
 * ribbon's edges are offset along. Interior points use the average of the incoming
 * and outgoing segment directions, so the ribbon does not kink at a joint; the ends
 * use their single segment.
 *
 * A polyline with a repeated point has a zero-length segment and therefore no
 * direction there. Those are dropped by the caller (trailRibbonQuads); this function
 * requires >= 2 points and refuses a degenerate run loudly rather than inventing an
 * axis for it.
 *
 * @param {number[][]} path - [[x, y], ...], at least 2 points, no consecutive duplicates
 * @returns {number[][]} one unit [nx, ny] per point
 *
 * @example polylineNormals([[0, 0], [10, 0]]) // [[0, -1], [0, -1]] (a rightward run: normals point up)
 * @example polylineNormals([[0, 0], [0, 10]]) // [[1, 0], [1, 0]] (a downward run: normals point right)
 */
export function polylineNormals(path) {
  if (path.length < 2) throw new Error(`polylineNormals: need >= 2 points, got ${path.length}`);
  const dirs = path.slice(1).map(([x, y], i) => {
    const dx = x - path[i][0], dy = y - path[i][1];
    const len = Math.hypot(dx, dy);
    if (len === 0) throw new Error(`polylineNormals: segment ${i} has zero length — consecutive duplicate points must be dropped first`);
    return [dx / len, dy / len];
  });
  return path.map((_, i) => {
    const before = dirs[i - 1] ?? dirs[i];
    const after = dirs[i] ?? dirs[i - 1];
    const dx = before[0] + after[0], dy = before[1] + after[1];
    const len = Math.hypot(dx, dy);
    // A perfect 180° reversal cancels to zero — the path doubled back on itself.
    // Fall back to the INCOMING direction's normal, which is the edge the ribbon
    // actually arrived on; this is a geometric degeneracy with a right answer, not
    // an unknown being papered over.
    const [ux, uy] = len === 0 ? before : [dx / len, dy / len];
    return [uy, -ux];
  });
}

/**
 * Pure function. A tapering ribbon as one CONVEX QUAD PER SEGMENT, plus the taper
 * parameter at each quad's midpoint (what the colour and opacity ramps are sampled
 * at). Consecutive quads SHARE their edge vertices, so nothing overlaps and a
 * semi-transparent trail does not darken at its joints.
 *
 * Consecutive duplicate points are dropped first: a zero-length segment has no
 * direction to offset along, and it contributes no picture.
 *
 * @param {{p: number[], t: number}[]} path - local points + taper params, oldest first
 * @param {number} tailWidth - ribbon width at t = 0
 * @param {number} headWidth - ribbon width at t = 1
 * @returns {{quad: number[][], t: number}[]} one entry per segment, oldest first
 *
 * @example // a straight 10-unit run tapering 0 → 4 makes one quad, mid-parameter 0.5:
 * @example trailRibbonQuads([{p: [0, 0], t: 0}, {p: [10, 0], t: 1}], 0, 4)
 * @example // [{quad: [[0, 0], [10, -2], [10, 2], [0, 0]], t: 0.5}]
 * @example trailRibbonQuads([{p: [0, 0], t: 1}], 0, 4) // [] (one point is a dot, not a ribbon)
 */
export function trailRibbonQuads(path, tailWidth, headWidth) {
  const kept = path.filter((node, i) => i === 0 || node.p[0] !== path[i - 1].p[0] || node.p[1] !== path[i - 1].p[1]);
  if (kept.length < 2) return [];
  const normals = polylineNormals(kept.map((node) => node.p));
  const half = kept.map((node) => lerp(tailWidth, headWidth, node.t) / 2);
  const left = kept.map((node, i) => [node.p[0] + normals[i][0] * half[i], node.p[1] + normals[i][1] * half[i]]);
  const right = kept.map((node, i) => [node.p[0] - normals[i][0] * half[i], node.p[1] - normals[i][1] * half[i]]);
  return kept.slice(1).map((node, i) => ({
    quad: [left[i], left[i + 1], right[i + 1], right[i]],
    t: (kept[i].t + node.t) / 2,
  }));
}

/**
 * Pure function. The ribbon's colour at taper parameter `t`, as a CSS rgba string —
 * the tail colour/opacity ramping to the head colour at the widget's own opacity.
 *
 * @param {object} state - the evaluated trail state (color, tailColor, tailOpacity, opacity)
 * @param {number} t - taper parameter, 0 at the window edge and 1 at the tip
 * @returns {string} an rgba() string
 *
 * @example trailColorAt({color: "#ffffff", tailColor: "#000000", tailOpacity: 0, opacity: 1}, 1) // "rgba(255,255,255,1)"
 * @example trailColorAt({color: "#ffffff", tailColor: "#000000", tailOpacity: 0, opacity: 1}, 0) // "rgba(0,0,0,0)"
 * @example trailColorAt({color: "#ffffff", tailColor: "#ffffff", tailOpacity: 0, opacity: 1}, 0.5) // "rgba(255,255,255,0.5)"
 */
export function trailColorAt(state, t) {
  const tail = parseColor(state.tailColor);
  const head = parseColor(state.color);
  const alpha = lerp(state.tailOpacity * tail[3], state.opacity * head[3], t);
  return rgbaToCss([lerp(tail[0], head[0], t), lerp(tail[1], head[1], t), lerp(tail[2], head[2], t), alpha]);
}

/**
 * Pure function. The LOCAL rect this trail's ink occupies — the hull of its drawn
 * path grown by the widest half-width. THE BOUNDS PROTOCOL (core/registry.js): it is
 * what culling, band select, hit testing and the export capture rect all read, so a
 * trail whose tip is off-screen but whose streamer is not stays visible and
 * grabbable.
 *
 * A trail with no injected history is its tip alone — a dot of the head width.
 *
 * @param {object} state - the evaluated trail state
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example trailInkRect({width: 8, tailWidth: 0, x: 0, y: 0}) // {x: -4, y: -4, w: 8, h: 8}
 */
export function trailInkRect(state) {
  const pad = Math.max(state.width, state.tailWidth) / 2;
  const path = Array.isArray(state[TRAIL_POINTS_KEY]) ? trailLocalPath(state[TRAIL_POINTS_KEY], state) : [];
  const xs = [0, ...path.map((node) => node.p[0])];
  const ys = [0, ...path.map((node) => node.p[1])];
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  return { x: minX, y: minY, w: Math.max(...xs) + pad - minX, h: Math.max(...ys) + pad - minY };
}

/**
 * Pure function. Where a width handle sits and which way it slides: the LOCAL point
 * it measures from, and the unit normal it offsets along. The tip measures from
 * local (0, 0); the tail measures from the oldest drawn point.
 *
 * WITH NO HISTORY THE TWO ENDS ARE THE SAME POINT — which is every editor render,
 * because presented time is frozen there. Rather than hide the tail's handle (the
 * author would then have no canvas affordance for it at all) the two are placed on
 * OPPOSITE sides of the origin: tip above, tail below. They cannot be confused for
 * each other, and each still drags the width it is named for.
 *
 * @param {object} state - the evaluated trail state
 * @param {boolean} atTail - the tail end rather than the tip
 * @returns {{origin: number[], normal: number[]}}
 *
 * @example trailWidthHandleFrame({x: 0, y: 0, width: 4, tailWidth: 0}, false)
 * @example // {origin: [0, 0], normal: [0, -1]} (no history: the fallback axis, tip side)
 * @example trailWidthHandleFrame({x: 0, y: 0, width: 4, tailWidth: 0}, true)
 * @example // {origin: [0, 0], normal: [0, 1]} (the other side of the same point)
 */
export function trailWidthHandleFrame(state, atTail) {
  const path = Array.isArray(state[TRAIL_POINTS_KEY]) ? trailLocalPath(state[TRAIL_POINTS_KEY], state) : [];
  const kept = path.filter((node, i) => i === 0 || node.p[0] !== path[i - 1].p[0] || node.p[1] !== path[i - 1].p[1]);
  if (kept.length < 2) {
    const side = atTail ? -1 : 1;
    return { origin: [0, 0], normal: [HANDLE_FALLBACK_NORMAL.x * side, HANDLE_FALLBACK_NORMAL.y * side] };
  }
  const normals = polylineNormals(kept.map((node) => node.p));
  const index = atTail ? 0 : kept.length - 1;
  return { origin: kept[index].p, normal: normals[index] };
}

/**
 * Pure function. A width handle's own drag rule: project a dragged point onto the
 * LINE through `origin` along `normal` (THE HANDLE-CONSTRAINT PROTOCOL — the allowed
 * set is that line), and read the resulting width off it.
 *
 * @param {{origin: number[], normal: number[]}} frame - from trailWidthHandleFrame
 * @param {{x: number, y: number}} desired - the dragged local point
 * @returns {{x: number, y: number, width: number}} the allowed point and the width it means
 *
 * @example trailWidthFromDrag({origin: [0, 0], normal: [0, -1]}, {x: 3, y: -5}) // {x: 0, y: -5, width: 10}
 * @example trailWidthFromDrag({origin: [0, 0], normal: [0, -1]}, {x: 0, y: 4}) // {x: 0, y: 4, width: 8}
 */
export function trailWidthFromDrag(frame, desired) {
  const along = (desired.x - frame.origin[0]) * frame.normal[0] + (desired.y - frame.origin[1]) * frame.normal[1];
  return {
    x: frame.origin[0] + frame.normal[0] * along,
    y: frame.origin[1] + frame.normal[1] * along,
    width: Math.abs(along) * 2,
  };
}

/**
 * Pure function. THE STATE A NEW TRAIL IS INSERTED WITH — the plugin defaults plus
 * the running clock equation, plus whatever the caller overrides. Every route that
 * creates a trail must go through here: the add command, and the R7-16 / R7-20 /
 * R7-25 presets, which anchor a trail to a pendulum tip, a body or a cursor by
 * overriding `x` and `y` with reference equations.
 *
 * A trail built from `trailPlugin.defaults` ALONE has a static clock and records
 * nothing. That is not a trap to remember, it is the honest reading of a numeric
 * `age`: the trail's clock is stopped, so its history cannot grow.
 *
 * @param {object} [overrides] - state leaves to override (x/y bindings, colours, …)
 * @returns {object} an item state
 *
 * @example trailInsertState().age // "= @@ + dt"
 * @example trailInsertState({x: "= rod2_br.x", y: "= rod2_br.y"}).x // "= rod2_br.x"
 * @example trailInsertState({seconds: 8}).seconds // 8
 */
export function trailInsertState(overrides = {}) {
  return { ...trailPlugin.defaults, [TRAIL_CLOCK_KEY]: TRAIL_CLOCK_EQUATION, ...overrides };
}

export const trailPlugin = {
  type: "trail",
  ephemeral: EPHEMERAL.NONE,
  title: "Trail",
  // NO bbox and NO rotation/scale: a trail's shape is its HISTORY, which is stated
  // in world coordinates, so its node world must stay a pure translation or the
  // recorded path would be transformed twice. `transform` is on so an UNBOUND trail
  // can still be dragged into place; a bound one has equations in x/y and the drag
  // machinery leaves an equation alone.
  capabilities: { bbox: false, transform: true, resizable: false, backdrop: false },
  defaults: {
    type: "trail", x: 400, y: 300, z: 1,
    // THE CLOCK'S INITIAL CONDITION — a number, never the equation. See
    // TRAIL_CLOCK_EQUATION for why the equation cannot live here, and
    // trailInsertState() for where it does.
    [TRAIL_CLOCK_KEY]: 0,
    seconds: TRAIL_SECONDS_DEFAULT,
    width: TRAIL_HEAD_WIDTH_DEFAULT,
    tailWidth: TRAIL_TAIL_WIDTH_DEFAULT,
    color: TRAIL_COLOR_DEFAULT,
    tailColor: TRAIL_COLOR_DEFAULT,
    tailOpacity: TRAIL_TAIL_OPACITY_DEFAULT,
    // `animated` keeps the presenter repainting while the trail is on screen, which
    // is what gives the simulation its steps. Default true, like the sparkler's.
    ...defaults("animated", "opacity"),
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    { key: "x", label: "X", kind: "number", category: "transform", help: "The point the trail follows, in canvas units. Bind it with = to another widget's ink anchor — rod2_br.x for a pendulum's free end — and the streamer draws wherever that point goes." },
    { key: "y", label: "Y", kind: "number", category: "transform", help: "The point the trail follows, in canvas units. Bind it with = to the same anchor's y." },
    { key: "z", label: "Z order", kind: "number", category: "transform" },
    {
      key: TRAIL_CLOCK_KEY, label: "Clock (s)", kind: "number", category: SIMULATION_CAT,
      help: "Seconds of simulation this trail has run, and the thing that makes it record. Its equation = @ + dt adds each frame's elapsed time to the previous value; the number you type here is the starting value, not a fixed one. Replace the equation with a plain number and the trail stops recording.",
    },
    { key: "seconds", label: "History (s)", kind: "number", min: 0, category: TRAIL_CAT, help: `How long a point stays on the streamer. Older points are dropped, and the ${TRAIL_SAMPLE_CAPACITY} samples kept are spread evenly across this window, so the picture is the same at 30 and at 144 frames per second.` },
    { key: "width", label: "Tip width", kind: "number", min: 0, category: TRAIL_CAT, help: "How wide the streamer is at the point it is following, in canvas units. Drag the square handle beside the tip to set it." },
    { key: "tailWidth", label: "Tail width", kind: "number", min: 0, category: TRAIL_CAT, help: "How wide the streamer is at its oldest end. Zero tapers it to a point; match it to the tip width for a constant-width ribbon." },
    { key: "color", label: "Tip color", kind: "color", category: TRAIL_CAT, help: "The streamer's color at the point it is following." },
    { key: "tailColor", label: "Tail color", kind: "color", category: TRAIL_CAT, help: "The streamer's color at its oldest end. Set it apart from the tip color to shade the trail by age." },
    { key: "tailOpacity", label: "Tail opacity", kind: "number", min: 0, max: 1, step: 0.01, category: TRAIL_CAT, help: "How solid the oldest end is, from 0 (dissolves into the background) to 1 (as solid as the tip)." },
    ...props("animated", "opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. THE TRAIL-SAMPLING CAPABILITY (core/trail_history.js): the point
   * to record and the window to keep it for. Declared as a hook rather than tested
   * for by type, so a future widget gets a streamer by declaring it.
   *
   * @param {object} state - the evaluated trail state
   * @returns {{x: number, y: number, seconds: number}}
   *
   * @example trailPlugin.trailSampler({x: 10, y: 20, seconds: 3}) // {x: 10, y: 20, seconds: 3}
   */
  trailSampler(state) {
    return { x: state.x, y: state.y, seconds: state.seconds };
  },
  /**
   * Pure function. State → display-list commands in LOCAL coordinates: one filled
   * convex quad per segment of the tapering ribbon, oldest first so the tip paints
   * last, wrapped in the shared effects bundle.
   *
   * The history arrives ON THE STATE (TRAIL_POINTS_KEY, injected by
   * core/trail_history.js at web/cameraFrame.js's evaluation seam), so this function
   * takes it as an argument and stays pure — the rule render_gpu/ports.js states for
   * every input emit() may not fetch for itself. A state with NO history injected is
   * the editor's frozen evaluation and the honest picture there is the tip alone: a
   * dot of the tip width, which is also exactly what the presenter draws on frame 0.
   *
   * @param {object} s - the evaluated trail state
   * @param {object} _targetWorldIR - unused (no subtree)
   * @param {object} world - this node's absolute world, for the effects substrate
   * @returns {object[]} display-list commands
   *
   * @example trailPlugin.emit({width: 4, tailWidth: 0, color: "#fff", tailColor: "#fff", tailOpacity: 0, opacity: 1, x: 0, y: 0, seconds: 3, age: 0}, null, {x: 0, y: 0, rotation: 0, scale: 1})[0].op // "ellipse"
   */
  emit(s, _targetWorldIR, world) {
    const path = Array.isArray(s[TRAIL_POINTS_KEY]) ? trailLocalPath(s[TRAIL_POINTS_KEY], s) : [];
    const quads = trailRibbonQuads(path, s.tailWidth, s.width);
    const ops = quads.length
      ? quads.map(({ quad, t }) => polygon({ points: quad, fill: trailColorAt(s, t) }))
      : [ellipse({ cx: 0, cy: 0, rx: s.width / 2, ry: s.width / 2, fill: trailColorAt(s, 1) })];
    return applyEffects(ops, s, world, trailInkRect(s));
  },
  localBounds: trailInkRect,
  cullMargin: effectsCullMargin,
  /**
   * Pure function. The one referencable anchor: `pt`, the point the trail is
   * following — so something else can hang off a trail's tip the same way the trail
   * hangs off a pendulum. It is at the LOCAL origin by construction (see
   * trailLocalPath).
   *
   * @example trailPlugin.anchors() // [{id: "pt", x: 0, y: 0}]
   */
  anchors() {
    return [{ id: "pt", x: 0, y: 0 }];
  },
  /**
   * Pure function. The two spatial rows get canvas handles — NO JSON-ONLY
   * PROPERTIES, and a width is a distance on the canvas, so it is dragged there.
   * Each slides along the ribbon's own normal at its end (THE HANDLE-CONSTRAINT
   * PROTOCOL: `constrain` projects onto that line, `apply` reads the width off the
   * already-allowed point).
   *
   * With no history the two ends coincide, so trailWidthHandleFrame puts them on
   * opposite sides of the origin rather than on top of each other — see it.
   *
   * @example trailPlugin.modifierPoints({x: 0, y: 0, width: 8, tailWidth: 6, seconds: 3, age: 0}).map((m) => m.id) // ["width", "tailWidth"]
   * @example trailPlugin.modifierPoints({x: 0, y: 0, width: 8, tailWidth: 6, seconds: 3, age: 0})[0].y // -4
   * @example trailPlugin.modifierPoints({x: 0, y: 0, width: 8, tailWidth: 6, seconds: 3, age: 0})[1].y // 3
   */
  modifierPoints(s) {
    return [{ key: "width", atTail: false }, { key: "tailWidth", atTail: true }].map(({ key, atTail }) => {
      const frame = trailWidthHandleFrame(s, atTail);
      const offset = s[key] / 2;
      return {
        id: key,
        x: frame.origin[0] + frame.normal[0] * offset,
        y: frame.origin[1] + frame.normal[1] * offset,
        label: atTail ? "Tail width" : "Tip width",
        constrain: (state, desired) => trailWidthFromDrag(trailWidthHandleFrame(state, atTail), desired),
        apply: (state, allowed) => ({ [key]: trailWidthFromDrag(trailWidthHandleFrame(state, atTail), allowed).width }),
      };
    });
  },
  commands: [
    { id: "add-trail", title: "Add Trail", icon: "mdi:vector-polyline", run: (app) => app.addItem(trailInsertState()) },
  ],
};
