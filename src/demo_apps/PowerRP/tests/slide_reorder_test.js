/**
 * Appearance-preserving slide reorder — core math.
 * Run: node src/demo_apps/PowerRP/tests/slide_reorder_test.js
 *
 * THE ACCEPTANCE LAW under test (core/slide_reorder.js header):
 *   fold(reorder(doc, P), j)  ==  fold(doc, P[j])   for every j
 * i.e. after a reorder every slide LOOKS exactly as it did; only order changed.
 * Everything else here is a corner of that one law.
 */

import assert from "node:assert/strict";
import { newDocument, withNewItem, withNewSlide, keyframed, slideState, withSlideToggled } from "../core/document.js";
import {
  deltaFromFoldDiff, foldedStates, checkedPermutation, reorderedSlides,
  movedSlidePreservingLook, duplicateKeyframes, simplifyDuplicateKeyframes,
  withSlidesMovedToBoundary, slideClipboardPayload, withSlidesPasted,
} from "../core/slide_reorder.js";
import { applied, deepEqual } from "../core/deltas.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** THE law, asserted against the REAL fold (core/document.js slideState). */
function assertLooksIdentical(before, after, order) {
  order.forEach((oldIndex, j) => {
    assert.deepEqual(
      slideState(after, j), slideState(before, oldIndex),
      `slide at new index ${j} (was ${oldIndex}) does not look the same`);
  });
}

/** A synthetic deck: 3 items, 4 slides, creations spread across slides. */
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

// ── deltaFromFoldDiff (the reuse seam) ───────────────────────────────────────

test("deltaFromFoldDiff is minimal, recursive, and round-trips through applied()", () => {
  assert.deepEqual(deltaFromFoldDiff({ x: 1, y: 2 }, { x: 5, y: 2 }), { x: 5 });
  assert.deepEqual(deltaFromFoldDiff({ x: 1, y: 2 }, { x: 1 }), { y: null }); // NONE
  assert.deepEqual(deltaFromFoldDiff({}, { items: { a: { x: 1 } } }), { items: { a: { x: 1 } } });
  assert.deepEqual(deltaFromFoldDiff({ a: 1 }, { a: 1 }), {}); // unchanged → omitted
  // Recursion: one changed leaf inside an item writes ONE leaf, not the item.
  assert.deepEqual(
    deltaFromFoldDiff({ items: { a: { x: 1, w: 9 } } }, { items: { a: { x: 2, w: 9 } } }),
    { items: { a: { x: 2 } } });
  // Arrays are WHOLE leaves (never a sparse per-index patch, which would merge
  // element-wise into a base of a different length).
  assert.deepEqual(deltaFromFoldDiff({ p: [1, 2] }, { p: [1, 3] }), { p: [1, 3] });
  assert.deepEqual(deltaFromFoldDiff({ p: [1, 2] }, { p: [1, 2] }), {});
  // Equations are opaque string leaves.
  assert.deepEqual(deltaFromFoldDiff({ x: "=a.x" }, { x: "=a.x" }), {});
  assert.deepEqual(deltaFromFoldDiff({ x: "=a.x" }, { x: "=a.y" }), { x: "=a.y" });
  assert.deepEqual(deltaFromFoldDiff({ x: 5 }, { x: "=a.y" }), { x: "=a.y" });
  // Round trip on a real deck's consecutive folds.
  const { doc } = sampleDoc();
  const folds = foldedStates(doc);
  for (let i = 1; i < folds.length; i++)
    assert.deepEqual(applied(folds[i - 1], deltaFromFoldDiff(folds[i - 1], folds[i])), folds[i]);
  // Output is deep-copied: mutating it cannot reach back into the folds.
  const d = deltaFromFoldDiff({}, { items: { a: { p: [1, 2] } } });
  d.items.a.p.push(3);
  assert.deepEqual(folds[0].items === undefined, false); // folds untouched (sanity)
});

