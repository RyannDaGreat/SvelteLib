/**
 * THE RECT-PRESET PIXEL-DISTINCTNESS GATE — bare node, real Skia, real pixels.
 *
 * WHAT IT PROVES: no two rect presets render the same picture, and none renders
 * the same picture as the widget's own UNTOUCHED DEFAULT (ledger C-16: a preset
 * identical to default is a dead row no preset-vs-preset comparison can ever
 * catch, because the default is not itself a preset).
 *
 * ── WHY BARE NODE ────────────────────────────────────────────────────────────
 * rect is pure vector (fill/stroke/effects), exactly the case cli/render.js's
 * software Skia surface exists for — no Chrome, no capture-hang risk,
 * deterministic. Same shared metric the browser probes use
 * (tests/imageDistinctness.js).
 *
 * ── WHY THE LIT-SET REDUCTION, NOT A WHOLE-FRAME MEAN ────────────────────────
 * MEASURED, not assumed to follow from "a rect is a filled box": four of this
 * family's twelve rows (Glass Panel, Neon Sign, Blueprint Outline, Dashed
 * Placeholder) are deliberately UNFILLED or near-transparent — a thin rim on a
 * large box, the exact geometry tests/arrow_presets_test.js's header describes
 * for connectors. A whole-frame mean (imageDistinctness.imageDistance) divides
 * their real differences by the empty interior they share and reported those
 * four within 4 code values of each other despite being visibly a magenta glow,
 * a frosted panel, a blue outline and a gapped grey line. litSetDistance
 * restricts the comparison to pixels either frame actually touches relative to
 * a REFERENCE — the region a preset is responsible for — which is exactly as
 * sound for a FILLED preset (its lit set is ~the whole box, so the number
 * barely moves) as for a thin one, so one metric serves the whole family.
 *
 * ── THE REFERENCE MUST BE AN EMPTY CANVAS, NOT THE UNTOUCHED DEFAULT ─────────
 * MEASURED, and this is the sharper trap of the two: an early version used
 * `frame({})` — the rect's OWN filled-and-stroked DEFAULT — as litSetDistance's
 * `reference`. That reference is itself a large filled box, so comparing two
 * UNFILLED presets (Neon Sign vs Blueprint Outline) against it makes their
 * shared, agreeing interior (both show backdrop through the empty fill) count
 * as "lit" — both differ hugely from the default's blue fill there — which
 * INFLATED their lit set to ~48% of the frame and buried the pair's real,
 * narrow-rim difference back under noise. The reference must be a canvas with
 * NOTHING drawn on it (renderToPng([], ...) — arrow_presets_test.js's BLANK),
 * so the lit set is exactly the union of what the two candidates actually
 * painted. The untouched (DEFAULT) rect is still one row IN the sweep (C-16
 * requires it), it is simply no longer also the yardstick the sweep measures
 * everything else against.
 *
 * ── WHY THE CANVAS IS MID-GRAY, NOT THE DEFAULT WHITE ────────────────────────
 * MEASURED, not assumed: rendered against node_render's default white
 * background, "Neon Sign" (blendMode: "screen", no fill) came back BYTE-IDENTICAL
 * to blank canvas everywhere — screen(white, x) = white for any x, so a glow
 * preset genuinely disappears on white. That is not a bug in the preset (a neon
 * sign is meant to sit on a dark slide, not nothing) and not a bug in screen
 * blending (it is doing exactly what screen blending does) — it is this test's
 * backdrop choice being unfair to a blend-mode-dependent preset. A backdrop
 * neutral enough not to favour a light-fill preset (Sticky Note) OR a
 * dark/blend preset (Neon Sign, Terminal Window) is required, so every frame
 * renders on a mid grey (#808080) rather than the renderer's own default.
 *
 * ── HOW THE BOUND WAS CALIBRATED ─────────────────────────────────────────────
 * The module ships only the DERIVABLE floor: at frozen clock the renderer is
 * deterministic, so the noise floor is zero and one 8-bit code value is the
 * smallest difference any display could show. "Far enough to be worth a
 * separate row" is a judgement, calibrated here against this family's own
 * MEASURED closest pair: Neon Sign <-> Blueprint Outline at 15.09 lit-set
 * levels (two thin, differently-coloured outlines with the smallest mutual
 * lit-set overlap in the table, 12.8%). "Glass Panel" was the first version's
 * narrowest pair at 8.02 — its `#eaf3ff33` fill composited to within ~4 code
 * values of the #808080 backdrop, a legitimately weak "frosted glass" look
 * that read as near-invisible rather than translucent, so its alpha and rim
 * were strengthened (`#eaf3ff88` / `#ffffffcc`) as a genuine preset-quality fix,
 * not a threshold adjustment. MIN_SEPARATION sits at 10, below the measured
 * 15.09 floor with headroom, the same shape arrow_presets_test.js uses.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
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
const rectPlugin = registry.get("rect");

const W = 400, H = 260;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
// A box comfortably clear of the canvas edge, so a shadow/bloom/blur halo has
// room to render fully rather than clipping — a clipped effect would make two
// genuinely different presets read closer than they are.
const BOX = { x: 60, y: 50, w: 280, h: 160 };
// See the header: node_render's own default background is white, which makes
// blendMode:"screen" a mathematical no-op (screen(white, x) = white) and was
// MEASURED to render "Neon Sign" byte-identical to blank canvas. Mid grey
// favours neither the light-fill presets nor the dark/blend ones.
const BACKGROUND = "#808080";

/** Near-pure function (renders via a Skia surface; deterministic at a frozen
 *  clock, so it behaves like a pure function of its arguments for this
 *  file's purposes). One rect frame as decoded RGBA.
 *
 *  @param {object} props - overlay on top of rectPlugin.defaults + BOX
 *  @returns {Promise<{width:number,height:number,data:Buffer}>}
 */
async function frame(props) {
  const state = { ...rectPlugin.defaults, ...BOX, ...props };
  return readPng(await renderToPng(rectPlugin.emit(state, null, VIEW), VIEW, { width: W, height: H, background: BACKGROUND }));
}

test("the sweep found the rect preset table at all", () => {
  assert.ok(Array.isArray(rectPlugin.presets) && rectPlugin.presets.length >= 10,
    `rectPlugin.presets is ${JSON.stringify(rectPlugin.presets)} — expected the R7-39 table (>= 10 presets)`);
});

// "Nothing applied" is an EMPTY canvas (arrow_presets_test.js's BLANK), NOT the
// rect's own filled default — see the header for why using the default as the
// reference inflates two unfilled presets' shared interior into "lit" pixels.
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKGROUND }));
const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
for (const preset of rectPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

// Calibrated against this family's own measured closest pair under litSetDistance
// with the corrected empty-canvas reference; see the header for the reasoning.
const MIN_SEPARATION = 10;

test(`rect: ${rectPlugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `rect: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

test("EVERY rect preset writes the IDENTICAL key set", () => {
  // Application is an OVERLAY (app.applyPreset), so a key one preset omits
  // keeps whatever the previously HOVERED preset left behind. A family full of
  // on/off effect knobs and stroke-trim toggles makes this a wrong-picture bug,
  // not a subtlety: hover "Neon Sign" then click "Blueprint Outline" and the
  // outline would still glow.
  const sets = new Set(rectPlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
  assert.equal(sets.size, 1, `rect presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
});

console.log(`\n${passed} rect-preset tests passed`);
