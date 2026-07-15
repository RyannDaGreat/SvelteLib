/**
 * Expressions-engine tests (THE UNIFICATION) — plain node, no framework.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/expressions_test.js
 * core/expressions.js being DOM-free is itself under test here.
 * The assertions mirror the modules' @example doctests plus the behavioral
 * spec: parse/eval, slugs, display↔stored conversion, dependency topo-sort,
 * loud cycles, closest fixpoint, binding migration, variable rename.
 */

import assert from "node:assert/strict";
import {
  tokenize, parseExpression, compiled, evalAst,
  slugify, slugMap, anchorRefName, parseStoredRef, resolveRef, mapRefTokens,
  displayToStored, storedToDisplay, isNumericSlot,
  evaluateState, withBindingsMigrated, withVariableRenamed,
} from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { newDocument, withNewItem, withNewSlide, keyframed, foldState } from "../core/document.js";
import { rectPlugin } from "../plugins/rect.js";
import { circlePlugin } from "../plugins/circle.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { textPlugin } from "../plugins/text.js";
import { cameraPlugin } from "../plugins/camera.js"; // newDocument() always contains THE camera

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}
/** Runs fn with console.error captured; returns the error strings. */
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

const registry = createRegistry();
registry.register(rectPlugin);
registry.register(circlePlugin);
registry.register(arrowPlugin);
registry.register(textPlugin);
registry.register(cameraPlugin);

// ── tokenizer + parser ───────────────────────────────────────────────────────
test("tokenize: kinds, positions, @refs, errors", () => {
  assert.deepEqual(tokenize("speed * 2").map((t) => t.kind), ["ref", "op", "num"]);
  assert.equal(tokenize("@ab12_tm.x + 10")[0].value, "@ab12_tm.x");
  assert.deepEqual(tokenize("a.b.c")[0].value, "a.b.c");
  const t = tokenize(" x +1");
  assert.deepEqual([t[0].start, t[0].end], [1, 2]); // positions track source
  assert.throws(() => tokenize("3 $ 4"), /Unexpected character "\$"/);
});
test("parseExpression: precedence, parens, unary minus, leading =", () => {
  const ast = parseExpression("2 + 3 * x");
  assert.equal(ast.op, "+");
  assert.equal(ast.right.op, "*");
  assert.deepEqual(parseExpression("-(a.x)"), { kind: "neg", arg: { kind: "ref", name: "a.x" } });
  assert.deepEqual(parseExpression("= 1 + 1"), parseExpression("1 + 1")); // spreadsheet affordance
  assert.throws(() => parseExpression("1 +"), /Unexpected end/);
  assert.throws(() => parseExpression("(1"), /Missing "\)"/);
  assert.throws(() => parseExpression("1 2"), /Unexpected "2"/);
  assert.throws(() => parseExpression(""), /Unexpected end/);
});
test("compiled: refs deduped; evalAst arithmetic", () => {
  assert.deepEqual(compiled("speed * 2 + speed").refs, ["speed"]);
  assert.equal(evalAst(parseExpression("2 + x * 3"), () => 4), 14);
  assert.equal(evalAst(parseExpression("-(1 + 1)"), () => 0), -2);
  assert.equal(evalAst(parseExpression("10 / 4"), () => 0), 2.5);
  assert.equal(evalAst(parseExpression("10 - 2 - 3"), () => 0), 5); // left assoc
});

// ── slugs ────────────────────────────────────────────────────────────────────
test("slugify", () => {
  assert.equal(slugify("Circle Top"), "circle_top");
  assert.equal(slugify("2nd Box!"), "_2nd_box");
  assert.equal(slugify("---"), "item");
  assert.equal(slugify("A  B"), "a_b");
});
test("slugMap: names, unnamed fallback, dedupe in creation order", () => {
  const state = {
    items: {
      ab12cd34: { type: "rect", name: "Box" },
      cd34ef56: { type: "rect", name: "Box" },
      ef56ab12: { type: "circle" },
    },
  };
  const m = slugMap(state);
  assert.equal(m.toId.get("box"), "ab12cd34");
  assert.equal(m.toId.get("box_2"), "cd34ef56");
  assert.equal(m.toSlug.get("ef56ab12"), "circle_ef56");
  assert.equal(anchorRefName(state, "ab12cd34", "tm"), "box_tm");
});

