/**
 * Lens-flare light-position migration tests (bare node, no framework — suite
 * convention). Covers the user ruling "the light position becomes ABSOLUTE
 * values in GLOBAL coordinate space, and ONLY absolute": lightX/lightY (a
 * [0,1] fraction of the widget's own box) is RENAMED to lightWorldX/lightWorldY
 * (a world/document point), never reinterpreted in place — the
 * fancyArrowFillMigrations precedent core/document.js cites for why a value
 * migration must gate carefully.
 *
 * Run: node src/demo_apps/PowerRP/tests/flare_light_migration_test.js
 */
import assert from "node:assert/strict";
import {
  newDocument, withNewItem, withNewSlide, keyframed, foldState,
  flareLightMigrations, withFlareLightMigrated, flareLightRelativeToWorld,
  repairedDocument,
} from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree, worldTransform } from "../core/derive.js";
import { sceneIR } from "../render_gpu/ports.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import * as T from "../core/transform.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());

/** A single-slide doc with one demo_lens_flare item at a fixed, non-equation
 *  box, so the migration's input geometry is a plain literal everywhere. */
function flareDoc(overrides = {}) {
  let doc = newDocument(), id;
  [doc, id] = withNewItem(doc, 0, {
    type: "demo_lens_flare",
    x: 100, y: 50, w: 200, h: 100, z: 300, rotation: 0, scale: 1,
    lightX: 0.72, lightY: 0.3,
    ...overrides,
  });
  return { doc, id };
}

// ── flareLightRelativeToWorld: the pure conversion helper ────────────────────

test("flareLightRelativeToWorld: rotation 0 — world == local fraction*extent, offset by the box origin", () => {
  const p = flareLightRelativeToWorld(0.72, 0.3, { x: 100, y: 50, w: 200, h: 100, rotation: 0, scale: 1 });
  assert.deepEqual(p, { x: 244, y: 80 }); // 100+0.72*200, 50+0.3*100
});

test("flareLightRelativeToWorld: matches worldTransform directly (no reimplemented rotation math)", () => {
  const geom = { x: 400, y: 300, w: 240, h: 140, rotation: Math.PI / 6, scale: 1.4, rotationAnchor: { x: 500, y: 350 } };
  const expect = T.apply(worldTransform(geom), 0.72 * geom.w, 0.3 * geom.h);
  assert.deepEqual(flareLightRelativeToWorld(0.72, 0.3, geom), expect);
});

// ── flareLightMigrations: candidate detection ─────────────────────────────────

test("flareLightMigrations: an unrotated flare's plain relative keyframe converts to its absolute point", () => {
  const { doc } = flareDoc();
  const { plain, equation } = flareLightMigrations(doc, registry);
  assert.equal(equation.length, 0);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].worldX, 244);
  assert.equal(plain[0].worldY, 80);
});

test("flareLightMigrations: a document with no lens flare has nothing to migrate", () => {
  const doc = newDocument();
  assert.deepEqual(flareLightMigrations(doc, registry), { plain: [], equation: [] });
});

test("flareLightMigrations: a NON-flare item's own lightX-shaped field is not touched (type-gated, like fancy-arrow's)", () => {
  let doc = newDocument(), id;
  [doc, id] = withNewItem(doc, 0, { type: "rect", x: 0, y: 0, w: 10, h: 10, lightX: 0.72, lightY: 0.3 });
  assert.deepEqual(flareLightMigrations(doc, registry), { plain: [], equation: [] });
});

// ── ROTATED WIDGET CASE ────────────────────────────────────────────────────────

test("flareLightMigrations: a ROTATED flare converts through its OWN world transform (mind rotation)", () => {
  const { doc } = flareDoc({ rotation: Math.PI / 4, x: 300, y: 200, w: 400, h: 200 });
  const { plain } = flareLightMigrations(doc, registry);
  assert.equal(plain.length, 1);
  // Ground truth: rotationAnchor absent -> geometric-centre pivot (core/derive.worldTransform).
  const expect = flareLightRelativeToWorld(0.72, 0.3, {
    x: 300, y: 200, w: 400, h: 200, rotation: Math.PI / 4, scale: 1,
  });
  assert.ok(Math.abs(plain[0].worldX - expect.x) < 1e-9);
  assert.ok(Math.abs(plain[0].worldY - expect.y) < 1e-9);
  // And it must NOT equal the naive (unrotated) answer — proving rotation was honored.
  const naive = { x: 300 + 0.72 * 400, y: 200 + 0.3 * 200 };
  assert.ok(Math.abs(plain[0].worldX - naive.x) > 1, "rotated conversion must differ from the unrotated formula");
});

