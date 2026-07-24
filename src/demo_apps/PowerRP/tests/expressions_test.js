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
  tokenize, classifyEquation, equationTokenSpans, parseExpression, compiled, evalAst,
  slugify, slugMap, anchorRefName, canonicalPropPath, parseStoredRef, parseSelfRef, resolveRef, mapRefTokens,
  snakeToCamel, camelToSnake,
  displayToStored, storedToDisplay, isNumericSlot,
  evaluateState, withBindingsMigrated, withVariableRenamed,
  FUNCTIONS, equationFunctionNames, resolveOverload, widgetArgToken, widgetArgSpans, resolveWidgetArg,
} from "../core/expressions.js";
import { nearestPairCircleCircle, closestPointOnCircle, nearestRimPair } from "../core/outline.js";
import { createRegistry } from "../core/registry.js";
import { newDocument, withNewItem, withNewSlide, keyframed, foldState, withSlideMoved } from "../core/document.js";
import { deriveRenderTree, worldTransform, nodeAnchors } from "../core/derive.js";
import { leaves } from "../core/deltas.js";
import * as T from "../core/transform.js";
import { rectPlugin } from "../plugins/rect.js";
import { circlePlugin } from "../plugins/circle.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { fancyArrowPlugin } from "../plugins/fancy_arrow.js";
import { textPlugin } from "../plugins/text.js";
import { cameraPlugin } from "../plugins/camera.js"; // newDocument() always contains THE camera
import { anchorPointPlugin } from "../plugins/anchor_point.js";

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
registry.register(fancyArrowPlugin);
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
  const neg = parseExpression("-(a.x)");
  assert.equal(neg.kind, "neg");
  assert.equal(neg.arg.kind, "ref");
  assert.equal(neg.arg.name, "a.x"); // ref nodes now also carry source spans (start/end) — checked structurally
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

