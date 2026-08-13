/**
 * THE MATERIAL-AUTHORITY PRESET LIBRARIES — plain node, real Skia, no browser.
 * Run: node src/demo_apps/PowerRP/tests/material_authority_presets_test.js
 *
 * WHY THIS FILE EXISTS. `render_gpu/skia/material_presets.js` (WIDGET_PRESET_SOURCES)
 * declares `demo_rainy_window` and `demo_raycast_dither` the AUTHORITY for the
 * "rainy_window" and "raycast_dither" materials' preset menus (Round 4 #52 user
 * rule: "the demo widget should determine the types of presets that these have").
 * Both widgets shipped ZERO presets, which left BOTH the widget's own Tools-pane
 * cards AND the material's paint-dropdown preset section empty — the same shape
 * of gap `tests/material_preset_merge_test.js` fixed for glitch/glass. This suite
 * is `tests/god_rays_presets_test.js`'s shape (a materialBackdrop family, rendered
 * pixel-for-pixel over a real fixture) with a second render rig for raycast_dither
 * (a materialFill / foreground-generative family — `tests/preset_contract_test.js`
 * and `plugins/qrcode.js`'s docblock call this the qrcode/rect precedent).
 *
 * WHAT THE GENERIC GATE ALREADY COVERS, so it is NOT repeated here: placement
 * keys, values legal for their own Inspector row, non-empty name/description,
 * name uniqueness, equation form, identical-props dedupe — all of that is
 * `tests/preset_contract_test.js`, over the whole plugin roster including these
 * two (it discovers `presetFamiliesOf` automatically; no per-family edit needed
 * there). What IS family-specific and lives here:
 *
 *   (1) THE FULL KNOB CEILING. Unlike a sparse geometry family (SPEC.md §4
 *       permits fewer keys), these two are DENSE material families with no inert
 *       value anywhere — every preset must write the material's whole look-knob
 *       set (its own RAINY_WINDOW_FILL_PARAMS / RAYCAST_DITHER_FILL_PARAMS) PLUS
 *       the widget-side geometry knob (cornerRadius), and nothing else. Reading
 *       the schema rather than a transcribed list is what
 *       `tests/god_rays_test.js`'s "ten-knob ceiling" check does for god_rays;
 *       this is the same check for both families. `backdropScale` is
 *       DELIBERATELY EXCLUDED from rainy_window's required set: its own row
 *       documents it as a PERFORMANCE guard (below-content resample resolution),
 *       not a look choice, so a preset that pretends otherwise would be
 *       transcribing an implementation detail as weather.
 *
 *   (2) PIXEL DISTINCTNESS, INCLUDING THE UNTOUCHED WIDGET (ledger C-16). Every
 *       preset renders on a software Skia surface (`render_gpu/skia/node_render.js`
 *       — the same backend `cli/render.js` uses; no Chrome, no capture-hang risk,
 *       deterministic at the frozen editor/CLI clock — see both widgets' headers).
 *       The widget's own DEFAULTS render as a row too, because a default that
 *       matches a preset is a dead row no preset-vs-preset comparison alone can
 *       ever catch. Scored pairwise with the shared metric
 *       (`tests/imageDistinctness.js`), calibrated per family against its own
 *       measured closest pair (see each MIN_* constant's comment).
 *
 *   (3) THE MATERIAL-MENU HALF (the actual two-surface bug this table fixes):
 *       `widgetPresetsFor(plugin, schema)` — the exact function
 *       `render_gpu/skia/material_presets.js presetsForMaterial` calls to give the
 *       widget's roster priority on the MATERIAL's dropdown — must now return the
 *       full, schema-filtered roster for both widgets. Before this table existed
 *       it returned `[]` for both (the widget had no `presets`), which is the
 *       precise defect `tests/material_preset_merge_test.js` pinned for
 *       glitch/glass; this asserts the same fix landed here.
 */

