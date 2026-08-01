/**
 * STOP REORDER — the value-level half of the visual gradient stop bar
 * (web/GradientStopBar.svelte). Plain node, no DOM.
 *
 * WHY THIS EXISTS. A gradient's stop list is DECLARED "sorted"
 * (core/properties.js GRADIENT_STOPS_LIST), and core/lists.js states what that
 * buys: "Editing one element's key past another's simply SWAPS them
 * (canonicalOrder re-sorts), which is what makes a gradient's absolute stop
 * positions behave the way a user expects: drag stop 1 past stop 2 and they
 * trade places." It also states the price, MEASURED: order is load-bearing all
 * the way down, because render_gpu/ir.js normalizeStops maps the array WITHOUT
 * sorting and Skia pins each position to >= the previous one — so an
 * out-of-order stop does not swap, its span COLLAPSES.
 *
 * The bar is the surface where a user drags one stop past another, so it is the
 * surface that must not produce that state. These tests pin the primitive it
 * writes through:
 *
 *   (1) `withElementsOrderedBy` orders the PAIR — the element list AND its
 *       visibility companion — where `canonicalOrder` orders the list alone and
 *       structurally cannot see the companion (arity 2). A hidden stop's flag
 *       must travel with ITS stop across a reorder, or hiding one stop and
 *       dragging another silently hides a third.
 *   (2) It preserves RAW element values across the permutation, so a stop whose
 *       position or colour is an "=" EQUATION keeps the expression — the sort
 *       key comes in from outside precisely so the ordering can be decided by
 *       EVALUATED positions while RAW elements are what move.
 *   (3) Its `indices` remap answers "where did the element I am dragging go",
 *       which is the one thing indexAfterPurge / indexAfterInsert cannot compute
 *       for a reorder (it depends on the values, not just an index).
 *   (4) Replaying the BAR'S OWN drag rule over a stop dragged past its neighbour
 *       yields an ASCENDING list — i.e. the swap the declaration promises — and
 *       the ramp the renderer would consume is the hand-authored swapped one.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/stop_reorder_test.js
 */
import assert from "node:assert/strict";
import {
  canonicalOrder, elementActive, elementFieldValue, visibleElements,
  withElementFieldValue, withElementPurged, withElementsOrderedBy,
} from "../core/lists.js";
import { GRADIENT_STOPS_LIST, RAMP_STOP_ELEMENT, MIN_GRADIENT_STOPS } from "../core/properties.js";

const DECL = GRADIENT_STOPS_LIST;
const EL = RAMP_STOP_ELEMENT;
const RED = "#ff0000", GREEN = "#00ff00", BLUE = "#0000ff";
const three = () => [{ offset: 0, color: RED }, { offset: 0.5, color: GREEN }, { offset: 1, color: BLUE }];

/**
 * Pure function. THE BAR'S DRAG RULE, replayed: the list value for stop `index`
 * moved to position `t`. Mirrors web/GradientStopBar.svelte draggedTo — the RAW
 * element with only its order key replaced, the pair re-ordered by the EVALUATED
 * positions. Kept here as a replay rather than imported because a .svelte module
 * is not importable in bare node; the shapes are pinned side by side in the
 * browser probe (tests/gradient_stop_bar_probe.js), which drives the real one.
 *
 * @example draggedTo([{offset: 0, color: "#ff0000"}, {offset: 1, color: "#0000ff"}], undefined, 0, 0.4).list[0].offset // 0.4
 * @example draggedTo([{offset: 0, color: "#ff0000"}, {offset: 1, color: "#0000ff"}], undefined, 0, 1).indices // [1, 0]
 */
function draggedTo(list, active, index, t) {
  const keys = list.map((el) => Number(elementFieldValue(EL, el, DECL.orderKey)));
  keys[index] = t;
  const moved = list.slice();
  moved[index] = withElementFieldValue(EL, moved[index], DECL.orderKey, t);
  return withElementsOrderedBy({ list: moved, active }, keys);
}

const offsets = (list) => list.map((s) => s.offset);
const colors = (list) => list.map((s) => s.color);

// ── (1) THE PAIR IS ORDERED, NOT JUST THE LIST ───────────────────────────────
{
  // canonicalOrder's own signature is the evidence: it never receives `active`.
  assert.equal(canonicalOrder.length, 2, "canonicalOrder takes (decl, list) — it cannot see the companion");

  // Hide the MIDDLE stop, then drag the FIRST past it. The flag must stay on the
  // green stop, which is now at index 0.
  const before = { list: three(), active: [true, false, true] };
  const after = draggedTo(before.list, before.active, 0, 0.8);
  assert.deepEqual(offsets(after.list), [0.5, 0.8, 1], "the dragged stop landed past its neighbour");
  assert.deepEqual(colors(after.list), [GREEN, RED, BLUE], "and the elements swapped, not their values");
  assert.deepEqual(after.active, [false, true, true], "the HIDDEN flag travelled with the green stop it belongs to");
  assert.deepEqual(
    visibleElements(DECL, after).map((s) => s.color), [RED, BLUE],
    "so the ramp the renderer reads still skips exactly the stop the user hid",
  );

  // The same reorder with the companion left OFF mints no companion — the
  // "never write state nobody asked for" rule the list control already follows.
  assert.equal(draggedTo(three(), undefined, 0, 0.8).active, undefined, "no companion in, no companion out");
}

