/**
 * THE PRESET-SWITCH SWEEP (R7-31) — all 187 PowerPoint AutoShapes must render,
 * anchor and offer handles WITHOUT THROWING, under an `adj` map that belongs to
 * some OTHER preset.
 *
 * WHY THIS TEST EXISTS, stated as the bug it would have caught. The `preset`
 * Inspector row is an ordinary select writing ONE leaf, so `state.adj` KEEPS THE
 * PREVIOUS PRESET'S GUIDE NAMES across a switch, and `foldGuides`
 * (core/pptx/preset_geometry.js) loudly refuses an adj name absent from the new
 * preset's `avLst`. Measured on the unfixed tree, with the plugin's own
 * `effectiveAdjOf`: every insert ships roundRect's `{adj: 16667}`, declared by
 * only 39 of 187 presets, so 148 threw on switch — and the 81 that ALSO declare
 * an `ahLst` threw from `modifierPoints`, which was called bare from
 * web/CanvasView.svelte and took the whole editor down on SELECTING the item.
 * Under a maximally-poisoned adj (the union of every preset's avLst keys, which
 * ONE handle drag can approach because `adjFromHandleDrag` returns the FULL
 * effective adj) it was 187/187 geometry and 120/120 handles.
 *
 * THE TWO CASES ARE (a) THE REAL GESTURE AND (b) ITS WORST CASE. Case (a) —
 * every preset carrying the insert default `{adj: 16667}` — is literally what
 * the user does: insert a shape, change the dropdown. Case (b) — every preset
 * carrying the UNION of all 187 avLst maps — is the poisoned document a handle
 * drag produces, and is the strictly stronger claim: if a preset survives every
 * stale key at once, it survives any subset.
 *
 * IT GOES THROUGH THE PLUGIN, NOT THE EVALUATOR. `effectiveAdjOf` is where the
 * fix lives, so a test that called `presetShapePath` directly would still throw
 * 187/187 and prove nothing about what the widget does. Every assertion here
 * enters through `pptxPresetPlugin`'s own emit/anchors/modifierPoints/morphPaths,
 * i.e. the four entry points a selected, rendered, morphing item actually uses.
 *
 * Bare node, no browser:
 *   node src/demo_apps/PowerRP/tests/preset_switch_test.js
 */
import assert from "node:assert";
import { pptxPresetPlugin } from "../plugins/pptx_preset.js";
import presetShapeDefsFile from "../core/pptx/preset_shape_defs.json" with { type: "json" };
import { pathDToSubpaths } from "../core/morph_payload.js";
import { nodeModifierPoints } from "../core/derive.js";

const DEFS = presetShapeDefsFile.shapes;
const PRESETS = Object.keys(DEFS).sort();
const W = 200, H = 140;
const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

/** The insert default every new pptxPreset item ships — roundRect's only key. */
const INSERT_ADJ = { adj: 16667 };

/** Pure function. The maximally-poisoned adj: every guide name any preset
 *  declares, in one map. This is the worst state a handle drag can leave
 *  behind, since `adjFromHandleDrag` writes the FULL effective adj.
 *
 *  IT IS GENUINELY EXHAUSTIVE, not merely large: the whole 187-shape table uses
 *  only ELEVEN distinct guide names (`adj`, `adj1`..`adj8`, `hf`, `vf`), so this
 *  union is every key any adj map can ever contain. A preset that survives it
 *  survives every possible stale-key subset — which is what makes case 2 a proof
 *  rather than a sample. (Counts, measured: 64 presets declare no adjustment, and
 *  the rest declare 1..8.) */
function poisonedAdjUnion(defs) {
  const all = {};
  for (const name of Object.keys(defs)) Object.assign(all, defs[name].avLst ?? {});
  return all;
}

const POISON = poisonedAdjUnion(DEFS);

/** Pure function. A widget state for `preset` carrying `adj` verbatim. */
function stateFor(preset, adj) {
  return { ...pptxPresetPlugin.defaults, preset, adj, w: W, h: H };
}

/** The four entry points a selected, rendered, morphing item exercises. A throw
 *  from ANY of them is the bug; the caller reports which preset and which one. */
function exerciseAll(state) {
  pptxPresetPlugin.emit(state, null, WORLD);
  pptxPresetPlugin.anchors(state);
  pptxPresetPlugin.modifierPoints(state);
  pptxPresetPlugin.morphPaths(state);
}

let failures = [];

// ── 1. EVERY PRESET SURVIVES THE INSERT DEFAULT (the real switch gesture) ─────
failures = [];
for (const preset of PRESETS) {
  try { exerciseAll(stateFor(preset, { ...INSERT_ADJ })); }
  catch (e) { failures.push(`${preset}: ${e.message}`); }
}
assert.deepEqual(failures, [], `presets throwing under the insert default adj {adj:16667}:\n${failures.join("\n")}`);
console.log(`ok   all ${PRESETS.length} presets render/anchor/handle/morph under the insert default adj`);

