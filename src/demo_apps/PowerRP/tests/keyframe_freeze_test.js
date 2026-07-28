/**
 * KEYFRAME TOOLS guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/keyframe_freeze_test.js
 *
 * WHY THIS EXISTS. The user asked for "a tool to remove all keyframes … for a
 * given selection or object", then split it by SCOPE once he saw one built:
 * "remove animation keyframes is not supposed to remove it on every slide, it's
 * just supposed to remove it on this slide … I think that one needs a different
 * name." So there are TWO tools and this suite is the ratchet on both:
 *
 *   MAKE STATIC FROM CURRENT SLIDE (withItemsMadeStatic) — taken literally,
 *     "remove all keyframes" deletes the OBJECT, since slide 0's delta is what
 *     CREATES every item and there is no separate items table. The buildable
 *     operation is a COLLAPSE: keep exactly one full keyframe, holding the values
 *     the item has on the slide the tool was run from. It is written at the START
 *     OF THE CONTIGUOUS RUN OF SLIDES THE ITEM IS VISIBLE ON, and the clearing
 *     covers exactly that run.
 *   REMOVE KEYFRAMES ON THIS SLIDE (withSlideKeyframesRemoved) — clears one
 *     slide's delta entry for the item, so it inherits the previous slide instead.
 *
 * core/document.js's two blocks state the rules and the reasoning.
 *
 * WHAT IT PROVES ABOUT MAKE STATIC:
 *   (1) NOTHING VISIBLE CHANGES WHERE YOU RAN IT — the item still exists and its
 *       folded state on the invoking slide is deep-equal to what it was.
 *   (2) IT IS ACTUALLY STATIC — every slide of the run folds to the same state,
 *       and no slide of it keys the item any more except the run's first.
 *   (3) THE VISIBILITY TIMELINE SURVIVES LEAF-FOR-LEAF. `active` is EXISTENCE,
 *       not animation (core/properties.js PROPS.active); collapsing it would
 *       silently perform a Delete-everywhere or Show-everywhere, and it is also
 *       what the runs are READ OFF — an operation that rewrote it could not say
 *       which slides it was allowed to touch.
 *   (4) AN EQUATION IN FORCE SURVIVES VERBATIM (the raw fold is written back, not
 *       the evaluated one), and an equation the collapse DOES replace is named by
 *       lostEquationKeyframes rather than vanishing quietly.
 *   (5) THE DELETE SENTINEL CANNOT RESURRECT A KEY — a `null` leaf that removed a
 *       key from the fold must not come back when the collapse rewrites the run's
 *       first slide.
 *   (6) IDEMPOTENT + PURE — a second run has nothing to do, and the source
 *       document is never mutated.
 *   (7) THE RESULT IS A CLEAN DOCUMENT — repairedDocument() reports NOTHING about
 *       it, so neither tool can produce a doc the load boundary wants to fix up.
 *   (8) THE SKIPS ARE REPORTED, NOT SWALLOWED — an item created later in the deck,
 *       an orphan, one hidden here, and an already-static one each get a reason.
 *   (9) THE TOOLS ARE WIRED UP — the Keyframes pool group exists, applies to every
 *       registered widget (including THE camera), and names both command entries
 *       web/App.svelte registers.
 *  (10) THE RUN IS THE UNIT — on an item visible 2-5, hidden 6-7, visible 8-10,
 *       running from slide 4 writes at slide 2, flattens 2-5, and leaves 8-10's own
 *       keyframes alone.
 *
 * AND ABOUT REMOVE KEYFRAMES ON THIS SLIDE:
 *  (11) THIS SLIDE INHERITS THE PREVIOUS ONE, no other slide's DELTA is touched,
 *       a later slide that re-keys a property is unaffected for it, and the CREATION
 *       slide is REFUSED (clearing it would delete the widget).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  foldState, itemCreationSlide, visibleRun, itemAnimationKeyframes, lostEquationKeyframes,
  withItemsMadeStatic, repairedDocument, newDocument,
  itemSlideKeyframes, slideEquationKeyframes, withSlideKeyframesRemoved,
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
 * Pure function. A three-slide document whose rect MOVES (x) and CHANGES COLOUR
 * (fill) and is NEVER hidden — so its VISIBLE RUN is the whole deck, which is the
 * ordinary case and the one where Make Static behaves exactly like the deck-wide
 * collapse it started life as. Slide 0 creates it with the rect plugin's real
 * defaults so the document is one repairedDocument() has nothing to say about.
 */