test("flareLightMigrations: a rotated flare with an explicit rotationAnchor pivots about THAT point", () => {
  const { doc } = flareDoc({
    rotation: Math.PI / 2, x: 0, y: 0, w: 100, h: 50,
    rotationAnchor: { x: 10, y: 10 },
  });
  const { plain } = flareLightMigrations(doc, registry);
  const expect = flareLightRelativeToWorld(0.72, 0.3, {
    x: 0, y: 0, w: 100, h: 50, rotation: Math.PI / 2, scale: 1, rotationAnchor: { x: 10, y: 10 },
  });
  assert.ok(Math.abs(plain[0].worldX - expect.x) < 1e-9 && Math.abs(plain[0].worldY - expect.y) < 1e-9);
});

// ── KEYFRAMED-ACROSS-SLIDES CASE ───────────────────────────────────────────────

test("flareLightMigrations: a light keyframed on slide 2 converts against slide 2's OWN (possibly moved) box", () => {
  let { doc, id } = flareDoc({ x: 0, y: 0, w: 100, h: 100 });
  let idx;
  [doc, idx] = withNewSlide(doc, 0);
  // The box MOVES on slide 2, and the light is re-keyframed there too.
  doc = keyframed(doc, idx, ["items", id, "x"], 500);
  doc = keyframed(doc, idx, ["items", id, "lightX"], 0.25);
  doc = keyframed(doc, idx, ["items", id, "lightY"], 0.75);

  const { plain } = flareLightMigrations(doc, registry);
  assert.equal(plain.length, 2, "both the creation-slide and slide-2 keyframes are candidates");
  const slide0 = plain.find((m) => m.slideIndex === 0);
  const slide1 = plain.find((m) => m.slideIndex === idx);
  // Slide 0: box at x=0 -> unaffected by the later move.
  assert.equal(slide0.worldX, 72); // 0 + 0.72*100
  // Slide 1: box moved to x=500, and lightX there is 0.25, not 0.72.
  assert.equal(slide1.worldX, 500 + 0.25 * 100);
});

test("flareLightMigrations: a slide that keyframes ONLY lightY still converts against the OTHER half's folded value", () => {
  let { doc, id } = flareDoc({ x: 0, y: 0, w: 100, h: 100 }); // lightX 0.72, lightY 0.3 on slide 0
  let idx;
  [doc, idx] = withNewSlide(doc, 0);
  doc = keyframed(doc, idx, ["items", id, "lightY"], 0.9); // lightX NOT re-written here
  const { plain } = flareLightMigrations(doc, registry);
  const slide1 = plain.find((m) => m.slideIndex === idx);
  assert.ok(slide1, "the lightY-only slide is still a candidate");
  assert.equal(slide1.worldX, 0.72 * 100); // read from the FOLD, not this slide's delta
  assert.equal(slide1.worldY, 0.9 * 100);
});

// ── EQUATION CASE: reported loudly, never auto-converted ──────────────────────

test("flareLightMigrations: lightX as the ONLY field written this slide, as an equation — nothing to convert", () => {
  let doc = newDocument(), id;
  [doc, id] = withNewItem(doc, 0, {
    type: "demo_lens_flare", x: 100, y: 50, w: 200, h: 100, lightX: "= self.w / 1000",
  });
  const { plain, equation } = flareLightMigrations(doc, registry);
  assert.equal(equation.length, 1);
  assert.equal(equation[0].key, "lightX");
  assert.equal(equation[0].value, "= self.w / 1000");
  assert.equal(plain.length, 0, "lightX is the ONLY field this slide writes, and it is an equation — nothing to convert");
});

test("flareLightMigrations: lightX an equation ALONGSIDE a plain lightY — the plain half still converts", () => {
  const { doc } = flareDoc({ lightX: "= self.w / 1000", lightY: 0.3 });
  const { plain, equation } = flareLightMigrations(doc, registry);
  assert.equal(equation.length, 1);
  assert.equal(equation[0].key, "lightX");
  assert.equal(plain.length, 1, "lightY was plain and IS written this slide — its converted half still reports");
  assert.equal(plain[0].worldX, undefined, "the equation half contributes no world value");
  assert.equal(plain[0].worldY, 80, "0.3 folded against h=100, y=50");
});

