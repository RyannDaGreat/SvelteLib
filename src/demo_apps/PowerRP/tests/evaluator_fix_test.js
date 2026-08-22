/**
 * THE EVALUATOR REPAIR SUITE — one pin per defect fixed in the evaluator/vector
 * area, each written so it FAILS on the code as it stood before the fix.
 *
 * Bare node, no DOM. Run:
 *   node src/demo_apps/PowerRP/tests/evaluator_fix_test.js
 *
 * WHY A SUITE OF ITS OWN RATHER THAN LINES ADDED TO SIX FILES. Every case here
 * is a claim some existing docblock or commit message ALREADY made and the code
 * did not keep — a font variable that evaluates, a channel keyframe that tweens
 * over a tagged paint, a projection that works after arithmetic. Keeping them
 * together makes the set of "things that were confidently wrong" legible; each
 * test names the sentence it is holding the code to.
 *
 * THE HEADLINE IS THE FIRST SECTION: the user's own bug report. A Font row bound
 * to `= note_font`, where `note_font` is a `font`-kind variable holding
 * "jetbrains-mono", reported *"= expression result 0 is not a valid string
 * value"* — the id was parsed as the expression `jetbrains - mono`.
 */

import assert from "node:assert/strict";
import { evaluateState, parseExpression, evalAst, toJsExpr, isVarEquation, isNumericSlot, isEquationValue } from "../core/expressions.js";
import { blendApplied } from "../core/deltas.js";
import {
  resolveColorComponentDelta, colorComponentDelta, isColorChannelSet, isPaintValue,
  axesForArity, makeVector, withColorChannel, colorChannelKeyframeValue,
} from "../core/vector_values.js";
import { VAR_KIND_RESULT, VAR_KIND_ZEROS, VAR_KINDS, repairedVarKinds } from "../core/var_kinds.js";
import { createRegistry } from "../core/registry.js";
import { newDocument, withNewItem, withNewSlide, keyframed, hasKeyframe, foldState } from "../core/document.js";
import { rectPlugin } from "../plugins/rect.js";
import { plaintextPlugin } from "../plugins/plaintext.js"; // declares a REAL numeric `size` row (the font size)
import { textPlugin } from "../plugins/text.js"; // declares a plain colour row keyed exactly `color`
import { cameraPlugin } from "../plugins/camera.js"; // newDocument() always contains THE camera

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const registry = createRegistry();
for (const p of [rectPlugin, plaintextPlugin, textPlugin, cameraPlugin]) registry.register(p);

/** Query. Runs fn with console.error captured; returns the reported strings. */
function capturedErrors(fn) {
  const original = console.error;
  const out = [];
  console.error = (...args) => out.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return out;
}

/** Pure function. A minimal two-item state: `b` (the source) and `a` (the reader). */
const pair = (b, a) => ({
  items: {
    b: { ...rectPlugin.defaults, type: "rect", name: "b", ...b },
    a: { ...rectPlugin.defaults, type: "rect", name: "a", ...a },
  },
});

// ── THE USER'S BUG: A VARIABLE'S KIND DECIDES WHAT ITS STRING MEANS ──────────

test("a font variable holding a font id is a LITERAL, and a Font row bound to it evaluates", () => {
  const state = {
    vars: { note_font: "jetbrains-mono" },
    items: { t: { ...plaintextPlugin.defaults, type: "plaintext", name: "t", font: "= note_font" } },
  };
  const kinds = { note_font: "font" };
  const errs = capturedErrors(() => {
    const { state: s, errors } = evaluateState(state, registry, "", null, kinds);
    assert.equal(errors.size, 0, `expected no errors, got ${[...errors].map(([k, v]) => `${k}: ${v}`).join("; ")}`);
    assert.equal(s.vars.note_font, "jetbrains-mono");
    assert.equal(s.items.t.font, "jetbrains-mono");
  });
  assert.deepEqual(errs, []);
});

