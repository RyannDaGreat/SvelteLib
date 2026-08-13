/**
 * THE LABELED-CIRCLE-PRESET PIXEL-DISTINCTNESS GATE — bare node, real Skia, real
 * pixels. The rect_presets_test.js shape (R7-39 presets law), adapted for a
 * widget whose ink is a disc PLUS a centred text label rather than a filled box.
 *
 * WHAT IT PROVES: no two labeled_circle presets render the same picture, none
 * renders the same picture as the widget's own UNTOUCHED DEFAULT (ledger C-16),
 * and vector TEXT actually rasterizes in bare node (no browser, no DOM) for every
 * font a preset names — this widget's label is drawn through the SAME `text()` IR
 * op every other text-bearing widget uses, and bare-node glyph rendering is a real
 * capability boundary elsewhere in this app (see cli/render.js's own doc: it
 * shares emit()/paint_skia.js with the editor but is the renderer with no DOM).
 *
 * ── WHY THE LIT-SET REDUCTION, NOT A WHOLE-FRAME MEAN ────────────────────────
 * Same reasoning as rect_presets_test.js: several rows here are deliberately
 * UNFILLED or near-transparent (Minimal Outline, Warning Roundel's zero rim), and
 * a disc's own ink is a fraction of its bounding square to begin with — a
 * whole-frame mean would dilute a real difference between two thin-ringed
 * presets under the empty margin they share. litSetDistance restricts the
 * comparison to pixels either frame actually touches relative to a blank
 * reference, which serves a filled preset (its lit set is ~the disc) exactly as
 * well as a bare-outline one.
 *
 * ── THE REFERENCE IS AN EMPTY CANVAS, NOT THE UNTOUCHED DEFAULT ──────────────
 * Same trap rect_presets_test.js names: using the widget's own filled default as
 * litSetDistance's `reference` would count two UNFILLED presets' shared,
 * agreeing backdrop-through-the-empty-fill region as "lit" (both differ hugely
 * from the default's green fill there), inflating their lit set and burying a
 * real thin-ring difference under noise. The reference here is `renderToPng([],
 * ...)` — nothing drawn at all.
 *
 * ── WHY THE CANVAS IS MID-GRAY ────────────────────────────────────────────────
 * Same reasoning as rect_presets_test.js: "Neon Token" blend-modes with screen
 * over no fill, which is a no-op composited onto a white background
 * (screen(white, x) = white) and would read as invisible on the renderer's
 * default white canvas. Mid grey (#808080) favours neither the light-fill
 * presets (Subway Roundel's white core) nor the dark/blend ones (Neon Token,
 * Scoreboard).
 *
 * ── HOW THE BOUND WAS CALIBRATED ─────────────────────────────────────────────
 * Same derivable floor as every sibling probe: the renderer is deterministic at
 * a frozen clock, so the noise floor is zero and one 8-bit code value is the
 * smallest displayable difference. MIN_SEPARATION is calibrated against this
 * family's own measured closest pair (see the printed "narrowest" line) with
 * headroom, the rect_presets_test.js / arrow_presets_test.js shape.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { fontOptions } from "../render_gpu/fonts.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());
const labeledCirclePlugin = registry.get("labeled_circle");

const W = 320, H = 320;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
// The disc's own default box (257x257 — REFERENCE.diameter), placed with margin
// clear of the canvas edge so a shadow/bloom/blur halo has room to render fully.
const BOX = { x: 31, y: 31, w: 257, h: 257 };
// See the header: node_render's own default background is white, which makes
// blendMode:"screen" (Neon Token) a mathematical no-op there. Mid grey favours
// neither the light-fill presets nor the dark/blend ones.
const BACKGROUND = "#808080";

/** Near-pure function (renders via a Skia surface; deterministic at a frozen
 *  clock, so it behaves like a pure function of its arguments for this file's
 *  purposes). One labeled_circle frame as decoded RGBA.
 *
 *  @param {object} props - overlay on top of labeledCirclePlugin.defaults + BOX
 *  @returns {Promise<{width:number,height:number,data:Buffer}>}
 */