function movingRectDoc(overrides = {}) {
  const rect = { ...registry.get("rect").defaults, type: "rect", x: 10, y: 10, fill: "#ff0000" };
  const tween = { type: "tween", seconds: 1, curve: "smooth", sound: null };
  return {
    meta: { name: "T", slideW: 1280, slideH: 720 },
    slides: [
      { id: "s0", name: "Slide 1", transition: tween, delta: { items: { r: { ...rect, ...overrides } } } },
      { id: "s1", name: "Slide 2", transition: tween, delta: { items: { r: { x: 200, fill: "#00ff00" } } } },
      { id: "s2", name: "Slide 3", transition: tween, delta: { items: { r: { x: 400 } } } },
    ],
  };
}

/**
 * Pure function. THE GAPPED FIXTURE — the acceptance case for "the run is the
 * unit": an eleven-slide deck whose rect is created and visible on slides 2-5,
 * HIDDEN on 6-7, and visible again on 8-10, with `x` keyframed on every slide of
 * the first run and once inside the second. Two runs, so this is the only fixture
 * that can tell "the visible run is the unit" apart from "the deck is the unit".
 */
function gappedRectDoc() {
  const tween = { type: "tween", seconds: 1, curve: "smooth", sound: null };
  const slides = [];
  for (let i = 0; i <= 10; i++) slides.push({ id: `g${i}`, name: `Slide ${i + 1}`, transition: tween, delta: {} });
  slides[2].delta = { items: { r: { ...registry.get("rect").defaults, type: "rect", x: 20 } } };
  slides[3].delta = { items: { r: { x: 30 } } };
  slides[4].delta = { items: { r: { x: 40 } } };
  slides[5].delta = { items: { r: { x: 50 } } };
  slides[6].delta = { items: { r: { active: false } } };
  slides[8].delta = { items: { r: { active: true } } };
  slides[9].delta = { items: { r: { x: 90 } } };
  return { meta: { name: "G", slideW: 1280, slideH: 720 }, slides };
}

/** Pure function. The item's folded `x` on every slide — the one-line summary this
 *  suite compares runs by. undefined where the item does not exist yet. */
const xTrack = (doc, id = "r") => doc.slides.map((_, i) => foldState(doc, i, 1).items?.[id]?.x);

// ── (1) nothing visible changes where you ran it ─────────────────────────────
test("the item survives and its folded state on the INVOKING slide is unchanged", () => {
  for (const from of [0, 1, 2]) {
    const doc = movingRectDoc();
    const before = foldState(doc, from, 1).items.r;
    const { doc: out, madeStatic } = withItemsMadeStatic(doc, from, ["r"]);
    assert.deepEqual(madeStatic, ["r"], `slide ${from}: nothing was made static`);
    const after = foldState(out, from, 1).items.r;
    assert.ok(after, `slide ${from}: the item stopped existing`);
    assert.deepEqual(after, before, `slide ${from}: folded state changed under the collapse`);
  }
});

// ── (2) it is actually static ────────────────────────────────────────────────
test("every slide of the RUN folds to the SAME state, and it is the invoking slide's", () => {
  const doc = movingRectDoc();
  assert.deepEqual(visibleRun(doc, 2, "r"), { start: 0, end: 2 }, "an item that is never hidden runs the whole deck");
  const { doc: out } = withItemsMadeStatic(doc, 2, ["r"]);
  assert.deepEqual(foldState(out, 0, 1).items.r, foldState(out, 1, 1).items.r);
  assert.deepEqual(foldState(out, 1, 1).items.r, foldState(out, 2, 1).items.r);
  // …and it is the slide-2 state that survived (x: 400), not the creation pose.
  assert.equal(foldState(out, 0, 1).items.r.x, 400);
  assert.equal(foldState(out, 0, 1).items.r.fill, "#00ff00");
});

