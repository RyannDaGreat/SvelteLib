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
  displayToStored, storedToDisplay, isNumericSlot, resultKindForSlot, resultMatchesKind,
  evaluateState, withBindingsMigrated, withVariableRenamed,
  FUNCTIONS, equationFunctionNames, resolveOverload, widgetArgToken, widgetArgSpans, resolveWidgetArg,
  withMarkerPreserved, isEquationValue, declaredListLeaves,
} from "../core/expressions.js";
import * as EXPRESSIONS from "../core/expressions.js"; // the MARKER SEAM sweep derives its set by reflection
import { PROPS } from "../core/properties.js";
import { textDissolve, textType, textScramble, shuffledOrder, hashText, clamp01 } from "../core/text_transitions.js";
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
import { plaintextPlugin } from "../plugins/plaintext.js"; // a plain STRING slot — the string-transition target
import { polygonPlugin } from "../plugins/polygon.js"; // a DECLARED LIST — an equation leaves() cannot see
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js"; // pin the presentation clock for `= time` tests

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
registry.register(plaintextPlugin);
registry.register(polygonPlugin);

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
  // NOT a transcribed roster — that was a hand-maintained mirror (R6-24.7), and it
  // went red the moment a function was added without saying anything true had
  // broken. What is actually under test is that every entry is USABLE: a name a
  // user can type, at least one overload for resolveOverload to find, and a doc
  // line for the autocomplete. Plus the specific entries this suite exercises,
  // which pins their existence without claiming the list is closed.
  for (const name of equationFunctionNames()) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, `"${name}" is not a typeable canonical function name`);
    assert.ok(FUNCTIONS[name].overloads.length > 0, `"${name}" declares no overload`);
    assert.ok(FUNCTIONS[name].doc, `"${name}" has no doc line for the autocomplete`);
  }
  for (const name of ["closest_to_rim", "text_dissolve", "text_type", "text_scramble", "direction2"])
    assert.ok(name in FUNCTIONS, `"${name}" left the function library`);
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

