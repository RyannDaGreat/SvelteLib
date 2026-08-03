/**
 * THE EVALUATE AFFORDANCE — the "1 2 3" button's value rule, plain node.
 * Run: node src/demo_apps/PowerRP/tests/evaluate_literal_test.js
 *
 * The GUI half (button present on an equation row, absent on a literal one) is
 * pinned by tests/evaluate_affordance_probe.js. THIS file pins the part that has
 * to be right no matter which of the three fields surfaces it: what literal an
 * evaluated equation bakes to, and when the bake must be REFUSED.
 *
 * Two halves:
 *   PURE — evaluatedLiteral / evaluateLiteralProblem against hand-built values,
 *     so each rule (tidying, type fidelity, the error refusal) is isolated.
 *   ROUND TRIP — a REAL document, folded and evaluated through the real
 *     registry: equation in, literal out, undo restores the equation. That half
 *     exists because the whole feature is a claim about the two state trees
 *     (stored vs evaluated), and a stub cannot tell those apart.
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerAll } from "../plugins/index.js";
import { createCommands } from "../core/commands.js";
import { createUndo } from "../core/undo.js";
import { newDocument, withNewItem, keyframed, foldState } from "../core/document.js";
import {
  EVALUATE_DECIMALS,
  evaluateState,
  evaluatedLiteral,
  evaluateLiteralProblem,
  isEquationValue,
} from "../core/expressions.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

// ── PURE: the tidy rule ──────────────────────────────────────────────────────

test("float dust is tidied to the row's shown precision", () => {
  // THE motivating case: an equation that lands on IEEE dust must not write
  // 0.30000000000000004 into a box the user reads as "the value it had".
  assert.equal(evaluatedLiteral(0.1 + 0.2, 3), 0.3);
  assert.equal(evaluatedLiteral(1.23456, 3), 1.235);
});

test("a row with a finer grid keeps its finer precision", () => {
  // shownDecimals is never coarser than the step the row scrubs in, so a
  // 1e-5-grid row bakes what it was actually showing, not a 3-decimal crop.
  assert.equal(evaluatedLiteral(1.23456, 5), 1.23456);
  assert.equal(evaluatedLiteral(0.000123, 6), 0.000123);
});

test("an exact number is unchanged, and integers stay integers", () => {
  assert.equal(evaluatedLiteral(42, 3), 42);
  assert.equal(evaluatedLiteral(-7.5, 3), -7.5);
  assert.equal(evaluatedLiteral(0, 3), 0);
});

test("the default decimals matches NumericField's long-standing 3", () => {
  assert.equal(EVALUATE_DECIMALS, 3);
  assert.equal(evaluatedLiteral(1.23456), 1.235);
});

// ── PURE: type fidelity ──────────────────────────────────────────────────────

test("non-numeric kinds pass through untouched (type fidelity)", () => {
  // The row's editor must come back holding something it can edit: a color row
  // gets its hex, a boolean its boolean, a select/text/asset row its string.
  assert.equal(evaluatedLiteral("#ff0000", 3), "#ff0000");
  assert.equal(evaluatedLiteral(true, 3), true);
  assert.equal(evaluatedLiteral(false, 3), false);
  assert.equal(evaluatedLiteral("multiply", 3), "multiply");
  assert.equal(evaluatedLiteral("some caption", 3), "some caption");
});

test("rounding NEVER coerces a non-number into one", () => {
  // The guard that keeps the tidy branch from turning a string row into 0 —
  // the silent-wrong-value class this codebase forbids.
  for (const v of ["#ff0000", true, "multiply", null, undefined])
    assert.equal(evaluatedLiteral(v, 3), v);
});

// ── PURE: the refusal ────────────────────────────────────────────────────────

test("a healthy equation bakes", () => {
  assert.equal(evaluateLiteralProblem(42, null), null);
  assert.equal(evaluateLiteralProblem("#ff0000", null), null);
  assert.equal(evaluateLiteralProblem(false, null), null);
});

test("an ERRORING equation is refused, naming the fallback", () => {
  // The decision this feature had to make: an errored equation evaluates to the
  // plugin FALLBACK, so baking it would stamp a default nobody chose over the
  // only record of the author's intent — while the row is visibly complaining.
  const why = evaluateLiteralProblem(42, 'Unknown variable "spedd"');
  assert.ok(why, "an errored row must refuse to bake");
  assert.match(why, /fallback/, "the reason must say WHAT would be baked");
  assert.match(why, /fix or clear it/, "the reason must say what to do instead");
});

test("a valueless or non-finite equation is refused too", () => {
  assert.ok(evaluateLiteralProblem(undefined, null));
  assert.ok(evaluateLiteralProblem(null, null));
  assert.ok(evaluateLiteralProblem(Infinity, null));
  assert.ok(evaluateLiteralProblem(NaN, null));
  // ...and evaluatedLiteral leaves a non-finite number ALONE rather than
  // rounding it into garbage, so the refusal above is what the caller sees.
  assert.equal(evaluatedLiteral(Infinity, 3), Infinity);
});

// ── ROUND TRIP: a real document ──────────────────────────────────────────────

/** Query. Fold + evaluate slide 0 through the real registry. */
function evaluated(doc) {
  return evaluateState(foldState(doc, 0, 1), registry);
}

