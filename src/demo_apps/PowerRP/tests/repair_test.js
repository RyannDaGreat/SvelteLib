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
  serialize, deserialize,
  fancyArrowFillMigrations, withFancyArrowFillMigrated,
  linearGradientAngleMigrations, withLinearGradientAngleMigrated,
  antialiasSelectMigrations, withAntialiasSelectMigrated,
  filmstripFramesMigrations, legacyBindings, itemCreationTypes,
  repairedDocument, defaultCameraState, withExtraCamerasDropped,
} from "../core/document.js";
import { angleToLinearEndpoints, linearEndpointsToAngle } from "../core/properties.js";
import { parsePaint } from "../render_gpu/ir.js";
import { fancyArrowPlugin } from "../plugins/fancy_arrow.js";
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
    // The effects bundle's effect-off keys (Round 12D) — like cornerRadius/
    // opacity above, plain data defaults that ARE filled on old docs; this
    // fixture enumerates every non-computed default so the assertion below
    // isolates exactly the self.-equation (rotationAnchor) injection question.
    shadow: { dx: 3, dy: 3, blur: 0, color: "#000000", opacity: 0.5 },
    bloom: { radius: 10, strength: 0 },
    blendMode: "normal",
    innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    softEdges: 0, // the effects bundle's soft-edges amount (0 = off)
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
  // Only the genuinely-new headWidth/headMode + the Round-12D effects-bundle
  // keys get filled, not headLength (headMode is the arrow-variants task's new
  // field — manifest ARCHITECTURE PLAN #6; the effect-off shadow/bloom/
  // blendMode/innerShadow/softEdges keys are the effects bundle's — the fixture
  // predates them all, the same "genuinely new" territory as headWidth).
  const arrowFill = fills.find((f) => f.id === id);
  assert.deepEqual(arrowFill.missing.map((m) => m.path.join(".")), [
    "headWidth", "headMode",
    "shadow.dx", "shadow.dy", "shadow.blur", "shadow.color", "shadow.opacity",
    "bloom.radius", "bloom.strength", "blendMode",
    "innerShadow.dx", "innerShadow.dy", "innerShadow.blur", "innerShadow.color", "innerShadow.opacity",
    "softEdges",
  ]);
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

// ── A CRISP SHADOW SURVIVES A SAVE/LOAD ROUND TRIP ───────────────────────────
//
// THESE THREE TESTS REPLACE THREE THAT ENCODED A BUG. The retired ones asserted
// that repairedDocument ZEROES any stored shadow with blur 0 and opacity > 0 —
// the "dormant shadow" migration (ac98586). Manifest 14.8 makes that shape the
// canonical CRISP hard-edged shadow ("blur should be allowed to be 0 and still
// visible — but shadow opacity = 0 gates whether we render it"), and shadow.blur
// DEFAULTS to 0, so the migration destroyed the most ordinary authored shadow
// there is on every single load. The old assertions were therefore pinning the
// defect in place; they are gone with the migration, and these replace them by
// asserting the OPPOSITE — the value survives.

test("a CRISP shadow (blur 0, opacity > 0) survives a save/load round trip", () => {
  // The most ordinary authored shadow in the app: blur left at its default 0,
  // Shadow opacity raised off 0. This is precisely what the deleted dormant-shadow
  // migration reset, and it must now come back byte-identical.
  const [doc, id] = withNewItem(newDocument(registry), 0, {
    ...registry.get("rect").defaults, x: 0, y: 0, w: 100, h: 60, active: true,
    shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0.5 },
  });
  const { doc: loaded, reports } = repairedDocument(deserialize(serialize(doc)), registry);
  assert.deepEqual(loaded.slides[0].delta.items[id].shadow,
    { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0.5 });
  assert.deepEqual(reports.filter((r) => r.includes("shadow")), []); // and nothing to say about it
  // Still renders through the strict IR.
  sceneIR(deriveRenderTree(evaluateState(foldState(loaded, 0, 1), registry).state, registry));
});

test("an OFFSET crisp shadow (blur 0, opacity 1, colored) survives too — and repeated loads never erode it", () => {
  const [doc, id] = withNewItem(newDocument(registry), 0, {
    ...registry.get("rect").defaults, x: 0, y: 0, w: 10, h: 10, active: true,
    shadow: { dx: 12, dy: -4, blur: 0, color: "#ff0000", opacity: 1 },
  });
  let out = doc;
  for (let i = 0; i < 3; i++) out = repairedDocument(deserialize(serialize(out)), registry).doc;
  assert.deepEqual(out.slides[0].delta.items[id].shadow,
    { dx: 12, dy: -4, blur: 0, color: "#ff0000", opacity: 1 });
});

