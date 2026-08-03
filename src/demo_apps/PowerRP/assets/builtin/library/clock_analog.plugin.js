// clock_analog.plugin.js — A BUILT-IN PLUGIN ASSET (core/builtin_plugin_assets.js).
//
// ANALOG CLOCK widget — a dial face with hour/minute/second hands driven by ONE
// equation-bindable number: `time`, in SECONDS since 12 o'clock. Everything
// visible is a pure function of that number, so the whole clock is PROPERTY
// STATE (CLAUDE.md's three kinds of state): bind `time` to `= time` and it
// follows the presentation clock; keyframe it across two slides and the tween
// sweeps the hands; leave it a plain number and every render is identical.
//
// ── THE HANDS ARE ANCHORS AND SNAP FEATURES, WHICH IS THE POINT ───────────────
// Each hand contributes a live TIP and MID anchor (handAnchorPoints), so another
// widget can be bound to `@clock_secondTip.x` and REVOLVE with the second hand,
// or snapped to a hand tip while dragging. Because those points are a pure
// function of `time`, nothing had to be added to make them move — the evaluator
// settles this clock's `time` first and the reference reads the result.
//
// ── DRAGGING A HAND WINDS THE CLOCK (it does not teleport it) ─────────────────
// One yellow modifier point per drawn hand tip. The HANDLE-CONSTRAINT protocol's
// two-degree-of-freedom case: the allowed set is the ANNULUS between the length
// clamps (the tip may swing to any angle — that is what dragging a hand means —
// but its radius is bounded), so `constrain` is a nearest-point-in-annulus
// projection and `apply` reads BOTH an angle and a radius out of the already-
// allowed point.
//
// The angle is integrated, NOT assigned — see unwrappedTurnDeg/windTime. Sweeping
// the second hand once around ADVANCES THE MINUTE HAND BY ONE, twice around by
// two, and sweeping back unwinds, exactly as the rotation property behaves. This
// works with NO stored gesture state because web/CanvasView.svelte's modifierDrag
// recomputes from the item's state on every pointer move and rawState() blends the
// live previewDelta in — so each `apply` observes the previous move's own write.
// THE HAND'S CURRENT ANGLE IS THE MEMORY. That is what keeps a winding gesture
// inside property state, with no history and no wall clock.
//
// ── THE PRESET MODEL IS DERIVABLE, NOT A ONE-SHOT WRITE ───────────────────────
// `preset` is an ordinary keyframable property, and every style row defaults to
// the sentinel INHERIT ("") meaning "take this from the preset". emit() resolves
// preset → values (resolveStyle) with an explicit per-row override winning. So a
// preset is re-derived on every render rather than splatted into state once:
//   - switching preset restyles the clock without clobbering rows an author set,
//   - a preset CHANGE tweens/keyframes like anything else (it is just a prop),
//   - it is idempotent under deltas — no write-amplification into slide 0,
//   - and the whole thing needs no app handle, which a plugin asset cannot have.
// The Tools-pane `presets` cards below are a CONVENIENCE on top: each writes only
// the single `preset` key, so using them stays inside this same model.
//
// ── WHY THIS IS AN ASSET, AND WHAT THE MOVE NEEDED ────────────────────────────
// Pure vector: ellipses, polylines, polygons and text over the shared registry.
// Three host bindings had to be exposed for it — `outline` (for
// closestPointInAnnulus, the handle's allowed-set solver), `wrapDegrees`/
// `FULL_TURN_DEG` (core/properties.js's angle convention, so a hand wraps exactly
// as the Inspector's angle dial draws it), and the font table (`DEFAULT_FONT`/
// `fontOptions`, for the numeral row). Each is a pure helper already part of the
// declarative plugin vocabulary. Its "Add Analog Clock" palette entry moved to
// plugins/builtin_asset_commands.js (a plugin asset may not declare `commands`),
// keeping the id `add-clock_analog`.

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v ?? lo, hi));
// Rounds tiny float dust so cos/sin of the cardinal angles land exactly on the
// axes (e.g. -cos(90°) ≈ -6e-17 → 0) — hands at 12/3/6/9 stay axis-aligned.
const TIDY_SCALE = 1e10;
const tidy = (v) => Math.round(v * TIDY_SCALE) / TIDY_SCALE;

// ── the three hands' angular PERIODS (seconds per full revolution) ────────────
const SECOND_HAND_PERIOD_S = 60;    // one minute
const MINUTE_HAND_PERIOD_S = 3600;  // one hour
const HOUR_HAND_PERIOD_S = 43200;   // twelve hours