import assert from "node:assert/strict";
import { rainyWindowPlugin } from "../plugins/demo/rainy_window.js";
import { raycastDitherPlugin } from "../plugins/demo/raycast_dither.js";
import { RAINY_WINDOW_FILL_PARAMS, rainyWindowUniformParams } from "../render_gpu/skia/rainy_window_shader.js";
import { RAYCAST_DITHER_FILL_PARAMS, raycastDitherUniformParams } from "../render_gpu/skia/raycast_dither_shader.js";
import { materialBackdrop, materialFill, rect } from "../render_gpu/ir.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { imageDistance, litSetDistance, readPng } from "./imageDistinctness.js";
import { widgetPresetsFor } from "../render_gpu/skia/material_presets.js";
import { getMaterial } from "../render_gpu/skia/materials.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). */
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) the full knob ceiling, per family ────────────────────────────────────
// rainy_window's required set EXCLUDES backdropScale (a performance knob, not a
// look one — see the header); everything else, including the widget-side
// cornerRadius, is required on every row.
const RAINY_REQUIRED_KEYS = [...RAINY_WINDOW_FILL_PARAMS.map((d) => d.name).filter((n) => n !== "backdropScale"), "cornerRadius"].sort();
const RAYCAST_REQUIRED_KEYS = [...RAYCAST_DITHER_FILL_PARAMS.map((d) => d.name), "cornerRadius"].sort();

test("(1a) every rainy_window preset writes exactly its required knob set", () => {
  assert.ok(rainyWindowPlugin.presets.length >= 10, `${rainyWindowPlugin.presets.length} presets — R7-39 asks for at least ten per widget`);
  for (const preset of rainyWindowPlugin.presets) {
    const written = Object.keys(preset.props).sort();
    assert.deepEqual(written, RAINY_REQUIRED_KEYS,
      `"${preset.name}" writes ${written.join(", ")} — expected exactly ${RAINY_REQUIRED_KEYS.join(", ")}. Application is an OVERLAY, so an omitted knob keeps whatever the previously HOVERED preset left there.`);
  }
});

test("(1b) every raycast_dither preset writes exactly its required knob set", () => {
  assert.ok(raycastDitherPlugin.presets.length >= 10, `${raycastDitherPlugin.presets.length} presets — R7-39 asks for at least ten per widget`);
  for (const preset of raycastDitherPlugin.presets) {
    const written = Object.keys(preset.props).sort();
    assert.deepEqual(written, RAYCAST_REQUIRED_KEYS,
      `"${preset.name}" writes ${written.join(", ")} — expected exactly ${RAYCAST_REQUIRED_KEYS.join(", ")}. Application is an OVERLAY, so an omitted knob keeps whatever the previously HOVERED preset left there.`);
  }
});

// ── (2) pixel distinctness ────────────────────────────────────────────────────
const RENDER_W = 300, RENDER_H = 200;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
const BOX = { cx: RENDER_W / 2, cy: RENDER_H / 2, halfW: RENDER_W / 2 - 10, halfH: RENDER_H / 2 - 10 };
const DEFAULT_RAINY_KNOBS = Object.fromEntries(RAINY_WINDOW_FILL_PARAMS.map((d) => [d.name, d.default]));
const DEFAULT_RAYCAST_KNOBS = Object.fromEntries(RAYCAST_DITHER_FILL_PARAMS.map((d) => [d.name, d.default]));

/**
 * Query (renders on a software Skia surface). One rainy_window frame: a varied
 * backdrop scene (so refraction/shine have something to bend and specular against)
 * with the material backdrop composited over it.
 *
 * @param {object|null} knobs - preset props (schema knobs + cornerRadius), or null for unlit
 * @returns {Promise<{width: number, height: number, data: Buffer}>} decoded RGBA
 */
async function renderRainy(knobs) {
  const scene = [
    rect({ x: 0, y: 0, w: RENDER_W, h: RENDER_H, fill: "#3a5f8a" }),
    rect({ x: RENDER_W * 0.1, y: RENDER_H * 0.15, w: RENDER_W * 0.35, h: RENDER_H * 0.3, fill: "#f2c14e" }),
    rect({ x: RENDER_W * 0.55, y: RENDER_H * 0.5, w: RENDER_W * 0.3, h: RENDER_H * 0.35, fill: "#1a1a1a" }),
  ];
  if (knobs) scene.push(materialBackdrop({
    material: "rainy_window", ...BOX,
    cornerRadius: knobs.cornerRadius, blurRadius: knobs.blurRadius, backdropScale: 1,
    params: rainyWindowUniformParams({ ...DEFAULT_RAINY_KNOBS, ...knobs }),
  }));
  return readPng(await renderToPng(scene, VIEW, { width: RENDER_W, height: RENDER_H, background: "#808080" }));
}

/**
 * Query (renders on a software Skia surface). One raycast_dither frame: the
 * material fill alone (a foreground generative material — it samples nothing
 * beneath it, so no backdrop scene is needed).
 *
 * @param {object|null} knobs - preset props (schema knobs + cornerRadius), or null for unlit
 * @returns {Promise<{width: number, height: number, data: Buffer}>} decoded RGBA
 */
