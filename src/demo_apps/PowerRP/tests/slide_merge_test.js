/**
 * MERGE SLIDES — core math.
 * Run: node src/demo_apps/PowerRP/tests/slide_merge_test.js
 *
 * User ruling (2026-08-02): "The one that comes later in the slideshow will have
 * priority. For whatever deltas arise."
 *
 * THE TWO LAWS under test (core/slide_reorder.js withSlidesMerged):
 *   1. fold(merged, earlier)  ==  fold(doc, later)      the pair shows the LATER picture
 *   2. fold(merged, j - 1)    ==  fold(doc, j)          for every j after the pair
 * Law 2 is the interesting one: composition preserves the pair's NET EFFECT, so
 * the rest of the deck is untouched BY CONSTRUCTION — no re-derivation anywhere.
 *
 * Everything else here is the tombstone algebra, which is where a hand-rolled
 * key-wise merge would go wrong, plus the identity decisions.
 */

import assert from "node:assert/strict";
import { newDocument, withNewItem, withNewSlide, keyframed, slideState, withSlideToggled, withSlideRenamed } from "../core/document.js";
import { withSlidesMerged, foldedStates } from "../core/slide_reorder.js";
import { NONE } from "../core/deltas.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/**
 * BOTH LAWS, asserted against the REAL fold (core/document.js slideState) rather
 * than this module's local one — the same discipline slide_reorder_test.js uses,
 * and the reason it catches a divergence between the two.
 */
function assertMergePreservesDeck(before, earlier) {
  const later = earlier + 1;
  const after = withSlidesMerged(before, earlier, later);
  assert.equal(after.slides.length, before.slides.length - 1, "a merge removes exactly one slide");
  // Law 1 — the merged slide shows what the LATER slide showed.
  assert.deepEqual(slideState(after, earlier), slideState(before, later),
    "the merged slide does not show the later slide's picture");
  // Law 1' — everything BEFORE the pair is untouched.
  for (let j = 0; j < earlier; j++)
    assert.deepEqual(slideState(after, j), slideState(before, j), `slide ${j} (before the pair) moved`);
  // Law 2 — every slide AFTER the pair folds byte-identically, one seat earlier.
  for (let j = later + 1; j < before.slides.length; j++)
    assert.deepEqual(slideState(after, j - 1), slideState(before, j),
      `slide ${j} (after the pair) does not look the same after the merge`);
  return after;
}

/**
 * A synthetic deck: 3 items, 4 slides, creations spread across slides, an
 * equation leaf, a list leaf and an active toggle — deliberately the SAME deck
 * tests/slide_reorder_test.js uses, so the two suites exercise one document
 * shape and a divergence between reorder and merge shows up as a difference in
 * results rather than a difference in fixtures.
 */
function sampleDoc() {
  let doc = newDocument();
  let a, b, c;
  [doc, a] = withNewItem(doc, 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, z: 0, active: true, fill: "#f00" });
  [doc] = withNewSlide(doc, 0); // slide 1
  doc = keyframed(doc, 1, ["items", a, "x"], 100);
  doc = keyframed(doc, 1, ["vars", "k"], 3);
  [doc, b] = withNewItem(doc, 1, { type: "circle", x: 5, y: 5, w: 20, h: 20, z: 1, active: true, fill: "=k*2" });
  [doc] = withNewSlide(doc, 1); // slide 2
  doc = keyframed(doc, 2, ["items", a, "active"], false);
  doc = keyframed(doc, 2, ["items", b, "points"], [[0, 0], [1, 1]]);
  [doc] = withNewSlide(doc, 2); // slide 3
  [doc, c] = withNewItem(doc, 3, { type: "rect", x: 9, y: 9, w: 1, h: 1, z: 2, active: true });
  doc = keyframed(doc, 3, ["items", a, "active"], true);
  doc = keyframed(doc, 3, ["items", b, "points"], [[0, 0], [2, 2]]);
  return { doc, a, b, c };
}

