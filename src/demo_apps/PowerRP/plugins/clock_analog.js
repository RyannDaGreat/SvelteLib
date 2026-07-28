/**
 * ANALOG CLOCK widget (`clock_analog`) — a bbox clock face + hands driven by an
 * equation-bindable TIME (the whole point: hook many instances to ONE shared
 * time source). It is a plain bbox widget, so it resizes, tweens, and rides the
 * shared effects bundle exactly like rect/circle/donut, and it renders
 * DETERMINISTICALLY from state (WYSIWYG-live: the same `time` always draws the
 * same hands — no wall clock, no hidden state).
 *
 * ── TIME → HANDS (the render direction) ───────────────────────────────────────
 * `time` is a NUMBER in SECONDS (0 = 12:00:00). Each hand has an angular PERIOD
 * (seconds per full revolution): the second hand 60 s, the minute hand 3600 s,
 * the hour hand 43200 s (12 h). Its clock-face angle is
 *   angle = wrap360( (time / period) * 360 )   — 0° = 12 o'clock, clockwise.
 * Because `time` is a plain numeric slot, it is equation-bindable through the
 * universal `=` path: `= time` (THE presentation clock — core/expressions.js
 * scopeGet over render_gpu/particle_clock.particleTime, so this clock and the
 * particle/sky widgets share one time), `= time * 3600` (an hour per second),
 * `= otherClock.time + 900` (a second time zone), etc. `= time` is PAUSED at a fixed
 * freeze in the editor/CLI (a deterministic still), ticks in Present mode, and is
 * driven frame by frame in an MP4 export. There is no `alpha` identifier: to sweep a
 * clock across a transition, KEYFRAME `time` on the two slides and let the tween
 * interpolate it.
 *
 * ── HANDS → TIME (draggable yellow-square handles) ────────────────────────────
 * Each drawn hand's TIP is a modifier point (the standard yellow handle,
 * core/derive.nodeModifierPoints — LOCAL space, wrapped through node.world for
 * display, the drag inverted back to local before apply()). Dragging a tip does
 * two things at once, so the user can "spin the hands and change their lengths":
 *   1. SPIN → the tip's angle inverts to a `time` write via timeFromHandAngle,
 *      which sets ONLY that hand's BAND of the shared time and preserves the
 *      coarser time above it (drag the minute hand → minutes within the current
 *      hour; the hour hand → the position within the current 12 h). Because all
 *      hands read the ONE `time`, this is the coupling the task asks for.
 *   2. RADIUS → the tip's distance from center sets that hand's LENGTH prop (a
 *      fraction of the face radius). Widths/colors are ordinary props too.
 * Dragging writes a concrete number to `time`, which OVERRIDES any equation
 * previously bound there — the standard direct-manipulation behavior (identical
 * to dragging an equation-bound x/y): bind the time OR set it by hand.
 *
 * No plugin imports another; geometry is pure local-space helpers + the IR
 * ellipse/polyline/text ops (parity across GPU raster + SVG + PDF backends).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointInAnnulus } from "../core/outline.js";
import { bundle, bundleNestedDefaults, defaults, props, wrapDegrees, FULL_TURN_DEG } from "../core/properties.js";
import * as T from "../core/transform.js";
import { ellipse, polyline, text } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v ?? lo, hi));
/** Rounds tiny float dust so cos/sin of the cardinal angles land exactly on the
 * axes (e.g. -cos(90°) ≈ -6e-17 → 0) — hands at 12/3/6/9 stay axis-aligned. */
const tidy = (v) => Math.round(v * 1e10) / 1e10;

// ── the three hands' angular PERIODS (seconds per full revolution) ────────────
export const SECOND_HAND_PERIOD_S = 60;    // one minute
export const MINUTE_HAND_PERIOD_S = 3600;  // one hour
export const HOUR_HAND_PERIOD_S = 43200;   // twelve hours