test("foldedStates agrees with core slideState, disabled slides included", () => {
  const { doc } = sampleDoc();
  const folds = foldedStates(doc);
  doc.slides.forEach((_, i) => assert.deepEqual(folds[i], slideState(doc, i)));
  const off = withSlideToggled(doc, 2);
  foldedStates(off).forEach((f, i) => assert.deepEqual(f, slideState(off, i)));
  assert.deepEqual(foldedStates(off)[2], foldedStates(off)[1]); // skipped delta
});

test("checkedPermutation refuses anything that is not a bijection", () => {
  assert.deepEqual(checkedPermutation([2, 0, 1], 3), [2, 0, 1]);
  assert.throws(() => checkedPermutation([0, 0], 2), /bijection/);
  assert.throws(() => checkedPermutation([0, 1], 3), /2 entries for 3 slides/);
  assert.throws(() => checkedPermutation([0, 3, 1], 3), /bijection/);
});

// ── The acceptance law ───────────────────────────────────────────────────────

test("EVERY permutation of a 4-slide deck leaves every slide looking identical", () => {
  const { doc } = sampleDoc();
  const perms = [];
  const build = (rest, acc) => {
    if (!rest.length) return perms.push(acc);
    rest.forEach((v, i) => build([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, v]));
  };
  build([0, 1, 2, 3], []);
  assert.equal(perms.length, 24);
  for (const p of perms) assertLooksIdentical(doc, reorderedSlides(doc, p), p);
});

test("identity permutation preserves folds AND every slide's identity fields", () => {
  const { doc } = sampleDoc();
  const same = reorderedSlides(doc, [0, 1, 2, 3]);
  assertLooksIdentical(doc, same, [0, 1, 2, 3]);
  doc.slides.forEach((s, i) => {
    assert.equal(same.slides[i].id, s.id);
    assert.equal(same.slides[i].name, s.name);
    assert.deepEqual(same.slides[i].transition, s.transition);
  });
});

test("slide identity (id/name/transition/enabled/autoAdvance) travels with the fold", () => {
  const { doc: base } = sampleDoc();
  const doc = {
    ...base,
    slides: base.slides.map((s, i) => ({ ...s, name: `N${i}`, autoAdvance: i })),
  };
  const order = [3, 1, 0, 2];
  const out = reorderedSlides(doc, order);
  order.forEach((oldIndex, j) => {
    assert.equal(out.slides[j].id, doc.slides[oldIndex].id);
    assert.equal(out.slides[j].name, `N${oldIndex}`);
    assert.equal(out.slides[j].autoAdvance, oldIndex);
  });
});

test("CREATION TRAVELS: a later slide moved to index 0 creates the items it shows", () => {
  const { doc, a, b, c } = sampleDoc();
  // Slide 3 (which shows all three items; c is born there) becomes slide 0.
  const order = [3, 0, 1, 2];
  const out = reorderedSlides(doc, order);
  assertLooksIdentical(doc, out, order);
  const born = out.slides[0].delta.items;
  for (const id of [a, b, c]) {
    assert.ok(born[id], `item ${id} must be CREATED by the new slide 0`);
    assert.equal(typeof born[id].type, "string", "creation carries the type");
  }
  // And the new slide 0 evaluates to exactly the old slide 3's picture.
  assert.deepEqual(slideState(out, 0), slideState(doc, 3));
});

test("active:false travels, and an item absent from a later fold is DELETED (NONE)", () => {
  const { doc, a } = sampleDoc();
  // Old slide 2 hides `a`; move it to the front, then old slide 0 follows.
  const order = [2, 0, 1, 3];
  const out = reorderedSlides(doc, order);
  assertLooksIdentical(doc, out, order);
  assert.equal(slideState(out, 0).items[a].active, false);
  assert.equal(slideState(out, 1).items[a].active, true);
  // The new slide 1 (old slide 0) shows only `a` + camera, so the items old
  // slide 2 showed and it does not must be removed by a NONE leaf.
  const nones = Object.entries(out.slides[1].delta.items ?? {}).filter(([, v]) => v === null);
  assert.ok(nones.length >= 1, "an item that ceases to exist is deleted, not left over");
});