async function frame(props) {
  const state = { ...labeledCirclePlugin.defaults, ...BOX, ...props };
  const ops = labeledCirclePlugin.emit(state, null, VIEW);
  return readPng(await renderToPng(ops, VIEW, { width: W, height: H, background: BACKGROUND }));
}

test("the sweep found the labeled_circle preset table at all", () => {
  assert.ok(Array.isArray(labeledCirclePlugin.presets) && labeledCirclePlugin.presets.length >= 10,
    `labeledCirclePlugin.presets is ${JSON.stringify(labeledCirclePlugin.presets)} — expected the R7-39 table (>= 10 presets)`);
  assert.ok(labeledCirclePlugin.presets.length <= 12,
    `labeledCirclePlugin.presets has ${labeledCirclePlugin.presets.length} rows — R7-39 asks for 10-12`);
});

test("NO preset writes `text` — the label is author content, never overwritten", () => {
  for (const preset of labeledCirclePlugin.presets)
    assert.ok(!("text" in preset.props), `preset "${preset.name}" writes "text" — presets must never overwrite the author's label`);
});

test("every preset's font is a real, registered font id", () => {
  const validFonts = new Set(fontOptions().map((o) => o.value));
  for (const preset of labeledCirclePlugin.presets)
    assert.ok(validFonts.has(preset.props.font), `preset "${preset.name}" names font "${preset.props.font}", which is not in fontOptions()`);
});

test("EVERY labeled_circle preset writes the IDENTICAL key set", () => {
  // Application is an OVERLAY (app.applyPreset), so a key one preset omits keeps
  // whatever the previously HOVERED preset left behind — the rect_presets_test.js
  // / group_treatments_test.js identity law, restated for a widget with BOTH a
  // ring and a label: a preset missing "font" would leave "Scoreboard"'s seg7
  // face lit after hovering to "Medal".
  const sets = new Set(labeledCirclePlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
  assert.equal(sets.size, 1, `labeled_circle presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
});

test("every preset's key set covers the full label/ring key set", () => {
  const REQUIRED = ["font", "size", "bold", "align", "valign", "labelColor", "fill", "stroke", "strokeWidth", "strokeOffset"];
  const [firstPreset] = labeledCirclePlugin.presets;
  for (const key of REQUIRED)
    assert.ok(key in firstPreset.props, `labeled_circle presets are missing required key "${key}"`);
});

// "Nothing applied" is an EMPTY canvas (rect_presets_test.js's BLANK), NOT the
// widget's own filled-and-labeled default — see the header for why using the
// default as the reference inflates two unfilled presets' shared interior into
// "lit" pixels.
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKGROUND }));
const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
for (const preset of labeledCirclePlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

// Calibrated against this family's own measured closest pair under litSetDistance
// with the empty-canvas reference; see the header for the reasoning. Printed
// below so a future author can see the margin, not just the pass/fail.
const MIN_SEPARATION = 10;

test(`labeled_circle: ${labeledCirclePlugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `labeled_circle: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

test("every preset frame actually paints SOMETHING (glyph + disc both rasterize in bare node)", () => {
  // A blank-looking frame here would mean either the disc failed to paint (a
  // props bug) or the label's vector text silently failed to rasterize (the
  // capability boundary cli/render.js's own header warns about elsewhere in this
  // app — LaTeX/Mermaid/media need a DOM, but plain vector TEXT does not and
  // must work here). litSetDistance against BLANK with each frame as both "a"
  // and "b" collapses to a plain lit-coverage check.
  for (const f of frames) {
    const d = litSetDistance(f.png, f.png, BLANK);
    assert.ok(d.coverage > 0, `"${f.name}" painted ZERO pixels different from a blank canvas — the disc and/or label failed to render`);
  }
});

console.log(`\n${passed} labeled_circle-preset tests passed`);
