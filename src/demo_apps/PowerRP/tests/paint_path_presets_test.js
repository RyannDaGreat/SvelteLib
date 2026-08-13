/**
 * THE PAINT-PATH PRESET PIXEL-DISTINCTNESS GATE — bare node, real Skia, real
 * pixels.
 *
 * WHAT IT PROVES: no two paint_path presets render the same picture, and none
 * renders the same picture as the widget's own UNTOUCHED DEFAULT (ledger C-16:
 * a preset identical to default is a dead row no preset-vs-preset comparison
 * can ever catch, since the default is not itself a preset).
 *
 * ── WHY A FIXED FIXTURE PATH, BUILT HERE ─────────────────────────────────────
 * Presets never write `paintPoints` — it is the author's drawing (plugins/
 * paint_path.js's header, "IT IS THE AUTHOR'S DRAWING"). So the geometry every
 * preset is rendered against is THIS TEST's content, not any preset's: one
 * multi-segment fixture with a CURVE (a mirrored handle) and a BREAK (a second
 * subpath), so a stroke idiom is judged against the same curved, broken path
 * every row shares — closer to what a real drawn path looks like than the
 * widget's own default's gentle single-subpath wave, and enough segments for a
 * join style (Ballpoint's miter vs Felt Marker's round) to have a corner to
 * show itself on.
 *
 * ── WHY BARE NODE, THE LIT-SET REDUCTION, AND MID-GREY ───────────────────────
 * paint_path is pure vector (stroke + optional fill, no media/backdrop), the
 * same case cli/render.js's software Skia surface exists for — no Chrome, no
 * capture-hang risk, deterministic. This family is entirely OPEN, thin-relative-
 * to-canvas strokes (a felt marker at 16px on a 400x260 frame still inks a small
 * fraction of it), so a whole-frame mean would divide every real difference by
 * the empty backdrop they share — the same trap rect_presets_test.js's header
 * measured on rect's unfilled rows. litSetDistance against a BLANK reference
 * (never the default — see that same header for why the default would inflate
 * two similarly-thin presets' shared empty interior into "lit") is the shared
 * metric every sparse-stroke family already uses (tests/imageDistinctness.js).
 * Mid grey (#808080) backdrop for the same reason rect's probe adopted it:
 * "Neon Tube" and "Highlighter" both trade on translucency/saturation reading
 * against a neutral field, and white or black would flatter one at the other's
 * expense.
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
const paintPathPlugin = registry.get("paint_path");

const W = 400, H = 260;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
// A box comfortably clear of the canvas edge, so a wide preset (Airbrush at 30,
// Highlighter at 24) has room to ink fully rather than clip against the frame —
// a clipped stroke would make two genuinely different widths read closer than
// they are.
const BOX = { x: 40, y: 40, w: 320, h: 180 };
// THE FIXTURE PATH — this test's content, never a preset's (see header). Three
// anchors curving up into a smooth crest (a real mirrored handle, so caps/join
// have visible geometry to sit on), a BREAK, then two more anchors as a second,
// separate straight-ish subpath — so a preset is judged on both a curved run and
// a sharp corner across a lifted pen, box-fraction coordinates per the widget's
// own storage convention.
const FIXTURE_PAINT_POINTS = [
  [0.05, 0.85, 0, 0, 0],
  [0.35, 0.10, 0.18, 0, 0],
  [0.62, 0.55, -0.10, -0.12, 0],
  [0.78, 0.30, 0, 0, 1],
  [0.95, 0.80, 0, 0, 0],
];
// See the header: node_render's own default background is white, which would
// wash out a translucent preset (Highlighter, Airbrush) exactly as
// rect_presets_test.js measured for blend-mode-dependent rows. Mid grey favours
// neither a light nor a saturated/translucent stroke.
const BACKGROUND = "#808080";

/** Near-pure function (renders via a Skia surface; deterministic at a frozen
 *  clock, so it behaves like a pure function of its arguments for this file's
 *  purposes). One paint_path frame, drawn over the FIXED fixture curve, as
 *  decoded RGBA.
 *
 *  @param {object} props - overlay on top of paintPathPlugin.defaults + BOX + FIXTURE_PAINT_POINTS
 *  @returns {Promise<{width:number,height:number,data:Buffer}>}
 */
async function frame(props) {
  const state = { ...paintPathPlugin.defaults, ...BOX, paintPoints: FIXTURE_PAINT_POINTS, ...props };
  return readPng(await renderToPng(paintPathPlugin.emit(state), VIEW, { width: W, height: H, background: BACKGROUND }));
}

test("the sweep found the paint_path preset table at all", () => {
  assert.ok(Array.isArray(paintPathPlugin.presets) && paintPathPlugin.presets.length >= 10,
    `paintPathPlugin.presets is ${JSON.stringify(paintPathPlugin.presets)} — expected the R7-39 table (>= 10 presets)`);
});

// "Nothing applied" is an EMPTY canvas (rect_presets_test.js's BLANK), NOT the
// widget's own default — see the header for why the default would be an unfair
// reference between two similarly-thin presets.
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKGROUND }));
const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
for (const preset of paintPathPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

// Calibrated against this family's own measured closest pair under litSetDistance
// with the empty-canvas reference; see the header and rect_presets_test.js /
// arrow_presets_test.js for the shape of this bound in sibling stroke families.
const MIN_SEPARATION = 10;

test(`paint_path: ${paintPathPlugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `paint_path: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

test("EVERY paint_path preset writes the IDENTICAL key set", () => {
  // Application is an OVERLAY (app.applyPreset), so a key one preset omits keeps
  // whatever the previously HOVERED preset left behind. A family of cap/join/
  // trim-window toggles makes this a wrong-picture bug, not a subtlety: hover
  // "Draw-In Reveal" then click "Ballpoint" and the ballpoint would stay half-drawn.
  const sets = new Set(paintPathPlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
  assert.equal(sets.size, 1, `paint_path presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
});

test("no paint_path preset writes paintPoints — the author's drawing is never overwritten", () => {
  for (const preset of paintPathPlugin.presets)
    assert.ok(!("paintPoints" in preset.props), `"${preset.name}" writes paintPoints — a stroke preset may never redraw the path`);
});

console.log(`\n${passed} paint_path-preset tests passed`);