test("vars and per-element list properties survive a reorder byte-identically", () => {
  const { doc, b } = sampleDoc();
  const order = [1, 3, 0, 2];
  const out = reorderedSlides(doc, order);
  assertLooksIdentical(doc, out, order);
  assert.equal(slideState(out, 0).vars.k, 3);
  assert.deepEqual(slideState(out, 1).items[b].points, [[0, 0], [2, 2]]);
  assert.equal(slideState(out, 1).items[b].fill, "=k*2"); // equation stored, not baked
});

test("a DISABLED slide keeps its delta verbatim; the ENABLED slides still obey the law", () => {
  const { doc: base } = sampleDoc();
  const doc = withSlideToggled(base, 2); // slide 2 disabled
  const order = [2, 3, 0, 1];
  const out = reorderedSlides(doc, order);
  assert.deepEqual(out.slides[0].delta, doc.slides[2].delta); // verbatim
  assert.equal(out.slides[0].enabled, false);
  // THE LIMIT, asserted rather than glossed: a disabled slide contributes
  // nothing to any fold, so it has no picture OF ITS OWN — it shows whatever its
  // predecessor shows, and moving it changes its predecessor. The law therefore
  // covers the ENABLED slides only, and it does hold for all of them.
  order.forEach((oldIndex, j) => {
    if (doc.slides[oldIndex].enabled === false) return;
    assert.deepEqual(slideState(out, j), slideState(doc, oldIndex));
  });
  // And the disabled slide is transparent, exactly as it was: it equals its
  // (new) predecessor, or the empty state when it lands first.
  assert.deepEqual(slideState(out, 0), {});
});

// ── movedSlidePreservingLook (what moveSlide calls) ──────────────────────────

test("move up/down changes ONLY the order — the user-reported regression", () => {
  const { doc } = sampleDoc();
  for (const [index, offset, order] of [
    [2, -1, [0, 2, 1, 3]],
    [1, +1, [0, 2, 1, 3]],
    [3, -3, [3, 0, 1, 2]],
    [0, +3, [1, 2, 3, 0]],
  ]) {
    const out = movedSlidePreservingLook(doc, index, offset);
    assert.equal(out.slides[order.indexOf(index)].id, doc.slides[index].id);
    assertLooksIdentical(doc, out, order);
  }
});

test("a clamped move is a no-op and returns the SAME document object", () => {
  const { doc } = sampleDoc();
  assert.equal(movedSlidePreservingLook(doc, 0, -1), doc);
  assert.equal(movedSlidePreservingLook(doc, 3, +1), doc);
  assert.equal(movedSlidePreservingLook(doc, 1, 0), doc);
});

test("down-then-up round-trips to the same FOLDS (and the same slide order)", () => {
  const { doc } = sampleDoc();
  const round = movedSlidePreservingLook(movedSlidePreservingLook(doc, 1, +1), 2, -1);
  assert.deepEqual(round.slides.map((s) => s.id), doc.slides.map((s) => s.id));
  assertLooksIdentical(doc, round, [0, 1, 2, 3]);
});

// ── simplifyDuplicateKeyframes ───────────────────────────────────────────────