test("the OLD-DEFAULT shadow shape is now kept as stored — it is indistinguishable from an authored one", () => {
  // {dx:3, dy:3, blur:0, opacity:0.5} was the pre-14.8 creation default, invisible
  // under the old blur-gated render. It is ALSO exactly what a user authors today by
  // typing 3 into Shadow X/Y and 0.5 into Shadow opacity — the two documents are
  // byte-identical, so no predicate can tell them apart. Repair therefore keeps it,
  // and a pre-14.8 deck shows those shadows. That is visible on canvas and undone by
  // setting Shadow opacity to 0; the alternative cost the user's authored value.
  const [doc, id] = withNewItem(newDocument(registry), 0, {
    ...registry.get("rect").defaults, x: 0, y: 0, w: 10, h: 10, active: true,
    shadow: { dx: 3, dy: 3, blur: 0, color: "#000000", opacity: 0.5 },
  });
  const { doc: fixed, reports } = repairedDocument(doc, registry);
  assert.equal(fixed.slides[0].delta.items[id].shadow.opacity, 0.5);
  assert.deepEqual(reports.filter((r) => r.includes("shadow")), []);
});

// ── Round 15.6: the box-level `valign` default fills on OLD text docs ─────────

test("an OLD text item (no valign key) gets valign filled to 'top' — old docs unchanged", () => {
  // A pre-15.6 text item carries every text default EXCEPT `valign` (it did not
  // exist). missingDefaults must report it, and the fill must write "top" — the
  // no-op value (core/richtext.valignOffset returns 0 for "top"), so the render
  // is byte-identical. This is the repair-path proof for the new plain-string
  // box property.
  const textDefaults = registry.get("text").defaults;
  const { valign, ...oldTextDefaults } = textDefaults; // strip valign → the old shape
  const [d1, id] = withNewItem(newDocument(), 0, { ...oldTextDefaults, active: true });
  // valign is reported missing (a plain-string default, NOT a self.-equation, so
  // it IS materialized — unlike rotationAnchor).
  const report = missingDefaults(d1, registry).find((r) => r.id === id);
  assert.ok(report, "old text item should be reported for missing defaults");
  assert.ok(report.missing.some((m) => m.path.join(".") === "valign"), "valign should be reported missing");
  const { doc: fixed } = withMissingDefaultsFilled(d1, registry);
  const state = evaluateState(foldState(fixed, 0, 1), registry).state;
  assert.equal(state.items[id].valign, "top"); // filled with the no-op default
  sceneIR(deriveRenderTree(state, registry)); // must not throw with valign present
  // idempotent: a COMPLETE text item (valign present) does not report valign.
  const [complete, cid] = withNewItem(newDocument(), 0, { ...textDefaults, active: true });
  const textRep = missingDefaults(complete, registry).find((r) => r.id === cid);
  assert.ok(!textRep || !textRep.missing.some((m) => m.path.join(".") === "valign"), "a complete text item does not report valign");
});

// ── Round 17.4: fancy-arrow "stroke was the fill" migration ────────────────

test("fancyArrowFillMigrations: an OLD stroke-as-fill write is selected, a NEW fill-bearing item is not", () => {
  const oldDoc = { slides: [{ delta: { items: { a: { type: "fancy_arrow", stroke: "#ff0000" } } } }] };
  assert.deepEqual(fancyArrowFillMigrations(oldDoc, registry), [{ id: "a", slideIndex: 0, value: "#ff0000" }]);
  const newDoc = { slides: [{ delta: { items: { a: { type: "fancy_arrow", fill: "#ff0000", stroke: "#000000" } } } }] };
  assert.deepEqual(fancyArrowFillMigrations(newDoc, registry), []); // already migrated — idempotent
});

test("fancyArrowFillMigrations: only fancy_arrow items are touched (a rect's stroke is a real outline already)", () => {
  const doc = { slides: [{ delta: { items: { a: { type: "rect", fill: "#7aa2f7", stroke: "#ff0000" } } } }] };
  assert.deepEqual(fancyArrowFillMigrations(doc, registry), []);
});

test("withFancyArrowFillMigrated: old stroke value moves to fill, stroke key is dropped (falls back to the plugin default)", () => {
  const [d1, id] = withNewItem(newDocument(), 0, {
    type: "fancy_arrow", z: 1, from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
    stroke: "#ff0000", opacity: 1, active: true,
  });
  const { doc: fixed, migrated } = withFancyArrowFillMigrated(d1, registry);
  assert.equal(migrated.length, 1);
  assert.equal(fixed.slides[0].delta.items[id].fill, "#ff0000");
  assert.equal("stroke" in fixed.slides[0].delta.items[id], false);
  // Idempotent: re-running finds nothing left to migrate.
  assert.equal(withFancyArrowFillMigrated(fixed, registry).migrated.length, 0);
});

