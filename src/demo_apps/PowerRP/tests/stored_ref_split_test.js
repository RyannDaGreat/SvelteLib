/**
 * THE STORED-ID INVARIANT guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/stored_ref_split_test.js
 *
 * WHY THIS EXISTS. A stored item reference is "@<itemId>[_<anchorId>].<path>",
 * with no delimiter marking where the id ends. Two split rules coexisted and
 * disagreed:
 *
 *   STORED side  — parseStoredRef / storedRefItemId split at the FIRST "_".
 *   DISPLAY side — resolveRef looks the whole head up as a SLUG first, and only
 *                  then splits at the LAST "_" (slugs are snake_case and DO
 *                  contain underscores).
 *
 * They are not the same namespace, so neither rule is wrong on its own. What was
 * wrong is that the WRITER used one and every READER used the other, with
 * nothing enforcing the precondition that makes them agree. Measured at
 * 3c071cd, for an item whose id is "Do_it":
 *
 *   displayToStored("= do_it_tl.x")  ->  "= @Do_it_tl.x"     (writer: LAST "_")
 *   parseStoredRef("@Do_it_tl.x")    ->  itemId "Do"          (reader: FIRST "_")
 *   storedToDisplay("@Do_it_tl.x")   ->  "@Do_it_tl.x"        (never converts back)
 *   withItemRefsRemapped("= @Do_it_tl.x", {Do_it -> AAA})
 *                                    ->  unchanged, external ["Do"]
 *
 * i.e. a reference the app itself wrote points at a DIFFERENT item, silently.
 * Nothing can produce such an id today (uuid() is base-16/base-36), which is
 * exactly why it needed a gate rather than a bug report — core/shatter.js's
 * synthetic part keys were the first thing to reach it and dodged it by banning
 * the character locally.
 *
 * WHAT IT PROVES:
 *   (1) the two split rules AGREE for every id/anchor the app can actually
 *       produce — derived from uuid() and from every registered plugin's
 *       anchors(), not from a hand-listed sample;
 *   (2) writing a reference to an id that breaks the invariant now FAILS LOUDLY
 *       at the mint seam (storedItemRef), in all four places one is written;
 *   (3) the seam every paste and duplicate runs through (withItemRefsRemapped)
 *       refuses such an id on BOTH sides of the map, OUTSIDE its
 *       not-an-equation catch — the catch is what would re-silence it;
 *   (4) the split itself is DRY: parseStoredRef and storedRefItemId agree by
 *       construction because they call one splitStoredRefHead.
 */

import assert from "node:assert/strict";
import {
  splitStoredRefHead, storedItemRef, storedRefItemId, parseStoredRef, resolveRef,
  slugMap, displayToStored, storedToDisplay, withItemRefsRemapped,
} from "../core/expressions.js";
import { uuid } from "../core/document.js";
import { allPlugins } from "../plugins/index.js";

const UUID_SAMPLES = 500; // enough that a 1-in-36 forbidden character would show
// A probe state broad enough that every plugin's anchors() runs: a box, a
// polyline's points, and an endpoint widget's from/to.
const ANCHOR_PROBE = { x: 0, y: 0, w: 100, h: 50, points: [[0, 0], [10, 10]], text: "x", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } };

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Query. Every anchor id every registered plugin declares for the probe state. */
function declaredAnchorIds() {
  const ids = new Set();
  for (const p of allPlugins) {
    if (typeof p.anchors !== "function") continue;
    let list;
    try { list = p.anchors({ ...ANCHOR_PROBE, type: p.type }); } catch { continue; } // a plugin needing richer state is covered by its own suite
    for (const a of list ?? []) ids.add(String(a.id));
  }
  return [...ids];
}

// ── (1) the two rules agree over the namespaces the app can produce ───────────

test("uuid() never mints an id the stored grammar cannot read back", () => {
  for (let i = 0; i < UUID_SAMPLES; i++) {
    const id = uuid();
    assert.doesNotThrow(() => storedItemRef(id, ".x"), `uuid() produced ${JSON.stringify(id)}`);
  }
});

test("STORED and DISPLAY splits agree for every real (itemId, anchorId) pair", () => {
  const anchorIds = declaredAnchorIds();
  assert.ok(anchorIds.length > 8, `expected the standard bbox anchors at least, got ${anchorIds.length}`);
  const itemId = uuid();
  const state = { items: { [itemId]: { type: "rect", name: "Box" } }, vars: {} };
  const slugs = slugMap(state);
  for (const anchorId of anchorIds) {
    const stored = storedItemRef(itemId, `_${anchorId}.x`);
    // Reader A: the token parser. Reader B: the id extractor. Writer: the
    // display grammar, round-tripped through the same token.
    assert.deepEqual(parseStoredRef(stored), { kind: "anchor", itemId, anchorId, coord: "x" }, stored);
    assert.equal(storedRefItemId(stored), itemId, stored);
    assert.equal(displayToStored(`box_${anchorId}.x`, state), stored, `display box_${anchorId}.x`);
    assert.equal(storedToDisplay(stored, state), `box_${anchorId}.x`, `round trip of ${stored}`);
    assert.deepEqual(resolveRef(`box_${anchorId}.x`, slugs), { kind: "anchor", itemId, anchorId, coord: "x" }, stored);
  }
});

