/**
 * MERGE SLIDES — core math.
 * Run: node src/demo_apps/PowerRP/tests/slide_merge_test.js
 *
 * User ruling (2026-08-02): "The one that comes later in the slideshow will have
 * priority. For whatever deltas arise." — the COMMAND path (Merge Slide Up/Down),
 * and this file's default.
 *
 * Later ruling the same day, for the DRAG gesture only: "When I'm merging two
 * slides, actually I want the one that I am currently dropping onto the other one
 * to take priority. Because it looks to me like I'm physically dropping it on
 * top, so the one that's on top gets the priority." Pinned at the bottom, in both
 * drag directions, alongside the command path's invariance which STILL holds.
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
import { withSlidesMerged, withSlideRunMerged, foldedStates, withSlidesMovedToBoundary } from "../core/slide_reorder.js";
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
  // REPEATED COMMAND-PATH MERGE. This used to be described as the drag-drop's
  // math; since the drop-priority ruling the drop goes through
  // `withSlideRunMerged` with an explicit order instead (pinned below), and what
  // this still pins is that iterating the LATER-WINS pair merge over a run lands
  // on the run's last picture — the property the Merge Slide Up/Down commands
  // compose to when a user runs them repeatedly.
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

// ── DRAG-MERGE: THE DROPPED SLIDE WINS ──────────────────────────────────────
// User ruling (2026-08-02): "When I'm merging two slides, actually I want the one
// that I am currently dropping onto the other one to take priority. Because it
// looks to me like I'm physically dropping it on top, so the one that's on top
// gets the priority." DRAG ONLY — the commands above keep deck order, which the
// last test in this section re-pins so a future edit cannot quietly unify them.

/**
 * `web/app.svelte.js mergeSlideRun`'s ALGORITHM, replicated here so the core
 * math is testable in bare node — the same discipline the "a RUN collapses
 * right-to-left" test above uses for the pre-drop version. If this drifts from
 * the app method, `tests/slide_merge_probe.js` (browser) is what catches it.
 *
 * GATHER IN DECK ORDER at the target's row, then merge in ONE step with an
 * explicit application order: target first, dragged after, so the dragged win and
 * the later of the dragged wins their own collisions. The gather must NOT express
 * the priority — see withSlideRunMerged's docblock for the re-derivation trap.
 */
function dragMerge(doc, dragged, target) {
  const run = [...new Set([...dragged, target])].sort((a, b) => a - b);
  const targetId = doc.slides[target].id;
  let out = doc;
  let block = run;
  if (run[run.length - 1] - run[0] !== run.length - 1) {
    const ids = run.map((i) => doc.slides[i].id);
    out = withSlidesMovedToBoundary(doc, run, target);
    block = ids.map((id) => out.slides.findIndex((s) => s.id === id)).sort((a, b) => a - b);
  }
  const seat = out.slides.findIndex((s) => s.id === targetId);
  const order = [seat, ...block.filter((i) => i !== seat)];
  return { doc: withSlideRunMerged(out, block, { order, seat }), seat: block[0] };
}

/** A five-slide deck whose slides each move ONE shared leaf to their own number. */
function contestedDeck() {
  return { meta: {}, slides: [0, 1, 2, 3, 4].map((i) => ({
    id: `s${i}`, name: `Slide ${i + 1}`,
    transition: { type: "tween", seconds: i },
    delta: i === 0 ? { items: { q: { type: "rect", x: 0, tag: 0 } } } : { items: { q: { x: i } } },
  })) };
}

test("DRAG DOWN (2 onto 5): the dragged slide's value wins, at the target's seat", () => {
  const doc = contestedDeck();
  const { doc: out, seat } = dragMerge(doc, [1], 4);
  assert.equal(out.slides.length, 4);
  assert.equal(slideState(out, seat).items.q.x, 1, "the DRAGGED slide 2's x must win, not the target's");
  assert.equal(out.slides[seat].id, "s4", "the merged slide sits at the DROP TARGET's seat");
  assert.deepEqual(out.slides[seat].transition, { type: "tween", seconds: 4 },
    "the seat keeps its own arrival identity");
});

test("DRAG UP (5 onto 2): the dragged slide's value wins, at the target's seat", () => {
  const doc = contestedDeck();
  const { doc: out, seat } = dragMerge(doc, [4], 1);
  assert.equal(slideState(out, seat).items.q.x, 4, "the DRAGGED slide 5's x must win");
  assert.equal(out.slides[seat].id, "s1", "the merged slide sits at the DROP TARGET's seat");
  assert.deepEqual(out.slides[seat].transition, { type: "tween", seconds: 1 });
});

test("the two drag directions DISAGREE — that is the whole ruling", () => {
  const doc = contestedDeck();
  const down = dragMerge(doc, [1], 4).doc;
  const up = dragMerge(doc, [4], 1).doc;
  assert.notDeepEqual(down, up,
    "dragging 2 onto 5 and 5 onto 2 must now differ; they were byte-identical before the drop ruling");
});

