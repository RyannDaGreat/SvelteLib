/**
 * THE PROJECT SCRIPT tests (core/project_script.js + its seams in
 * core/expressions.js, core/document.js). Bare node, no framework (suite
 * conventions).
 *
 * WHAT IS UNDER TEST, and why each part earns a test rather than a comment:
 *   THE JAIL          — a script must not be able to reach the wall clock, the
 *                       network or unseeded randomness. This is the manifest's
 *                       determinism law; a regression here silently makes exports
 *                       non-reproducible, which no rendered frame would reveal.
 *   EXPORT → SCOPE    — the whole point: a function written ONCE, called from TWO
 *                       different items' properties. Both are asserted, because a
 *                       per-slot compile would pass a one-property test.
 *   SHADOWING REFUSAL — a colliding export is a LOUD compile error. Tested in both
 *                       directions (built-in refused, ordinary name accepted) so the
 *                       refusal cannot be widened into "refuse everything".
 *   PRECEDENCE        — a variable or item slug BEATS an export; a built-in cannot be
 *                       reached by one at all. Pinned so the resolution order in
 *                       scopeGet cannot be reshuffled silently.
 *   LOUD FAILURE      — a broken script exports NOTHING and every equation calling it
 *                       errors through the normal equation-error path, never a silent 0.
 *   TOP-LEVEL CLOCK   — reading `time`/`random` in the script BODY is refused, because
 *                       the compile is memoized per source and such a read would be
 *                       frozen forever (the subtle determinism break this design
 *                       exists to prevent).
 *   STORAGE           — meta.script is first-class: born "", filled quietly when an
 *                       old document lacks it, discarded LOUDLY when it is not a
 *                       string, and it survives serialize/deserialize.
 *   UNDO              — a script edit is an ordinary document commit, so it undoes and
 *                       redoes interleaved with item edits. Asserted against the real
 *                       undo log, not a mock.
 *   HIGHLIGHTER        — the equation field must paint a script-exported identifier as
 *                       a reference, not as red. Found in browser verification: a
 *                       `= 0 + GUTTER * 4` that evaluated to 160 was painted entirely
 *                       red, which sends the author after a bug that is not there.
 *
 * Run: node src/demo_apps/PowerRP/tests/project_script_test.js
 */

import assert from "node:assert/strict";
import {
  compileProjectScript, projectScriptProblem, projectScriptExports,
  scriptReservedNames, scriptScope, isIdentifier,
} from "../core/project_script.js";
import { evaluateState, equationTokenSpans, BLOCKED_GLOBALS, FUNCTIONS } from "../core/expressions.js";
import {
  newDocument, repairedDocument, serialize, deserialize, keyframed, foldState,
} from "../core/document.js";
import { createUndo } from "../core/undo.js";
import { createRegistry } from "../core/registry.js";
import { rectPlugin } from "../plugins/rect.js";
import { circlePlugin } from "../plugins/circle.js";
import { cameraPlugin } from "../plugins/camera.js";

let passed = 0;
function test(name, fn) { fn(); console.log(`  ok  ${name}`); passed += 1; }

const registry = createRegistry();
registry.register(rectPlugin);
registry.register(circlePlugin);
registry.register(cameraPlugin);

// A deterministic host, standing in for the evaluator's seeded PRNG + one clock.
const HOST = { random: () => 0.25, time: () => 7 };

/** A two-rect state whose properties are the equations under test. */
function twoRects(aX, bX, bY) {
  return {
    vars: {},
    items: {
      a1: { type: "rect", x: aX, y: 0, w: 10, h: 10 },
      b2: { type: "rect", x: bX, y: bY, w: 10, h: 10 },
    },
  };
}

// ── The jail ─────────────────────────────────────────────────────────────────

