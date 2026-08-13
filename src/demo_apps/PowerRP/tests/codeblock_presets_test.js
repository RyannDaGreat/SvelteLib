/**
 * THE CODEBLOCK-PRESET PIXEL-DISTINCTNESS GATE — bare node, real Skia, real
 * pixels.
 *
 * WHAT IT PROVES: no two codeblock presets render the same picture, and none
 * renders the same picture as the widget's own UNTOUCHED DEFAULT (ledger
 * C-16: a preset identical to default is a dead row no preset-vs-preset
 * comparison can ever catch, because the default is not itself a preset).
 *
 * ── WHY BARE NODE ────────────────────────────────────────────────────────────
 * A code block is pure vector: a `rect` background op plus one `text` op per
 * highlighted token, JetBrains Mono laid on the exact mono grid (module
 * header, plugins/codeblock.js) — no image/video/LaTeX/Mermaid, exactly the
 * case cli/render.js's software Skia surface exists for. This was MEASURED
 * here, not assumed from "it's DOM-free core code": a probe render of the
 * first preset through `render_gpu/skia/node_render.js` produced a real,
 * correctly-sized PNG with no browser, confirming the module header's own
 * claim ("code block text shaping should work in bare node — it's vector
 * glyphs, unlike LaTeX/Mermaid which need a DOM/font-load"). No piece of this
 * widget needs coverage from a browser probe instead.
 *
 * ── WHY THE LIT-SET REDUCTION, NOT A WHOLE-FRAME MEAN ────────────────────────
 * Following tests/rect_presets_test.js's precedent: several rows here
 * (Terminal, Ticker / One-Liner) are near-black-on-near-black with a thin or
 * absent border, and Ghost Overlay is reduced-opacity — thin, low-signal
 * differences a whole-frame mean would dilute against the empty backdrop
 * outside the box and the code's own sparse glyph coverage inside it.
 * litSetDistance restricts the comparison to pixels either frame actually
 * touches relative to a blank reference, which is exactly as sound for a
 * large bright card (Card Embed, High-Contrast Review) as for a thin dark
 * strip.
 *
 * ── THE REFERENCE IS A BLANK CANVAS, THE BACKDROP IS MID-GREY ────────────────
 * Same two lessons rect_presets_test.js measured and this file inherits
 * rather than re-derives: litSetDistance's `reference` is an EMPTY canvas
 * (renderToPng([], ...)), never the widget's own filled default (a filled
 * default would count two unfilled/near-empty presets' shared backdrop as
 * "lit" and bury their real difference); the render backdrop is `#808080`
 * mid-grey rather than the renderer's own default white, since this family
 * has both near-black rows (Terminal) and near-white rows (Printed Handout,
 * High-Contrast Review) and a white backdrop would make one of those pairs
 * partially disappear into it.
 *
 * ── CALIBRATION ──────────────────────────────────────────────────────────────
 * MIN_SEPARATION is derived the same way as the rect gate: rendered once,
 * measured the closest pair under litSetDistance, and set below that
 * measured floor with headroom. See the printed "narrowest:" line for the
 * measured pair and value this run found.
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
const codeblockPlugin = registry.get("codeblock");

const W = 400, H = 260;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
// A box comfortably clear of the canvas edge, so nothing clips.
const BOX = { x: 60, y: 50, w: 280, h: 160 };
// Neutral backdrop: neither the near-black rows (Terminal, Ticker/One-Liner)
// nor the near-white rows (Printed Handout, High-Contrast Review) blend into
// it — see the header, mirroring tests/rect_presets_test.js's measured reason.
const BACKGROUND = "#808080";
// Fixed multi-line source, distinct from the widget's own default snippet, so
// the frames exercise line numbers / wrapping-by-truncation identically
// across every preset — the PRESETS themselves must never set `code` (the
// task law: a preset is a presentation context, not authored content), so the
// fixture is supplied here, once, by the test.
const CODE = "function fib(n) {\n  if (n < 2) return n;\n  return fib(n - 1) + fib(n - 2);\n}\n\nconsole.log(fib(10));";

/** Near-pure function (renders via a Skia surface; deterministic at a frozen
 *  clock, so it behaves like a pure function of its arguments for this
 *  file's purposes). One codeblock frame as decoded RGBA.
 *
 *  @param {object} props - overlay on top of codeblockPlugin.defaults + BOX + CODE
 *  @returns {Promise<{width:number,height:number,data:Buffer}>}
 */
async function frame(props) {
  const state = { ...codeblockPlugin.defaults, ...BOX, code: CODE, ...props };
  return readPng(await renderToPng(codeblockPlugin.emit(state, null, VIEW), VIEW, { width: W, height: H, background: BACKGROUND }));
}

test("the sweep found the codeblock preset table at all", () => {
  assert.ok(Array.isArray(codeblockPlugin.presets) && codeblockPlugin.presets.length >= 10,
    `codeblockPlugin.presets is ${JSON.stringify(codeblockPlugin.presets)} — expected the R7-39 table (>= 10 presets)`);
});

// "Nothing applied" is an EMPTY canvas, NOT the codeblock's own filled
// default — see the header for why the default would be an unfair reference.
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKGROUND }));
const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
for (const preset of codeblockPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

// Calibrated against this family's own measured closest pair under
// litSetDistance with the blank-canvas reference; see the header.
const MIN_SEPARATION = 10;

test(`codeblock: ${codeblockPlugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `codeblock: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

test("EVERY codeblock preset writes the IDENTICAL key set", () => {
  // Application is an OVERLAY (app.applyPreset), so a key one preset omits
  // keeps whatever the previously HOVERED preset left behind — a family
  // spanning theme/fontSize/lineNumbers/padding/box style makes this a
  // wrong-picture bug, not a subtlety.
  const sets = new Set(codeblockPlugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
  assert.equal(sets.size, 1, `codeblock presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
});

test("no codeblock preset writes `code` or `language`", () => {
  // The task law, restated as a pixel-suite-adjacent data check: a preset is
  // a PRESENTATION CONTEXT, never the author's content or their chosen
  // language (switching it would silently relabel/recolor the author's own
  // code — module header).
  for (const preset of codeblockPlugin.presets) {
    assert.ok(!("code" in preset.props), `"${preset.name}" writes "code" — presets must never author content`);
    assert.ok(!("language" in preset.props), `"${preset.name}" writes "language" — presets must never change the author's chosen language`);
  }
});

console.log(`\n${passed} codeblock-preset tests passed`);
