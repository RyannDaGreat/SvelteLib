/**
 * debug_storage_test.js — plain node, no DOM. Covers the PURE half of
 * web/debugStorage.js: row labeling, sorting, subtotaling, the grand-total
 * report shape, the estimate-delta sentence, and the per-keyspace asset
 * grouping. The `gather*` I/O functions (CacheStorage, indexedDB.databases())
 * need a browser and are covered by tests/debug_storage_probe.js instead.
 *
 * Run: node src/demo_apps/PowerRP/tests/debug_storage_test.js
 */

import assert from "node:assert/strict";
import { assetsByKeyspace, biggestFirst, documentRowsFromLocalDocs, estimateDeltaLine, inventoryReport, resolveInitialPage, rowLabel, STORAGE_GROUPS, summarizeGroup } from "../web/debugStorage.js";
import { humanReadableFileSize } from "../web/fileSize.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

test("rowLabel passes an ordinary project name through unchanged", () => {
  assert.equal(rowLabel("RobotSim"), "RobotSim");
});

test("rowLabel marks the draft keyspace so it is never mistaken for a real project", () => {
  assert.equal(rowLabel("~draft/current"), "~draft/current (unsaved draft)");
});

test("biggestFirst sorts descending by bytes and is stable on ties", () => {
  const rows = [{ name: "a", bytes: 10 }, { name: "b", bytes: 90 }, { name: "c", bytes: 90 }, { name: "d", bytes: 1 }];
  assert.deepEqual(biggestFirst(rows).map((r) => r.name), ["b", "c", "a", "d"]);
});

test("biggestFirst does not mutate its input", () => {
  const rows = [{ name: "a", bytes: 1 }, { name: "b", bytes: 2 }];
  const sorted = biggestFirst(rows);
  assert.notEqual(sorted, rows);
  assert.equal(rows[0].name, "a"); // original order untouched
});

test("summarizeGroup sorts and sums in one shape", () => {
  const g = summarizeGroup([{ name: "logo.png", bytes: 8000 }, { name: "clip.mp4", bytes: 92000 }]);
  assert.deepEqual(g.rows.map((r) => r.name), ["clip.mp4", "logo.png"]);
  assert.equal(g.subtotal, 100000);
});

test("summarizeGroup of an empty group is a real zero, not an absent group", () => {
  assert.deepEqual(summarizeGroup([]), { rows: [], subtotal: 0 });
});

test("inventoryReport groups in STORAGE_GROUPS order regardless of input key order", () => {
  const inv = inventoryReport({
    caches: [{ name: "shell", bytes: 500 }],
    documents: [{ name: "RobotSim", bytes: 4000 }],
    assets: [{ name: "RobotSim/logo.png", bytes: 8000 }],
  });
  assert.deepEqual(inv.groups.map((g) => g.id), [...STORAGE_GROUPS]);
  assert.equal(inv.groups.find((g) => g.id === "documents").subtotal, 4000);
  assert.equal(inv.groups.find((g) => g.id === "renderings").subtotal, 0); // never gathered — honest zero
  assert.equal(inv.grandTotal, 4000 + 8000 + 500);
});

test("inventoryReport treats a group absent from rowsByGroup as empty, not an error", () => {
  const inv = inventoryReport({});
  assert.equal(inv.groups.length, STORAGE_GROUPS.length);
  assert.ok(inv.groups.every((g) => g.subtotal === 0 && g.rows.length === 0));
  assert.equal(inv.grandTotal, 0);
});

test("estimateDeltaLine reports both numbers when the estimate is supported", () => {
  const line = estimateDeltaLine(12000, { usage: 20000, quota: 1e9, supported: true }, humanReadableFileSize);
  assert.equal(line, "Inventory counts 11.7KB; the browser estimates 19.5KB in use (browsers round deliberately).");
});

test("estimateDeltaLine says so honestly when the estimate is unsupported", () => {
  const line = estimateDeltaLine(12000, { supported: false }, humanReadableFileSize);
  assert.equal(line, "Inventory counts 11.7KB; the browser storage estimate is unavailable here.");
});

test("documentRowsFromLocalDocs sizes by JSON byte length and labels the draft", () => {
  const rows = documentRowsFromLocalDocs([
    { name: "RobotSim", doc: { meta: { name: "RobotSim" }, slides: [] } },
    { name: "~draft/current", doc: { meta: { name: "Untitled" }, slides: [{ id: "s1" }] } },
  ]);
  assert.equal(rows[0].name, "RobotSim");
  assert.equal(rows[0].bytes, new Blob([JSON.stringify({ meta: { name: "RobotSim" }, slides: [] })]).size);
  assert.equal(rows[1].name, "~draft/current (unsaved draft)");
});

test("assetsByKeyspace unions per-project totals AND keeps individual files, biggest first", () => {
  const grouped = assetsByKeyspace([
    { project: "A", name: "x.png", bytes: 100 },
    { project: "A", name: "y.png", bytes: 50 },
    { project: "~draft/current", name: "z.mp4", bytes: 900 },
  ]);
  const a = grouped.find((g) => g.project === "A");
  const draft = grouped.find((g) => g.project === "~draft/current");
  assert.equal(a.bytes, 150);
  assert.deepEqual(a.files.map((f) => f.name), ["x.png", "y.png"]); // biggest first
  assert.equal(draft.bytes, 900);
  assert.deepEqual(draft.files.map((f) => f.name), ["z.mp4"]);
});

test("assetsByKeyspace of an empty asset list is an empty array, not an error", () => {
  assert.deepEqual(assetsByKeyspace([]), []);
});

test("resolveInitialPage resumes a stored page that still exists", () => {
  assert.equal(resolveInitialPage("storage", [{ id: "storage" }, { id: "network" }]), "storage");
});

test("resolveInitialPage falls back to the first page for a removed/unknown stored id", () => {
  assert.equal(resolveInitialPage("removed-tool", [{ id: "storage" }, { id: "network" }]), "storage");
});

test("resolveInitialPage falls back to the first page when nothing is stored yet", () => {
  assert.equal(resolveInitialPage(null, [{ id: "storage" }]), "storage");
});

console.log(`\ndebug_storage_test: ${passed} passed`);
