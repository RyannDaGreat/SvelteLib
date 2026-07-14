/**
 * ticks_test.js — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/ticks_test.js
 *
 * Covers the two properties the Blender-style grid math must have:
 *  1. DENSITY INVARIANCE — a decade grid is self-similar under ×10 zoom, so the
 *     multiset of (screenSpacing, opacity) it presents at zoom z equals the one
 *     at zoom 10z. Same apparent density at every zoom = "one continuous grid".
 *  2. OPACITY CONTINUITY — sweeping zoom, no level's opacity jumps (no pops);
 *     the composite opacity stays within a tight band with no gaps.
 * Plus enumeration correctness and the ruler level choice.
 */

import assert from "node:assert/strict";
import {
  smoothstep, levelSpacing, levelOpacity, visibleLevels, ticksInRange, rulerLevel,
} from "../../../lib/ticks.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}

// ── smoothstep ────────────────────────────────────────────────────────────────
test("smoothstep: clamps and is symmetric S-curve", () => {
  approx(smoothstep(-5), 0);
  approx(smoothstep(0), 0);
  approx(smoothstep(0.5), 0.5);
  approx(smoothstep(1), 1);
  approx(smoothstep(9), 1);
  // symmetry about (0.5, 0.5)
  approx(smoothstep(0.25) + smoothstep(0.75), 1);
});

// ── levelSpacing / levelOpacity ────────────────────────────────────────────────
test("levelSpacing: decade powers, incl. negative and custom base/ratio", () => {
  assert.deepEqual([levelSpacing(-1), levelSpacing(0), levelSpacing(1), levelSpacing(2)], [1, 10, 100, 1000]);
  approx(levelSpacing(3, 1, 2), 8); // base 1, ratio 2
});

test("levelOpacity: symmetric bump — peaks at target, zero one decade each side", () => {
  approx(levelOpacity(40), 1); // peak at target
  approx(levelOpacity(4), 0); // one decade too dense
  approx(levelOpacity(400), 0); // one decade too sparse
  approx(levelOpacity(3.9), 0); // outside window -> clamped 0
  approx(levelOpacity(410), 0);
  // symmetric in log space about the peak
  approx(levelOpacity(40 * 2), levelOpacity(40 / 2), 1e-12);
  // rises 4->40 then falls 40->400, staying in [0,1]
  let prev = -1;
  for (let s = 4; s <= 40; s += 1) {
    const o = levelOpacity(s);
    assert.ok(o >= prev - 1e-12, `opacity not rising toward peak at s=${s}`);
    assert.ok(o >= 0 && o <= 1);
    prev = o;
  }
  prev = 2;
  for (let s = 40; s <= 400; s += 1) {
    const o = levelOpacity(s);
    assert.ok(o <= prev + 1e-12, `opacity not falling past peak at s=${s}`);
    prev = o;
  }
});

test("levelOpacity: adjacent decades form a partition of unity (sum == 1)", () => {
  // The TWO STRADDLING levels sum to exactly 1 (smoothstep(t)+smoothstep(1-t)=1).
  // Sweep the denser one across the overlap window (targetPx/ratio .. targetPx)
  // and pair it with its coarser neighbor (×10) — the pair that actually straddles.
  // This is WHY the grid composite is uniform density with no pops.
  for (let s = 4.001; s < 40; s *= 1.02) {
    approx(levelOpacity(s) + levelOpacity(s * 10), 1, 1e-12);
  }
});

// ── DENSITY INVARIANCE (the core Blender property) ─────────────────────────────
test("visibleLevels: density identical at zoom z and 10z (decade self-similarity)", () => {
  // The apparent-density "fingerprint" is the sorted list of (screenSpacing,
  // opacity) pairs — WITHOUT reference to which world level produced them. Under
  // ×10 zoom every level's index shifts by one but the screen picture is identical.
  const fingerprint = (zoom) =>
    visibleLevels(zoom)
      .map((l) => [round(l.screenSpacing), round(l.opacity)])
      .sort((a, b) => a[0] - b[0]);
  const round = (x) => Math.round(x * 1e6) / 1e6;

  for (const z of [0.3, 1, 2, 7, 13.37, 250]) {
    assert.deepEqual(
      fingerprint(z),
      fingerprint(z * 10),
      `density fingerprint differs between zoom ${z} and ${z * 10}`,
    );
    // ...and across two decades, to be sure it's not a one-off coincidence.
    assert.deepEqual(fingerprint(z), fingerprint(z * 100));
  }
});