test("WITHOUT a kind map the engine is the pre-kinds one, byte-identically", () => {
  // The whole safety argument for threading: an un-threaded caller must be
  // unchanged. A bare string in an undeclared variable is still an EQUATION.
  const state = { vars: { speed: "5 * 2" }, items: { r: { ...rectPlugin.defaults, type: "rect", name: "r", x: "speed" } } };
  const a = evaluateState(state, registry);
  const b = evaluateState({ ...state }, registry, "", null, {});
  assert.equal(a.state.vars.speed, 10);
  assert.equal(a.state.items.r.x, 10);
  assert.equal(b.state.vars.speed, 10, "an EMPTY kind map declares every variable number");
});

test("every kind's ZERO evaluates to itself, with no error", () => {
  // A variable is born already keyframed at its zero, so a zero the evaluator
  // rejects is a slot that reads as broken on its very first frame. Before the
  // kind was threaded, `text` reported "Unexpected end of expression" and `font`
  // reported `Unknown variable "system"`, and both were replaced by 0.
  const vars = Object.fromEntries(VAR_KINDS.map((k) => [k, VAR_KIND_ZEROS[k]]));
  const kinds = Object.fromEntries(VAR_KINDS.map((k) => [k, k]));
  const errs = capturedErrors(() => {
    const { state: s, errors } = evaluateState({ vars, items: {} }, registry, "", null, kinds);
    assert.equal(errors.size, 0, `zeros must not error: ${[...errors].map(([k, v]) => `${k}: ${v}`).join("; ")}`);
    for (const k of VAR_KINDS) assert.deepEqual(s.vars[k], VAR_KIND_ZEROS[k], `${k}'s zero survived`);
  });
  assert.deepEqual(errs, []);
});

test("the `=` escape hatch still works in EVERY kind, and the result is typed by the kind", () => {
  const kinds = { brand: "color", tint: "color", origin: "vec2", offset: "vec2", moved: "vec2", caption: "text", loud: "text" };
  const state = {
    vars: {
      brand: "#ff0000", tint: "= brand",
      origin: [1, 2], offset: [10, 20], moved: "= origin + offset",
      caption: "hello", loud: "= caption + \"!\"",
    },
    items: {},
  };
  const errs = capturedErrors(() => {
    const { state: s, errors } = evaluateState(state, registry, "", null, kinds);
    assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
    assert.equal(s.vars.tint, "#ff0000");
    assert.equal(s.vars.loud, "hello!");
    // A vec2 result is stored as the PLAIN tuple the kind's control edits — the
    // `__vec` runtime tag must never reach a document (VAR_KIND_ZEROS says so).
    assert.deepEqual(s.vars.moved, [11, 22]);
    assert.ok(Array.isArray(s.vars.moved) && !("__vec" in s.vars.moved), "no runtime tag in a stored vec2");
  });
  assert.deepEqual(errs, []);
});

test("a FAILED variable equation falls back to its KIND'S zero, not to 0", () => {
  const errs = capturedErrors(() => {
    const { state: s, errors } = evaluateState({ vars: { brand: "= nope" }, items: {} }, registry, "", null, { brand: "color" });
    assert.equal(s.vars.brand, VAR_KIND_ZEROS.color, "a colour variable falls back to a COLOUR");
    assert.match(errors.get("vars.brand"), /Unknown variable/);
  });
  assert.equal(errs.length, 1, "the failure is still LOUD");
});

test("the kind map is part of the MEMO KEY — retyping a variable is not served from cache", () => {
  const state = { vars: { f: "jetbrains-mono" }, items: {} };
  const asFont = evaluateState(state, registry, "", null, { f: "font" });
  const asNumber = capturedErrors(() => evaluateState(state, registry, "", null, null));
  assert.equal(asFont.state.vars.f, "jetbrains-mono");
  assert.ok(asNumber.length > 0, "the same state under a DIFFERENT kind map re-evaluates");
});

test("isVarEquation reads the DECLARATION, and defaults to the legacy fiat", () => {
  assert.equal(isVarEquation("speed * 2"), true, "an undeclared bare string is still an equation");
  assert.equal(isVarEquation("jetbrains-mono", "font"), false, "a font id is a literal");
  assert.equal(isVarEquation("Hello world", "text"), false, "prose is a literal");
  assert.equal(isVarEquation("red", "color"), false, "a CSS colour name is a literal");
  assert.equal(isVarEquation("= titleFont", "font"), true, "the `=` hatch survives in every kind");
  assert.equal(isVarEquation("speed * 2", "number"), true, "a number variable is byte-identical");
});

