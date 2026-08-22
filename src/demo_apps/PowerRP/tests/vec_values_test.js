/**
 * VECTOR VALUES — the acceptance suite for R7-38 / R7-38b / R7-38c.
 *
 * Bare node, no DOM (core/ modules must run in bare node — CLAUDE.md).
 *
 * WHAT THIS SUITE IS FOR, beyond "the functions return the right numbers": every
 * ruling in this workstream is a claim that can rot silently. "A bound colour
 * tweens continuously" degrades into a discrete switch that looks deliberate;
 * "adding a kind needs no evaluator edit" degrades the first time someone writes
 * `if (kind === "pos")`; "documents are byte-identical" degrades the first time a
 * write reformats a hex. Each of those has a test here that fails when the claim
 * stops being true, rather than a comment asserting it.
 *
 * Run: node src/demo_apps/PowerRP/tests/vec_values_test.js
 */

import assert from "node:assert/strict";
import {
  VECTOR_KINDS, VECTOR_ADDRESS_FOR_COMPOUND, COLOR_VECTOR_ARITY, COLOR_CHANNEL_MAX,
  colorAlphaIsPaintLocal, isVectorAxis, colorChannelValue, colorBytes, withColorChannel,
  vectorRead, vectorWrite, vectorInterpolate, vectorInterpolationIsContinuous,
  paintColorPath, paintColorRefusal, foldColorComponent,
  makeVector, isNumericTensor, vectorValues, shapeMismatchRefusal, zipTensors,
  vectorBinaryOp, vectorMapFunction, vectorMapVariadic, vectorFor, vectorToStored,
  VEC2_ROW_KIND, isVec2Value,
} from "../core/vector_values.js";
import { interpolate } from "../core/interpolators.js";
import { ROW_KINDS } from "../core/properties.js";
import { VAR_KINDS, VAR_KIND_ZEROS } from "../core/var_kinds.js";

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

// ── THE RULINGS' OWN SPELLINGS ──────────────────────────────────────────────
// "thing.xy.x is stupid sounding. it should be like .pos.x or .pos.y"

test("the address for x/y is `pos`, not `xy` (2026-08-13 ruling)", () => {
  assert.deepEqual(VECTOR_KINDS.pos.axes, ["x", "y"]);
  assert.equal(VECTOR_KINDS.xy, undefined, "`xy` must not be an address kind");
  assert.equal(VECTOR_ADDRESS_FOR_COMPOUND.xy, "pos");
});

test("colour has FOUR addressable components, alpha included", () => {
  assert.deepEqual(VECTOR_KINDS.color.axes, ["r", "g", "b", "a"]);
  assert.equal(COLOR_VECTOR_ARITY, 4);
  assert.ok(isVectorAxis("color", "a"), "`.color.a` is a real address");
});

test("a colour's alpha is paint-local and never the item's opacity", () => {
  // The NEGATIVE requirement ("must not silently multiply twice") as an assertion.
  assert.equal(colorAlphaIsPaintLocal(), true);
  // Writing .a touches ONLY the colour's own digits — no other key appears.
  const written = vectorWrite("color", withColorChannel("#ff0000", "a", 0.5));
  assert.deepEqual(written, [[[], "#ff000080"]]);
});

// ── THE COMPONENT VIEW OVER A HEX COLOUR ────────────────────────────────────

test("channels read out of every hex spelling a document can hold", () => {
  assert.equal(colorChannelValue("#ff8000", "r"), 255);
  assert.equal(colorChannelValue("#ff8000", "g"), 128);
  assert.equal(colorChannelValue("#ff8000", "b"), 0);
  assert.equal(colorChannelValue("#f80", "r"), 255, "3-digit shorthand");
  assert.equal(colorChannelValue("#ff0000", "a"), 1, "plain #rrggbb is opaque");
  assert.equal(colorChannelValue("#ff000080", "a"), 128 / COLOR_CHANNEL_MAX);
  assert.deepEqual(colorBytes([255, 128, 0]), [255, 128, 0, 255]);
});

