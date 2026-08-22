/**
 * THE CORKBOARD-FAMILY PRESET-TABLE GATE — bare node, real Skia, real pixels.
 * Run: node src/demo_apps/PowerRP/tests/corkboard_presets_test.js
 *
 * WHAT IT PROVES, per widget (corkboard, corkboardNote, corkboardThumbtack,
 * corkboardYarn — plugins/demo/corkboard.js): the R7-39 presets law's pixel half.
 * tests/preset_contract_test.js already sweeps this family for the DATA-level
 * rules (declared keys, unique names/descriptions, equation legality, no
 * placement keys, in-range values) over the whole plugin roster; this file adds
 * what only a renderer can prove — that no two rows, and no row against the
 * widget's own untouched default, paint the SAME picture.
 *
 * ── THE RIG, AND WHY IT IS rect_presets_test.js's, NOT metaball_presets_test.js's ──
 * corkboard/corkboardNote/corkboardThumbtack emit ONE `materialFill` op naming an
 * SkSL material (render_gpu/skia/corkboard_shader.js); corkboardYarn emits three
 * stroked `path` ops. Both op kinds already round-trip through
 * render_gpu/skia/node_render.js's `renderToPng` — the same bare CPU-Skia surface
 * cli/render.js uses — with NO document, camera or backdrop-compositor
 * involvement, exactly as rect_presets_test.js proves for `rect`. The heavier
 * metaball_presets_test.js rig (full document, evaluatedStateAt, cameraFrameIR)
 * exists because metaballs SAMPLE the backdrop; this family's materials do not
 * (`backdrop: false` on both CORK_MATERIAL and TACK_MATERIAL — see
 * corkboard_shader.js), so there is nothing under the widget for a render to
 * miss. MEASURED: `renderToPng(plugin.emit(state, null, VIEW), VIEW, {...})`
 * renders `corkboard`'s SkSL material correctly with no document at all — the
 * one thing this DOES need that rect.js's own rig does not is `registerAll`,
 * because the corkboard SkSL material is a BUILT-IN PLUGIN ASSET
 * (core/builtin_plugin_assets.js: "corkboard.material.plugin.js"), not a static
 * import — the material registry is populated as `registerAll`'s side effect,
 * independent of the render call, so it must run once before any frame() call.
 *
 * ── litSetDistance, MID-GREY, EMPTY-CANVAS REFERENCE — rect_presets_test.js's ──
 * argument transcribed, not re-derived: several rows in this family are
 * near-transparent by design (Frameless Cork Tile has frameWidth 0; Fine Fishing
 * Line is a 1.5px cord on a big canvas) exactly like rect's unfilled rows, so a
 * whole-frame mean would divide their real difference by the shared empty area.
 * litSetDistance restricts the comparison to the union of what either frame
 * actually painted, relative to a BLANK canvas (never the widget's own filled
 * default, for the same reason rect_presets_test.js gives: using a filled
 * default as the reference makes two SPARSE presets agree everywhere on "not
 * default" and inflates their apparent lit set). Mid-grey (#808080) is neutral
 * between this family's darkest (Black Enamel Pin, Charcoal Felt) and lightest
 * (Whiteboard-ish, Glossy Yellow Ball-Head Pin) rows, exactly as it is neutral
 * for rect's light-fill vs. dark/blend rows.
 *
 * ── FOUR SEPARATE CANVASES, NOT ONE SHARED ONE ────────────────────────────────
 * Each widget gets its own render box sized to its own natural proportions (the
 * board is wide, the note is tall, the tack is a small square, the yarn is a
 * diagonal run) so every family's own geometry is fully on-canvas with room for
 * its shadow halo — the same "clear of the edge" reasoning rect_presets_test.js
 * states for its BOX.
 *
 * ── WHAT THIS FILE DOES NOT PROVE ─────────────────────────────────────────────
 * That a preset's props are legal, unique, complete or placement-free — that is
 * tests/preset_contract_test.js, over the SAME plugins, and repeating it here
 * would be the hand-maintained-mirror defect that file exists to kill.
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

// registerAll's side effect (not its return value) is what this file needs: it
// loads the corkboard/tack SkSL materials into render_gpu/skia/materials.js's
// registry as BUILT-IN PLUGIN ASSETS (core/builtin_plugin_assets.js) — see the
// header. Without this call the two materialFill widgets throw "unknown
// material" the first time renderToPng resolves their op.
const registry = createRegistry();
registerAll(registry, createCommands());

// mid-grey — neutral between this family's darkest and lightest rows; see header.
const BACKGROUND = "#808080";

/**
 * Near-pure function (renders via a Skia surface; deterministic at a frozen
 * clock, so it behaves like a pure function of its arguments for this file's
 * purposes). One widget frame as decoded RGBA.
 *
 * @param {object} plugin - a registered corkboard-family plugin
 * @param {object} box - {x, y, w, h} the widget occupies (identity world == local)
 * @param {object} props - overlay on top of plugin.defaults + box
 * @param {number} w,h - canvas size
 * @returns {Promise<{width:number,height:number,data:Buffer}>}
 */