test("non-colliding leaves still UNION — priority is per leaf under the drag too", () => {
  const doc = { meta: {}, slides: [
    { id: "s0", name: "Slide 1", delta: { items: { q: { type: "rect", x: 0, y: 0 } } } },
    { id: "s1", name: "Slide 2", delta: { items: { q: { x: 1 } } } },      // dragged: moves x
    { id: "s2", name: "Slide 3", delta: { items: { q: { y: 2 } } } },      // target: moves y
  ] };
  const { doc: out, seat } = dragMerge(doc, [1], 2);
  assert.deepEqual(slideState(out, seat).items.q, { type: "rect", x: 1, y: 2 },
    "the target's uncontested y survives beside the dragged x");
});

test("slides OUTSIDE the merge keep their exact appearance", () => {
  // The gather is the appearance-preserving reorder, so every slide that is not a
  // member of the run still shows exactly what it showed — the bystanders BETWEEN
  // the dragged row and its target included, wherever the gather parked them.
  const doc = contestedDeck();
  const { doc: out } = dragMerge(doc, [1], 4);
  for (const id of ["s0", "s2", "s3"]) {
    const wasAt = doc.slides.findIndex((s) => s.id === id);
    const nowAt = out.slides.findIndex((s) => s.id === id);
    assert.notEqual(nowAt, -1, `bystander ${id} vanished`);
    assert.deepEqual(slideState(out, nowAt), slideState(doc, wasAt), `bystander ${id} changed appearance`);
  }
});

test("MULTI-DRAG: all dragged beat the target, later of the dragged beats earlier", () => {
  const doc = contestedDeck();          // slides 2 and 4 dragged onto slide 1
  const { doc: out, seat } = dragMerge(doc, [1, 3], 0);
  assert.equal(slideState(out, seat).items.q.x, 3,
    "among the dragged, the LATER (slide 4) wins; both beat the target");
  assert.equal(out.slides[seat].id, "s0", "the drop target keeps the seat");
});

test("the COMMAND path is UNCHANGED — later wins, both directions agree", () => {
  // The earlier ruling stands for Merge Slide Up/Down. `withSlidesMerged` with no
  // options is that path, and it is direction-blind by construction.
  const doc = contestedDeck();
  assert.deepEqual(withSlidesMerged(doc, 1, 2), withSlidesMerged(doc, 2, 1));
  assert.equal(slideState(withSlidesMerged(doc, 1, 2), 1).items.q.x, 2, "the LATER slide's x wins");
  assert.equal(withSlidesMerged(doc, 1, 2).slides[1].id, "s1", "and the EARLIER slide keeps the seat");
});

test("priority: earlier reverses the contested leaf and nothing else", () => {
  const doc = contestedDeck();
  const later = withSlidesMerged(doc, 1, 2);
  const earlier = withSlidesMerged(doc, 1, 2, { priority: "earlier" });
  assert.equal(slideState(later, 1).items.q.x, 2);
  assert.equal(slideState(earlier, 1).items.q.x, 1);
  assert.equal(earlier.slides[1].id, "s1", "seat defaults to earlier regardless of priority");
});

test("seat: later hands the survivor the LATER slide's id and arrival", () => {
  const doc = contestedDeck();
  const out = withSlidesMerged(doc, 1, 2, { seat: "later" });
  assert.equal(out.slides[1].id, "s2");
  assert.deepEqual(out.slides[1].transition, { type: "tween", seconds: 2 });
  assert.equal(out.slides.length, 4, "the survivor still occupies the EARLIER index — a row is spliced out");
});

test("an unknown priority or seat is refused loudly", () => {
  const doc = contestedDeck();
  assert.throws(() => withSlidesMerged(doc, 1, 2, { priority: "dragged" }), /priority must be/);
  assert.throws(() => withSlidesMerged(doc, 1, 2, { seat: "target" }), /seat must be/);
});

test("under priority: earlier an AUTHORED earlier name wins", () => {
  const doc = { meta: {}, slides: [
    { id: "sA", name: "Punchline", delta: {} },
    { id: "sB", name: "Slide 2", delta: {} },
  ] };
  assert.equal(withSlidesMerged(doc, 0, 1, { priority: "earlier" }).slides[0].name, "Punchline");
  // A winner whose name is its OWN seat's positional default is unauthored, so
  // the fallback stands — and the fallback is the name already correct for the
  // index the survivor occupies, which is the EARLIER slide's, in both directions.
  const winnerUnnamed = { meta: {}, slides: [
    { id: "sA", name: "Slide 1", delta: {} },
    { id: "sB", name: "Kicker", delta: {} },
  ] };
  assert.equal(withSlidesMerged(winnerUnnamed, 0, 1, { priority: "earlier" }).slides[0].name, "Slide 1",
    "an unauthored winner leaves the survivor's seat name in place");
});

console.log(`\nslide_merge_test: ${passed} passed`);