test("every VAR_KINDS member declares a result kind", () => {
  for (const k of VAR_KINDS)
    assert.ok(VAR_KIND_RESULT[k], `variable kind "${k}" has no equation result kind`);
});

test("repairedVarKinds names the kinds it actually knows", () => {
  // A stale example in this sentence is how a doctest went on describing a kind
  // list that no longer existed (vec2 was missing from it for a whole round).
  assert.equal(repairedVarKinds({ brand: "quaternion" }).dropped[0].reason,
    `not one of ${VAR_KINDS.join(", ")}`);
});

// ── A PROPS ROW WITH NO PLUGIN DEFAULT IS STILL A NUMERIC SLOT ──────────────

test("the LEGACY bare equation binds on `delay`, a PROPS row declared with no default", () => {
  // `delay` is declared in PROPS deliberately WITHOUT a default ("absent means 0,
  // and 0 must stay byte-identical"). The Inspector gives it the same ƒ field
  // every numeric row has, so typing the legacy bare form stored a string nothing
  // collected — no equation, no error, the picture just never bound. `= …` worked,
  // because resultKindForSlot reads PROPS first; that asymmetry was the defect.
  // Found through tests/item_vars_probe.js, which picks the FIRST numeric row.
  assert.equal(isNumericSlot(rectPlugin, ["delay"]), true);
  assert.equal(isEquationValue(rectPlugin, ["delay"], "self.vars.lambda"), true);
  const state = { items: { r: { ...rectPlugin.defaults, type: "rect", name: "r", vars: { lambda: 0.75 }, delay: "self.vars.lambda" } } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.r.delay, 0.75);
  // THE PLUGIN STILL WINS WHEN IT SAYS ANYTHING AT ALL — a default of another
  // type keeps its "no", which is what keeps name/text/fill out of the engine.
  assert.equal(isNumericSlot({ defaults: { name: "Text" } }, ["name"]), false);
  assert.equal(isNumericSlot(rectPlugin, ["fill"]), false);
});

// ── A WIDGET'S OWN PROPERTY BEATS A SYNTHESIZED VECTOR ADDRESS ───────────────

test("`= t.size` reads a widget's REAL numeric size row, not the w/h 2-vector", () => {
  // Seven plugins declare a numeric `size` (the font size). The vector address
  // hijacked all of them: `a.w` evaluated to "[object Object]" and fell back.
  const state = {
    items: {
      t: { ...plaintextPlugin.defaults, type: "plaintext", name: "t", size: 48 },
      a: { ...rectPlugin.defaults, type: "rect", name: "a", w: "= t.size", opacity: "= t.size / 100" },
    },
  };
  const errs = capturedErrors(() => {
    const { state: s, errors } = evaluateState(state, registry, "", null, null);
    assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
    assert.equal(s.items.a.w, 48);
    assert.equal(s.items.a.opacity, 0.48);
  });
  assert.deepEqual(errs, []);
});

test("`= b.size.w` still reads the 2-vector on a widget that has NO size property", () => {
  const { state: s, errors } = evaluateState(pair({ w: 30, h: 20 }, { x: "= b.size.w", y: "= b.size.h" }), registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.a.x, 30);
  assert.equal(s.items.a.y, 20);
});

// ── NOT EVERY PATH ENDING IN `color` IS A PAINT ADDRESS ─────────────────────

test("`= b.fill.linear.stops.1.color` reads the STOP's colour", () => {
  // The module header points gradient authors at exactly this address, and the
  // composite branch refused it: paintColorPath types every untagged object as a
  // paint, so the STOP RECORD was read as one.
  const grad = {
    type: "linearGradient", solid: "#123456",
    linear: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], angle: 0 },
  };
  const { state: s, errors } = evaluateState(pair({ fill: grad }, { fill: "= b.fill.linear.stops.1.color" }), registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.a.fill, "#ffffff");
});

