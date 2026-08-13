/**
 * THE TRAIL-PRESET PIXEL-DISTINCTNESS GATE — bare node, real Skia, real pixels,
 * over a SIMULATED trail rather than a static widget (ledger C-16, restated for
 * the fourth kind of state).
 *
 * ── WHY A NAIVE STILL RENDER PROVES NOTHING HERE ─────────────────────────────
 * A trail with no injected history is a dot (plugins/trail.js's own header: "the
 * editor shows a dot, and that is the ruling, not a gap" — presented time is
 * frozen there). Two presets with wildly different `seconds`/taper/colour ramps
 * would render IDENTICAL single ellipses if compared at the frozen initial
 * condition — the look their names promise only exists once the clock has run.
 * So this file does what tests/trail_test.js does to pin the simulation laws:
 * it drives `advanceTrailHistory` through many simulated steps with the particle
 * clock override (never wall time — the Δt law), building a real ring of samples
 * for each preset, THEN emits and rasterizes that state.
 *
 * ── THE FIXTURE: ONE SHARED MOVING POINT, STEPPED THROUGH SIMULATION FRAMES ──
 * Every preset's trail is anchored to the SAME scripted path (a sweeping arc) so
 * that geometry is never the independent variable — only the preset's own look
 * knobs (seconds/width/tailWidth/color/tailColor/tailOpacity/opacity/effects)
 * can be responsible for a measured difference. `freshRun` resets the shared
 * simulation table between presets so no trail inherits another's ring.
 *
 * ── WHY BARE NODE ─────────────────────────────────────────────────────────────
 * A trail emits ordinary `polygon`/`ellipse` ops (plugins/trail.js), exactly the
 * vector case cli/render.js's software Skia surface exists for — no Chrome, no
 * capture-hang risk, deterministic. Same renderToPng + litSetDistance seam
 * tests/rect_presets_test.js uses.
 *
 * ── REFERENCE AND BACKDROP, SAME REASONING AS rect_presets_test.js ───────────
 * The lit-set reference is a BLANK canvas, not the untouched default (several
 * presets are thin/tapered-to-zero streamers, the same "unfilled" shape that
 * forced the lit-set reduction for rect's outline/glow rows). The backdrop is
 * mid-grey so neither a bright preset (Comet Tail) nor a dark one (Ink Drag) nor
 * a blend-mode preset (Light-Cycle, screen-free here but bloom-heavy) is favoured.
 *
 * ── HONEST LEVEL ACHIEVED ─────────────────────────────────────────────────────
 * Full stepped-simulation rendering for EVERY preset (not a data-only check plus
 * one spot render): each of the 12 presets, plus the untouched default, is
 * stepped through the same 90-frame arc at a real particle-clock cadence and
 * rasterized. This is the level tests/rect_presets_test.js proves for a
 * non-simulated widget, carried over to the fourth kind of state.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { evaluateState } from "../core/expressions.js";
import { resetSimulation, setSimulationTimestepOverride } from "../core/simulation_history.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { advanceTrailHistory } from "../core/trail_history.js";
import { trailPlugin, trailInsertState } from "../plugins/trail.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());
// registerAll DECORATES each plugin object (toolGroups, etc.), so the registered
// trail is not reference-equal to the bare import — assert on the one thing that
// actually matters: it carries the SAME presets array this file is testing.
assert.equal(registry.get("trail").presets, trailPlugin.presets, "the registered trail plugin must carry the same presets table this file imports");

const W = 400, H = 260;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
// Mid grey: see the header, and rect_presets_test.js's own measured reason —
// neither a light nor a dark nor a screen/bloom-heavy preset is favoured.
const BACKGROUND = "#808080";
// A sweeping arc comfortably inside the canvas, so a wide preset's bloom/softEdges
// halo has room to render fully rather than clipping at the frame edge.
const CENTER = { x: 200, y: 150 };
const RADIUS = 80;
// 90 frames at 60fps = 1.5s of simulated motion — enough to fill even the widest
// preset's window (Jet Contrail, 8s, decimated) with a visible arc of samples,
// and short enough that the whole 13-frame sweep (12 presets + default) is cheap.
const SIM_FRAMES = 90;
const SIM_FPS = 60;

/** Pure function. The shared scripted point every preset's trail follows, at
 *  simulation frame `frame` — a point sweeping a quarter-circle arc, so the
 *  fixture exercises curvature (the ribbon's mitred joints) rather than a
 *  straight line alone.
 *
 *  @example sweepPoint(0) // {x: 280, y: 150}
 */
function sweepPoint(frame) {
  const t = frame / SIM_FRAMES;
  const angle = (Math.PI / 2) * t;
  return { x: CENTER.x + RADIUS * Math.cos(angle), y: CENTER.y + RADIUS * Math.sin(angle) };
}

/** Command (mutates the shared simulation table; near-pure otherwise — every run
 *  with the same props produces the identical ring, per trail_test.js's own
 *  EXACTLY REPRODUCIBLE law). Resets the simulation, then steps ONE trail item
 *  (built from `props` as an overlay on trailInsertState) through SIM_FRAMES of
 *  the shared sweep, returning the fully-evaluated final-frame item — history
 *  and all — ready for emit().
 *
 *  @param {object} props - preset props (or {} for the untouched default)
 *  @returns {object} the evaluated trail item state at the last simulated frame
 */
