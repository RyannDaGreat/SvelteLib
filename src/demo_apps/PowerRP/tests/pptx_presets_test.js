/**
 * THE PPTX-PRESET-SHAPE FAMILY GATE — bare node, real Skia, real pixels.
 *
 * (1) THE ADJ HAZARD CHECK, IN TWO HALVES, BECAUSE ONE HALF PROVES NOTHING
 * ALONE. `pptxPreset`'s `adj` map is NAMED and PER-SHAPE (roundRect declares
 * only `adj`; pie declares `adj1`/`adj2`; star5 declares `adj`/`hf`/`vf`, ...).
 *
 *   (1a) EVERY ROW FOLDS THROUGH THE REAL EVALUATOR — the plugin's own
 *   emit/anchors/modifierPoints/morphPaths, the same four entry points
 *   tests/preset_switch_test.js exercises for the whole 187-shape catalog —
 *   and any throw fails by name.
 *
 *   (1b) EVERY ROW'S adj IS CHECKED AS DATA, against the shape's own `avLst`
 *   and its own `ahLst` min/max. THIS HALF IS THE LOAD-BEARING ONE, and the
 *   reason is that (1a) CANNOT FAIL for a bad row: `effectiveAdjOf` DROPS an
 *   override the current preset does not declare (deliberately — it is what
 *   makes the `preset` selector survivable), and `foldGuides` PINS an
 *   out-of-range value rather than rejecting it. So a borrowed guide name or a
 *   value past its handle's max renders happily and silently means nothing.
 *   This file used to assert (1b) against a hand-listed vocabulary of eleven
 *   generic names (`adj`, `adj1`…`adj8`, `hf`, `vf`), which every plausible
 *   borrowed key is a member of; a fabricated `{preset: "roundRect",
 *   adj: {hf: 123, adj2: 5}}` passed the whole file. It now reads
 *   `preset_shape_defs.json` directly, and it caught a real one: `leftBrace`
 *   shipped adj1 = 45000 against its own maxAdj1 of 25000.
 *
 * (2) PAIRWISE PIXEL DISTINCTNESS (C-16), following tests/arrow_presets_test.js's
 * shape: render the widget's own untouched default plus all ten presets, and
 * assert no two of the resulting pictures collide under `litSetDistance`
 * (lit-set-only, so background bulk cannot dilute a real difference).
 *
 * Bare node, no browser (pptxPreset is pure vector geometry — polylines,
 * cubic Beziers and arcs from `core/pptx/preset_geometry.js`, nothing that
 * needs a GPU), matching arrow_presets_test.js's own reasoning for staying
 * off Chrome:
 *   node src/demo_apps/PowerRP/tests/pptx_presets_test.js
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { BUNDLES } from "../core/properties.js";
import { foldGuides } from "../core/pptx/preset_geometry.js";
import { parseAhLst, resolveHandleBound } from "../core/pptx/preset_handles.js";
import { pptxPresetPlugin } from "../plugins/pptx_preset.js";
import presetShapeDefsFile from "../core/pptx/preset_shape_defs.json" with { type: "json" };

/** The vendored preset table, read STRAIGHT from the JSON rather than through
 *  the plugin, so this file checks the plugin's rows against PowerPoint's own
 *  declarations instead of against the plugin's own idea of them. */
const DEFS = presetShapeDefsFile.shapes;

let passed = 0;
function test(name, fn) {
  // AN ASYNC BODY IS REFUSED, BECAUSE THIS HARNESS DOES NOT AWAIT. The pixel
  // test below was once `async () => {…}`: `fn()` returned a promise nothing
  // held, so "ok" AND the passing summary printed before a single assertion in
  // it had run, and a real failure surfaced afterwards as a bare unhandled
  // rejection carrying no test name. Frames are rendered at module top level
  // instead (FRAMES below, the shape every sibling preset suite uses) and every
  // body here is synchronous; this throw is what keeps it that way.
  if (fn.constructor.name === "AsyncFunction")
    throw new Error(`test "${name}" was given an async body, but this harness does not await — render at module level and keep the body synchronous`);
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const W = 240, H = 200;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };
const BOX = { w: 200, h: 160 };

/** Near-pure function (renders through Skia; deterministic for a fixed
 *  state). One preset's state -> a decoded PNG, at a shared box size so every
 *  frame in the sweep is directly comparable. */