test("equation in → literal out → undo restores the equation", () => {
  const rect = registry.get("rect");
  let doc = newDocument();
  let sourceId, boundId;
  [doc, sourceId] = withNewItem(doc, 0, { ...rect.defaults, x: 100, y: 0, w: 40, h: 20, active: true });
  [doc, boundId] = withNewItem(doc, 0, { ...rect.defaults, x: 0, y: 0, w: 40, h: 20, active: true });
  // The bound row: x = the other rect's x + 10, i.e. 110.
  doc = keyframed(doc, 0, ["items", boundId, "x"], `=@${sourceId}.x + 10`);

  const path = ["items", boundId, "x"];
  const undo = createUndo(doc);

  // BEFORE: the STORED value is the expression; the EVALUATED value is 110.
  const storedBefore = foldState(undo.doc, 0, 1).items[boundId].x;
  assert.equal(typeof storedBefore, "string", "the row stores an equation");
  assert.ok(isEquationValue(rect, ["x"], storedBefore));
  const { state, errors } = evaluated(undo.doc);
  assert.equal(errors.size, 0, `unexpected expression errors: ${[...errors.values()].join("; ")}`);
  assert.equal(state.items[boundId].x, 110);

  // THE BAKE — reads the EVALUATED tree (this is the direction that is correct
  // here; the stored tree would write the string "=@id.x + 10" as a literal).
  assert.equal(evaluateLiteralProblem(state.items[boundId].x, null), null);
  undo.commit(keyframed(undo.doc, 0, path, evaluatedLiteral(state.items[boundId].x, EVALUATE_DECIMALS)));

  // AFTER: a plain number, and no longer an equation.
  const storedAfter = foldState(undo.doc, 0, 1).items[boundId].x;
  assert.equal(storedAfter, 110);
  assert.equal(typeof storedAfter, "number");
  assert.equal(isEquationValue(rect, ["x"], storedAfter), false, "the binding is destroyed");

  // ONE UNDO UNIT: a single undo brings the expression back verbatim.
  undo.undo();
  assert.equal(foldState(undo.doc, 0, 1).items[boundId].x, storedBefore);
  assert.equal(undo.canUndo, false, "the bake was exactly one undo unit");
});

test("baking FREEZES a slide-varying equation (the tooltip's warning is true)", () => {
  // The user-visible consequence the tooltip has to warn about: an equation
  // animating via a slide-varying reference becomes one fixed number.
  const rect = registry.get("rect");
  let doc = newDocument();
  let sourceId, boundId;
  [doc, sourceId] = withNewItem(doc, 0, { ...rect.defaults, x: 100, y: 0, w: 40, h: 20, active: true });
  [doc, boundId] = withNewItem(doc, 0, { ...rect.defaults, x: 0, y: 0, w: 40, h: 20, active: true });
  doc = keyframed(doc, 0, ["items", boundId, "x"], `=@${sourceId}.x`);
  // Slide 1 moves the SOURCE, so the bound row follows it while it is an equation.
  doc = { ...doc, slides: [...doc.slides, { ...doc.slides[0], id: "s2", delta: {} }] };
  doc = keyframed(doc, 1, ["items", sourceId, "x"], 500);

  const onSlide = (i) => evaluateState(foldState(doc, i, 1), registry).state.items[boundId].x;
  assert.equal(onSlide(0), 100);
  assert.equal(onSlide(1), 500, "while bound, the row tracks the source across slides");

  // Bake on slide 0, then look at slide 1: it no longer follows.
  const baked = keyframed(doc, 0, ["items", boundId, "x"], evaluatedLiteral(onSlide(0)));
  const bakedOn = (i) => evaluateState(foldState(baked, i, 1), registry).state.items[boundId].x;
  assert.equal(bakedOn(0), 100);
  assert.equal(bakedOn(1), 100, "baked: the value that changed across slides is now fixed");
});

console.log(`\nevaluate_literal_test: ${passed} passed`);
