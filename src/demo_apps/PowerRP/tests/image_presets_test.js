/**
 * THE IMAGE-WIDGET PRESET GATE — bare node, real Skia, real pixels.
 * Run: node src/demo_apps/PowerRP/tests/image_presets_test.js
 *
 * Structural template: tests/arrow_presets_test.js / tests/shape_presets_test.js.
 * tests/preset_contract_test.js already sweeps `image`'s table for the family-
 * agnostic laws (declared keys, names, no placement key, effects-family
 * completeness, data distinctness) — this file adds the one thing that suite
 * cannot: proof that the eleven photo TREATMENTS actually render eleven
 * different pictures.
 *
 * ── WHY THE WIDGET'S OWN "PHOTO" NEVER APPEARS IN ANY FRAME HERE ──────────────
 * cli/render.js's own header names the bound this file works inside: bare node
 * has no `createImageBitmap`, so `renderToPng` runs the `image` op against an
 * EMPTY media map and `paint_skia.js`'s `case "image"` breaks out and draws
 * NOTHING for it (`if (!img) break` — the async-media contract, not a bug). So
 * every frame below is missing exactly the bitmap and NOTHING ELSE: the border
 * stroke, the rounded-corner clip, the crop-inset region, and every effect
 * (shadow/bloom/blend/inner-shadow/soft-edges/blur) are ordinary vector Skia ops
 * — `decorateStrokedBox` and `applyEffects` — that paint with zero dependency on
 * whether the quad they wrap has a bitmap behind it. That is exactly why this
 * family's presets are FRAME/FINISH treatments (border, shadow, glow, blend,
 * crop) and none of them sets `sampling` — a resampling choice has no picture at
 * all until there are real source pixels to resample, so a probe that could
 * exercise it needs a browser, and this file states that rather than silently
 * proving something narrower than "eleven treatments" while claiming the whole
 * table.
 *
 * ── WHAT IT PROVES ────────────────────────────────────────────────────────────
 *  1. No two presets, and no preset against the widget's own UNTOUCHED DEFAULT,
 *     render the same picture (ledger C-16: a preset reproducing the default is
 *     a dead row invisible to any preset-vs-preset comparison).
 *  2. Every preset sets all four crop insets (0 = identity) — proven directly
 *     against the props table, not by rendering, since an omitted inset is
 *     invisible in a lit-set comparison whenever the family's OTHER presets also
 *     leave it at 0.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { imagePlugin } from "../plugins/image.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());

// A box well inside a canvas bigger than it, so the widest treatment's spill
// (Sticker's bloom, Polaroid's shadow) is not clipped away by the canvas edge —
// the same lesson tests/layout_presets_test.js records for the group family.
const BOX = { x: 60, y: 40, w: 300, h: 220 };
const W = 420, H = 300;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
// Mid grey: distinct from the white Polaroid/Sticker borders, the black
// Pixel-Art/Gallery-Mat keylines, and dark enough that a "screen" blend (CRT
// Screen) still visibly lightens it.
const BACKDROP = "#7a7a7a";

async function frame(props) {
  const state = { ...imagePlugin.defaults, ...BOX, ...props };
  return readPng(await renderToPng(imagePlugin.emit(state, null, IDENTITY), VIEW, { width: W, height: H, background: BACKDROP }));
}

const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKDROP }));

test("the roster carries the image plugin with its preset table", () => {
  assert.equal(registry.get("image").type, "image");
  assert.ok(Array.isArray(imagePlugin.presets) && imagePlugin.presets.length >= 10,
    `image declares ${imagePlugin.presets?.length ?? 0} presets — the R7-39 law requires >= 10`);
});

test("every preset sets all four crop insets (0 is the identity, but every row must state it)", () => {
  for (const preset of imagePlugin.presets)
    for (const key of ["cropTop", "cropLeft", "cropRight", "cropBottom"])
      assert.ok(key in preset.props, `image "${preset.name}" omits "${key}" — an overlay application would leave a previously-hovered crop in place`);
});

const FRAMES = [{ name: "(DEFAULT)", png: await frame({}) }];
for (const preset of imagePlugin.presets) FRAMES.push({ name: preset.name, png: await frame(preset.props) });

test(`image: ${imagePlugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
  const frames = FRAMES;
  // Calibrated the same way as the sibling suites: the shared floor is
  // DISPLAYABLE_CODE_VALUE (one 8-bit code value); "far enough to be worth a
  // separate row" is a per-family judgement. Measured on this fixture, over
  // every pairing of the eleven presets and the untouched default (66 pairs):
  //   8.73   Thumbnail Chip <-> Faded Watermark — the NARROWEST pair shipped,
  //          and still a real distinction by eye (a light 3px rounded chip
  //          corner vs. a near-invisible 1px hairline at 18% opacity).
  //   6.5    the bound used below — under the narrowest shipped pair, so it
  //          fails a table that regresses toward this collision, and still
  //          well above the DISPLAYABLE_CODE_VALUE floor.
  const MIN_SEPARATION = 6.5;
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `image: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

console.log(`\n${passed} image-preset tests passed`);
