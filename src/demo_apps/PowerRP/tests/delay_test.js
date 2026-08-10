/**
 * THE `delay` UNIVERSAL PROPERTY — bare node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/delay_test.js
 *
 * Pins the design recorded in the dump manifest ("THE `delay` UNIVERSAL
 * PROPERTY — DESIGN") and THE ALPHA REFACTOR it required:
 *
 *   BYTE-IDENTITY  — a delay-free document's foldState/tweenedState at linear
 *                    progress `u` equals the OLD pre-refactor picture: easing
 *                    `u` manually with the transition's curve and feeding that
 *                    straight to blendApplied, exactly what every caller used
 *                    to do for itself before curve easing moved into the fold.
 *   THE WINDOW     — a delayed item holds its start value through
 *                    [0, delay/seconds), then eases through the remaining
 *                    window, and lands exactly on target at u = 1. Undelayed
 *                    siblings in the SAME delta are unaffected.
 *   THE DEGENERATE
 *   CASE           — delay >= seconds is a legal STEP at the very end (u = 1),
 *                    not an error and not floored.
 *   THE VISIBILITY
 *   FLIP           — a delayed not-visible -> visible item flips exactly when
 *                    its OWN windowed alpha crosses 0 (u > delay/seconds), not
 *                    at any u > 0.
 *   MORPH          — `delay` is non-shape: changing only it must never arm a
 *                    morph (it joins MORPH_NON_SHAPE_KEYS in core/deltas.js).
 *   SINGLE EASE    — web/transitionRender.fadeStrength eases its input EXACTLY
 *                    once (the double-ease bug THE ALPHA REFACTOR fixes).
 */

import assert from "node:assert/strict";
import {
  newDocument, withNewItem, withNewSlide, keyframed, foldState, tweenedState, itemDelayAlpha,
} from "../core/document.js";
import { morphEndpointsDiffer } from "../core/deltas.js";
import { ease } from "../core/interpolators.js";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { fadeStrength } from "../web/transitionRender.js";