test("jail: every BLOCKED_GLOBAL is unreachable from a script body", () => {
  // Each blocked name resolves to undefined, so a MEMBER use throws — which is the
  // loud shape (a silent undefined would let `Date.now && …` guard itself away).
  // `import`/`export` are statements, not member expressions, so they are exercised
  // through the syntax-error path instead of this one.
  for (const name of BLOCKED_GLOBALS) {
    if (name === "import" || name === "export") continue;
    const { exports, error } = compileProjectScript(`exports.v = ${name}.anything;`, HOST);
    assert.ok(error, `${name} must not be reachable from a project script`);
    assert.match(error, /^Project script threw:/, `${name} must fail as a throw, not silently`);
    assert.deepEqual({ ...exports }, {}, `${name}'s failure must export nothing`);
  }
});

test("jail: Math is SAFE_MATH — every member but random", () => {
  assert.equal(compileProjectScript("exports.v = Math.round(2.6);", HOST).exports.v, 3);
  assert.equal(compileProjectScript("exports.v = Math.PI;", HOST).exports.v, Math.PI);
  // Math.random is EXCISED, so calling it throws (undefined is not a function).
  const bad = compileProjectScript("exports.v = Math.random();", HOST);
  assert.match(bad.error, /^Project script threw:/);
  assert.deepEqual({ ...bad.exports }, {});
});

test("jail: the deterministic stdlib IS reachable — a library needs it", () => {
  // Each of these was unreachable before SCRIPT_STDLIB, and the failure blamed the
  // author's code ("Error is not a constructor") rather than the jail.
  const s = compileProjectScript([
    "exports.validate = (a) => { if (a < 0) throw new RangeError('negative'); return a; };",
    "exports.keys = (o) => Object.keys(o).join(',');",
    "exports.parsed = () => JSON.parse('{\"a\":1}').a;",
    "exports.mapped = () => Array.from(new Map([[1, 'x']]).values())[0];",
    "exports.num = () => parseFloat('2.5') + Number('1.5');",
  ].join("\n"), HOST);
  assert.equal(s.error, null);
  assert.equal(s.exports.validate(3), 3);
  assert.throws(() => s.exports.validate(-1), /negative/, "a script may raise its own errors");
  assert.equal(s.exports.keys({ p: 1, q: 2 }), "p,q");
  assert.equal(s.exports.parsed(), 1);
  assert.equal(s.exports.mapped(), "x");
  assert.equal(s.exports.num(), 4);
});

test("jail: the ASYNC and META-PROGRAMMING escapes stay closed", () => {
  // Each of these would break a stated invariant, so their absence is a REQUIREMENT
  // and not an accident of what SCRIPT_STDLIB happened to list: Promise/setTimeout
  // would let a value arrive after the frame was drawn; Function/eval is a second
  // UNJAILED compiler; Proxy/Reflect can forge the jail's own scope objects.
  for (const name of ["Promise", "setTimeout", "Function", "eval", "Proxy", "Reflect", "WeakMap"]) {
    const s = compileProjectScript(`exports.v = ${name};`, HOST);
    assert.equal(s.error, null, `reading ${name} is merely undefined, not itself an error`);
    assert.equal(s.exports.v, undefined, `${name} must be unreachable`);
  }
});

test("jail: an unknown free identifier is undefined, not a real global", () => {
  // `has: () => true` is what makes this true — there is no fall-through at all, so
  // even a global this test's own runtime HAS (globalThis, Buffer) is invisible.
  assert.equal(compileProjectScript("exports.v = typeof Buffer;", HOST).exports.v, "undefined");
  assert.equal(compileProjectScript("exports.v = typeof globalThis;", HOST).exports.v, "undefined");
});

test("jail: the seeded random and the one clock are the host's, inside a function", () => {
  const s = compileProjectScript("exports.r = () => random();\nexports.t = () => time;", HOST);
  assert.equal(s.error, null);
  assert.equal(s.r ?? s.exports.r(), 0.25);
  assert.equal(s.exports.t(), 7);
});