// The half turn is the BRANCH CUT of the winding rule below. Named because it is
// load-bearing there, not because 360/2 is hard to read.
const HALF_TURN_DEG = FULL_TURN_DEG / 2;

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
function handAngleDeg(timeSeconds, periodSeconds) {
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
function hourAngle(timeSeconds) {
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
function minuteAngle(timeSeconds) {
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
function secondAngle(timeSeconds) {
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
function clockAngleToUnitVector(deg) {
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
function unitVectorToClockAngle(dx, dy) {
  return wrapDegrees(Math.atan2(dx, -dy) / DEG);
}

/**
 * Pure function. The UNWRAPPED signed turn from `prevDeg` to `nextDeg`: the
 * representative of their difference in the half-open range (-180, +180].
 * Positive = clockwise (angles increase clockwise on this face).
 *
 * THIS IS THE WINDING RULE. core/properties.js `shortestTurn` is the same idea
 * and the precedent, but it is NOT part of the plugin-asset API (only
 * `wrapDegrees`/`FULL_TURN_DEG` are exposed), so the rule is restated here in
 * terms of the two host bindings that ARE available.
 *
 * WHY INTEGRATE AT ALL. A pointer reports an ABSOLUTE heading, which is only ever
 * known modulo a full turn; writing that heading straight into a value folds it
 * into one turn and destroys turn COUNT. Taking the turn from the angle the hand
 * ALREADY holds and ADDING it accumulates instead: a hand at 350° dragged to 10°
 * advances +20°, never retreats -340°.
 *
 * The branch cut sits at the half turn, so no single integrated step may exceed
 * 180°. That is inherent to every incremental rotary (the Inspector's angle dial
 * has the same bound): a flick faster than the pointer-event rate reads as the
 * short way round.
 *
 * WHY (-180, +180] AND NOT [-180, +180). The two differ only at the antipode,
 * where the turn is a half turn either way and the sign is pure convention.
 * Landing on +180 makes a dead-opposite drag wind FORWARD, matching the clockwise
 * reading of a clock face; the naive wrap alone would give -180.
 *
 * @param {number} prevDeg - the angle currently held (any magnitude)
 * @param {number} nextDeg - the angle just measured (typically a pointer heading)
 * @returns {number} the signed turn in (-180, +180]
 *
 * @example unwrappedTurnDeg(350, 10) // 20   (past 12 the SHORT way: forward)
 * @example unwrappedTurnDeg(10, 350) // -20  (and backwards unwinds)
 * @example unwrappedTurnDeg(0, 90)   // 90
 * @example unwrappedTurnDeg(0, 180)  // 180  (the antipode winds FORWARD, by convention)
 * @example unwrappedTurnDeg(0, 0)    // 0
 * @example unwrappedTurnDeg(720, 90) // 90   (an unwrapped `prev` is congruent to itself)
 */
function unwrappedTurnDeg(prevDeg, nextDeg) {
  return HALF_TURN_DEG - wrapDegrees(HALF_TURN_DEG - (nextDeg - prevDeg));
}

/**
 * Pure function. WINDING a hand: the new clock time (seconds) after dragging the
 * hand of the given PERIOD from wherever it is to the pointer heading `angleDeg`,
 * accumulating turn count so that crossing 12 CARRIES into the coarser hands.
 *
 * This is the whole "drag the second hand around and the minute hand advances by
 * one" behaviour, and it is a two-line consequence of unwrappedTurnDeg:
 *
 *   turn = unwrappedTurnDeg(currentAngleOfThisHand, pointerAngle)   degrees
 *   time = current + (turn / 360) · period                          seconds
 *
 * Because the time is ADVANCED by a signed turn rather than RECONSTRUCTED from an
 * absolute angle, one full sweep of the second hand adds exactly its period (60 s
 * → the minute hand moves one minute), two sweeps add 120 s, and sweeping back
 * subtracts. CARRY IS ORDINARY ARITHMETIC: nothing special-cases the minute hand,
 * it simply reads the larger `time`.
 *
 * Contrast the band-preserving reconstruction this replaced, which pinned the
 * coarser digits and so made the wrap SNAP BACK: dragging the second hand from
 * :59 to :01 rewound the minute instead of advancing it. That version could never
 * carry, because it rebuilt band + fraction from scratch on every move.
 *
 * The result is CONTINUOUS across a drag: consecutive calls chain, because the
 * caller feeds back the time the previous call returned (CanvasView re-reads the
 * item's previewed state on every pointer move). No gesture state is stored
 * anywhere — the hand's own angle IS the memory, which is what keeps the widget
 * property state (CLAUDE.md's three kinds) with no wall clock and no history.
 *
 * @param {number} currentTimeSeconds - the clock's time before this step
 * @param {number} periodSeconds - the dragged hand's full-revolution period
 * @param {number} angleDeg - the pointer's clock-face angle (0 = up, cw)
 * @returns {number} the new time in seconds (may exceed 12 h, or go negative)
 *
 * @example windTime(0, 60, 90)     // 15    (second hand 12 → 3 o'clock = +15 s)
 * @example windTime(59, 60, 0)     // 60    (:59 → 12 winds FORWARD one minute, never back to 0)
 * @example windTime(60, 60, 354)   // 59    (and dragging back across 12 unwinds)
 * @example windTime(0, 3600, 90)   // 900   (minute hand to 3 o'clock = +15 min)
 * @example windTime(3540, 3600, 0) // 3600  (:59 min → 12 carries a whole HOUR)
 * @example windTime(0, 43200, 90)  // 10800 (hour hand to 3 o'clock = +3 h)
 */
function windTime(currentTimeSeconds, periodSeconds, angleDeg) {
  const current = currentTimeSeconds ?? 0;
  const turn = unwrappedTurnDeg(handAngleDeg(current, periodSeconds), angleDeg);
  return current + (turn / FULL_TURN_DEG) * periodSeconds;
}

const HOUR_MARKS = 12;                                // numerals / hour ticks around the dial
const DEG_PER_HOUR_MARK = FULL_TURN_DEG / HOUR_MARKS; // 30° between hour marks

// ── ROMAN NUMERALS, and the IIII question ────────────────────────────────────
// The subtractive pairs, largest first — the standard greedy table, truncated at
// X because a 12-hour dial never needs L or beyond. IV is DELIBERATELY ABSENT:
// see romanNumeral's docblock for the horological convention this encodes.
const ROMAN_PAIRS = [[10, "X"], [9, "IX"], [5, "V"], [4, "IIII"], [1, "I"]];

/**
 * Pure function. An integer 1..12 as the Roman numeral a CLOCK FACE uses.
 *
 * THE IIII CONVENTION (and the whole reason the table above is not the textbook
 * one). Standard Roman orthography writes four as the subtractive IV. Traditional
 * clock and watch dials overwhelmingly write IIII instead — the "clockmaker's
 * four". This widget draws CLOCK FACES, so it follows the dial convention.
 *
 * The reasons usually given, none individually decisive but jointly the settled
 * practice for centuries: IIII BALANCES the dial, because VIII sits diametrically
 * opposite and IV is visually far lighter than VIII while IIII matches its
 * weight; it keeps the face's first four numerals a pure I-count, so the dial
 * reads I·II·III·IIII / V…VIII / IX…XII as three growing groups; and in cast or
 * engraved numerals it let a maker strike a whole set from exactly seventeen I,
 * four V and four X. It is also claimed to avoid IV as the opening letters of
 * IVPPITER — a story with no contemporary support, recorded here as folklore.
 *
 * A caller who wants strict orthography does not get it from this widget: the
 * dial convention is the point of the widget. Values outside 1..12 are refused
 * LOUDLY rather than silently rendering "" — a numeral ring that quietly lost a
 * position would read as a font problem, not a caller bug.
 *
 * @param {number} n - the hour, an integer in 1..12
 * @returns {string} the numeral
 *
 * @example romanNumeral(1)  // "I"
 * @example romanNumeral(4)  // "IIII"  (the CLOCKMAKER'S four, not IV — see above)
 * @example romanNumeral(5)  // "V"
 * @example romanNumeral(8)  // "VIII"
 * @example romanNumeral(9)  // "IX"    (nine stays subtractive; only four is special)
 * @example romanNumeral(12) // "XII"
 */
function romanNumeral(n) {
  if (!Number.isInteger(n) || n < 1 || n > HOUR_MARKS)
    throw new Error(`romanNumeral: expected an integer hour in 1..${HOUR_MARKS}, got ${JSON.stringify(n)}`);
  let left = n, out = "";
  for (const [value, glyph] of ROMAN_PAIRS) {
    while (left >= value) { out += glyph; left -= value; }
  }
  return out;
}

const NUMERALS_ARABIC = "arabic", NUMERALS_ROMAN = "roman", NUMERALS_NONE = "none";
const NUMERAL_KINDS = [NUMERALS_ARABIC, NUMERALS_ROMAN, NUMERALS_NONE];
const NUMERAL_KIND_LABELS = {
  [NUMERALS_ARABIC]: "Arabic (1–12)",
  [NUMERALS_ROMAN]: "Roman (I–XII)",
  [NUMERALS_NONE]: "None",
};

/**
 * Pure function. The LABEL drawn at hour `n` for a numerals KIND. "arabic" gives
 * "1".."12", "roman" gives the dial numerals (IIII, not IV), and "none" gives ""
 * — which emit() reads as "draw no numeral at all", NOT as an empty text op (a
 * zero-glyph run still costs a shaping pass and can still antialias a box in some
 * backends; "draw nothing" has to mean "emit nothing").
 *
 * @param {number} n - the hour, 1..12
 * @param {string} kind - "arabic" | "roman" | "none"
 * @returns {string} the label, or "" for none
 *
 * @example numeralLabel(4, "arabic") // "4"
 * @example numeralLabel(4, "roman")  // "IIII"
 * @example numeralLabel(4, "none")   // ""
 * @example numeralLabel(12, "roman") // "XII"
 */
function numeralLabel(n, kind) {
  if (kind === NUMERALS_NONE) return "";
  return kind === NUMERALS_ROMAN ? romanNumeral(n) : String(n);
}

/**
 * Pure function. The numerals KIND for an item, honouring the RETIRED
 * `showNumerals` boolean.
 *
 * WHY THIS EXISTS. Before the numerals SELECT, the dial had a plain
 * `showNumerals: true` checkbox; `numerals` (arabic|roman|none) supersedes it and
 * is strictly richer. But a document saved by the old widget stores
 * `showNumerals: false` and NOTHING ELSE — so a naive read would resolve
 * `numerals` to the preset's "arabic" and hand that author back a dial with
 * twelve numbers they had explicitly switched off. A retired row must not
 * silently change a picture.
 *
 * The migration is one-way and narrow, which is what keeps it safe: it fires only
 * when `showNumerals` is exactly `false` AND `numerals` was never pinned. So an
 * author who has since chosen a kind keeps it, and `showNumerals: true` is a
 * no-op (it agreed with the default already). No current-schema document has the
 * key at all, so this costs today's render nothing.
 *
 * This mirrors the repair pipeline's "migrate LOUDLY" rule in the one register
 * available here: a plugin asset has no reporting channel, so the migration is
 * confined to the case where the legacy value is UNAMBIGUOUS.
 *
 * @param {object} s - the evaluated item state
 * @returns {string} "arabic" | "roman" | "none"
 *
 * @example resolvedNumerals({})                                    // "arabic" (default dial)
 * @example resolvedNumerals({showNumerals: false})                 // "none"   (LEGACY off is honoured)
 * @example resolvedNumerals({showNumerals: true})                  // "arabic" (legacy on = the default)
 * @example resolvedNumerals({showNumerals: false, numerals: "roman"}) // "roman" (an explicit kind WINS)
 * @example resolvedNumerals({preset: "minimal"})                   // "none"   (the preset still decides)
 */
function resolvedNumerals(s) {
  if (s.showNumerals === false && (s.numerals === INHERIT || s.numerals === undefined || s.numerals === null))
    return NUMERALS_NONE;
  return resolveStyle(s, "numerals");
}

/**
 * Pure function. The clock face's LOCAL geometry: center + the INSCRIBED-circle
 * radius (min of the half-extents, so a non-square bbox still draws a true
 * circle centered in the box).
 *
 * @example faceGeom({w: 220, h: 220}) // {cx: 110, cy: 110, R: 110}
 * @example faceGeom({w: 300, h: 200}) // {cx: 150, cy: 100, R: 100}
 */
function faceGeom(s) {
  return { cx: (s.w ?? 0) / 2, cy: (s.h ?? 0) / 2, R: Math.min(s.w ?? 0, s.h ?? 0) / 2 };
}

/**
 * Pure function. The LOCAL-space tip of a hand: from the face center along the
 * clock angle by (lengthFraction · faceRadius).
 *
 * @example handTip({cx: 110, cy: 110, R: 110}, 90, 0.5) // {x: 165, y: 110} (3 o'clock, half radius)
 * @example handTip({cx: 110, cy: 110, R: 110}, 0, 0.8)  // {x: 110, y: 22}  (12 o'clock)
 */
function handTip(g, angleDeg, lengthFraction) {
  const d = clockAngleToUnitVector(angleDeg);
  return { x: g.cx + g.R * lengthFraction * d.dx, y: g.cy + g.R * lengthFraction * d.dy };
}

// The three hands, in DRAW order (hour under minute under second). `period` is
// the angular period; the *Key fields name the state props each hand reads. ONE
// table drives emit(), the anchors AND modifierPoints() (no drift between draw +
// handle). `styled` names the hand's slice of a PRESET (see PRESETS).
const HANDS = [
  { id: "hour", period: HOUR_HAND_PERIOD_S, angleOf: hourAngle, lengthKey: "hourHandLength", widthKey: "hourHandWidth", colorKey: "hourHandColor", styled: "hourHandWidth" },
  { id: "minute", period: MINUTE_HAND_PERIOD_S, angleOf: minuteAngle, lengthKey: "minuteHandLength", widthKey: "minuteHandWidth", colorKey: "minuteHandColor", styled: "minuteHandWidth" },
  { id: "second", period: SECOND_HAND_PERIOD_S, angleOf: secondAngle, lengthKey: "secondHandLength", widthKey: "secondHandWidth", colorKey: "secondHandColor", styled: "secondHandWidth" },
];

// ── dial geometry constants (fractions of the face radius, unless noted) ──────
const DIGIT_ADVANCE_RATIO = 0.55;        // ~advance of one digit / font size (metric-free h-centering)
const NUMERAL_VCENTER_RATIO = 0.5;       // top-origin text: raise half a font size to v-center on the point
const TICK_COUNT = 60;                   // one tick per minute mark
const TICKS_PER_HOUR = 5;                // every 5th tick is a major (hour) tick
const TICK_OUTER_FRACTION = 0.97;        // ticks start just inside the rim
const HUB_RADIUS = 6;                    // canvas units — center cap over the pivots
const DEFAULT_NUMERAL_SIZE = 20;         // canvas units
const MIN_HAND_LENGTH = 0.05;            // hand-tip drag radius FLOOR (fraction of R): a hand must have length
// NO upper cap: a hand MAY overhang the face (real clock designs do). Infinity mirrors the
// hand-WIDTH clamp (clamp(width, MIN_HAND_WIDTH, Infinity)) — the render, anchors and the
// tip-drag annulus all read this, so an author can type or drag a hand past R.
const MAX_HAND_LENGTH = Infinity;
// A hand-tip drag landing EXACTLY on the pivot has no direction to read an angle
// from. This is the heading it resolves to: +y is local screen-down, i.e. 6
// o'clock — which is where unitVectorToClockAngle's own degenerate branch already
// sent it (atan2(0, -0) = π), so naming it here changes nothing and hides nothing.
const PIVOT_FALLBACK_DIR = { x: 0, y: 1 };
const MIN_HAND_WIDTH = 0.5;              // canvas units — a hand is always at least hairline-visible
// The bezel chamfer is white at this alpha over the hand's own color: light
// enough to read as a lit facet rather than a second, competing hand color.
const BEZEL_ALPHA = 0.35;

// ── THE PRESET MODEL ─────────────────────────────────────────────────────────
// INHERIT is the sentinel a style row holds when it has NOT been overridden: the
// empty string, because that is what an untouched select/number row round-trips
// as through the document and it is unambiguous against every real value (a
// length is a number, a color is "#rrggbb"). resolveStyle() reads it as "ask the
// preset", so the DEFAULTS below are all-inherit and a fresh clock is exactly its
// preset. An author who edits one row pins ONLY that row.
const INHERIT = "";

// Each preset is a full style vector: every key resolveStyle can be asked for.
// "classic" IS THE FROZEN DEFAULT LOOK — its numbers are the literal constants the
// pre-preset widget hard-coded, which is what makes emit() at all-defaults
// byte-identical to the version before any of this existed (pinned by
// tests/clock_analog_test.js). Do not "tidy" these values.
const PRESETS = {
  classic: {
    majorTickWidth: 3, majorTickLength: 0.11, minorTickWidth: 1.5, minorTickLength: 0.05,
    showMinorTicks: true, numerals: NUMERALS_ARABIC, numeralInset: 0.19,
    secondHandTaper: 0, handBezel: 0,
    hourHandWidth: 7, minuteHandWidth: 5, secondHandWidth: 2,
  },
  roman: {
    // A dressed dial: heavier hour marks, no minute ticks competing with the
    // numerals, numerals pulled in to clear the longer marks, bezelled hands.
    majorTickWidth: 4, majorTickLength: 0.14, minorTickWidth: 1, minorTickLength: 0.04,
    // NUMERAL INSET IS LARGER HERE THAN THE RADIAL CLEARANCE ALONE WOULD SUGGEST,
    // and the reason is glyph WIDTH, not ring position. A roman hour label is up
    // to four glyphs ("VIII"), so its half-width reaches much further sideways
    // than an arabic "8"; at the 1/2/4/5 positions — where the ring runs diagonally
    // past the hour ticks — that half-width is what collides with the tick, not
    // the ring radius. Measured on a 500px dial: at 0.26 the "II" overlapped its
    // own tick. Pulling the ring in clears the widest labels at every position.
    showMinorTicks: false, numerals: NUMERALS_ROMAN, numeralInset: 0.34,
    secondHandTaper: 0.7, handBezel: 0.55,
    hourHandWidth: 8, minuteHandWidth: 5.5, secondHandWidth: 1.6,
  },
  minimal: {
    // Hour batons only, no numerals at all — the Braun/Rams reading of a dial.
    majorTickWidth: 3.5, majorTickLength: 0.09, minorTickWidth: 1, minorTickLength: 0.03,
    showMinorTicks: false, numerals: NUMERALS_NONE, numeralInset: 0.19,
    secondHandTaper: 0.85, handBezel: 0.35,
    hourHandWidth: 6, minuteHandWidth: 4, secondHandWidth: 1.5,
  },
  thin: {
    // Hairline everything, full 60-tick railroad track, numerals set well in.
    majorTickWidth: 1.5, majorTickLength: 0.13, minorTickWidth: 0.75, minorTickLength: 0.06,
    showMinorTicks: true, numerals: NUMERALS_ARABIC, numeralInset: 0.28,
    secondHandTaper: 1, handBezel: 0,
    hourHandWidth: 3, minuteHandWidth: 2, secondHandWidth: 1,
  },
  // ── THE ORDER BELOW IS VIEWING DISTANCE, AND THAT IS PHYSICS, NOT TASTE ─────
  // `classic` must stay FIRST — it is DEFAULT_PRESET and the byte-frozen
  // baseline. After it the pane runs from the farthest-read dial to the nearest:
  // a terminal board across a concourse, a platform clock down a platform, a
  // school clock across a hall, a cockpit dial at arm's length under vibration, a
  // wrist. Viewing distance is exactly what sets index weight and hand mass, so
  // running the list top to bottom walks that one variable. The last three are
  // dress and graphic dials, where legibility is not the governing constraint at
  // all and the numerals move INWARD instead of the marks growing.
  // (`roman`, `minimal` and `thin` above keep their shipped values byte for byte;
  // PRESET_IDS below reorders the pane without touching them.)
  //
  // TWO SIGNATURES ARE SOURCED INVERSIONS RATHER THAN STYLING, and they are why
  // those two dials cannot be mistaken for any other in the set:
  //   diver      — minuteHandWidth (9) EXCEEDS hourHandWidth (7). The diving
  //                standard asks for "a large, easily identifiable minute hand"
  //                and for styling such that no hand can obscure another; the
  //                minute hand is the one being timed against, so it is the
  //                broadest thing on the dial. Every other dial here has the hour
  //                hand heaviest, which is the ordinary convention.
  //   sweepTimer — secondHandWidth (3.5) EXCEEDS minuteHandWidth (3). On a timer
  //                the sweep hand is the primary indicator, not the fine one.
  //
  // A PRESET CANNOT CHANGE A COLOUR (the rule stated below the model: a preset
  // restyles the DIAL, it does not repaint a chosen palette), so every entry here
  // is a GEOMETRY-ONLY reading of its archetype on whatever palette the author
  // set. That costs four archetypes outright — the field watch's and the diver's
  // white-on-black, a negative platform dial, and the railway clock's red second
  // hand — and it is the single largest constraint on this set. It is also a
  // deliberate shipped decision, not a defect: if it is ever revisited the right
  // move is a SECOND, DISJOINT palette family, since {fill, tickColor,
  // numeralColor, hourHandColor, ...} shares no key with these twelve.
  terminalBoard: {
    // Read across a concourse: the marks are enormous and there is no minute
    // track at all, because at that distance a 60-tick ring is grey noise.
    majorTickWidth: 14, majorTickLength: 0.13, minorTickWidth: 1, minorTickLength: 0.03,
    showMinorTicks: false, numerals: NUMERALS_NONE, numeralInset: 0.19,
    secondHandTaper: 0, handBezel: 0,
    hourHandWidth: 14, minuteHandWidth: 10, secondHandWidth: 3,
  },
  stationPlatform: {
    // The platform clock: bold hour batons AND a full minute track, because a
    // departure is read to the minute. No numerals — the baton positions carry it.
    majorTickWidth: 6, majorTickLength: 0.17, minorTickWidth: 2.4, minorTickLength: 0.075,
    showMinorTicks: true, numerals: NUMERALS_NONE, numeralInset: 0.19,
    secondHandTaper: 0, handBezel: 0,
    hourHandWidth: 10, minuteHandWidth: 7, secondHandWidth: 2.6,
  },
  schoolhouse: {
    // THE NUMERALS ARE THE DIAL HERE, so the hour ticks are deliberately the
    // shortest and thinnest in the set and the numeral ring is pushed OUT to 0.16
    // — nearer the rim than classic's 0.19, which only clears because those short
    // ticks leave room for it. Measured worst numeral/tick gap 9.94 on a 500px
    // dial, against classic's 4.82.
    majorTickWidth: 2, majorTickLength: 0.06, minorTickWidth: 1.2, minorTickLength: 0.04,
    showMinorTicks: true, numerals: NUMERALS_ARABIC, numeralInset: 0.16,
    secondHandTaper: 0.15, handBezel: 0,
    hourHandWidth: 9, minuteHandWidth: 6.5, secondHandWidth: 1.8,
  },
  flieger: {
    // The pilot's observation dial, and its one expressible signature is that the
    // MINUTE ticks are nearly as heavy as the hour ticks (2 against 3) — nothing
    // else in the set does that — over broad hands. The type's actual defining
    // marks, the triangle at twelve flanked by two dots and the two-ring numeral
    // layout, need per-index control and a second numeral ring, neither of which
    // this dial has; the description therefore describes what it DOES look like
    // rather than claiming a specification.
    majorTickWidth: 3, majorTickLength: 0.075, minorTickWidth: 2, minorTickLength: 0.075,
    showMinorTicks: true, numerals: NUMERALS_ARABIC, numeralInset: 0.26,
    secondHandTaper: 0.4, handBezel: 0,
    hourHandWidth: 11, minuteHandWidth: 8, secondHandWidth: 1.8,
  },
  fieldWatch: {
    // Everything subordinate to the minute track: fine marks, slim hands, and the
    // numerals pulled well in so the track is what the eye lands on.
    majorTickWidth: 2.2, majorTickLength: 0.09, minorTickWidth: 1.1, minorTickLength: 0.055,
    showMinorTicks: true, numerals: NUMERALS_ARABIC, numeralInset: 0.33,
    secondHandTaper: 0.2, handBezel: 0,
    hourHandWidth: 6, minuteHandWidth: 4.5, secondHandWidth: 1.3,
  },
  diver: {
    // Fat short luminous plots instead of numerals, and the sourced inversion:
    // the minute hand is BROADER than the hour hand (see the note above).
    majorTickWidth: 9, majorTickLength: 0.085, minorTickWidth: 1.4, minorTickLength: 0.035,
    showMinorTicks: true, numerals: NUMERALS_NONE, numeralInset: 0.19,
    secondHandTaper: 0.3, handBezel: 0.45,
    hourHandWidth: 7, minuteHandWidth: 9, secondHandWidth: 1.6,
  },
  sweepTimer: {
    // Long minute graduations to read fractions against, and the second
    // inversion: the needle-pointed sweep hand is the THICKEST on the dial.
    majorTickWidth: 3.5, majorTickLength: 0.16, minorTickWidth: 1.8, minorTickLength: 0.10,
    showMinorTicks: true, numerals: NUMERALS_NONE, numeralInset: 0.19,
    secondHandTaper: 1, handBezel: 0,
    hourHandWidth: 3, minuteHandWidth: 3, secondHandWidth: 3.5,
  },
  bulkhead: {
    // The marine bulkhead clock: short fat hour dots out at the rim, roman
    // numerals pulled deep inside them leaving a bare outer band, and the
    // heaviest chamfer available so the hands read as polished brass rather than
    // paint. Worst numeral/tick gap 63.74 — the roomiest dial in the set.
    majorTickWidth: 7, majorTickLength: 0.055, minorTickWidth: 1, minorTickLength: 0.03,
    showMinorTicks: false, numerals: NUMERALS_ROMAN, numeralInset: 0.42,
    secondHandTaper: 0.25, handBezel: 1,
    hourHandWidth: 12, minuteHandWidth: 8, secondHandWidth: 2.2,
  },
  deco: {
    // The graphic dial of the set: the deepest numeral ring (0.48) behind the
    // longest, thinnest hour rays (0.20 at 1.2 wide), leaving a wide empty band
    // at the rim. Worst numeral/tick gap 54.96.
    majorTickWidth: 1.2, majorTickLength: 0.20, minorTickWidth: 1, minorTickLength: 0.03,
    showMinorTicks: false, numerals: NUMERALS_ARABIC, numeralInset: 0.48,
    secondHandTaper: 0.6, handBezel: 0.2,
    hourHandWidth: 4.5, minuteHandWidth: 3.5, secondHandWidth: 1,
  },
};
// THE PANE ORDER, and it is NOT Object.keys(PRESETS) — the four shipped entries
// keep their positions in the map above (so a diff shows nine additions rather
// than a reshuffle) while the pane runs by viewing distance. Derived against the
// map so a preset added to one and forgotten in the other is a LOUD failure
// rather than a silently missing card.
const PRESET_IDS = ["classic", "terminalBoard", "stationPlatform", "schoolhouse", "flieger",
  "fieldWatch", "diver", "sweepTimer", "thin", "bulkhead", "roman", "deco", "minimal"];
{
  const declared = Object.keys(PRESETS).sort().join(",");
  const ordered = [...PRESET_IDS].sort().join(",");
  if (declared !== ordered)
    throw new Error(`clock_analog: PRESET_IDS and the PRESETS map disagree — [${ordered}] vs [${declared}]`);
}
const PRESET_LABELS = {
  classic: "Classic", terminalBoard: "Terminal Board", stationPlatform: "Station Platform",
  schoolhouse: "Schoolhouse", flieger: "Flieger", fieldWatch: "Field Watch",
  diver: "Diver's Bezel", sweepTimer: "Sweep Timer",
  // RENAMED from "Thin", which is a knob reading rather than a thing. This dial's
  // hairline marks over a full 60-tick minute ring ARE a chemin de fer, the term
  // of art for exactly that ring. The STORED id stays `thin`, so no document
  // migrates and resolveStyle is untouched — PRESET_LABELS is display only.
  thin: "Chemin-de-Fer",
  bulkhead: "Ship's Bulkhead", roman: "Roman", deco: "Deco Numerals", minimal: "Minimal",
};
const DEFAULT_PRESET = "classic";

/**
 * Pure function. Resolve ONE style key against the preset model: an explicit
 * value on the item WINS; the INHERIT sentinel (or a missing key) falls through
 * to the named preset; an unknown preset name falls back to the default preset
 * rather than painting `undefined` into the display list.
 *
 * This is the whole preset mechanism — it runs inside emit(), so a preset is
 * RE-DERIVED every render instead of being splatted into state once. That is what
 * makes preset a keyframable, tween-able, delta-idempotent ordinary property.
 *
 * @param {object} s - the evaluated item state
 * @param {string} key - a style key present in every PRESETS entry
 * @returns {*} the resolved value
 *
 * @example resolveStyle({}, "majorTickWidth")                                  // 3    (classic, by default)
 * @example resolveStyle({preset: "thin"}, "majorTickWidth")                    // 1.5  (the preset supplies it)
 * @example resolveStyle({preset: "thin", majorTickWidth: 9}, "majorTickWidth") // 9    (an explicit row WINS)
 * @example resolveStyle({preset: "thin", majorTickWidth: ""}, "majorTickWidth")// 1.5  (INHERIT falls through)
 * @example resolveStyle({preset: "roman"}, "numerals")                         // "roman"
 * @example resolveStyle({preset: "nonsense"}, "numerals")                      // "arabic" (unknown preset → default)
 */
function resolveStyle(s, key) {
  const own = s[key];
  if (own !== INHERIT && own !== undefined && own !== null) return own;
  return (PRESETS[s.preset] ?? PRESETS[DEFAULT_PRESET])[key];
}

/**
 * Pure function. The four corners of ONE hand's body as a TAPERED QUAD, in local
 * space: a bar from the pivot to the tip whose half-width shrinks from `width/2`
 * at the base to `width/2 · (1 - taper)` at the point. taper = 0 is a parallel
 * bar; taper = 1 comes to a true point (the classic sweep second hand).
 *
 * Returned corner order is base-left, tip-left, tip-right, base-right, which is
 * CONVEX and wound consistently — the IR's `polygon` op is convex-only, so this
 * must not be handed a self-crossing quad.
 *
 * @param {{cx: number, cy: number}} g - face geometry (only the center is read)
 * @param {{x: number, y: number}} tip - the hand's tip, local space
 * @param {number} width - the hand's width at the base, canvas units
 * @param {number} taper - 0 = parallel bar, 1 = point at the tip
 * @returns {number[][]} four [x, y] corners
 *
 * @example
 * // A hand pointing at 3 o'clock, 10 wide, coming to a full point:
 * taperedHandQuad({cx: 0, cy: 0}, {x: 100, y: 0}, 10, 1)
 * // => [[0, -5], [100, 0], [100, 0], [0, 5]]
 * @example
 * // taper 0 is a parallel bar — both ends 10 wide.
 * taperedHandQuad({cx: 0, cy: 0}, {x: 100, y: 0}, 10, 0)
 * // => [[0, -5], [100, -5], [100, 5], [0, 5]]
 */
function taperedHandQuad(g, tip, width, taper) {
  const dx = tip.x - g.cx, dy = tip.y - g.cy;
  const len = Math.hypot(dx, dy);
  // A zero-length hand has no axis to raise a perpendicular on; PIVOT_FALLBACK_DIR
  // is the same 6-o'clock heading the angle reader degenerates to, so the quad
  // stays consistent with everything else rather than becoming NaN.
  const ux = len > 0 ? dx / len : PIVOT_FALLBACK_DIR.x;
  const uy = len > 0 ? dy / len : PIVOT_FALLBACK_DIR.y;
  const px = -uy, py = ux; // unit perpendicular
  const baseHalf = width / 2;
  const tipHalf = baseHalf * (1 - clamp(taper, 0, 1));
  return [
    [tidy(g.cx + px * baseHalf), tidy(g.cy + py * baseHalf)],
    [tidy(tip.x + px * tipHalf), tidy(tip.y + py * tipHalf)],
    [tidy(tip.x - px * tipHalf), tidy(tip.y - py * tipHalf)],
    [tidy(g.cx - px * baseHalf), tidy(g.cy - py * baseHalf)],
  ];
}

/**
 * Pure function. The BEZEL highlight quad for a hand: the leading half of the
 * hand's body, so a flat vector "chamfer" can be laid over it in a lighter tint.
 * `strength` in (0, 1] scales how much of the width the highlight covers.
 *
 * Tasteful and FLAT by construction — this is a second convex polygon, not a
 * gradient and not a lighting model. A bezelled hand is two flat tones, which is
 * what reads as a chamfered metal hand at slide sizes and costs one more op.
 *
 * @param {number[][]} quad - a taperedHandQuad result (base-l, tip-l, tip-r, base-r)
 * @param {number} strength - fraction of the width the highlight covers, 0..1
 * @returns {number[][]} four [x, y] corners along the leading edge
 *
 * @example
 * // Half-strength bezel over a parallel bar: the highlight covers the
 * // leading half of the width, from the base edge inward.
 * bezelQuad([[0, -5], [100, -5], [100, 5], [0, 5]], 0.5)
 * // => [[0, -5], [100, -5], [100, 0], [0, 0]]
 */
function bezelQuad(quad, strength) {
  const f = clamp(strength, 0, 1);
  const [baseL, tipL, tipR, baseR] = quad;
  const lerp = (a, b, t) => [tidy(a[0] + (b[0] - a[0]) * t), tidy(a[1] + (b[1] - a[1]) * t)];
  return [baseL, tipL, lerp(tipL, tipR, f), lerp(baseL, baseR, f)];
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
function handAnchorPoints(s) {
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

// Inline Inspector row builders (the donut / shapeshifter precedent — rows
// declared in the plugin, so the shared registry needs zero edits). Category
// "formatting" files the clock knobs alongside fill/stroke, before effects.
const CAT = "formatting";
const N = (key, label, help, extra = {}) => ({ key, label, kind: "number", category: CAT, help, ...extra });
const BOOL = (key, label, help) => ({ key, label, kind: "boolean", category: CAT, help });
const COLOR = (key, label, help) => ({ key, label, kind: "color", category: CAT, help });
const SELECT = (key, label, help, options, optionLabels) => ({ key, label, kind: "select", category: CAT, help, options, optionLabels });
const FONT = (key, label, help) => ({ key, label, kind: "select", category: CAT, help, options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])) });

// A STYLE row is one whose default is INHERIT. The extra option/label entry for
// the sentinel is what lets the author put the row BACK to "from preset" after
// pinning it — without it, an override would be one-way.
const INHERIT_LABEL = "From preset";
const STYLE_N = (key, label, help, extra = {}) => N(key, label, `${help} Blank = inherit from the preset.`, extra);
const STYLE_SELECT = (key, label, help, options, optionLabels) =>
  SELECT(key, label, `${help} "${INHERIT_LABEL}" takes it from the preset.`, [INHERIT, ...options], { [INHERIT]: INHERIT_LABEL, ...optionLabels });

return {
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
    // THE PRESET, and the style rows that inherit from it. Every one of these is
    // INHERIT by default, so a fresh clock renders exactly PRESETS.classic — which
    // is byte-for-byte the look this widget had before presets existed.
    preset: DEFAULT_PRESET,
    numerals: INHERIT, numeralInset: INHERIT,
    majorTickWidth: INHERIT, majorTickLength: INHERIT,
    minorTickWidth: INHERIT, minorTickLength: INHERIT, showMinorTicks: INHERIT,
    secondHandTaper: INHERIT, handBezel: INHERIT,
    hourHandWidth: INHERIT, minuteHandWidth: INHERIT, secondHandWidth: INHERIT,
    // Non-inherited knobs: fonts, colors and lengths are the author's, not the
    // preset's — a preset restyles the DIAL, it does not repaint a chosen palette.
    numeralFont: DEFAULT_FONT, numeralSize: DEFAULT_NUMERAL_SIZE, numeralColor: "#000000",
    showTicks: true, tickColor: "#000000",
    showSecondHand: true,
    hourHandColor: "#000000", hourHandLength: 0.5,
    minuteHandColor: "#000000", minuteHandLength: 0.72,
    secondHandColor: "#e0245e", secondHandLength: 0.85,
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blend/innerShadow, all EFFECT-OFF
  },
  // ONE preset family, surfaced as cards in the Tools pane. Each writes ONLY the
  // `preset` key — the style rows stay INHERIT, so the cards are a shortcut into
  // the derivable model above rather than a second, competing mechanism.
  presets: PRESET_IDS.map((id) => ({
    name: PRESET_LABELS[id],
    description: {
      classic: "The default dial: arabic numerals, full minute track, flat hands.",
      terminalBoard: "The concourse clock read from across a hall: enormous hour batons, no numerals and no minute track, on the heaviest hands in the set.",
      stationPlatform: "The railway platform clock — bold hour batons over a full minute track, no numerals at all, and a broad parallel-bar second hand.",
      schoolhouse: "The institutional wall clock: heavy arabic numerals pushed out near the minute track, with the hour marks deliberately kept subordinate to them.",
      flieger: "The pilot's observation dial: numerals set inside a minute ring nearly as heavy as the hour marks, on broad hands meant to be read in a glance.",
      fieldWatch: "The military field dial — numerals pulled well inside a fine minute track, on slim hands, so the track you time against is what the eye lands on.",
      diver: "The diving dial: fat luminous plots instead of numerals, and a minute hand broader than the hour hand so the two can never be read for each other.",
      sweepTimer: "The stopwatch face — long minute graduations and a needle-pointed sweep hand that is the thickest on the dial, because it is the one being read.",
      thin: "The dress dial's fine railway-track minute ring: hairline marks all round, numerals set well in.",
      bulkhead: "The marine bulkhead clock: roman numerals pulled deep inside a bare outer band, short fat hour dots, and heavy hands fully chamfered like polished brass.",
      roman: "Dressed dial — roman numerals (IIII), heavy hour marks, bezelled hands, no minute track.",
      deco: "The nineteen-thirties mantel dial: numerals set deepest of all behind long hairline rays, leaving a wide empty band at the rim.",
      minimal: "Hour batons only, no numerals, tapered second hand.",
    }[id],
    props: { preset: id },
  })),
  inspector: [
    ...bundle("transform"),
    N("time", "Time (seconds)", "The clock's time in seconds since 12 o'clock (0 = 12:00:00). This is the point of the widget: bind it to a shared time source with an equation — `= time` for the live presentation clock, `= time * 3600` for an hour per second — and every instance follows. Or drag a hand's yellow tip to WIND it: sweeping the second hand once around advances the minute hand by one, exactly like the rotation property. To sweep the clock across a transition, keyframe this on the two slides and let the tween do it."),
    SELECT("preset", "Preset", "The dial style every blank row below inherits from. It is an ordinary property, so it keyframes and tweens like any other — and pinning a row below overrides just that row, without disturbing the rest.", PRESET_IDS, PRESET_LABELS),
    ...props("fill", "stroke", "strokeWidth"),
    STYLE_SELECT("numerals", "Numerals", "Which numerals ring the dial. Roman uses the clockmaker's IIII rather than IV.", NUMERAL_KINDS, NUMERAL_KIND_LABELS),
    STYLE_N("numeralInset", "Numeral inset", "How far IN from the rim the numerals sit, as a fraction of the face radius. Larger = further toward the center.", { min: 0, max: 0.9, scrub: 0.01 }),
    FONT("numeralFont", "Numeral font", "Typeface used for the hour numbers."),
    N("numeralSize", "Numeral size", "Height of the hour numbers, in canvas units.", { min: 1 }),
    COLOR("numeralColor", "Numeral color", "Color of the hour numbers."),
    BOOL("showTicks", "Tick marks", "Draw the dial's tick marks at all. Turn this off for a bare face."),
    STYLE_N("majorTickWidth", "Hour tick thickness", "Thickness of the 12 hour ticks, in canvas units.", { min: 0, scrub: 0.1 }),
    STYLE_N("majorTickLength", "Hour tick length", "Length of the hour ticks as a fraction of the face radius.", { min: 0, max: 0.9, scrub: 0.005 }),
    STYLE_SELECT("showMinorTicks", "Minute ticks", "Draw the 48 minute ticks between the hour ticks. Off leaves the hour marks alone on the dial.", [true, false], { true: "Show", false: "Hide" }),
    STYLE_N("minorTickWidth", "Minute tick thickness", "Thickness of the minute ticks, in canvas units.", { min: 0, scrub: 0.1 }),
    STYLE_N("minorTickLength", "Minute tick length", "Length of the minute ticks as a fraction of the face radius.", { min: 0, max: 0.9, scrub: 0.005 }),
    COLOR("tickColor", "Tick color", "Color of the tick marks."),
    STYLE_N("handBezel", "Hand bezel", "Flat chamfer highlight down the leading half of the hour and minute hands. 0 = flat hands, 1 = the highlight covers the full width.", { min: 0, max: 1, scrub: 0.02 }),
    BOOL("showSecondHand", "Second hand", "Show the thin, fast second hand (and its drag handle)."),
    STYLE_N("secondHandTaper", "Second hand taper", "How sharply the second hand narrows toward its tip. 0 = a parallel bar, 1 = a true point.", { min: 0, max: 1, scrub: 0.02 }),
    COLOR("hourHandColor", "Hour hand color", "Color of the short hour hand."),
    STYLE_N("hourHandWidth", "Hour hand width", "Thickness of the hour hand, in canvas units.", { min: MIN_HAND_WIDTH }),
    N("hourHandLength", "Hour hand length", "Length of the hour hand as a fraction of the face radius (no upper cap — it may overhang the face). Drag its yellow tip handle to wind the clock and change this length at once.", { min: MIN_HAND_LENGTH, scrub: 0.01 }),
    COLOR("minuteHandColor", "Minute hand color", "Color of the long minute hand."),
    STYLE_N("minuteHandWidth", "Minute hand width", "Thickness of the minute hand, in canvas units.", { min: MIN_HAND_WIDTH }),
    N("minuteHandLength", "Minute hand length", "Length of the minute hand as a fraction of the face radius (no upper cap — it may overhang the face). Drag its tip to wind the minutes.", { min: MIN_HAND_LENGTH, scrub: 0.01 }),
    COLOR("secondHandColor", "Second hand color", "Color of the second hand."),
    STYLE_N("secondHandWidth", "Second hand width", "Thickness of the second hand, in canvas units.", { min: MIN_HAND_WIDTH }),
    N("secondHandLength", "Second hand length", "Length of the second hand as a fraction of the face radius (no upper cap — it may overhang the face). Drag its tip to wind the seconds; one full sweep carries a minute.", { min: MIN_HAND_LENGTH, scrub: 0.01 }),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → display-list commands (LOCAL space): face ellipse,
   * optional ticks + numerals, then the hour/minute/(optional second) hands and
   * a center hub. Wrapped in the shared effects bundle (all-off = pass-through).
   * A zero-radius clock emits nothing.
   *
   * EVERY style value comes through resolveStyle, so the preset is re-derived
   * here on each render (see THE PRESET MODEL above). At all-defaults this emits
   * BYTE-IDENTICAL ops to the pre-preset widget — pinned by
   * tests/clock_analog_test.js, which is the regression gate for this file.
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

    // 2. Tick marks. The hour ticks always draw; the minute ticks are a resolved
    // toggle, and each family has its own thickness + length.
    if (s.showTicks) {
      const showMinor = resolveStyle(s, "showMinorTicks");
      const majorWidth = resolveStyle(s, "majorTickWidth");
      const minorWidth = resolveStyle(s, "minorTickWidth");
      // TIDIED, and this is load-bearing rather than cosmetic: a tick's inner
      // fraction used to be a literal constant (0.86 / 0.92) and is now
      // outer - length. That subtraction is not exact in binary — 0.97 - 0.05 is
      // 0.9199999999999999, not 0.92 — which moved every minor tick by ~1e-14 and
      // broke the byte-identical-at-defaults gate. tidy() snaps it back, so the
      // author-facing "length" row and the frozen default geometry agree exactly.
      const majorInner = tidy(TICK_OUTER_FRACTION - resolveStyle(s, "majorTickLength"));
      const minorInner = tidy(TICK_OUTER_FRACTION - resolveStyle(s, "minorTickLength"));
      for (let i = 0; i < TICK_COUNT; i++) {
        const major = i % TICKS_PER_HOUR === 0;
        if (!major && !showMinor) continue;
        const d = clockAngleToUnitVector(i * (FULL_TURN_DEG / TICK_COUNT));
        const innerF = major ? majorInner : minorInner;
        ops.push(polyline({
          points: [
            [g.cx + g.R * TICK_OUTER_FRACTION * d.dx, g.cy + g.R * TICK_OUTER_FRACTION * d.dy],
            [g.cx + g.R * innerF * d.dx, g.cy + g.R * innerF * d.dy],
          ],
          width: major ? majorWidth : minorWidth,
          color: s.tickColor, opacity,
        }));
      }
    }

    // 3. Numerals (metric-free centering — good enough for 1–4 glyphs).
    // "none" emits NOTHING rather than empty text ops. Read through
    // resolvedNumerals so a document saved with the RETIRED `showNumerals: false`
    // still comes back with a bare dial rather than silently regaining numbers.
    const numerals = resolvedNumerals(s);
    if (numerals !== NUMERALS_NONE) {
      const size = s.numeralSize ?? DEFAULT_NUMERAL_SIZE;
      const font = s.numeralFont ?? DEFAULT_FONT;
      const ringF = tidy(TICK_OUTER_FRACTION - resolveStyle(s, "numeralInset")); // tidy: see the tick fractions above
      for (let n = 1; n <= HOUR_MARKS; n++) {
        const d = clockAngleToUnitVector((n % HOUR_MARKS) * DEG_PER_HOUR_MARK);
        const px = g.cx + g.R * ringF * d.dx;
        const py = g.cy + g.R * ringF * d.dy;
        const label = numeralLabel(n, numerals);
        ops.push(text({
          text: label,
          x: px - (label.length * size * DIGIT_ADVANCE_RATIO) / 2,
          y: py - size * NUMERAL_VCENTER_RATIO,
          size, color: s.numeralColor, font, opacity,
        }));
      }
    }

    // 4. Hands (hour, minute, optional second). A hand with NO taper and NO bezel
    // is the original round-capped polyline — that exact op, not an equivalent —
    // which is what keeps the default emit byte-identical. Taper or bezel promotes
    // it to convex polygons (the IR's polygon op is convex-only; both helpers
    // return wound quads).
    const taper = clamp(resolveStyle(s, "secondHandTaper"), 0, 1);
    const bezel = clamp(resolveStyle(s, "handBezel"), 0, 1);
    for (const hand of HANDS) {
      if (hand.id === "second" && !s.showSecondHand) continue;
      const width = clamp(resolveStyle(s, hand.styled), MIN_HAND_WIDTH, Infinity);
      const tip = handTip(g, hand.angleOf(time), clamp(s[hand.lengthKey], MIN_HAND_LENGTH, MAX_HAND_LENGTH));
      // Taper applies to the SECOND hand only (it is the sweep hand); bezel is the
      // hour/minute chamfer. A hand with neither stays a polyline.
      const handTaper = hand.id === "second" ? taper : 0;
      const handBezel = hand.id === "second" ? 0 : bezel;
      if (handTaper <= 0 && handBezel <= 0) {
        ops.push(polyline({ points: [[g.cx, g.cy], [tip.x, tip.y]], width, color: s[hand.colorKey], opacity }));
        continue;
      }
      const quad = taperedHandQuad(g, tip, width, handTaper);
      ops.push(polygon({ points: quad, fill: s[hand.colorKey], opacity }));
      if (handBezel > 0)
        // The chamfer is WHITE at BEZEL_ALPHA over the hand's own color, so it
        // lightens whatever palette the author chose instead of introducing a
        // second color that would have to be kept in sync with the hand's.
        ops.push(polygon({ points: bezelQuad(quad, handBezel), fill: "#ffffff", opacity: opacity * BEZEL_ALPHA }));
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
   * these through node.world so they are referenceable in `=` equations as
   * `@id_secondTip.x` (core/expressions.anchorValue validates + resolves them,
   * settling this clock's `time` first — so a bound widget REVOLVES as time
   * advances) and drawn by the hover-copy anchor chips.
   */
  anchors(state) {
    return [...standardBBoxAnchors(state), ...handAnchorPoints(state)];
  },
  /**
   * Pure function. The live hand tip/mid points as SNAP features: so another
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
   * already un-rotated it through node.world) into BOTH a `time` write and this
   * hand's LENGTH prop — "wind the hands and change their lengths".
   *
   * THE WINDING SEMANTICS (the reason this is not a plain angle write). `apply`
   * INTEGRATES: it takes the turn from where the hand currently is to the pointer
   * (unwrappedTurnDeg) and ADDS the corresponding time. So a sweep past 12 CARRIES
   * into the coarser hands — one full turn of the second hand advances the minute
   * hand by exactly one, two turns by two — and reversing UNWINDS. There is no
   * snap or jump at the wrap, because no angle is ever reconstructed from scratch.
   *
   * This needs NO stored gesture state: modifierDrag recomputes from the item's
   * state each move and rawState() blends the live previewDelta in, so each call
   * sees its predecessor's own write. The hand's current angle IS the memory —
   * which is what keeps a winding gesture inside property state.
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
            return outline.closestPointInAnnulus({ x: gg.cx, y: gg.cy }, MIN_HAND_LENGTH * gg.R, MAX_HAND_LENGTH * gg.R, desired, PIVOT_FALLBACK_DIR);
          },
          apply(state, allowed) {
            const gg = faceGeom(state);
            const dx = allowed.x - gg.cx, dy = allowed.y - gg.cy;
            const newTime = windTime(state.time ?? 0, hand.period, unitVectorToClockAngle(dx, dy));
            // A zero-radius face has no radius to take a fraction OF (a technical
            // division guard — and it emits no handle to drag in the first place).
            const length = gg.R > 0 ? Math.hypot(dx, dy) / gg.R : clamp(state[hand.lengthKey], MIN_HAND_LENGTH, MAX_HAND_LENGTH);
            return { time: newTime, [hand.lengthKey]: length };
          },
        };
      });
  },
  // CROSSHAIR PLACEMENT (the circle/donut precedent): click-drag sizes the bbox,
  // a plain click drops the default 220×220 clock. "Add Analog Clock" lives in
  // plugins/builtin_asset_commands.js (a plugin asset may not declare `commands`).
};
