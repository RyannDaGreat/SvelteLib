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
  slugify, slugMap, anchorRefName, canonicalPropPath, parseStoredRef, parseSelfRef, resolveRef, mapRefTokens,
  snakeToCamel, camelToSnake,
  displayToStored, storedToDisplay, isNumericSlot,
  evaluateState, withBindingsMigrated, withVariableRenamed,
} from "../core/expressions.js";
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
test("evaluateState: DEGENERATE tangency hits the sweep cap LOUDLY, result stays sane", () => {
  // 0.1px gap: asymptotic contraction ~0.996/sweep — certifying 0.01px would
  // take thousands of sweeps, so the cap fires (reported, never silent) and
  // the best iterate is kept. The residual is sub-visual (< 0.1px).
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
  assert.equal(result.errors.size, 0); // a slow fixpoint is not a slot error
  assert.ok(logged.some((m) => m.includes("closest-anchor fixpoint still moving")),
    `expected the loud sweep-cap warning, got: ${JSON.stringify(logged)}`);
  approx(result.state.items.ar.from.x, 100, 0.1);
  approx(result.state.items.ar.from.y, 50, 0.1);
  approx(result.state.items.ar.to.x, 100.1, 0.1);
  approx(result.state.items.ar.to.y, 50, 0.1);
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

console.log(`\n${passed} expressions tests passed`);