test("an unreadable colour is null, NEVER a silent 0 that would paint black", () => {
  assert.equal(colorChannelValue("rebeccapurple", "r"), null, "a CSS name is not decomposable here");
  assert.equal(colorChannelValue(42, "r"), null);
  assert.equal(withColorChannel("nope", "r", 1), null);
  assert.equal(colorBytes(null), null);
});

test("writing one channel preserves the others byte-for-byte", () => {
  assert.equal(withColorChannel("#123456", "r", 255), "#ff3456");
  assert.equal(withColorChannel("#123456", "g", 255), "#12ff56");
  assert.equal(withColorChannel("#123456", "b", 255), "#1234ff");
});

test("an opaque result stays 6-digit, so a component edit is a minimal diff", () => {
  // Without this, the first .r edit on any deck rewrites every colour longer.
  assert.equal(withColorChannel("#ff0000", "g", 128), "#ff8000");
  assert.equal(withColorChannel("#ff000080", "a", 1), "#ff0000");
  assert.equal(withColorChannel("#ff0000", "a", 0.5), "#ff000080");
});

test("out-of-range channels CLAMP, never wrap", () => {
  // A wrap would turn an overshooting equation into a DARK red — a wrong picture
  // that looks intentional.
  assert.equal(withColorChannel("#000000", "r", 300), "#ff0000");
  assert.equal(withColorChannel("#ffffff", "r", -50), "#00ffff");
});

// ── THE HONEST PER-COMPONENT KEYFRAME (the R7-36 refusal's objection) ───────

test("a component keyframe leaves un-keyed channels FOLLOWING the base", () => {
  // THE honesty property. Key R only; then change the base's green. Green must
  // move, because "only R is keyframed here" means exactly that. A stored
  // whole-colour keyframe would have frozen it — the lie this shape refuses.
  assert.equal(foldColorComponent("#123456", { r: 255 }), "#ff3456");
  assert.equal(foldColorComponent("#12ff56", { r: 255 }), "#ffff56");
});

test("no keyed channel returns the base's own spelling untouched", () => {
  assert.equal(foldColorComponent("#f80", {}), "#f80", "byte-identical, not round-tripped");
  assert.equal(foldColorComponent("#123456", {}), "#123456");
});

test("several keyed channels compose", () => {
  assert.equal(foldColorComponent("#000000", { r: 255, b: 128 }), "#ff0080");
});

// ── WHAT `fill.color` MEANS PER PAINT KIND ──────────────────────────────────

test("the colour address maps onto BOTH storage shapes", () => {
  assert.deepEqual(paintColorPath("#7aa2f7"), [], "a bare string IS the colour");
  assert.deepEqual(paintColorPath({ type: "solid", solid: "#ff0000" }), ["solid"]);
  assert.deepEqual(
    paintColorPath({ type: "linearGradient", linear: {}, solid: "#ff0000" }),
    ["solid"],
    "a gradient's REMEMBERED solid is a real stored value",
  );
});

test("paints with no colour REFUSE with a sentence, never a silent black", () => {
  for (const paint of [{ type: "none" }, { type: "material", material: {} }, { type: "crossfade" }]) {
    assert.equal(paintColorPath(paint), null);
    const sentence = paintColorRefusal(paint, "fill.color");
    assert.ok(sentence && sentence.includes("fill.color"), `must name the reference: ${sentence}`);
  }
  assert.equal(paintColorRefusal("#ff0000", "fill.color"), null, "a real colour is not refused");
});

test("the material refusal points at the knobs that DO exist", () => {
  const sentence = paintColorRefusal({ type: "material", material: {} }, "fill.color");
  assert.ok(sentence.includes("fill.material.params"), `a refusal must be actionable: ${sentence}`);
});

// ── WHOLE-VECTOR READ / WRITE ───────────────────────────────────────────────

test("a leaves-vector reads as a tuple and writes as its leaves", () => {
  assert.deepEqual(vectorRead("pos", { x: 10, y: 20, w: 5 }), [10, 20]);
  assert.deepEqual(vectorRead("size", { w: 100, h: 50 }), [100, 50]);
  assert.deepEqual(vectorWrite("pos", [10, 20]), [[["x"], 10], [["y"], 20]]);
});