test("only the RUN'S FIRST slide keys the item afterwards", () => {
  const doc = movingRectDoc();
  assert.equal(itemCreationSlide(doc, "r"), 0);
  const { doc: out } = withItemsMadeStatic(doc, 2, ["r"]);
  assert.equal(out.slides[1].delta.items, undefined, "slide 1 still keys the item");
  assert.equal(out.slides[2].delta.items, undefined, "slide 2 still keys the item");
  assert.equal(itemAnimationKeyframes(out, 2, "r").length, 0, "animation keyframes were left behind");
});

test("THE RUN START IS ALWAYS AN ENABLED SLIDE (a disabled one is out of the fold)", () => {
  const doc = movingRectDoc();
  doc.slides[0].enabled = false;
  doc.slides[1].delta.items.r.type = "rect"; // re-created on the first slide that folds
  assert.deepEqual(visibleRun(doc, 2, "r"), { start: 1, end: 2 }, "slide 0 folds to nothing, so it cannot begin a run");
  // Writing the collapsed state into slide 0 would delete the item from the whole
  // document, because a disabled slide's delta is skipped entirely.
  const { doc: out } = withItemsMadeStatic(doc, 2, ["r"]);
  assert.ok(foldState(out, 2, 1).items.r, "the item vanished — the collapse was written into a disabled slide");
  assert.ok(out.slides[1].delta.items.r, "the static state did not land on the run's first slide");
});

// ── (3) the visibility timeline survives leaf-for-leaf ───────────────────────
test("`active` keyframes are untouched on every slide, so visibility is identical", () => {
  const doc = gappedRectDoc();
  const visibility = (d) => d.slides.map((_, i) => foldState(d, i, 1).items?.r?.active);
  const before = visibility(doc);
  const { doc: out } = withItemsMadeStatic(doc, 4, ["r"]);
  assert.deepEqual(visibility(out), before);
  assert.deepEqual(before.slice(5, 9), [undefined, false, false, true], "the fixture stopped exercising the hide/show timeline");
  // The two `active` leaves are STILL the whole of what those slides say.
  assert.deepEqual(out.slides[6].delta.items.r, { active: false });
  assert.deepEqual(out.slides[8].delta.items.r, { active: true });
});

test("HIDDEN on the invoking slide is REFUSED — there is no visible stretch to be static over", () => {
  const doc = movingRectDoc();
  doc.slides[1].delta.items.r.active = false;
  assert.equal(visibleRun(doc, 1, "r"), null);
  const { doc: out, madeStatic, skipped } = withItemsMadeStatic(doc, 1, ["r"]);
  assert.deepEqual(madeStatic, []);
  assert.match(skipped[0].reason, /not visible on slide 1/);
  assert.equal(json(out), json(doc), "a refusal must not rewrite the document");
});

test("an item whose ONLY later keyframes are `active` is already static (the gate says no)", () => {
  const doc = movingRectDoc();
  doc.slides[1].delta.items.r = { active: false };
  doc.slides[2].delta.items.r = { active: true };
  assert.deepEqual(itemAnimationKeyframes(doc, 0, "r"), []);
  const { doc: out, madeStatic, skipped } = withItemsMadeStatic(doc, 0, ["r"]);
  assert.deepEqual(madeStatic, []);
  assert.match(skipped[0].reason, /already static/);
  assert.equal(json(out), json(doc), "a no-op must not rewrite the document");
});

// ── (4) equations ────────────────────────────────────────────────────────────
test("an equation IN FORCE on the invoking slide is written back verbatim", () => {
  const doc = movingRectDoc({ x: "=100 + 5" });
  delete doc.slides[1].delta.items.r.x; // …so the creation equation is what folds through
  delete doc.slides[2].delta.items.r.x;
  assert.deepEqual(lostEquationKeyframes(doc, 2, "r", registry), []);
  const { doc: out } = withItemsMadeStatic(doc, 2, ["r"]);
  assert.equal(out.slides[0].delta.items.r.x, "=100 + 5", "the equation was baked into a number");
});