// ── reference resolution ─────────────────────────────────────────────────────
test("parseStoredRef: prop, anchor, errors", () => {
  assert.deepEqual(parseStoredRef("@ab12cd34.x"), { kind: "prop", itemId: "ab12cd34", path: ["x"] });
  assert.deepEqual(parseStoredRef("@ab12cd34.from.x"), { kind: "prop", itemId: "ab12cd34", path: ["from", "x"] });
  assert.deepEqual(parseStoredRef("@ab12cd34_tm.y"), { kind: "anchor", itemId: "ab12cd34", anchorId: "tm", coord: "y" });
  assert.throws(() => parseStoredRef("@ab12cd34"), /needs a property/);
  assert.throws(() => parseStoredRef("@ab12cd34_tm.w"), /must end in \.x or \.y/);
});
test("resolveRef: var / item-slug-first / last-underscore anchor rule", () => {
  const slugs = slugMap({
    items: {
      a1: { type: "rect", name: "Circle Top" }, // slug "circle_top" — contains _
      b2: { type: "circle", name: "Circle" },
    },
  });
  assert.deepEqual(resolveRef("speed", slugs), { kind: "var", name: "speed" });
  // "circle_top.x" is an ITEM named Circle Top, not anchor "top" of "circle":
  assert.deepEqual(resolveRef("circle_top.x", slugs), { kind: "prop", itemId: "a1", path: ["x"] });
  assert.deepEqual(resolveRef("circle_tm.x", slugs), { kind: "anchor", itemId: "b2", anchorId: "tm", coord: "x" });
  assert.deepEqual(resolveRef("circle_top_tm.y", slugs), { kind: "anchor", itemId: "a1", anchorId: "tm", coord: "y" });
  assert.throws(() => resolveRef("ghost.x", slugs), /Unknown reference/);
});
test("display ↔ stored conversion (spacing preserved, roundtrip)", () => {
  const state = { vars: { speed: 5 }, items: { a1: { type: "rect", name: "Box" }, b2: { type: "circle", name: "Moon" } } };
  assert.equal(displayToStored("box.x + 10", state), "@a1.x + 10");
  assert.equal(displayToStored("= moon_tm.x * 2", state), "@b2_tm.x * 2");
  assert.equal(displayToStored("speed * 2", state), "speed * 2");
  assert.throws(() => displayToStored("sped * 2", state), /Unknown variable "sped"/); // typo protection at entry
  assert.equal(storedToDisplay("@a1.x + 10", state), "box.x + 10");
  assert.equal(storedToDisplay("@b2_tm.x*2", state), "moon_tm.x*2");
  assert.equal(storedToDisplay("@dead0000.x", state), "@dead0000.x"); // purged item stays visible
  assert.equal(storedToDisplay("not an ) equation", state), "not an ) equation"); // malformed: verbatim
  assert.throws(() => displayToStored("ghost.x", state), /Unknown reference/);
  assert.throws(() => displayToStored("1 +", state), /Unexpected end/);
  assert.equal(mapRefTokens("a + b", (t) => t.toUpperCase()), "A + B");
});

// ── numeric slots ────────────────────────────────────────────────────────────
test("isNumericSlot: defaults-derived, nested, strings excluded", () => {
  assert.ok(isNumericSlot(rectPlugin, ["x"]));
  assert.ok(!isNumericSlot(rectPlugin, ["fill"])); // color string default
  assert.ok(!isNumericSlot(textPlugin, ["text"]));
  assert.ok(isNumericSlot(arrowPlugin, ["from", "x"]));
  assert.ok(!isNumericSlot(rectPlugin, ["nope"]));
});

