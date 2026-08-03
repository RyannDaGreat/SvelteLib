/**
 * COPY PROPERTIES — the time-transport law and its corners.
 * Run: node src/demo_apps/PowerRP/tests/copy_properties_test.js
 *
 * THE LAW under test (core/item_properties_clipboard.js header):
 *   copy item X's fold on slide s, paste on slide d
 *     ⟹  fold(D', d, X) == fold(D, s, X),  and nothing else changes.
 * Everything here is a corner of that one law, plus the two rulings that shape
 * it: minimal keyframes, and "paste behaves as normal" for the clone payload.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KEYBINDING_DEFAULTS, KEYBINDING_LABELS } from "../core/shortcut_entries.js";
import { newDocument, withNewItem, withNewSlide, keyframed, slideState, withItemPurged } from "../core/document.js";
import { applied } from "../core/deltas.js";
import {
  itemPropertiesPayload, partitionPurged, purgedRefusal, itemPropertiesDelta,
} from "../core/item_properties_clipboard.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The paste, as the app performs it: merge the transport delta into slide d. */
function pasted(doc, destIndex, payload) {
  const delta = itemPropertiesDelta(payload, slideState(doc, destIndex));
  const slides = doc.slides.map((s, i) =>
    i === destIndex ? { ...s, delta: applied(s.delta, delta) } : s);
  return { ...doc, slides };
}

/** A 3-slide deck with one rect that moves and changes colour along the way. */
function sampleDoc() {
  let doc = newDocument();
  let a, b;
  [doc, a] = withNewItem(doc, 0, { type: "rect", x: 10, y: 20, w: 5, h: 5, z: 0, active: true, fill: "#f00" });
  [doc, b] = withNewItem(doc, 0, { type: "rect", x: 99, y: 99, w: 1, h: 1, z: 1, active: true, fill: "#00f" });
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 1, ["items", a, "x"], 200);
  doc = keyframed(doc, 1, ["items", a, "fill"], "#0f0");
  [doc] = withNewSlide(doc, 1);
  doc = keyframed(doc, 2, ["items", a, "y"], 400);
  return { doc, a, b };
}

// ── THE TRANSPORT LAW ────────────────────────────────────────────────────────

test("copy on slide 0, paste on slide 2 → the item's fold on 2 equals its fold on 0", () => {
  const { doc, a } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 0), [a]);
  const after = pasted(doc, 2, payload);
  assert.deepEqual(slideState(after, 2).items[a], slideState(doc, 0).items[a],
    "the pasted item does not look like what was copied");
});

test("copy on a LATER slide, paste on an EARLIER one — transport runs both directions", () => {
  const { doc, a } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 2), [a]);
  const after = pasted(doc, 0, payload);
  assert.deepEqual(slideState(after, 0).items[a], slideState(doc, 2).items[a]);
});

test("nothing else changes: the OTHER item, and the OTHER slides, are untouched", () => {
  const { doc, a, b } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 0), [a]);
  const after = pasted(doc, 2, payload);
  assert.deepEqual(slideState(after, 2).items[b], slideState(doc, 2).items[b], "the unselected item moved");
  assert.deepEqual(slideState(after, 0), slideState(doc, 0), "slide 0 changed");
  assert.deepEqual(slideState(after, 1), slideState(doc, 1), "slide 1 changed");
});

test("multiple items transport in one delta", () => {
  const { doc, a, b } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 0), [a, b]);
  const after = pasted(doc, 2, payload);
  assert.deepEqual(slideState(after, 2).items[a], slideState(doc, 0).items[a]);
  assert.deepEqual(slideState(after, 2).items[b], slideState(doc, 0).items[b]);
});

// ── MINIMALITY: unchanged properties gain NO keyframe ────────────────────────

test("minimal diff — only the properties that actually differ are keyframed", () => {
  const { doc, a } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 0), [a]);
  // Slide 2 differs from slide 0 in x (200 vs 10), y (400 vs 20) and fill.
  const delta = itemPropertiesDelta(payload, slideState(doc, 2));
  assert.deepEqual(Object.keys(delta.items[a]).sort(), ["fill", "x", "y"],
    "a property that already agreed was needlessly keyframed");
});

test("pasting onto the slide it was copied from is a NO-OP delta (no undo-worthy edit)", () => {
  const { doc, a } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 1), [a]);
  assert.deepEqual(itemPropertiesDelta(payload, slideState(doc, 1)), {},
    "an identical fold produced a delta");
});

test("equations transport verbatim as opaque leaves, not as their evaluated numbers", () => {
  let doc = newDocument();
  let a;
  [doc, a] = withNewItem(doc, 0, { type: "rect", x: "=1+2", y: 0, w: 5, h: 5, z: 0, active: true });
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 1, ["items", a, "x"], 50);
  const payload = itemPropertiesPayload(slideState(doc, 0), [a]);
  assert.equal(itemPropertiesDelta(payload, slideState(doc, 1)).items[a].x, "=1+2");
});

test("arrays are whole leaves — a copied point list transports intact", () => {
  let doc = newDocument();
  let a;
  [doc, a] = withNewItem(doc, 0, { type: "poly", pts: [1, 2, 3], x: 0, y: 0, z: 0, active: true });
  [doc] = withNewSlide(doc, 0);
  doc = keyframed(doc, 1, ["items", a, "pts"], [9]);
  const payload = itemPropertiesPayload(slideState(doc, 0), [a]);
  const after = pasted(doc, 1, payload);
  assert.deepEqual(slideState(after, 1).items[a].pts, [1, 2, 3]);
});

// ── `active` RIDES ALONG: a hidden item comes back ───────────────────────────