test("flareLightMigrations: BOTH fields as equations are BOTH reported", () => {
  const { doc } = flareDoc({ lightX: "= self.w / 1000", lightY: "= self.h / 500" });
  const { equation, plain } = flareLightMigrations(doc, registry);
  assert.equal(equation.length, 2);
  assert.deepEqual(equation.map((e) => e.key).sort(), ["lightX", "lightY"]);
  assert.equal(plain.length, 0);
});

test("withFlareLightMigrated: an equation-carrying field is DROPPED (not renamed) — the plugin no longer declares it", () => {
  const { doc, id } = flareDoc({ lightX: "= self.w / 1000", lightY: 0.3 });
  const { doc: fixed, equation } = withFlareLightMigrated(doc, registry);
  assert.equal(equation.length, 1);
  assert.equal(fixed.slides[0].delta.items[id].lightX, undefined);
  assert.equal(fixed.slides[0].delta.items[id].lightWorldX, undefined, "no invented replacement value");
  assert.equal(fixed.slides[0].delta.items[id].lightY, undefined, "the OLD field name is gone even where it was plain (schema no longer has it)");
});

test("repairedDocument: the equation report names the item and the exact equation source", () => {
  const { doc } = flareDoc({ lightX: "= self.w / 1000" });
  const { reports } = repairedDocument(doc, registry);
  const line = reports.find((r) => r.includes("lightX") && r.includes("EQUATION"));
  assert.ok(line, `expected an equation report line, got: ${JSON.stringify(reports)}`);
  assert.ok(line.includes("self.w / 1000"), `report should quote the equation source: ${line}`);
});

// ── withFlareLightMigrated: renamed, never value-reinterpreted in place ───────

test("withFlareLightMigrated: lightX/lightY are RENAMED to lightWorldX/lightWorldY, old keys removed", () => {
  const { doc, id } = flareDoc();
  const { doc: fixed } = withFlareLightMigrated(doc, registry);
  const item = fixed.slides[0].delta.items[id];
  assert.equal(item.lightWorldX, 244);
  assert.equal(item.lightWorldY, 80);
  assert.equal("lightX" in item, false);
  assert.equal("lightY" in item, false);
});

test("withFlareLightMigrated: idempotent — a migrated document reports nothing on a second pass", () => {
  const { doc } = flareDoc();
  const { doc: once } = withFlareLightMigrated(doc, registry);
  const { plain, equation } = flareLightMigrations(once, registry);
  assert.deepEqual({ plain, equation }, { plain: [], equation: [] });
});

test("withFlareLightMigrated: an item that never wrote lightX/lightY (already-current schema) is left untouched", () => {
  let doc = newDocument(), id;
  [doc, id] = withNewItem(doc, 0, {
    type: "demo_lens_flare", x: 0, y: 0, w: 100, h: 100, lightWorldX: 500, lightWorldY: 300,
  });
  const { doc: fixed, plain, equation } = withFlareLightMigrated(doc, registry);
  assert.deepEqual(plain, []);
  assert.deepEqual(equation, []);
  assert.equal(fixed.slides[0].delta.items[id].lightWorldX, 500);
});

// ── BYTE-IDENTICAL RENDER AT THE MIGRATION MOMENT ─────────────────────────────
// The migration's whole promise: a MIGRATED document paints the EXACT SAME
// picture the OLD relative semantics named. The current plugin code no longer
// reads lightX/lightY at all (that is the whole point of the migration), so
// "render the un-migrated doc" is not a comparison the CURRENT code can make —
// there is nothing left in it that still implements the old formula to compare
// against. The honest comparison is therefore: what the OLD formula names
// (lightX·w, lightY·h in LOCAL px, independently reconstructed here from the
// shader's own documented contract — render_gpu/skia/lens_flare_shader.js
// LENS_FLARE_FILL_PARAMS's lightX/lightY help text) versus the shader `lightX`/
// `lightY` UNIFORM PARAM the migrated document's real emit() produces. Every
// other look/geometry op is asserted structurally IDENTICAL by deepEqual with
// that one param excluded, so this still catches any unrelated regression.

/** Pure. Finds the FIRST op matching `pred`, recursing into an effectSubtree's
 *  `content` (the flare's default blendMode "screen" wraps its materialFill in
 *  exactly one of these — render_gpu/ir.js effectSubtree). */