/**
 * Pure function. A hand's clock-face angle in DEGREES at `timeSeconds`, given
 * its full-revolution PERIOD. 0° points UP (12 o'clock); the angle increases
 * CLOCKWISE. The time is taken modulo the period (a hand wraps every period), so
 * the result is always in [0, 360).
 *
 *   angle = wrap360( (timeSeconds / periodSeconds) · 360 )
 *
 * @param {number} timeSeconds - the clock's time, in seconds
 * @param {number} periodSeconds - the hand's full-revolution period, in seconds
 * @returns {number} degrees in [0, 360), 0 = up, clockwise
 *
 * @example handAngleDeg(0, 43200)     // 0    (time 0 → hour hand straight up)
 * @example handAngleDeg(10800, 43200) // 90   (3 h → hour hand at 3 o'clock)
 * @example handAngleDeg(1800, 3600)   // 180  (30 min → minute hand at 6 o'clock)
 * @example handAngleDeg(3600, 3600)   // 0    (a full hour → minute hand back up)
 */
export function handAngleDeg(timeSeconds, periodSeconds) {
  return wrapDegrees((timeSeconds / periodSeconds) * FULL_TURN_DEG);
}

/**
 * Pure function. The HOUR hand's angle (deg, 0 = up, clockwise) for a time in
 * seconds — handAngleDeg with the 12-hour period.
 *
 * @example hourAngle(0)     // 0   (12 o'clock)
 * @example hourAngle(10800) // 90  (3 h → 3 o'clock)
 * @example hourAngle(21600) // 180 (6 h → 6 o'clock)
 */
export function hourAngle(timeSeconds) {
  return handAngleDeg(timeSeconds, HOUR_HAND_PERIOD_S);
}

/**
 * Pure function. The MINUTE hand's angle (deg, 0 = up, clockwise) — handAngleDeg
 * with the one-hour period.
 *
 * @example minuteAngle(0)    // 0   (on the hour → 12 o'clock)
 * @example minuteAngle(900)  // 90  (15 min → 3 o'clock)
 * @example minuteAngle(1800) // 180 (30 min → 6 o'clock)
 */
export function minuteAngle(timeSeconds) {
  return handAngleDeg(timeSeconds, MINUTE_HAND_PERIOD_S);
}

/**
 * Pure function. The SECOND hand's angle (deg, 0 = up, clockwise) — handAngleDeg
 * with the one-minute period.
 *
 * @example secondAngle(0)  // 0   (12 o'clock)
 * @example secondAngle(15) // 90  (:15 → 3 o'clock)
 * @example secondAngle(30) // 180 (:30 → 6 o'clock)
 */
export function secondAngle(timeSeconds) {
  return handAngleDeg(timeSeconds, SECOND_HAND_PERIOD_S);
}

/**
 * Pure function. The unit direction a hand points for a clock-face angle
 * (0 = up, clockwise), in SCREEN axes (+x right, +y DOWN). Up is (0, -1),
 * 3 o'clock (1, 0), 6 o'clock (0, 1).
 *
 *   dx = sin(θ),  dy = -cos(θ)
 *
 * @param {number} deg - clock-face angle in degrees (0 = up, clockwise)
 * @returns {{dx: number, dy: number}} unit direction in screen space
 *
 * @example clockAngleToUnitVector(0)   // {dx: 0, dy: -1} (up)
 * @example clockAngleToUnitVector(90)  // {dx: 1, dy: 0}  (right / 3 o'clock)
 * @example clockAngleToUnitVector(180) // {dx: 0, dy: 1}  (down / 6 o'clock)
 */
export function clockAngleToUnitVector(deg) {
  const r = deg * DEG;
  return { dx: tidy(Math.sin(r)), dy: tidy(-Math.cos(r)) };
}

/**
 * Pure function. The INVERSE of clockAngleToUnitVector: the clock-face angle
 * (deg, 0 = up, clockwise, in [0, 360)) of a direction (dx, dy) in screen space
 * (+y down). This turns a dragged hand-tip's offset from center into an angle.
 *
 *   θ = atan2(dx, -dy)
 *
 * @example unitVectorToClockAngle(0, -1) // 0   (up)
 * @example unitVectorToClockAngle(1, 0)  // 90  (right)
 * @example unitVectorToClockAngle(0, 1)  // 180 (down)
 * @example unitVectorToClockAngle(-1, 0) // 270 (left)
 */