test("`= b.fill.color` (a real paint address) still answers with the paint's colour", () => {
  const { state: s, errors } = evaluateState(pair({ fill: "#804020" }, { x: "= b.fill.color.r" }), registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.a.x, 0x80);
});

test("`= b.shadow.color[.r]` — a colour NESTED in a non-paint record", () => {
  // `shadow` is a plain record {dx, dy, blur, color, opacity}, so the prefix is
  // not a paint. Before the split, paintColorPath typed that record as a paint
  // and BOTH forms were refused with "is not a colour".
  const shadow = { dx: 0, dy: 4, blur: 10, color: "#0a4a7a", opacity: 0.3 };
  const { state: s, errors } = evaluateState(pair({ shadow }, { fill: "= b.shadow.color", x: "= b.shadow.color.r" }), registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.a.fill, "#0a4a7a");
  assert.equal(s.items.a.x, 0x0a);
});

test("a gradient STOP's colour is addressable by channel too", () => {
  const grad = {
    type: "linearGradient", solid: "#123456",
    linear: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ff8040" }], angle: 0 },
  };
  const { state: s, errors } = evaluateState(pair({ fill: grad }, { x: "= b.fill.linear.stops.1.color.g" }), registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.a.x, 0x80);
});

test("an OFF paint still refuses a channel read, in its own words", () => {
  const { errors } = evaluateState(pair({ fill: { type: "none" } }, { x: "= b.fill.color.g" }), registry);
  assert.match(errors.get("items.a.x"), /is Off — an off paint has no colour to address/);
});

test("isPaintValue tells a paint from a gradient STOP", () => {
  assert.equal(isPaintValue("#7aa2f7"), true);
  assert.equal(isPaintValue({ type: "linearGradient", linear: { stops: [] } }), true);
  assert.equal(isPaintValue({ offset: 1, color: "#ffffff" }), false, "a stop record is not a paint");
  assert.equal(isPaintValue(undefined), false);
});

// ── A PROPERTY WHOSE OWN KEY IS `color` ─────────────────────────────────────

test("`= t.color.r` reads a plugin row keyed exactly `color`", () => {
  const state = {
    items: {
      t: { ...textPlugin.defaults, type: "text", name: "t", color: "#123456" },
      a: { ...rectPlugin.defaults, type: "rect", name: "a", x: "= t.color.r" },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.a.x, 0x12);
});

test("`= t.color` (WHOLE) still reads the author's own spelling, not a re-spelled vector", () => {
  // The stored property wins the whole-vector read. That is the same rule that
  // gives `= t.size` back the font size, applied to the other collision.
  const state = {
    items: {
      t: { ...textPlugin.defaults, type: "text", name: "t", color: "#f80" },
      a: { ...rectPlugin.defaults, type: "rect", name: "a", fill: "= t.color" },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.a.fill, "#f80", "the three-digit spelling survives");
});

test("a channel keyframe on a row keyed `color` FOLDS, through the real document path", () => {
  // Measured before the fix: the fold's colour seam fired one level too high (on
  // the ITEM delta `{color: {r}}`, where the target is a WIDGET), refused, and
  // dropped the keyframe while the diamond went on showing it as set.
  let doc = newDocument();
  let id;
  [doc, id] = withNewItem(doc, 0, { ...textPlugin.defaults, type: "text", name: "t", color: "#123456" });
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 1, ["items", id, "color", "r"], 255);
  assert.equal(foldState(doc, 0).items[id].color, "#123456", "the base slide is untouched");
  assert.equal(foldState(doc, 1).items[id].color, "#ff3456", "the keyed slide folds to a real hex");
});

test("colorComponentDelta asks what the delta LANDS ON; the item map is the caller's job", () => {
  assert.deepEqual(colorComponentDelta("fill", { color: { r: 255 } }, "#123456"), { r: 255 });
  assert.deepEqual(colorComponentDelta("color", { r: 255 }, "#123456"), { r: 255 });
  assert.equal(colorComponentDelta("vars", { color: { r: 255 } }, { speed: 5 }), null, "a non-paint record is not one");
  assert.equal(colorComponentDelta("fill", { stops: [] }, "#123456"), null);
  assert.equal(isColorChannelSet({}), false, "a keyframe of no channels is not one");
  // A WIDGET carries a string `type` exactly as a paint record does, so the
  // VALUE cannot separate them and this function does not pretend to. The fold
  // excludes the item map by LEVEL instead — pinned end-to-end by the
  // "channel keyframe on a row keyed `color`" test above, which would fold to
  // the refusal `t has no colour slot` if that guard were removed.
  assert.deepEqual(colorComponentDelta("t", { color: { r: 255 } }, { type: "text", color: "#123456" }), { r: 255 });
});

// ── THE CHANNEL TWEEN, AND WHAT A CHANNEL MAY HOLD ──────────────────────────

test("a channel keyframe TWEENS over a tagged solid and a gradient, not only a bare hex", () => {
  // The lerp used to be handed the PAINT, so colorChannelValue answered null for
  // anything tagged and every channel snapped to its target at alpha 0.25 while
  // a bare hex tweened. The three shapes must agree exactly.
  const shapes = {
    bare: "#123456",
    tagged: { type: "solid", solid: "#123456" },
    gradient: { type: "linearGradient", solid: "#123456", linear: { stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }], angle: 0 } },
  };
  for (const [name, base] of Object.entries(shapes))
    for (const [alpha, want] of [[0.25, "#4d3456"], [0.5, "#893456"], [1, "#ff3456"]]) {
      const out = blendApplied({ fill: base }, { fill: { color: { r: 255 } } }, alpha);
      const got = typeof out.fill === "string" ? out.fill : out.fill.solid;
      assert.equal(got, want, `${name} at alpha ${alpha}`);
    }
});