test("withFancyArrowFillMigrated: a keyframed-on-a-LATER-slide stroke (an animated fill color) migrates on that slide too", () => {
  let doc = newDocument();
  const [d1, id] = withNewItem(doc, 0, {
    type: "fancy_arrow", z: 1, from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
    stroke: "#ff0000", opacity: 1, active: true,
  });
  const [d2] = withNewSlide(d1, 0);
  const d3 = keyframed(d2, 1, ["items", id, "stroke"], "#00ff00"); // color animates across slides
  const { doc: fixed, migrated } = withFancyArrowFillMigrated(d3, registry);
  assert.equal(migrated.length, 2);
  assert.equal(fixed.slides[0].delta.items[id].fill, "#ff0000");
  assert.equal(fixed.slides[1].delta.items[id].fill, "#00ff00"); // the animation survives
  assert.equal("stroke" in fixed.slides[1].delta.items[id], false);
});

test("repairedDocument: an OLD fancy arrow (stroke-as-fill) migrates to fill + strokeWidth 0, and renders BYTE-IDENTICAL to its pre-migration appearance", () => {
  const [d1, id] = withNewItem(newDocument(), 0, {
    type: "fancy_arrow", z: 1, from: { x: 200, y: 340 }, to: { x: 420, y: 340 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
    stroke: "#ff0000", opacity: 1, active: true,
  });
  const { doc: fixed, reports } = repairedDocument(d1, registry);
  assert.ok(reports.some((r) => r.includes(id) && r.includes("fancy-arrow") && r.includes("fill")));
  const item = fixed.slides[0].delta.items[id];
  assert.equal(item.fill, "#ff0000"); // the OLD "stroke" value, preserved exactly
  assert.equal(item.strokeWidth, 0);  // no outline — the migration never invents one
  // The RENDER must be byte-identical: pre-migration, the old emit() drew
  // `fill: s.stroke`; post-migration the new emit() draws `fill: s.fill` and,
  // with strokeWidth 0, emits NO outline polyline — same op list, same color.
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  const migratedOps = fancyArrowPlugin.emit(item, null, world);
  assert.ok(migratedOps.every((op) => op.op === "path"), "strokeWidth 0 must emit zero outline ops");
  const preMigrationFillColor = [1, 0, 0, 1]; // parseColor("#ff0000")
  assert.deepEqual(migratedOps[0].fill, preMigrationFillColor);
  // And the full strict-IR pipeline survives (fold → evaluate → derive → sceneIR).
  const state = evaluateState(foldState(fixed, 0, 1), registry).state;
  sceneIR(deriveRenderTree(state, registry));
});

test("repairedDocument: a fresh fancy arrow (already on fill/stroke) is idempotent — no migration report", () => {
  const [d1] = withNewItem(newDocument(), 0, { ...fancyArrowPlugin.defaults, active: true });
  const { reports } = repairedDocument(d1, registry);
  assert.ok(!reports.some((r) => r.includes("fancy-arrow")));
});

test("fancyArrowPlugin.emit: strokeWidth > 0 draws ONE closed outline polyline around the OUTER HULL (no per-triangle seams)", () => {
  const state = { ...fancyArrowPlugin.defaults, fill: "#ff0000", stroke: "#000000", strokeWidth: 4 };
  const ops = fancyArrowPlugin.emit(state, null, { x: 0, y: 0, rotation: 0, scale: 1 });
  const polylines = ops.filter((op) => op.op === "polyline");
  assert.equal(polylines.length, 1); // exactly one outline, not one per fill triangle
  const pts = polylines[0].points;
  assert.deepEqual(pts[0], pts[pts.length - 1]); // closed loop (first vertex repeated)
  assert.equal(pts.length, 8); // the 7-vertex hull + the closing repeat
  assert.equal(polylines[0].width, 4);
});

// ── Round 18 audit F1: camera uniqueness (THE CAMERA — exactly one) ──────────

/** Distinct camera item ids present anywhere in a doc's deltas. */
function camerasIn(doc) {
  const ids = new Set();
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {}))
      if (item && item.type === "camera") ids.add(id);
  return [...ids];
}

test("withExtraCamerasDropped: keeps the first camera by id, purges the rest, leaves non-cameras (idempotent)", () => {
  const doc = { meta: {}, slides: [{ id: "s0", delta: { items: {
    aaa: { type: "camera", x: 0, y: 0, w: 100, h: 100 },
    zzz: { type: "camera", x: 5, y: 5, w: 200, h: 200 },
    rect1: { type: "rect", x: 1, y: 1, w: 10, h: 10 },
  } } }] };
  const { doc: out, dropped } = withExtraCamerasDropped(doc);
  assert.deepEqual(dropped, ["zzz"]);            // first-by-id "aaa" wins
  assert.ok(out.slides[0].delta.items.aaa);      // kept
  assert.equal(out.slides[0].delta.items.zzz, undefined); // purged
  assert.ok(out.slides[0].delta.items.rect1);    // non-camera untouched
  // Idempotent: a single-camera doc comes back byte-identical (same ref), no drops.
  const again = withExtraCamerasDropped(out);
  assert.deepEqual(again.dropped, []);
  assert.equal(again.doc, out);
});