// ── THE TWO LAWS, ON A REAL DECK ────────────────────────────────────────────

test("merging any adjacent pair leaves every other slide byte-identical", () => {
  const { doc } = sampleDoc();
  for (let i = 0; i < doc.slides.length - 1; i++) assertMergePreservesDeck(doc, i);
});

test("the merged slide's fold equals the LATER slide's pre-merge fold", () => {
  const { doc } = sampleDoc();
  const after = withSlidesMerged(doc, 1, 2);
  assert.deepEqual(slideState(after, 1), slideState(doc, 2));
});

test("merging into slide 0 still creates everything (no fold enters the pair)", () => {
  const { doc } = sampleDoc();
  const after = assertMergePreservesDeck(doc, 0);
  // Slide 0's delta is what CREATES the document's items; the merged slide 0 must
  // still do that, diffing from the empty state rather than from a predecessor.
  assert.deepEqual(slideState(after, 0), slideState(doc, 1));
  assert.ok(Object.keys(after.slides[0].delta.items).length >= 2, "merged slide 0 must still create its items");
});

test("argument order does not matter — (a,b) and (b,a) merge identically", () => {
  const { doc } = sampleDoc();
  assert.deepEqual(withSlidesMerged(doc, 1, 2), withSlidesMerged(doc, 2, 1));
});

// ── THE TOMBSTONE ALGEBRA ───────────────────────────────────────────────────
// These use bare hand-built documents so the delta under test is visible in the
// assertion. Each is a case where a key-wise "later delta wins" merge differs
// from the truth; the docblock names delete-then-recreate as the proof case.

/**
 * A two-slide-plus-tail deck whose slide 1 and 2 deltas are given verbatim.
 *
 * Slide 0's delta always carries an `items` bag, even when a case does not use
 * one. That is not decoration: `deltaFromFoldDiff` writes an empty `items: {}`
 * branch when the ENTERING fold has no `items` key at all but the outgoing one
 * does, and a real document can never be in that state — slide 0's delta is what
 * creates the items, so the key exists from the first fold onward. A fixture
 * without it would be asserting against a shape the app cannot produce.
 */
function pairDoc(delta0, deltaA, deltaB, tail = {}) {
  return { meta: {}, slides: [
    { id: "s0", name: "Slide 1", delta: { items: {}, ...delta0 } },
    { id: "sA", name: "Slide 2", delta: deltaA },
    { id: "sB", name: "Slide 3", delta: deltaB },
    { id: "s3", name: "Slide 4", delta: tail },
  ] };
}

test("tombstone: create-then-delete nets to NOTHING", () => {
  const doc = pairDoc({}, { items: { q: { type: "rect", x: 1 } } }, { items: { q: NONE } });
  const after = withSlidesMerged(doc, 1, 2);
  assert.deepEqual(after.slides[1].delta, {}, "a create followed by a delete must leave no trace");
  assert.deepEqual(slideState(after, 1), slideState(doc, 2));
});

test("tombstone: delete-then-recreate keeps the recreate AND tombstones what it did not restore", () => {
  // THE PROOF CASE. A destroys q entirely; B builds a fresh one carrying only x.
  // The later picture has NO y — so the merged delta MUST carry `y: NONE`, which
  // neither input delta mentions. A key-wise merge would resurrect y: 2.
  const doc = pairDoc(
    { items: { q: { type: "rect", x: 1, y: 2 } } },
    { items: { q: NONE } },
    { items: { q: { type: "rect", x: 9 } } });
  const after = withSlidesMerged(doc, 1, 2);
  assert.deepEqual(after.slides[1].delta, { items: { q: { x: 9, y: NONE } } });
  assert.deepEqual(slideState(after, 1).items.q, { type: "rect", x: 9 }, "y must NOT come back");
});

