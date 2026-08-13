/**
 * THE EMPTY, AND THE RETIREMENT OF `anchor_point` — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/empty_migration_test.js
 *
 * User, 2026-08-13: "Empties. Replace the anchor widget. I want empties. Full
 * transform, blender-style." — grouped as "AM - which replaces anchor widget and
 * looks like blender empty".
 *
 * WHAT THE REPLACEMENT HAD TO PRESERVE, and therefore what this file guards.
 * `anchor_point` existed to be POINTED AT: its whole value is that other items'
 * equations name it, as `@<itemId>_pt.x` or, through the item's name, `<slug>.pt.x`.
 * So a migration that renames the type is only correct if BOTH halves of that
 * reference survive — the ITEM ID (the delta key, never rewritten) and the ANCHOR
 * ID `pt` (which the empty deliberately keeps). If either moved, every deck that
 * used the widget would load with silently dangling equations.
 *
 * AND THE ORDER IS THE MIGRATION. A retired type is by definition absent from the
 * registry, and repairedDocument's FIRST step drops items whose type is unknown.
 * So a rename placed after it does nothing at all: the widget is already purged,
 * every equation bound to it already dangling, and the only report is that
 * something unknown went away. §3 pins the ordering directly, on a real
 * pipeline run, because reading the source would not prove the outcome.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { emptyPlugin } from "../plugins/empty.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { cameraPlugin } from "../plugins/camera.js";
import { rectPlugin } from "../plugins/rect.js";
import {
  RETIRED_ITEM_TYPES, itemTypeMigrations, withItemTypesMigrated,
  repairedDocument, newDocument, uuid,
} from "../core/document.js";
import { evaluateState } from "../core/expressions.js";

const registry = createRegistry();
await registerPlugins(registry);

/** A one-slide document whose slide-0 delta creates `items` (the document model). */
const docOf = (items) => ({
  meta: { name: "t", w: 1920, h: 1080, script: "" },
  slides: [{ id: uuid(), name: "S1", transition: { type: "none", seconds: 0, curve: "linear", sound: null }, delta: { items } }],
});

// ── §1. THE WIDGET ITSELF ────────────────────────────────────────────────────

test("1a. the empty is registered and the anchor point is GONE from the roster", () => {
  assert.ok(registry.all().some((p) => p.type === "empty"), "empty must be registered");
  assert.equal(registry.all().some((p) => p.type === "anchor_point"), false,
    "anchor_point must not still be registered — a live alias would make the migration unnecessary and therefore silent");
});

test("1b. FULL TRANSFORM is the feature: rotation and scale are inspector rows, which anchor_point lacked", () => {
  const rows = new Set(emptyPlugin.inspector.map((r) => r.key));
  for (const key of ["x", "y", "z", "rotation", "scale"])
    assert.ok(rows.has(key), `the empty must publish a "${key}" row — the retired widget published x/y/z ALONE, which is the gap the user named`);
  // And every one is a real keyframable leaf, not just a row: the defaults carry it.
  for (const key of ["x", "y", "z", "rotation", "scale"])
    assert.ok(key in emptyPlugin.defaults, `"${key}" must be a stored property, not a display-only row`);
});

test("1c. it paints NOTHING and is a ghost — blender's empty is viewport-only", () => {
  assert.deepEqual(emptyPlugin.emit({ ...emptyPlugin.defaults }), [],
    "an empty has no geometry; its axis cross is editor chrome (CanvasView overlay), never sceneIR");
  assert.equal(emptyPlugin.capabilities.ghost, true);
  assert.equal(emptyPlugin.capabilities.resizable, false,
    "size is a DISPLAY size (blender's empty_display_size), not a bounding box to drag");
});

test("1d. BOUNDS protocol: localBounds is declared, so culling and band select can see it", () => {
  assert.deepEqual(emptyPlugin.localBounds({ w: 20, h: 20 }), { x: 0, y: 0, w: 20, h: 20 });
  // NEGATIVE EXTENTS protocol: a stored w/h may be negative (a flip). The plugin
  // reads what it is handed; the sign is resolved upstream at one map. What must
  // hold here is that it does not throw or invent a sign of its own.
  assert.deepEqual(emptyPlugin.localBounds({ w: -20, h: 20 }), { x: 0, y: 0, w: -20, h: 20 });
});

