/**
 * Field display-unit transforms — a GENERIC seam letting an inspector row (or
 * any field) show/edit a value in a unit different from how core STORES it,
 * without touching document storage. Rotation is the first user: core stores
 * radians (core/transform.js), the user edits DEGREES (round-10 ruling).
 *
 * A transform is { toDisplay, fromDisplay, suffix }:
 *   - toDisplay(stored)   stored number → shown number (the field boundary)
 *   - fromDisplay(shown)  shown number → stored number (inverse; commit path)
 *   - suffix              indicator string appended after the number ("°")
 *
 * The pair MUST round-trip: fromDisplay(toDisplay(v)) === v (up to float
 * epsilon). This is DISPLAY ONLY — nothing here migrates stored units; a row
 * opts in by naming a transform, everything else stays identity.
 *
 * Design note (WHY a registry, not a rotation special-case): the same seam
 * serves any future unit (percent 0..1↔0..100, px↔pt, turns, ...) with zero
 * new field code — the field just looks a name up here.
 */

const DEG_PER_RAD = 180 / Math.PI;

/**
 * Pure function. The identity transform — value shown exactly as stored.
 *
 * @example identityUnit().toDisplay(1.5) // 1.5
 * @example identityUnit().fromDisplay(1.5) // 1.5
 * @example identityUnit().suffix // ""
 */
export function identityUnit() {
  return { toDisplay: (v) => v, fromDisplay: (v) => v, suffix: "" };
}

/**
 * Query — the named display-unit transforms. "degrees" converts a stored
 * radian angle to/from degrees with a "°" indicator; an unknown/absent name
 * falls back to identity (a row without a `display` key behaves as today).
 *
 * (Query, not pure: it reads this module's fixed table by name. The transforms
 * it returns are themselves pure.)
 */
const UNITS = {
  degrees: {
    // radians (stored) ↔ degrees (shown). 71° reads "71°", stores 1.239 rad.
    toDisplay: (rad) => rad * DEG_PER_RAD,
    fromDisplay: (deg) => deg / DEG_PER_RAD,
    suffix: "°",
  },
};

/**
 * Query. Look up a display-unit transform by name; unknown/undefined → identity.
 *
 * @example Math.round(displayUnit("degrees").toDisplay(Math.PI)) // 180  (π rad → 180°)
 * @example Math.round(displayUnit("degrees").fromDisplay(90) * 1000) / 1000 // 1.571  (90° → rad)
 * @example displayUnit(undefined).suffix // ""  (no unit → identity)
 */
export function displayUnit(name) {
  return (name && UNITS[name]) || identityUnit();
}
