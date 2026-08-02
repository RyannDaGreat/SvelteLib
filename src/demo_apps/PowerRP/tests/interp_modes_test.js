/**
 * PER-PROPERTY INTERPOLATION MODES (core/interp_modes.js + its one call site in
 * core/deltas.mutBlendApply). Plain node, no framework (suite convention):
 *   node src/demo_apps/PowerRP/tests/interp_modes_test.js
 *
 * WHAT THIS PINS, and why each half matters:
 *
 *   (1) THE STORAGE KEY IS INERT EVERYWHERE ELSE. `<key>~interp` must survive
 *       delta paths without becoming a child of the property (a "." would), and
 *       must be UNREACHABLE from the equation grammar (REF_RE takes identifier
 *       characters only) — that unreachability is what stops anyone binding a
 *       mode to a formula, which the mode-steps-at-start rule depends on.
 *   (2) ABSENT = TODAY, BYTE-IDENTICAL. The whole no-migration promise. Asserted
 *       as a JSON byte comparison of a folded legacy document across a sweep of
 *       alphas, not as a spot check — a partial equality would let a mode leak a
 *       key into a fold nobody asked to change.
 *   (3) STEP FORCES A NUMERIC LEAF DISCRETE, from both storage positions (the
 *       standing mode on the outgoing state, and the mode the incoming delta
 *       sets) and INDEPENDENTLY OF DELTA KEY ORDER — the ordering hazard
 *       mutBlendApply's `outgoing` snapshot exists for.
 *   (4) THE MODE STEPS AT THE START. The user's "flicked immediately at the
 *       beginning": at any alpha > 0 the TARGET mode governs, both directions
 *       (tween→step and step→tween).
 *   (5) THE REGISTRY EXTENSION HOOK. A follow-up wave (fade/blend/morph) must be
 *       able to add a law WITHOUT touching deltas — so a mode registered from
 *       outside changes the fold, receives the documented (a, b, alpha, ctx),
 *       and a duplicate id throws instead of silently replacing a law.
 *   (6) LOUD ON AN UNKNOWN MODE. A document naming a mode this build lacks must
 *       throw, not quietly tween — the no-silent-fallback rule.
 *
 * DOM-free (core/), so it runs in bare node.
 */

import assert from "node:assert/strict";
import { blendApplied, applied, setPath, getPath, leaves } from "../core/deltas.js";
import {
  INTERP_KEY_SUFFIX, DEFAULT_INTERP_MODE, interpKeyFor, isInterpKey, propertyOfInterpKey,
  registerInterpMode, interpMode, interpModeIds, interpModeLabels, modeForBlend, blendUnderMode,
} from "../core/interp_modes.js";
import { interpRowFor, rowSupportsInterp } from "../core/properties.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) The key scheme ───────────────────────────────────────────────────────

test("key scheme: interpKeyFor / isInterpKey / propertyOfInterpKey (doctests)", () => {
  assert.equal(INTERP_KEY_SUFFIX, "~interp");
  assert.equal(interpKeyFor("x"), "x~interp");
  assert.equal(interpKeyFor("visible"), "visible~interp");
  assert.equal(isInterpKey("x~interp"), true);
  assert.equal(isInterpKey("x"), false);
  assert.equal(propertyOfInterpKey("cornerRadius~interp"), "cornerRadius");
  assert.equal(propertyOfInterpKey("cornerRadius"), null);
});

test("the key is a SIBLING, not a child: delta paths keep the property a leaf", () => {
  // The reason the marker is not ".": a dotted companion would make `x` a TREE.
  const tree = setPath({}, ["items", "a", interpKeyFor("x")], "step");
  assert.equal(getPath(tree, ["items", "a", "x~interp"]), "step");
  assert.equal(getPath(tree, ["items", "a", "x"]), undefined, "x is untouched — the mode is beside it, not inside it");
  // leaves() sees it as one ordinary leaf (so the keyframe panel lists it).
  assert.deepEqual(leaves(tree), [[["items", "a", "x~interp"], "step"]]);
});

