/**
 * THE FONT-SIZE STEPPER IS RELATIVE, AND THERE IS EXACTLY ONE OF IT.
 *
 * The reported defect (R6-13.1): pressing the floating toolbar's +/- on a MIXED
 * selection FLATTENED it. Measured live on a 48+18 selection, select-all, one
 * step up: the toolbar produced ONE run at 38 and the keyboard (Cmd+Plus) ONE run
 * at 50 — two different wrong answers, and both destroyed the run boundary. Cause:
 * the toolbar built an ABSOLUTE `{size: n}` delta from the selection's COMMON
 * size, which is `undefined` on a mixed selection, so it fell back to a constant
 * and applyRunStyle spread that one number over every covered run; the keyboard
 * path computed its fallback differently, from the run at the selection start.
 *
 * Two things had to be true for the fix, and this suite locks both:
 *
 *   1. THE PRIMITIVE IS RELATIVE. core/richtext.adjustRunSize shifts each covered
 *      run's OWN resolved size, so 48+18 → 50+20 and the boundary survives.
 *   2. THERE IS ONE OF IT. Both entry points call the controller's stepSize, and
 *      neither component re-declares the step or the default size — the pair used
 *      to be hand-mirrored in two files and had ALREADY drifted, which is what
 *      produced two different wrong answers rather than one. A grep-guard is the
 *      right shape for that half (the tests/glass_blur_guard_test.js precedent):
 *      the property is "this literal exists in exactly one place", which no
 *      behavioural assertion can state.
 *
 * Bare node, no framework (suite conventions).
 * Run: node src/demo_apps/PowerRP/tests/text_size_step_test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  adjustRunSize, steppedSize, applyRunStyle, runFrom,
  DEFAULT_PARA_SIZE, MIN_RUN_SIZE, SIZE_STEP,
} from "../core/richtext.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLBAR_SRC = readFileSync(resolve(HERE, "../web/TextFormatToolbar.svelte"), "utf8");
const CONTROLLER_SRC = readFileSync(resolve(HERE, "../web/TextEditController.svelte"), "utf8");

let passed = 0;
function test(name, fn) { fn(); console.log(`  ok  ${name}`); passed += 1; }

// The exact selection the defect was measured on: one run at 48, one at 18.
const BIG = 48, SMALL = 18;
const MIXED = [{ text: "Big ", size: BIG }, { text: "small", size: SMALL }];
const MIXED_LEN = "Big small".length;
const sizesOf = (runs) => runs.map((r) => r.size);

// ── 1. the primitive is RELATIVE ──────────────────────────────────────────────

test("adjustRunSize shifts EVERY covered run by the same delta and keeps the boundary", () => {
  const up = adjustRunSize(MIXED, 0, MIXED_LEN, SIZE_STEP);
  assert.deepEqual(sizesOf(up), [BIG + SIZE_STEP, SMALL + SIZE_STEP]);
  assert.equal(up.length, 2, "the 48/18 boundary must survive — flattening it IS the bug");
  const down = adjustRunSize(MIXED, 0, MIXED_LEN, -SIZE_STEP);
  assert.deepEqual(sizesOf(down), [BIG - SIZE_STEP, SMALL - SIZE_STEP]);
  // The relative DIFFERENCE is the invariant, in both directions and over repeats.
  const twice = adjustRunSize(up, 0, MIXED_LEN, SIZE_STEP);
  assert.equal(twice[0].size - twice[1].size, BIG - SMALL);
});

test("the ABSOLUTE delta it replaced really did flatten — the two are not interchangeable", () => {
  // Not a re-implementation of the old bug as a fixture: this is applyRunStyle,
  // the shipped primitive, with the {size: n} delta the toolbar used to hand it.
  // Stating the contrast is what makes "use adjustRunSize" a rule and not a taste.
  const flattened = applyRunStyle(MIXED, 0, MIXED_LEN, { size: DEFAULT_PARA_SIZE + SIZE_STEP });
  assert.equal(flattened.length, 1, "one size for every run collapses them into one run");
  assert.equal(flattened[0].size, DEFAULT_PARA_SIZE + SIZE_STEP);
});

test("a UNIFORM selection is unaffected by the change (relative and absolute coincide)", () => {
  const uniform = [{ text: "Same size here", size: DEFAULT_PARA_SIZE }];
  assert.deepEqual(sizesOf(adjustRunSize(uniform, 0, 14, SIZE_STEP)), [DEFAULT_PARA_SIZE + SIZE_STEP]);
});

test("it READS resolved and WRITES explicit — the box row supplies the starting size", () => {
  const BOX_SIZE = 60;
  const bare = [{ text: "abcd" }];
  // A bare run has no size of its own, so the step must start from the widget's
  // row (runFrom's layering), not from the hardcoded floor.
  assert.deepEqual(sizesOf(adjustRunSize(bare, 0, 4, SIZE_STEP, { size: BOX_SIZE })), [BOX_SIZE + SIZE_STEP]);
  assert.deepEqual(sizesOf(adjustRunSize(bare, 0, 4, SIZE_STEP)), [DEFAULT_PARA_SIZE + SIZE_STEP]);
  // …and only the COVERED runs are stamped, so the box row keeps supplying the rest.
  const partial = adjustRunSize([{ text: "ab" }, { text: "cd" }], 0, 2, SIZE_STEP, { size: BOX_SIZE });
  assert.deepEqual(Object.keys(partial[1]), ["text"], "the untouched run must stay bare");
});

test("the floor is MIN_RUN_SIZE, shared by the selection path and the caret path", () => {
  assert.deepEqual(sizesOf(adjustRunSize([{ text: "abcd", size: 2 }], 0, 4, -99)), [MIN_RUN_SIZE]);
  assert.equal(steppedSize(2, -99), MIN_RUN_SIZE);
  assert.equal(steppedSize(DEFAULT_PARA_SIZE, SIZE_STEP), DEFAULT_PARA_SIZE + SIZE_STEP);
});

test("an empty selection is a no-op, and equal sizes still merge to canonical form", () => {
  assert.deepEqual(adjustRunSize(MIXED, 3, 3, SIZE_STEP), MIXED);
  const equal = [{ text: "ab", size: 10 }, { text: "cd", size: 10 }];
  assert.equal(adjustRunSize(equal, 0, 4, SIZE_STEP).length, 1);
});

test("adjustRunSize never mutates its input", () => {
  const before = JSON.stringify(MIXED);
  adjustRunSize(MIXED, 0, MIXED_LEN, SIZE_STEP);
  assert.equal(JSON.stringify(MIXED), before);
});

test("resolving through runFrom is what makes a MIXED step correct — spelled out", () => {
  // The one line of reasoning the whole item rests on: each covered run's start
  // value is its OWN resolved size, never a single number shared by the selection.
  for (const run of MIXED)
    assert.equal(adjustRunSize([run], 0, [...run.text].length, SIZE_STEP)[0].size, runFrom(run).size + SIZE_STEP);
});

// ── 2. there is exactly ONE stepper ───────────────────────────────────────────

test("neither text component re-declares the step or the default size", () => {
  // The hand-maintained-mirror defect, caught as source text because that is what
  // it is: two `const SIZE_STEP = 2` lines and two differently-computed fallbacks.
  for (const [name, src] of [["TextFormatToolbar", TOOLBAR_SRC], ["TextEditController", CONTROLLER_SRC]]) {
    assert.doesNotMatch(src, /const\s+SIZE_STEP\s*=/, `${name}: SIZE_STEP must be imported from core/richtext.js, not re-declared`);
    assert.doesNotMatch(src, /const\s+DEFAULT_(TEXT_)?SIZE\s*=/, `${name}: the default font size must be imported (DEFAULT_PARA_SIZE), not re-declared`);
    assert.match(src, /from "\.\.\/core\/richtext\.js"/, `${name}: must import the shared rich-text vocabulary`);
  }
});

test("the toolbar no longer builds an ABSOLUTE size delta of its own", () => {
  // `sizeDelta` was the toolbar's private "common size ± step" helper. Its whole
  // existence was the divergence; the toolbar now only says BY HOW MUCH.
  assert.doesNotMatch(TOOLBAR_SRC, /sizeDelta\s*\(/, "the toolbar must not compute a size value — it sends a relative step");
  assert.match(TOOLBAR_SRC, /onsizestep\(/, "the toolbar's +/- must call the shared relative entry point");
  assert.match(TOOLBAR_SRC, /onsizesteppreview\(/, "…and so must its hover preview and the scrubbable readout");
});

test("the controller's stepSize is the ONE size write, and it is relative", () => {
  assert.match(CONTROLLER_SRC, /adjustRunSize\(/, "stepSize must go through the relative primitive");
  assert.match(CONTROLLER_SRC, /onsizestep=\{stepSize\}/, "the toolbar's stepper must be wired to that same function");
  assert.match(CONTROLLER_SRC, /stepSize\(SIZE_STEP\)/, "…and so must Cmd+Plus");
  assert.match(CONTROLLER_SRC, /stepSize\(-SIZE_STEP\)/, "…and Cmd+Minus");
});

test("the scrubbable readout is a BARE DraggableNumber, never NumericField", () => {
  // A run size cannot hold an equation (core/expressions.js never generates a
  // text.runs.N.size path), so NumericField's ƒ toggle would offer an escape hatch
  // that does not exist. Precedent: app.css's material-knob scrubber.
  assert.match(TOOLBAR_SRC, /import DraggableNumber from "\.\.\/\.\.\/\.\.\/lib\/DraggableNumber\.svelte"/);
  // The IMPORT, not the word: the markup's comment names NumericField in order to
  // record why it is not used, and a guard that forbade the name would forbid the
  // explanation too.
  assert.doesNotMatch(TOOLBAR_SRC, /import\s+NumericField/, "a run size is not an equation slot — the ƒ would be a lie");
  assert.match(TOOLBAR_SRC, /<DraggableNumber/, "the size readout itself must be the scrubber");
});

console.log(`\n${passed} text size-step tests passed`);
