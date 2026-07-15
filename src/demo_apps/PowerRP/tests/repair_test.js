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
  missingDefaults, withMissingDefaultsFilled, legacyKeyRenames, withLegacyKeysRenamed,
  repairedDocument, defaultCameraState,
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

test("unrepaired typeless folds evaluate cleanly and derive to nothing (imaginary-slide semantics)", () => {
  // SUPERSEDED behavior: this used to assert a crash ('Unknown widget type
  // "undefined"'). The imaginary-slide semantics fix made typeless-in-fold a
  // DEFINED state (not yet created → skipped), so even an unrepaired orphan
  // can never brick the app; the repair below remains as data hygiene.
  const [doc, id] = orphanedDoc();
  const { state, errors } = evaluateState(foldState(doc, 0, 1), registry);
  assert.equal(errors.size, 0);
  assert.equal(deriveRenderTree(state, registry).some((n) => n.itemId === id), false);
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

test("computed (self.-equation) defaults are NEVER injected into old docs", () => {
  // Opus1 review finding #1: rotationAnchor defaults are supplied by
  // derive.worldTransform's fallback — a pre-round-11 doc must load with
  // ZERO missing-defaults repairs for them (no console spam, no doc rewrite).
  let doc = newDocument();
  doc = keyframed(doc, 0, ["items", "old1"], {
    type: "rect", x: 1, y: 2, w: 10, h: 10, z: 0, rotation: 0.5, scale: 1,
    fill: "#fff", stroke: "#000", strokeWidth: 1, cornerRadius: 0, opacity: 1, active: true,
  });
  const report = missingDefaults(doc, registry).find((r) => r.id === "old1");
  assert.equal(report, undefined);
});

test("complete creations (the normal path) report nothing", () => {
  let doc = newDocument();
  const rectDefaults = registry.get("rect").defaults;
  const [d1] = withNewItem(doc, 0, { ...rectDefaults, active: true });
  assert.deepEqual(missingDefaults(d1, registry), []);
});

// ── Legacy key renames (headSize → headLength, manifest Round 11) ───────────

/** A pre-round-11 arrow doc: headSize keyframed at creation AND animated on slide 2. */
function legacyArrowDoc() {
  let doc = newDocument();
  const [d1, id] = withNewItem(doc, 0, {
    type: "arrow", z: 1, from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    color: "#000", width: 3, headSize: 20, opacity: 1, active: true,
  });
  const [d2] = withNewSlide(d1, 0);
  return [keyframed(d2, 1, ["items", id, "headSize"], 40), id];
}

test("legacy rename: headSize moves to headLength on EVERY slide, values verbatim (plus the arrow's OWN color/width→stroke/strokeWidth rename on slide 0 — manifest ARCHITECTURE PLAN #6, same declarative legacyKeys mechanism)", () => {
  const [doc, id] = legacyArrowDoc();
  const report = legacyKeyRenames(doc, registry);
  assert.deepEqual(report.map((r) => [r.slideIndex, r.from, r.to, r.stale]), [
    [0, "headSize", "headLength", false],
    [0, "color", "stroke", false],
    [0, "width", "strokeWidth", false],
    [1, "headSize", "headLength", false],
  ]);
  const { doc: fixed, renamed } = withLegacyKeysRenamed(doc, registry);
  assert.equal(renamed.length, 4);
  assert.equal(fixed.slides[0].delta.items[id].headLength, 20);
  assert.equal(fixed.slides[1].delta.items[id].headLength, 40); // the ANIMATION survives
  assert.equal(fixed.slides[0].delta.items[id].stroke, "#000");
  assert.equal(fixed.slides[0].delta.items[id].strokeWidth, 3);
  assert.equal("headSize" in fixed.slides[0].delta.items[id], false);
  assert.equal("headSize" in fixed.slides[1].delta.items[id], false);
  assert.equal("color" in fixed.slides[0].delta.items[id], false);
  assert.equal("width" in fixed.slides[0].delta.items[id], false);
  assert.deepEqual(withLegacyKeysRenamed(fixed, registry).renamed, []); // idempotent
});

test("legacy rename: an EQUATION-valued legacy key moves verbatim (still an equation)", () => {
  let doc = newDocument();
  const [d1, id] = withNewItem(doc, 0, {
    type: "arrow", z: 1, from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    color: "#000", width: 3, headSize: "speed * 2", opacity: 1, active: true,
  });
  const withVar = keyframed(d1, 0, ["vars", "speed"], 10);
  const { doc: fixed } = withLegacyKeysRenamed(withVar, registry);
  assert.equal(fixed.slides[0].delta.items[id].headLength, "speed * 2");
  // headLength has a NUMBER plugin default, so the moved string is still an
  // equation slot — the derivation stage evaluates it.
  const filled = withMissingDefaultsFilled(fixed, registry).doc;
  const state = evaluateState(foldState(filled, 0, 1), registry).state;
  assert.equal(state.items[id].headLength, 20);
});

test("legacy rename: when BOTH keys are written the new key wins, stale copy dropped", () => {
  let doc = newDocument();
  const [d1, id] = withNewItem(doc, 0, {
    type: "arrow", z: 1, from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    color: "#000", width: 3, headSize: 20, headLength: 33, opacity: 1, active: true,
  });
  const report = legacyKeyRenames(d1, registry);
  assert.equal(report[0].stale, true);
  const { doc: fixed } = withLegacyKeysRenamed(d1, registry);
  assert.equal(fixed.slides[0].delta.items[id].headLength, 33); // authoritative
  assert.equal("headSize" in fixed.slides[0].delta.items[id], false);
});

test("legacy rename: a null (delete-sentinel) legacy write moves as a delete of the new key", () => {
  const [doc, id] = legacyArrowDoc();
  const nulled = keyframed(doc, 1, ["items", id, "headSize"], null);
  const { doc: fixed } = withLegacyKeysRenamed(nulled, registry);
  assert.equal(fixed.slides[1].delta.items[id].headLength, null);
});

test("legacy rename ORDER: rename BEFORE missing-defaults fill preserves the user's value", () => {
  // The load-boundary chain must run withLegacyKeysRenamed first: filling
  // first would write headLength = default(14) at the creation slide, and the
  // rename would then drop the user's 20 as a stale duplicate.
  const [doc, id] = legacyArrowDoc();
  const renamed = withLegacyKeysRenamed(doc, registry).doc;
  const { doc: filled, filled: fills } = withMissingDefaultsFilled(renamed, registry);
  assert.equal(filled.slides[0].delta.items[id].headLength, 20); // preserved
  // Only the genuinely-new headWidth/headMode get filled, not headLength
  // (headMode is the arrow-variants task's new field — manifest ARCHITECTURE
  // PLAN #6 — the fixture predates it, same "genuinely new" territory as headWidth).
  const arrowFill = fills.find((f) => f.id === id);
  assert.deepEqual(arrowFill.missing.map((m) => m.path.join(".")), ["headWidth", "headMode"]);
  const state = evaluateState(foldState(filled, 1, 1), registry).state;
  assert.equal(state.items[id].headLength, 40);
  sceneIR(deriveRenderTree(state, registry)); // renders through the strict IR
});

test("current documents report no legacy renames", () => {
  let doc = newDocument();
  const [d1] = withNewItem(doc, 0, { ...registry.get("arrow").defaults, active: true });
  assert.deepEqual(legacyKeyRenames(d1, registry), []);
});

// ── defaultCameraState (the ONE camera literal) ─────────────────────────────

test("defaultCameraState sizes to meta and carries name/active (the reconciled truth)", () => {
  const cam = defaultCameraState({ slideW: 800, slideH: 600 });
  assert.equal(cam.type, "camera");
  assert.equal(cam.name, "Camera");
  assert.equal(cam.active, true);
  assert.equal(cam.w, 800);
  assert.equal(cam.h, 600);
  // no meta → the historical 1280×720 fallback
  assert.equal(defaultCameraState().w, 1280);
  assert.equal(defaultCameraState().h, 720);
});

test("the camera plugin's defaults ARE defaultCameraState (no drift)", () => {
  // The plugin literal used to lack name/active and hardcode 1280×720; it now
  // reuses the ONE truth, so filling from plugin defaults yields name/active too.
  const d = registry.get("camera").defaults;
  assert.equal(d.name, "Camera");
  assert.equal(d.active, true);
  assert.equal(d.w, 1280);
});

// ── repairedDocument (the ONE load-boundary pipeline) ───────────────────────

test("repairedDocument is idempotent on a fresh document (no reports)", () => {
  const { doc, reports } = repairedDocument(newDocument(), registry);
  assert.deepEqual(reports, []);
  const again = repairedDocument(doc, registry);
  assert.deepEqual(again.reports, []);
});

test("repairedDocument STRIPS legacy meta.fps (the CLI-vs-editor drift the audit flagged)", () => {
  const doc = newDocument();
  doc.meta.fps = 120; // legacy field
  const { doc: fixed, reports } = repairedDocument(doc, registry);
  assert.equal("fps" in fixed.meta, false);
  assert.ok(reports.some((r) => r.includes("removed legacy meta.fps")));
});

test("repairedDocument drops an orphan, re-ensures the camera, and reports both classes", () => {
  const [doc, id] = orphanedDoc(); // orphaned rect + camera lost with the deleted slide
  const { doc: fixed, reports } = repairedDocument(doc, registry);
  // orphan gone
  assert.equal(foldState(fixed, 0, 1).items?.[id], undefined);
  // camera re-ensured (withCameraEnsured runs inside the pipeline)
  const hasCamera = fixed.slides.some((s) =>
    Object.values(s.delta.items ?? {}).some((it) => it?.type === "camera"));
  assert.ok(hasCamera);
  assert.ok(reports.some((r) => r.includes(`dropped item "${id}"`)));
  // the repaired doc renders through the strict IR
  const state = evaluateState(foldState(fixed, 0, 1), registry).state;
  sceneIR(deriveRenderTree(state, registry));
});

test("repairedDocument runs legacy renames BEFORE fill (value preserved) and migrates duration", () => {
  const [doc, id] = legacyArrowDoc(); // headSize animated; slide 0 also color/width legacy
  // A pre-transitions slide: strip the fresh doc's transition and give it the
  // legacy per-slide `duration` so withDurationMigrated actually fires.
  delete doc.slides[1].transition;
  doc.slides[1].duration = 3;
  const { doc: fixed, reports } = repairedDocument(doc, registry);
  assert.equal(fixed.slides[0].delta.items[id].headLength, 20); // user value preserved
  assert.equal(fixed.slides[1].delta.items[id].headLength, 40); // animation survives
  assert.equal("duration" in fixed.slides[1], false);
  assert.equal(fixed.slides[1].transition.seconds, 3);
  assert.ok(reports.some((r) => r.includes("headSize") && r.includes("headLength")));
  assert.ok(reports.some((r) => r.includes("duration") && r.includes("transition.seconds")));
});

console.log(`\n${passed} repair tests passed`);