export function unitVectorToClockAngle(dx, dy) {
  return wrapDegrees(Math.atan2(dx, -dy) / DEG);
}

/**
 * Pure function. The time (seconds) that places a hand of the given PERIOD at
 * `angleDeg` (0 = up, clockwise), PRESERVING the coarser time above that hand's
 * band — the render direction inverted for a hand-tip drag. Dragging a hand sets
 * ONLY its own band of the shared time:
 *   - second hand (period 60)   → seconds within the current minute
 *   - minute hand (period 3600) → minutes/seconds within the current hour
 *   - hour hand (period 43200)  → the position within the current 12 h
 *
 *   band = ⌊current / period⌋ · period            (the coarser time kept)
 *   time = band + (wrap360(angle)/360) · period    (this hand's contribution)
 *
 * @param {number} currentTimeSeconds - the clock's time before the drag
 * @param {number} periodSeconds - the dragged hand's full-revolution period
 * @param {number} angleDeg - the hand's new clock-face angle (0 = up, cw)
 * @returns {number} the new time in seconds
 *
 * @example timeFromHandAngle(0, 60, 90)       // 15    (second hand to 3 o'clock → :15)
 * @example timeFromHandAngle(0, 3600, 90)     // 900   (minute hand to 3 o'clock → 15 min)
 * @example timeFromHandAngle(0, 43200, 90)    // 10800 (hour hand to 3 o'clock → 3 h)
 * @example timeFromHandAngle(10000, 43200, 0) // 0     (hour hand to 12 keeps the same 12 h band)
 */
export function timeFromHandAngle(currentTimeSeconds, periodSeconds, angleDeg) {
  const band = Math.floor((currentTimeSeconds ?? 0) / periodSeconds) * periodSeconds;
  return band + (wrapDegrees(angleDeg) / FULL_TURN_DEG) * periodSeconds;
}

/**
 * Pure function. The clock face's LOCAL geometry: center + the INSCRIBED-circle
 * radius (min of the half-extents, so a non-square bbox still draws a true
 * circle centered in the box).
 *
 * @example faceGeom({w: 220, h: 220}) // {cx: 110, cy: 110, R: 110}
 * @example faceGeom({w: 300, h: 200}) // {cx: 150, cy: 100, R: 100}
 */
export function faceGeom(s) {
  return { cx: (s.w ?? 0) / 2, cy: (s.h ?? 0) / 2, R: Math.min(s.w ?? 0, s.h ?? 0) / 2 };
}

/**
 * Pure function. The LOCAL-space tip of a hand: from the face center along the
 * clock angle by (lengthFraction · faceRadius).
 *
 * @example handTip({cx: 110, cy: 110, R: 110}, 90, 0.5) // {x: 165, y: 110} (3 o'clock, half radius)
 * @example handTip({cx: 110, cy: 110, R: 110}, 0, 0.8)  // {x: 110, y: 22}  (12 o'clock)
 */
export function handTip(g, angleDeg, lengthFraction) {
  const d = clockAngleToUnitVector(angleDeg);
  return { x: g.cx + g.R * lengthFraction * d.dx, y: g.cy + g.R * lengthFraction * d.dy };
}

/**
 * Pure function. The LIVE hand ANCHORS of a clock, in LOCAL space: a TIP and a
 * MID point for each of the three hands, derived from the CURRENT `time` +
 * per-hand length. Because they are a pure function of `time`, they MOVE as time
 * advances (or as a hand is dragged) — a widget bound/snapped to `secondTip`
 * REVOLVES with the second hand (that is the whole point). The hands' shared
 * pivot/base is the bbox CENTER, already named by the standard `cm` anchor, so
 * these add only the moving points.
 *
 * ids (no underscores → they resolve cleanly through the evaluator's
 * `@item_anchorId.x|y` grammar, which splits on the LAST underscore):
 *   hourTip · hourMid · minuteTip · minuteMid · secondTip · secondMid
 *
 * @param {object} s - evaluated clock state ({w, h, time, *HandLength})
 * @returns {{id: string, x: number, y: number}[]} local-space anchor points
 *
 * @example handAnchorPoints({w: 220, h: 220, time: 10800, hourHandLength: 0.5, minuteHandLength: 0.72, secondHandLength: 0.85}).find((a) => a.id === "hourTip") // {id: "hourTip", x: 165, y: 110} (3:00 → hour hand east, half radius)
 * @example handAnchorPoints({w: 220, h: 220, time: 0, hourHandLength: 0.5, minuteHandLength: 0.72, secondHandLength: 0.85}).find((a) => a.id === "minuteTip") // {id: "minuteTip", x: 110, y: 30.8} (12:00 → minute hand straight up)
 * @example handAnchorPoints({w: 0, h: 0, time: 0}) // [] (degenerate clock has no hands)
 */