// ── (2) RAW VALUES SURVIVE THE PERMUTATION (equations included) ──────────────
{
  // Stop 0's position is an EQUATION. It is not the one being dragged; stop 2 is
  // dragged below it. The expression must come out the other side verbatim, at
  // whatever address the reorder gave it.
  const list = [{ offset: "=phase", color: RED }, { offset: 0.5, color: GREEN }, { offset: 1, color: BLUE }];
  const EVALUATED_PHASE = 0.9; // what "=phase" resolves to for this fixture
  const keys = [EVALUATED_PHASE, 0.5, 1];
  const moved = list.slice();
  moved[2] = withElementFieldValue(EL, moved[2], DECL.orderKey, 0.1);
  const out = withElementsOrderedBy({ list: moved, active: undefined }, [...keys.slice(0, 2), 0.1]);

  assert.deepEqual(offsets(out.list), [0.1, 0.5, "=phase"], "the equation is STORED, never stamped over with its value");
  assert.deepEqual(colors(out.list), [BLUE, GREEN, RED], "and it stayed attached to its own stop through the move");
  assert.deepEqual(out.indices, [2, 1, 0], "indices maps every old address to its new one");

  // A COLOUR equation is equally untouched — the write never rebuilds an element,
  // it only replaces the one field the drag moved. Here the equation-coloured
  // stop is the one DRAGGED, past its neighbour, so it changes address AND keeps
  // its expression.
  const withEqColor = [{ offset: 0, color: "=accent" }, { offset: 0.5, color: GREEN }, { offset: 1, color: BLUE }];
  const movedEqColor = draggedTo(withEqColor, undefined, 0, 0.8);
  assert.deepEqual(offsets(movedEqColor.list), [0.5, 0.8, 1], "the equation-coloured stop really moved past its neighbour");
  assert.equal(movedEqColor.list[1].color, "=accent", "a colour equation survives a reorder, at its new address");
  assert.equal(movedEqColor.indices[0], 1, "and indices says where to keep looking for it");
}

// ── (3) THE REMAP IS THE ANSWER TO "WHERE DID MY BEAD GO" ────────────────────
{
  const out = draggedTo(three(), undefined, 0, 0.8);
  assert.equal(out.indices[0], 1, "the dragged stop is now element 1, and the bar keeps marking it");
  // Sitting exactly ON a neighbour is a TIE, and a tie is stable — the dragged
  // stop does not leapfrog a stop it merely reached. Two stops at one position is
  // a legal ramp (a hard colour edge), so this must not be special-cased away.
  const tie = draggedTo(three(), undefined, 0, 0.5);
  assert.deepEqual(offsets(tie.list), [0.5, 0.5, 1], "two stops may share a position — a hard edge");
  assert.deepEqual(colors(tie.list), [RED, GREEN, BLUE], "and the tie keeps the order they were already in");
  assert.equal(tie.indices[0], 0, "so the bead the user is holding has not jumped");
}

// ── (4) THE RESULT IS ALWAYS RENDERABLE — the defect this exists to prevent ──
{
  // Every intermediate position of a full sweep across the whole track, not just
  // the endpoints: the invariant is that the document is valid at EVERY instant
  // of the gesture, because each pointermove stages it.
  const STEPS = 40;
  for (let i = 0; i <= STEPS; i++) {
    const out = draggedTo(three(), undefined, 0, i / STEPS);
    const os = offsets(out.list);
    assert.ok(os.every((o, k) => k === 0 || os[k - 1] <= o), `sweep step ${i}: offsets ascend (${JSON.stringify(os)})`);
    assert.equal(out.list.length, 3, `sweep step ${i}: nothing was lost or duplicated`);
    assert.deepEqual([...colors(out.list)].sort(), [BLUE, GREEN, RED], `sweep step ${i}: the same three colours`);
  }

  // …and the swapped result is what a HAND-AUTHORED swap would be, byte for byte.
  const dragged = draggedTo(three(), undefined, 0, 0.8);
  assert.deepEqual(dragged.list, [{ offset: 0.5, color: GREEN }, { offset: 0.8, color: RED }, { offset: 1, color: BLUE }],
    "a drag past a neighbour produces exactly the list a user would have typed");

  // THE CONTRAST that makes the above non-vacuous: a BARE LEAF write of the same
  // offset — which is what scrubbing the row's own `offset` field does today —
  // leaves the array DESCENDING at the head, the state core/lists.js records as
  // collapsing rather than swapping. Pinned so the difference between the two
  // write shapes is a measured fact and not a claim in a comment.
  const leafWritten = three();
  leafWritten[0] = { ...leafWritten[0], offset: 0.8 };
  assert.deepEqual(offsets(leafWritten), [0.8, 0.5, 1], "a leaf write really does leave it out of order");
  assert.notDeepEqual(offsets(leafWritten), offsets(dragged.list), "so the two write shapes genuinely differ");
  assert.deepEqual(offsets(canonicalOrder(DECL, leafWritten)), [0.5, 0.8, 1], "canonicalOrder is what closes that gap");
}

// ── PURGE: the bar and the row remove a stop the SAME way ────────────────────
{
  const value = { list: three(), active: undefined };
  assert.deepEqual(offsets(withElementPurged(DECL, value, 1).list), [0, 1], "purging the middle stop leaves the ends");
  assert.throws(
    () => withElementPurged(DECL, { list: three().slice(0, 2), active: undefined }, 0),
    /below the declared minimum of 2/,
    "and it refuses at the declared two-stop floor, loudly",
  );
  assert.equal(DECL.minLength, MIN_GRADIENT_STOPS, "the floor the bar's purge button reads is the declaration's own");
  assert.equal(elementActive(undefined, 7), true, "absent companion means visible (the rule the bar draws beads by)");
}

console.log("stop_reorder_test: OK");
