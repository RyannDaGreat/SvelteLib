/**
 * THE SVG-WIDGET PRESET GATE — bare node, real Skia, real pixels.
 * Run: node src/demo_apps/PowerRP/tests/svg_presets_test.js
 *
 * Structural template: tests/image_presets_test.js. tests/preset_contract_test.js
 * already sweeps `svg`'s table for the family-agnostic laws (declared keys,
 * names, no placement key, effects-family completeness, data distinctness) —
 * this file adds the one thing that suite cannot: proof that the twelve artwork
 * TREATMENTS actually render twelve different pictures.
 *
 * ── UNLIKE image_presets_test.js, THE ARTWORK IS FULLY PRESENT HERE ───────────
 * The image widget's bare-node blind spot (no `createImageBitmap`, so a photo
 * never decodes) does not apply to this widget: svg.js's own docblock states the
 * flatten is SYNCHRONOUS (DOMParser where one exists, a text-based fallback
 * parser in bare node — render_gpu/gpu/svg_raster.js parseSvgToTree). Measured
 * directly: svgPlugin.emit() against DEFAULT_SVG_SRC in plain node returns real
 * `path` ops (a rounded rect + a check stroke), not an empty list. So every
 * frame below renders the WHOLE treatment — recolor (ink/fill), the stroked
 * border, and every effect — against genuine vector content, with none of the
 * "frame/finish only, no picture" caveat the image family's presets carry.
 *
 * ── WHAT IT PROVES ────────────────────────────────────────────────────────────
 *  1. No two presets, and no preset against the widget's own UNTOUCHED DEFAULT,
 *     render the same picture (ledger C-16: a preset reproducing the default is
 *     a dead row invisible to any preset-vs-preset comparison).
 *  2. Every preset sets the full recolor/border/effects key set (ink, fill,
 *     preserveAspect, stroke, strokeWidth, cornerRadius, opacity, and every
 *     BUNDLES.effects leaf) — proven directly against the props table, not by
 *     rendering, since an omitted key is invisible in a lit-set comparison
 *     whenever the family's OTHER presets also leave it at the same value.
 *  3. No preset touches `svgSrc`, `svgSource` or `svgUrl` — the artwork is the
 *     author's content, never a preset's to overwrite (the qrcode `data` /
 *     image `src` rule).
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { BUNDLES } from "../core/properties.js";
import { svgPlugin } from "../plugins/svg.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());

// A box well inside a canvas bigger than it, so the widest treatment's spill
// (Neon Glow's bloom, Sticker's shadow) is not clipped away by the canvas edge —
// the image_presets_test.js precedent.
const BOX = { x: 60, y: 40, w: 300, h: 220 };
const W = 420, H = 300;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
// Mid grey: distinct from the white Sticker keyline, the black Framed Plate
// border, and dark enough that Duotone Wash's "multiply" blend still visibly
// darkens it and Neon Glow's bloom still visibly lights it.
const BACKDROP = "#7a7a7a";

async function frame(props) {
  const state = { ...svgPlugin.defaults, ...BOX, ...props };
  return readPng(await renderToPng(svgPlugin.emit(state, null, IDENTITY), VIEW, { width: W, height: H, background: BACKDROP }));
}

const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKDROP }));

test("the roster carries the svg plugin with its preset table", () => {
  assert.equal(registry.get("svg").type, "svg");
  assert.ok(Array.isArray(svgPlugin.presets) && svgPlugin.presets.length >= 10,
    `svg declares ${svgPlugin.presets?.length ?? 0} presets — the R7-39 law requires >= 10`);
});

const IDENTITY_KEYS = ["ink", "fill", "preserveAspect", "stroke", "strokeWidth", "cornerRadius", "opacity"];
const EFFECTS_KEYS = [...new Set(BUNDLES.effects.map((k) => k.split(".")[0]))];

test("every preset sets the full recolor/border identity (ink, fill, preserveAspect, stroke, strokeWidth, cornerRadius, opacity)", () => {
  for (const preset of svgPlugin.presets)
    for (const key of IDENTITY_KEYS)
      assert.ok(key in preset.props, `svg "${preset.name}" omits "${key}" — an overlay application would leave a previously-hovered row's value in place`);
});

test("every preset sets every BUNDLES.effects leaf, derived rather than transcribed", () => {
  for (const preset of svgPlugin.presets)
    for (const key of EFFECTS_KEYS)
      assert.ok(key in preset.props, `svg "${preset.name}" omits effects leaf "${key}" — BUNDLES.effects grew and this table did not follow`);
});

test("no preset touches svgSrc, svgSource or svgUrl — the artwork is the author's content", () => {
  for (const preset of svgPlugin.presets)
    for (const key of ["svgSrc", "svgSource", "svgUrl"])
      assert.ok(!(key in preset.props), `svg "${preset.name}" writes "${key}" — a preset must never overwrite the author's own source`);
});

const FRAMES = [{ name: "(DEFAULT)", png: await frame({}) }];
for (const preset of svgPlugin.presets) FRAMES.push({ name: preset.name, png: await frame(preset.props) });

test(`svg: ${svgPlugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
  const frames = FRAMES;
  // Calibrated the same way as the sibling suites: the shared floor is
  // DISPLAYABLE_CODE_VALUE (one 8-bit code value); "far enough to be worth a
  // separate row" is a per-family judgement. Measured on this fixture, over
  // every pairing of the twelve presets and the untouched default (78 pairs):
  //   6.83   (DEFAULT) <-> Print Registration — the NARROWEST pair shipped,
  //          and still a real distinction by eye (a hard black offset double
  //          vs. the default's plain undecorated artwork).
  //   4      the bound used below — under the narrowest shipped pair, so it
  //          fails a table that regresses toward this collision, and still
  //          well above the DISPLAYABLE_CODE_VALUE floor.
  const MIN_SEPARATION = 4;
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `svg: "${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

console.log(`\n${passed} svg-preset tests passed`);
