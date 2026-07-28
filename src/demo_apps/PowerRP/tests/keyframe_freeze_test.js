/**
 * KEYFRAME FREEZE guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/keyframe_freeze_test.js
 *
 * WHY THIS EXISTS. The user asked for "a tool to remove all keyframes … for a
 * given selection or object". Taken literally that deletes the OBJECT — slide 0's
 * delta is what CREATES every item, there being no separate items table — so the
 * buildable operation is a COLLAPSE: keep exactly one full keyframe, at the item's
 * creation slide, holding the values it has on the slide the tool was run from.
 * core/document.js's "Freezing an item's animation" block states the rule and the
 * reasoning; this suite is the ratchet on it.
 *
 * WHAT IT PROVES:
 *   (1) NOTHING VISIBLE CHANGES WHERE YOU RAN IT — the item still exists and its
 *       folded state on the invoking slide is deep-equal to what it was.
 *   (2) IT IS ACTUALLY FROZEN — every slide from the target onward folds to the
 *       same state, and no slide keys the item any more except the target.
 *   (3) THE VISIBILITY TIMELINE SURVIVES LEAF-FOR-LEAF. `active` is EXISTENCE,
 *       not animation (core/properties.js PROPS.active); collapsing it would
 *       silently perform a Delete-everywhere or Show-everywhere, and running the
 *       tool from a slide where the item is hidden would erase it from the whole
 *       document while still passing check (1).
 *   (4) AN EQUATION IN FORCE SURVIVES VERBATIM (the raw fold is written back, not
 *       the evaluated one), and an equation the collapse DOES replace is named by
 *       lostEquationKeyframes rather than vanishing quietly.
 *   (5) THE DELETE SENTINEL CANNOT RESURRECT A KEY — a `null` leaf that removed a
 *       key from the fold must not come back when the collapse rewrites the
 *       creation slide.
 *   (6) IDEMPOTENT + PURE — a second run has nothing to do, and the source
 *       document is never mutated.
 *   (7) A FROZEN DOCUMENT IS A CLEAN DOCUMENT — repairedDocument() reports NOTHING
 *       about it, so the operation cannot produce a doc the load boundary wants to
 *       fix up.
 *   (8) THE SKIPS ARE REPORTED, NOT SWALLOWED — an item created later in the deck,
 *       an orphan, and an already-static item each come back with a reason.
 *   (9) THE TOOL IS WIRED UP — the Keyframes pool group exists, applies to every
 *       registered widget (including THE camera), and names the command entry
 *       web/App.svelte registers.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  foldState, freezeTargetSlide, itemAnimationKeyframes, lostEquationKeyframes,
  withKeyframesFrozen, repairedDocument, newDocument,
} from "../core/document.js";
import { createRegistry, TOOL_POOL, keyframable } from "../core/registry.js";
import { allPlugins } from "../plugins/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const registry = createRegistry();
for (const p of allPlugins) registry.register(p);

/**
 * Pure function. A deep copy, and the identity comparison this suite uses for
 * DOCUMENTS — compared by SERIALIZATION, never by reference (a rebuilt slide is
 * a different object holding the same document).
 *
 * STATES are compared with assert.deepEqual instead, deliberately: the collapse
 * clears an item's subtree and rewrites it, so `active` (the one leaf it never
 * touches) ends up FIRST in the rewritten delta's key order. Key order is not
 * part of what a state means anywhere in this codebase — deltas are addressed by
 * path — and the operation is idempotent, so the order settles after one run.
 */
const json = (x) => JSON.stringify(x);
const clone = (x) => JSON.parse(json(x));

/**
 * Pure function. A three-slide document whose rect MOVES (x), CHANGES COLOUR
 * (fill) and is HIDDEN then SHOWN again — every axis this suite discriminates,
 * in one fixture. Slide 0 creates it with the rect plugin's real defaults so the
 * document is one repairedDocument() has nothing to say about.
 */
function movingRectDoc(overrides = {}) {
  const rect = { ...registry.get("rect").defaults, type: "rect", x: 10, y: 10, fill: "#ff0000" };
  return {
    meta: { name: "T", slideW: 1280, slideH: 720 },
    slides: [
      { id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 1, curve: "smooth", sound: null }, delta: { items: { r: { ...rect, ...overrides } } } },
      { id: "s1", name: "Slide 2", transition: { type: "tween", seconds: 1, curve: "smooth", sound: null }, delta: { items: { r: { x: 200, fill: "#00ff00", active: false } } } },
      { id: "s2", name: "Slide 3", transition: { type: "tween", seconds: 1, curve: "smooth", sound: null }, delta: { items: { r: { x: 400, active: true } } } },
    ],
  };
}