export function handAnchorPoints(s) {
  const g = faceGeom(s);
  if (g.R <= 0) return [];
  const time = s.time ?? 0;
  const out = [];
  for (const hand of HANDS) {
    const len = clamp(s[hand.lengthKey], MIN_HAND_LENGTH, MAX_HAND_LENGTH);
    const angle = hand.angleOf(time);
    const tip = handTip(g, angle, len);
    const mid = handTip(g, angle, len / 2);
    out.push({ id: `${hand.id}Tip`, x: tip.x, y: tip.y }, { id: `${hand.id}Mid`, x: mid.x, y: mid.y });
  }
  return out;
}

// The three hands, in DRAW order (hour under minute under second). `period` is
// the angular period; the *Key fields name the state props each hand reads. ONE
// table drives both emit() and modifierPoints() (no drift between draw + handle).
const HANDS = [
  { id: "hour", period: HOUR_HAND_PERIOD_S, angleOf: hourAngle, lengthKey: "hourHandLength", widthKey: "hourHandWidth", colorKey: "hourHandColor" },
  { id: "minute", period: MINUTE_HAND_PERIOD_S, angleOf: minuteAngle, lengthKey: "minuteHandLength", widthKey: "minuteHandWidth", colorKey: "minuteHandColor" },
  { id: "second", period: SECOND_HAND_PERIOD_S, angleOf: secondAngle, lengthKey: "secondHandLength", widthKey: "secondHandWidth", colorKey: "secondHandColor" },
];

// ── dial geometry constants (fractions of the face radius, unless noted) ──────
const NUMERAL_RADIUS_FRACTION = 0.78;    // numerals ring
const DIGIT_ADVANCE_RATIO = 0.55;        // ~advance of one digit / font size (metric-free h-centering)
const NUMERAL_VCENTER_RATIO = 0.5;       // top-origin text: raise half a font size to v-center on the point
const TICK_COUNT = 60;                   // one tick per minute mark
const TICKS_PER_HOUR = 5;                // every 5th tick is a major (hour) tick
const TICK_OUTER_FRACTION = 0.97;        // ticks start just inside the rim
const MAJOR_TICK_INNER_FRACTION = 0.86;  // hour ticks reach further in
const MINOR_TICK_INNER_FRACTION = 0.92;  // minute ticks are short
const MAJOR_TICK_WIDTH = 3;              // canvas units
const MINOR_TICK_WIDTH = 1.5;            // canvas units
const HUB_RADIUS = 6;                    // canvas units — center cap over the pivots
const HOUR_MARKS = 12;                   // numerals / hour ticks around the dial
const DEG_PER_HOUR_MARK = FULL_TURN_DEG / HOUR_MARKS; // 30° between hour marks
const MIN_HAND_LENGTH = 0.05;            // hand-tip drag radius FLOOR (fraction of R): a hand must have length
// NO upper cap: a hand MAY overhang the face (real clock designs do). Infinity mirrors the
// hand-WIDTH clamp (clamp(width, MIN_HAND_WIDTH, Infinity)) already shipped below — the render,
// anchors and the tip-drag annulus all read this, so an author can type or drag a hand past R.
const MAX_HAND_LENGTH = Infinity;
// A hand-tip drag landing EXACTLY on the pivot has no direction to read an angle
// from. This is the heading it resolves to: +y is local screen-down, i.e. 6
// o'clock — which is where unitVectorToClockAngle's own degenerate branch already
// sent it (atan2(0, -0) = π), so naming it here changes nothing and hides nothing.
const PIVOT_FALLBACK_DIR = { x: 0, y: 1 };
const MIN_HAND_WIDTH = 0.5;              // canvas units — a hand is always at least hairline-visible

