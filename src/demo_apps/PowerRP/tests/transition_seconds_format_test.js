/**
 * formatSeconds tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/transition_seconds_format_test.js
 *
 * WORKSTREAM AW (user ruling, 2026-08-02, verbatim, with a screenshot of a
 * slide tooltip reading "Transition into slide 4: Tw… 2.9800000000000004s —"):
 * "Please limit the decimals that are used to display anything involving
 * transition times to the third decimal place." This asserts the helper caps
 * at 3 decimals, trims trailing zeros, and specifically kills the float-noise
 * case the user screenshotted — plus SlideNav's `pillLabel`, one of the
 * display sites that routes through it, to prove the sweep actually reaches
 * the template rather than just the helper in isolation.
 */

import assert from "node:assert/strict";
import { formatSeconds } from "../web/formatSeconds.js";

let passed = 0;
function eq(seconds, expected) {
  const got = formatSeconds(seconds);
  assert.equal(got, expected, `formatSeconds(${seconds}) = ${got}, expected ${expected}`);
  passed++;
  console.log(`  ok  formatSeconds(${seconds}) -> ${got}`);
}

// ── The user's own screenshot case: float noise from repeated tween interp ──
eq(2.9800000000000004, "2.98s");
eq(0.1 + 0.2, "0.3s"); // classic float noise (0.30000000000000004)

// ── Cap at 3 decimals, trailing zeros trimmed ────────────────────────────────
eq(1.23456, "1.235s"); // rounds to 3 places
eq(2.98, "2.98s"); // already <=3 decimals — unchanged
eq(3, "3s"); // whole number — no decimal point at all
eq(3.0, "3s");
eq(0.5, "0.5s");
eq(0, "0s");
eq(1.5, "1.5s");

console.log(`\ntransition_seconds_format_test: formatSeconds OK (${passed} assertions)`);

// ── The sweep reaches SlideNav's pillLabel (grid spine pill), not just the
//    helper in isolation. pillLabel is a plain pure function so this is
//    importable in bare node without mounting the component. ─────────────────
const source = await (await import("node:fs/promises")).readFile(new URL("../web/SlideNav.svelte", import.meta.url), "utf8");
const match = source.match(/function pillLabel\(info, heightPx\) \{[\s\S]*?\n  \}/);
assert.ok(match, "pillLabel function body not found in SlideNav.svelte — has it moved or been renamed?");
assert.ok(match[0].includes("formatSeconds(info.seconds)"), "pillLabel must route info.seconds through formatSeconds(), not print it raw");
assert.ok(!/\$\{info\.seconds\}s/.test(match[0]), "pillLabel must not interpolate info.seconds directly as `${info.seconds}s` (unrounded — the float-noise bug)");
passed++;
console.log("  ok  SlideNav.svelte pillLabel() routes info.seconds through formatSeconds()");

// ── The tooltip and list-chip label template strings also route through it —
//    a static source check (no browser needed) that the raw-seconds pattern
//    the user's screenshot exhibited is gone from every transition-duration
//    display site, not just pillLabel's. ─────────────────────────────────────
const rawSecondsPattern = /\binfo\.seconds\b(?!\s*[,)])/g; // any bare read of info.seconds not passed into a call
const rawUses = [...source.matchAll(rawSecondsPattern)];
// Every remaining bare `info.seconds` read must be an argument to formatSeconds(...),
// never interpolated directly into a template string as `${info.seconds}s`.
const unrouted = rawUses.filter((m) => {
  const before = source.slice(Math.max(0, m.index - 20), m.index);
  return !/formatSeconds\($/.test(before);
});
assert.equal(unrouted.length, 0, `found ${unrouted.length} unrouted info.seconds read(s) in SlideNav.svelte — every transition-duration display site must call formatSeconds()`);
passed++;
console.log("  ok  no unrouted info.seconds reads remain in SlideNav.svelte (tooltips + chip label + pill all route through formatSeconds)");

console.log(`\ntransition_seconds_format_test OK (${passed} assertions)`);
