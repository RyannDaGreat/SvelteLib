/**
 * THE GOVERNING TYPE KEYFRAME (#286) — nearest at-or-before, not the first.
 *
 * R6-6.7 predicted this as its open question: "#creationState's definition (the
 * first slide keying its type) stops being unique once type is keyed on several
 * slides. Decide what it means then — most likely the NEAREST PRECEDING type
 * keyframe, which is what the fold already implies." Making the Widget type row
 * keyframeable (634954c) turned that from hypothetical into reachable.
 *
 * The selection rule is arithmetic over a keyframe index list, so it is tested as
 * such — no app, no browser. The app-side wiring is exercised by the suites that
 * already drive Show All.
 */
import assert from "node:assert/strict";
import { keyframeIndices } from "../core/document.js";

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

/** The rule under test, mirroring web/app.svelte.js #governingTypeState. */
const governing = (keyed, slide) => keyed.filter((i) => i <= slide).pop() ?? keyed[0];

test("the NEAREST PRECEDING keyframe wins — the whole fix", () => {
  const keyed = [0, 5];                       // authored on 0, retyped on 5
  assert.equal(governing(keyed, 0), 0);
  assert.equal(governing(keyed, 4), 0, "before the retype, the original governs");
  assert.equal(governing(keyed, 5), 5, "on the retype slide, the new type governs");
  assert.equal(governing(keyed, 8), 5,
    "AFTER the retype — the old code answered 0 here, which is the silent defect: " +
    "Show All on slide 8 resurrected the widget as its pre-retype type");
});

test("three keyframes select correctly at every slide, not just the ends", () => {
  const keyed = [0, 3, 7];
  assert.deepEqual([0,1,2,3,4,5,6,7,8].map((s) => governing(keyed, s)), [0,0,0,3,3,3,3,7,7]);
});

test("FALLS BACK TO THE FIRST when nothing precedes — never worse than the old code", () => {
  // An item keyed only LATER still has a definite identity, and the first index is
  // exactly what the old [0] always returned, so this case is byte-compatible.
  assert.equal(governing([4, 9], 0), 4);
  assert.equal(governing([4, 9], 3), 4);
  assert.equal(governing([4, 9], 4), 4);
});

test("a SINGLE keyframe behaves exactly as before, everywhere", () => {
  for (const s of [0, 1, 9]) assert.equal(governing([2], s), 2);
});

test("keyframeIndices really is ASCENDING, which the .pop() relies on", () => {
  // The rule takes the LAST of the filtered list; that is only the nearest one if
  // the source is sorted. document.js builds it with forEach over slides in order,
  // so it is — asserted here rather than assumed, because .pop() would silently
  // pick the wrong keyframe if that ever changed.
  const doc = { slides: [
    { delta: { items: { a: { type: "rect" } } } },
    { delta: { items: { a: { x: 1 } } } },
    { delta: { items: { a: { type: "circle" } } } },
  ] };
  const keyed = keyframeIndices(doc, ["items", "a", "type"]);
  assert.deepEqual(keyed, [0, 2]);
  assert.deepEqual([...keyed].sort((p, q) => p - q), keyed, "keyframeIndices must be ascending");
  assert.equal(governing(keyed, 2), 2);
  assert.equal(governing(keyed, 1), 0);
});

console.log(`\n${passed} governing-type tests passed`);