async function frame(props) {
  const state = { ...pptxPresetPlugin.defaults, ...BOX, ...props };
  return readPng(await renderToPng(pptxPresetPlugin.emit(state, null, WORLD), VIEW, { width: W, height: H }));
}

// "Nothing applied" for a widget is the canvas with no widget on it.
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H }));

// ── (1a) EVERY PRESET'S adj FOLDS THROUGH THE REAL GEOMETRY EVALUATOR, via all
// four entry points a selected/rendered/morphing item actually uses, with no
// throw. Necessary and NOT sufficient — see (1b) below and the header: a bad
// row cannot throw here, because the plugin filters undeclared names and the
// evaluator pins out-of-range values.
test(`all ${pptxPresetPlugin.presets.length} presets fold through the real geometry evaluator (emit/anchors/modifierPoints/morphPaths) without throwing`, () => {
  const failures = [];
  for (const preset of pptxPresetPlugin.presets) {
    const state = { ...pptxPresetPlugin.defaults, ...BOX, ...preset.props };
    try {
      const ir = pptxPresetPlugin.emit(state, null, WORLD);
      assert.ok(ir.length > 0, `"${preset.name}": emit produced no display-list ops`);
      pptxPresetPlugin.anchors(state);
      pptxPresetPlugin.modifierPoints(state);
      const morph = pptxPresetPlugin.morphPaths(state);
      assert.ok(morph.subpaths.length > 0, `"${preset.name}": morphPaths produced no subpaths`);
    } catch (e) {
      failures.push(`"${preset.name}" (preset=${state.preset}, adj=${JSON.stringify(preset.props.adj)}): ${e.message}`);
    }
  }
  assert.deepEqual(failures, [], `presets throwing through the real evaluator:\n${failures.join("\n")}`);
});

/** Every `<a:ahXY>`/`<a:ahPolar>` axis, as (guide-name attribute, min attribute,
 *  max attribute) — the four ways a handle can name an adjustment it drags and
 *  the bound attributes that go with each (core/pptx/preset_handles.js's
 *  parseAhLst produces exactly these keys). */
const HANDLE_AXES = [["gdRefX", "minX", "maxX"], ["gdRefY", "minY", "maxY"], ["gdRefR", "minR", "maxR"], ["gdRefAng", "minAng", "maxAng"]];

/**
 * Pure function. The DRAG RANGE a preset shape's own `ahLst` declares for each
 * adjustment guide, at a concrete box: `{gdName: {min, max}}`, with a side
 * `undefined` where the handle declares no bound. A guide with no handle at all
 * is absent from the result.
 *
 * THE BOX IS AN ARGUMENT BECAUSE THE BOUNDS MOVE WITH IT. 93 of the 574 bound
 * attributes the 243 vendored handles declare are GUIDE NAMES rather than
 * literals (counted off the table for this file; core/pptx/preset_handles.js's
 * header says 92 counting HANDLES rather than attributes, and that count
 * measures 90 today — re-measure rather than copying either number), so they are
 * resolved through `foldGuides` — `leftBrace`'s maxAdj1 is `q3*h/ss`, 25000 on a
 * box at least as wide as it is tall and larger on a tall one. A value checked
 * at one aspect ratio only is not checked.
 *
 * Args:
 *   shapeDef (object): one `preset_shape_defs.json` shapes entry (`{avLst, gdLst, ahLst, ...}`)
 *   adj (object): the effective adjustments to resolve named bounds against
 *   w (number), h (number): the box the bounds are evaluated at
 *
 * Returns:
 *   Record<string, {min: number|undefined, max: number|undefined}>
 *
 * @example // a literal-bounded handle: the numbers come straight off the XML
 * adjHandleBounds({avLst: {adj: 16667}, gdLst: [], ahLst: '<ahXY gdRefX="adj" minX="0" maxX="50000"><pos x="x1" y="t"/></ahXY>'}, {adj: 16667}, 200, 100)
 * // {adj: {min: 0, max: 50000}}
 * @example // leftBrace's max is the GUIDE maxAdj1 = q3*h/ss, so the box decides it
 * adjHandleBounds(DEFS.leftBrace, {adj1: 8333, adj2: 50000}, 200, 160).adj1 // {min: 0, max: 25000}
 * @example // ... and the same shape on a tall box allows more
 * adjHandleBounds(DEFS.leftBrace, {adj1: 8333, adj2: 50000}, 160, 200).adj1 // {min: 0, max: 31250}
 * @example // a shape whose ahLst reaches none of its avLst guides
 * adjHandleBounds({avLst: {adj: 5}, gdLst: [], ahLst: ""}, {adj: 5}, 100, 100) // {}
 */