// Inline Inspector row builders (the donut.js / shapeshifter.js precedent — rows
// declared in the plugin, so the shared registry needs zero edits). Category
// "formatting" files the clock knobs alongside fill/stroke, before effects.
const CAT = "formatting";
const N = (key, label, help, extra = {}) => ({ key, label, kind: "number", category: CAT, help, ...extra });
const BOOL = (key, label, help) => ({ key, label, kind: "boolean", category: CAT, help });
const COLOR = (key, label, help) => ({ key, label, kind: "color", category: CAT, help });
const FONT = (key, label, help) => ({ key, label, kind: "select", category: CAT, help, options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])) });

export const clockAnalogPlugin = {
  type: "clock_analog",
  title: "Analog Clock",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  defaults: {
    type: "clock_analog", x: 120, y: 120, w: 220, h: 220, z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // Face: a classic near-white dial with a dark rim.
    fill: "#f7f7fa", stroke: "#000000", strokeWidth: 3,
    // TIME in seconds (0 = 12:00:00) — the equation-bindable time source.
    time: 0,
    showNumerals: true, numeralFont: DEFAULT_FONT, numeralSize: 20, numeralColor: "#000000",
    showTicks: true, tickColor: "#000000",
    showSecondHand: true,
    hourHandColor: "#000000", hourHandWidth: 7, hourHandLength: 0.5,
    minuteHandColor: "#000000", minuteHandWidth: 5, minuteHandLength: 0.72,
    secondHandColor: "#e0245e", secondHandWidth: 2, secondHandLength: 0.85,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blend/innerShadow, all EFFECT-OFF
  },
  inspector: [
    ...bundle("positioning"),
    N("time", "Time (seconds)", "The clock's time in seconds since 12 o'clock (0 = 12:00:00). This is the point of the widget: bind it to a shared time source with an equation — `= time` for the live presentation clock, `= time * 3600` for an hour per second — and every instance follows. Or drag a hand's yellow tip to set it by hand. To sweep the clock across a transition, keyframe this on the two slides and let the tween do it."),
    ...props("fill", "stroke", "strokeWidth"),
    BOOL("showNumerals", "Numerals", "Draw the hour numbers 1–12 around the dial."),
    FONT("numeralFont", "Numeral font", "Typeface used for the hour numbers."),
    N("numeralSize", "Numeral size", "Height of the hour numbers, in canvas units.", { min: 1 }),
    COLOR("numeralColor", "Numeral color", "Color of the hour numbers."),
    BOOL("showTicks", "Tick marks", "Draw the 60 minute ticks, with a longer, thicker tick on each hour."),
    COLOR("tickColor", "Tick color", "Color of the tick marks."),
    BOOL("showSecondHand", "Second hand", "Show the thin, fast second hand (and its drag handle)."),
    COLOR("hourHandColor", "Hour hand color", "Color of the short hour hand."),
    N("hourHandWidth", "Hour hand width", "Thickness of the hour hand, in canvas units.", { min: MIN_HAND_WIDTH }),
    N("hourHandLength", "Hour hand length", "Length of the hour hand as a fraction of the face radius (no upper cap — it may overhang the face). Drag its yellow tip handle to spin the clock and change this length at once.", { min: MIN_HAND_LENGTH, scrub: 0.01 }),
    COLOR("minuteHandColor", "Minute hand color", "Color of the long minute hand."),
    N("minuteHandWidth", "Minute hand width", "Thickness of the minute hand, in canvas units.", { min: MIN_HAND_WIDTH }),
    N("minuteHandLength", "Minute hand length", "Length of the minute hand as a fraction of the face radius (no upper cap — it may overhang the face). Drag its tip to set the minutes.", { min: MIN_HAND_LENGTH, scrub: 0.01 }),
    COLOR("secondHandColor", "Second hand color", "Color of the second hand."),
    N("secondHandWidth", "Second hand width", "Thickness of the second hand, in canvas units.", { min: MIN_HAND_WIDTH }),
    N("secondHandLength", "Second hand length", "Length of the second hand as a fraction of the face radius (no upper cap — it may overhang the face). Drag its tip to set the seconds.", { min: MIN_HAND_LENGTH, scrub: 0.01 }),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (LOCAL space): face ellipse,
   * optional ticks + numerals, then the hour/minute/(optional second) hands and
   * a center hub. Wrapped in the shared effects bundle (all-off = pass-through).
   * A zero-radius clock emits nothing.
   */
  emit(s, _targetWorldIR, world) {
    const g = faceGeom(s);
    if (g.R <= 0) return [];
    const opacity = s.opacity ?? 1;
    const time = s.time ?? 0;
    const ops = [];

    // 1. Face (fill + optional border).
    ops.push(ellipse({
      cx: g.cx, cy: g.cy, rx: g.R, ry: g.R,
      fill: s.fill,
      stroke: (s.strokeWidth ?? 0) > 0 ? s.stroke : null,
      strokeWidth: s.strokeWidth ?? 0,
      opacity,
    }));

    // 2. Tick marks (60, every 5th a longer/thicker hour tick).
    if (s.showTicks) {
      for (let i = 0; i < TICK_COUNT; i++) {
        const major = i % TICKS_PER_HOUR === 0;
        const d = clockAngleToUnitVector(i * (FULL_TURN_DEG / TICK_COUNT));
        const innerF = major ? MAJOR_TICK_INNER_FRACTION : MINOR_TICK_INNER_FRACTION;
        ops.push(polyline({
          points: [
            [g.cx + g.R * TICK_OUTER_FRACTION * d.dx, g.cy + g.R * TICK_OUTER_FRACTION * d.dy],
            [g.cx + g.R * innerF * d.dx, g.cy + g.R * innerF * d.dy],
          ],
          width: major ? MAJOR_TICK_WIDTH : MINOR_TICK_WIDTH,
          color: s.tickColor, opacity,
        }));
      }
    }

    // 3. Numerals 1..12 (metric-free centering — good enough for 1–2 glyphs).
    if (s.showNumerals) {
      const size = s.numeralSize ?? 20;
      const font = s.numeralFont ?? DEFAULT_FONT;
      for (let n = 1; n <= HOUR_MARKS; n++) {
        const d = clockAngleToUnitVector((n % HOUR_MARKS) * DEG_PER_HOUR_MARK);
        const px = g.cx + g.R * NUMERAL_RADIUS_FRACTION * d.dx;
        const py = g.cy + g.R * NUMERAL_RADIUS_FRACTION * d.dy;
        const label = String(n);
        ops.push(text({
          text: label,
          x: px - (label.length * size * DIGIT_ADVANCE_RATIO) / 2,
          y: py - size * NUMERAL_VCENTER_RATIO,
          size, color: s.numeralColor, font, opacity,
        }));
      }
    }

    // 4. Hands (hour, minute, optional second) — each a round-capped polyline
    // from center to its tip.
    for (const hand of HANDS) {
      if (hand.id === "second" && !s.showSecondHand) continue;
      const tip = handTip(g, hand.angleOf(time), clamp(s[hand.lengthKey], MIN_HAND_LENGTH, MAX_HAND_LENGTH));
      ops.push(polyline({
        points: [[g.cx, g.cy], [tip.x, tip.y]],
        width: clamp(s[hand.widthKey], MIN_HAND_WIDTH, Infinity),
        color: s[hand.colorKey], opacity,
      }));
    }

    // 5. Center hub covering the hand pivots.
    ops.push(ellipse({ cx: g.cx, cy: g.cy, rx: HUB_RADIUS, ry: HUB_RADIUS, fill: s.hourHandColor, opacity }));

    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  hitTest(s, lx, ly) {
    const g = faceGeom(s);
    if (g.R <= 0) return false;
    const dx = lx - g.cx, dy = ly - g.cy;
    return dx * dx + dy * dy <= g.R * g.R;
  },
  /**
   * Pure function. The standard 9 bbox anchors PLUS the LIVE per-hand tip/mid
   * anchors (handAnchorPoints). The bbox center `cm` doubles as the hands' shared
   * pivot/base. Everything downstream is automatic: nodeAnchors (derive.js) wraps
   * these through node.world so they are (a) referenceable in `=` equations as
   * `@id_secondTip.x` (core/expressions.anchorValue validates + resolves them,
   * settling this clock's `time` first — so a bound widget REVOLVES as time
   * advances) and (c) drawn by the hover-copy anchor chips.
   */
  anchors(state) {
    return [...standardBBoxAnchors(state), ...handAnchorPoints(state)];
  },
  /**
   * Pure function. The live hand tip/mid points as SNAP features (b): so another
   * widget dragged near a hand tip snaps to it. nodeFeatures already contributes
   * the bbox corner/edge/center features for a bbox widget, so this adds ONLY the
   * hand points (no duplication).
   */
  snapFeatures(state) {
    return handAnchorPoints(state).map((a) => ({ kind: "point", x: a.x, y: a.y, id: a.id }));
  },
  closestAnchor(state, wx, wy, world) {
    // Radial point on the face circle toward the target (circle.js convention).
    const local = T.apply(T.invert(world), wx, wy);
    const g = faceGeom(state);
    const theta = Math.atan2(local.y - g.cy, local.x - g.cx);
    return { x: g.cx + g.R * Math.cos(theta), y: g.cy + g.R * Math.sin(theta) };
  },
  /**
   * Pure function. ONE yellow modifier point per drawn hand tip (second hand
   * only when shown). `apply` inverts the dragged LOCAL point (CanvasView has
   * already un-rotated it through node.world) into BOTH a `time` write (spin →
   * band-preserving time, timeFromHandAngle) and this hand's LENGTH prop (its
   * distance from center as a fraction of the face radius) — "spin the hands and
   * change their lengths". Writing `time` overrides any equation bound there.
   *
   * THE HANDLE-CONSTRAINT PROTOCOL (core/derive.js): the allowed set is the
   * ANNULUS between the two length clamps — the tip swings to ANY angle (that is
   * the whole point of dragging a hand) but its RADIUS is bounded, so this is the
   * two-degree-of-freedom case, not a curve. Because the face radius is the
   * INSCRIBED circle (faceGeom takes min(w, h)/2), the set is a true circle even
   * in a non-square box, so nearest-in-local is the exact metric projection with
   * no ellipse caveat.
   */
  modifierPoints(s) {
    const g = faceGeom(s);
    if (g.R <= 0) return [];
    const time = s.time ?? 0;
    return HANDS
      .filter((hand) => hand.id !== "second" || s.showSecondHand)
      .map((hand) => {
        const tip = handTip(g, hand.angleOf(time), clamp(s[hand.lengthKey], MIN_HAND_LENGTH, MAX_HAND_LENGTH));
        return {
          id: `${hand.id}Tip`,
          x: tip.x, y: tip.y,
          constrain(state, desired) {
            const gg = faceGeom(state);
            return closestPointInAnnulus({ x: gg.cx, y: gg.cy }, MIN_HAND_LENGTH * gg.R, MAX_HAND_LENGTH * gg.R, desired, PIVOT_FALLBACK_DIR);
          },
          apply(state, allowed) {
            const gg = faceGeom(state);
            const dx = allowed.x - gg.cx, dy = allowed.y - gg.cy;
            const newTime = timeFromHandAngle(state.time ?? 0, hand.period, unitVectorToClockAngle(dx, dy));
            // A zero-radius face has no radius to take a fraction OF (a technical
            // division guard — and it emits no handle to drag in the first place).
            const length = gg.R > 0 ? Math.hypot(dx, dy) / gg.R : clamp(state[hand.lengthKey], MIN_HAND_LENGTH, MAX_HAND_LENGTH);
            return { time: newTime, [hand.lengthKey]: length };
          },
        };
      });
  },
  // CROSSHAIR PLACEMENT (the circle/donut precedent): click-drag sizes the bbox,
  // a plain click drops the default 220×220 clock.
  commands: [
    { id: "add-clock_analog", title: "Add Analog Clock", icon: "mdi:clock-outline", run: (app) => app.armCrosshairPlacement(clockAnalogPlugin) },
  ],
};
