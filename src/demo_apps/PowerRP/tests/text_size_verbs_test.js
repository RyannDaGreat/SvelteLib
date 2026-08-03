/**
 * THE THREE FONT-SIZE VERBS — one control, three gestures, three different edits.
 *
 * The ruling this pins (2026-08-02, verbatim): "when I type in a number for a font
 * size, if I have multiple words that have different sizes, they should all be
 * normalized to that number. But if I drag it up and down, it should make them all
 * bigger or smaller, maintaining the myriad of different sizes I may have
 * selected. And by the way, it should do so proportionally when I'm using the
 * slider, as opposed to the pluses and minuses."
 *
 * So a MIXED selection is the only fixture that can tell the three apart, and every
 * test below uses one. On a UNIFORM selection all three verbs can reach the same
 * number and the distinction is invisible — which is exactly why the bug survived:
 * typing over a mixed selection went through the ADDITIVE verb, so typing 18 with
 * 48 showing SHIFTED everything by -30 instead of normalizing it.
 *
 * WHAT THIS FILE DOES NOT COVER: the live gesture routing (does a real DRAG on the
 * real readout reach scaleRunSize?). That is tests/text_size_verbs_probe.js, which
 * drives the actual controller — the two halves are deliberately split the same way
 * text_size_step_test/text_size_step_probe are.
 *
 * Run: node src/demo_apps/PowerRP/tests/text_size_verbs_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  applyRunStyle, adjustRunSize, scaleRunSize, scaledSize, steppedSize,
  runFrom, DEFAULT_PARA_SIZE, MIN_RUN_SIZE, SIZE_STEP,
} from "../core/richtext.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLBAR_SRC = readFileSync(resolve(HERE, "../web/TextFormatToolbar.svelte"), "utf8");
const CONTROLLER_SRC = readFileSync(resolve(HERE, "../web/TextEditController.svelte"), "utf8");
const DN_SRC = readFileSync(resolve(HERE, "../../../lib/DraggableNumber.svelte"), "utf8");

// THE FIXTURE, and why these two numbers: 48 and 18 are the sizes from the
// original divergence report, and their ratio (8:3) is not a round number — so a
// scale that quietly rounded both to something tidy, or that lost the ratio in
// float dust, shows up as an inequality rather than hiding behind a coincidence.
const BIG = 48, SMALL = 18;
const MIXED = [{ text: "Big ", size: BIG }, { text: "small", size: SMALL }];
const MIXED_LEN = "Big small".length;
const sizesOf = (runs) => runs.map((r) => r.size);

// ── 1. the three verbs do three different things ─────────────────────────────

test("TYPED normalizes: every covered run becomes exactly the typed number", () => {
  // The user's own words: "they should all be normalized to that number."
  const TYPED = 30;
  const out = applyRunStyle(MIXED, 0, MIXED_LEN, { size: TYPED });
  assert.deepEqual(sizesOf(out), [TYPED], "every run is the typed size — so they merge to ONE run");
  // Stated as the property rather than the shape, because the shape (one merged
  // run) is a consequence of canonicalization, not the point:
  for (const r of out) assert.equal(runFrom(r).size, TYPED);
});

test("DRAG scales: every run is multiplied, and the RATIO is exactly preserved", () => {
  const out = scaleRunSize(MIXED, 0, MIXED_LEN, 1.5);
  assert.deepEqual(sizesOf(out), [72, 27]);
  assert.equal(out.length, 2, "the run boundary SURVIVES — the differences are the thing being kept");
  // The property the user asked for, stated as a ratio rather than as two numbers.
  assert.equal(72 / 27, BIG / SMALL, "8:3 before, 8:3 after");
});

test("STEP adds: every run shifts by the same px, and the ratio deliberately does NOT survive", () => {
  // This is the CONTRAST the user drew, so it is asserted as a contrast: the
  // stepper is not a worse scale, it is a different verb that they want.
  const out = adjustRunSize(MIXED, 0, MIXED_LEN, SIZE_STEP);
  assert.deepEqual(sizesOf(out), [BIG + SIZE_STEP, SMALL + SIZE_STEP]);
  assert.notEqual(
    (BIG + SIZE_STEP) / (SMALL + SIZE_STEP), BIG / SMALL,
    "an additive step CHANGES the ratio — which is why a scale had to be its own primitive",
  );
});

test("the three verbs disagree on one selection — the whole reason there are three", () => {
  // Reaching 24 (BIG/2) three ways, from the same mixed selection. If any two of
  // these came out equal the control could not be said to have three meanings.
  const typed = sizesOf(applyRunStyle(MIXED, 0, MIXED_LEN, { size: 24 }));
  const dragged = sizesOf(scaleRunSize(MIXED, 0, MIXED_LEN, 24 / BIG));
  const stepped = sizesOf(adjustRunSize(MIXED, 0, MIXED_LEN, 24 - BIG));
  assert.deepEqual(typed, [24]);
  assert.deepEqual(dragged, [24, 9]);
  assert.deepEqual(stepped, [24, MIN_RUN_SIZE], "18 - 24 floors at MIN_RUN_SIZE rather than going negative");
  assert.notDeepEqual(typed, dragged);
  assert.notDeepEqual(dragged, stepped);
});

// ── 2. the scale's arithmetic: no compounding, honest edges ──────────────────

test("RATIO-FROM-START: N frames of one drag equal ONE application of the total factor", () => {
  // THE COMPOUNDING BUG, pinned. A drag emits a frame per pixel; if each frame
  // scaled the PREVIOUS frame's already-rounded sizes, the per-run rounding would
  // accumulate differently per run and the proportions would visibly drift apart.
  // The real code never compounds (the controller re-applies from a captured base
  // and the toolbar divides by a stable seed), and this states what that buys.
  const TOTAL = 2.5;
  const FRAMES = 40;
  const oneShot = sizesOf(scaleRunSize(MIXED, 0, MIXED_LEN, TOTAL));

  // What the code does: every frame from the SAME base, with the whole-gesture
  // factor so far. The last frame is the settle.
  let fromStart = MIXED;
  for (let i = 1; i <= FRAMES; i++) fromStart = scaleRunSize(MIXED, 0, MIXED_LEN, 1 + (TOTAL - 1) * (i / FRAMES));
  assert.deepEqual(sizesOf(fromStart), oneShot, "ratio-from-start lands exactly on the one-shot result");

  // What the bug would have done: each frame from the PREVIOUS frame.
  let compounded = MIXED;
  const perFrame = TOTAL ** (1 / FRAMES);
  for (let i = 0; i < FRAMES; i++) compounded = scaleRunSize(compounded, 0, MIXED_LEN, perFrame);
  assert.notDeepEqual(
    sizesOf(compounded), oneShot,
    "compounding really does drift — so 'ratio from start' is a fix, not a preference",
  );
});

test("scaledSize rounds to whole px and floors at MIN_RUN_SIZE", () => {
  assert.equal(scaledSize(BIG, 1.5), 72);
  assert.equal(scaledSize(SMALL, 1.5), 27);
  // A size is authored in whole px everywhere else (SIZE_STEP is 2, the scrubber's
  // grid is 1), so a scale must not leave 48.48 in the document where the readout
  // says 48.
  assert.equal(scaledSize(BIG, 1.01), 48);
  assert.equal(scaledSize(4, 0.01), MIN_RUN_SIZE, "shrinking asymptotes at tiny, never reaches gone");
  assert.equal(steppedSize(4, -99), MIN_RUN_SIZE, "…the same floor the additive verb uses");
});

test("a non-positive or non-finite factor is REFUSED, not clamped", () => {
  // Silently substituting 1 would make a broken drag look like a successful no-op,
  // which is the silent-fallback defect this codebase forbids outright.
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(() => scaleRunSize(MIXED, 0, MIXED_LEN, bad), /positive finite/, `factor ${bad} must throw`);
  }
});

test("scaleRunSize matches adjustRunSize everywhere the two are not about arithmetic", () => {
  // The new primitive must be the old one's sibling in every respect but the
  // operation, so a reader who knows one knows the other.
  assert.deepEqual(scaleRunSize(MIXED, 3, 3, 2), adjustRunSize(MIXED, 3, 3, 0), "empty selection: both no-ops");
  // Partial coverage: only the covered characters move, and the split is identical.
  assert.deepEqual(sizesOf(scaleRunSize([{ text: "abcd", size: 20 }], 1, 3, 2)), [20, 40, 20]);
  // An absent size resolves through the BOX row, then DEFAULT_PARA_SIZE.
  assert.deepEqual(sizesOf(scaleRunSize([{ text: "abcd" }], 0, 4, 2, { size: 30 })), [60]);
  assert.deepEqual(sizesOf(scaleRunSize([{ text: "abcd" }], 0, 4, 2)), [DEFAULT_PARA_SIZE * 2]);
  // Equal results still merge to canonical form.
  assert.equal(scaleRunSize([{ text: "ab", size: 10 }, { text: "cd", size: 10 }], 0, 4, 2).length, 1);
  // Never mutates its input.
  const before = JSON.stringify(MIXED);
  scaleRunSize(MIXED, 0, MIXED_LEN, 3);
  assert.equal(JSON.stringify(MIXED), before);
});

// ── 3. the gesture actually reaches the right verb ───────────────────────────

test("DraggableNumber reports gesture provenance, and it is PURELY ADDITIVE", () => {
  // The lib change the user authorised ("You may need the number slider to be able
  // to emit an event upon entering a number through text").
  assert.match(DN_SRC, /oninput\?\.\(value, gesture\(\)\)/, "oninput must carry the provenance record");
  assert.match(DN_SRC, /onchange\?\.\(value, gesture\(\)\)/, "onchange must carry it too");
  // ADDITIVE means the FIRST argument is unchanged: every existing consumer takes
  // (v) and must keep seeing exactly the value it always did. A second parameter
  // cannot break them; a changed first one silently would.
  assert.match(DN_SRC, /function gesture\(\)\s*\{\s*return \{ source: gestureSource, startValue: gestureStartValue \};/);
  for (const src of [/beginGesture\("drag"/, /beginGesture\("typed"\)/, /beginGesture\("step"\)/])
    assert.match(DN_SRC, src, "all three sources must actually be declared somewhere");
});

test("the toolbar routes each gesture to its own verb", () => {
  assert.match(TOOLBAR_SRC, /g\?\.source === "typed"\s*\)\s*\{\s*onsizeset\(next\)/, "TYPED → normalize");
  assert.match(TOOLBAR_SRC, /g\?\.source === "step"\s*\)\s*\{\s*onsizestep\(/, "a keyboard nudge → the additive verb");
  assert.match(TOOLBAR_SRC, /onsizescale\(sizeFactor\(next\)\)/, "everything else (a DRAG) → the proportional verb");
  // The regression itself, made INEXPRESSIBLE: the readout must not answer a typed
  // commit with a px delta ever again.
  assert.doesNotMatch(
    TOOLBAR_SRC, /function commitScrubSize\([^)]*\)\s*\{\s*previewing = false;\s*onsizestep\(next - sizeSeed\);\s*\}/,
    "the readout must not send an additive delta for EVERY gesture — that was the bug",
  );
});

test("the controller owns one entry point per verb, each through its own primitive", () => {
  assert.match(CONTROLLER_SRC, /function setSize\(/, "NORMALIZE");
  assert.match(CONTROLLER_SRC, /function scaleSize\(/, "PROPORTIONAL");
  assert.match(CONTROLLER_SRC, /function stepSize\(/, "ADDITIVE");
  assert.match(CONTROLLER_SRC, /scaleRunSize\(/, "scaleSize must go through the proportional primitive");
  assert.match(CONTROLLER_SRC, /adjustRunSize\(/, "stepSize must still go through the additive one");
  // Wired to the toolbar, or the entry points exist and nothing calls them.
  for (const wire of [/onsizeset=\{setSize\}/, /onsizescale=\{scaleSize\}/, /onsizestep=\{stepSize\}/])
    assert.match(CONTROLLER_SRC, wire, "each verb must be wired to the toolbar");
});

test("Cmd+Plus/Minus still take the ADDITIVE verb — the keyboard is a stepper", () => {
  // The 38-vs-50 divergence was two paths computing one gesture differently. The
  // fix for that was ONE stepper; this workstream adds verbs BESIDE it and must
  // not have quietly moved the keyboard onto a different one.
  assert.match(CONTROLLER_SRC, /stepSize\(SIZE_STEP\)/);
  assert.match(CONTROLLER_SRC, /stepSize\(-SIZE_STEP\)/);
  assert.doesNotMatch(CONTROLLER_SRC, /scaleSize\(SIZE_STEP\)/, "Cmd+Plus must not scale");
});

console.log("\nthe three font-size verbs: all checks passed");
