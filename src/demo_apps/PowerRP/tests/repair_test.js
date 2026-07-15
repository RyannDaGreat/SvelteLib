/**
 * Orphaned-item repair tests (bare node, no framework — suite conventions).
 *
 * THE BUG (user hit it live): deleting an item's CREATION slide leaves its
 * later property keyframes orphaned; the fold materializes a typeless item
 * ({x: 99}) and evaluateState/derive crash with 'Unknown widget type
 * "undefined"', bricking the whole app. Repair = drop orphans LOUDLY at the
 * load/mutation boundary (core stays strict).
 */

import assert from "node:assert/strict";
import {
  newDocument, withNewItem, withNewSlide, keyframed, unkeyframed, withSlideDeleted,
  withSlideToggled, foldState, orphanedItems, withOrphanedItemsDropped,
  missingDefaults, withMissingDefaultsFilled,
} from "../core/document.js";
import { deriveRenderTree } from "../core/derive.js";
import { sceneIR } from "../render_gpu/ports.js";
import { evaluateState } from "../core/expressions.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());
const KNOWN = new Set(registry.all().map((p) => p.type));

/** The producer: item created on slide 1, keyframed on slide 2, creation slide deleted. */
function orphanedDoc() {
  let doc = newDocument(); // slide 0 holds the default camera's creation
  const [d1, id] = withNewItem(doc, 0, { type: "rect", x: 10, y: 10, w: 50, h: 50, active: true });
  const [d2] = withNewSlide(d1, 0);
  const d3 = keyframed(d2, 1, ["items", id, "x"], 99);
  return [withSlideDeleted(d3, 0), id];
}

test("producer: deleting the creation slide orphans the item", () => {
  const [doc, id] = orphanedDoc();
  assert.deepEqual(foldState(doc, 0, 1).items[id], { x: 99 }); // typeless
  const orphans = orphanedItems(doc, KNOWN);
  // Exactly one orphan: the rect (its slide-2 keyframe survives typeless).
  // The camera vanishes ENTIRELY (keyframes only lived on the deleted slide)
  // — not an orphan; the app's repaired() re-ensures it via withCameraEnsured.
  assert.deepEqual(orphans.map((o) => o.id), [id]);
  assert.ok(orphans[0].reason.includes("no type"));
});

test("unrepaired fold crashes evaluation (the strict core is the safety net)", () => {
  const [doc] = orphanedDoc();
  assert.throws(() => evaluateState(foldState(doc, 0, 1), registry), /Unknown widget type "undefined"/);
});

test("repair drops the orphan and evaluation survives", () => {
  const [doc, id] = orphanedDoc();
  const { doc: fixed, dropped } = withOrphanedItemsDropped(doc, KNOWN);
  assert.equal(dropped.length, 1);
  const state = foldState(fixed, 0, 1);
  assert.equal(state.items?.[id], undefined); // items key itself may be gone (doc emptied)
  evaluateState(state, registry); // must not throw
});

test("unknown plugin type is dropped with a naming reason", () => {
  let doc = newDocument();
  doc = keyframed(doc, 0, ["items", "w1"], { type: "wombat", x: 0 });
  const orphans = orphanedItems(doc, KNOWN);
  assert.deepEqual(orphans, [{ id: "w1", reason: 'unknown type "wombat"' }]);
});

test("a DISABLED creation slide is a view state, not an orphan — kept", () => {
  let doc = newDocument();
  const [d1, id] = withNewItem(doc, 0, { type: "rect", x: 1, y: 1, w: 5, h: 5, active: true });
  const disabled = withSlideToggled(d1, 0);
  assert.equal(orphanedItems(disabled, KNOWN).some((o) => o.id === id), false);
});

test("clean documents pass through untouched and idempotently", () => {
  const doc = newDocument();
  const first = withOrphanedItemsDropped(doc, KNOWN);
  assert.deepEqual(first.dropped, []);
  const again = withOrphanedItemsDropped(first.doc, KNOWN);
  assert.deepEqual(again.dropped, []);
});

test("partial typed item (missing w) is reported and filled from plugin defaults", () => {
  // The user's second live crash: type present, geometry absent — canvas2D
  // silently drew nothing, the strict IR builders throw on w: undefined.
  let doc = newDocument();
  doc = keyframed(doc, 0, ["items", "p1"], { type: "rect", x: 5, y: 6, active: true });
  const report = missingDefaults(doc, registry);
  const p1 = report.find((r) => r.id === "p1");
  assert.ok(p1.missing.some((m) => m.path.join(".") === "w"));
  const { doc: fixed, filled } = withMissingDefaultsFilled(doc, registry);
  assert.equal(filled.length, 1);
  const state = evaluateState(foldState(fixed, 0, 1), registry).state;
  assert.equal(typeof state.items.p1.w, "number");
  sceneIR(deriveRenderTree(state, registry)); // must not throw
  assert.deepEqual(withMissingDefaultsFilled(fixed, registry).filled, []); // idempotent
});

test("a null (delete-sentinel) write of a required key still counts as missing", () => {
  let doc = newDocument();
  const [d1, id] = withNewItem(doc, 0, { type: "rect", x: 1, y: 1, w: 10, h: 10, active: true });
  const nulled = keyframed(d1, 0, ["items", id, "w"], null); // author deleted w
  assert.ok(missingDefaults(nulled, registry).find((r) => r.id === id).missing.some((m) => m.path.join(".") === "w"));
});

test("complete creations (the normal path) report nothing", () => {
  let doc = newDocument();
  const rectDefaults = registry.get("rect").defaults;
  const [d1] = withNewItem(doc, 0, { ...rectDefaults, active: true });
  assert.deepEqual(missingDefaults(d1, registry), []);
});

console.log(`\n${passed} repair tests passed`);