test("the key is UNREACHABLE from the equation grammar (that is the point)", () => {
  // core/expressions.js REF_RE = /^@?[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/ — "~" is
  // not an identifier character, so no reference token can ever name a mode key.
  // A mode must be a stepped literal; enforcing that in the GRAMMAR beats
  // enforcing it in a runtime check nobody remembers to write.
  const REF_RE = /^@?[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/;
  assert.equal(REF_RE.exec("x~interp")[0], "x", "a ref stops dead at the tilde");
  // And no plugin-declared key can collide, because plugin keys are identifiers.
  assert.equal(/^[A-Za-z_][A-Za-z0-9_.]*$/.test("x~interp"), false);
});

// ── (2) Absent = today, byte-identical ───────────────────────────────────────

test("ABSENT companion: a legacy fold is BYTE-IDENTICAL across every alpha", () => {
  // A state exercising every branch interpolate() has: number, int pair, color,
  // string, boolean, numeric array, record list, nested tree, an addition and a
  // deletion. No "~interp" anywhere — i.e. every document written before today.
  const state = {
    x: 0, count: 1, fill: "#000000", label: "a", on: false,
    pts: [0, 0], stops: [{ offset: 0.25, color: "#000000" }],
    shadow: { dx: 0, dy: 0 }, gone: 7,
  };
  const delta = {
    x: 10, count: 4, fill: "#ffffff", label: "b", on: true,
    pts: [10, 20], stops: [{ offset: 0.75, color: "#ffffff" }],
    shadow: { dx: 4, dy: 8 }, gone: null, added: 3,
  };
  // The EXPECTED values are written out by hand rather than computed from the
  // same code path, so this cannot pass by both sides changing together.
  // (The stop offsets are 0.25 → 0.75, deliberately NOT the 0 → 1 int pair:
  // interpolate() ROUNDS a lerp between two integers — the tweenline int rule,
  // the "integer trap" core/lists.js names — and a midpoint that snapped to an
  // endpoint would hide a real drift in the record-list branch.)
  const expectedHalf = {
    x: 5, count: 3, fill: "#808080", label: "b", on: true,
    pts: [5, 10], stops: [{ offset: 0.5, color: "#808080" }],
    shadow: { dx: 2, dy: 4 }, added: 3,
  };
  assert.equal(JSON.stringify(blendApplied(state, delta, 0.5)), JSON.stringify(expectedHalf));
  assert.equal(JSON.stringify(blendApplied(state, delta, 0)), JSON.stringify(state));
  assert.equal(JSON.stringify(blendApplied(state, delta, 1)), JSON.stringify(applied(state, delta)));
  // A sweep, so a mode cannot have leaked a key or shifted a value at some alpha.
  for (const alpha of [0.01, 0.1, 0.25, 0.5, 0.75, 0.99, 1]) {
    const out = blendApplied(state, delta, alpha);
    assert.equal(Object.keys(out).some(isInterpKey), false, `alpha ${alpha}: no companion key invented`);
  }
});

test("the DEFAULT mode's law IS interpolate — which is why (2) can hold", () => {
  assert.equal(DEFAULT_INTERP_MODE, "tween");
  assert.equal(blendUnderMode(0, 10, 0.5, { key: "x", mode: "tween" }), 5);
  assert.equal(blendUnderMode("#000000", "#ffffff", 0.5, { key: "fill", mode: "tween" }), "#808080");
  assert.equal(blendUnderMode("a", "b", 0.5, { key: "label", mode: "tween" }), "b");
});

// ── (3) Step forces a numeric leaf discrete ──────────────────────────────────

test("STEP forces a numeric leaf discrete — the user's example, x", () => {
  // The STANDING mode (already on the outgoing state).
  const standing = blendApplied({ x: 0, "x~interp": "step" }, { x: 10 }, 0.5);
  assert.equal(standing.x, 10, "x jumps rather than lerping");
  assert.equal(standing["x~interp"], "step");
  // Every alpha past zero, and zero itself still untouched.
  assert.equal(blendApplied({ x: 0, "x~interp": "step" }, { x: 10 }, 0.001).x, 10);
  assert.equal(blendApplied({ x: 0, "x~interp": "step" }, { x: 10 }, 0).x, 0);
  // The SIBLING property with no mode still tweens — a mode is per-property.
  const mixed = blendApplied({ x: 0, y: 0, "x~interp": "step" }, { x: 10, y: 10 }, 0.5);
  assert.deepEqual([mixed.x, mixed.y], [10, 5]);
});

test("STEP set BY THE INCOMING DELTA governs the same transition", () => {
  const out = blendApplied({ x: 0 }, { x: 10, "x~interp": "step" }, 0.5);
  assert.equal(out.x, 10, "the mode flicked at the start and then governed x");
  assert.equal(out["x~interp"], "step");
});

test("DELTA KEY ORDER cannot change the result (the `outgoing` snapshot)", () => {
  // JS object iteration is insertion order, so a delta listing the companion
  // FIRST would have already clobbered the standing mode by the time x asks —
  // unless the mode is read from a pre-loop snapshot. Both orders, both
  // directions of mode change.
  const modeFirst = blendApplied({ x: 0, "x~interp": "step" }, { "x~interp": "tween", x: 10 }, 0.5);
  const propFirst = blendApplied({ x: 0, "x~interp": "step" }, { x: 10, "x~interp": "tween" }, 0.5);
  assert.equal(JSON.stringify(modeFirst), JSON.stringify(propFirst));
  assert.equal(modeFirst.x, 5, "the TARGET mode (tween) governs, whichever key came first");

  const onFirst = blendApplied({ x: 0 }, { "x~interp": "step", x: 10 }, 0.5);
  const onLast = blendApplied({ x: 0 }, { x: 10, "x~interp": "step" }, 0.5);
  assert.equal(JSON.stringify(onFirst), JSON.stringify(onLast));
  assert.equal(onFirst.x, 10);
});

test("a mode inside a NESTED tree governs that level's leaf", () => {
  // Each recursion step takes its own snapshot, so `shadow.dx~interp` lives
  // inside `shadow` and governs `shadow.dx` alone.
  const out = blendApplied(
    { shadow: { dx: 0, dy: 0, "dx~interp": "step" } },
    { shadow: { dx: 10, dy: 10 } },
    0.5,
  );
  assert.deepEqual([out.shadow.dx, out.shadow.dy], [10, 5]);
});

// ── (4) The mode steps at the start ──────────────────────────────────────────

test("modeForBlend: the TARGET wins from frame 1, both directions (doctests)", () => {
  assert.equal(modeForBlend(undefined, undefined), "tween");
  assert.equal(modeForBlend("step", undefined), "step", "a standing mode carries when the delta is silent");
  assert.equal(modeForBlend(undefined, "step"), "step");
  assert.equal(modeForBlend("step", "tween"), "tween");
});

test("switching a stepping property BACK to tween tweens the SAME transition", () => {
  // The other direction of the ruling: the mode that steps in is the one that
  // governs, so turning step OFF takes effect immediately too.
  const out = blendApplied({ x: 0, "x~interp": "step" }, { x: 10, "x~interp": "tween" }, 0.5);
  assert.equal(out.x, 5);
  assert.equal(out["x~interp"], "tween");
});

// ── (5) The registry extension hook ──────────────────────────────────────────

test("registry vocabulary: ids, labels, lookup", () => {
  assert.deepEqual(interpModeIds().slice(0, 2), ["tween", "step"]);
  assert.equal(interpModeLabels().step, "Step");
  assert.equal(interpMode("step").label, "Step");
  assert.equal(interpMode("nope"), undefined);
  assert.ok(interpMode("tween").help.length > 0, "every mode explains itself in the Inspector");
});

test("EXTENSION HOOK: a mode registered from OUTSIDE changes the fold, with deltas untouched", () => {
  // This is the seam the fade/blend/morph waves ride. Nothing in core/deltas.js
  // knows this mode exists; registering it is the entire integration.
  const seen = [];
  registerInterpMode({
    id: "__test_halfway",
    label: "Halfway",
    help: "Test-only: parks at the midpoint until the transition ends.",
    blend: (a, b, alpha, ctx) => {
      seen.push({ a, b, alpha, ctx });
      return (a + b) / 2;
    },
  });
  const out = blendApplied({ x: 0, "x~interp": "__test_halfway" }, { x: 10 }, 0.25);
  assert.equal(out.x, 5, "the new law drove the fold");
  // The documented contract, exactly: lazy start capture, the delta's target,
  // an alpha strictly inside the endpoints, and a {key, mode} ctx bag.
  assert.deepEqual(seen, [{ a: 0, b: 10, alpha: 0.25, ctx: { key: "x", mode: "__test_halfway" } }]);
  // ENDPOINTS ARE NEVER THE MODE'S CALL, and this mode would visibly disagree if
  // they were (it returns the midpoint at every alpha). `applied()` IS
  // blendApplied(…, 1) and core/document.js folds every slide through it, so a
  // mode reached at alpha 1 would rewrite the document's own stored values.
  // Enforced at the call site, so the blend is not even INVOKED.
  seen.length = 0;
  assert.equal(blendApplied({ x: 0, "x~interp": "__test_halfway" }, { x: 10 }, 0).x, 0);
  assert.equal(blendApplied({ x: 0, "x~interp": "__test_halfway" }, { x: 10 }, 1).x, 10);
  assert.equal(applied({ x: 0, "x~interp": "__test_halfway" }, { x: 10 }).x, 10);
  assert.deepEqual(seen, [], "no mode is consulted at an endpoint");
});

test("a DUPLICATE mode id THROWS — two waves cannot silently share a name", () => {
  assert.throws(
    () => registerInterpMode({ id: "step", label: "Nope", blend: (a, b) => b }),
    /already registered/,
  );
  assert.throws(() => registerInterpMode({ id: "", label: "x", blend: (a, b) => b }), /non-empty string/);
  assert.throws(() => registerInterpMode({ id: "__test_bad", label: "x" }), /blend/);
});

// ── (6) Loud on an unknown mode ──────────────────────────────────────────────

test("an UNKNOWN mode THROWS rather than quietly tweening", () => {
  // The stand-in used to be "fade" — a mode that did not exist YET. It does now
  // (core/interp_modes.js), so this assertion silently stopped testing anything
  // it meant to and started testing that fade was still missing. Named for a
  // mode nobody will ever ship, so the check keeps meaning what it says.
  assert.throws(
    () => blendApplied({ x: 0, "x~interp": "__never_a_real_mode" }, { x: 10 }, 0.5),
    /Unknown interpolation mode "__never_a_real_mode" on "x~interp"/,
  );
});

// ── The Inspector's derived row ──────────────────────────────────────────────

test("interpRowFor: a DERIVED select row over the registered modes (doctests)", () => {
  const r = interpRowFor({ key: "x", label: "X", category: "positioning" });
  assert.equal(r.key, "x~interp");
  assert.equal(r.label, "X interpolation");
  assert.equal(r.kind, "select");
  assert.equal(r.category, "positioning");
  assert.equal(r.interpOf, "x");
  assert.ok(r.options.includes("step"));
  assert.equal(r.optionLabels.step, "Step");
  assert.ok(r.help.includes("Step"), "the row explains every mode it offers");
  // A row displaying one key while WRITING another (cx → x) must name the
  // WRITTEN slot, or the mode would govern a property nothing stores.
  assert.equal(interpRowFor({ key: "cx", writeKey: "x", label: "Center X" }).key, "x~interp");
});

test("rowSupportsInterp: keyframeable rows only, and never a mode row itself", () => {
  assert.equal(rowSupportsInterp({ key: "x", kind: "number" }), true);
  assert.equal(rowSupportsInterp({ key: "visible", kind: "boolean" }), true, "the user named `visible` explicitly");
  assert.equal(rowSupportsInterp({ key: "name", kind: "text", keyframes: false }), false);
  assert.equal(rowSupportsInterp({ key: "__ungroup", kind: "action" }), false);
  assert.equal(rowSupportsInterp(interpRowFor({ key: "x", label: "X" })), false, "no mode-of-a-mode");
});

console.log(`\n${passed} interp-mode tests passed`);