async function renderRaycast(knobs) {
  const scene = [];
  if (knobs) scene.push(materialFill({
    material: "raycast_dither", ...BOX,
    cornerRadius: knobs.cornerRadius,
    params: raycastDitherUniformParams({ ...DEFAULT_RAYCAST_KNOBS, ...knobs }),
  }));
  return readPng(await renderToPng(scene, VIEW, { width: RENDER_W, height: RENDER_H, background: "#808080" }));
}

/**
 * Near-pure function (renders via a Skia surface; deterministic at the frozen
 * editor/CLI clock, so it behaves like a pure function of its arguments here).
 * Runs the pairwise distinctness check (ledger C-16) for one preset family.
 *
 * @param {string} label - family name, for assertion messages
 * @param {Array<{name:string, props:object}>} presets
 * @param {(knobs: object|null) => Promise<object>} render - the family's render rig
 * @param {number} minSeparation - calibrated floor, in maxAbs code values
 */
async function checkDistinctness(label, presets, render, minSeparation) {
  const blank = await render(null);
  const frames = [{ name: "(widget defaults)", png: await render({}) }];
  for (const preset of presets) frames.push({ name: preset.name, png: await render(preset.props) });

  let narrowest = null;
  const tooClose = [];
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = imageDistance(frames[i].png, frames[j].png);
      const lit = litSetDistance(frames[i].png, frames[j].png, blank);
      if (!narrowest || d.maxAbs < narrowest.d.maxAbs) narrowest = { a: frames[i].name, b: frames[j].name, d, lit };
      if (d.maxAbs < minSeparation) tooClose.push(`${frames[i].name} <-> ${frames[j].name} (maxAbs ${d.maxAbs}, lit-set mean ${lit.meanAbs.toFixed(3)})`);
    }
  assert.deepEqual(tooClose, [],
    `${label}: these render as the same picture: ${tooClose.join("; ")}. A preset that moves no pixel is a dead row — if one side is "(widget defaults)", move the DEFAULT.`);
  console.log(`      ${label} narrowest: ${narrowest.a} vs ${narrowest.b} — maxAbs ${narrowest.d.maxAbs}, lit-set mean ${narrowest.lit.meanAbs.toFixed(3)} over ${(100 * narrowest.lit.coverage).toFixed(1)}% of the frame`);
}

// CALIBRATED per family (R6-25.3: the derivable floor is DISPLAYABLE_CODE_VALUE
// = 1; "far enough to be worth a separate row" is measured against each
// family's own closest pair, with headroom, the same shape rect/god_rays use).
await test("(2a) every rainy_window preset renders distinguishably, defaults included", async () => {
  await checkDistinctness("rainy_window", rainyWindowPlugin.presets, renderRainy, 6);
});

await test("(2b) every raycast_dither preset renders distinguishably, defaults included", async () => {
  await checkDistinctness("raycast_dither", raycastDitherPlugin.presets, renderRaycast, 6);
});

// ── (3) the material-menu half: widgetPresetsFor is no longer empty ─────────
const registry = createRegistry();
registerAll(registry, createCommands());

test("(3a) widgetPresetsFor(demo_rainy_window, ...) is no longer empty — the material dropdown gap", () => {
  const wp = widgetPresetsFor(registry.get("demo_rainy_window"), getMaterial("rainy_window").fillParams);
  assert.ok(wp.length >= 10, `widgetPresetsFor returned ${wp.length} rainy_window presets — expected the full table (>= 10), the material's paint dropdown was empty before this fix`);
  assert.deepEqual(wp.map((p) => p.title), rainyWindowPlugin.presets.map((p) => p.name), "the material sees the widget's roster in the widget's own order");
});

test("(3b) widgetPresetsFor(demo_raycast_dither, ...) is no longer empty — the material dropdown gap", () => {
  const wp = widgetPresetsFor(registry.get("demo_raycast_dither"), getMaterial("raycast_dither").fillParams);
  assert.ok(wp.length >= 10, `widgetPresetsFor returned ${wp.length} raycast_dither presets — expected the full table (>= 10), the material's paint dropdown was empty before this fix`);
  assert.deepEqual(wp.map((p) => p.title), raycastDitherPlugin.presets.map((p) => p.name), "the material sees the widget's roster in the widget's own order");
});

console.log(`\n${passed} material-authority preset tests passed (${rainyWindowPlugin.presets.length} rainy_window + ${raycastDitherPlugin.presets.length} raycast_dither presets)`);