test("withExtraCamerasDropped: a normal single-camera doc is unchanged", () => {
  const doc = newDocument();
  assert.equal(camerasIn(doc).length, 1);
  const { doc: out, dropped } = withExtraCamerasDropped(doc);
  assert.deepEqual(dropped, []);
  assert.equal(out, doc); // no work → same reference
});

test("repairedDocument: a >=2-camera doc repairs to exactly one camera with a LOUD report (F1)", () => {
  // A well-formed doc has one camera (a uuid id); inject an EXTRA camera whose
  // id ('zzz…' > any hex uuid) sorts last, so the original survives and the
  // extra is the one dropped — deterministic regardless of the uuid.
  let doc = newDocument();
  const origCam = camerasIn(doc)[0];
  doc = keyframed(doc, 0, ["items", "zzz-extra-camera"], defaultCameraState(doc.meta));
  assert.equal(camerasIn(doc).length, 2); // two before repair
  const { doc: fixed, reports } = repairedDocument(doc, registry);
  const cams = camerasIn(fixed);
  assert.equal(cams.length, 1);            // exactly one after repair
  assert.deepEqual(cams, [origCam]);       // the first-by-id original kept
  assert.ok(
    reports.some((r) => r.includes("dropped extra camera") && r.includes("zzz-extra-camera")),
    `expected a loud extra-camera report, got: ${JSON.stringify(reports)}`,
  );
  // The repaired doc still renders through the strict IR.
  const state = evaluateState(foldState(fixed, 0, 1), registry).state;
  sceneIR(deriveRenderTree(state, registry));
});

test("repairedDocument: a clean single-camera doc emits NO camera report", () => {
  const { reports } = repairedDocument(newDocument(), registry);
  assert.ok(!reports.some((r) => r.includes("camera")));
});

test("repairedDocument: a gradient PAINT survives repair — not clobbered by the scalar default (regression)", () => {
  // A rect with a gradient PAINT object as its fill. missingDefaults must treat
  // the scalar-default key `fill` as COVERED because the item wrote nested paths
  // (fill.type / fill.linear.stops…). Pre-fix it reported `fill` as missing and
  // keyframed the "#…" default OVER the gradient — silently wiping every gradient
  // paint (fill/stroke/background) on load.
  const grad = { type: "linearGradient", solid: "#123456", linear: { stops: [{ offset: 0, color: "#111111" }, { offset: 1, color: "#eeeeee" }], from: { x: 0, y: 0 }, to: { x: 1, y: 0 } } };
  let doc = newDocument();
  doc = keyframed(doc, 0, ["items", "grad1"], { ...registry.get("rect").defaults, type: "rect", fill: grad });
  const { doc: fixed } = repairedDocument(doc, registry);
  const fill = evaluateState(foldState(fixed, 0, 1), registry).state.items.grad1.fill;
  assert.ok(fill && fill.type === "linearGradient", `gradient fill must survive repair, got ${JSON.stringify(fill)}`);
});

// ── Linear-gradient direction → angle migration (the "angle" property kind) ────
// The gradient direction used to be four discrete presets that stored only
// objectBoundingBox from/to; it is now a continuous `angle` in degrees — the
// AUTHORITATIVE direction the renderer reads (parsePaint DERIVES from/to from it).
// Repair adds the angle beside every legacy from/to, leaving from/to in the doc
// as harmless legacy data. The four presets map to EXACT angles (→ 0°, ↓ 90°,
// ↘ 45°, ↗ 315°) and render identically after migration: the diagonals recover
// byte-exact endpoints, the axis-aligned ones recover a center-offset chord that
// is render-equivalent (a shift perpendicular to a gradient's axis is invisible).
const LEGACY_DIRECTION_PRESETS = [
  { name: "→ right", from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, angle: 0 },
  { name: "↓ down", from: { x: 0, y: 0 }, to: { x: 0, y: 1 }, angle: 90 },
  { name: "↘ down-right", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, angle: 45 },
  { name: "↗ up-right", from: { x: 0, y: 1 }, to: { x: 1, y: 0 }, angle: 315 },
];

