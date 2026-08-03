/**
 * NODE KNOBS — the dials on a module's face, and the geometry the painter, the
 * hit test and the drag all read.
 *
 * ── THE FOUNDING ASK (user, 2026-08-02, verbatim) ───────────────────────────
 * "we'll have knobs on them that I can... If I double click the module, I can
 * start playing with the knobs in it"
 *
 * Two claims, and they are separable:
 *   THE KNOBS ARE PART OF THE MODULE. "knobs on them" — a knob is on the module's
 *     FACE, the way it is on a hardware panel and the way it is in Audulus. So a
 *     knob is PAINTED by the plugin's emit(), always, into the ordinary display
 *     list. It is in exports, in the PDF, in cli/render.js. A module whose knobs
 *     appear only while you are editing is a module that looks unfinished in the
 *     one place it matters, which is the slide.
 *   DOUBLE-CLICK MAKES THEM PLAYABLE. "if I double click the module, I can start
 *     playing with the knobs" — the double-click does not CREATE the knobs, it
 *     hands you the ability to turn them. That is KNOB FOCUS (web/knobFocus.js),
 *     an ordinary activate MODE, and it is what stops a knob from stealing the
 *     press that moves the node.
 *
 * ── WHY A KNOB IS NOT A `modifierPoint` ─────────────────────────────────────
 * It is a close call and worth writing down, because modifierPoints is exactly
 * "a draggable handle that writes one parameter" and that is what a knob is.
 * The reason it cannot be one: `modifierPoints(state)` is a pure function of
 * ITEM STATE, and the overlay shows them for any single selection. A knob must
 * appear as an affordance only inside knob focus, which is APP state, not
 * document state. Gating them on a stored flag would put an editor mode into
 * every saved document — a `knobFocus: true` leaf that tweens across slides and
 * survives a reload, which is nonsense. So the LOOK is display-list (always) and
 * the GESTURE is a mode (transient), and this module is what keeps the two
 * describing the same circle.
 *
 * ── THE TASTE (ADDENDUM 6: Audulus, and never gaudy) ────────────────────────
 * An Audulus knob is a thin ring with a value ARC drawn on it and a short
 * pointer line — no bevel, no gloss, no metal, no tick marks. It reads at a
 * glance and it stays quiet in a wall of forty modules. That is what is drawn
 * here: a track ring in the node's own rim colour, an arc from the minimum to
 * the current value in the node's family accent, one pointer line, and the
 * label under it. Nothing else. The temptation to add tick marks, a shadow, or a
 * chrome cap is the gaudy failure the ruling names, and it is refused on
 * purpose.
 *
 * ── THE SWEEP IS 270°, WHICH IS NOT ARBITRARY ───────────────────────────────
 * A dial with a full 360° sweep has no visible ZERO — minimum and maximum land
 * on the same point and the pointer's meaning becomes ambiguous. Every hardware
 * knob and every plugin UI leaves a gap at the bottom for exactly this reason.
 * 270° with the gap centred at the bottom is the near-universal convention, so
 * it is what a user already knows how to read.
 *
 * DOM-free and painter-free: this module computes NUMBERS and returns records.
 * core/node_chrome.js turns them into display-list ops (it is the module that
 * may import the painter); web/knobFocus.js turns a drag into a value. Both read
 * the same layout, which is what stops a knob from being drawn anywhere other
 * than where it can be turned — the same law core/nodeflow.portLayout states for
 * the beads.
 */

/**
 * The dial's angular sweep, in radians, and where it starts.
 *
 * START is measured the way canvas/SVG measure: 0 is the +x axis and angles
 * increase CLOCKWISE (y grows downward). 135° puts the minimum at the lower
 * left; sweeping 270° clockwise from there ends at the lower right, leaving a
 * 90° gap centred at the bottom.
 */
export const KNOB_START_ANGLE = (135 * Math.PI) / 180;
export const KNOB_SWEEP_ANGLE = (270 * Math.PI) / 180;

/** The dial's DEFAULT radius in LOCAL units, and the stroke width of its ring.
 *  Small: a node is 150 wide and must hold several of these plus its ports.
 *
 *  A layout record MAY carry its own `r` and the KNOB control node does — it is
 *  one large dial that IS the widget rather than one of a band of small ones.
 *  Read it through `knobRadius` so the painter, the hit test and the overlay
 *  cannot disagree about how big a given dial is (the same one-source rule
 *  `knobLayout` states for where a dial sits). */