function adjHandleBounds(shapeDef, adj, w, h) {
  const guides = foldGuides(shapeDef.avLst, adj, shapeDef.gdLst, w, h);
  const bounds = {};
  for (const handle of parseAhLst(shapeDef.ahLst))
    for (const [ref, minAttr, maxAttr] of HANDLE_AXES)
      if (handle[ref])
        bounds[handle[ref]] = { min: resolveHandleBound(handle[minAttr], guides), max: resolveHandleBound(handle[maxAttr], guides) };
  return bounds;
}

/**
 * Pure function. One preset row's EFFECTIVE adjustments — the shape's own avLst
 * defaults with the row's overrides layered on, exactly as the plugin's
 * `effectiveAdjOf` does (undeclared keys dropped), so the bounds below are
 * resolved against the table the shape is really drawn with.
 *
 * @example effectiveAdj(DEFS.roundRect, {adj: 50000}) // {adj: 50000}
 * @example effectiveAdj(DEFS.roundRect, {}) // {adj: 16667}
 * @example effectiveAdj(DEFS.roundRect, {hf: 3}) // {adj: 16667}
 */
function effectiveAdj(shapeDef, overrides) {
  const adj = { ...(shapeDef.avLst ?? {}) };
  for (const [key, value] of Object.entries(overrides ?? {})) if (key in adj) adj[key] = value;
  return adj;
}

// The boxes every row is range-checked at: the widget's OWN default box, this
// file's render box, and a tall one. More than one because a bound may be a
// guide (see adjHandleBounds) — a row legal only at the aspect it happened to be
// authored at stops meaning what its description says the moment it is resized.
const CHECK_BOXES = [
  { w: pptxPresetPlugin.defaults.w, h: pptxPresetPlugin.defaults.h },
  { w: BOX.w, h: BOX.h },
  { w: BOX.h, h: BOX.w },
];