test("gradient direction migration: each legacy 4-preset from/to → the correct angle, from/to preserved (renders identical), loud + idempotent", () => {
  for (const p of LEGACY_DIRECTION_PRESETS) {
    // An OLD linear-gradient paint: from/to present, NO angle (the 4-preset era).
    const grad = { type: "linearGradient", solid: "#123456", linear: { stops: [{ offset: 0, color: "#111111" }, { offset: 1, color: "#eeeeee" }], from: p.from, to: p.to } };
    let doc = newDocument();
    doc = keyframed(doc, 0, ["items", "g"], { ...registry.get("rect").defaults, type: "rect", fill: grad });

    const { doc: fixed, reports } = repairedDocument(doc, registry);
    const lin = fixed.slides[0].delta.items.g.fill.linear;

    // (1) migrated to the correct angle …
    assert.equal(lin.angle, p.angle, `${p.name}: expected angle ${p.angle}, got ${lin.angle}`);
    // (2) … with the doc's from/to LEFT UNTOUCHED by the migration (now legacy
    //     data — no longer what the renderer reads) …
    assert.deepEqual(lin.from, p.from, `${p.name}: from preserved`);
    assert.deepEqual(lin.to, p.to, `${p.name}: to preserved`);
    // (3) … proven at the renderer seam: parsePaint DERIVES the endpoints from the
    //     authoritative angle, so the exact points may slide along the axis, but
    //     the rendered DIRECTION (axis heading) is identical to the pre-migration one.
    const before = parsePaint(grad); // no angle ⇒ fallback reads the raw from/to
    const after = parsePaint(fixed.slides[0].delta.items.g.fill); // angle-derived
    assert.equal(linearEndpointsToAngle(after.from, after.to), linearEndpointsToAngle(before.from, before.to), `${p.name}: rendered direction unchanged`);
    // (4) LOUD report.
    assert.ok(reports.some((r) => r.includes(`angle ${p.angle}°`)), `${p.name}: loud migration report`);
    // (5) idempotent: a re-run migrates nothing (angle already present).
    assert.equal(withLinearGradientAngleMigrated(fixed).migrated.length, 0, `${p.name}: idempotent`);
  }
});

test("gradient direction migration: a legacy-INLINE linear gradient (from/to on the paint itself) migrates too; arrow endpoints are NOT touched", () => {
  // Legacy-inline form: {type, stops, from, to} with NO sub-state wrapper.
  const inlineGrad = { type: "linearGradient", stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], from: { x: 0, y: 0 }, to: { x: 1, y: 1 } };
  let doc = newDocument();
  doc = keyframed(doc, 0, ["items", "g"], { ...registry.get("rect").defaults, type: "rect", fill: inlineGrad });
  // An arrow whose OWN from/to endpoints are {x,y} points but have NO stops —
  // must NOT be mistaken for a gradient.
  doc = keyframed(doc, 0, ["items", "arr"], { ...registry.get("arrow").defaults, type: "arrow", from: { x: 5, y: 5 }, to: { x: 9, y: 9 } });

  const found = linearGradientAngleMigrations(doc);
  assert.equal(found.length, 1, `only the inline gradient is a candidate, got ${JSON.stringify(found)}`);
  assert.deepEqual(found[0].relPath, ["fill"], "inline gradient is located at the paint itself");
  assert.equal(found[0].angle, 45, "inline (0,0)-(1,1) → 45°");

  const { doc: fixed } = repairedDocument(doc, registry);
  assert.equal(fixed.slides[0].delta.items.g.fill.angle, 45, "inline gradient got its angle");
  const arr = fixed.slides[0].delta.items.arr;
  assert.ok(!("angle" in arr.from) && !("angle" in arr.to), "arrow endpoints untouched (no angle injected)");
});