// ── (1) nothing visible changes where you ran it ─────────────────────────────
test("the item survives and its folded state on the INVOKING slide is unchanged", () => {
  for (const from of [0, 1, 2]) {
    const doc = movingRectDoc();
    const before = foldState(doc, from, 1).items.r;
    const { doc: out, frozen } = withKeyframesFrozen(doc, from, ["r"]);
    assert.deepEqual(frozen, ["r"], `slide ${from}: nothing was frozen`);
    const after = foldState(out, from, 1).items.r;
    assert.ok(after, `slide ${from}: the item stopped existing`);
    assert.deepEqual(after, before, `slide ${from}: folded state changed under the freeze`);
  }
});

// ── (2) it is actually frozen ────────────────────────────────────────────────
test("every slide from the target onward folds to the SAME state (bar visibility)", () => {
  const doc = movingRectDoc();
  const { doc: out } = withKeyframesFrozen(doc, 2, ["r"]);
  const shown = (i) => { const s = { ...foldState(out, i, 1).items.r }; delete s.active; return s; };
  assert.deepEqual(shown(0), shown(1));
  assert.deepEqual(shown(1), shown(2));
  // …and it is the slide-2 state that survived (x: 400), not the creation pose.
  assert.equal(foldState(out, 0, 1).items.r.x, 400);
  assert.equal(foldState(out, 0, 1).items.r.fill, "#00ff00");
});

test("only the TARGET slide keys the item afterwards (bar the visibility leaves)", () => {
  const doc = movingRectDoc();
  const target = freezeTargetSlide(doc, "r");
  assert.equal(target, 0);
  const { doc: out } = withKeyframesFrozen(doc, 2, ["r"]);
  assert.deepEqual(Object.keys(out.slides[1].delta.items.r), ["active"]);
  assert.deepEqual(Object.keys(out.slides[2].delta.items.r), ["active"]);
  assert.equal(itemAnimationKeyframes(out, "r").length, 0, "the freeze left animation keyframes behind");
});

test("the TARGET is the first ENABLED slide keying `type` (a disabled one is out of the fold)", () => {
  const doc = movingRectDoc();
  doc.slides[0].enabled = false;
  doc.slides[1].delta.items.r.type = "rect"; // re-created on the first slide that folds
  assert.equal(freezeTargetSlide(doc, "r"), 1);
  // Writing the collapsed state into slide 0 would delete the item from the whole
  // document, because a disabled slide's delta is skipped entirely.
  const { doc: out } = withKeyframesFrozen(doc, 2, ["r"]);
  assert.ok(foldState(out, 2, 1).items.r, "the item vanished — the collapse was written into a disabled slide");
});

// ── (3) the visibility timeline survives leaf-for-leaf ───────────────────────
test("`active` keyframes are untouched on every slide, so visibility is identical", () => {
  const doc = movingRectDoc();
  const visibility = (d) => d.slides.map((_, i) => foldState(d, i, 1).items.r?.active);
  const before = visibility(doc);
  const { doc: out } = withKeyframesFrozen(doc, 2, ["r"]);
  assert.deepEqual(visibility(out), before);
  assert.deepEqual(before, [undefined, false, true], "the fixture stopped exercising the hide/show timeline");
});

test("running it from a slide where the item is HIDDEN does not erase it from the deck", () => {
  const doc = movingRectDoc();
  const { doc: out } = withKeyframesFrozen(doc, 1, ["r"]); // slide 1: active === false
  assert.equal(foldState(out, 0, 1).items.r.active, undefined, "slide 0 must stay visible");
  assert.equal(foldState(out, 1, 1).items.r.active, false);
  assert.equal(foldState(out, 2, 1).items.r.active, true, "the Show on slide 2 was collapsed away");
});

test("an item whose ONLY later keyframes are `active` is already static (the gate says no)", () => {
  const doc = movingRectDoc();
  doc.slides[1].delta.items.r = { active: false };
  doc.slides[2].delta.items.r = { active: true };
  assert.deepEqual(itemAnimationKeyframes(doc, "r"), []);
  const { doc: out, frozen, skipped } = withKeyframesFrozen(doc, 0, ["r"]);
  assert.deepEqual(frozen, []);
  assert.equal(skipped[0].reason, "it has no keyframes beyond its creation slide — it is already static");
  assert.equal(json(out), json(doc), "a no-op must not rewrite the document");
});