test("every preset's adj writes ONLY guide names its own shape declares, each INSIDE that shape's own ahLst range", () => {
  // (1b), the half that can actually fail — read the vendored table directly.
  // The previous version of this test compared each key against a hand-listed
  // vocabulary of eleven generic names, which is a set every borrowed key
  // belongs to: {preset: "roundRect", adj: {hf: 123, adj2: 5}} passed it, and
  // passed emit() too, because effectiveAdjOf drops what the shape never
  // declared. Range is checked for the same reason: foldGuides PINS, so an
  // out-of-range value draws the clamped shape and the stored number is a lie
  // about the picture (leftBrace shipped adj1 = 45000 against a maxAdj1 of
  // 25000, drawing at 25000).
  const failures = [];
  let boundsChecked = 0;
  for (const preset of pptxPresetPlugin.presets) {
    const shape = preset.props.preset;
    const def = DEFS[shape];
    const declared = def.avLst ?? {};
    const overrides = preset.props.adj ?? {};
    for (const key of Object.keys(overrides))
      if (!(key in declared))
        failures.push(`"${preset.name}" (${shape}): adj key "${key}" is not one this shape declares (avLst: ${Object.keys(declared).join(", ") || "none"}) — effectiveAdjOf DROPS it, so the row writes nothing`);
    for (const box of CHECK_BOXES) {
      const bounds = adjHandleBounds(def, effectiveAdj(def, overrides), box.w, box.h);
      for (const [key, value] of Object.entries(overrides)) {
        const range = bounds[key];
        if (!range) continue; // an avLst guide no handle reaches: no declared range to be outside of
        boundsChecked += 1;
        if (range.min !== undefined && value < range.min)
          failures.push(`"${preset.name}" (${shape}): adj.${key} = ${value} is BELOW its handle's declared min ${range.min} at ${box.w}x${box.h} — foldGuides pins it, so the shape draws at ${range.min}`);
        if (range.max !== undefined && value > range.max)
          failures.push(`"${preset.name}" (${shape}): adj.${key} = ${value} is ABOVE its handle's declared max ${range.max} at ${box.w}x${box.h} — foldGuides pins it, so the shape draws at ${range.max}`);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  // The sweep must have SUBJECTS: if the rows stopped carrying handle-reachable
  // adjustments this check would pass while proving nothing, which is exactly
  // the failure mode it was written to replace.
  assert.ok(boundsChecked > 0, "no preset adj value resolved to a declared handle range — this check is proving nothing");
  console.log(`      adj values range-checked: ${boundsChecked} across ${CHECK_BOXES.length} box aspect ratios`);
});

// ── (2) PAIRWISE PIXEL DISTINCTNESS (C-16) ───────────────────────────────────
// Calibrated the same way tests/arrow_presets_test.js's MIN_SEPARATION was:
// 10 lit-set levels sits between a measured real collision and a measured
// real distinction on that family. This family shares the same metric.
const MIN_SEPARATION = 10;

// EVERY FRAME IS RENDERED HERE, AT MODULE LEVEL, under top-level await — the
// shape every sibling preset suite uses, and the reason the pixel test's body
// below can be (and must be, per `test`'s guard) synchronous. It sits AFTER the
// checks above on purpose: a preset whose emit() throws should fail (1a) by
// name, not die in this loop with only a module line number to go on.
const FRAMES = [{ name: "(DEFAULT)", png: await frame({}) }];
for (const preset of pptxPresetPlugin.presets) FRAMES.push({ name: preset.name, png: await frame(preset.props) });

test(`${pptxPresetPlugin.presets.length} presets and the untouched default all render a DIFFERENT picture`, () => {
  let narrowest = null;
  for (let i = 0; i < FRAMES.length; i++)
    for (let j = i + 1; j < FRAMES.length; j++) {
      const d = litSetDistance(FRAMES[i].png, FRAMES[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: FRAMES[i].name, b: FRAMES[j].name, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `"${FRAMES[i].name}" and "${FRAMES[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

test("every preset writes the IDENTICAL effects-bundle key set (no hover leak)", () => {
  // Application is an OVERLAY (app.applyPreset writes exactly the keys in
  // `props`), so a family whose rows disagree on which effect keys they touch
  // lets a previously-hovered row's value survive onto the next click. This
  // family sets all six effect heads (shadow/bloom/blendMode/innerShadow/
  // softEdges/gaussianBlur) on every row — verified here directly, mirroring
  // preset_contract_test.js's own gate (7) for this specific family.
  // DERIVED from BUNDLES.effects, not transcribed — the comment above already
  // claimed to mirror preset_contract_test.js's gate (7), which derives it. A
  // transcribed list cannot see a seventh effect head arriving, which is the
  // whole event this check exists for.
  const EFFECT_HEADS = [...new Set(BUNDLES.effects.map((k) => k.split(".")[0]))];
  for (const preset of pptxPresetPlugin.presets) {
    const missing = EFFECT_HEADS.filter((k) => !(k in preset.props));
    assert.deepEqual(missing, [], `"${preset.name}" omits ${missing.join(", ")} — a preset applied after another would leave that effect on`);
  }
});

test("no preset writes a placement key", () => {
  const PLACEMENT_KEYS = ["type", "x", "y", "z", "rotation", "scale", "rotationAnchor"];
  for (const preset of pptxPresetPlugin.presets) {
    const illegal = PLACEMENT_KEYS.filter((k) => k in preset.props);
    assert.deepEqual(illegal, [], `"${preset.name}" writes ${illegal.join(", ")} — a preset changes the look, never something already placed`);
  }
});

test("every preset names a real member of the 187 PowerPoint AutoShapes", () => {
  const validPresets = new Set(pptxPresetPlugin.inspector.find((r) => r.key === "preset").options);
  for (const preset of pptxPresetPlugin.presets)
    assert.ok(validPresets.has(preset.props.preset), `"${preset.name}": "${preset.props.preset}" is not a real preset shape name`);
});

test(`preset count is in the required range (10-14, got ${pptxPresetPlugin.presets.length})`, () => {
  assert.ok(pptxPresetPlugin.presets.length >= 10 && pptxPresetPlugin.presets.length <= 14);
});

console.log(`\n${passed} pptx-preset tests passed`);