test("angle ↔ endpoints round-trip: legacy presets recover their exact angle; angle→endpoints→angle is stable", () => {
  for (const p of LEGACY_DIRECTION_PRESETS) {
    // Every legacy preset's endpoints recover its exact heading.
    assert.equal(linearEndpointsToAngle(p.from, p.to), p.angle, `${p.name}: endpoints → ${p.angle}`);
    // angle → endpoints → angle is stable (bijective on direction).
    const e = angleToLinearEndpoints(p.angle);
    assert.equal(linearEndpointsToAngle(e.from, e.to), p.angle, `${p.name}: ${p.angle}° round-trips`);
  }
  // The DIAGONAL presets are reproduced with byte-EXACT endpoints (corner to
  // corner); the horizontal/vertical presets are reproduced render-equivalently
  // (same axis, center-offset chord). Either way the angle recovers the same
  // rendered direction the renderer now derives from it, so every migrated
  // document renders identically.
  assert.deepEqual(angleToLinearEndpoints(45), { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, "↘ 45° → exact corner-to-corner");
  assert.deepEqual(angleToLinearEndpoints(315), { from: { x: 0, y: 1 }, to: { x: 1, y: 0 } }, "↗ 315° → exact corner-to-corner");
});

// ── Round 19: anti-aliasing BOOLEAN → SELECT migration ───────────────────────
// The camera's `antialias` was a boolean (true = smooth, false = crisp); it is
// now a quality/algorithm SELECT (ANTIALIAS_MODES: "off"|"standard"). Repair
// rewrites the legacy boolean to its select id, preserving each doc's exact
// intent: true → "standard" (today's coverage-AA look), false → "off" (crisp).

test("antialiasSelectMigrations: a boolean antialias is selected (true→standard, false→off); a string is not", () => {
  const onDoc = { slides: [{ delta: { items: { c: { type: "camera", antialias: true } } } }] };
  assert.deepEqual(antialiasSelectMigrations(onDoc), [{ id: "c", slideIndex: 0, from: true, to: "standard" }]);
  const offDoc = { slides: [{ delta: { items: { c: { type: "camera", antialias: false } } } }] };
  assert.deepEqual(antialiasSelectMigrations(offDoc), [{ id: "c", slideIndex: 0, from: false, to: "off" }]);
  const migratedDoc = { slides: [{ delta: { items: { c: { type: "camera", antialias: "standard" } } } }] };
  assert.deepEqual(antialiasSelectMigrations(migratedDoc), []); // already a select value — idempotent
});

test("withAntialiasSelectMigrated: boolean → select value, string left untouched, idempotent", () => {
  const doc = { slides: [{ delta: { items: {
    c: { type: "camera", antialias: false },        // → "off"
    d: { type: "camera", antialias: true },         // → "standard"
    e: { type: "camera", antialias: "standard" },   // untouched (already migrated)
  } } }] };
  const { doc: fixed, migrated } = withAntialiasSelectMigrated(doc);
  assert.equal(fixed.slides[0].delta.items.c.antialias, "off");
  assert.equal(fixed.slides[0].delta.items.d.antialias, "standard");
  assert.equal(fixed.slides[0].delta.items.e.antialias, "standard");
  assert.equal(migrated.length, 2);
  // Idempotent: re-running finds nothing left to migrate.
  assert.equal(withAntialiasSelectMigrated(fixed).migrated.length, 0);
});

test("withAntialiasSelectMigrated: a boolean keyframed on a LATER slide (animated AA) migrates there too", () => {
  let doc = newDocument();
  const cam = camerasIn(doc)[0];
  const [d2] = withNewSlide(doc, 0);
  const d3 = keyframed(d2, 1, ["items", cam, "antialias"], false); // AA toggled off on slide 2 (legacy boolean)
  const { doc: fixed, migrated } = withAntialiasSelectMigrated(d3);
  assert.equal(fixed.slides[1].delta.items[cam].antialias, "off");
  assert.ok(migrated.some((m) => m.slideIndex === 1 && m.to === "off"));
});

test("repairedDocument: a legacy boolean antialias migrates to a select id with a LOUD report, and still renders", () => {
  // A pre-select document: force the camera's antialias back to the old boolean.
  let doc = newDocument();
  const cam = camerasIn(doc)[0];
  doc = keyframed(doc, 0, ["items", cam, "antialias"], false); // legacy "crisp" boolean
  const { doc: fixed, reports } = repairedDocument(doc, registry);
  assert.equal(fixed.slides[0].delta.items[cam].antialias, "off"); // false → "off"
  assert.ok(
    reports.some((r) => r.includes(cam) && r.includes("boolean antialias") && r.includes('"off"')),
    `expected a loud antialias migration report, got: ${JSON.stringify(reports)}`,
  );
  // The repaired doc still renders through the strict IR (select value is valid).
  const state = evaluateState(foldState(fixed, 0, 1), registry).state;
  sceneIR(deriveRenderTree(state, registry));
});

test("repairedDocument: a fresh document (antialias already the select default) emits NO antialias report", () => {
  const { doc: fixed, reports } = repairedDocument(newDocument(), registry);
  const cam = camerasIn(fixed)[0];
  assert.equal(fixed.slides[0].delta.items[cam].antialias, "standard"); // the new select default
  assert.ok(!reports.some((r) => r.includes("boolean antialias")));
});

// ── MIGRATION GATES ──────────────────────────────────────────────────────────
// THE CRITERION (core/document.js's RETIRED block, and the reason those
// migrations are safe to re-run forever): a migration may only fire on a shape
// THE CURRENT EDITOR CANNOT PRODUCE. Every test below is a gate against the
// three ways that was violated — a per-SLIDE gate standing in for a per-ITEM
// one, a per-SHAPE gate standing in for a per-WIDGET one, and a coverage test
// the repair's own write could never satisfy.

/** The filmstrip's own frame-list builder, the way repairedDocument gets it. */
const defaultFrameList = registry.all().find((p) => p.type === "filmstrip").defaultFrameList;

test("itemCreationTypes: the FIRST type written wins; a typeless id is absent (the orphan case)", () => {
  const doc = { slides: [{ delta: { items: { a: { type: "rect" }, b: { x: 1 } } } }, { delta: { items: { a: { x: 5 } } } }] };
  assert.equal(itemCreationTypes(doc).get("a"), "rect");
  assert.equal(itemCreationTypes(doc).has("b"), false);
});

test("fancy arrow: an Outline keyframe authored TODAY is NOT migrated (per-ITEM gate, not per-slide)", () => {
  // THE DEFECT this gates: a fancy arrow inserted today writes fill AND stroke
  // on its creation slide, so changing Outline on slide 2 commits that ONE leaf
  // and slide 2's delta is {stroke: …} — byte-identical to a legacy pre-17.4
  // write. The per-SLIDE gate rewrote it to {fill: …} on the very next load, so
  // the authored OUTLINE animation became a BODY animation, permanently, three
  // clicks from a fresh insert.
  const [d1, id] = withNewItem(newDocument(), 0, { ...fancyArrowPlugin.defaults, active: true });
  const [d2] = withNewSlide(d1, 0);
  const authored = keyframed(d2, 1, ["items", id, "stroke"], "#00ff00");
  assert.ok("fill" in authored.slides[0].delta.items[id], "premise: today's creation slide writes fill");
  assert.deepEqual(fancyArrowFillMigrations(authored, registry), []);

  const { doc: fixed, reports } = repairedDocument(authored, registry);
  assert.deepEqual(fixed.slides[1].delta.items[id], { stroke: "#00ff00" });
  assert.ok(!reports.some((r) => r.includes("fancy-arrow")), `expected no fancy-arrow report, got: ${JSON.stringify(reports)}`);
  // The folded slide-2 state is UNCHANGED by the load: green outline, default body.
  const before = foldState(authored, 1, 1).items[id];
  const after = foldState(fixed, 1, 1).items[id];
  assert.equal(after.stroke, "#00ff00");
  assert.equal(after.stroke, before.stroke);
  assert.equal(after.fill, before.fill);
});

test("fancy arrow: an EQUATION on a later stroke keyframe is not eaten either", () => {
  // The corruption moved whatever the leaf held — equations included, which is
  // how an animated outline colour became an animated body colour.
  const [d1, id] = withNewItem(newDocument(), 0, { ...fancyArrowPlugin.defaults, active: true });
  const [d2] = withNewSlide(d1, 0);
  const authored = keyframed(d2, 1, ["items", id, "stroke"], "= hsl(t, 1, 0.5)");
  const { doc: fixed } = repairedDocument(authored, registry);
  assert.deepEqual(fixed.slides[1].delta.items[id], { stroke: "= hsl(t, 1, 0.5)" });
});

test("fancy arrow: a GENUINELY legacy doc still migrates, on EVERY slide, and only once", () => {
  // The same document as the two tests above with ONE difference — the
  // creation slide has no `fill` write, which is exactly the pre-17.4 schema
  // (that property did not exist; `stroke` WAS the body colour). Both slides
  // must migrate: a fix that stops migrating real legacy data would be worse
  // than the corruption it replaced.
  const [d1, id] = withNewItem(newDocument(), 0, { ...fancyArrowPlugin.defaults, active: true });
  const [d2] = withNewSlide(d1, 0);
  const withLater = keyframed(d2, 1, ["items", id, "stroke"], "#00ff00");
  const legacy = unkeyframed(withLater, 0, ["items", id, "fill"]);

  assert.deepEqual(
    fancyArrowFillMigrations(legacy, registry).map((m) => [m.slideIndex, m.value]),
    [[0, fancyArrowPlugin.defaults.stroke], [1, "#00ff00"]]);
  const { doc: fixed } = withFancyArrowFillMigrated(legacy, registry);
  assert.equal(fixed.slides[0].delta.items[id].fill, fancyArrowPlugin.defaults.stroke);
  assert.equal(fixed.slides[0].delta.items[id].stroke, undefined); // falls back to the outline default
  assert.equal(fixed.slides[1].delta.items[id].fill, "#00ff00");
  assert.deepEqual(fancyArrowFillMigrations(fixed, registry), []); // idempotent

  // …and repairedDocument says so, twice, then goes quiet.
  const loud = repairedDocument(legacy, registry);
  assert.equal(loud.reports.filter((r) => r.includes("fancy-arrow")).length, 2);
  assert.deepEqual(repairedDocument(loud.doc, registry).reports.filter((r) => r.includes("fancy-arrow")), []);
});

test("cropbox: the NULL default `target` is reported at most once — never on every load", () => {
  // THE DEFECT this gates: `written` excludes null values (a null write is the
  // delete sentinel), and a null DEFAULT can only ever be filled with null, so
  // coverage was never satisfied and the report fired forever while the
  // document never changed — the reverse of a silent repair, and a falsified
  // "idempotent, reports = []" contract for every document with a crop box.
  const cropbox = registry.get("cropbox");
  assert.equal(cropbox.defaults.target, null, "premise: cropbox.target is a NULL default");
  const [created, id] = withNewItem(newDocument(), 0, { ...cropbox.defaults, active: true });

  let cur = created; // (a) created today: target: null is already written — silence from the first load
  for (let load = 1; load <= 5; load++) {
    const { doc, reports } = repairedDocument(cur, registry);
    assert.deepEqual(reports, [], `load ${load} of a fresh crop box must be silent`);
    cur = doc;
  }

  // (b) a document that never wrote `target` at all: reported ONCE, filled, then silent.
  const never = unkeyframed(created, 0, ["items", id, "target"]);
  const first = repairedDocument(never, registry);
  assert.equal(first.reports.filter((r) => r.includes("target")).length, 1);
  assert.equal(first.doc.slides[0].delta.items[id].target, null); // the report matches a real write
  assert.deepEqual(repairedDocument(first.doc, registry).reports, []);
});

test("repairedDocument REPORTS the legacy {item, anchor} binding migration (it used to rewrite in silence)", () => {
  // Step 7 of the order-critical sequence was the only step that pushed nothing:
  // the document changed shape ({item, anchor} → an equation pair) with no line
  // for printRepairReports to print.
  const [d1, cid] = withNewItem(newDocument(), 0, { type: "circle", x: 0, y: 0, w: 10, h: 10, active: true });
  const [d2, aid] = withNewItem(d1, 0, { type: "arrow", from: { item: cid, anchor: "tm" }, to: { x: 5, y: 5 }, active: true });
  assert.deepEqual(legacyBindings(d2), [{ id: aid, slideIndex: 0, key: "from", target: cid, anchor: "tm" }]);

  const { doc: fixed, reports } = repairedDocument(d2, registry);
  assert.deepEqual(fixed.slides[0].delta.items[aid].from, { x: `@${cid}_tm.x`, y: `@${cid}_tm.y` });
  assert.ok(
    reports.some((r) => r.includes(aid) && r.includes("binding") && r.includes(`@${cid}_tm.x`)),
    `expected a loud binding migration report, got: ${JSON.stringify(reports)}`);
  assert.deepEqual(legacyBindings(fixed), []); // idempotent — and the report stops with it
  assert.deepEqual(repairedDocument(fixed, registry).reports.filter((r) => r.includes("binding")), []);
});

test("frames / antialias migrations are gated on THEIR widget — a rect keeps both values verbatim", () => {
  // Neither `frames` nor `antialias` is a document-format concept: they belong
  // to the filmstrip and THE camera. Ungated, the next plugin to declare a
  // numeric `frames` would have had it rewritten into a 7-element list of
  // video-time equations, and a boolean `antialias` into the string "off" —
  // the fancy-arrow defect with different key names. A rect stands in for that
  // future plugin here.
  const [d1, id] = withNewItem(newDocument(), 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, active: true });
  const d2 = keyframed(keyframed(d1, 0, ["items", id, "frames"], 7), 0, ["items", id, "antialias"], false);
  assert.deepEqual(filmstripFramesMigrations(d2, defaultFrameList), []);
  assert.deepEqual(antialiasSelectMigrations(d2), []);
  const { doc: fixed } = repairedDocument(d2, registry);
  assert.equal(fixed.slides[0].delta.items[id].frames, 7);
  assert.equal(fixed.slides[0].delta.items[id].antialias, false);
});