test("a colour reads as its authored spelling, not a tuple", () => {
  // `= brandColor` must keep producing "#7aa2f7": every colour consumer speaks hex.
  assert.equal(vectorRead("color", "#7aa2f7"), "#7aa2f7");
  assert.deepEqual(vectorWrite("color", "#ff0000"), [[[], "#ff0000"]]);
});

test("a missing leaf or wrong arity is null, never zero-padded", () => {
  assert.equal(vectorRead("pos", { x: 10 }), null);
  assert.equal(vectorWrite("pos", [10]), null);
  assert.equal(vectorWrite("color", 42), null);
});

// ── INTERPOLATION IS CONTINUOUS (R7-38 point 5) ─────────────────────────────

test("whole-vector values tween componentwise, not discretely", () => {
  assert.deepEqual(vectorInterpolate("pos", [0, 0], [10, 20], 0.5), [5, 10]);
  assert.equal(vectorInterpolate("color", "#000000", "#ffffff", 0.5), "#808080");
  assert.ok(vectorInterpolationIsContinuous("pos", [0, 0], [10, 20]));
  assert.ok(vectorInterpolationIsContinuous("color", "#000000", "#ffffff"));
});

test("a 2-vec does NOT int-round — a coordinate is continuous", () => {
  assert.deepEqual(vectorInterpolate("pos", [0, 0], [1, 1], 0.25), [0.25, 0.25]);
});

test("a colour fade tweens alpha with the rest", () => {
  assert.equal(vectorInterpolate("color", "#ff0000", "#ff000000", 0.5), "#ff000080");
});

test("vector interp AGREES with core/interpolators for the same values", () => {
  // The two must not drift: a bound whole-vector value routes through the
  // ordinary interpolate() at the fold, so a divergence here would mean the
  // Inspector's preview and the rendered frame disagreed.
  assert.deepEqual(vectorInterpolate("pos", [0, 0], [10, 20], 0.5), interpolate([0, 0], [10, 20], 0.5));
  assert.equal(vectorInterpolate("color", "#000000", "#ffffff", 0.5), interpolate("#000000", "#ffffff", 0.5));
});

// ── THE NUMPY ALGEBRA (R7-38b) ──────────────────────────────────────────────

const APPLY = (op, l, r) => {
  if (op === "+") return l + r;
  if (op === "-") return l - r;
  if (op === "*") return l * r;
  if (op === "/") return l / r;
  if (op === "%") return l % r;
  if (op === "**") return l ** r;
  throw new Error(`unknown op ${op}`);
};

test("a.pos = b.pos + c.pos — the user's own worked example", () => {
  const b = makeVector([10, 20]), c = makeVector([1, 2]);
  assert.deepEqual(vectorBinaryOp("+", b, c, APPLY), makeVector([11, 22]));
  assert.deepEqual(vectorToStored("pos", vectorBinaryOp("+", b, c, APPLY)), [11, 22]);
});

test("every binary operator is elementwise", () => {
  const a = makeVector([6, 8]), b = makeVector([2, 4]);
  assert.deepEqual(vectorValues(vectorBinaryOp("-", a, b, APPLY)), [4, 4]);
  assert.deepEqual(vectorValues(vectorBinaryOp("*", a, b, APPLY)), [12, 32]);
  assert.deepEqual(vectorValues(vectorBinaryOp("/", a, b, APPLY)), [3, 2]);
  assert.deepEqual(vectorValues(vectorBinaryOp("%", a, b, APPLY)), [0, 0]);
  assert.deepEqual(vectorValues(vectorBinaryOp("**", b, makeVector([2, 2]), APPLY)), [4, 16]);
});