test("an EQUATION typed into a channel row is REFUSED loudly, never baked into the hex", () => {
  // NumericField stores `= 100` at fill.color.r (channel rows are plain number
  // rows), and the fold turned that into "#NaN3456" with no error anywhere.
  const errs = capturedErrors(() => {
    const out = blendApplied({ fill: "#123456" }, { fill: { color: { r: "= 100" } } }, 1);
    assert.equal(out.fill, "#123456", "the author's colour is untouched");
  });
  assert.equal(errs.length, 1, "the refusal is reported");
  assert.match(errs[0], /cannot hold an equation/);
  assert.equal(withColorChannel("#123456", "r", "= 100"), null, "the channel writer itself refuses a non-number");
});

test("a REFUSING paint reports its sentence — the fold is never a silent no-op", () => {
  // vector_values' own docblock promises "the sentence is the caller's to
  // report", and the fold arm dropped `resolved.refusal` on the floor.
  const errs = capturedErrors(() => {
    const out = blendApplied({ fill: { type: "none" } }, { fill: { color: { r: 255 } } }, 1);
    assert.deepEqual(out.fill, { type: "none" }, "the paint comes back exactly as it went in");
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /is Off — an off paint has no colour to address/);
});

test("resolveColorComponentDelta's alpha defaults to the ENDPOINT, so old callers are unchanged", () => {
  assert.deepEqual(resolveColorComponentDelta("#123456", { r: 255 }, "fill"), { paint: "#ff3456" });
  assert.equal(resolveColorComponentDelta({ type: "solid", solid: "#123456" }, { r: 255 }, "fill", 0.5).paint.solid, "#893456");
});

// ── A CHANNEL KEYFRAME CAN CAPTURE ITS OWN VALUE ────────────────────────────

test("a colour CHANNEL has a value to keyframe, at every shape the address reaches", () => {
  // The Inspector's diamond captures "the value as it stands" before writing a
  // keyframe, and a channel is a VIEW over a colour with no stored leaf — so it
  // captured `undefined`, `hasKeyframe` stayed false (the diamond never lit) and
  // the write left `{fill: {color: {}}}` in the delta. Found via colorfield_probe.
  const grad = {
    type: "linearGradient", solid: "#123456",
    linear: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ff8040" }], angle: 0 },
  };
  assert.equal(colorChannelKeyframeValue({ fill: "#123456" }, ["fill", "color", "r"]), 0x12);
  assert.equal(colorChannelKeyframeValue({ fill: { type: "solid", solid: "#123456" } }, ["fill", "color", "g"]), 0x34);
  assert.equal(colorChannelKeyframeValue({ color: "#123456" }, ["color", "b"]), 0x56);
  assert.equal(colorChannelKeyframeValue({ shadow: { dx: 0, color: "#0a4a7a" } }, ["shadow", "color", "r"]), 0x0a);
  assert.equal(colorChannelKeyframeValue({ fill: grad }, ["fill", "linear", "stops", "1", "color", "g"]), 0x80);
  assert.equal(colorChannelKeyframeValue({ fill: { type: "none" } }, ["fill", "color", "r"]), undefined,
    "an OFF paint has no colour, so there is nothing to capture");
  assert.equal(colorChannelKeyframeValue({ x: 5 }, ["x"]), undefined, "an ordinary path is not a channel address");
});

test("keyframing a channel with a real value LIGHTS the diamond; undefined writes an empty wrapper", () => {
  // Both halves of the failure, through the real document functions: the value is
  // what makes hasKeyframe true, and the empty wrapper is what the fold cannot
  // read as a channel keyframe.
  let doc = newDocument();
  let id, idx;
  [doc, id] = withNewItem(doc, 0, { ...rectPlugin.defaults, type: "rect", name: "r", fill: "#7aa2f7" });
  [doc, idx] = withNewSlide(doc, 0);
  const path = ["items", id, "fill", "color", "r"];
  assert.equal(hasKeyframe(keyframed(doc, idx, path, undefined), idx, path), false);
  assert.equal(hasKeyframe(keyframed(doc, idx, path, 200), idx, path), true);
});

// ── COMPONENT PROJECTION AFTER ARITHMETIC ───────────────────────────────────

test("`.r` and `.w` project after arithmetic, not only `.x`", () => {
  // The commit that introduced vector algebra claimed "(b.pos + c.pos).x works
  // after arithmetic"; the parser refused every other component name, so the
  // source fell through to the token-splice path, emitted a native `*`, and died
  // with the exact "Cannot convert object to primitive value" it was meant to end.
  const state = pair(
    { w: 30, h: 20, fill: "#804020" },
    { x: "= (b.size * 2).w", y: "= (b.fill.color * 0.5).r", w: "= (b.pos + b.pos).x" },
  );
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0, [...errors].map(([k, v]) => `${k}: ${v}`).join("; "));
  assert.equal(s.items.a.x, 60);
  assert.equal(s.items.a.y, 0x40);
});