// ── equation special forms + highlight spans (Opus25, round-3 field) ──────────
test("classifyEquation: constant / reference / general (structure only)", () => {
  assert.equal(classifyEquation("42"), "constant");
  assert.equal(classifyEquation("-3.5"), "constant"); // unary minus on a lone number
  assert.equal(classifyEquation("= 42"), "constant"); // leading "=" tolerated
  assert.equal(classifyEquation("speed"), "reference"); // bare variable
  assert.equal(classifyEquation("box.x"), "reference"); // item-property path
  assert.equal(classifyEquation("self.w"), "reference"); // self path
  assert.equal(classifyEquation("box_tm.x"), "reference"); // anchor path
  assert.equal(classifyEquation("self.w / 2"), "general"); // modified reference
  assert.equal(classifyEquation("a + b"), "general");
  assert.equal(classifyEquation("2 * 3"), "general"); // arithmetic, not a bare literal
  assert.equal(classifyEquation("3 $ 4"), "general"); // unparseable → edited as general
});
test("equationTokenSpans: kinds, resolved refs, unknown → error, malformed", () => {
  const state = { items: { a1: { type: "rect", name: "Box" } }, vars: { speed: 5 } };
  // Each ref classified by resolveRef's real kind; num/op/paren by token kind.
  assert.deepEqual(equationTokenSpans("box.x + speed * self.w", state, "a1"), [
    { start: 0, end: 5, cls: "prop" },
    { start: 6, end: 7, cls: "op" },
    { start: 8, end: 13, cls: "var" },
    { start: 14, end: 15, cls: "op" },
    { start: 16, end: 22, cls: "self" },
  ]);
  assert.deepEqual(equationTokenSpans("box_tm.x", state), [{ start: 0, end: 8, cls: "anchor" }]);
  assert.deepEqual(equationTokenSpans("(1)", state), [
    { start: 0, end: 1, cls: "paren" },
    { start: 1, end: 2, cls: "num" },
    { start: 2, end: 3, cls: "paren" },
  ]);
  // Unknown variable resolves as {kind:"var"} structurally but doesn't exist →
  // flagged "error" so the overlay matches the field's invalid affordance.
  assert.deepEqual(equationTokenSpans("ghost", state), [{ start: 0, end: 5, cls: "error" }]);
  assert.deepEqual(equationTokenSpans("nope.x", state), [{ start: 0, end: 6, cls: "error" }]); // unknown slug
  assert.deepEqual(equationTokenSpans("self.w", state, null), [{ start: 0, end: 6, cls: "error" }]); // self w/o owner
  assert.deepEqual(equationTokenSpans("3 $ 4", state), [{ start: 0, end: 5, cls: "error" }]); // whole-source error
  assert.deepEqual(equationTokenSpans("", state), []); // empty → no spans
  // A ref immediately followed by "(" is a FUNCTION name — classified as "call"
  // POSITIONALLY (exactly as the parser decides), never as an unknown variable.
  assert.deepEqual(equationTokenSpans("f(2)", state).map((s) => s.cls), ["call", "paren", "num", "paren"]);
  // Grammar coexistence with Opus24's call/projection tokens (comma/dot → punct).
  // A .x/.y after a call/paren is a MEMBER projection (grammar, not a variable).
  assert.deepEqual(equationTokenSpans("g(speed, 2).x", state, "a1").map((s) => s.cls),
    ["call", "paren", "var", "punct", "num", "paren", "punct", "member"]);
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
test("self reference: props, anchors, center alias, base-frame flag, errors", () => {
  // parseSelfRef: self.<prop> → owner prop; self.anchors.<id>.x|y → owner anchor.
  assert.deepEqual(parseSelfRef("self.w", "a1"), { kind: "prop", itemId: "a1", path: ["w"] });
  assert.deepEqual(parseSelfRef("self.from.x", "a1"), { kind: "prop", itemId: "a1", path: ["from", "x"] });
  // "center" aliases the "cm" anchor; selfBase marks base-frame (rotation-zeroed) eval.
  assert.deepEqual(parseSelfRef("self.anchors.center.x", "a1"),
    { kind: "anchor", itemId: "a1", anchorId: "cm", coord: "x", selfBase: true });
  assert.deepEqual(parseSelfRef("self.anchors.tm.y", "a1"),
    { kind: "anchor", itemId: "a1", anchorId: "tm", coord: "y", selfBase: true });
  assert.throws(() => parseSelfRef("self.anchors.center", "a1"), /self\.anchors\.<id>\.x\|y/); // missing coord
  assert.throws(() => parseSelfRef("self", "a1"), /needs a property/);
  assert.throws(() => parseSelfRef("self.w", null), /only valid in an item's own equation/);
  // resolveRef threads selfId; self is stored VERBATIM (identity-stable, no @id).
  const slugs = slugMap({ items: {} });
  assert.deepEqual(resolveRef("self.w", slugs, "a1"), { kind: "prop", itemId: "a1", path: ["w"] });
  assert.equal(displayToStored("self.w / 2", { items: {} }), "self.w / 2");
  assert.equal(storedToDisplay("self.anchors.center.x + 5", { items: {} }), "self.anchors.center.x + 5");
});
test("isNumericSlot: self-prefixed computed-default strings are equation slots", () => {
  assert.ok(isNumericSlot({ defaults: { rotationAnchor: { x: "self.anchors.center.x" } } }, ["rotationAnchor", "x"]));
  assert.ok(!isNumericSlot({ defaults: { name: "Text" } }, ["name"])); // plain label, not self.
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

// ── canonical snake_case property grammar (EQUATION DISCOVERABILITY) ─────────
test("snakeToCamel / camelToSnake: per-segment bijection", () => {
  assert.equal(snakeToCamel("end_width"), "endWidth");
  assert.equal(snakeToCamel("x"), "x"); // single-word: identity
  assert.equal(snakeToCamel("rotation_anchor"), "rotationAnchor");
  assert.equal(camelToSnake("endWidth"), "end_width");
  assert.equal(camelToSnake("x"), "x");
  assert.equal(camelToSnake("rotationAnchor"), "rotation_anchor");
  // Bijection over every plugin's ACTUAL stored keys (the real coverage that
  // matters: not just the two example words, but every property this app has).
  for (const plugin of [rectPlugin, circlePlugin, arrowPlugin, fancyArrowPlugin, textPlugin]) {
    for (const [path] of leaves(plugin.defaults)) {
      for (const seg of path) assert.equal(snakeToCamel(camelToSnake(seg)), seg, `${plugin.type}.${path.join(".")}`);
    }
  }
});
test("canonical grammar: snake_case entry resolves against a camelCase-keyed property (the user's fancy-arrow case)", () => {
  // The user's EXACT complaint case: self.end_width / self.start_width must
  // resolve against the plugin's stored `endWidth`/`startWidth` keys.
  const state = { items: { fa1: { ...fancyArrowPlugin.defaults, name: "Fancy Arrow", endWidth: "self.startWidth + 2" } } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.equal(s.items.fa1.endWidth, fancyArrowPlugin.defaults.startWidth + 2);
  // The SAME equation authored end-to-end through the display boundary:
  const stored = displayToStored("self.start_width + 2", state);
  assert.equal(stored, "self.startWidth + 2");
  assert.equal(storedToDisplay(stored, state), "self.start_width + 2"); // round-trip
  // Absolute (non-self) form via the item's slug.
  assert.equal(displayToStored("fancy_arrow.start_width", state), "@fa1.startWidth");
  assert.equal(storedToDisplay("@fa1.startWidth + @fa1.tipLength", state), "fancy_arrow.start_width + fancy_arrow.tip_length");
});
test("canonical grammar: camelCase typed in the field is NOT silently accepted — errors as unknown (one visible form)", () => {
  const state = { items: { fa1: { ...fancyArrowPlugin.defaults, name: "Fancy Arrow" } } };
  // The tolerant-aliasing fallback the user explicitly vetoed: camelCase must
  // NOT resolve, even though "endWidth" is the item's REAL stored key.
  assert.throws(() => displayToStored("self.endWidth", state), /Unknown property "endWidth".*not canonical snake_case/);
  assert.throws(() => displayToStored("fancy_arrow.startWidth", state), /Unknown property "startWidth".*not canonical snake_case/);
  assert.throws(() => displayToStored("self.rotationAnchor.x", state), /Unknown property "rotationAnchor".*not canonical snake_case/);
  // A GENUINELY unknown snake_case name still reaches evaluation's own error
  // (displayToStored only guards CASE; existence is eval's job — same
  // division of labor as anchor refs). Loud either way, never silent.
  const bad = { items: { fa1: { ...fancyArrowPlugin.defaults, name: "Fancy Arrow", x2: "self.not_a_real_prop" } } };
  assert.equal(displayToStored("self.not_a_real_prop", bad), "self.notARealProp"); // passes the CASE guard...
  const { errors } = evaluateState({ items: { fa1: { ...fancyArrowPlugin.defaults, endWidth: "self.notARealProp" } } }, registry);
  assert.match(errors.get("items.fa1.endWidth"), /has no property/); // ...but eval catches the typo
});
test("canonical grammar: nested paths convert per-segment (rotation_anchor.x ↔ rotationAnchor.x)", () => {
  const state = { items: { r1: { ...rectPlugin.defaults, name: "Box" } } };
  assert.equal(displayToStored("self.rotation_anchor.x", state), "self.rotationAnchor.x");
  assert.equal(displayToStored("box.rotation_anchor.y", state), "@r1.rotationAnchor.y");
  assert.equal(storedToDisplay("self.rotationAnchor.x + self.rotationAnchor.y", state),
    "self.rotation_anchor.x + self.rotation_anchor.y");
  assert.equal(storedToDisplay("@r1.rotationAnchor.x", state), "box.rotation_anchor.x");
  // Evaluates correctly end-to-end (the default rotation pivot IS this equation).
  const { state: s, errors } = evaluateState({ items: { r1: { ...rectPlugin.defaults, x: 0, y: 0, w: 100, h: 60 } } }, registry);
  assert.equal(errors.size, 0);
  assert.deepEqual(s.items.r1.rotationAnchor, { x: 50, y: 30 });
});
test("canonicalPropPath: self + absolute forms, snake_case, unnamed-item slug", () => {
  assert.deepEqual(
    canonicalPropPath({ items: { fa1: { type: "fancy_arrow" } } }, "fa1", "endWidth"),
    { self: "self.end_width", absolute: "fancy_arrow_fa1.end_width" },
  );
  assert.deepEqual(
    canonicalPropPath({ items: { r1: { type: "rect", name: "Box" } } }, "r1", "rotationAnchor.x"),
    { self: "self.rotation_anchor.x", absolute: "box.rotation_anchor.x" },
  );
  assert.deepEqual(
    canonicalPropPath({ items: { r1: { type: "rect", name: "Box" } } }, "r1", "x"),
    { self: "self.x", absolute: "box.x" },
  );
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
test("evaluateState: self resolves to the OWNING item (props + own anchor)", () => {
  const state = {
    items: {
      // self.w/2 → half the box's own width; cornerRadius is a numeric slot.
      r1: { ...rectPlugin.defaults, x: 10, y: 20, w: 300, h: 100, cornerRadius: "self.w / 2" },
      // Two different rects reusing the SAME "self.w" text resolve to their OWN w.
      r2: { ...rectPlugin.defaults, x: 0, y: 0, w: 40, h: 40, cornerRadius: "self.w" },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.equal(s.items.r1.cornerRadius, 150); // 300/2 — self is r1
  assert.equal(s.items.r2.cornerRadius, 40); // same text, self is r2
});
test("evaluateState: self.anchors.center pivot uses the BASE (rotation-zeroed) frame", () => {
  // The default rotationAnchor equation. Even when the box is rotated, the self
  // center must be the GEOMETRIC center (x+w/2, y+h/2), not a center that spins.
  const state = { items: { r1: { ...rectPlugin.defaults, x: 100, y: 100, w: 240, h: 140, rotation: Math.PI / 2 } } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.deepEqual(s.items.r1.rotationAnchor, { x: 220, y: 170 }); // base-frame center, not rotated
});
test("evaluateState: self in a VARIABLE is an error (no owner item)", () => {
  const state = { vars: { bad: "self.w" }, items: {} };
  const { errors } = capturedErrorsResult(state);
  assert.match(errors.get("vars.bad"), /only valid in an item's own equation/);
});
test("evaluateState: self-referential cycle via own property is LOUD", () => {
  // cornerRadius = self.cornerRadius + 1 → a slot depending on itself.
  const state = { items: { r1: { ...rectPlugin.defaults, cornerRadius: "self.cornerRadius + 1" } } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.match(errors.get("items.r1.cornerRadius"), /Cyclic/);
  assert.equal(typeof s.items.r1.cornerRadius, "number"); // fallback, not NaN
});
test("evaluateState: rotationAnchor.x and .y don't falsely cycle on each other", () => {
  // Both default to self.anchors.center.{x,y}; the base-frame dep rule must NOT
  // make them depend on each other (that would be a spurious cycle).
  const state = { items: { r1: { ...rectPlugin.defaults, x: 0, y: 0, w: 100, h: 60, rotation: 1 } } };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.deepEqual(s.items.r1.rotationAnchor, { x: 50, y: 30 });
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
  // Convergence-gated sweeps (residual estimate < CLOSEST_EPS_PX) — the
  // fixed-two-sweep version met this only by luck of the easy geometry.
  const EPS = 0.01;
  approx(s.items.ar.from.x, 20, EPS); // right edge of c1, facing c2
  approx(s.items.ar.to.x, 200, EPS); // left edge of c2, facing c1
  approx(s.items.ar.from.y, 10, EPS);
  approx(s.items.ar.to.y, 10, EPS);
});
test("evaluateState: NEARLY-TANGENT mutual closest converges (weak contraction)", () => {
  // Two 100px circles 1px apart. The closest-point mapping loses contraction
  // near tangency (~82 sweeps needed — probe-measured); the old FIXED two
  // sweeps left a visible ~10px error here. Analytic fixpoint: both points
  // on the center line — from = right of c1 (100, 50), to = left of c2
  // (101, 50).
  const state = {
    items: {
      c1: { ...circlePlugin.defaults, x: 0, y: 0, w: 100, h: 100 },
      c2: { ...circlePlugin.defaults, x: 101, y: 0, w: 100, h: 100 },
      ar: {
        ...arrowPlugin.defaults,
        from: { x: "@c1_closest.x", y: "@c1_closest.y" },
        to: { x: "@c2_closest.x", y: "@c2_closest.y" },
      },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  const EPS = 0.02; // enforced residual bound 0.01 + estimator slack
  approx(s.items.ar.from.x, 100, EPS);
  approx(s.items.ar.from.y, 50, EPS);
  approx(s.items.ar.to.x, 101, EPS);
  approx(s.items.ar.to.y, 50, EPS);
});
test("evaluateState: NEAR-TANGENT mutual closest solves EXACTLY (no wobble, no cap)", () => {
  // 0.1px gap — the geometry that made the OLD Gauss-Seidel fixpoint crawl
  // (~0.996 contraction/sweep, thousands of sweeps to certify 0.01px, so the
  // cap fired). The JOINT nearest-pair solver projects onto the true rim each
  // half-step, so it converges in ONE iteration to the analytic pair: from on
  // c1's right rim (100, 50), to on c2's left rim (100.1, 50). No sweep cap,
  // no warning — the wobble class is gone by construction.
  const state = {
    items: {
      c1: { ...circlePlugin.defaults, x: 0, y: 0, w: 100, h: 100 },
      c2: { ...circlePlugin.defaults, x: 100.1, y: 0, w: 100, h: 100 },
      ar: {
        ...arrowPlugin.defaults,
        from: { x: "@c1_closest.x", y: "@c1_closest.y" },
        to: { x: "@c2_closest.x", y: "@c2_closest.y" },
      },
    },
  };
  let result;
  const logged = capturedErrors(() => { result = evaluateState(state, registry); });
  assert.equal(result.errors.size, 0);
  assert.deepEqual(logged, [], `expected no cap/wobble warning, got: ${JSON.stringify(logged)}`);
  const EPS = 1e-6; // analytic, not merely sub-visual
  approx(result.state.items.ar.from.x, 100, EPS);
  approx(result.state.items.ar.from.y, 50, EPS);
  approx(result.state.items.ar.to.x, 100.1, EPS);
  approx(result.state.items.ar.to.y, 50, EPS);
});
// ── Cross-item anchor refs to ROTATED targets (registry #2) ──────────────────
// A cross-item anchor ref must evaluate through the target's PAINTED transform
// (worldTransform — rotation pivoted about the rotationAnchor), NOT T.fromState
// (top-left pivot). Before the fix, arrows attached 49-233px off a rotated
// target. The invariant asserted: the evaluated ref === the painted anchor
// (derive.nodeAnchors), at every rotation.
function paintedAnchor(item, anchorId, reg) {
  const node = { world: worldTransform(item), state: item, plugin: reg.get(item.type) };
  return nodeAnchors(node).find((a) => a.id === anchorId);
}
test("evaluateState: preset anchor ref to a ROTATED rect matches the painted rim", () => {
  for (const rot of [Math.PI / 6, Math.PI / 4, Math.PI / 2, Math.PI]) {
    const tgt = { ...rectPlugin.defaults, x: 100, y: 100, w: 200, h: 120, rotation: rot, name: "Tgt" };
    const state = {
      items: {
        tgt,
        ar: { ...arrowPlugin.defaults, from: { x: 0, y: 0 }, to: { x: "@tgt_tr.x", y: "@tgt_tr.y" } },
      },
    };
    const { state: s, errors } = evaluateState(state, registry);
    assert.equal(errors.size, 0, `rot ${rot}`);
    const painted = paintedAnchor(tgt, "tr", registry);
    approx(s.items.ar.to.x, painted.x, 1e-6);
    approx(s.items.ar.to.y, painted.y, 1e-6);
  }
});
test("evaluateState: closest-rim ref to a ROTATED circle attaches on the painted rim", () => {
  for (const rot of [Math.PI / 6, Math.PI / 4, Math.PI / 2, Math.PI]) {
    const c1 = { ...circlePlugin.defaults, x: 100, y: 100, w: 120, h: 120, rotation: rot, name: "C" };
    const state = {
      items: {
        c1,
        ar: { ...arrowPlugin.defaults, from: { x: 400, y: 160 }, to: { x: "@c1_closest.x", y: "@c1_closest.y" } },
      },
    };
    const { state: s, errors } = evaluateState(state, registry);
    assert.equal(errors.size, 0, `rot ${rot}`);
    // Painted rim point toward the arrow's other (free) endpoint.
    const world = worldTransform(c1);
    const local = circlePlugin.closestAnchor(c1, s.items.ar.from.x, s.items.ar.from.y, world);
    const painted = T.apply(world, local.x, local.y);
    approx(s.items.ar.to.x, painted.x, 0.02);
    approx(s.items.ar.to.y, painted.y, 0.02);
    // A closest rim point is genuinely ON the circle (radius from center).
    const cen = T.apply(world, c1.w / 2, c1.h / 2);
    approx(Math.hypot(s.items.ar.to.x - cen.x, s.items.ar.to.y - cen.y), c1.w / 2, 0.05);
  }
});
test("evaluateState: mutual closest between TWO rotated rims stays consistent (both on the center line)", () => {
  // Two 100px circles 200px apart; rotation is a no-op for a circle's geometry
  // but exercises the pivoted-world eval path for BOTH endpoints jointly. The
  // fixpoint must land each endpoint on the facing rim (the mutual-closest
  // solve), not drift like the pre-fix top-left-pivot eval.
  const c1 = { ...circlePlugin.defaults, x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 3, name: "A" };
  const c2 = { ...circlePlugin.defaults, x: 300, y: 0, w: 100, h: 100, rotation: -Math.PI / 4, name: "B" };
  const state = {
    items: {
      c1, c2,
      ar: {
        ...arrowPlugin.defaults,
        from: { x: "@c1_closest.x", y: "@c1_closest.y" },
        to: { x: "@c2_closest.x", y: "@c2_closest.y" },
      },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  const EPS = 0.02;
  approx(s.items.ar.from.x, 100, EPS); // right rim of c1, facing c2
  approx(s.items.ar.from.y, 50, EPS);
  approx(s.items.ar.to.x, 300, EPS); // left rim of c2, facing c1
  approx(s.items.ar.to.y, 50, EPS);
});
test("evaluateState: anchor ref to a rotated target does NOT introduce a cycle", () => {
  // The anchor slot now depends on the target's rotationAnchor.{x,y} (self
  // anchors) — which depend only on the target's base geometry — so no path
  // returns to the arrow. Must evaluate cleanly (no false Cyclic error).
  const tgt = { ...rectPlugin.defaults, x: 10, y: 20, w: 200, h: 100, rotation: Math.PI / 5, name: "Tgt" };
  const state = {
    items: {
      tgt,
      ar: { ...arrowPlugin.defaults, from: { x: 0, y: 0 }, to: { x: "@tgt_cm.x", y: "@tgt_cm.y" } },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  // cm (center) is the rotation pivot's fixed point = the base-frame center.
  approx(s.items.ar.to.x, 110, 1e-6); // x + w/2
  approx(s.items.ar.to.y, 70, 1e-6); // y + h/2
});
test("evaluateState: closest-rim ref to a ROUNDED + ROTATED rect lands on the visible rounded rim", () => {
  // The user's ORIGINAL complaint: an arrow to a rounded, rotated rect must meet
  // the rounded rim exactly (rect.js closestAnchor → closestPointOnRoundedRect,
  // evaluated through worldTransform).
  for (const rot of [Math.PI / 6, Math.PI / 4, Math.PI]) {
    const rr = { ...rectPlugin.defaults, x: 100, y: 100, w: 200, h: 120, cornerRadius: 30, rotation: rot, name: "RR" };
    const state = {
      items: {
        rr,
        ar: { ...arrowPlugin.defaults, from: { x: 600, y: 400 }, to: { x: "@rr_closest.x", y: "@rr_closest.y" } },
      },
    };
    const { state: s, errors } = evaluateState(state, registry);
    assert.equal(errors.size, 0, `rot ${rot}`);
    const world = worldTransform(rr);
    const local = rectPlugin.closestAnchor(rr, s.items.ar.from.x, s.items.ar.from.y, world);
    const painted = T.apply(world, local.x, local.y);
    approx(s.items.ar.to.x, painted.x, 0.02);
    approx(s.items.ar.to.y, painted.y, 0.02);
  }
});

// ── DYNAMIC ANCHOR FUNCTION LIBRARY (closest_to_rim) — Opus24 ─────────────────
test("grammar: call parsing + point .x/.y projection", () => {
  const ast = parseExpression("closest_to_rim(a, b).x");
  assert.equal(ast.kind, "member");
  assert.equal(ast.prop, "x");
  assert.equal(ast.obj.kind, "call");
  assert.equal(ast.obj.name, "closest_to_rim");
  assert.equal(ast.obj.args.length, 2);
  // The .x/.y projection tokenizes as a standalone dot + coord.
  assert.deepEqual(tokenize("f(a, b).x").map((t) => t.kind), ["ref", "op", "ref", "comma", "ref", "op", "dot", "ref"]);
  // A call is a POINT; using it unprojected in arithmetic is a loud error.
  assert.throws(() => evalAst(parseExpression("closest_to_rim(a,b) + 1"), () => 0, () => ({ x: 1, y: 2 })), /returns a point/);
  // Only .x / .y are valid projections.
  assert.throws(() => parseExpression("f(a).z"), /Expected \.x or \.y/);
  assert.equal(evalAst(parseExpression("f(a,b).y + 1"), () => 0, () => ({ x: 3, y: 4 })), 5);
});
test("function table: names, overloads, arity/kind/unknown errors", () => {
  assert.deepEqual(equationFunctionNames(), ["closest_to_rim"]);
  assert.ok("closest_to_rim" in FUNCTIONS);
  assert.deepEqual(resolveOverload("closest_to_rim", 2).params, ["widget", "widget"]);
  assert.deepEqual(resolveOverload("closest_to_rim", 3).params, ["widget", "number", "number"]);
  assert.throws(() => resolveOverload("nope", 1), /Unknown function "nope"/);
  assert.throws(() => resolveOverload("closest_to_rim", 4), /has no 4-argument form/);
  assert.equal(widgetArgToken({ kind: "ref", name: "circle1" }), "circle1");
  assert.equal(widgetArgToken({ kind: "ref", name: "box.x" }), null);
  // A widget position requires a bare widget token, not an expression.
  assert.throws(() => widgetArgSpans(parseExpression("closest_to_rim(a + 1, b).x")), /must be a widget name/);
});
test("conversion: widget args round-trip slug↔@id; fn name + projection verbatim", () => {
  const st = { items: { a1: { type: "rect", name: "Box" }, a2: { type: "circle", name: "C" } }, vars: {} };
  assert.equal(displayToStored("closest_to_rim(box, c).x", st), "closest_to_rim(@a1, @a2).x");
  assert.equal(storedToDisplay("closest_to_rim(@a1, @a2).x", st), "closest_to_rim(box, c).x");
  // Round-trip is stable.
  assert.equal(displayToStored(storedToDisplay("closest_to_rim(@a1, @a2).y", st), st), "closest_to_rim(@a1, @a2).y");
  // Mixed widget + numeric args + arithmetic.
  assert.equal(displayToStored("closest_to_rim(box, 5, 6).y + 10", st), "closest_to_rim(@a1, 5, 6).y + 10");
  assert.equal(resolveWidgetArg("@a1", slugMap(st)), "a1");
  assert.equal(resolveWidgetArg("box", slugMap(st)), "a1");
  // Unknown widget name is a loud entry error.
  assert.throws(() => displayToStored("closest_to_rim(nope, c).x", st), /Unknown widget "nope"/);
});
test("closest_to_rim(widget, x, y): rim-vs-point equals the plugin closestAnchor", () => {
  // A rect's x/y written as closest_to_rim to a fixed world point → the point on
  // the rim nearest that point (here the free arrow endpoint).
  const c1 = { ...circlePlugin.defaults, x: 100, y: 100, w: 120, h: 120, name: "C" };
  const state = {
    items: {
      c1,
      ar: { ...arrowPlugin.defaults, from: { x: 400, y: 160 }, to: { x: "closest_to_rim(c, ar.from.x, ar.from.y).x", y: "closest_to_rim(c, ar.from.x, ar.from.y).y" }, name: "Ar" },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  const world = worldTransform(c1);
  const local = circlePlugin.closestAnchor(c1, 400, 160, world);
  const painted = T.apply(world, local.x, local.y);
  approx(s.items.ar.to.x, painted.x, 1e-9);
  approx(s.items.ar.to.y, painted.y, 1e-9);
});
test("closest_to_rim(A, B): JOINT nearest pair — TRUE analytic pair, both endpoints", () => {
  // Two circles: c1 radius 50 at center (50,50), c2 radius 50 at center (250,50).
  // True nearest pair: c1's right rim (100, 50), c2's left rim (200, 50).
  const c1 = { ...circlePlugin.defaults, x: 0, y: 0, w: 100, h: 100, name: "A" };
  const c2 = { ...circlePlugin.defaults, x: 200, y: 0, w: 100, h: 100, name: "B" };
  const state = {
    items: {
      c1, c2,
      ar: {
        ...arrowPlugin.defaults,
        from: { x: "closest_to_rim(a, b).x", y: "closest_to_rim(a, b).y" },
        to: { x: "closest_to_rim(b, a).x", y: "closest_to_rim(b, a).y" },
      },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  const analytic = nearestPairCircleCircle({ x: 50, y: 50 }, 50, { x: 250, y: 50 }, 50);
  approx(s.items.ar.from.x, analytic.a.x, 1e-6); // point on A's rim
  approx(s.items.ar.from.y, analytic.a.y, 1e-6);
  approx(s.items.ar.to.x, analytic.b.x, 1e-6);   // point on B's rim
  approx(s.items.ar.to.y, analytic.b.y, 1e-6);
  approx(s.items.ar.from.x, 100, 1e-6);
  approx(s.items.ar.to.x, 200, 1e-6);
});
test("closest_to_rim(A, B): re-evaluation is DETERMINISTIC (zero wobble across passes)", () => {
  const c1 = { ...circlePlugin.defaults, x: 0, y: 0, w: 100, h: 100, name: "A" };
  const c2 = { ...circlePlugin.defaults, x: 200, y: 0, w: 100, h: 100, name: "B" };
  const mk = () => ({
    items: {
      c1: { ...c1 }, c2: { ...c2 },
      ar: {
        ...arrowPlugin.defaults,
        from: { x: "closest_to_rim(a, b).x", y: "closest_to_rim(a, b).y" },
        to: { x: "closest_to_rim(b, a).x", y: "closest_to_rim(b, a).y" },
      },
    },
  });
  // Fresh state objects (defeats the whole-state memo) — the answer must be
  // bit-identical every pass: the joint solve is a pure function of geometry,
  // NOT of a previous iterate (the wobble class the old fixpoint had).
  const r1 = evaluateState(mk(), registry).state;
  const r2 = evaluateState(mk(), registry).state;
  assert.equal(r1.items.ar.from.x, r2.items.ar.from.x);
  assert.equal(r1.items.ar.from.y, r2.items.ar.from.y);
  assert.equal(r1.items.ar.to.x, r2.items.ar.to.x);
  assert.equal(r1.items.ar.to.y, r2.items.ar.to.y);
});
test("closest_to_rim: memoized joint solve — from.x and from.y share ONE solve", () => {
  // Both from.x and from.y reference closest_to_rim(a, b); the per-pass memo
  // makes them read the SAME pair (identical x/y on the exact same rim point).
  const c1 = { ...circlePlugin.defaults, x: 0, y: 0, w: 100, h: 100, name: "A" };
  const c2 = { ...circlePlugin.defaults, x: 137, y: 41, w: 80, h: 80, name: "B" };
  const state = {
    items: {
      c1, c2,
      ar: { ...arrowPlugin.defaults, from: { x: "closest_to_rim(a, b).x", y: "closest_to_rim(a, b).y" }, to: { x: 500, y: 500 } },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  // The from point lies exactly on c1's rim (radius 50 from center (50,50)).
  approx(Math.hypot(s.items.ar.from.x - 50, s.items.ar.from.y - 50), 50, 1e-6);
});
test("closest_to_rim(A, B) on ROTATED rims resolves on the PAINTED rim (45°)", () => {
  // A rotated rounded rect and a circle; the joint solve must use each rim's
  // worldTransform-painted geometry. Assert the result sits on each painted rim.
  const rr = { ...rectPlugin.defaults, x: 0, y: 0, w: 200, h: 120, cornerRadius: 30, rotation: Math.PI / 4, name: "RR" };
  const c2 = { ...circlePlugin.defaults, x: 400, y: 200, w: 100, h: 100, name: "C" };
  const state = {
    items: {
      rr, c2,
      ar: {
        ...arrowPlugin.defaults,
        from: { x: "closest_to_rim(rr, c).x", y: "closest_to_rim(rr, c).y" },
        to: { x: "closest_to_rim(c, rr).x", y: "closest_to_rim(c, rr).y" },
      },
    },
  };
  const { state: s, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  // `to` lands on c2's painted rim (radius 50 from its center).
  const cWorld = T.apply(worldTransform(c2), 50, 50);
  approx(Math.hypot(s.items.ar.to.x - cWorld.x, s.items.ar.to.y - cWorld.y), 50, 1e-6);
  // `from` lands on the rounded rect's painted rim: re-project it and confirm it
  // maps to itself (it's a fixed point of the rim's closest-point map).
  const rrWorld = worldTransform(rr);
  const localFrom = rectPlugin.closestAnchor(rr, s.items.ar.from.x, s.items.ar.from.y, rrWorld);
  const reproj = T.apply(rrWorld, localFrom.x, localFrom.y);
  approx(reproj.x, s.items.ar.from.x, 1e-4);
  approx(reproj.y, s.items.ar.from.y, 1e-4);
});
test("closest_to_rim: cycle THROUGH a function arg is LOUD (widget's own geometry)", () => {
  // A rect whose x = closest_to_rim(self, …).x depends on self's geometry incl.
  // x → self-cycle. Must be a loud Cyclic error with a numeric fallback.
  const state = {
    items: {
      r1: { ...rectPlugin.defaults, x: "closest_to_rim(self, 10, 10).x", name: "R" },
    },
  };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.match(errors.get("items.r1.x"), /Cyclic/);
  assert.equal(typeof s.items.r1.x, "number"); // fallback, not NaN
});
test("closest_to_rim: unknown widget / non-rim widget are loud entry errors", () => {
  // A widget without closestAnchor (blur has no rim) is rejected.
  const state = {
    items: {
      r1: { ...rectPlugin.defaults, name: "R" },
      ar: { ...arrowPlugin.defaults, to: { x: "closest_to_rim(missing, r).x", y: 0 }, name: "Ar" },
    },
  };
  const { errors } = capturedErrorsResult(state);
  assert.ok([...errors.values()].some((m) => /Unknown widget|has no item/.test(m)), `got: ${JSON.stringify([...errors])}`);
});
test("anchor_point widget: its `pt` anchor is a referencable movable reference point", () => {
  const anchorReg = createRegistry();
  anchorReg.register(anchorPointPlugin);
  anchorReg.register(arrowPlugin);
  const state = {
    items: {
      ap: { ...anchorPointPlugin.defaults, x: 100, y: 200, w: 20, h: 20, name: "My Anchor" },
      ar: { ...arrowPlugin.defaults, from: { x: 0, y: 0 }, to: { x: "@ap_pt.x", y: "@ap_pt.y" } },
    },
  };
  const { state: s, errors } = evaluateState(state, anchorReg);
  assert.equal(errors.size, 0);
  approx(s.items.ar.to.x, 110); // anchor pt = center = x + w/2
  approx(s.items.ar.to.y, 210);
  // Paints nothing (invisible), is a ghost, and the display slug is my_anchor_pt.
  assert.deepEqual(anchorPointPlugin.emit(s.items.ap), []);
  assert.equal(displayToStored("my_anchor_pt.x + 5", state), "@ap_pt.x + 5");
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

test("typeless-in-fold = NOT YET CREATED: Move Slide Down never crashes", () => {
  // Opus3's 3-keystroke crash: a creation slide moved BELOW a slide that
  // keyframes its items leaves intermediate folds holding typeless items.
  // Imaginary-slide semantics: such items don't exist yet — evaluation and
  // derivation SKIP them (defined behavior, not an error), and the item
  // exists again on folds that include its creation delta.
  const reg = createRegistry();
  reg.register(rectPlugin);
  reg.register(cameraPlugin);
  let doc = newDocument();
  const [d1, id] = withNewItem(doc, 0, {
    type: "rect", x: 10, y: 10, w: 50, h: 50, z: 0, rotation: 0, scale: 1,
    fill: "#fff", stroke: "#000", strokeWidth: 1, cornerRadius: 0, opacity: 1, active: true,
  });
  const [d2] = withNewSlide(d1, 0);
  const d3 = keyframed(d2, 1, ["items", id, "x"], 300);
  const moved = withSlideMoved(d3, 0, +1); // creation slide now BELOW its keyframes
  const early = foldState(moved, 0, 1);
  assert.deepEqual(early.items[id], { x: 300 }); // typeless — not yet created
  const { state: evaluated, errors } = evaluateState(early, reg); // must not throw
  assert.equal(errors.size, 0); // defined semantics, not a failure
  assert.equal(deriveRenderTree(evaluated, reg).some((n) => n.itemId === id), false);
  const late = evaluateState(foldState(moved, 1, 1), reg).state; // creation folded in
  assert.equal(deriveRenderTree(late, reg).some((n) => n.itemId === id), true);
});

test("any-type equations: a leading = resolves color/string/select/number + validates result kind", () => {
  const state = { items: {
    ok: { ...rectPlugin.defaults, fill: "=#ff8800", opacity: "=0.25", blendMode: '="multiply"' },
  } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.equal(errors.size, 0);
  assert.equal(s.items.ok.fill, "#ff8800", "color literal");
  assert.equal(s.items.ok.opacity, 0.25, "number literal");
  assert.equal(s.items.ok.blendMode, "multiply", "select literal (an allowed option)");
});
test("any-type equations: a wrong-kind = result is LOUD and falls back to the property default", () => {
  const state = { items: {
    bad: { ...rectPlugin.defaults, fill: "=42", blendMode: '="not_an_option"' },
  } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.match(errors.get("items.bad.fill"), /not a valid color/);
  assert.equal(s.items.bad.fill, rectPlugin.defaults.fill, "color<-number → default fill (never a silent 42)");
  assert.match(errors.get("items.bad.blendMode"), /not a valid select/);
  assert.equal(s.items.bad.blendMode, rectPlugin.defaults.blendMode, "select not-in-options → default");
});
test("any-type equations: a bare (no =) string in a NON-numeric slot stays a literal, never an equation", () => {
  // A plain color/name string must NOT be mistaken for an equation (only "="
  // opts a non-numeric slot in). The legacy numeric-slot rule is untouched.
  const state = { items: { r1: { ...rectPlugin.defaults, fill: "#123456" } } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.equal(errors.size, 0);
  assert.equal(s.items.r1.fill, "#123456", "literal color untouched");
});

console.log(`\n${passed} expressions tests passed`);