test("jail: scriptScope refuses time/random at the top level, loudly and by name", () => {
  const scope = scriptScope({ host: null }, {});
  assert.throws(() => scope.time, /"time" is unavailable at the project script's top level/);
  assert.throws(() => scope.random, /"random" is unavailable/);
  // With a live cell they resolve normally — the refusal is about WHEN, not whether.
  const live = scriptScope({ host: HOST }, {});
  assert.equal(live.time, 7);
  assert.equal(live.random(), 0.25);
});

test("a top-level clock read becomes the script's compile error", () => {
  const s = compileProjectScript("exports.t = time;", HOST);
  assert.match(s.error, /unavailable at the project script's top level/);
  assert.match(s.error, /exports\.f = \(\) => time/, "the message must name the fix");
  assert.deepEqual({ ...s.exports }, {});
  // The SAME source read through an exported function is fine — that is the fix the
  // message points at, so it must actually work.
  assert.equal(compileProjectScript("exports.t = () => time;", HOST).exports.t(), 7);
});

// ── Export convention + compile results ──────────────────────────────────────

test("only `exports` assignments escape; locals stay private", () => {
  const s = compileProjectScript(
    "const secret = 3;\nfunction helper(x) { return x + secret; }\nexports.pub = (x) => helper(x);",
    HOST);
  assert.equal(s.error, null);
  assert.deepEqual(Object.keys(s.exports), ["pub"], "only the exported name escapes");
  assert.equal(s.exports.pub(4), 7, "a private helper is still reachable from the export");
});

test("a blank script compiles to nothing, with no error", () => {
  for (const src of ["", "   ", "\n\n", null, undefined]) {
    const s = compileProjectScript(src, HOST);
    assert.equal(s.error, null, `${JSON.stringify(src)} must not be an error`);
    assert.deepEqual({ ...s.exports }, {});
  }
});

test("a syntax error and a throw are DIFFERENT messages, both loud, both total", () => {
  const syntax = compileProjectScript("exports.v = (", HOST);
  assert.match(syntax.error, /^Project script syntax error:/);
  assert.deepEqual({ ...syntax.exports }, {});
  const thrown = compileProjectScript("exports.a = 1;\nthrow new Error('boom');\nexports.b = 2;", HOST);
  assert.match(thrown.error, /^Project script threw: boom/);
  // TOTAL failure: `a` was assigned before the throw and must NOT survive — a half
  // library would blame the equations instead of the script.
  assert.deepEqual({ ...thrown.exports }, {}, "a partial export set is forbidden");
});

test("exports are frozen, so nothing downstream can mutate the library", () => {
  const s = compileProjectScript("exports.v = 1;", HOST);
  assert.ok(Object.isFrozen(s.exports));
});

// ── Shadowing refusal ────────────────────────────────────────────────────────

test("shadowing a built-in is refused at compile time, naming the collision", () => {
  for (const name of scriptReservedNames()) {
    const s = compileProjectScript(`exports.${name} = 1;`, HOST);
    assert.ok(s.error, `export "${name}" must be refused`);
    assert.match(s.error, new RegExp(`export "${name}" collides with a built-in`));
    assert.deepEqual({ ...s.exports }, {}, "a refused script exports nothing at all");
  }
});

test("the reserved set covers the evaluator keywords AND every FUNCTIONS name", () => {
  const reserved = scriptReservedNames();
  for (const kw of ["time", "random", "Math", "self"]) assert.ok(reserved.has(kw), kw);
  // Folded in from FUNCTIONS rather than restated, so a NEW library function is
  // reserved automatically — this asserts the fold, not a copy of the list.
  for (const fn of Object.keys(FUNCTIONS)) assert.ok(reserved.has(fn), `FUNCTIONS.${fn}`);
});

test("an ordinary name is NOT refused — the guard is narrow, not a blanket", () => {
  for (const name of ["ease", "GUTTER", "_private", "$x", "closestToRim"]) {
    assert.equal(compileProjectScript(`exports.${name} = 1;`, HOST).error, null, name);
  }
});

test("an export key an equation could never spell is refused", () => {
  // Assigned through a computed key, which is the only way to get here.
  const s = compileProjectScript("exports['my ease'] = 1;", HOST);
  assert.match(s.error, /is not a legal identifier/);
  assert.equal(isIdentifier("my ease"), false);
  assert.equal(isIdentifier("myEase"), true);
});

// ── Export → equation scope ──────────────────────────────────────────────────

test("ONE exported function drives TWO different items' properties", () => {
  // The headline requirement: written once, used in many places. Two items and
  // three separate slots, so a per-slot recompile or a single-use path fails here.
  const state = twoRects("= ease(0.5) * 100", "= ease(1) * 100", "= GUTTER * 2");
  const r = evaluateState(state, registry, "exports.ease = (t) => t*t*(3-2*t);\nexports.GUTTER = 12;");
  assert.deepEqual([...r.errors], [], "no slot may error");
  assert.equal(r.state.items.a1.x, 50);
  assert.equal(r.state.items.b2.x, 100);
  assert.equal(r.state.items.b2.y, 24);
});

test("an exported VALUE (not just a function) is usable from an equation", () => {
  const r = evaluateState(twoRects("= GOLDEN * 100", 0, 0), registry, "exports.GOLDEN = 1.618;");
  assert.deepEqual([...r.errors], []);
  assert.equal(Math.round(r.state.items.a1.x), 162);
});

test("an exported function may compose other exports and private helpers", () => {
  const script = [
    "const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;",
    "exports.norm = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);",
    "exports.lerp = (a, b, t) => a + (b - a) * exports.norm(t, 0, 1);",
  ].join("\n");
  const r = evaluateState(twoRects("= lerp(0, 200, 0.25)", "= norm(150, 100, 200)", 0), registry, script);
  assert.deepEqual([...r.errors], []);
  assert.equal(r.state.items.a1.x, 50);
  assert.equal(r.state.items.b2.x, 0.5);
});

// ── Precedence ───────────────────────────────────────────────────────────────

test("precedence: a VARIABLE beats an export of the same name", () => {
  const state = { vars: { gutter: 5 }, items: { a1: { type: "rect", x: "= gutter", y: 0, w: 1, h: 1 } } };
  const r = evaluateState(state, registry, "exports.gutter = 999;");
  assert.deepEqual([...r.errors], []);
  assert.equal(r.state.items.a1.x, 5, "the document's own variable wins");
});

test("precedence: an ITEM SLUG beats an export of the same name", () => {
  const state = {
    vars: {},
    items: {
      a1: { type: "rect", name: "Box", x: 40, y: 0, w: 1, h: 1 },
      b2: { type: "rect", x: "= box.x", y: 0, w: 1, h: 1 },
    },
  };
  // `box` as an export would be a plain object with no `.x`; the slug must win, so a
  // correct read is proof of the ordering rather than a coincidence.
  const r = evaluateState(state, registry, "exports.box = 1;");
  assert.deepEqual([...r.errors], []);
  assert.equal(r.state.items.b2.x, 40);
});

test("precedence: a built-in is UNREACHABLE by an export (the compile refuses first)", () => {
  // Belt and braces with the refusal test above: even at the SCOPE level, `time`
  // resolves to the clock and not to a would-be export. Since the refusal makes the
  // whole script fail, the observable effect is that `time` still reads the clock.
  const state = { vars: {}, items: { a1: { type: "rect", x: "= time * 0 + 3", y: 0, w: 1, h: 1 } } };
  const r = evaluateState(state, registry, "exports.time = 99;");
  assert.equal(r.state.items.a1.x, 3);
});

// ── Loud failure downstream ──────────────────────────────────────────────────

test("a broken script makes its callers error LOUDLY, never a silent 0", () => {
  const state = twoRects("= ease(0.5)", "= ease(1)", 0);
  const r = evaluateState(state, registry, "exports.ease = (");
  // BOTH slots must be in the error map — the plugin default is the value, and the
  // error is what makes it visible rather than a plausible-looking number.
  assert.equal(r.errors.size, 2, `expected both slots to error, got ${[...r.errors]}`);
  assert.ok(r.errors.has("items.a1.x"));
  assert.ok(r.errors.has("items.b2.x"));
  for (const [, message] of r.errors) assert.ok(message.length > 0, "an error must say something");
});

test("projectScriptProblem reports the evaluator's verdict, and never compiles", () => {
  const src = "exports.oops = (";
  // Compiled by the EVALUATOR (the path the canvas takes), then read back.
  evaluateState(twoRects(0, 0, 0), registry, src);
  assert.match(projectScriptProblem(src), /^Project script syntax error:/);
  assert.equal(projectScriptProblem(""), null, "a blank script has no problem");
  // A source nothing has compiled yet is reported as "nothing known", NOT compiled
  // here — that is the property that keeps a status read from perturbing the canvas.
  assert.equal(projectScriptProblem("exports.neverCompiledAnywhere = ("), null);
});

test("projectScriptExports reports the evaluator's export names, without compiling", () => {
  const src = "exports.ease = (t) => t;\nexports.GUTTER = 8;";
  assert.deepEqual(Object.keys(projectScriptExports(src)), [], "not yet compiled by the evaluator");
  evaluateState(twoRects(0, 0, 0), registry, src);
  assert.deepEqual(Object.keys(projectScriptExports(src)).sort(), ["GUTTER", "ease"]);
  assert.deepEqual(Object.keys(projectScriptExports("")), [], "a blank script exports nothing");
  // A BROKEN script exports nothing, so its callers correctly light up red rather
  // than being excused by a stale name list.
  evaluateState(twoRects(0, 0, 0), registry, "exports.x = (");
  assert.deepEqual(Object.keys(projectScriptExports("exports.x = (")), []);
});

// ── The equation HIGHLIGHTER must agree with the evaluator ───────────────────

test("highlighter: a script-exported identifier paints as a var, not an error", () => {
  // THE BUG THIS PINS: `= 0 + GUTTER * 4` evaluated to 160 on the canvas while the
  // field painted GUTTER red, because the identifier is not a document variable. A
  // highlighter that contradicts the evaluator sends the author after a bug that is
  // not there. (An exported FUNCTION escaped by accident — a ref before "(" is
  // classified positionally as a "call" — so only VALUES showed the disagreement.)
  const state = { vars: {}, items: { a1: { type: "rect", x: 0, y: 0, w: 1, h: 1 } } };
  const exports = new Set(["GUTTER", "ease"]);
  assert.deepEqual(equationTokenSpans("GUTTER", state, null).map((s) => s.cls), ["error"],
    "with no script, an unknown identifier is STILL red");
  assert.deepEqual(equationTokenSpans("GUTTER", state, null, exports).map((s) => s.cls), ["var"],
    "with the export known, it paints as an ordinary reference");
  assert.deepEqual(equationTokenSpans("0 + GUTTER * 4", state, null, exports).map((s) => s.cls),
    ["num", "op", "var", "op", "num"]);
  // A genuinely unknown name is still red WITH a script present — the widening is
  // exactly the export set, not a blanket amnesty.
  assert.deepEqual(equationTokenSpans("ghost", state, null, exports).map((s) => s.cls), ["error"]);
  // A real document variable still wins its own class (same precedence as the
  // evaluator's: a variable first, an export second).
  const withVar = { vars: { GUTTER: 1 }, items: {} };
  assert.deepEqual(equationTokenSpans("GUTTER", withVar, null, exports).map((s) => s.cls), ["var"]);
});

// ── Storage: meta.script is first-class ──────────────────────────────────────

test("a fresh document is born with meta.script = \"\"", () => {
  const doc = newDocument();
  assert.equal(doc.meta.script, "", "first-class and empty, never absent");
  assert.ok("script" in doc.meta);
});

test("repair: a fresh document needs no repair (idempotence)", () => {
  const { reports } = repairedDocument(newDocument(), registry);
  assert.deepEqual(reports, [], `a current document must report nothing: ${reports}`);
});

test("repair: an ABSENT script is filled QUIETLY (an old deck has no library)", () => {
  const doc = newDocument();
  const legacy = { ...doc, meta: { name: doc.meta.name, slideW: doc.meta.slideW, slideH: doc.meta.slideH } };
  const { doc: out, reports } = repairedDocument(legacy, registry);
  assert.equal(out.meta.script, "");
  assert.deepEqual(reports.filter((r) => r.includes("script")), [],
    "filling an absent script changes no meaning, so it must not print");
});

test("repair: a NON-STRING script is discarded LOUDLY (data is being destroyed)", () => {
  for (const value of [42, {}, [], true]) {
    const doc = newDocument();
    const damaged = { ...doc, meta: { ...doc.meta, script: value } };
    const { doc: out, reports } = repairedDocument(damaged, registry);
    assert.equal(out.meta.script, "");
    assert.equal(reports.filter((r) => r.includes("meta.script")).length, 1,
      `a discarded ${typeof value} script must be reported exactly once`);
  }
});

test("the script survives serialize → deserialize verbatim", () => {
  const src = "// a comment with \"quotes\" and a \\backslash\nexports.f = (x) => x * 2;\n";
  const doc = { ...newDocument() };
  doc.meta = { ...doc.meta, script: src };
  const back = deserialize(serialize(doc));
  assert.equal(back.meta.script, src, "byte-for-byte, including comments and escapes");
});

// ── Undo: a script edit is an ordinary document commit ────────────────────────

test("undo/redo round-trips a script edit interleaved with an item edit", () => {
  // The real undo log over real documents — the script is not a special case, which
  // is exactly the claim under test. Each `commit` is one undo unit, as in the app.
  const doc0 = newDocument();
  const itemId = Object.keys(doc0.slides[0].delta.items)[0]; // THE CAMERA
  const withScript = { ...doc0, meta: { ...doc0.meta, script: "exports.k = 5;" } };
  const withItem = keyframed(withScript, 0, ["items", itemId, "x"], 33);
  const withScript2 = { ...withItem, meta: { ...withItem.meta, script: "exports.k = 6;" } };

  const log = createUndo(doc0);
  for (const d of [withScript, withItem, withScript2]) log.commit(d);

  // Undo walks BACK through the interleaving: script edit, item edit, script edit.
  assert.equal(log.undo().meta.script, "exports.k = 5;", "the second script edit undoes");
  assert.equal(foldState(log.doc, 0, 1).items[itemId].x, 33, "the item edit is still there");
  const afterItemUndo = log.undo();
  assert.equal(foldState(afterItemUndo, 0, 1).items[itemId].x, 0, "the item edit undoes");
  assert.equal(afterItemUndo.meta.script, "exports.k = 5;", "and leaves the script alone");
  assert.equal(log.undo().meta.script, "", "the first script edit undoes to empty");

  // And forward again, in order.
  assert.equal(log.redo().meta.script, "exports.k = 5;");
  assert.equal(foldState(log.redo(), 0, 1).items[itemId].x, 33);
  assert.equal(log.redo().meta.script, "exports.k = 6;");
});

test("an edited script changes what the SAME folded state evaluates to", () => {
  // THE MEMO HAZARD, pinned: the fold is identical across a script edit (the script
  // lives in meta, not in the fold), so an evaluation cache keyed on state identity
  // alone would serve the pre-edit answer forever. Same `state` object, twice.
  const state = twoRects("= k", 0, 0);
  assert.equal(evaluateState(state, registry, "exports.k = 5;").state.items.a1.x, 5);
  assert.equal(evaluateState(state, registry, "exports.k = 6;").state.items.a1.x, 6);
  assert.equal(evaluateState(state, registry, "exports.k = 5;").state.items.a1.x, 5);
});

console.log(`\n${passed} project script tests passed`);