export const KNOB_R = 13;
export const KNOB_TRACK_WIDTH = 3;

/** Horizontal pitch between knob centres. */
export const KNOB_PITCH_X = 44;


/** The gap between the dial's bottom and its label's baseline. */
export const KNOB_LABEL_GAP = 11;
/** The knob label's type size — smaller than a port label, because there are
 *  more of them and they sit closer together. */
export const KNOB_LABEL_SIZE = 8;

/**
 * The vertical space one knob row occupies INCLUDING its label — and it is
 * DERIVED from the parts rather than chosen, because choosing it got it wrong.
 *
 * ── THE MEASURED DEFECT (BV, 2026-08-03) ────────────────────────────────────
 * It was 40, and a row genuinely needs 2·KNOB_R + KNOB_LABEL_GAP +
 * KNOB_LABEL_SIZE = 45. So on ANY module with two rows of dials, the first
 * row's labels were painted 5px INTO the second row's dials — the mixer and the
 * ambience pad have had this since knobs landed. It was found on a rendered
 * still of a six-knob module and is invisible to every test, because nothing
 * asserts that two ops do not overlap.
 *
 * A derived value cannot drift back: change the dial's radius or its label's
 * size and the row grows to fit, rather than silently re-colliding. The `+ 4` is
 * breathing room between a label's baseline and the next dial's top edge, which
 * is the only part of this that is taste rather than arithmetic.
 */
export const KNOB_ROW_GAP = 4;
export const KNOB_ROW_H = KNOB_R * 2 + KNOB_LABEL_GAP + KNOB_LABEL_SIZE + KNOB_ROW_GAP;
/** The live VALUE readout's type size, shown under the label only while the
 *  knob is being turned (the number matters exactly while you are changing it). */
export const KNOB_VALUE_SIZE = 9;

/**
 * How many LOCAL units of vertical drag sweep a knob from its minimum to its
 * maximum. Larger than the knob itself ON PURPOSE: a dial you can slam from end
 * to end in 26 px of travel cannot be set to anything in between. 150 units is
 * roughly a node's own width, which is a comfortable full-scale gesture.
 */
export const KNOB_DRAG_SPAN = 150;

/** What the FINE modifier divides the gesture's sensitivity by. 8 gives roughly
 *  1200 units of travel for full scale — enough to place a filter cutoff to the
 *  hertz without the drag leaving the screen. */
export const KNOB_FINE_DIVISOR = 8;

/**
 * Pure function. A knob's value as a FRACTION of its range, clamped to [0, 1].
 *
 * Linear in the value, deliberately, even for a frequency knob that a
 * logarithmic taper would serve better musically. The reason is honesty about
 * one number: the Inspector row for the same property is a linear number field
 * over the same min/max, and a dial whose position disagreed with the slider
 * beside it would be two controls telling different stories about one value. A
 * per-knob `taper` is the right way to add this later — declared in the spec, so
 * BOTH surfaces read it — not a curve hidden in the dial.
 *
 * @param {number} value - the knob's current value
 * @param {number} min - range minimum
 * @param {number} max - range maximum
 * @returns {number} in [0, 1]
 *
 * @example knobFraction(500, 0, 1000) // 0.5
 * @example knobFraction(20, 20, 20000) // 0
 * @example // out of range is CLAMPED, not refused: an equation may briefly overshoot
 * @example knobFraction(-5, 0, 10) // 0
 * @example knobFraction(50, 0, 10) // 1
 * @example // a degenerate range has no fraction to report; 0 is the quiet answer
 * @example knobFraction(7, 5, 5) // 0
 */