test("1e. the anchors: `pt` is the CENTRE and keeps its id, plus the four axis tips", () => {
  const a = emptyPlugin.anchors({ w: 20, h: 20 });
  const byId = new Map(a.map((p) => [p.id, p]));
  assert.deepEqual(byId.get("pt"), { id: "pt", x: 10, y: 10 }, "`pt` is the centre — the id every legacy equation names");
  assert.deepEqual(byId.get("+x"), { id: "+x", x: 20, y: 10 });
  assert.deepEqual(byId.get("-x"), { id: "-x", x: 0, y: 10 });
  assert.deepEqual(byId.get("+y"), { id: "+y", x: 10, y: 20 });
  assert.deepEqual(byId.get("-y"), { id: "-y", x: 10, y: 0 });
  // The tips are the visible ends of the drawn cross, which is what makes them
  // worth publishing: the display size moves them, and that is its whole job.
  const big = new Map(emptyPlugin.anchors({ w: 100, h: 100 }).map((p) => [p.id, p]));
  assert.equal(big.get("+x").x, 100, "a larger display size moves the arm tip");
});

// ── §2. THE PURE MIGRATION ───────────────────────────────────────────────────

test("2a. the retired-type table says anchor_point → empty, and nothing else about it", () => {
  // SCOPED TO THIS RETIREMENT, deliberately. This used to assert the whole table
  // deep-equalled `{anchor_point: "empty"}` — which was true on the day it was
  // written and became a FALSE FAILURE the moment a second widget was retired
  // (html_capture → html2image, 2026-08-13). A table shared by every retirement
  // cannot be pinned exhaustively by the test of ONE of them: the next entry would
  // redden this file for a change that has nothing to do with empties. So it pins
  // its own row, and that `anchor_point` is not ALSO a destination (a retirement
  // that pointed at a retired type would migrate into another migration).
  assert.equal(RETIRED_ITEM_TYPES.anchor_point, "empty");
  assert.ok(!Object.values(RETIRED_ITEM_TYPES).includes("anchor_point"),
    "nothing may migrate TO the retired anchor_point");
});

test("2b. every slide that WRITES the type is found and rewritten", () => {
  // A type may be re-stated on later slides; each write is a separate legacy
  // occurrence and each must be migrated, or the fold would flip back mid-deck.
  const doc = {
    slides: [
      { delta: { items: { a: { type: "anchor_point", x: 5 }, r: { type: "rect", x: 1 } } } },
      { delta: { items: { a: { type: "anchor_point", x: 9 } } } },
      { delta: { items: { a: { x: 12 } } } }, // a keyframe with no type write — nothing to migrate
    ],
  };
  const found = itemTypeMigrations(doc);
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], { id: "a", slideIndex: 0, from: "anchor_point", to: "empty" });
  assert.deepEqual(found[1], { id: "a", slideIndex: 1, from: "anchor_point", to: "empty" });
  const { doc: out } = withItemTypesMigrated(doc);
  assert.equal(out.slides[0].delta.items.a.type, "empty");
  assert.equal(out.slides[1].delta.items.a.type, "empty");
  assert.equal(out.slides[0].delta.items.a.x, 5, "ONLY the type leaf changes — every other authored value survives");
  assert.deepEqual(out.slides[0].delta.items.r, { type: "rect", x: 1 }, "an untouched item is untouched");
  assert.deepEqual(out.slides[2], doc.slides[2], "a slide with nothing to migrate is the SAME object");
});

test("2c. IDEMPOTENT: a current document comes back unchanged, as the same object", () => {
  const doc = { slides: [{ delta: { items: { a: { type: "empty", x: 5 } } } }] };
  const { doc: out, migrated } = withItemTypesMigrated(doc);
  assert.equal(migrated.length, 0);
  assert.equal(out, doc, "no copy is made when nothing changed — this is what keeps repairedDocument reporting zero");
});

// ── §3. THE PIPELINE: ORDER, LOUDNESS, AND THE EQUATIONS ─────────────────────