// ── (4) equations ────────────────────────────────────────────────────────────
test("an equation IN FORCE on the invoking slide is written back verbatim", () => {
  const doc = movingRectDoc({ x: "=100 + 5" });
  delete doc.slides[1].delta.items.r.x; // …so the creation equation is what folds through
  delete doc.slides[2].delta.items.r.x;
  assert.deepEqual(lostEquationKeyframes(doc, 2, "r", registry), []);
  const { doc: out } = withKeyframesFrozen(doc, 2, ["r"]);
  assert.equal(out.slides[0].delta.items.r.x, "=100 + 5", "the equation was baked into a number");
});

test("an equation the collapse REPLACES is named (and then really is gone)", () => {
  const doc = movingRectDoc({ x: "=100 + 5" });
  const lost = lostEquationKeyframes(doc, 2, "r", registry);
  assert.deepEqual(lost, [{ slideIndex: 0, path: ["x"], value: "=100 + 5" }]);
  const { doc: out } = withKeyframesFrozen(doc, 2, ["r"]);
  assert.equal(out.slides[0].delta.items.r.x, 400);
});

test("a COMPUTED default (`self.`-equation) survives verbatim and is not reported lost", () => {
  // rotationAnchor's stored form is "self.anchors.center.x" (core/document.js
  // missingDefaults: computed defaults are resolved at derivation, never
  // materialized). Baking it to a number would silently pin the rotation pivot to
  // wherever the box happened to be — writing the RAW fold back is what prevents it.
  const doc = movingRectDoc({ rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" } });
  assert.deepEqual(lostEquationKeyframes(doc, 2, "r", registry), []);
  const { doc: out } = withKeyframesFrozen(doc, 2, ["r"]);
  assert.deepEqual(out.slides[0].delta.items.r.rotationAnchor, { x: "self.anchors.center.x", y: "self.anchors.center.y" });
});

test("a BARE reference in a numeric slot counts as an equation too (the camera-bind form)", () => {
  const doc = movingRectDoc({ x: "@cam.x" });
  assert.deepEqual(lostEquationKeyframes(doc, 2, "r", registry).map((e) => e.value), ["@cam.x"]);
  // Still in force on slide 0 → freezing FROM slide 0 keeps it and reports nothing.
  assert.deepEqual(lostEquationKeyframes(doc, 0, "r", registry), []);
});

// ── (5) the delete sentinel cannot resurrect a key ───────────────────────────
test("a key a `null` keyframe removed from the fold does NOT come back", () => {
  const doc = movingRectDoc();
  doc.slides[0].delta.items.r.stroke = "#123456";
  doc.slides[1].delta.items.r.stroke = null; // NONE: delete the key
  assert.equal("stroke" in foldState(doc, 2, 1).items.r, false);
  const { doc: out } = withKeyframesFrozen(doc, 2, ["r"]);
  assert.equal("stroke" in foldState(out, 2, 1).items.r, false, "the creation-slide stroke survived the collapse");
  assert.equal("stroke" in foldState(out, 0, 1).items.r, false);
});

// ── (6) idempotent + pure ────────────────────────────────────────────────────
test("PURE: the source document is not mutated", () => {
  const doc = movingRectDoc();
  const before = json(doc);
  withKeyframesFrozen(doc, 2, ["r"]);
  assert.equal(json(doc), before);
});

test("IDEMPOTENT: a second freeze from the same slide has nothing to do", () => {
  const doc = movingRectDoc();
  const { doc: once } = withKeyframesFrozen(doc, 2, ["r"]);
  const { doc: twice, frozen } = withKeyframesFrozen(once, 2, ["r"]);
  assert.deepEqual(frozen, []);
  assert.equal(json(twice), json(once));
});

test("MULTI-SELECTION: one call freezes the whole set, and the items do not interfere", () => {
  const doc = movingRectDoc();
  doc.slides[0].delta.items.q = { ...registry.get("circle").defaults, type: "circle", x: 0 };
  doc.slides[1].delta.items.q = { x: 77 };
  const rBefore = clone(foldState(doc, 1, 1).items.r);
  const qBefore = clone(foldState(doc, 1, 1).items.q);
  const { doc: out, frozen } = withKeyframesFrozen(doc, 1, ["r", "q"]);
  assert.deepEqual(frozen, ["r", "q"]);
  assert.deepEqual(foldState(out, 1, 1).items.r, rBefore);
  assert.deepEqual(foldState(out, 1, 1).items.q, qBefore);
  assert.equal(foldState(out, 0, 1).items.q.x, 77);
});

// ── (7) a frozen document is a clean document ────────────────────────────────
test("repairedDocument() has NOTHING to say about a frozen document", () => {
  // Start from a real editor document so the baseline is genuinely clean.
  const base = repairedDocument(newDocument(), registry).doc;
  const rect = { ...registry.get("rect").defaults, type: "rect", x: 10 };
  const doc = clone(base);
  doc.slides.push({ id: "s1", name: "Slide 2", transition: clone(base.slides[0].transition), delta: { items: { r: { x: 300 } } } });
  doc.slides[0].delta.items.r = rect;
  assert.deepEqual(repairedDocument(doc, registry).reports, [], "the fixture itself is not repair-clean");
  const { doc: out } = withKeyframesFrozen(doc, 1, ["r"]);
  assert.deepEqual(repairedDocument(out, registry).reports, []);
  // …and the freeze did not quietly drop THE CAMERA on the way through.
  const cameraId = Object.keys(out.slides[0].delta.items).find((id) => out.slides[0].delta.items[id].type === "camera");
  assert.ok(cameraId, "the camera is gone");
});

test("THE CAMERA can be frozen: `purgeable: false` forbids removal, not stillness", () => {
  const base = repairedDocument(newDocument(), registry).doc;
  const cameraId = Object.keys(base.slides[0].delta.items)[0];
  const doc = clone(base);
  doc.slides.push({ id: "s1", name: "Slide 2", transition: clone(base.slides[0].transition), delta: { items: { [cameraId]: { x: 500 } } } });
  const before = clone(foldState(doc, 1, 1).items[cameraId]);
  const { doc: out, frozen } = withKeyframesFrozen(doc, 1, [cameraId]);
  assert.deepEqual(frozen, [cameraId]);
  assert.deepEqual(foldState(out, 1, 1).items[cameraId], before);
  assert.equal(foldState(out, 0, 1).items[cameraId].x, 500);
  assert.deepEqual(repairedDocument(out, registry).reports, []);
});

// ── (8) the skips are reported, not swallowed ────────────────────────────────
test("an item created LATER in the deck is skipped with its reason", () => {
  const doc = movingRectDoc();
  doc.slides.unshift({ id: "sPre", name: "Slide 0", transition: clone(doc.slides[0].transition), delta: {} });
  const { doc: out, frozen, skipped } = withKeyframesFrozen(doc, 0, ["r"]);
  assert.deepEqual(frozen, []);
  assert.match(skipped[0].reason, /no state on slide 0/);
  assert.equal(json(out), json(doc));
});

test("an ORPHAN (no slide sets its type) is skipped with its reason", () => {
  const doc = movingRectDoc();
  delete doc.slides[0].delta.items.r.type;
  const { frozen, skipped } = withKeyframesFrozen(doc, 2, ["r"]);
  assert.deepEqual(frozen, []);
  assert.match(skipped[0].reason, /sets its type/);
});

// ── (9) the tool is wired up ─────────────────────────────────────────────────
test("the Keyframes pool group exists and names the command web/App.svelte registers", () => {
  const group = TOOL_POOL.find((g) => g.id === "keyframes");
  assert.ok(group, "no `keyframes` group in TOOL_POOL");
  assert.deepEqual(group.rows.map((r) => r.command), ["freeze-keyframes"]);
  const appSvelte = readFileSync(resolve(here, "../web/App.svelte"), "utf8");
  assert.ok(appSvelte.includes('id: "freeze-keyframes"'), "web/App.svelte registers no `freeze-keyframes` command");
  // The pool row's help/requires ARE the entry's — imported, never transcribed.
  assert.ok(appSvelte.includes("FREEZE_KEYFRAMES_HELP") && appSvelte.includes("FREEZE_KEYFRAMES_REQUIRES"),
    "the command entry re-types the sentences instead of importing them from core/registry.js");
});

test("the tool reaches EVERY registered widget, THE camera included", () => {
  const registered = registry.all();
  const unreached = registered.filter((p) => !keyframable(p)).map((p) => p.type);
  assert.deepEqual(unreached, [], `these widgets show no Keyframes group: ${unreached.join(", ")}`);
  for (const p of registered)
    assert.ok(p.toolGroups.some((g) => g.id === "keyframes"), `${p.type}: no resolved Keyframes group`);
  assert.equal(keyframable({ defaults: {} }), false, "the predicate is vacuous — it accepts a stateless plugin too");
});

console.log(`\n${passed} keyframe freeze tests passed`);