test("dead filmstrip keys are the filmstrip's too — a rect's frameW/frameH/frameUrls are left alone", () => {
  const [d1, id] = withNewItem(newDocument(), 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, active: true });
  const d2 = keyframed(keyframed(d1, 0, ["items", id, "frameW"], 320), 0, ["items", id, "frameUrls"], ["a"]);
  assert.deepEqual(filmstripFramesMigrations(d2, defaultFrameList), []);
  assert.equal(repairedDocument(d2, registry).doc.slides[0].delta.items[id].frameW, 320);
});

test("EVERY plugin: an item built from its own defaults loads with a SILENT second pass", () => {
  // The GENERAL form of the crop-box defect: any default the fill cannot
  // materialize makes repairedDocument report forever while changing nothing.
  // Runs over the whole roster so the next such default is caught by this
  // suite rather than by a console full of repair lines.
  for (const plugin of registry.all()) {
    const [doc] = withNewItem(newDocument(), 0, { ...plugin.defaults, active: true });
    const first = repairedDocument(doc, registry);
    const second = repairedDocument(first.doc, registry);
    assert.deepEqual(second.reports, [], `${plugin.type}: a second load must report nothing, got ${JSON.stringify(second.reports)}`);
  }
});

test("EVERY plugin: its own fresh defaults are not a migration candidate (widget-gate drift guard)", () => {
  // If a future plugin declares `frames`, `antialias`, `fill`+`stroke` or an
  // {item, anchor}-shaped default, THIS is what goes red if the widget gates
  // are ever loosened back to shape-only tests.
  for (const plugin of registry.all()) {
    const [doc] = withNewItem(newDocument(), 0, { ...plugin.defaults, active: true });
    assert.deepEqual(filmstripFramesMigrations(doc, defaultFrameList), [], `${plugin.type}: filmstrip frames`);
    assert.deepEqual(antialiasSelectMigrations(doc), [], `${plugin.type}: antialias`);
    assert.deepEqual(fancyArrowFillMigrations(doc, registry), [], `${plugin.type}: fancy-arrow fill`);
    assert.deepEqual(legacyBindings(doc), [], `${plugin.type}: legacy bindings`);
  }
});

console.log(`\n${passed} repair tests passed`);