const registry = createRegistry();
registerAll(registry, createCommands());

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.stack ?? e.message}`);
    failed++;
  }
}
function approx(a, b, eps = 1e-9, msg = "") {
  assert.ok(Math.abs(a - b) < eps, `${msg} ${a} !~ ${b}`.trim());
}

// x tweens 0 -> TARGET_X. Deliberately NON-INTEGER: interpolate() rounds a
// plain-number leaf when BOTH endpoints are integers (core/interpolators.js —
// "the int rule is on the SCALAR path"), which would make every expected value
// below an approximation of an approximation. A fractional target sidesteps it
// so the assertions measure the alpha math exactly.
const TARGET_X = 100.5;

/** A one-rect, two-slide document tweening x: 0 -> TARGET_X into slide 1, with
 *  the given transition seconds/curve. Returns {doc, id}. */
function xTweenDoc(seconds, curve, extraSlide1Items = {}) {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, z: 0 });
  [doc] = withNewSlide(doc, 0);
  doc.slides[1] = { ...doc.slides[1], transition: { type: "tween", seconds, curve, sound: null } };
  doc = keyframed(doc, 1, ["items", id, "x"], TARGET_X);
  for (const [key, value] of Object.entries(extraSlide1Items)) doc = keyframed(doc, 1, ["items", id, key], value);
  return { doc, id };
}

console.log("\nTHE `delay` UNIVERSAL PROPERTY\n");

// ── BYTE-IDENTITY: a delay-free document is unchanged by the refactor ────────

test("BYTE-IDENTITY: foldState(u) === blendApplied at manually-eased alpha, default 'smooth' curve", () => {
  const { doc, id } = xTweenDoc(1, "smooth");
  const easeFn = ease("cubic");
  for (const u of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    approx(foldState(doc, 1, u).items[id].x, TARGET_X * easeFn(u), 1e-12, `u=${u}`);
  }
});

test("BYTE-IDENTITY: foldState(u) === blendApplied at manually-eased alpha, explicit 'linear' curve", () => {
  const { doc, id } = xTweenDoc(1, "linear");
  for (const u of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    approx(foldState(doc, 1, u).items[id].x, TARGET_X * u, 1e-12, `u=${u}`);
  }
});

test("BYTE-IDENTITY: tweenedState(u) matches foldState(u) for a plugin with no interpolateState hook", () => {
  const { doc, id } = xTweenDoc(1, "smooth");
  for (const u of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(tweenedState(doc, 1, u, registry).items[id].x, foldState(doc, 1, u).items[id].x, `u=${u}`);
  }
});

test("BYTE-IDENTITY: itemDelayAlpha(u, T, 0, easeFn) === easeFn(u) for every u — absent/0 delay is the identity", () => {
  const easeFn = ease("cubic");
  for (const u of [0, 0.1, 0.37, 0.5, 0.63, 0.9, 1]) {
    assert.equal(itemDelayAlpha(u, 1, 0, easeFn), easeFn(u), `u=${u}`);
  }
});

// ── THE WINDOW: a delayed item holds, then eases through [delay, seconds] ────

test("THE WINDOW: a delayed item holds its start value through u < delay/seconds, linear curve", () => {
  const T = 1, D = 0.4;
  const { doc, id } = xTweenDoc(T, "linear", { delay: D });
  // Strictly inside the hold: unchanged from the start value (0).
  for (const u of [0, 0.1, 0.2, 0.39]) {
    assert.equal(foldState(doc, 1, u).items[id].x, 0, `u=${u} must still be held at the start value`);
  }
});

test("THE WINDOW: the item's own progress re-parameterizes the REMAINING span, linear curve", () => {
  const T = 1, D = 0.4;
  const { doc, id } = xTweenDoc(T, "linear", { delay: D });
  // itemU = (u*T - D) / (T - D); linear curve means itemAlpha = itemU directly.
  for (const u of [0.4, 0.5, 0.7, 0.9, 1]) {
    const itemU = Math.max(0, Math.min(1, (u * T - D) / (T - D)));
    approx(foldState(doc, 1, u).items[id].x, TARGET_X * itemU, 1e-12, `u=${u}`);
  }
});

test("THE WINDOW: a delayed item lands exactly on target at u = 1", () => {
  const { doc, id } = xTweenDoc(1, "smooth", { delay: 0.6 });
  assert.equal(foldState(doc, 1, 1).items[id].x, TARGET_X);
});

test("THE WINDOW: UNDELAYED siblings in the SAME delta are unaffected by another item's delay", () => {
  let doc = newDocument();
  let delayed, plain;
  [doc, delayed] = withNewItem(doc, 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, z: 0 });
  [doc, plain] = withNewItem(doc, 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, z: 1 });
  [doc] = withNewSlide(doc, 0);
  doc.slides[1] = { ...doc.slides[1], transition: { type: "tween", seconds: 1, curve: "linear", sound: null } };
  doc = keyframed(doc, 1, ["items", delayed, "x"], 100);
  doc = keyframed(doc, 1, ["items", delayed, "delay"], 0.5);
  doc = keyframed(doc, 1, ["items", plain, "x"], 100);
  // At u=0.25 the delayed item is still held (0.25 < 0.5); the plain sibling
  // has already moved a quarter of the way, exactly like a plain linear tween.
  const mid = foldState(doc, 1, 0.25);
  assert.equal(mid.items[delayed].x, 0, "the delayed item is still inside its hold");
  approx(mid.items[plain].x, 25, 1e-12, "the undelayed sibling tweens as if delay did not exist");
});

test("THE WINDOW: itemDelayAlpha's own doctested examples", () => {
  const linear = ease("linear");
  assert.equal(itemDelayAlpha(0.5, 1, 0, linear), 0.5);
  assert.equal(itemDelayAlpha(0.25, 1, 0.5, linear), 0);
  assert.equal(itemDelayAlpha(0.75, 1, 0.5, linear), 0.5);
});

// ── THE DEGENERATE CASE: delay >= seconds is a step at the very end ──────────

test("DEGENERATE: delay >= seconds holds the item for EVERY u < 1, whatever the curve", () => {
  const { doc, id } = xTweenDoc(1, "smooth", { delay: 2 }); // delay > seconds
  for (const u of [0, 0.25, 0.5, 0.75, 0.99, 0.999999]) {
    assert.equal(foldState(doc, 1, u).items[id].x, 0, `u=${u}: must still read the start value`);
  }
  assert.equal(foldState(doc, 1, 1).items[id].x, TARGET_X, "and steps to the target exactly at u = 1");
});

test("DEGENERATE: delay === seconds exactly is the same step-at-the-end (no divide-by-zero)", () => {
  const { doc, id } = xTweenDoc(1, "linear", { delay: 1 });
  for (const u of [0, 0.5, 0.999]) assert.equal(foldState(doc, 1, u).items[id].x, 0, `u=${u}`);
  assert.equal(foldState(doc, 1, 1).items[id].x, TARGET_X);
});

// ── THE VISIBILITY FLIP: crosses at u > delay/seconds, not at u > 0 ──────────

test("VISIBILITY FLIP: a delayed not-visible -> visible item flips exactly at its OWN window, not at u > 0", () => {
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, z: 0, active: false });
  [doc] = withNewSlide(doc, 0);
  doc.slides[1] = { ...doc.slides[1], transition: { type: "tween", seconds: 1, curve: "linear", sound: null } };
  doc = keyframed(doc, 1, ["items", id, "active"], true);
  doc = keyframed(doc, 1, ["items", id, "delay"], 0.4);
  // Below the delay window: still not-visible, even though u > 0 — the OLD
  // rule ("discrete values switch at alpha > 0") would have flipped this at
  // any u > 0; the delayed window must postpone that crossing.
  for (const u of [0.01, 0.1, 0.2, 0.39]) {
    assert.equal(foldState(doc, 1, u).items[id].active, false, `u=${u}: must still be hidden`);
  }
  // At and past the delay window: visible (discrete flip fires once itemAlpha > 0).
  for (const u of [0.41, 0.6, 1]) {
    assert.equal(foldState(doc, 1, u).items[id].active, true, `u=${u}: must now be visible`);
  }
});

// ── MORPH: `delay` is non-shape — changing only it must never arm a morph ────

test("MORPH: delay alone never differs the morph endpoints (joins MORPH_NON_SHAPE_KEYS)", () => {
  assert.equal(
    morphEndpointsDiffer({ type: "rect", w: 10, delay: 0 }, { type: "rect", w: 10, delay: 2 }),
    false,
    "delay is a timing knob, not a shape leaf — it must never arm the universal morph",
  );
  // Contrast: an UNKNOWN leaf still defaults to morphable (the denylist polarity).
  assert.equal(
    morphEndpointsDiffer({ type: "rect", teeth: 8 }, { type: "rect", teeth: 12 }),
    true,
    "control: a genuinely unknown leaf must still default to morphable",
  );
});

// ── FADE: fadeStrength eases its input EXACTLY once ──────────────────────────

test("FADE: fadeStrength(u, 'smooth') eases u ONCE — the double-ease bug THE ALPHA REFACTOR fixes", () => {
  const easeFn = ease("cubic");
  for (const u of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    // ONE ease: fadeStrength(u) must equal easeFn(u), NOT easeFn(easeFn(u)) —
    // the pre-refactor bug was the presenter pre-easing alpha (easeFn(t)) and
    // PresentMode feeding that eased value into fadeStrength, which eased it
    // a second time. Both emitters are linear now, so fadeStrength is the only
    // ease a fade frame gets.
    approx(fadeStrength(u, "smooth"), easeFn(u), 1e-12, `u=${u}`);
  }
  // The double-ease CONTROL, isolated to non-fixed-point u (0, 0.5 and 1 are
  // fixed points of cubic — easeFn(easeFn(u)) === easeFn(u) there BY
  // COINCIDENCE, which would make the comparison vacuous at exactly the values
  // most likely to be hand-picked for a quick check).
  for (const u of [0.1, 0.25, 0.75, 0.9]) {
    assert.notEqual(fadeStrength(u, "smooth"), easeFn(easeFn(u)),
      `u=${u}: a real double-ease would have produced this value — fadeStrength must not match it`);
  }
});

test("FADE: fadeStrength('linear') passes u straight through, both directions of the identity", () => {
  for (const u of [0, 0.25, 0.5, 0.75, 1]) assert.equal(fadeStrength(u, "linear"), u);
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}\n`);
process.exit(failed ? 1 : 0);