export function knobFraction(value, min, max) {
  if (!(max > min)) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/**
 * Pure function. The inverse: a fraction of the sweep back to a value.
 *
 * @param {number} fraction - in [0, 1] (clamped)
 * @param {number} min - range minimum
 * @param {number} max - range maximum
 * @returns {number}
 *
 * @example knobValue(0.5, 0, 1000) // 500
 * @example knobValue(0, 20, 20000) // 20
 * @example knobValue(1.4, 0, 10) // 10
 * @example knobValue(0.25, 5, 5) // 5
 */
export function knobValue(fraction, min, max) {
  if (!(max > min)) return min;
  return min + Math.max(0, Math.min(1, fraction)) * (max - min);
}

/**
 * Pure function. A value snapped to its knob's `step`, when it declares one.
 *
 * A step of 1 on a "Steps" knob is what makes a dial land on 16 rather than on
 * 15.87 — and the Inspector row for the same property already declares that
 * step, so reading it here is what keeps the two surfaces writing the same kind
 * of number. A knob with no declared step is left alone: a filter cutoff is
 * genuinely continuous and rounding it would be inventing a grid.
 *
 * SNAPPING IS RELATIVE TO `min`, not to zero. A knob running 20..20000 in steps
 * of 100 should be able to sit at its own minimum; snapping to a zero-anchored
 * grid would make 20 unreachable, which is the one value such a knob certainly
 * has.
 *
 * @param {number} value - the raw value
 * @param {{step?: number, min?: number}} knob - the knob's declaration
 * @returns {number}
 *
 * @example knobSnap(15.87, {step: 1, min: 1}) // 16
 * @example // no step declared: continuous, left exactly as it is
 * @example knobSnap(1234.567, {min: 20}) // 1234.567
 * @example // the grid is anchored at MIN, so the minimum itself is always reachable
 * @example knobSnap(20, {step: 100, min: 20}) // 20
 * @example knobSnap(0.4, {step: 0.25, min: 0}) // 0.5
 */
export function knobSnap(value, knob) {
  const step = knob?.step;
  if (!(typeof step === "number" && step > 0)) return value;
  const base = typeof knob.min === "number" ? knob.min : 0;
  const snapped = base + Math.round((value - base) / step) * step;
  // Re-round to the step's own decimal places: 0 + 3 * 0.1 is 0.30000000000000004
  // in binary floating point, and a knob readout showing that is a bug the user
  // sees. Deriving the places from the step rather than fixing a constant keeps
  // a step of 0.001 exact too.
  const places = decimalPlacesOf(step);
  return Number(snapped.toFixed(places));
}

/**
 * Pure function. How many decimal places a step implies — the precision its own
 * spelling carries.
 *
 * @param {number} step - a positive step size
 * @returns {number} decimal places, 0..12
 *
 * @example decimalPlacesOf(1) // 0
 * @example decimalPlacesOf(0.25) // 2
 * @example decimalPlacesOf(0.001) // 3
 * @example // an exponential spelling still reports its true precision
 * @example decimalPlacesOf(1e-4) // 4
 */
export function decimalPlacesOf(step) {
  const s = String(step);
  if (s.includes("e-")) return Math.min(12, Number(s.split("e-")[1]));
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : Math.min(12, s.length - dot - 1);
}

/**
 * Pure function. Where a knob's pointer sits, as an ANGLE in radians.
 *
 * @param {number} fraction - in [0, 1]
 * @returns {number} radians, canvas convention (0 = +x, clockwise)
 *
 * @example // the minimum sits at the lower LEFT, 135 degrees round from +x
 * @example knobAngle(0) === KNOB_START_ANGLE // true
 * @example // and the maximum a further 270 degrees clockwise, at the lower right
 * @example knobAngle(1) === KNOB_START_ANGLE + KNOB_SWEEP_ANGLE // true
 * @example // half way is straight up (405 degrees = 45 degrees, pointing up-right… no:
 * @example // 135 + 135 = 270 degrees, which with y DOWN is straight up)
 * @example Math.round((knobAngle(0.5) * 180) / Math.PI) // 270
 */
export function knobAngle(fraction) {
  return KNOB_START_ANGLE + Math.max(0, Math.min(1, fraction)) * KNOB_SWEEP_ANGLE;
}

/**
 * Pure function. A point on the dial's circle at a given fraction.
 *
 * @param {{cx: number, cy: number}} centre - the dial centre, LOCAL
 * @param {number} radius - distance from the centre
 * @param {number} fraction - in [0, 1]
 * @returns {{x: number, y: number}} LOCAL
 *
 * @example // at fraction 0.5 the pointer is straight UP from the centre (x is a
 * @example // float-dust 1.8e-15 rather than a clean 0 — cos(3pi/2) always is)
 * @example knobPoint({cx: 0, cy: 0}, 10, 0.5).y // -10
 * @example Math.abs(knobPoint({cx: 0, cy: 0}, 10, 0.5).x) < 1e-9 // true
 * @example Math.round(knobPoint({cx: 100, cy: 50}, 10, 0).x) // 93
 */
export function knobPoint(centre, radius, fraction) {
  const a = knobAngle(fraction);
  return { x: centre.cx + radius * Math.cos(a), y: centre.cy + radius * Math.sin(a) };
}

/**
 * Pure function. The SVG path `d` for a dial's arc from fraction `from` to
 * fraction `to` — the track when it runs 0..1, the value fill when it runs
 * 0..current.
 *
 * A degenerate arc (from === to) still returns a valid one-point path rather
 * than an empty string, because render_gpu/ir.path REFUSES an empty `d`: a knob
 * sitting exactly at its minimum is an ordinary state, not an error, and it must
 * paint as "no fill yet" rather than throw mid-render.
 *
 * @param {{cx: number, cy: number}} centre - dial centre, LOCAL
 * @param {number} radius - the arc's radius
 * @param {number} from - start fraction
 * @param {number} to - end fraction
 * @returns {string} an SVG path
 *
 * @example knobArcPath({cx: 0, cy: 0}, 10, 0, 0).startsWith("M ") // true
 * @example // a >180 degree sweep sets the large-arc flag; the full 270 does
 * @example knobArcPath({cx: 0, cy: 0}, 10, 0, 1).includes(" 1 1 ") // true
 * @example // a quarter of the sweep (67.5 degrees) does not
 * @example knobArcPath({cx: 0, cy: 0}, 10, 0, 0.25).includes(" 0 1 ") // true
 */
export function knobArcPath(centre, radius, from, to) {
  const a = knobPoint(centre, radius, from);
  const b = knobPoint(centre, radius, to);
  const sweptRadians = Math.abs(to - from) * KNOB_SWEEP_ANGLE;
  if (sweptRadians < 1e-9) return `M ${round(a.x)} ${round(a.y)}`;
  const largeArc = sweptRadians > Math.PI ? 1 : 0;
  // sweepFlag 1 = clockwise, which is the direction knobAngle increases in.
  return `M ${round(a.x)} ${round(a.y)} A ${round(radius)} ${round(radius)} 0 ${largeArc} 1 ${round(b.x)} ${round(b.y)}`;
}

/** Six places: enough that a path is exact at any zoom, short enough that a
 *  display list of forty knobs is not mostly digits. */
const round = (n) => Number(n.toFixed(6));

/**
 * How far a knob band may be SHRUNK before it stops shrinking and starts
 * clipping. Below roughly a third of full size a dial's arc is a few pixels of
 * ink, its pointer is shorter than the stroke that draws it, and its label is
 * sub-pixel — the picture is no longer a knob, it is a smudge that still eats
 * presses. Past this floor the band is honestly too big for the card, and the
 * registry docblock's rule applies: SHOW the overflow rather than hide it, so
 * the author can see the node is too short and drag it taller.
 */
export const KNOB_BAND_MIN_SCALE = 1 / 3;

/**
 * Pure function. THE RESIZE SEAM — the uniform scale a node's knob band is drawn
 * at so it fits inside the RESOLVED BOX, and 1 when it already does.
 *
 * ── THE DEFECT THIS EXISTS FOR (workstream CD, user 2026-08-03, verbatim) ───
 * "Also looks at this stupid shit when I resize a widget lmao the knobs stay in
 * place and the module knobs are floating"
 *
 * Everything below a node's header used to be laid out from the TOP with fixed
 * pixel constants — port rows at PORT_TOP_INSET + i·PORT_PITCH, the readout one
 * gap under those, the knob band one gap under THAT. Not one of those offsets
 * ever read `h`. So `readoutNodeHeight` computed a natural height at which the
 * whole stack fitted, and the moment an author dragged the card shorter than
 * that, the band kept its absolute offsets and simply carried on past the bottom
 * rim. MEASURED on the Mixer at its own defaults (w 150, h 355): its five dials
 * sit at y 244…306. Shrink it to h 200 and they are still at 244…306 — the four
 * port rows are inside the frame and every dial is below it, detached, which is
 * exactly the screenshot.
 *
 * ── WHY A SCALE AND NOT A CLAMP ─────────────────────────────────────────────
 * Clamping the band's TOP upward would slide the dials over the port rows and
 * the readout, trading one collision for a worse one. Refusing the resize (a
 * minimum height) would take away a size the author asked for, and the founding
 * ask has nodes on slides at whatever size the slide needs. Scaling keeps the
 * band's INTERNAL rhythm exactly as designed — dial, gap, label — and just draws
 * the whole of it smaller, which is the one option that both fits and stays
 * legible as the same object.
 *
 * ── AND WHY THE SCALE IS UNIFORM ────────────────────────────────────────────
 * Squeezing only the vertical would give an oval dial, and a dial's whole reading
 * is its pointer's ANGLE — an oval one reads its angle wrong at every position
 * except the axes. So the dial radius, the row pitch, the label gap and the label
 * size all take the same factor, and a scaled band is the band photographed
 * smaller rather than a different band.
 *
 * ── AN ABSENT HEIGHT IS "UNCONSTRAINED", NOT "ZERO ROOM" ───────────────────
 * A caller that passes no height has not said the card is short — it has said
 * nothing about the card at all, which several pure-geometry callers legitimately
 * do (they want the band's SHAPE, not its fit). Reading that silence as a
 * zero-height box would scale every such layout straight to the floor and hand
 * back a band of smudges, so the honest answer to "no height given" is 1.
 * A height that IS given and is zero is a different statement and does scale.
 *
 * @param {number} bandTop - LOCAL y the band starts at
 * @param {number} rows - how many knob rows the band wraps to
 * @param {number} [boxH] - the node's RESOLVED height (already sign-normalized);
 *     absent or non-finite = unconstrained
 * @returns {number} a factor in [KNOB_BAND_MIN_SCALE, 1]
 *
 * @example // a card with room to spare draws its band at full size
 * @example knobBandScale(60, 1, 200) // 1
 * @example // one row needs KNOB_ROW_H (49); a card leaving exactly that is full size
 * @example knobBandScale(60, 1, 109) // 1
 * @example // half the room, half the band — the dials shrink instead of escaping
 * @example knobBandScale(60, 2, 109) // 0.5
 * @example // absurdly short: the shrink stops at the floor and the band clips, visibly
 * @example knobBandScale(60, 4, 70) // 0.3333333333333333
 * @example // a band that starts past the bottom rim has no room at all: the floor
 * @example knobBandScale(300, 1, 100) // 0.3333333333333333
 * @example // NO height given is not a short card — it is no statement about one
 * @example knobBandScale(60, 4, undefined) // 1
 */
export function knobBandScale(bandTop, rows, boxH) {
  const need = Math.max(0, rows) * KNOB_ROW_H;
  if (need <= 0) return 1;
  if (!Number.isFinite(boxH)) return 1;
  const room = boxH - bandTop;
  if (room >= need) return 1;
  return Math.max(KNOB_BAND_MIN_SCALE, room / need);
}

/**
 * Pure function. THE KNOB LAYOUT — where every turnable knob of a node sits, in
 * LOCAL coordinates. The ONE geometry the painter and the hit test both read.
 *
 * ── WHICH KNOBS GET A DIAL ──────────────────────────────────────────────────
 * The CONTINUOUS ones. A `discrete` knob (a waveform name, a reverb character)
 * is a choice among names, and a dial that lands between "sine" and "square" is
 * meaningless — worse, several of them are `construct: true`, so a drag across
 * them would rebuild the engine module on every pointermove. Those stay in the
 * Inspector, where a select row says what they are. That is not a gap: it is the
 * difference between a knob and a switch, and hardware makes the same one.
 *
 * A knob whose value is an EQUATION is still laid out (the dial must SHOW where
 * a bound value currently sits) but is marked `bound`, and web/knobFocus.js
 * refuses to turn it — overwriting an equation with the number it happens to
 * evaluate to is the destruction interiorNav already refuses for the same
 * reason.
 *
 * ── THE ROW LAYOUT, AND WHY IT STARTS BELOW THE PORTS ───────────────────────
 * Knobs go in the band under the last port row, wrapped to as many rows as fit
 * the node's width. That is the same band the readout uses, which is why
 * `knobBandTop` is passed in rather than computed here: core/audio_nodes.js owns
 * the vertical stack of a node's body and this module must not grow a second
 * opinion about it.
 *
 * ── EVERY RECORD CARRIES ITS OWN `stateKey` (BV, 2026-08-03) ────────────────
 * The item-state key a turn writes to is now ON the layout record, supplied by
 * the caller. web/knobFocus.js used to derive it by prefixing "audio", which was
 * correct while audio modules were the only widgets with dials and was written
 * down at the time as a thing to remove: "When that happens the key belongs ON
 * the layout record and this function goes away." That happened — the KNOB and
 * SLIDER control nodes store their value in a plain `value` leaf with no prefix
 * at all, and a mode that guessed the key from the knob's name would have
 * written `audioValue` into a widget that has no such property, silently doing
 * nothing to the sound while the dial appeared to move.
 *
 * `stateKeyOf` defaults to the knob's own key, which is the identity a
 * non-prefixing widget wants.
 *
 * @param {Array<object>} knobs - the spec's knob declarations, in order
 * @param {object} state - the folded item state (its `w` decides the wrap)
 * @param {number} bandTop - LOCAL y the knob band starts at
 * @param {function} valueOf - (knob) → its current value, or a non-number when bound
 * @param {function} [stateKeyOf] - (knob) → the flat item-state key it writes to
 * @returns {Array<object>} [{key, stateKey, label, cx, cy, min, max, step, unit, value, fraction, bound}]
 *
 * @example // one continuous knob centres itself in the first row of the band
 * @example knobLayout([{key: "cutoff", label: "Cutoff", min: 20, max: 20000}], {w: 150}, 60, () => 800).length // 1
 * @example knobLayout([{key: "cutoff", label: "Cutoff", min: 20, max: 20000}], {w: 150}, 60, () => 800)[0].key // "cutoff"
 * @example // a DISCRETE knob is not a dial and is left out entirely
 * @example knobLayout([{key: "waveform", discrete: true, options: []}], {w: 150}, 60, () => "sine") // []
 * @example // a knob holding an equation is laid out but flagged, so it can be shown and refused
 * @example knobLayout([{key: "q", label: "Q", min: 0, max: 10}], {w: 150}, 60, () => "= ease(time)")[0].bound // true
 * @example // three knobs on a 150-wide node wrap to a second row
 * @example knobLayout([{key: "a"}, {key: "b"}, {key: "c"}, {key: "d"}], {w: 150}, 60, () => 0)[3].cy > knobLayout([{key: "a"}, {key: "b"}, {key: "c"}, {key: "d"}], {w: 150}, 60, () => 0)[0].cy // true
 * @example // the state key defaults to the knob's own name…
 * @example knobLayout([{key: "value", min: 0, max: 1}], {w: 150}, 60, () => 0.5)[0].stateKey // "value"
 * @example // …and a widget that namespaces its knobs says so
 * @example knobLayout([{key: "q", min: 0, max: 1}], {w: 150}, 60, () => 0.5, (k) => "audio" + k.key)[0].stateKey // "audioq"
 */
export function knobLayout(knobs, state, bandTop, valueOf, stateKeyOf = (k) => k.key) {
  const dials = (knobs ?? []).filter((k) => !k.discrete);
  if (dials.length === 0) return [];
  // THE RESOLVED BOX, sign-resolved here. A stored w/h MAY BE NEGATIVE — that is
  // a REFLECTION, how Flip H/V is stored (CLAUDE.md's NEGATIVE EXTENTS law), and
  // a plugin never sees the sign. `knobLayout` runs on RAW folded state (emit's
  // `s`, and web/knobFocus.js's item state), which is one of the pre-derivation
  // readers the law names, so it must resolve the sign itself or a flipped
  // module would lay its band out at negative height and scale to the floor.
  const w = Math.abs(state?.w ?? 0);
  // An ABSENT height stays absent (see knobBandScale): a caller that said nothing
  // about the card's height has not said the card is short.
  const h = typeof state?.h === "number" ? Math.abs(state.h) : undefined;
  // How many fit per row, at least one — a node narrower than one knob still
  // draws it (clipping is the visible signal that it is too narrow, which the
  // registry docblock says to show rather than hide).
  const perRow = Math.max(1, Math.floor(w / KNOB_PITCH_X));
  const rows = Math.ceil(dials.length / perRow);
  // THE ONE FACTOR. Every length below is multiplied by it and it is written onto
  // each record, so the painter (core/node_chrome.knobOps), the hit test (knobAt
  // via knobRadius) and the drag (web/knobFocus.js) all read the SAME scaled
  // geometry rather than three copies of the unscaled constants.
  const k$ = knobBandScale(bandTop, rows, h);
  const pitchX = KNOB_PITCH_X * k$;
  const r = KNOB_R * k$;
  return dials.map((k, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    // Centre each row's own run of knobs, so a final short row is not left-heavy.
    const inRow = Math.min(perRow, dials.length - row * perRow);
    const rowW = inRow * pitchX;
    const cx = (w - rowW) / 2 + pitchX * (col + 0.5);
    const cy = bandTop + KNOB_ROW_H * k$ * row + r;
    const raw = valueOf(k);
    const bound = typeof raw !== "number" || !Number.isFinite(raw);
    const min = typeof k.min === "number" ? k.min : 0;
    const max = typeof k.max === "number" ? k.max : 1;
    const value = bound ? min : raw;
    return {
      key: k.key, stateKey: stateKeyOf(k), label: k.label ?? k.key,
      cx, cy, min, max, step: k.step, unit: k.unit ?? "",
      // The scaled geometry, ON THE RECORD. `r` is the field knobRadius already
      // read for the KNOB control node's one big dial, so a band-scaled dial and
      // a per-widget dial travel the same path; `pitchX`/`labelGap`/`labelSize`
      // are the same idea for the label box knobOps draws under it.
      r, pitchX, labelGap: KNOB_LABEL_GAP * k$, labelSize: KNOB_LABEL_SIZE * k$,
      value, fraction: knobFraction(value, min, max), bound,
    };
  });
}

/**
 * Pure function. Which knob (if any) a LOCAL point grabs, or null.
 *
 * The grab radius is the dial's own radius plus `tol`, matching
 * core/nodeflow.portAt's contract exactly — and, like it, the NEAREST wins when
 * two overlap so the answer is never ambiguous.
 *
 * ── A KNOB NEVER OUTRANKS A BEAD, and that is a user ruling, not a preference ─
 * ADDENDUM 6 / the founding message: a port bead is drag-active "even if it's
 * not selected". The bead layer is ALWAYS live, including inside knob focus, so
 * the caller must ask core/nodeflow.portAt FIRST and only fall through to this.
 * Knobs sit in the body band and beads sit on the edges, so the two rarely
 * compete — but on a node squeezed short enough for them to overlap, the wire
 * gesture is the one that must survive, because a knob has the Inspector as a
 * second route and a bead has none.
 *
 * @param {Array<object>} layout - from knobLayout
 * @param {number} lx - LOCAL x
 * @param {number} ly - LOCAL y
 * @param {number} [tol] - extra grab radius in LOCAL units
 * @returns {object|null} the knob record, or null
 *
 * @example // KL is knobLayout([{key: "cutoff", min: 0, max: 1}], {w: 150}, 60, () => 0.5)
 * @example knobAt(knobLayout([{key: "cutoff", min: 0, max: 1}], {w: 150}, 60, () => 0.5), 75, 73, 0).key // "cutoff"
 * @example // well away from every dial: an ordinary body drag, which moves the node
 * @example knobAt(knobLayout([{key: "cutoff", min: 0, max: 1}], {w: 150}, 60, () => 0.5), 5, 5, 0) // null
 */
export function knobAt(layout, lx, ly, tol = 0) {
  let best = null, bestD = Infinity;
  for (const k of layout) {
    const d = Math.hypot(k.cx - lx, k.cy - ly);
    // PER-DIAL RADIUS, not the module constant: a big dial must be grabbable
    // across its whole face, and a small one must not steal presses from the
    // card around it. Both read `knobRadius`, so grabbing and drawing agree.
    if (d <= knobRadius(k) + tol && d < bestD) { best = k; bestD = d; }
  }
  return best;
}

/**
 * Pure function. A dial's radius: its own `r` when it declares one, else the
 * shared default.
 *
 * THE ONE LOOKUP the painter (core/node_chrome.knobOps), the hit test (knobAt)
 * and the editor overlay all go through. A dial drawn at one radius and grabbed
 * at another is the defect this prevents, and it is invisible in a screenshot —
 * the picture looks right and the click misses.
 *
 * @param {object} knob - a knobLayout record
 * @returns {number} radius in LOCAL units
 *
 * @example knobRadius({}) // 13
 * @example knobRadius({r: 26}) // 26
 * @example // a nonsense radius falls back rather than painting an inverted arc
 * @example knobRadius({r: -4}) // 13
 */
export function knobRadius(knob) {
  const r = Number(knob?.r);
  return Number.isFinite(r) && r > 0 ? r : KNOB_R;
}

/**
 * Pure function. The value a vertical drag lands a knob on: the grab-time value
 * moved by the travel, snapped to the knob's step and clamped to its range.
 *
 * ── UP IS MORE, AND THE GESTURE IS ABSOLUTE FROM THE GRAB ───────────────────
 * Screen y grows DOWNWARD, so a negative dy is an upward drag and must INCREASE
 * the value — that is the near-universal convention in audio software and the
 * one a user's hands already know.
 *
 * The travel is measured from the GRAB, not accumulated per move event. That
 * matters for one specific reason: an accumulating gesture that clamps at an end
 * stop and then reverses does not come back until the accumulated total has
 * unwound, so a knob you pushed past maximum feels stuck. Measuring from the
 * grab means the knob is always exactly where the pointer says it is.
 *
 * ── A RECORD MAY DECLARE ITS OWN `span` (BV, 2026-08-03) ────────────────────
 * A DIAL has no length, so how far you drag to sweep it is a free choice, and
 * KNOB_DRAG_SPAN's 150 units is that choice. A SLIDER does have a length: its
 * handle sits on a track, and the one thing a user expects is that the handle
 * stays under the cursor. With the shared 150 against a track ~86 tall, dragging
 * the handle to the top of its own track reached 0.79 of the range and the
 * handle visibly lagged the pointer — measured, not reasoned. So a strip control
 * declares `span` = its track length and the handle tracks exactly.
 *
 * @param {object} knob - a knobLayout record (its min/max/step/value at grab,
 *     and optionally its own `span`)
 * @param {number} startValue - the value when the drag began
 * @param {number} dyLocal - travel since the grab, LOCAL units, +y = down
 * @param {boolean} fine - whether the FINE modifier is held
 * @returns {number}
 *
 * @example // half the drag span upward from the bottom is half the range
 * @example knobDragValue({min: 0, max: 100}, 0, -75, false) // 50
 * @example // downward drag decreases
 * @example knobDragValue({min: 0, max: 100}, 50, 75, false) // 0
 * @example // FINE divides the sensitivity, so the same travel moves an eighth as far
 * @example knobDragValue({min: 0, max: 100}, 0, -75, true) // 6.25
 * @example // the step snaps the result, and the range clamps it
 * @example knobDragValue({min: 0, max: 16, step: 1}, 8, -30, false) // 11
 * @example knobDragValue({min: 0, max: 100}, 90, -1000, false) // 100
 * @example // a declared span rescales the gesture: on an 86-unit track, dragging
 * @example // the handle 43 up from the middle reaches the TOP of the range
 * @example knobDragValue({min: 0, max: 1, span: 86}, 0.5, -43, false) // 1
 */
export function knobDragValue(knob, startValue, dyLocal, fine) {
  const declared = Number(knob?.span);
  const base = Number.isFinite(declared) && declared > 0 ? declared : KNOB_DRAG_SPAN;
  const span = base * (fine ? KNOB_FINE_DIVISOR : 1);
  const delta = (-dyLocal / span) * (knob.max - knob.min);
  const raw = Math.max(knob.min, Math.min(knob.max, startValue + delta));
  return Math.max(knob.min, Math.min(knob.max, knobSnap(raw, knob)));
}

/**
 * Pure function. A knob's value formatted for its live readout.
 *
 * Precision follows the STEP when one is declared, and otherwise the magnitude —
 * a cutoff at 8400 Hz does not want two decimal places and a mix at 0.35 does.
 *
 * @param {object} knob - a knobLayout record
 * @param {number} value - the value to show
 * @returns {string}
 *
 * @example knobReadout({unit: " Hz"}, 8400) // "8400 Hz"
 * @example knobReadout({unit: ""}, 0.3512) // "0.35"
 * @example knobReadout({step: 1, unit: ""}, 16) // "16"
 * @example knobReadout({step: 0.01, unit: ""}, 0.5) // "0.5"
 */
export function knobReadout(knob, value) {
  const places = typeof knob.step === "number" && knob.step > 0
    ? decimalPlacesOf(knob.step)
    : (Math.abs(value) >= 100 ? 0 : 2);
  return `${Number(Number(value).toFixed(places))}${knob.unit ?? ""}`;
}