// ── evaluation ───────────────────────────────────────────────────────────────
test("evaluateState: vars, chained deps, item prop refs", () => {
  const state = {
    vars: { speed: 5, double: "speed * 2" },
    items: {
      a1: { ...rectPlugin.defaults, name: "Box", x: "double + 1" },
      b2: { ...rectPlugin.defaults, x: "@a1.x * 10" },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.equal(s.vars.double, 10);
  assert.equal(s.items.a1.x, 11);
  assert.equal(s.items.b2.x, 110);
  // Purity: the input state is untouched.
  assert.equal(state.items.a1.x, "double + 1");
  // Memoization: same state object → same result object.
  assert.equal(evaluateState(state, registry), evaluateState(state, registry));
});
test("evaluateState: display-form refs in stored docs resolve via slugs", () => {
  const state = { items: { a1: { ...rectPlugin.defaults, name: "Box", x: 40 }, b2: { ...rectPlugin.defaults, x: "box.x + 2" } } };
  assert.equal(evaluateState(state, registry).state.items.b2.x, 42);
});
test("evaluateState: anchors are variables (world coords, transform-aware)", () => {
  const state = {
    items: {
      c1: { ...circlePlugin.defaults, name: "Moon", x: 100, y: 100, w: 20, h: 20 },
      a1: { ...rectPlugin.defaults, x: "@c1_cm.x", y: "moon_tm.y" },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.equal(s.items.a1.x, 110); // center of the circle
  assert.equal(s.items.a1.y, 100); // top edge midpoint
});
test("evaluateState: anchor deps on equation-valued item props (topo order)", () => {
  const state = {
    vars: { off: 30 },
    items: {
      c1: { ...circlePlugin.defaults, name: "Moon", x: "off * 2", y: 0, w: 20, h: 20 },
      a1: { ...rectPlugin.defaults, x: "moon_cm.x" },
    },
  };
  assert.equal(evaluateState(state, registry).state.items.a1.x, 70); // 60 + 10
});
test("evaluateState: closest anchor via arrow endpoints (fixpoint)", () => {
  // Mirrors the old resolveBinding test: circle at (100,100) 20×20; the
  // arrow's other endpoint sits directly above the center → closest = top.
  const state = {
    items: {
      c1: { ...circlePlugin.defaults, x: 100, y: 100, w: 20, h: 20 },
      ar: { ...arrowPlugin.defaults, from: { x: 110, y: 0 }, to: { x: "@c1_closest.x", y: "@c1_closest.y" } },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  approx(s.items.ar.to.x, 110);
  approx(s.items.ar.to.y, 100); // top of the circle, toward the point above
});
test("evaluateState: mutual closest (both endpoints computed) converges", () => {
  const state = {
    items: {
      c1: { ...circlePlugin.defaults, x: 0, y: 0, w: 20, h: 20 },
      c2: { ...circlePlugin.defaults, x: 200, y: 0, w: 20, h: 20 },
      ar: {
        ...arrowPlugin.defaults,
        from: { x: "@c1_closest.x", y: "@c1_closest.y" },
        to: { x: "@c2_closest.x", y: "@c2_closest.y" },
      },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  // The two-pass fixpoint (V1 resolveEndpoints semantics) converges
  // geometrically, not exactly — tolerance reflects one remaining iteration.
  const EPS = 0.01;
  approx(s.items.ar.from.x, 20, EPS); // right edge of c1, facing c2
  approx(s.items.ar.to.x, 200, EPS); // left edge of c2, facing c1
  approx(s.items.ar.from.y, 10, EPS);
  approx(s.items.ar.to.y, 10, EPS);
});
test("evaluateState: cycles are LOUD (errors + console + fallback, no NaN)", () => {
  const state = {
    vars: { a: "b + 1", b: "a + 1" },
    items: { r1: { ...rectPlugin.defaults, x: "a + 1" } },
  };
  let result;
  const logged = capturedErrors(() => {
    result = evaluateState(state, registry);
  });
  assert.match(result.errors.get("vars.a"), /Cyclic expressions/);
  assert.match(result.errors.get("vars.b"), /Cyclic expressions/);
  assert.equal(result.state.vars.a, 0); // fallback, not NaN
  assert.equal(result.state.vars.b, 0);
  assert.equal(result.state.items.r1.x, 1); // consumer of fallback still evaluates
  assert.ok(!Number.isNaN(result.state.items.r1.x));
  assert.ok(logged.some((m) => m.includes("Cyclic expressions")), "cycle explained on console");
});
test("evaluateState: self-cycle via own anchor", () => {
  const state = { items: { c1: { ...circlePlugin.defaults, name: "Moon", x: "moon_cm.y", y: "moon_cm.x" } } };
  const result = capturedErrorsResult(state);
  assert.match(result.errors.get("items.c1.x"), /Cyclic/);
  assert.equal(typeof result.state.items.c1.x, "number");
});
function capturedErrorsResult(state) {
  let r;
  capturedErrors(() => {
    r = evaluateState(state, registry);
  });
  return r;
}
test("evaluateState: unknown refs / bad syntax / non-finite are reported with fallbacks", () => {
  const state = {
    vars: { bad: "nope + 1", div: "1 / 0" },
    items: {
      r1: { ...rectPlugin.defaults, x: "@dead0000.x", y: "1 +", w: "@r1nope_zz.x" },
      t1: { ...textPlugin.defaults, text: "not an equation (string default: untouched)" },
    },
  };
  const { state: s, errors } = capturedErrorsResult(state) ?? {};
  assert.match(errors.get("vars.bad"), /Unknown variable/);
  assert.match(errors.get("vars.div"), /evaluates to Infinity/);
  assert.match(errors.get("items.r1.x"), /Unknown item/);
  assert.match(errors.get("items.r1.y"), /Unexpected end/);
  assert.equal(s.items.r1.x, rectPlugin.defaults.x); // plugin-default fallback
  assert.equal(s.vars.bad, 0); // vars fall back to 0
  assert.equal(s.items.t1.text, "not an equation (string default: untouched)");
});
test("evaluateState: referencing a non-numeric property is an error", () => {
  const state = { items: { r1: { ...rectPlugin.defaults, name: "Box" }, r2: { ...rectPlugin.defaults, x: "box.fill" } } };
  const { errors } = capturedErrorsResult(state);
  assert.match(errors.get("items.r2.x"), /not a numeric property/);
});

// ── arrow plugin hooks ───────────────────────────────────────────────────────
test("arrow moveBy: free coords translate, equations stay anchored", () => {
  const raw = { from: { x: 0, y: 0 }, to: { x: 10, y: "@c1_tm.y" } };
  assert.deepEqual(arrowPlugin.moveBy(raw, 5, 2), [
    [["from", "x"], 5], [["from", "y"], 2], [["to", "x"], 15],
  ]);
  assert.deepEqual(arrowPlugin.closestToward({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }, ["from", "x"]), { x: 3, y: 4 });
  assert.equal(arrowPlugin.closestToward({}, ["width"]), null);
});

// ── migration ────────────────────────────────────────────────────────────────
test("withBindingsMigrated: {item, anchor} → equation pairs; free stays; idempotent", () => {
  let doc = newDocument();
  let circle, arrow;
  [doc, circle] = withNewItem(doc, 0, { ...circlePlugin.defaults });
  [doc, arrow] = withNewItem(doc, 0, {
    ...arrowPlugin.defaults,
    from: { x: 1, y: 2 },
    to: { item: circle, anchor: "closest" },
  });
  const migrated = withBindingsMigrated(doc);
  const to = migrated.slides[0].delta.items[arrow].to;
  assert.deepEqual(to, { x: `@${circle}_closest.x`, y: `@${circle}_closest.y` });
  assert.deepEqual(migrated.slides[0].delta.items[arrow].from, { x: 1, y: 2 }); // free untouched
  assert.equal(withBindingsMigrated(migrated), migrated); // no bindings → same object
  // The migrated document folds + evaluates to a working arrow:
  const folded = foldState(migrated, 0);
  const { state: s, errors } = evaluateState(folded, registry);
  assert.equal(errors.size, 0);
  assert.equal(typeof s.items[arrow].to.x, "number");
});
test("withBindingsMigrated: stale x/y mixed into a binding subtree is cleaned (old detach bug)", () => {
  let doc = newDocument();
  let circle, arrow;
  [doc, circle] = withNewItem(doc, 0, { ...circlePlugin.defaults });
  [doc, arrow] = withNewItem(doc, 0, { ...arrowPlugin.defaults });
  // Simulate the legacy merge bug: binding keys AND stale x/y in one subtree.
  doc = keyframed(doc, 0, ["items", arrow, "from"], { item: circle, anchor: "tm", x: 99, y: 99 });
  const from = withBindingsMigrated(doc).slides[0].delta.items[arrow].from;
  assert.deepEqual(from, { x: `@${circle}_tm.x`, y: `@${circle}_tm.y` }); // binding wins; stale dropped
});

// ── variable rename ──────────────────────────────────────────────────────────
test("withVariableRenamed: keyframes move, equations rewrite, text untouched", () => {
  let doc = newDocument();
  let rect, text;
  [doc, rect] = withNewItem(doc, 0, { ...rectPlugin.defaults, x: "speed * 2" });
  [doc, text] = withNewItem(doc, 0, { ...textPlugin.defaults, text: "speed" }); // literal text, NOT an equation
  doc = keyframed(doc, 0, ["vars", "speed"], 5);
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 1, ["vars", "speed"], 9);
  doc = keyframed(doc, 1, ["vars", "derived"], "speed + 1");
  const renamed = withVariableRenamed(doc, "speed", "velocity", registry);
  assert.equal(renamed.slides[0].delta.vars.velocity, 5);
  assert.equal(renamed.slides[1].delta.vars.velocity, 9);
  assert.equal(renamed.slides[0].delta.vars.speed, undefined);
  assert.equal(renamed.slides[0].delta.items[rect].x, "velocity * 2");
  assert.equal(renamed.slides[1].delta.vars.derived, "velocity + 1");
  assert.equal(renamed.slides[0].delta.items[text].text, "speed"); // string default: untouched
  assert.throws(() => withVariableRenamed(doc, "speed", "2bad", registry), /not a valid variable name/);
  doc = keyframed(doc, 0, ["vars", "velocity"], 1);
  assert.throws(() => withVariableRenamed(doc, "speed", "velocity", registry), /already exists/);
});

// ── end-to-end: fold → evaluate keeps the invariant, tweens drive equations ──
test("tween a VARIABLE, equations follow (fold then evaluate)", () => {
  let doc = newDocument();
  let rect;
  [doc, rect] = withNewItem(doc, 0, { ...rectPlugin.defaults, x: "speed * 2" });
  doc = keyframed(doc, 0, ["vars", "speed"], 0);
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 1, ["vars", "speed"], 100);
  const mid = evaluateState(foldState(doc, 1, 0.5), registry).state;
  assert.equal(mid.vars.speed, 50); // the var lerps...
  assert.equal(mid.items[rect].x, 100); // ...and the equation follows
});

console.log(`\n${passed} expressions tests passed`);