// ── STRING-TRANSITION FUNCTIONS (core/text_transitions.js + FUNCTIONS registry) ─
test("text_transitions pure: textType typewriter reveal (endpoints + floor cut)", () => {
  assert.equal(textType("Hello", 0), "");
  assert.equal(textType("Hello", 1), "Hello");
  assert.equal(textType("Hello", 0.5), "He"); // floor(0.5*5) = 2
  assert.equal(textType("Hello", 0.6), "Hel"); // floor(0.6*5) = 3
  assert.equal(textType("Hello", -1), ""); // clamped
  assert.equal(textType("Hello", 2), "Hello"); // clamped
});
test("text_transitions pure: textScramble resolves scramble→clear, length + whitespace preserved", () => {
  assert.equal(textScramble("Hello", 1), "Hello"); // fully resolved
  assert.equal(textScramble("Hello", 0).length, 5); // same length when fully scrambled
  assert.notEqual(textScramble("Hello", 0), "Hello"); // scramble glyphs are non-alphabetic
  assert.equal(textScramble("Hi there", 1), "Hi there");
  assert.equal(textScramble("Hi there", 0)[2], " "); // whitespace preserved at every alpha
  assert.equal(textScramble("Decode", 0.5), textScramble("Decode", 0.5)); // deterministic (no Math.random)
  assert.equal(textScramble("Decode", 0.5).length, 6);
});
test("text_transitions pure: textDissolve endpoints EXACT + deterministic scattered mid", () => {
  assert.equal(textDissolve("cat", "dog", 0), "cat"); // alpha 0 → from, verbatim
  assert.equal(textDissolve("cat", "dog", 1), "dog"); // alpha 1 → to, verbatim
  assert.equal(textDissolve("cat", "dog", -0.5), "cat"); // clamped
  assert.equal(textDissolve("cat", "dog", 5), "dog"); // clamped
  const mid = textDissolve("cat", "dog", 0.5);
  assert.equal(mid, textDissolve("cat", "dog", 0.5)); // deterministic given (from, to, alpha)
  assert.equal(mid.length, 3);
  assert.notEqual(mid, "cat"); // a real blend — not either endpoint
  assert.notEqual(mid, "dog");
  assert.equal(textDissolve("hi", "hello", 1), "hello"); // grows to the longer target
  assert.equal(textDissolve("hello", "hi", 0), "hello"); // starts at the longer source
});
test("text_transitions pure: helpers (clamp01, hashText, shuffledOrder)", () => {
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(1.7), 1);
  assert.equal(hashText(""), 2166136261); // the bare FNV-1a offset basis
  assert.notEqual(hashText("a"), hashText("b"));
  assert.deepEqual(shuffledOrder(0, 123), []);
  assert.deepEqual(shuffledOrder(4, 7).slice().sort((a, b) => a - b), [0, 1, 2, 3]); // a permutation
  assert.deepEqual(shuffledOrder(4, 7), shuffledOrder(4, 7)); // deterministic
});
test("string-transition registry: names + overloads + arity errors", () => {
  assert.ok("text_dissolve" in FUNCTIONS && "text_type" in FUNCTIONS && "text_scramble" in FUNCTIONS);
  assert.deepEqual(resolveOverload("text_dissolve", 3).params, ["string", "string", "number"]);
  assert.deepEqual(resolveOverload("text_type", 2).params, ["string", "number"]);
  assert.deepEqual(resolveOverload("text_scramble", 2).params, ["string", "number"]);
  assert.throws(() => resolveOverload("text_type", 3), /has no 3-argument form/);
  assert.equal(typeof FUNCTIONS.text_dissolve.impl, "function"); // a pure impl, not a point-solver
});
test("string-transition equation: an = call on a STRING slot resolves to a string (plaintext.text)", () => {
  const state = { vars: {}, items: {
    typed: { ...plaintextPlugin.defaults, text: '=text_type("Hello", 0.4)' },      // floor(0.4*5)=2
    a: { ...plaintextPlugin.defaults, text: '=text_dissolve("cat", "dog", 0)' },   // → from
    b: { ...plaintextPlugin.defaults, text: '=text_dissolve("cat", "dog", 1)' },   // → to
  } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.equal(errors.size, 0);
  assert.equal(s.items.typed.text, "He");
  assert.equal(s.items.a.text, "cat");
  assert.equal(s.items.b.text, "dog");
});
test("string-transition equation: alpha may be a VARIABLE and its dependency IS captured", () => {
  const state = { vars: { base: 0.2, alpha: "base + 0.4" }, items: { // alpha slot = 0.6
    d: { ...plaintextPlugin.defaults, name: "D", text: '=text_type("Hello", alpha)' },
  } };
  const { state: s, errors, deps } = capturedErrorsResult(state);
  assert.equal(errors.size, 0);
  assert.equal(s.items.d.text, "Hel"); // floor(0.6*5) = 3
  assert.ok(deps.get("items.d.text").has("vars.alpha"), "the string-arg's ref is a captured dependency");
});
test("string-transition equation: derivation is DETERMINISTIC across fresh states (no Math.random)", () => {
  const mk = () => ({ vars: {}, items: { m: { ...plaintextPlugin.defaults, text: '=text_scramble("Decode", 0.5)' } } });
  const first = capturedErrorsResult(mk()).state.items.m.text;
  const second = capturedErrorsResult(mk()).state.items.m.text; // distinct state object → not memo-shared
  assert.equal(first, second);
  assert.equal(first.length, 6);
});
test("string-transition conversion: a call display↔stored round-trips (literals verbatim, var checked)", () => {
  const st = { vars: { p: 0.5 }, items: {} };
  assert.equal(displayToStored('=text_dissolve("a", "b", p)', st), 'text_dissolve("a", "b", p)');
  assert.equal(displayToStored('text_type("Hi", 0.5)', st), 'text_type("Hi", 0.5)');
  assert.throws(() => displayToStored('text_type("Hi", ghost)', st), /Unknown variable "ghost"/);
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

// ── Tier-0 result-kind resolution (manifest: "=" on EVERY property) ──────────
test("resultKindForSlot: an angle-kind PROPS row types as a NUMBER (raw degrees)", () => {
  // No PROPS entry declares kind "angle" YET (the gradient direction reaches
  // AngleField through a paint sub-path, below), so register a throwaway one to
  // prove the KIND_RESULT mapping the first real angle row will depend on. It
  // used to fall through a `?? "string"` guess and reject a good heading with
  // `= expression result 30 is not a valid string value`.
  const key = "__test_angle_row__";
  PROPS[key] = { label: "Test angle", kind: "angle", category: "formatting" };
  try {
    assert.equal(resultKindForSlot({ defaults: {} }, [key], "=30"), "number");
    assert.equal(resultMatchesKind(30, resultKindForSlot({ defaults: {} }, [key], "=30")), true);
  } finally {
    delete PROPS[key];
  }
});
test("resultKindForSlot: every PROPS kind in the registry is typed (no silent string guess)", () => {
  // The import-time guard in core/expressions.js enforces this; assert it here
  // too so the reason a new kind must be typed is visible from the test suite.
  // "list" joined the set when list properties landed (core/lists.js): it is its
  // OWN result type, not a coercion of a scalar one — an `=` on a whole list must
  // evaluate to an ARRAY of the declared element shape, which the grammar can only
  // produce by REFERENCING another list slot (`= other_poly.points`). Its element
  // shape is then validated by listResultProblem. See tests/lists_test.js.
  for (const [key, def] of Object.entries(PROPS)) {
    const kind = resultKindForSlot({ defaults: {} }, key.split("."), "=1");
    assert.ok(["number", "color", "boolean", "select", "string", "list"].includes(kind), `PROPS."${key}" (kind ${def.kind}) → ${kind}`);
  }
});
test("resultKindForSlot: PAINT sub-state leaves resolve (the gradient direction dial)", () => {
  // A paint stores {type, solid, linear: {stops, angle}, radial: {stops, center, r}},
  // none of which the plugin's flat hex `fill` default describes — these used to
  // guess "string" and reject every gradient-geometry equation.
  assert.equal(resultKindForSlot(rectPlugin, ["fill", "linear", "angle"], "=30"), "number");
  assert.equal(resultKindForSlot(rectPlugin, ["stroke", "linear", "angle"], "=30"), "number");
  assert.equal(resultKindForSlot(cameraPlugin, ["background", "linear", "angle"], "=30"), "number");
  assert.equal(resultKindForSlot(rectPlugin, ["fill", "radial", "r"], "=0.5"), "number");
  assert.equal(resultKindForSlot(rectPlugin, ["fill", "radial", "center", "x"], "=0.5"), "number");
  assert.equal(resultKindForSlot(rectPlugin, ["fill", "solid"], "=#f00"), "color");
  assert.equal(resultKindForSlot(rectPlugin, ["fill", "angle"], "=30"), "number", "LEGACY inline gradient (no mode wrapper)");
  assert.equal(resultKindForSlot(rectPlugin, ["fill"], "=#f00"), "color", "the paint itself is still PROPS.fill");
  // A plain (non-paint) color property must NOT pick up paint sub-state rules.
  assert.equal(resultKindForSlot(rectPlugin, ["shadow", "color"], "=#f00"), "color");
});
test("resultKindForSlot: a self.-prefixed COMPUTED default is numeric under = too", () => {
  // isNumericSlot already treats a "self."-default as a numeric slot; the "="
  // branch used to see only a non-hex STRING and type it "string" (magnifier /
  // magnify `origin.x`, whose default is "self.anchors.center.x").
  const plugin = { defaults: { origin: { x: "self.anchors.center.x" } } };
  assert.equal(resultKindForSlot(plugin, ["origin", "x"], "=self.w"), "number");
  assert.equal(resultKindForSlot(plugin, ["origin", "x"], "self.w"), "number", "legacy, no leading =");
});
test("resultKindForSlot: an UNDECLARED slot is 'unresolved', never guessed as a string", () => {
  assert.equal(resultKindForSlot({ defaults: {} }, ["mystery"], "=1"), "unresolved");
  assert.equal(resultMatchesKind(1, "unresolved"), false);
  assert.equal(resultMatchesKind("x", "unresolved"), false);
});
test("evaluateState: gradient geometry equations evaluate (angle, radius, center, solid)", () => {
  const state = {
    vars: { tilt: 33 },
    items: { g: { ...rectPlugin.defaults, fill: {
      type: "linearGradient", solid: "=#ff8800",
      linear: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], angle: "=tilt * 2" },
      radial: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], center: { x: "=tilt / 66", y: 0.5 }, r: "=0.25 + 0.25" },
    } } },
  };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.equal(errors.size, 0, [...errors].join("; "));
  assert.equal(s.items.g.fill.linear.angle, 66, "the direction dial's heading, in degrees");
  assert.equal(s.items.g.fill.radial.r, 0.5);
  assert.equal(s.items.g.fill.radial.center.x, 0.5);
  assert.equal(s.items.g.fill.solid, "#ff8800");
});
test("evaluateState: an UNDECLARED slot's = fails LOUDLY with an actionable message", () => {
  const state = { items: { m: { ...rectPlugin.defaults, mystery: "=1 + 1" } } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.match(errors.get("items.m.mystery"), /has no declared value kind/);
  assert.match(errors.get("items.m.mystery"), /PROPS entry, or a plugin default/, "the message names the fix");
  assert.equal(s.items.m.mystery, 0, "falls back (no plugin default at this path)");
});

// ── Reserved literals (true/false are GRAMMAR, not variables) ────────────────
test("displayToStored: the reserved boolean literals round-trip (they are not variables)", () => {
  const state = { vars: {}, items: { a1: { type: "rect", name: "Box" } } };
  assert.equal(displayToStored("=true", state), "true");
  assert.equal(displayToStored("=false", state), "false");
  assert.equal(displayToStored("= true", state), "true", "whitespace after = tolerated");
  assert.equal(storedToDisplay("true", state), "true");
  assert.equal(displayToStored("box.x", state), "@a1.x", "ordinary refs still map");
  // Still LOUD on a real unknown identifier — the literal skip is narrow.
  assert.throws(() => displayToStored("ghost", state), /Unknown variable "ghost"/);
});
test("mapRefTokens: a reserved literal is grammar (never mapped); a call NAME still is", () => {
  assert.equal(mapRefTokens("true", (t) => t.toUpperCase()), "true");
  assert.equal(mapRefTokens("false + a", (t) => t.toUpperCase()), "false + A");
  assert.equal(mapRefTokens("true(1)", (t) => t.toUpperCase()), "TRUE(1)", "a following ( makes it a call name, exactly as the parser decides");
});
test("evaluateState: a boolean = equation evaluates in a boolean slot", () => {
  const state = { items: { t: { ...textPlugin.defaults, type: "text", bold: "=true" } } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.equal(errors.size, 0, [...errors].join("; "));
  assert.equal(s.items.t.bold, true);
  const off = capturedErrorsResult({ items: { t: { ...textPlugin.defaults, type: "text", bold: "=false" } } });
  assert.equal(off.errors.size, 0);
  assert.equal(off.state.items.t.bold, false);
});
test("equationTokenSpans: reserved literals and typed literals get their own classes", () => {
  const state = { vars: { speed: 1 }, items: {} };
  assert.deepEqual(equationTokenSpans("true", state).map((s) => s.cls), ["bool"], "a valid boolean is NOT an error span");
  assert.deepEqual(equationTokenSpans("false", state).map((s) => s.cls), ["bool"]);
  assert.deepEqual(equationTokenSpans('"hi"', state).map((s) => s.cls), ["str"], "a string literal is not punctuation");
  assert.deepEqual(equationTokenSpans("#ff0080", state).map((s) => s.cls), ["color"], "a hex literal is not punctuation");
  assert.deepEqual(equationTokenSpans("true(1)", state).map((s) => s.cls), ["call", "paren", "num", "paren"]);
  assert.deepEqual(equationTokenSpans("ghost", state).map((s) => s.cls), ["error"], "a REAL unknown ref is still red");
  assert.deepEqual(equationTokenSpans("speed", state).map((s) => s.cls), ["var"]);
});

// ── GRAMMAR: `%` modulo + the `time` keyword (manifest item 72 — `time % length`) ─
test("grammar: `%` parses at the * / tier and evaluates as modulo", () => {
  assert.deepEqual(tokenize("time % 12.5").map((t) => t.kind), ["ref", "op", "num"], "% tokenizes as an op");
  // Same precedence tier as * and /: `10 % 3 * 2` = (10 % 3) * 2 = 2, left-associative.
  assert.equal(evalAst(parseExpression("10 % 3 * 2"), () => 0), 2);
  assert.equal(evalAst(parseExpression("7 % 3"), () => 0), 1);
  assert.equal(evalAst(parseExpression("13.5 % 5"), () => 0), 3.5);
  // + binds looser than %: `1 + 8 % 5` = 1 + (8 % 5) = 4.
  assert.equal(evalAst(parseExpression("1 + 8 % 5"), () => 0), 4);
});
test("grammar: the `time` keyword round-trips through the UI validator (not an unknown variable)", () => {
  const state = { vars: {}, items: { a1: { type: "rect", name: "Box" } } };
  // resolveRef sees it as a keyword, not a variable → displayToStored no longer throws.
  assert.deepEqual(resolveRef("time", slugMap(state)), { kind: "keyword", name: "time" });
  assert.equal(displayToStored("time", state), "time");
  assert.equal(displayToStored("time % 12.5", state), "time % 12.5", "the exact `time % length` shape the user types");
  assert.equal(storedToDisplay("time % 12.5", state), "time % 12.5", "and it round-trips back to display verbatim");
  assert.equal(mapRefTokens("time % 2", (t) => t.toUpperCase()), "time % 2", "the keyword is grammar, never mapped");
  // Painted as a keyword (like `self`), the % as an op — never an error span.
  assert.deepEqual(equationTokenSpans("time % 2", state).map((s) => s.cls), ["self", "op", "num"]);
  // A REAL unknown identifier is STILL loud — the keyword skip is narrow.
  assert.throws(() => displayToStored("tyme % 2", state), /Unknown variable "tyme"/);
});
test("evaluateState: `= time % length` evaluates against the pinned presentation clock", () => {
  setParticleTimeOverride(13.5); // clock at 13.5s
  try {
    // rect.x is a numeric slot; bind it to the dream equation with a literal length of 5.
    const state = { items: { r: { ...rectPlugin.defaults, x: "= time % 5" } } };
    const { state: s, errors } = capturedErrorsResult(state);
    assert.equal(errors.size, 0, [...errors].join("; "));
    assert.equal(s.items.r.x, 3.5, "13.5 % 5 = 3.5 — a looping ramp over a 5s clip");
    // Δt = 0 ⟹ identical (recordable-state law): same clock, same value, distinct state object.
    const again = capturedErrorsResult({ items: { r: { ...rectPlugin.defaults, x: "= time % 5" } } });
    assert.equal(again.state.items.r.x, 3.5);
    // A different clock ⟹ a different value (the whole point of time-driven scrubbing).
    setParticleTimeOverride(2);
    assert.equal(capturedErrorsResult({ items: { r: { ...rectPlugin.defaults, x: "= time % 5" } } }).state.items.r.x, 2);
  } finally {
    setParticleTimeOverride(null); // never leak the override into sibling tests
  }
});

// ── FULL-JS evaluator (new Function + with(proxy)) — determinism + dep-capture ─
test("full-JS: an IIFE evaluates (locals + return)", () => {
  const state = { items: { r: { ...rectPlugin.defaults, x: "(function () { return 123; })()" } } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.equal(errors.size, 0);
  assert.equal(s.items.r.x, 123); // the exact spec example: (function(){return 123})()
});
test("full-JS: locals + a loop compute inside an IIFE", () => {
  const state = { items: { r: { ...rectPlugin.defaults, x: "(function () { let s = 0; for (let i = 1; i <= 4; i++) s += i; return s; })()" } } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.equal(errors.size, 0);
  assert.equal(s.items.r.x, 10); // 1 + 2 + 3 + 4
});
test("full-JS: conditionals + Math (deterministic members) are available", () => {
  const state = { items: { r: { ...rectPlugin.defaults, x: "self.w > 0 ? Math.sqrt(144) + Math.max(1, 2, 3) : -1" } } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.equal(errors.size, 0);
  assert.equal(s.items.r.x, 15); // self.w (default 100) > 0 → 12 + 3
});
test("full-JS: DYNAMIC dep-capture records a ref read inside a TAKEN `if` branch; the untaken branch is NOT captured", () => {
  // src.y is an equation slot (= 6); dst.x reads it ONLY inside the if-branch.
  const mk = (speed) => ({
    vars: { speed },
    items: {
      src: { ...rectPlugin.defaults, name: "Src", y: "speed + 1" }, // slug "src"; itemId "src"
      dst: { ...rectPlugin.defaults, name: "Dst", x: "(function () { if (speed > 0) { return src.y; } return 999; })()" },
    },
  });
  const taken = evaluateState(mk(5), registry); // if (5 > 0) → reads src.y
  assert.equal(taken.errors.size, 0);
  assert.equal(taken.state.items.dst.x, 6);
  assert.ok(taken.deps.get("items.dst.x").has("items.src.y"), "ref read inside the taken `if` IS captured");
  const untaken = evaluateState(mk(0), registry); // if (0 > 0) false → returns 999, never reads src.y
  assert.equal(untaken.errors.size, 0);
  assert.equal(untaken.state.items.dst.x, 999);
  assert.ok(!(untaken.deps.get("items.dst.x")?.has("items.src.y")), "untaken-branch ref is NOT captured (documented caveat)");
});
test("full-JS determinism: Date and Math.random are UNAVAILABLE — loud, fall back to default", () => {
  const state = { items: {
    d: { ...rectPlugin.defaults, x: "Date.now()" },
    m: { ...rectPlugin.defaults, x: "Math.random()" },
  } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.ok(errors.get("items.d.x"), "Date.now() is an error (Date routed to undefined)");
  assert.ok(errors.get("items.m.x"), "Math.random() is an error (random removed)");
  assert.equal(s.items.d.x, rectPlugin.defaults.x); // fell back — never the wall clock
  assert.equal(s.items.m.x, rectPlugin.defaults.x);
});
test("full-JS: `random` is a SEEDED deterministic generator (identical across fresh states)", () => {
  const mk = () => ({ items: { r: { ...rectPlugin.defaults, x: "random() * 1000" } } });
  const a = evaluateState(mk(), registry).state.items.r.x; // fresh object → defeats the memo
  const b = evaluateState(mk(), registry).state.items.r.x;
  assert.equal(typeof a, "number");
  assert.ok(a >= 0 && a < 1000);
  assert.equal(a, b, "same document ⇒ same sequence (RenderTree stays pure(document))");
});
test("full-JS: a throwing expression fails LOUD and falls back (no silent NaN)", () => {
  const state = { items: { r: { ...rectPlugin.defaults, x: "(function () { const a = null; return a.b; })()" } } };
  const { state: s, errors } = capturedErrorsResult(state);
  assert.ok(errors.get("items.r.x"), "the thrown error is reported");
  assert.equal(s.items.r.x, rectPlugin.defaults.x); // fallback, never NaN/undefined
});

// ── THE "=" MARKER SEAM (forward invariant) ──────────────────────────────────
//
// The universal "=" marker is NOT part of the expression grammar — tokenize()
// rejects it, and it must, because its tokens carry SOURCE POSITIONS that the
// rewriters slice the original string with. So every function that takes a stored
// equation source has to decide what to do with the marker, and there are only two
// right answers:
//
//   STRIP     f("= X", …) behaves exactly as f("X", …)              (readers/parsers)
//   PRESERVE  f("= X", …) is f("X", …) with the marker put back      (rewriters)
//
// A function that does NEITHER is the defect this guards. It does not merely throw:
// every caller of the tokenizer wraps it in a "not parseable → return the value
// unchanged" branch, so the marker form comes back UNTOUCHED and nobody says a
// word. That is how withVariableRenamed left `= speed * 2` naming a variable it had
// just deleted, and how storedToDisplay put a raw `@a1.x` internal id on screen.
//
// THE SET IS DERIVED, NOT LISTED. Reflect over the module's exports and take every
// function whose FIRST PARAMETER is named `src` — this file's own name for "a
// stored equation source". A new function that tokenizes a stored value is swept
// the moment it is exported; there is no roster to remember to update, which is the
// point (the hand-kept mirror is its own recurring defect).
//
// THE ARGUMENT VOCABULARY IS SHAPES, NOT NAMES. To call each swept function the
// sweep tries the module's own second-argument shapes (nothing, a state, a token
// mapper, an idMap) and uses the first one the marker-FREE call accepts. A new
// function needing a shape not in the vocabulary FAILS here rather than passing
// unexamined — also the point.

/** The one export that satisfies NEITHER relation, and why. Asserted to STILL
 * fail both, so this note cannot outlive its reason. */
const MARKER_LEDGER = {
  tokenize: "tokenize DEFINES the grammar the marker is not part of, and its tokens carry positions into the exact string it was handed — swallowing a prefix would report offsets into a string the caller never had. That is why withMarkerPreserved exists ABOVE it.",
};

const SEAM_STATE = { vars: { speed: 5 }, items: { a1: { ...rectPlugin.defaults, name: "Box" } } };
// A body that is valid in BOTH directions (a stored @id AND a display variable), so
// one probe serves the stored→display and display→stored functions alike.
const SEAM_BODY = "@a1.x + speed";
// EVERY SPELLING OF THE MARKER, because the near-miss is as dangerous as the
// omission: a hand-rolled `/^=/` (no `\s*`) passes a `"= x"` probe and mangles
// `"  = x"`, and a hand-rolled `/^\s*=\s*/` in a PRESERVING function eats the
// body's own leading space. Only one regex, behind the seam, survives all three.
const SEAM_MARKERS = ["=", "= ", "  =  "];
const SEAM_TAILS = [[], [SEAM_STATE], [(t) => t], [new Map([["a1", "z9"]])]];

/** Pure function. The first parameter's name in a function's source, or null. */
function firstParamName(fn) {
  const m = /^[^(]*\(([^),]*)/.exec(fn.toString());
  const name = m?.[1]?.trim().split(/[\s=]/)[0];
  return name || null;
}
/** Pure function. `value` with `marker` put back on — onto the string itself, or
 * onto its `src` field (this module's name for "the rewritten source"). */
function markerAdded(value, marker) {
  if (typeof value === "string") return marker + value;
  if (value && typeof value.src === "string") return { ...value, src: marker + value.src };
  return null; // no PRESERVE form exists for this shape
}
/** Query. Deep equality as a boolean (assert.deepEqual throws; the sweep needs to
 * test two candidate relations and report on both). */
function deepEquals(a, b) {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false; // a mismatch is the ANSWER here, not a failure
  }
}

test("MARKER SEAM: every exported source-taking function in core/expressions.js STRIPS or PRESERVES the `=` marker (set derived by reflection)", () => {
  const swept = Object.entries(EXPRESSIONS)
    .filter(([, v]) => typeof v === "function" && firstParamName(v) === "src")
    .map(([name]) => name);
  // The derivation must actually be finding things — a reflection bug that swept
  // NOTHING would make every assertion below vacuous.
  assert.ok(swept.length >= 8, `the sweep found only ${swept.length} source-taking exports — the derivation is broken, not the code`);
  for (const name of Object.keys(MARKER_LEDGER))
    assert.ok(swept.includes(name), `MARKER_LEDGER names "${name}", which is no longer a swept export — delete the note`);

  for (const name of swept) {
    const fn = EXPRESSIONS[name];
    const tail = SEAM_TAILS.find((t) => {
      try {
        fn(SEAM_BODY, ...t);
        return true;
      } catch {
        return false; // this shape is not this function's signature; try the next
      }
    });
    if (name in MARKER_LEDGER) {
      // The ledger's claim is narrow: this function REJECTS the marker form (so it
      // satisfies neither relation, by construction). If that stops being true the
      // note has outlived its reason and must go — MARKER_LEDGER[name] says why.
      for (const marker of SEAM_MARKERS)
        assert.throws(() => fn(marker + SEAM_BODY, ...(tail ?? [])), /Unexpected character "="/,
          `${name} no longer rejects the "${marker}" marker — MARKER_LEDGER's exception for it is stale: ${MARKER_LEDGER[name]}`);
      continue;
    }
    assert.ok(tail, `no probe shape fits ${name}(src, …) — add its second-argument shape to SEAM_TAILS and state which relation it satisfies`);
    const plain = fn(SEAM_BODY, ...tail);
    for (const marker of SEAM_MARKERS) {
      // A THROW is one of the two ways to fail this, and the likelier one: a new
      // marker-blind rewriter hands the marker to tokenize and dies there. It gets
      // the SAME guidance as a wrong VALUE, because it is the same mistake.
      let marked, threw = null;
      try {
        marked = fn(marker + SEAM_BODY, ...tail);
      } catch (e) {
        threw = e;
      }
      const outcome = threw ? `threw "${threw.message}"` : `returned ${JSON.stringify(marked)}`;
      const ok = !threw && (deepEquals(marked, plain) || deepEquals(marked, markerAdded(plain, marker)));
      assert.ok(ok,
        `${name}("${marker}${SEAM_BODY}") neither STRIPS nor PRESERVES the marker — it ${outcome}, `
        + `where stripping gives ${JSON.stringify(plain)} and preserving gives ${JSON.stringify(markerAdded(plain, marker))}. `
        + "Route it through withMarkerPreserved (a rewriter) or strip the marker on entry (a reader).");
    }
  }
});

test("variable rename is COMPLETE or LOUD in every shape a document stores an equation", () => {
  const doc = {
    meta: {},
    slides: [{
      id: "s0",
      delta: {
        vars: { speed: 5, bare: "speed * 2", marked: "= speed * 3" },
        items: {
          n: { ...rectPlugin.defaults, type: "rect", name: "N", x: "speed * 2" },        // legacy bare, numeric slot
          m: { ...rectPlugin.defaults, type: "rect", name: "M", y: "= speed * 4" },      // "=" on a numeric slot
          s: { ...textPlugin.defaults, type: "text", name: "S", text: "= speed" },       // "=" on a NON-numeric slot
          p: { ...polygonPlugin.defaults, type: "polygon", name: "P", points: [["= speed", 0]] }, // "=" in a declared list
          j: { ...rectPlugin.defaults, type: "rect", name: "J", x: "(function () { return speed; })()" }, // full JS
        },
      },
    }],
  };
  let out;
  const reports = capturedErrors(() => {
    out = withVariableRenamed(doc, "speed", "velocity", registry);
  });
  const d = out.slides[0].delta;
  assert.equal(d.vars.velocity, 5);          // the keyframe moved
  assert.equal(d.vars.bare, "velocity * 2");
  assert.equal(d.vars.marked, "= velocity * 3");
  assert.equal(d.items.n.x, "velocity * 2");
  assert.equal(d.items.m.y, "= velocity * 4");
  assert.equal(d.items.s.text, "= velocity");     // the isNumericSlot filter never saw this one
  assert.equal(d.items.p.points[0][0], "= velocity");
  assert.equal(d.items.j.x, "(function () { return speed; })()"); // unrewritable — left alone
  assert.equal(reports.length, 1, `expected exactly the full-JS equation to be reported, got: ${JSON.stringify(reports)}`);
  assert.match(reports[0], /rename incomplete/);
  assert.match(reports[0], /still names "speed"/);

  // THE POSTCONDITION, derived from the resulting DOCUMENT rather than from the
  // list of shapes above: every equation slot the canonical walk can see must have
  // either lost the old name or been REPORTED. A future storable shape that this
  // rename cannot reach fails here unless it says so out loud.
  const stillNamesOld = (v) => typeof v === "string" && /\bspeed\b/.test(v);
  const accountedFor = (where, value) => assert.ok(reports.some((r) => r.includes(value)),
    `${where} still names "speed" after the rename and NOTHING reported it: ${JSON.stringify(value)}`);
  for (const slide of out.slides) {
    for (const [name, value] of Object.entries(slide.delta.vars ?? {}))
      if (stillNamesOld(value)) accountedFor(`vars.${name}`, value);
    for (const [itemId, sub] of Object.entries(slide.delta.items ?? {})) {
      const plugin = registry.get(sub.type);
      for (const [path, value] of [...leaves(sub), ...declaredListLeaves(sub)])
        if (isEquationValue(plugin, path, value) && stillNamesOld(value))
          accountedFor(`items.${itemId}.${path.join(".")}`, value);
    }
  }
});

test("resolveRef takes ONE TOKEN: a whole equation source is a loud error, not a variable named `= speed`", () => {
  const slugs = slugMap(SEAM_STATE);
  assert.deepEqual(resolveRef("speed", slugs), { kind: "var", name: "speed" });
  // The marker case, which silently disabled NumericField's reference scrubber:
  // classifyEquation strips and says "reference", so the two calls disagreed.
  assert.equal(classifyEquation("= speed"), "reference");
  for (const src of ["= speed", "=speed", "  =  speed"])
    assert.throws(() => resolveRef(src, slugs), /is not one reference token/, `resolveRef must reject ${JSON.stringify(src)}`);
  // Not marker-specific — the whole source-where-a-token-belongs category is loud.
  assert.throws(() => resolveRef("speed * 2", slugs), /is not one reference token/);
});

test("withMarkerPreserved: the marker's own spacing survives; a marker-free source is passed whole", () => {
  const swap = (body) => body.replace("@a", "@z");
  assert.equal(withMarkerPreserved("= @a.w / 2", swap), "= @z.w / 2");
  assert.equal(withMarkerPreserved("@a.w", swap), "@z.w");
  assert.equal(withMarkerPreserved("  =  @a.w", swap), "  =  @z.w");
  assert.equal(withMarkerPreserved("=1", (b) => `(${b})`), "=(1)");
  // The body handed to `rewrite` never contains the marker — that is the contract
  // the tokenizer depends on.
  withMarkerPreserved("=  speed", (body) => {
    assert.equal(body, "  speed");
    return body;
  });
});

console.log(`\n${passed} expressions tests passed`);