test("duplicate keyframes are found, counted, removed — folds unchanged, idempotent", () => {
  const { doc: base, a } = sampleDoc();
  // Re-state values slide 1 already folded to: x:100 (set on slide 1) and the
  // camera-independent w:10 (inherited from slide 0). Both are no-ops.
  let doc = keyframed(base, 2, ["items", a, "x"], 100);
  doc = keyframed(doc, 2, ["items", a, "w"], 10);
  doc = keyframed(doc, 3, ["vars", "k"], 3); // already 3 since slide 1
  const found = duplicateKeyframes(doc);
  assert.equal(found.length, 3);
  assert.deepEqual(found.map((f) => f.slideIndex), [2, 2, 3]);
  const { document: simple, count } = simplifyDuplicateKeyframes(doc);
  assert.equal(count, 3);
  doc.slides.forEach((_, i) => assert.deepEqual(slideState(simple, i), slideState(doc, i)));
  assert.equal(simplifyDuplicateKeyframes(simple).count, 0); // idempotent
  // Emptied object nodes are pruned rather than left as {}.
  assert.equal(simple.slides[3].delta.vars, undefined);
});

test("a real change is never simplified away; slide 0 and disabled slides are exempt", () => {
  const { doc } = sampleDoc();
  assert.deepEqual(duplicateKeyframes(doc), []);
  assert.equal(simplifyDuplicateKeyframes(doc).document, doc); // same object when nothing to do
  // Slide 0's creation delta is exempt even though it diffs against {}.
  assert.equal(duplicateKeyframes(doc).some((f) => f.slideIndex === 0), false);
  // A disabled slide's delta is outside the fold: never inspected.
  const off = withSlideToggled(keyframed(doc, 2, ["vars", "k"], 3), 2);
  assert.deepEqual(duplicateKeyframes(off).filter((f) => f.slideIndex === 2), []);
  // A NONE leaf deleting an already-absent key IS redundant.
  const ghost = keyframed(doc, 1, ["items", "nosuchitem"], null);
  assert.deepEqual(duplicateKeyframes(ghost), [{ slideIndex: 1, path: ["items", "nosuchitem"] }]);
});

test("reorder output is already simplified (its deltas hold no no-op keyframes)", () => {
  const { doc } = sampleDoc();
  for (const order of [[3, 2, 1, 0], [1, 0, 3, 2], [2, 3, 0, 1]])
    assert.deepEqual(duplicateKeyframes(reorderedSlides(doc, order)), [],
      `permutation ${order} synthesized a redundant keyframe`);
});

// ── Block move (the drag-to-reorder drop) ────────────────────────────────────

test("withSlidesMovedToBoundary moves a contiguous block and preserves every look", () => {
  const { doc } = sampleDoc();
  const ids = doc.slides.map((s) => s.id);
  // Slides 1+2 dropped at the end (boundary 4).
  const moved = withSlidesMovedToBoundary(doc, [1, 2], 4);
  assert.deepEqual(moved.slides.map((s) => s.id), [ids[0], ids[3], ids[1], ids[2]]);
  assertLooksIdentical(doc, moved, [0, 3, 1, 2]);
});

test("withSlidesMovedToBoundary takes a NON-contiguous selection and closes it up", () => {
  const { doc } = sampleDoc();
  const ids = doc.slides.map((s) => s.id);
  // Slides 0 and 3 dropped before slide 2 → they become adjacent, in doc order.
  const moved = withSlidesMovedToBoundary(doc, [3, 0], 2);
  assert.deepEqual(moved.slides.map((s) => s.id), [ids[1], ids[0], ids[3], ids[2]]);
  assertLooksIdentical(doc, moved, [1, 0, 3, 2]);
});

test("withSlidesMovedToBoundary: dropping into a block's own gap is the SAME object", () => {
  const { doc } = sampleDoc();
  assert.equal(withSlidesMovedToBoundary(doc, [1, 2], 1), doc);
  assert.equal(withSlidesMovedToBoundary(doc, [1, 2], 3), doc); // the far edge of the same gap
  assert.equal(withSlidesMovedToBoundary(doc, [], 2), doc);
  assert.throws(() => withSlidesMovedToBoundary(doc, [9], 0), /out of range/);
  assert.throws(() => withSlidesMovedToBoundary(doc, [0], 5), /boundary 5 out of range/);
});

// ── Slide clipboard (copy / paste / duplicate) ───────────────────────────────

