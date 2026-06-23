/** format.js — small shared formatting helpers. */

/**
 * Pure function, general. Format seconds as M:SS.
 *
 * @example formatTimeMinSec(0) // "0:00"
 * @example formatTimeMinSec(65.4) // "1:05"
 * @example formatTimeMinSec(3661) // "61:01"
 */
export function formatTimeMinSec(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Pure function. Build {value,label} items for a speed dropdown.
 *
 * @example speedItems([1, 2]) // [{value:1,label:"1x"},{value:2,label:"2x"}]
 */
export function speedItems(speeds) {
  return speeds.map((s) => ({ value: s, label: `${s}x` }));
}