function stepPresetTrail(props) {
  setSimulationTimestepOverride(null);
  resetSimulation();
  setParticleTimeOverride(0);
  let item = null;
  for (let frame = 0; frame <= SIM_FRAMES; frame++) {
    const t = frame / SIM_FPS;
    setParticleTimeOverride(t);
    const { x, y } = sweepPoint(frame);
    const state = { vars: {}, items: { t1: { ...trailInsertState(props), name: "Trail", x, y } } };
    const pass = evaluateState(state, registry);
    advanceTrailHistory(pass.state, registry);
    item = pass.state.items.t1;
  }
  return item;
}

/** Near-pure function (renders via a Skia surface; deterministic at a frozen
 *  clock/fixed simulation trajectory — trail_test.js's EXACTLY REPRODUCIBLE law —
 *  so it behaves like a pure function of `props` for this file's purposes). One
 *  fully-simulated trail preset, rasterized to decoded RGBA.
 *
 *  @param {object} props - preset props overlay (or {} for the default)
 *  @returns {Promise<{width:number,height:number,data:Buffer}>}
 */
async function frame(props) {
  const item = stepPresetTrail(props);
  const world = { x: item.x, y: item.y, rotation: 0, scale: 1 };
  const ops = trailPlugin.emit(item, null, world);
  return readPng(await renderToPng(ops, VIEW, { width: W, height: H, background: BACKGROUND }));
}

test("the sweep found the trail preset table at all", () => {
  assert.ok(Array.isArray(trailPlugin.presets) && trailPlugin.presets.length >= 10,
    `trailPlugin.presets is ${JSON.stringify(trailPlugin.presets)} — expected the R7-39 table (>= 10 presets)`);
});

test("EVERY trail preset writes the IDENTICAL key set, and none touches placement or clock state", () => {
  const sets = new Set(trailPlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
  assert.equal(sets.size, 1, `trail presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  const FORBIDDEN = ["x", "y", "z", "age", "trail_points"];
  for (const preset of trailPlugin.presets)
    for (const key of FORBIDDEN)
      assert.ok(!(key in preset.props), `trail preset "${preset.name}" writes forbidden key "${key}" — presets are look-only overlays, never placement or simulated-clock state`);
});

// "Nothing applied" is an EMPTY canvas (rect_presets_test.js's BLANK), not the
// widget's own default emission — the lit-set reference must be neutral to every
// candidate, including the tapered-to-zero and near-transparent presets.
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKGROUND }));

const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
for (const preset of trailPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

/** Pure function. The RIBBON ops a trail emitted, unwrapped from applyEffects'
 *  effectSubtree when a preset has an active effect (bloom, softEdges, …) —
 *  render_gpu/effects.js wraps content in ONE effectSubtree op whenever any
 *  effect is on, so counting top-level ops alone would misread an effect-bearing
 *  multi-segment ribbon as "one op". */
function ribbonOps(ops) {
  return ops.length === 1 && ops[0].op === "effectSubtree" ? ops[0].content : ops;
}

test("every preset frame actually recorded simulated history, not just a frozen dot", () => {
  // A dot-only render is a single ellipse; a real ribbon renders MANY polygon ops.
  // This is a fixture sanity check, not the distinctness gate below — it protects
  // this file's own "honest level achieved" claim.
  for (const preset of trailPlugin.presets) {
    const item = stepPresetTrail(preset.props);
    const raw = trailPlugin.emit(item, null, { x: item.x, y: item.y, rotation: 0, scale: 1 });
    // pushTransform/popTransform may bracket the ribbon (effect substrate framing);
    // the ribbon proper is everything else, and it must be MANY polygons — a
    // dot-only render is a single "ellipse" op with no polygons at all.
    const polygons = ribbonOps(raw).filter((op) => op.op === "polygon");
    const other = ribbonOps(raw).filter((op) => !["polygon", "pushTransform", "popTransform"].includes(op.op));
    assert.ok(polygons.length > 3 && other.length === 0,
      `preset "${preset.name}" rendered ${polygons.length} polygon(s) and unexpected ops [${other.map((o) => o.op).join(",")}] inside ${raw.map((o) => o.op).join(",")} — expected a multi-segment simulated ribbon, not a frozen dot`);
  }
});

// Calibrated the same way rect_presets_test.js calibrates its own family: MEASURED
// against this table's own closest pair (Smoke Wisp <-> Sparkler Arc, 8.69
// lit-set levels — two short-window, translucent presets that started this close
// enough to force a real redesign of a colliding pair, "Meteor", to a cold-blue
// unbloomed streak so it stopped reading as "Sparkler Arc" with different colours).
// MIN_SEPARATION sits at 6, below that measured floor with headroom, the same
// shape rect_presets_test.js and arrow_presets_test.js use.
const MIN_SEPARATION = 6;

test(`trail: ${trailPlugin.presets.length} presets and the default all render a DIFFERENT simulated picture`, () => {
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `trail: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

setParticleTimeOverride(null);
setSimulationTimestepOverride(null);
resetSimulation();
console.log(`\n${passed} trail-preset tests passed`);
