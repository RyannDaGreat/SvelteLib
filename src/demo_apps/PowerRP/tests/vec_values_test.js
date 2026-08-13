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
} from "../core/vector_values.js";
import { interpolate } from "../core/interpolators.js";

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
  const src = readFileSync(new URL("../core/vector_values.js", import.meta.url), "utf8");
  const algebra = src.slice(src.indexOf("// ── THE ALGEBRA"));
  for (const forbidden of ['"pos"', '"size"', '"color"'])
    assert.ok(!algebra.includes(`kind === ${forbidden}`),
      `the algebra must not branch on ${forbidden}`);
  assert.ok(!/\.length === [234]\b/.test(algebra),
    "the algebra must not branch on a specific arity");
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

console.log(`vec_values_test: ${passed} passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