async function frame(plugin, box, props, w, h) {
  const view = fitRectView({ x: 0, y: 0, w, h }, w, h);
  const state = { ...plugin.defaults, ...box, ...props };
  const png = await renderToPng(plugin.emit(state, null, view), view, { width: w, height: h, background: BACKGROUND });
  return readPng(png);
}

/**
 * Command (renders every preset + the default, asserts pairwise + vs-default
 * distinctness under litSetDistance). One family's whole pixel-distinctness
 * gate, parametrized over the widget's own render geometry.
 *
 * @param {string} type - plugin type id
 * @param {object} box - {x, y, w, h} the widget renders at (identity world)
 * @param {number} canvasW,canvasH - render surface size
 * @param {number} minSeparation - calibrated MIN_SEPARATION for this family (litSetDistance mean-abs levels)
 */
async function testFamily(type, box, canvasW, canvasH, minSeparation) {
  const plugin = registry.get(type);
  assert.ok(plugin, `corkboard_presets_test: registry has no plugin "${type}"`);

  test(`${type}: the sweep found the preset table at all`, () => {
    assert.ok(Array.isArray(plugin.presets) && plugin.presets.length >= 1,
      `${type}.presets is ${JSON.stringify(plugin.presets)}`);
  });

  const view = fitRectView({ x: 0, y: 0, w: canvasW, h: canvasH }, canvasW, canvasH);
  const blankPng = await renderToPng([], view, { width: canvasW, height: canvasH, background: BACKGROUND });
  const BLANK = readPng(blankPng);

  const frames = [{ name: "(DEFAULT)", png: await frame(plugin, box, {}, canvasW, canvasH) }];
  for (const preset of plugin.presets)
    frames.push({ name: preset.name, png: await frame(plugin, box, preset.props, canvasW, canvasH) });

  test(`${type}: ${plugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= minSeparation,
          `${type}: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${minSeparation}) — the same row twice`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
  });

  test(`${type}: EVERY preset writes the IDENTICAL key set`, () => {
    // Application is an OVERLAY (app.applyPreset), so a key one preset omits
    // keeps whatever the previously HOVERED preset left behind — the same
    // hover-leak hazard rect_presets_test.js and group_treatments_test.js guard.
    const sets = new Set(plugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
    assert.equal(sets.size, 1, `${type} presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  });
}

// Each family gets its own box + canvas, sized to its own geometry — see header.
// BOARD: wide panel, comfortably inset from the canvas edge for its frame/vignette.
await testFamily("corkboard", { x: 40, y: 30, w: 480, h: 320 }, 560, 380, 10);
// NOTE: tall paper with room below/right for its drop shadow.
await testFamily("corkboardNote", { x: 60, y: 40, w: 220, h: 280 }, 340, 380, 10);
// THUMBTACK: a small square disk, inset enough for a proud pin's contact shadow.
await testFamily("corkboardThumbtack", { x: 40, y: 40, w: 120, h: 120 }, 200, 200, 10);

// YARN has no bbox (endpoints, not w/h) — its own frame() overlay/box shape.
await (async () => {
  const type = "corkboardYarn";
  const plugin = registry.get(type);
  assert.ok(plugin, `corkboard_presets_test: registry has no plugin "${type}"`);

  test(`${type}: the sweep found the preset table at all`, () => {
    assert.ok(Array.isArray(plugin.presets) && plugin.presets.length >= 1,
      `${type}.presets is ${JSON.stringify(plugin.presets)}`);
  });

  const W = 500, H = 260;
  const view = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
  // A diagonal run comfortably inset from every edge, wide enough that the
  // widest preset (Satin Ribbon, width 12) plus its shadow/highlight offsets
  // stay fully on-canvas.
  const ENDPOINTS = { from: { x: 60, y: 60 }, to: { x: 440, y: 200 } };

  const yarnFrame = async (props) => {
    const state = { ...plugin.defaults, ...ENDPOINTS, ...props };
    const png = await renderToPng(plugin.emit(state), view, { width: W, height: H, background: BACKGROUND });
    return readPng(png);
  };

  const BLANK = readPng(await renderToPng([], view, { width: W, height: H, background: BACKGROUND }));
  const frames = [{ name: "(DEFAULT)", png: await yarnFrame({}) }];
  for (const preset of plugin.presets) frames.push({ name: preset.name, png: await yarnFrame(preset.props) });

  const MIN_SEPARATION = 10;
  test(`${type}: ${plugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= MIN_SEPARATION,
          `${type}: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
  });

  test(`${type}: EVERY preset writes the IDENTICAL key set`, () => {
    const sets = new Set(plugin.presets.map((p) => Object.keys(p.props).sort().join(",")));
    assert.equal(sets.size, 1, `${type} presets write ${sets.size} different key sets:\n    ${[...sets].join("\n    ")}`);
  });
})();

console.log(`\n${passed} corkboard-family preset tests passed`);