// ── 2. EVERY PRESET SURVIVES THE POISONED UNION (post-handle-drag worst case) ─
failures = [];
for (const preset of PRESETS) {
  try { exerciseAll(stateFor(preset, { ...POISON })); }
  catch (e) { failures.push(`${preset}: ${e.message}`); }
}
assert.deepEqual(failures, [], `presets throwing under the poisoned adj union:\n${failures.join("\n")}`);
console.log(`ok   all ${PRESETS.length} presets survive an adj carrying every one of the ${Object.keys(POISON).length} guide names the whole table uses`);

// ── 3. THE FILTER KEEPS THE VALUES THAT ARE REALLY THIS PRESET'S ──────────────
// Containment must not be achieved by ignoring the adjustment: a DECLARED key
// must still steer the geometry, or the fix would have "passed" by drawing every
// shape at its defaults forever.
{
  const d = (adj) => pptxPresetPlugin.emit(stateFor("roundRect", adj), null, WORLD)[0].d;
  const atDefault = d({ adj: 16667 });
  const atOther = d({ adj: 40000 });
  assert.notEqual(atDefault, atOther, "a DECLARED adj value still changes roundRect's geometry");
  // ...and a stale key riding alongside it changes nothing.
  assert.equal(d({ adj: 40000, hf: 105146, adj1: 12345 }), atOther,
    "stale keys from another preset are dropped, leaving the declared value's geometry untouched");
  console.log("ok   a declared adj still steers geometry; stale keys are inert");
}

// ── 4. HANDLE COUNTS ARE THE SHAPE'S OWN, POISONED OR NOT ────────────────────
// The handle-bearing presets must offer the SAME handles under a poisoned adj as
// under a clean one — degrading to zero handles would be containment, not a fix.
{
  const mismatched = [];
  for (const preset of PRESETS) {
    const clean = pptxPresetPlugin.modifierPoints(stateFor(preset, {})).length;
    const dirty = pptxPresetPlugin.modifierPoints(stateFor(preset, { ...POISON })).length;
    if (clean !== dirty) mismatched.push(`${preset}: ${clean} clean vs ${dirty} poisoned`);
  }
  assert.deepEqual(mismatched, [], `handle counts must not change with a poisoned adj:\n${mismatched.join("\n")}`);
  const withHandles = PRESETS.filter((p) => pptxPresetPlugin.modifierPoints(stateFor(p, {})).length > 0).length;
  assert.equal(withHandles, 120, `120 of 187 presets declare at least one adjust handle (got ${withHandles})`);
  console.log(`ok   handle counts identical clean vs poisoned; ${withHandles} presets carry handles`);
}

// ── 5. THE L-AFTER-Z GRAMMAR (the second, independent R7-31 bug) ─────────────
// `Z` ends a subpath and leaves the pen at its start; a following segment command
// begins a NEW subpath there with no second `M` (SVG 1.1 §8.3.3). Six vendored
// presets use exactly that, and the parser used to dereference a null subpath.
{
  const sp = pathDToSubpaths("M0 0L10 0L5 8ZL20 20");
  assert.equal(sp.length, 2, "L after Z opens a second subpath");
  assert.deepEqual(sp[1].start, [0, 0], "the restarted subpath begins at the pen (the closed subpath's start)");
  assert.equal(sp[0].closed, true, "the first subpath is still closed");
  assert.equal(pathDToSubpaths("M0 0L10 0L5 8ZC1 1 2 2 3 3").length, 2, "C after Z also restarts");
  assert.equal(pathDToSubpaths("M0 0L10 0L5 8ZQ1 1 3 3").length, 2, "Q after Z also restarts");
  console.log("ok   a draw command after Z restarts a subpath at the pen");

  // The six real shapes whose vendored paths contain `moveTo, close, lnTo`.
  const CALLOUTS = ["accentCallout1", "accentCallout2", "accentCallout3",
                    "accentBorderCallout1", "accentBorderCallout2", "accentBorderCallout3"];
  for (const preset of CALLOUTS) {
    const payload = pptxPresetPlugin.morphPaths(stateFor(preset, {}));
    assert.ok(payload.subpaths.length > 0, `${preset} yields morph subpaths`);
  }
  console.log(`ok   all ${CALLOUTS.length} accent callouts produce a morph payload`);
}

// ── 6. THE DERIVE BOUNDARY CONTAINS A THROWING PLUGIN ────────────────────────
// nodeModifierPoints is called BARE from CanvasView/app.svelte.js, so an
// uncontained throw here is an app-level pageerror — the user's "it crashes".
{
  const thrower = { modifierPoints: () => { throw new Error("synthetic modifierPoints failure"); } };
  const node = { itemId: "test-item", type: "pptxPreset", state: { w: 10, h: 10 }, world: WORLD, plugin: thrower };
  const points = nodeModifierPoints(node);
  assert.deepEqual(points, [], "a throwing plugin costs its own handles, not the app");
  console.log("ok   nodeModifierPoints contains a plugin throw (reported above, not rethrown)");
}

console.log("\nPASS — preset switch sweep");