test("3a. a legacy anchor_point SURVIVES the load as an empty, and the repair says so LOUDLY", () => {
  const doc = docOf({
    cam: { ...registry.get("camera").defaults, type: "camera" },
    ap: { type: "anchor_point", x: 100, y: 200, w: 20, h: 20, z: 0, rotation: 0, scale: 1, opacity: 1 },
  });
  const { doc: out, reports } = repairedDocument(doc, registry);
  const items = out.slides[0].delta.items;
  assert.ok(items.ap, "THE ITEM MUST STILL EXIST — this is the whole test; the orphan step would have purged it");
  assert.equal(items.ap.type, "empty");
  assert.equal(items.ap.x, 100, "its authored position survives");
  assert.equal(items.ap.y, 200);
  const line = reports.find((r) => r.includes('retired type "anchor_point"'));
  assert.ok(line, `the migration must be REPORTED (silent repairs are forbidden). Got: ${JSON.stringify(reports)}`);
  assert.match(line, /empty/, "the report must name what it became");
  assert.match(line, /_pt|anchor id is unchanged/, "and must tell the author their equations still resolve");
  assert.equal(reports.some((r) => r.includes('dropped item "ap"')), false,
    "the item must NEVER be reported as dropped — that is the ordering defect this migration exists to avoid");
});

test("3b. THE ORDERING, stated as a counterfactual: with the type unknown, the item IS purged", () => {
  // Proves the hazard is real rather than hypothetical: a registry that does not
  // know `empty` either (i.e. the rename never happened) purges the widget. That
  // is exactly what would ship if the migration ran after the orphan drop.
  // A registry built from the plugin MODULES, not from `registry.get(...)`:
  // register() decorates what it stores (tool groups, preset rows), and feeding a
  // decorated plugin back in is rejected loudly.
  const bare = createRegistry();
  bare.register(cameraPlugin);
  bare.register(rectPlugin);
  const doc = docOf({
    cam: { ...registry.get("camera").defaults, type: "camera" },
    ap: { type: "some_type_no_registry_knows", x: 100, y: 200 },
  });
  const { doc: out, reports } = repairedDocument(doc, bare);
  assert.equal(out.slides[0].delta.items.ap, undefined, "an unmigrated unknown type IS purged");
  assert.ok(reports.some((r) => r.includes('dropped item "ap"')));
});

test("3c. AN EQUATION BOUND TO THE OLD WIDGET STILL RESOLVES AFTER THE MIGRATION", () => {
  // The reference is `@<itemId>_pt` — item id + anchor id — and the migration
  // touches neither. This is the end-to-end proof that the rename is safe, run
  // through the real evaluator on the real repaired document.
  const doc = docOf({
    cam: { ...registry.get("camera").defaults, type: "camera" },
    ap: { type: "anchor_point", x: 100, y: 200, w: 20, h: 20, z: 0, rotation: 0, scale: 1, opacity: 1 },
    ar: { ...arrowPlugin.defaults, from: { x: 0, y: 0 }, to: { x: "@ap_pt.x", y: "@ap_pt.y" } },
  });
  const { doc: repaired } = repairedDocument(doc, registry);
  const items = repaired.slides[0].delta.items;
  const { state, errors } = evaluateState({ items, vars: {} }, registry);
  assert.equal(errors.size, 0, `the migrated document must evaluate cleanly. Got: ${JSON.stringify([...errors])}`);
  assert.equal(state.items.ar.to.x, 110, "@ap_pt.x = the empty's centre = x + w/2 — the SAME value the anchor point gave");
  assert.equal(state.items.ar.to.y, 210);
});

test("3d. a document containing an empty and nothing legacy repairs to ZERO reports", () => {
  // The idempotence bar the whole repair pipeline is held to: authoring today must
  // not print a repair line tomorrow.
  const doc = docOf({
    cam: { ...registry.get("camera").defaults, type: "camera" },
    e: { ...emptyPlugin.defaults },
  });
  const { reports } = repairedDocument(doc, registry);
  assert.deepEqual(reports, [], `a current-schema document must report nothing. Got: ${JSON.stringify(reports)}`);
});

test("3e. a FRESH document still repairs to zero — the roster swap broke nothing else", () => {
  const { reports } = repairedDocument(newDocument(), registry);
  assert.deepEqual(reports, [], `newDocument() must be clean. Got: ${JSON.stringify(reports)}`);
});