test("visibleLevels: composite opacity is a constant 1 (partition of unity)", () => {
  // Sum of level opacities == 1 at EVERY zoom => perfectly uniform apparent
  // density, never a density hole or a spike. This is the mathematical core of
  // "reads as one continuous grid at any zoom".
  for (let logz = -2; logz <= 3; logz += 0.001) {
    const z = 10 ** logz;
    const sum = visibleLevels(z).reduce((s, l) => s + l.opacity, 0);
    approx(sum, 1, 1e-9);
  }
});

// ── OPACITY CONTINUITY (no pops) ───────────────────────────────────────────────
test("visibleLevels: per-level opacity is continuous under zoom (no pops)", () => {
  // Track each WORLD level's opacity as zoom sweeps; when a level is present in
  // two adjacent samples its opacity must not jump. A level appearing/vanishing
  // must do so AT an opacity near 0 (smooth birth/death), never popping in solid.
  const Z0 = 0.05, Z1 = 5000;
  const step = 1.002; // 0.2% zoom per sample — a level can't traverse its whole
  //                      fade window in one such step, so any legit jump is a pop.
  const POP = 0.05; // max allowed opacity change between adjacent zoom samples
  // Seed `prev` from the FIRST sample so its levels aren't counted as births
  // (an empty seed would flag every initial level as a spurious pop-in).
  let prev = new Map(visibleLevels(Z0).map((l) => [l.k, l.opacity]));
  let maxJump = 0, maxBirth = 0;
  for (let z = Z0 * step; z <= Z1; z *= step) {
    const cur = new Map(visibleLevels(z).map((l) => [l.k, l.opacity]));
    for (const [k, o] of cur) {
      if (prev.has(k)) maxJump = Math.max(maxJump, Math.abs(o - prev.get(k)));
      else maxBirth = Math.max(maxBirth, o); // opacity at which the level appeared
    }
    for (const [k, o] of prev) if (!cur.has(k)) maxBirth = Math.max(maxBirth, o); // at death
    prev = cur;
  }
  assert.ok(maxJump < POP, `opacity popped by ${maxJump} between adjacent zooms`);
  assert.ok(maxBirth < POP, `a level appeared/vanished at opacity ${maxBirth} (a pop-in)`);
});

// ── ticksInRange ────────────────────────────────────────────────────────────────
test("ticksInRange: multiples within [lo,hi], order-agnostic, negatives", () => {
  assert.deepEqual(ticksInRange(0, 25, 10), [0, 10, 20]);
  assert.deepEqual(ticksInRange(-15, 15, 10), [-10, 0, 10]);
  assert.deepEqual(ticksInRange(23, -3, 10), [0, 10, 20]); // auto-ordered
  assert.deepEqual(ticksInRange(10, 10, 10), [10]); // inclusive endpoints
  assert.deepEqual(ticksInRange(1, 9, 10), []); // no multiple inside
  assert.throws(() => ticksInRange(0, 10, 0)); // spacing must be > 0
});

test("ticksInRange: matches a level's spacing (grid-line enumeration)", () => {
  const lvl = visibleLevels(2)[0]; // finest visible level at zoom 2
  const xs = ticksInRange(0, 500, lvl.spacing);
  for (const x of xs) approx(x % lvl.spacing, 0); // every tick is a multiple
});

// ── rulerLevel ──────────────────────────────────────────────────────────────────
test("rulerLevel: coarsest level with ticks >= target apart; self-similar", () => {
  assert.equal(rulerLevel(1).spacing, 100); // 10px world would be 10px on screen — too tight
  assert.equal(rulerLevel(10).spacing, 10); // zoomed in: 10px world = 100px on screen
  assert.equal(rulerLevel(0.1).spacing, 1000);
  // its on-screen spacing is always in [target, target*ratio)
  for (const z of [0.02, 0.5, 1, 3, 40, 999]) {
    const s = rulerLevel(z).screenSpacing;
    assert.ok(s >= 40 - 1e-9 && s < 400 + 1e-9, `ruler screenSpacing ${s} out of band at zoom ${z}`);
  }
});

console.log(`\n${passed} ticks tests passed.`);
