/** numberStep.js — deriving a scrub/nudge step from a value's own precision. */

/**
 * Pure function. Count the decimal places in a number's shortest decimal
 * string. Reads the sign-stripped `String(|v|)` form, so it reflects how the
 * value is naturally written (0.25 → 2, 5 → 0), and unwinds scientific
 * notation (1e-7 → 7) so tiny magnitudes still report their true precision.
 *
 * @param {number} v - The value to inspect.
 * @returns {number} Count of digits after the decimal point (0 for integers).
 *
 * @example decimalPlaces(0.25) // 2
 * @example decimalPlaces(2.5) // 1
 * @example decimalPlaces(5) // 0
 * @example decimalPlaces(240) // 0
 * @example decimalPlaces(-0.05) // 2
 * @example decimalPlaces(1e-7) // 7
 */
export function decimalPlaces(v) {
  const s = Math.abs(v).toString();
  if (s.includes("e") || s.includes("E")) {
    const [mantissa, expText] = s.split(/[eE]/);
    const exponent = parseInt(expText, 10);
    const dot = mantissa.indexOf(".");
    const mantissaDecimals = dot < 0 ? 0 : mantissa.length - dot - 1;
    return Math.max(0, mantissaDecimals - exponent);
  }
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Pure function. The intelligent fallback step for a numeric control given no
 * explicit step: the granularity implied by its DEFAULT value's own precision,
 * i.e. 10^(-decimalPlaces(defaultValue)). So a default of 0.25 scrubs in 0.01s,
 * 0.3 in 0.1s, and an integer default in whole units.
 *
 * A null/undefined/non-finite default, OR a default of exactly 0, returns null
 * — "no step, stay continuous" — so a control with no meaningful default keeps
 * its free-scrub behavior instead of being forced onto an integer grid.
 *
 * @param {number|null|undefined} defaultValue - The property's default value.
 * @returns {number|null} The step, or null to leave the control continuous.
 *
 * @example defaultStep(0.25) // 0.01
 * @example defaultStep(0.3) // 0.1
 * @example defaultStep(2.5) // 0.1
 * @example defaultStep(5) // 1
 * @example defaultStep(240) // 1
 * @example defaultStep(0.005) // 0.001
 * @example defaultStep(0) // null  (no meaningful precision → stay continuous)
 * @example defaultStep(null) // null
 */
export function defaultStep(defaultValue) {
  if (defaultValue == null || !Number.isFinite(defaultValue) || defaultValue === 0) return null;
  return 10 ** -decimalPlaces(defaultValue);
}