test("a scalar broadcasts, in BOTH operand orders", () => {
  assert.deepEqual(vectorValues(vectorBinaryOp("*", makeVector([3, 4]), 2, APPLY)), [6, 8]);
  assert.deepEqual(vectorValues(vectorBinaryOp("+", 100, makeVector([1, 2]), APPLY)), [101, 102]);
  // Non-commutative ops keep their order under broadcast — the trap a naive
  // implementation falls into by always putting the vector on the left.
  assert.deepEqual(vectorValues(vectorBinaryOp("-", 10, makeVector([1, 2]), APPLY)), [9, 8]);
  assert.deepEqual(vectorValues(vectorBinaryOp("-", makeVector([10, 20]), 1, APPLY)), [9, 19]);
});

test("two scalars stay plain numbers — no wrapper leaks into scalar math", () => {
  assert.equal(vectorBinaryOp("+", 2, 3, APPLY), 5);
});

test("math functions map elementwise (sin, cos, abs)", () => {
  assert.deepEqual(vectorValues(vectorMapFunction(Math.abs, makeVector([-1, 2, -3]))), [1, 2, 3]);
  assert.deepEqual(vectorValues(vectorMapFunction(Math.sin, makeVector([0, 0]))), [0, 0]);
  assert.deepEqual(vectorValues(vectorMapFunction(Math.cos, makeVector([0, 0]))), [1, 1]);
  assert.equal(vectorMapFunction(Math.abs, -5), 5, "a scalar passes through");
});

test("variadic math (min/max) zips across arguments and broadcasts scalars", () => {
  assert.deepEqual(vectorValues(vectorMapVariadic(Math.max, [makeVector([-5, 10]), 0])), [0, 10]);
  assert.deepEqual(vectorValues(vectorMapVariadic(Math.min, [makeVector([1, 8]), makeVector([4, 2])])), [1, 2]);
  assert.equal(vectorMapVariadic(Math.max, [3, 9]), 9);
});

test("a SHAPE MISMATCH refuses with a sentence — no truncation, fill or NaN", () => {
  assert.equal(shapeMismatchRefusal([1, 2], [1, 2, 3], "+"),
    'cannot "+" a 2-vector and a 3-vector — operands must have the same length');
  assert.equal(shapeMismatchRefusal([1, 2], [3, 4], "+"), null);
  assert.throws(
    () => vectorBinaryOp("+", makeVector([1, 2]), makeVector([1, 2, 3]), APPLY),
    /2-vector and a 3-vector/,
  );
  assert.throws(
    () => vectorMapVariadic(Math.max, [makeVector([1, 2]), makeVector([1, 2, 3])]),
    /same length/,
  );
});

test("a BARE array is not a tensor — a polyline must never broadcast", () => {
  assert.equal(isNumericTensor([1, 2]), false);
  assert.equal(isNumericTensor(makeVector([1, 2])), true);
  assert.equal(isNumericTensor("#ff0000"), false);
  assert.equal(isNumericTensor({ __vec: ["a", "b"] }), false, "non-numeric data is not a tensor");
  assert.equal(vectorValues(5), null);
});

test("zipTensors reports whether the RESULT is a vector", () => {
  assert.equal(zipTensors(makeVector([1, 2]), 10, "*").vector, true);
  assert.equal(zipTensors(10, makeVector([1, 2]), "*").vector, true);
  assert.equal(zipTensors(3, 4, "+").vector, false);
});

// ── THE ALGEBRA/ADDRESS BRIDGE ──────────────────────────────────────────────

test("a colour enters the algebra as channels and returns as a hex", () => {
  assert.deepEqual(vectorValues(vectorFor("color", "#ff8000")), [255, 128, 0, 255]);
  // `= fill.color * 0.5` scales EVERY component, alpha included — so the result
  // is half-brightness AND half-opacity. That is elementwise NumPy semantics
  // applied honestly to a 4-vec, and it is deliberately NOT special-cased:
  // exempting alpha would mean the algebra knew what a "colour" is, which is
  // exactly the kind-specific branching R7-38c forbids. An author who wants
  // brightness alone scales the channels they mean, or writes `.a` back.
  const half = vectorBinaryOp("*", vectorFor("color", "#ff8000"), 0.5, APPLY);
  assert.equal(vectorToStored("color", half), "#80400080");
  // ...and the opaque-preserving form is one component write away:
  assert.equal(withColorChannel(vectorToStored("color", half), "a", 1), "#804000");
});