test("tombstone: a delete with a silent successor survives as a NONE leaf", () => {
  const doc = pairDoc({ items: { q: { type: "rect", x: 1 } } }, { items: { q: NONE } }, {});
  const after = withSlidesMerged(doc, 1, 2);
  assert.deepEqual(after.slides[1].delta, { items: { q: NONE } });
});

test("tombstone: Delete-keyframe then Show (active false→true) nets to nothing", () => {
  const doc = pairDoc(
    { items: { q: { type: "rect", x: 1, active: true } } },
    { items: { q: { active: false } } },
    { items: { q: { active: true } } });
  assert.deepEqual(withSlidesMerged(doc, 1, 2).slides[1].delta, {});
});

test("later wins PER LEAF — a leaf only the earlier slide touches survives", () => {
  const doc = pairDoc(
    { items: { q: { type: "rect", x: 1, y: 1 } } },
    { items: { q: { x: 5 } } },   // earlier moves x
    { items: { q: { y: 9 } } });  // later moves y, says nothing about x
  assert.deepEqual(withSlidesMerged(doc, 1, 2).slides[1].delta, { items: { q: { x: 5, y: 9 } } });
});

test("later wins on a CONTESTED leaf", () => {
  const doc = pairDoc(
    { items: { q: { type: "rect", x: 1 } } },
    { items: { q: { x: 5 } } },
    { items: { q: { x: 7 } } });
  assert.deepEqual(withSlidesMerged(doc, 1, 2).slides[1].delta, { items: { q: { x: 7 } } });
});

test("a leaf the pair returns to its entering value is not keyframed at all", () => {
  // x: 1 → 5 → 1. The pair's NET effect on x is nil, so the minimal delta omits
  // it — the merge cannot leave a keyframe that says nothing.
  const doc = pairDoc(
    { items: { q: { type: "rect", x: 1 } } },
    { items: { q: { x: 5 } } },
    { items: { q: { x: 1 } } });
  assert.deepEqual(withSlidesMerged(doc, 1, 2).slides[1].delta, {});
});

test("vars compose exactly as items do", () => {
  const doc = pairDoc({ vars: { k: 1, m: 1 } }, { vars: { k: 2 } }, { vars: { m: NONE } });
  const after = withSlidesMerged(doc, 1, 2);
  assert.deepEqual(after.slides[1].delta, { vars: { k: 2, m: NONE } });
  assert.deepEqual(slideState(after, 1).vars, { k: 2 });
});

// ── IDENTITY ────────────────────────────────────────────────────────────────

test("the survivor keeps the EARLIER slide's id, seat and transition", () => {
  const doc = { meta: {}, slides: [
    { id: "s0", name: "Slide 1", delta: {} },
    { id: "sA", name: "Slide 2", transition: { type: "tween", seconds: 3 }, delta: { x: 1 } },
    { id: "sB", name: "Slide 3", transition: { type: "fade", seconds: 9 }, delta: { x: 2 } },
  ] };
  const merged = withSlidesMerged(doc, 1, 2).slides[1];
  assert.equal(merged.id, "sA", "the earlier slide keeps the seat, so it keeps the id");
  // The transition INTO the pair is unchanged by a merge; the later slide's
  // transition was INTERIOR to the pair and the merge deletes that boundary.
  assert.deepEqual(merged.transition, { type: "tween", seconds: 3 });
});

test("an AUTHORED later name wins; a positional default does not", () => {
  const doc = { meta: {}, slides: [
    { id: "sA", name: "Intro", delta: {} },
    { id: "sB", name: "Slide 2", delta: {} },   // positional default for seat 2
  ] };
  assert.equal(withSlidesMerged(doc, 0, 1).slides[0].name, "Intro",
    "a default name must not overwrite an authored one");
  const named = withSlideRenamed(doc, 1, "Punchline");
  assert.equal(withSlidesMerged(named, 0, 1).slides[0].name, "Punchline",
    "later priority: an authored later name wins");
});