/** A deterministic id minter, so a paste's ids are assertable. */
function idMinter(prefix) {
  let n = 0;
  return () => `${prefix}${n++}`;
}

test("paste reproduces the copied slides' LOOK and leaves every other slide alone", () => {
  const { doc } = sampleDoc();
  const payload = slideClipboardPayload(doc, [2, 3]);
  const { document: out, indices } = withSlidesPasted(doc, 0, payload, idMinter("p"));
  assert.deepEqual(indices, [1, 2]);
  assert.equal(out.slides.length, 6);
  // The pasted pair looks exactly like the copied pair.
  assert.deepEqual(slideState(out, 1), slideState(doc, 2));
  assert.deepEqual(slideState(out, 2), slideState(doc, 3));
  // Every ORIGINAL slide still looks like itself (indices shifted by the block).
  assert.deepEqual(slideState(out, 0), slideState(doc, 0));
  [1, 2, 3].forEach((i) => assert.deepEqual(slideState(out, i + 2), slideState(doc, i)));
});

test("paste mints FRESH ids and carries name/transition verbatim", () => {
  const { doc } = sampleDoc();
  const payload = slideClipboardPayload(doc, [1]);
  const { document: out } = withSlidesPasted(doc, 1, payload, idMinter("fresh"));
  assert.equal(out.slides[2].id, "fresh0");
  assert.notEqual(out.slides[2].id, doc.slides[1].id);
  assert.equal(out.slides[2].name, doc.slides[1].name);
  assert.deepEqual(out.slides[2].transition, doc.slides[1].transition);
});

test("duplicate (copy + paste after itself) is appearance-identical on both rows", () => {
  const { doc } = sampleDoc();
  const { document: out } = withSlidesPasted(doc, 2, slideClipboardPayload(doc, [2]), idMinter("d"));
  assert.deepEqual(slideState(out, 3), slideState(doc, 2)); // the copy
  assert.deepEqual(slideState(out, 2), slideState(doc, 2)); // the original
  assert.deepEqual(slideState(out, 4), slideState(doc, 3)); // the slide after is untouched
});

test("paste at the TOP (afterIndex -1) synthesizes a CREATION delta", () => {
  const { doc } = sampleDoc();
  const { document: out, indices } = withSlidesPasted(doc, -1, slideClipboardPayload(doc, [3]), idMinter("t"));
  assert.deepEqual(indices, [0]);
  assert.deepEqual(slideState(out, 0), slideState(doc, 3));
  doc.slides.forEach((_, i) => assert.deepEqual(slideState(out, i + 1), slideState(doc, i)));
});

test("a pasted DISABLED slide keeps its delta verbatim and stays outside the fold", () => {
  const { doc: base } = sampleDoc();
  const doc = withSlideToggled(base, 2);
  const payload = slideClipboardPayload(doc, [2]);
  assert.deepEqual(payload.slides[0].disabledDelta, doc.slides[2].delta);
  const { document: out } = withSlidesPasted(doc, 0, payload, idMinter("x"));
  assert.equal(out.slides[1].enabled, false);
  assert.deepEqual(out.slides[1].delta, doc.slides[2].delta);
  // It contributes nothing, so slide 1 shows what slide 0 shows, and the deck
  // downstream is unchanged.
  assert.deepEqual(slideState(out, 1), slideState(out, 0));
  doc.slides.forEach((_, i) => assert.deepEqual(slideState(out, i + 1), slideState(doc, i)));
});

test("an empty payload is a no-op; a malformed one throws", () => {
  const { doc } = sampleDoc();
  assert.equal(withSlidesPasted(doc, 0, { slides: [] }, idMinter("z")).document, doc);
  assert.throws(() => withSlidesPasted(doc, 0, null, idMinter("z")), /no slides array/);
  assert.throws(() => slideClipboardPayload(doc, [7]), /no slide at index 7/);
});

console.log(`\n${passed} slide-reorder tests passed`);