test("an algebraic result lands back on real leaves", () => {
  const sum = vectorBinaryOp("+", vectorFor("pos", { x: 1, y: 2 }), vectorFor("pos", { x: 10, y: 20 }), APPLY);
  assert.deepEqual(vectorWrite("pos", vectorToStored("pos", sum)), [[["x"], 11], [["y"], 22]]);
});

test("a wrong-arity result is refused rather than padded into a slot", () => {
  assert.equal(vectorToStored("pos", makeVector([1, 2, 3])), null);
  assert.equal(vectorToStored("color", makeVector([1, 2])), null);
});

test("colour arithmetic CLAMPS on the way back to storage", () => {
  // Overshooting a channel must saturate, not wrap to a dark colour.
  const doubled = vectorBinaryOp("*", vectorFor("color", "#808080"), 4, APPLY);
  assert.equal(vectorToStored("color", doubled), "#ffffff");
});

// ── THE GENERALITY CLAIM (R7-38c): NAMED n-VECS, NOT SPECIAL CASES ──────────

test("a NEW vector kind needs no operator, evaluator or algebra edit", () => {
  // The claim "adding `uv` is a declaration entry and zero edits" — executed.
  // Every algebra function below is called with a length the shipped kinds do
  // not have, and none of them knows any kind name at all.
  const five = makeVector([1, 2, 3, 4, 5]);
  assert.deepEqual(vectorValues(vectorBinaryOp("+", five, 1, APPLY)), [2, 3, 4, 5, 6]);
  assert.deepEqual(vectorValues(vectorMapFunction(Math.abs, makeVector([-1, -2, -3, -4, -5, -6, -7]))),
    [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    vectorValues(vectorBinaryOp("*", makeVector([1, 2, 3]), makeVector([2, 2, 2]), APPLY)),
    [2, 4, 6],
    "a 3-vec works with no 3-specific branch",
  );
});

test("the algebra's source mentions no kind name and no arity", () => {
  // A STRUCTURAL guard on the generality claim: the day someone writes
  // `if (kind === "pos")` inside an operator, this fails. Prose cannot catch it.
  //
  // THE REGION IS BOUNDED AT BOTH ENDS, AND THE PATTERNS ARE THE PROPERTY, NOT A
  // SPELLING OF IT. This test used to slice from the marker to END OF FILE and
  // grep for `kind === "pos"` and `.length === 2` — which the file satisfied by
  // wording alone: `axesForArity` branches on `n === 2/3/4` with literal axis
  // names and `makeVector` reads `VECTOR_KINDS[kind]`, both inside the slice,
  // and it passed. Those two are the NAMING layer and the tail of the file is the
  // kind-aware ADDRESS BRIDGE; the markers now bound exactly the operators the
  // claim is about, and the patterns catch any spelling of an arity or a kind
  // lookup rather than one.
  // COMMENTS ARE STRIPPED FIRST: the guard is about what the CODE branches on,
  // and the region's own header has to be able to NAME the things it forbids
  // (`VECTOR_KINDS`, `pos`) without tripping its own check.
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const src = readFileSync(new URL("../core/vector_values.js", import.meta.url), "utf8");
  const start = src.indexOf("// ── THE ALGEBRA: ");
  const end = src.indexOf("// ── THE ADDRESS BRIDGE");
  assert.ok(start > 0 && end > start, "the algebra region must be bounded at both ends");
  const algebra = stripComments(src.slice(start, end));
  for (const forbidden of ['"pos"', '"size"', '"color"'])
    assert.ok(!algebra.includes(forbidden),
      `the algebra must not mention ${forbidden}`);
  assert.ok(!/=== [234]\b/.test(algebra),
    "the algebra must not branch on a specific arity");
  assert.ok(!algebra.includes("VECTOR_KINDS"),
    "the algebra must not read the kind table — that is the address bridge's job");
  // The guard is only worth having if it can FAIL: the naming layer it now
  // excludes really does contain both patterns.
  const naming = stripComments(src.slice(src.indexOf("// ── THE VALUE LAYER"), start));
  assert.ok(/=== [234]\b/.test(naming) && naming.includes("VECTOR_KINDS"),
    "the excluded naming layer must be the thing the guard would have caught");
});

test("VECTOR_KINDS is the only place component names live", () => {
  // The naming layer is per-kind metadata, so a dict-like or rank-2 kind can be
  // added as data. Every shipped kind declares axes and a via; nothing else.
  for (const [kind, decl] of Object.entries(VECTOR_KINDS)) {
    assert.ok(Array.isArray(decl.axes) && decl.axes.length > 0, `${kind} declares axes`);
    assert.ok(["leaves", "composite"].includes(decl.via), `${kind} declares a storage direction`);
  }
});

import { readFileSync } from "node:fs";


// ── END-TO-END THROUGH A REAL evaluateState PASS ────────────────────────────
//
// Everything above tests the value layer in isolation. THIS SECTION IS THE ONE
// THAT PROVES THE FEATURE, because the whole workstream turns on a claim about
// the EVALUATOR: that `a.pos = b.pos + c.pos` survives compilation through
// `new Function` + `with(scope)`, where a vector cannot be produced by `+` at
// all (Symbol.toPrimitive must return a primitive — measured TypeError). A unit
// test of vectorBinaryOp cannot see that; only a real equation can.

import { createRegistry } from "../core/registry.js";
import { evaluateState } from "../core/expressions.js";
import { rectPlugin } from "../plugins/rect.js";

const registry = createRegistry();
registry.register(rectPlugin);

/** Query. Evaluates one document and returns {state, errors} — no memo reuse
 *  (evaluateState memoizes on state identity, so each call builds a fresh object). */
function evaluate(items, vars = {}) {
  return evaluateState({ vars, items }, registry);
}

/** Query. The evaluated value of item `id`'s property `key`, asserting no errors. */
function evalProp(items, id, key, vars = {}) {
  const { state, errors } = evaluate(items, vars);
  assert.equal(errors.size, 0, `unexpected errors: ${[...errors.values()].join("; ")}`);
  return state.items[id][key];
}

/** A rect fixture. `name` is what makes an item REFERENCABLE — slugMap derives
 *  the equation slug from it, so a fixture without one cannot be named by `= b.…`. */
const RECT = (name, extra) => ({ ...rectPlugin.defaults, type: "rect", name, ...extra });

test("E2E: a whole-vector address `.pos` evaluates to a vector", () => {
  const v = evalProp({
    b: RECT("b", { x: 10, y: 20 }),
    a: RECT("a", { w: "= b.pos.x" }),
  }, "a", "w");
  assert.equal(v, 10, "a component of a vector address reads through the evaluator");
});

test("E2E: a.pos = b.pos + c.pos — THE user's worked example, really compiled", () => {
  // The x leaf of `a` is bound to the SUM of two vectors, projected. If the
  // compile rewrite regressed, this throws "Cannot convert object to primitive".
  const { state, errors } = evaluate({
    b: RECT("b", { x: 10, y: 20 }),
    c: RECT("c", { x: 1, y: 2 }),
    a: RECT("a", { x: "= (b.pos + c.pos).x", y: "= (b.pos + c.pos).y" }),
  });
  assert.equal(errors.size, 0, `errors: ${[...errors.values()].join("; ")}`);
  assert.equal(state.items.a.x, 11);
  assert.equal(state.items.a.y, 22);
});

test("E2E: scalar broadcast through a real equation", () => {
  const { state, errors } = evaluate({
    b: RECT("b", { x: 3, y: 4 }),
    a: RECT("a", { x: "= (b.pos * 2).x", y: "= (b.pos * 2).y" }),
  });
  assert.equal(errors.size, 0, `errors: ${[...errors.values()].join("; ")}`);
  assert.equal(state.items.a.x, 6);
  assert.equal(state.items.a.y, 8);
});

test("E2E: sin/abs map elementwise over a vector in a real equation", () => {
  const { state, errors } = evaluate({
    b: RECT("b", { x: -5, y: -7 }),
    a: RECT("a", { x: "= abs(b.pos).x", y: "= abs(b.pos).y" }),
  });
  assert.equal(errors.size, 0, `errors: ${[...errors.values()].join("; ")}`);
  assert.equal(state.items.a.x, 5);
  assert.equal(state.items.a.y, 7);
  // sin over a vector, projected — the ruling's own "sin cos etc" example.
  assert.equal(evalProp({ b: RECT("b", { x: 0, y: 0 }), a: RECT("a", { w: "= sin(b.pos).x" }) }, "a", "w"), 0);
});

test("E2E: max(vec, scalar) broadcasts through the variadic path", () => {
  const { state, errors } = evaluate({
    b: RECT("b", { x: -5, y: 10 }),
    a: RECT("a", { x: "= max(b.pos, 0).x", y: "= max(b.pos, 0).y" }),
  });
  assert.equal(errors.size, 0, `errors: ${[...errors.values()].join("; ")}`);
  assert.equal(state.items.a.x, 0, "the negative component clamps");
  assert.equal(state.items.a.y, 10, "the positive one is untouched");
});

test("E2E: SCALAR equations are completely unaffected by the compile rewrite", () => {
  // The back-compat guarantee: an expression with operators but no vector must
  // evaluate exactly as it always did, through the same __op host.
  assert.equal(evalProp({ a: RECT("a", { w: "= 2 + 3 * 4" }) }, "a", "w"), 14, "precedence survives");
  assert.equal(evalProp({ a: RECT("a", { w: "= (2 + 3) * 4" }) }, "a", "w"), 20, "parens survive");
  assert.equal(evalProp({ a: RECT("a", { w: "= 7 % 3" }) }, "a", "w"), 1, "modulo survives");
  assert.equal(evalProp({ a: RECT("a", { w: "= -(1 + 1)" }) }, "a", "w"), -2, "unary minus survives");
  assert.equal(evalProp({ a: RECT("a", { w: "= speed * 2" }) }, "a", "w", { speed: 21 }), 42, "variables survive");
});

test("E2E: a SHAPE MISMATCH surfaces through the normal equation-error path", () => {
  // Not a crash, not a NaN that paints — an error in the errors map, with the
  // sentence naming both lengths.
  const { errors } = evaluate({
    b: RECT("b", { x: 1, y: 2, fill: "#ff0000" }),
    a: RECT("a", { x: "= (b.pos + b.fill.color).x" }),
  });
  assert.ok(errors.size > 0, "a 2-vec + 4-vec must be an error");
  const text = [...errors.values()].join("; ");
  assert.ok(/2-vector and a 4-vector/.test(text), `must name both lengths, got: ${text}`);
});

test("E2E: fill.color and its components read through the evaluator", () => {
  const items = { b: RECT("b", { fill: "#ff8000" }), a: RECT("a", { w: "= b.fill.color.r", h: "= b.fill.color.g" }) };
  const { state, errors } = evaluate(items);
  assert.equal(errors.size, 0, `errors: ${[...errors.values()].join("; ")}`);
  assert.equal(state.items.a.w, 255);
  assert.equal(state.items.a.h, 128);
});

test("E2E: an OFF paint's .color refuses with its sentence, not a silent black", () => {
  const { errors } = evaluate({
    b: RECT("b", { fill: { type: "none" } }),
    a: RECT("a", { w: "= b.fill.color.r" }),
  });
  assert.ok(errors.size > 0, "an off paint must refuse");
  assert.ok(/is Off/.test([...errors.values()].join("; ")), "the sentence must say it is off");
});

test("E2E: a colour arithmetic result lands back on a colour slot", () => {
  // `= fill.color * 0.5` must produce a real hex a paint consumer can read.
  const { state, errors } = evaluate({
    b: RECT("b", { fill: "#ff8000" }),
    a: RECT("a", { fill: "= b.fill.color * 0.5" }),
  });
  assert.equal(errors.size, 0, `errors: ${[...errors.values()].join("; ")}`);
  assert.equal(state.items.a.fill, "#80400080", "alpha scales too — the documented, pinned behaviour");
});


// ── VEC2 VARIABLES (R7-38 point 4: a whole vector bound to a variable) ──────

test("E2E: a vec2 variable reads whole and per-component", () => {
  const vars = { origin: [10, 20] };
  const { state, errors } = evaluate({
    a: RECT("a", { x: "= origin.x", y: "= origin.y" }),
  }, vars);
  assert.equal(errors.size, 0, `errors: ${[...errors.values()].join("; ")}`);
  assert.equal(state.items.a.x, 10);
  assert.equal(state.items.a.y, 20);
});

test("E2E: a vec2 variable enters the ALGEBRA as a vector", () => {
  const { state, errors } = evaluate({
    a: RECT("a", { x: "= (origin + offset).x", y: "= (origin + offset).y" }),
  }, { origin: [10, 20], offset: [1, 2] });
  assert.equal(errors.size, 0, `errors: ${[...errors.values()].join("; ")}`);
  assert.equal(state.items.a.x, 11);
  assert.equal(state.items.a.y, 22);
});

test("E2E: a non-vector variable's component is refused with a sentence", () => {
  const { errors } = evaluate({ a: RECT("a", { x: "= speed.x" }) }, { speed: 5 });
  assert.ok(errors.size > 0, "a scalar variable has no components");
  assert.ok(/has no component/.test([...errors.values()].join("; ")),
    `must name the problem: ${[...errors.values()].join("; ")}`);
});

test("E2E: an UNKNOWN dotted head still reports the unknown reference", () => {
  // The resolveRef fallback must not swallow a genuine typo into a vague error.
  const { errors } = evaluate({ a: RECT("a", { x: "= nosuchthing.x" }) });
  assert.ok(errors.size > 0, "an unknown head must still fail");
  const text = [...errors.values()].join("; ");
  assert.ok(/nosuchthing/.test(text), `must name the bad reference: ${text}`);
});

test("a vec2 variable's STORED value carries no runtime tag", () => {
  // The tag (makeVector) is a runtime wrapper the evaluator adds on READ; a
  // document must never contain it, or a saved deck would carry `__vec` keys.
  const { state, errors } = evaluate({ a: RECT("a", { x: "= origin.x" }) }, { origin: [10, 20] });
  assert.equal(errors.size, 0);
  assert.deepEqual(state.vars.origin, [10, 20], "the variable stays a plain tuple");
  assert.equal(isNumericTensor(state.vars.origin), false);
});

test("the vec2 VAR KIND ships, and it ships WITH a control (the omission, resolved)", () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and the flip is the point. It pinned
  // "there is deliberately NO vec2 var kind" — an assertion of HONESTY, not of
  // permanence: the kind was withheld because declaring it without a control
  // would have put an uneditable variable in the panel. The control now exists
  // (VEC2_ROW_KIND, Vector2Pad over a single tuple slot), so the same spirit is
  // now served by asserting the kind and its control landed TOGETHER.
  assert.ok(VAR_KINDS.includes("vec2"), "the vec2 variable kind is declared");
  assert.ok(ROW_KINDS.includes(VEC2_ROW_KIND),
    "and it names a REAL row kind — the invariant the omission was protecting");
  // The zero is a PLAIN tuple: the `__vec` tag is a runtime wrapper the
  // evaluator adds on read, and a zero carrying one would write it into every
  // new variable's first keyframe.
  assert.deepEqual(VAR_KIND_ZEROS.vec2, [0, 0]);
  assert.equal(isNumericTensor(VAR_KIND_ZEROS.vec2), false, "the STORED zero carries no tag");
  assert.ok(isVec2Value(VAR_KIND_ZEROS.vec2), "and it is a legal vec2 value of its own kind");
});

console.log(`vec_values_test: ${passed} passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