test("autoAdvance follows later priority, including its ABSENCE", () => {
  const base = [{ id: "sA", name: "A", delta: {} }, { id: "sB", name: "B", delta: {} }];
  const laterHas = { meta: {}, slides: [base[0], { ...base[1], autoAdvance: 4 }] };
  assert.equal(withSlidesMerged(laterHas, 0, 1).slides[0].autoAdvance, 4);
  // The earlier slide lingers, the later one does not — later priority means the
  // merged slide does not linger either.
  const earlierHas = { meta: {}, slides: [{ ...base[0], autoAdvance: 4 }, base[1]] };
  assert.ok(!("autoAdvance" in withSlidesMerged(earlierHas, 0, 1).slides[0]),
    "the later slide's silence must clear the earlier slide's linger");
});

// ── REFUSALS ────────────────────────────────────────────────────────────────

test("non-adjacent slides are refused loudly", () => {
  const { doc } = sampleDoc();
  assert.throws(() => withSlidesMerged(doc, 0, 2), /not adjacent/);
  assert.throws(() => withSlidesMerged(doc, 1, 1), /not adjacent/);
});

test("out-of-range indices are refused loudly", () => {
  const { doc } = sampleDoc();
  assert.throws(() => withSlidesMerged(doc, -1, 0), /out of range/);
  assert.throws(() => withSlidesMerged(doc, doc.slides.length - 1, doc.slides.length), /out of range/);
});

test("a DISABLED slide is refused — it has no folded picture to merge", () => {
  const { doc } = sampleDoc();
  const off = withSlideToggled(doc, 2);
  assert.throws(() => withSlidesMerged(off, 1, 2), /disabled/);
  assert.throws(() => withSlidesMerged(off, 2, 3), /disabled/);
});

// ── PURITY ──────────────────────────────────────────────────────────────────

test("the input document is not mutated", () => {
  const { doc } = sampleDoc();
  const snapshot = JSON.stringify(doc);
  withSlidesMerged(doc, 1, 2);
  assert.equal(JSON.stringify(doc), snapshot);
});

test("a RUN collapses right-to-left to the run's LAST picture, tail untouched", () => {
  // THE DRAG-ONTO-A-SLIDE DROP'S MATH (web/app.svelte.js mergeSlideRun). It
  // collapses a contiguous run by repeated adjacent merge, taken from the RIGHT
  // so the indices of the not-yet-merged pairs never shift underneath it.
  const { doc } = sampleDoc();
  const run = [1, 2]; // merge slides 2 and 3, leaving slide 4 as the tail
  const wantRunPicture = slideState(doc, run[run.length - 1]);
  const wantTail = slideState(doc, run[run.length - 1] + 1);
  let out = doc;
  for (let i = run[run.length - 1]; i > run[0]; i--) out = withSlidesMerged(out, i - 1, i);
  assert.equal(out.slides.length, doc.slides.length - (run.length - 1));
  assert.deepEqual(slideState(out, 0), slideState(doc, 0), "the slide before the run moved");
  assert.deepEqual(slideState(out, run[0]), wantRunPicture, "the merged run must show the run's LAST picture");
  assert.deepEqual(slideState(out, run[0] + 1), wantTail, "the slide after the run changed");
  assert.equal(out.slides[run[0]].id, doc.slides[run[0]].id, "the run's earliest slide keeps the seat");
});

test("merging every pair down to one slide preserves the LAST slide's picture", () => {
  // The associativity check: repeated merges must land on the final picture,
  // which is what "compose, later wins" means iterated.
  const { doc } = sampleDoc();
  const want = slideState(doc, doc.slides.length - 1);
  let cur = doc;
  while (cur.slides.length > 1) cur = withSlidesMerged(cur, 0, 1);
  assert.deepEqual(slideState(cur, 0), want);
});

console.log(`\nslide_merge_test: ${passed} passed`);