test("an equation the collapse REPLACES is named (and then really is gone)", () => {
  const doc = movingRectDoc({ x: "=100 + 5" });
  const lost = lostEquationKeyframes(doc, 2, "r", registry);
  assert.deepEqual(lost, [{ slideIndex: 0, path: ["x"], value: "=100 + 5" }]);
  const { doc: out } = withItemsMadeStatic(doc, 2, ["r"]);
  assert.equal(out.slides[0].delta.items.r.x, 400);
});

test("an equation OUTSIDE the run is not rewritten, so it is not reported either", () => {
  // The rect's SECOND run (8-10) carries an equation; running from slide 4 touches
  // only 2-5, so naming it would be a false alarm.
  const doc = gappedRectDoc();
  doc.slides[9].delta.items.r.x = "=99";
  assert.deepEqual(lostEquationKeyframes(doc, 4, "r", registry), []);
  const { doc: out } = withItemsMadeStatic(doc, 4, ["r"]);
  assert.equal(out.slides[9].delta.items.r.x, "=99");
});

test("a COMPUTED default (`self.`-equation) survives verbatim and is not reported lost", () => {
  // rotationAnchor's stored form is "self.anchors.center.x" (core/document.js
  // missingDefaults: computed defaults are resolved at derivation, never
  // materialized). Baking it to a number would silently pin the rotation pivot to
  // wherever the box happened to be — writing the RAW fold back is what prevents it.
  const doc = movingRectDoc({ rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" } });
  assert.deepEqual(lostEquationKeyframes(doc, 2, "r", registry), []);
  const { doc: out } = withItemsMadeStatic(doc, 2, ["r"]);
  assert.deepEqual(out.slides[0].delta.items.r.rotationAnchor, { x: "self.anchors.center.x", y: "self.anchors.center.y" });
});

test("a BARE reference in a numeric slot counts as an equation too (the camera-bind form)", () => {
  const doc = movingRectDoc({ x: "@cam.x" });
  assert.deepEqual(lostEquationKeyframes(doc, 2, "r", registry).map((e) => e.value), ["@cam.x"]);
  // Still in force on slide 0 → running FROM slide 0 keeps it and reports nothing.
  assert.deepEqual(lostEquationKeyframes(doc, 0, "r", registry), []);
});

// ── (5) the delete sentinel cannot resurrect a key ───────────────────────────
test("a key a `null` keyframe removed from the fold does NOT come back", () => {
  const doc = movingRectDoc();
  doc.slides[0].delta.items.r.stroke = "#123456";
  doc.slides[1].delta.items.r.stroke = null; // NONE: delete the key
  assert.equal("stroke" in foldState(doc, 2, 1).items.r, false);
  const { doc: out } = withItemsMadeStatic(doc, 2, ["r"]);
  assert.equal("stroke" in foldState(out, 2, 1).items.r, false, "the run-start stroke survived the collapse");
  assert.equal("stroke" in foldState(out, 0, 1).items.r, false);
});

// ── (6) idempotent + pure ────────────────────────────────────────────────────
test("PURE: the source document is not mutated", () => {
  const doc = movingRectDoc();
  const before = json(doc);
  withItemsMadeStatic(doc, 2, ["r"]);
  assert.equal(json(doc), before);
});

test("IDEMPOTENT: a second run from the same slide has nothing to do", () => {
  const doc = movingRectDoc();
  const { doc: once } = withItemsMadeStatic(doc, 2, ["r"]);
  const { doc: twice, madeStatic } = withItemsMadeStatic(once, 2, ["r"]);
  assert.deepEqual(madeStatic, []);
  assert.equal(json(twice), json(once));
});

test("MULTI-SELECTION: one call covers the whole set, and the items do not interfere", () => {
  const doc = movingRectDoc();
  doc.slides[0].delta.items.q = { ...registry.get("circle").defaults, type: "circle", x: 0 };
  doc.slides[1].delta.items.q = { x: 77 };
  const rBefore = clone(foldState(doc, 1, 1).items.r);
  const qBefore = clone(foldState(doc, 1, 1).items.q);
  const { doc: out, madeStatic } = withItemsMadeStatic(doc, 1, ["r", "q"]);
  assert.deepEqual(madeStatic, ["r", "q"]);
  assert.deepEqual(foldState(out, 1, 1).items.r, rBefore);
  assert.deepEqual(foldState(out, 1, 1).items.q, qBefore);
  assert.equal(foldState(out, 0, 1).items.q.x, 77);
});

// ── (7) the result is a clean document ───────────────────────────────────────
test("repairedDocument() has NOTHING to say about a document either tool produced", () => {
  // Start from a real editor document so the baseline is genuinely clean.
  const base = repairedDocument(newDocument(), registry).doc;
  const rect = { ...registry.get("rect").defaults, type: "rect", x: 10 };
  const doc = clone(base);
  doc.slides.push({ id: "s1", name: "Slide 2", transition: clone(base.slides[0].transition), delta: { items: { r: { x: 300 } } } });
  doc.slides[0].delta.items.r = rect;
  assert.deepEqual(repairedDocument(doc, registry).reports, [], "the fixture itself is not repair-clean");
  const { doc: staticDoc } = withItemsMadeStatic(doc, 1, ["r"]);
  assert.deepEqual(repairedDocument(staticDoc, registry).reports, []);
  const { doc: clearedDoc } = withSlideKeyframesRemoved(doc, 1, ["r"]);
  assert.deepEqual(repairedDocument(clearedDoc, registry).reports, []);
  // …and neither quietly dropped THE CAMERA on the way through.
  for (const d of [staticDoc, clearedDoc])
    assert.ok(Object.values(d.slides[0].delta.items).some((it) => it.type === "camera"), "the camera is gone");
});

test("THE CAMERA can be made static: `purgeable: false` forbids removal, not stillness", () => {
  const base = repairedDocument(newDocument(), registry).doc;
  const cameraId = Object.keys(base.slides[0].delta.items)[0];
  const doc = clone(base);
  doc.slides.push({ id: "s1", name: "Slide 2", transition: clone(base.slides[0].transition), delta: { items: { [cameraId]: { x: 500 } } } });
  const before = clone(foldState(doc, 1, 1).items[cameraId]);
  const { doc: out, madeStatic } = withItemsMadeStatic(doc, 1, [cameraId]);
  assert.deepEqual(madeStatic, [cameraId]);
  assert.deepEqual(foldState(out, 1, 1).items[cameraId], before);
  assert.equal(foldState(out, 0, 1).items[cameraId].x, 500);
  assert.deepEqual(repairedDocument(out, registry).reports, []);
});

// ── (8) the skips are reported, not swallowed ────────────────────────────────
test("an item created LATER in the deck is skipped with its reason", () => {
  const doc = movingRectDoc();
  doc.slides.unshift({ id: "sPre", name: "Slide 0", transition: clone(doc.slides[0].transition), delta: {} });
  const { doc: out, madeStatic, skipped } = withItemsMadeStatic(doc, 0, ["r"]);
  assert.deepEqual(madeStatic, []);
  assert.match(skipped[0].reason, /not visible on slide 0/);
  assert.equal(json(out), json(doc));
});

test("an ORPHAN (no slide sets its type) is skipped with its reason", () => {
  const doc = movingRectDoc();
  delete doc.slides[0].delta.items.r.type;
  const { madeStatic, skipped } = withItemsMadeStatic(doc, 2, ["r"]);
  assert.deepEqual(madeStatic, []);
  assert.match(skipped[0].reason, /never given a type/);
});

// ── (9) the tools are wired up ───────────────────────────────────────────────
test("the Keyframes pool group names BOTH commands web/App.svelte registers, local first", () => {
  const group = TOOL_POOL.find((g) => g.id === "keyframes");
  assert.ok(group, "no `keyframes` group in TOOL_POOL");
  assert.deepEqual(group.rows.map((r) => r.command), ["remove-slide-keyframes", "make-static"]);
  const appSvelte = readFileSync(resolve(here, "../web/App.svelte"), "utf8");
  for (const id of ["remove-slide-keyframes", "make-static"])
    assert.ok(appSvelte.includes(`id: "${id}"`), `web/App.svelte registers no \`${id}\` command`);
  // The pool rows' help/requires ARE the entries' — imported, never transcribed.
  for (const name of ["MAKE_STATIC_HELP", "MAKE_STATIC_REQUIRES", "SLIDE_KEYFRAMES_HELP", "SLIDE_KEYFRAMES_REQUIRES"])
    assert.ok(appSvelte.includes(name), `the command entries re-type ${name} instead of importing it from core/registry.js`);
});

test("THE TITLES OPEN WITH DIFFERENT WORDS, and each states its own SCOPE", () => {
  // The reported defect: "remove animation keyframes is not supposed to remove it
  // on every slide … I think that one needs a different name". The palette is
  // fuzzy-searched over TITLES, so a shared opening would make one query match both
  // and force the reader into the parentheticals.
  const appSvelte = readFileSync(resolve(here, "../web/App.svelte"), "utf8");
  const titleOf = (id) => appSvelte.match(new RegExp(`id: "${id}", title: "([^"]+)"`))?.[1] ?? null;
  const local = titleOf("remove-slide-keyframes");
  const sweeping = titleOf("make-static");
  assert.ok(local && sweeping, `could not read both titles: ${JSON.stringify({ local, sweeping })}`);
  assert.notEqual(local.split(" ")[0], sweeping.split(" ")[0], "both titles open with the same word");
  assert.match(local, /This Slide/, "the local tool's title does not say it is local");
  assert.match(sweeping, /every slide/i, "the sweeping tool's title does not say how far it reaches");
});

test("both tools reach EVERY registered widget, THE camera included", () => {
  const registered = registry.all();
  const unreached = registered.filter((p) => !keyframable(p)).map((p) => p.type);
  assert.deepEqual(unreached, [], `these widgets show no Keyframes group: ${unreached.join(", ")}`);
  for (const p of registered) {
    const group = p.toolGroups.find((g) => g.id === "keyframes");
    assert.ok(group, `${p.type}: no resolved Keyframes group`);
    assert.equal(group.rows.length, 2, `${p.type}: the Keyframes group does not carry both tools`);
  }
  assert.equal(keyframable({ defaults: {} }), false, "the predicate is vacuous — it accepts a stateless plugin too");
});

// ── (10) THE RUN IS THE UNIT (the gapped-fixture acceptance case) ─────────────
test("GAPPED: the static value lands on the RUN'S first slide, not the creation slide", () => {
  const doc = gappedRectDoc();
  assert.deepEqual(visibleRun(doc, 4, "r"), { start: 2, end: 5 });
  assert.deepEqual(visibleRun(doc, 9, "r"), { start: 8, end: 10 }, "the second run must be its own");
  assert.equal(itemCreationSlide(doc, "r"), 2, "in this fixture the first run happens to begin at creation");
  const before = clone(foldState(doc, 4, 1).items.r);
  const { doc: out, madeStatic } = withItemsMadeStatic(doc, 4, ["r"]);
  assert.deepEqual(madeStatic, ["r"]);
  // The slide-4 value (40) is what was written, and it was written on slide 2.
  assert.equal(out.slides[2].delta.items.r.x, 40);
  assert.deepEqual(foldState(out, 4, 1).items.r, before, "the invoking slide moved");
  // The whole first run now folds to one state; slides 3-5 key nothing of their own.
  for (const i of [3, 4, 5]) assert.equal(out.slides[i].delta.items, undefined, `slide ${i} still keys the item`);
  for (const i of [2, 3, 4, 5]) assert.equal(foldState(out, i, 1).items.r.x, 40, `slide ${i} is not static`);
});

test("GAPPED: the SECOND run's own keyframes are untouched, and what it INHERITS moves", () => {
  const doc = gappedRectDoc();
  assert.deepEqual(xTrack(doc), [undefined, undefined, 20, 30, 40, 50, 50, 50, 50, 90, 90]);
  const { doc: out } = withItemsMadeStatic(doc, 4, ["r"]);
  // Slides 8-10 are OUTSIDE the run, so their deltas are byte-identical…
  for (const i of [6, 7, 8, 9, 10]) assert.deepEqual(out.slides[i].delta, doc.slides[i].delta, `slide ${i}'s delta was rewritten`);
  // …and slide 9's own keyframe still decides 9 and 10.
  assert.deepEqual(xTrack(out).slice(9), [90, 90]);
  // THE CONSEQUENCE, ASSERTED RATHER THAN HIDDEN: slide 8 keys no x of its own, so
  // it INHERITS — and what it inherits is now the static value (40, was 50). That is
  // what a delta document does; nothing else in the deck is rewritten to disguise it.
  assert.equal(xTrack(doc)[8], 50);
  assert.equal(xTrack(out)[8], 40);
});

test("GAPPED: running from INSIDE the second run leaves the first one alone", () => {
  const doc = gappedRectDoc();
  const { doc: out, madeStatic } = withItemsMadeStatic(doc, 9, ["r"]);
  assert.deepEqual(madeStatic, ["r"]);
  // Written at slide 8 (the second run's first slide), which is NOT the creation
  // slide — the exact case a deck-wide clear would have destroyed, because clearing
  // slides 2-5 strips the `type` that makes the item exist at all.
  assert.equal(out.slides[8].delta.items.r.x, 90);
  assert.equal(out.slides[8].delta.items.r.active, true, "the leaf that BEGINS the run must survive");
  for (const i of [2, 3, 4, 5]) assert.deepEqual(out.slides[i].delta, doc.slides[i].delta, `slide ${i}'s delta was rewritten`);
  assert.deepEqual(xTrack(out).slice(2, 6), [20, 30, 40, 50], "the first run stopped animating");
  assert.deepEqual(xTrack(out).slice(8), [90, 90, 90]);
  assert.deepEqual(repairedDocument(out, registry).reports, [], "the item was orphaned or damaged");
});

// ── (11) REMOVE KEYFRAMES ON THIS SLIDE ──────────────────────────────────────
test("THIS SLIDE inherits the PREVIOUS one, and no other slide's DELTA is touched", () => {
  const doc = movingRectDoc();
  const prev = clone(foldState(doc, 0, 1).items.r);
  assert.deepEqual(itemSlideKeyframes(doc, 1, "r").map((k) => k.path.join(".")).sort(), ["fill", "x"]);
  const { doc: out, cleared, refused } = withSlideKeyframesRemoved(doc, 1, ["r"]);
  assert.deepEqual([cleared, refused], [["r"], []]);
  assert.deepEqual(foldState(out, 1, 1).items.r, prev, "slide 1 did not inherit slide 0");
  for (const i of [0, 2]) assert.deepEqual(out.slides[i].delta, doc.slides[i].delta, `slide ${i}'s delta was rewritten`);
  assert.equal(out.slides[1].delta.items, undefined, "the emptied entry was not pruned");
});

test("A LATER SLIDE THAT RE-KEYS A PROPERTY IS UNAFFECTED FOR IT; one that INHERITS moves", () => {
  // The acceptance criterion "the fold on the NEXT slide is unchanged" cannot hold in
  // general and must not: removing a keyframe is exactly a change to what everything
  // downstream inherits, which is the point of the tool ("the animation passes
  // through this slide instead of stopping at it"). What IS true is per-property.
  const doc = movingRectDoc();
  const before = { x: xTrack(doc), fill: doc.slides.map((_, i) => foldState(doc, i, 1).items.r.fill) };
  assert.deepEqual(before.x, [10, 200, 400]);
  assert.deepEqual(before.fill, ["#ff0000", "#00ff00", "#00ff00"]);
  const { doc: out } = withSlideKeyframesRemoved(doc, 1, ["r"]);
  // x: slide 2 RE-KEYS it (400), so slide 2 is untouched; slide 1 inherits 10.
  assert.deepEqual(xTrack(out), [10, 10, 400]);
  // fill: slide 2 inherits it, so slide 2 moves with slide 1 back to the creation red.
  assert.deepEqual(out.slides.map((_, i) => foldState(out, i, 1).items.r.fill), ["#ff0000", "#ff0000", "#ff0000"]);
});

test("THE CREATION SLIDE IS REFUSED — clearing it would delete the widget", () => {
  const doc = movingRectDoc();
  assert.equal(itemCreationSlide(doc, "r"), 0);
  const { doc: out, cleared, refused } = withSlideKeyframesRemoved(doc, 0, ["r"]);
  assert.deepEqual(cleared, []);
  assert.match(refused[0].reason, /CREATES it/);
  assert.match(refused[0].reason, /Purge Item/);
  assert.equal(json(out), json(doc), "a refusal must not rewrite the document");
  // And the item is still there, which is the whole reason for the refusal.
  assert.ok(foldState(out, 0, 1).items.r);
});

test("A KEYFRAMED `active` GOES TOO, so a Delete made on this slide is undone", () => {
  // Unlike Make Static, which exempts `active` because it would impose one value on
  // a whole run: here the edit is confined to one slide and the result is
  // INHERITANCE, the item cannot be destroyed (the creation slide is refused), and
  // the inverse is one click of Delete. Leaving it behind would instead leave a
  // filled keyframe on the very slide the user asked to clear.
  const doc = movingRectDoc();
  doc.slides[1].delta.items.r = { active: false };
  assert.equal(foldState(doc, 1, 1).items.r.active, false);
  const { doc: out, cleared } = withSlideKeyframesRemoved(doc, 1, ["r"]);
  assert.deepEqual(cleared, ["r"]);
  assert.equal(foldState(out, 1, 1).items.r.active, undefined, "the Delete on this slide survived");
  assert.equal(foldState(out, 2, 1).items.r.active, undefined);
});

test("NOTHING TO DO is neither cleared nor reported (not every miss is a failure)", () => {
  const doc = movingRectDoc();
  delete doc.slides[1].delta.items;
  const { doc: out, cleared, refused } = withSlideKeyframesRemoved(doc, 1, ["r"]);
  assert.deepEqual([cleared, refused], [[], []]);
  assert.equal(json(out), json(doc));
});

test("an EQUATION on this slide is named before it goes", () => {
  const doc = movingRectDoc();
  doc.slides[1].delta.items.r.x = "=12 + 3";
  assert.deepEqual(slideEquationKeyframes(doc, 1, "r", registry), [{ path: ["x"], value: "=12 + 3" }]);
  // …and nothing is claimed for a slide that keys only plain values.
  assert.deepEqual(slideEquationKeyframes(doc, 2, "r", registry), []);
});

test("PURE + IDEMPOTENT + MULTI-SELECTION, and a mixed selection reports only the refusal", () => {
  const doc = movingRectDoc();
  doc.slides[0].delta.items.q = { ...registry.get("circle").defaults, type: "circle", x: 0 };
  doc.slides[1].delta.items.q = { x: 77 };
  doc.slides[2].delta.items.z = { ...registry.get("circle").defaults, type: "circle", x: 5 };
  const source = json(doc);
  const { doc: out, cleared, refused } = withSlideKeyframesRemoved(doc, 2, ["r", "q", "z"]);
  assert.equal(json(doc), source, "PURE: the source document was mutated");
  // r is keyed on slide 2 → cleared. q is not → silent. z is CREATED there → refused.
  assert.deepEqual(cleared, ["r"]);
  assert.deepEqual(refused.map((f) => f.id), ["z"]);
  const { doc: twice, cleared: again } = withSlideKeyframesRemoved(out, 2, ["r", "q", "z"]);
  assert.deepEqual(again, []);
  assert.equal(json(twice), json(out), "IDEMPOTENT: a second pass rewrote the document");
});

console.log(`\n${passed} keyframe tool tests passed`);