test("an item HIDDEN at the destination is restored by the paste (active is in the fold)", () => {
  const { doc: base, a } = sampleDoc();
  const doc = keyframed(base, 2, ["items", a, "active"], false);
  assert.equal(slideState(doc, 2).items[a].active, false, "precondition: hidden on slide 2");
  const payload = itemPropertiesPayload(slideState(doc, 0), [a]);
  const after = pasted(doc, 2, payload);
  assert.equal(slideState(after, 2).items[a].active, true, "the item did not come back");
  assert.deepEqual(slideState(after, 2).items[a], slideState(doc, 0).items[a]);
});

test("hidden is NOT purged — a hidden item is a valid destination, never refused", () => {
  const { doc: base, a } = sampleDoc();
  const doc = keyframed(base, 2, ["items", a, "active"], false);
  const payload = itemPropertiesPayload(slideState(doc, 0), [a]);
  assert.deepEqual(partitionPurged(payload, slideState(doc, 2)), { surviving: [a], purged: [] });
});

// ── PURGED ITEMS ARE REFUSED, BY NAME ────────────────────────────────────────

test("a PURGED item is partitioned out, and the survivors still apply", () => {
  const { doc, a, b } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 0), [a, b]);
  const after = withItemPurged(doc, b);
  const split = partitionPurged(payload, slideState(after, 2));
  assert.deepEqual(split, { surviving: [a], purged: [b] });
  // The surviving item still transports; the purged one is never resurrected.
  const done = pasted(after, 2, payload);
  assert.deepEqual(slideState(done, 2).items[a], slideState(doc, 0).items[a]);
  assert.equal(slideState(done, 2).items[b], undefined, "a purged item was recreated by paste");
});

test("the refusal sentence NAMES the purged items and says what happened to the rest", () => {
  const partial = purgedRefusal(["ab12"], 2);
  assert.match(partial, /ab12/, "the refusal does not name the item");
  assert.match(partial, /1 copied widget no longer exists/);
  assert.match(partial, /the other 2 were pasted/);
  const total = purgedRefusal(["ab12", "cd34"], 0);
  assert.match(total, /2 copied widgets no longer exist/);
  assert.match(total, /nothing was pasted/);
  assert.match(total, /ab12, cd34/);
});

// ── PAYLOAD SHAPE / KIND DISPATCH ────────────────────────────────────────────

test("the payload is its OWN kind — powerrp_item_props, never the clone key", () => {
  const { doc, a } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 0), [a]);
  assert.ok(payload.powerrp_item_props, "missing the properties key");
  assert.equal(payload.powerrp_items, undefined, "a properties payload must not read as a clone payload");
  assert.deepEqual(payload.powerrp_item_props[a], slideState(doc, 0).items[a]);
});

test("the payload is a DEEP COPY — mutating the document cannot alter what was copied", () => {
  const { doc, a } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 0), [a]);
  const snapshot = JSON.parse(JSON.stringify(payload));
  slideState(doc, 0).items[a].x = 12345; // a rogue consumer mutating the folded state
  assert.deepEqual(payload, snapshot, "the payload aliased document state");
});

test("an id with no state on the copy slide captures nothing (no empty entry)", () => {
  const { doc, a } = sampleDoc();
  const payload = itemPropertiesPayload(slideState(doc, 0), [a, "never-existed"]);
  assert.deepEqual(Object.keys(payload.powerrp_item_props), [a]);
});

// ── WIDGET-COPY PASTE IS UNCHANGED ───────────────────────────────────────────
//
// The ruling is that adding a kind must not disturb the one that was there:
// "paste behaves as normal, because after all if we copy something different,
// paste will still do it". The dispatch lives in web/app.svelte.js's
// #insertClipboardPayload, which is private AND DOM-bound (localStorage, the
// server clipboard, $state), so it cannot be called from bare node. What CAN be
// pinned here — and is the thing that would actually break — is that the clone
// branch still comes FIRST and still routes to the same clone home, so a
// powerrp_items payload never reaches the new code at all.

test("the clone branch is still first and still routes to the clone home", () => {
  const src = readFileSync(new URL("../web/app.svelte.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("#insertClipboardPayload(payload) {"));
  const dispatch = body.slice(0, body.indexOf("\n  }\n"));
  assert.ok(dispatch.includes("if (payload.powerrp_items) {"),
    "the clone payload is no longer the first branch");
  assert.ok(dispatch.includes("this.#cloneStatesIntoSlide(payload.powerrp_items)"),
    "the clone payload no longer routes to the canonical clone home");
  assert.ok(dispatch.indexOf("powerrp_items") < dispatch.indexOf("powerrp_item_props"),
    "the properties branch precedes the clone branch — a clone payload could be captured by it");
});

test("copy-properties is bound, surfaced and labelled — the chord is not orphaned", () => {
  const entry = KEYBINDING_DEFAULTS.find((e) => e.command === "copy-properties");
  assert.ok(entry, "no shortcut entry for copy-properties");
  assert.deepEqual(entry.keys, ["Cmd", "Shift", "C"], "not the chord the user asked for");
  assert.equal(entry.when, "editSelection", "the chord must not be live without a selection");
  // A registered chord with no HintBar label does not exist to the user, and
  // toShortcutEntries throws on the gap — assert it directly so the reason is
  // named here rather than surfacing as a stack trace in another suite.
  assert.ok(KEYBINDING_LABELS["copy-properties"], "the chord has no HintBar label");
  const toolbar = readFileSync(new URL("../web/Toolbar.svelte", import.meta.url), "utf8");
  assert.match(toolbar, /\["copy-item", "copy-properties", "paste"\]/,
    "the button is not beside Copy in the toolbar group");
});

console.log(`\ncopy_properties: ${passed} passed`);