test("the projection is emitted through the HOST, so a wrong component is a sentence", () => {
  assert.equal(toJsExpr("(b.size * 2).w"), '__proj(__op("*", b.size, 2), "w")');
  const { errors } = evaluateState(pair({ w: 30, h: 20 }, { x: "= (b.size * 2).zz" }), registry);
  assert.match(errors.get("items.a.x"), /has no component "zz"/);
});

test("a 2-vec answers to BOTH readings, because an arithmetic result carries no kind", () => {
  assert.deepEqual(axesForArity(2), ["x", "y", "w", "h"]);
  const v = makeVector([30, 20]);
  assert.equal(v.x, 30);
  assert.equal(v.w, 30, "the same slot under the size reading");
  assert.equal(v.h, 20);
  // The names stay NON-ENUMERABLE, so they never reach JSON or a saved document.
  assert.equal(JSON.stringify(v), '{"__vec":[30,20]}');
});

test("a POINT's vocabulary is still x/y, and it says so", () => {
  // The parser's widening is for the compiled path; the restricted evaluator
  // only ever projects a function RESULT, which is a point.
  assert.equal(parseExpression("f(a).z").prop, "z");
  assert.throws(() => evalAst(parseExpression("f(a).z"), () => 0, () => ({ x: 1, y: 2 })), /has no component "z"/);
  assert.equal(evalAst(parseExpression("f(a).y"), () => 0, () => ({ x: 1, y: 2 })), 2);
});

console.log(`\nevaluator_fix_test: ${passed} passed`);