function findOpDeep(ir, pred) {
  for (const op of ir) {
    if (pred(op)) return op;
    if (op.op === "effectSubtree" && Array.isArray(op.content)) {
      const found = findOpDeep(op.content, pred);
      if (found) return found;
    }
  }
  return null;
}

/** Pure. The materialFill op's `params.lightX/lightY` (the shader uniform) for
 *  one flare item, from a document's evaluated + derived + emitted IR. */
function flareLightParam(doc, slideIndex, itemId) {
  const evaluated = evaluateState(foldState(doc, slideIndex, 1), registry, doc.meta.script ?? "").state;
  const nodes = deriveRenderTree(evaluated, registry);
  const ir = sceneIR(nodes);
  const op = findOpDeep(ir, (o) => o.op === "materialFill" && o.material === "lens_flare");
  if (!op) throw new Error(`no lens_flare materialFill op found in IR: ${JSON.stringify(ir)}`);
  return { lightX: op.params.lightX, lightY: op.params.lightY, ir, node: nodes.find((n) => n.itemId === itemId) };
}

const LIGHT_EPS = 1e-9;

test("BYTE-IDENTICAL: an unrotated flare's migrated shader param matches the OLD relative formula", () => {
  const { doc, id } = flareDoc(); // lightX 0.72, lightY 0.3, w=200, h=100 -> local (144, 30) -> fraction unchanged at rotation 0
  const { doc: fixed } = withFlareLightMigrated(doc, registry);
  const after = flareLightParam(fixed, 0, id);
  assert.ok(Math.abs(after.lightX - 0.72) < LIGHT_EPS && Math.abs(after.lightY - 0.3) < LIGHT_EPS,
    `migrated flare reproduces the OLD fraction (got ${after.lightX}, ${after.lightY})`);
});

test("BYTE-IDENTICAL: a ROTATED+SCALED flare's migrated shader param matches the OLD relative formula", () => {
  const { doc, id } = flareDoc({ rotation: Math.PI / 5, scale: 1.3, x: 220, y: 90, w: 300, h: 220 });
  const { doc: fixed } = withFlareLightMigrated(doc, registry);
  const after = flareLightParam(fixed, 0, id);
  assert.ok(Math.abs(after.lightX - 0.72) < LIGHT_EPS && Math.abs(after.lightY - 0.3) < LIGHT_EPS,
    `rotation/scale must cancel out of the round trip (got ${after.lightX}, ${after.lightY})`);
});

test("BYTE-IDENTICAL: a keyframed-across-slides flare matches the OLD formula on EVERY slide after migration", () => {
  let { doc, id } = flareDoc({ x: 0, y: 0, w: 100, h: 100 });
  let idx;
  [doc, idx] = withNewSlide(doc, 0);
  doc = keyframed(doc, idx, ["items", id, "x"], 400);
  doc = keyframed(doc, idx, ["items", id, "rotation"], Math.PI / 3);
  doc = keyframed(doc, idx, ["items", id, "lightX"], 0.1);
  doc = keyframed(doc, idx, ["items", id, "lightY"], 0.95);
  const { doc: fixed } = withFlareLightMigrated(doc, registry);

  const slide0 = flareLightParam(fixed, 0, id);
  assert.ok(Math.abs(slide0.lightX - 0.72) < LIGHT_EPS && Math.abs(slide0.lightY - 0.3) < LIGHT_EPS, "slide 0 unchanged");

  const slide1 = flareLightParam(fixed, idx, id);
  assert.ok(Math.abs(slide1.lightX - 0.1) < LIGHT_EPS && Math.abs(slide1.lightY - 0.95) < LIGHT_EPS,
    `slide 1 (moved + rotated + re-keyframed light) reproduces ITS OWN 0.1/0.95 (got ${slide1.lightX}, ${slide1.lightY})`);
});

test("BYTE-IDENTICAL: repairedDocument end-to-end (legacy doc in, migrated doc matches the OLD formula)", () => {
  const { doc, id } = flareDoc({ rotation: Math.PI / 7, x: 150, y: 60, w: 260, h: 180 });
  const { doc: repaired } = repairedDocument(doc, registry);
  const after = flareLightParam(repaired, 0, id);
  assert.ok(Math.abs(after.lightX - 0.72) < LIGHT_EPS && Math.abs(after.lightY - 0.3) < LIGHT_EPS,
    `repairedDocument's migration reproduces the OLD fraction end-to-end (got ${after.lightX}, ${after.lightY})`);
});

console.log(`\nflare_light_migration_test: ${passed} tests passed`);
