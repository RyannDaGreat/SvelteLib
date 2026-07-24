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
  dormantShadows, withDormantShadowsNeutralized,
  fancyArrowFillMigrations, withFancyArrowFillMigrated,
  repairedDocument, defaultCameraState, withExtraCamerasDropped,
} from "../core/document.js";
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
  // blendMode keys are the effects bundle's — the fixture predates them all,
  // the same "genuinely new" territory as headWidth).
  const arrowFill = fills.find((f) => f.id === id);
  assert.deepEqual(arrowFill.missing.map((m) => m.path.join(".")), [
    "headWidth", "headMode",
    "shadow.dx", "shadow.dy", "shadow.blur", "shadow.color", "shadow.opacity",
    "bloom.radius", "bloom.strength", "blendMode",
    "innerShadow.dx", "innerShadow.dy", "innerShadow.blur", "innerShadow.color", "innerShadow.opacity",
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

test("dormantShadows: only a blur-0, opacity>0 stored shadow (the old default) is dormant", () => {
  // The exact old-default shadow every pre-14.8 item stored at creation.
  const oldDefault = { dx: 3, dy: 3, blur: 0, color: "#000000", opacity: 0.5 };
  const doc = { slides: [{ delta: { items: {
    a: { type: "rect", shadow: { ...oldDefault } },            // dormant (blur 0, opacity 0.5)
    b: { type: "rect", shadow: { ...oldDefault, blur: 4 } },   // VISIBLE before (blur 4) → keep
    c: { type: "rect", shadow: { ...oldDefault, opacity: 0 } },// already off → not dormant
    d: { type: "rect" },                                        // no shadow → nothing
  } } }] };
  const dormant = dormantShadows(doc);
  assert.equal(dormant.length, 1);
  assert.equal(dormant[0].id, "a");
});

test("withDormantShadowsNeutralized: dormant shadow → opacity 0, visible shadow untouched, idempotent", () => {
  const doc = { slides: [{ delta: { items: {
    a: { type: "rect", shadow: { dx: 3, dy: 3, blur: 0, color: "#000000", opacity: 0.5 } },
    b: { type: "rect", shadow: { dx: 3, dy: 3, blur: 4, color: "#000000", opacity: 0.5 } },
  } } }] };
  const { doc: fixed, neutralized } = withDormantShadowsNeutralized(doc);
  assert.equal(fixed.slides[0].delta.items.a.shadow.opacity, 0); // neutralized
  assert.equal(fixed.slides[0].delta.items.a.shadow.dx, 3);      // dx/dy left as stored
  assert.equal(fixed.slides[0].delta.items.b.shadow.opacity, 0.5); // visible shadow untouched
  assert.equal(neutralized.length, 1);
  // Idempotent: re-running finds nothing dormant.
  assert.equal(withDormantShadowsNeutralized(fixed).neutralized.length, 0);
});

test("repairedDocument neutralizes an old-default dormant shadow with a loud report", () => {
  const [doc, id] = withNewItem(newDocument(registry), 0, {
    type: "rect", x: 0, y: 0, w: 10, h: 10, active: true,
    shadow: { dx: 3, dy: 3, blur: 0, color: "#000000", opacity: 0.5 }, // old default
  });
  const { doc: fixed, reports } = repairedDocument(doc, registry);
  assert.equal(fixed.slides[0].delta.items[id].shadow.opacity, 0);
  assert.ok(reports.some((r) => r.includes(id) && r.includes("opacity 0")));
  // And it still renders through the strict IR.
  const state = evaluateState(foldState(fixed, 0, 1), registry).state;
  sceneIR(deriveRenderTree(state, registry));
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
  assert.ok(migratedOps.every((op) => op.op === "polygon"), "strokeWidth 0 must emit zero outline ops");
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

console.log(`\n${passed} repair tests passed`);
