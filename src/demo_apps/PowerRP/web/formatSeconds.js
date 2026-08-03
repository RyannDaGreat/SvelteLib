/**
 * formatSeconds.js — display-only formatting for transition durations.
 *
 * User ruling (2026-08-02, night, verbatim, with a screenshot of a slide
 * tooltip reading "Transition into slide 4: Tw… 2.9800000000000004s —"):
 * "Please limit the decimals that are used to display anything involving
 * transition times to the third decimal place."
 *
 * DISPLAY ONLY: the stored `transition.seconds` value stays exact (equations,
 * autosave and undo read it unrounded). This module only formats a number for
 * READ-ONLY text — tooltips, pill/chip labels, aria-labels. A NumericField
 * editing the stored value is not a display site and must not route through
 * this helper (see web/SlideNav.svelte + core/transitions.js's `row("seconds")`
 * Inspector row, which stays a plain editable number).
 */

const TRANSITION_SECONDS_DECIMALS = 3; // the user's ruling: cap at the third decimal place

/**
 * Pure function. Formats a duration in seconds for display, rounded to at
 * most `TRANSITION_SECONDS_DECIMALS` places with trailing zeros trimmed, and
 * appends "s". Kills float noise from repeated tween interpolation
 * (2.9800000000000004 -> "2.98s").
 *
 * @param {number} seconds Duration in seconds.
 * @returns {string} e.g. "2.98s", "3s", "0.5s".
 *
 * @example formatSeconds(2.9800000000000004) // "2.98s"
 * @example formatSeconds(3) // "3s"
 * @example formatSeconds(0.5) // "0.5s"
 * @example formatSeconds(1.23456) // "1.235s"
 * @example formatSeconds(0) // "0s"
 */
export function formatSeconds(seconds) {
  const rounded = Number(seconds.toFixed(TRANSITION_SECONDS_DECIMALS));
  return `${rounded}s`;
}