test("the STORED grammar gives the \"_\" to the ANCHOR — that is which namespace pays", () => {
  // Which of the two namespaces gives up the character is the whole design
  // decision, so it is pinned rather than left to the next reader to infer.
  assert.deepEqual(splitStoredRefHead("ab12cd34_top_left"), { itemId: "ab12cd34", anchorId: "top_left" });
  assert.deepEqual(parseStoredRef("@ab12cd34_top_left.y"), { kind: "anchor", itemId: "ab12cd34", anchorId: "top_left", coord: "y" });
});

test("KNOWN BOUND: the DISPLAY grammar cannot READ an underscored anchor id, though it writes one", () => {
  // Measured, and the mirror image of the defect above: storedToDisplay emits
  // "box_top_left.x", and typing that same string back throws. No registered
  // plugin declares such an anchor (test 2 sweeps all of them and would go red
  // first), so this is a latent bound, not a live bug — recorded here so the
  // author who adds `top_left` finds the sentence instead of the symptom.
  // The display side cannot do better without a delimiter: a slug is snake_case,
  // so "box_top_left" is equally readable as a lone item named "Box top left".
  const state = { items: { ab12cd34: { type: "rect", name: "Box" } }, vars: {} };
  assert.equal(storedToDisplay("@ab12cd34_top_left.x", state), "box_top_left.x", "written happily");
  assert.throws(() => displayToStored("box_top_left.x", state), /Unknown reference/, "and unreadable");
  assert.equal(displayToStored("box_tm.x", state), "@ab12cd34_tm.x", "an underscore-free anchor round-trips");
});

// ── (2) writing an illegal id fails loudly, at every mint site ────────────────

test("storedItemRef REFUSES an id that would read back as a different item", () => {
  assert.throws(() => storedItemRef("Do_it", ".x"), /cannot be referenced/);
  assert.throws(() => storedItemRef("_leading"), /cannot be referenced/);
  assert.throws(() => storedItemRef(""), /cannot be referenced/);
  assert.throws(() => storedItemRef(null), /cannot be referenced/);
  assert.doesNotThrow(() => storedItemRef("ab12cd34", "_tm.x"));
});

test("displayToStored refuses rather than minting the ambiguous token (all three of its mint sites)", () => {
  const state = { items: { Do_it: { type: "circle", name: "Do it" }, ok: { type: "circle", name: "Ok" } }, vars: {} };
  assert.throws(() => displayToStored("do_it.x", state), /cannot be referenced/, "property ref");
  assert.throws(() => displayToStored("do_it_tl.x", state), /cannot be referenced/, "anchor ref");
  assert.throws(() => displayToStored("closest_to_rim(do_it, ok).x", state), /cannot be referenced/, "widget argument");
  // The legal item in the same document is unaffected — the refusal is per-id.
  assert.equal(displayToStored("ok.x", state), "@ok.x");
});

// ── (3) the paste/duplicate seam ──────────────────────────────────────────────

test("withItemRefsRemapped refuses an illegal id on BOTH sides of the map", () => {
  assert.throws(() => withItemRefsRemapped("@a.x", new Map([["Do_it", "z"]])), /cannot be referenced/, "source id");
  assert.throws(() => withItemRefsRemapped("@a.x", new Map([["a", "New_id"]])), /cannot be referenced/, "clone id");
  assert.deepEqual(withItemRefsRemapped("@a.x", new Map([["a", "z"]])), { src: "@z.x", external: [] });
});

test("the refusal is OUTSIDE the not-an-equation catch (which would re-silence it)", () => {
  // A source that does not tokenize is returned verbatim and silently, by
  // design. If the id check lived inside that try, an illegal map would take
  // the same silent path for every source, which is the original defect.
  assert.throws(() => withItemRefsRemapped("this is not an equation", new Map([["Do_it", "z"]])), /cannot be referenced/);
  assert.deepEqual(withItemRefsRemapped("this is not an equation", new Map([["a", "z"]])), { src: "this is not an equation", external: [] });
});

// ── (4) one split rule, not two ───────────────────────────────────────────────

test("parseStoredRef and storedRefItemId agree BY CONSTRUCTION (one splitStoredRefHead)", () => {
  for (const token of ["@ab12cd34.x", "@ab12cd34_tm.y", "@ab12cd34_top_left.x", "@a.w"])
    assert.equal(parseStoredRef(token).itemId, storedRefItemId(token), token);
  assert.equal(storedRefItemId("@ab12cd34"), "ab12cd34", "bare widget argument: no property to parse");
  assert.equal(storedRefItemId("speed"), null);
  assert.equal(storedRefItemId("self.w"), null);
});

console.log(`\n${passed} stored-id invariant tests passed.`);
