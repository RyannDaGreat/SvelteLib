/**
 * THE ICONIFY-WIDGET PRESET GATE — bare node, real Skia, real pixels.
 * Run: node src/demo_apps/PowerRP/tests/iconify_presets_test.js
 *
 * Structural template: tests/rect_presets_test.js / tests/image_presets_test.js.
 * tests/preset_contract_test.js already sweeps `iconify`'s table for the
 * family-agnostic laws (declared keys, names, no placement key, effects-family
 * completeness, data distinctness) — this file adds the one thing that suite
 * cannot: proof that the twelve icon TREATMENTS actually render twelve
 * different pictures.
 *
 * ── WHY THIS FILE DOES NOT GO THROUGH `iconifyPlugin.emit` ────────────────────
 * `emit` resolves an icon id to `https://api.iconify.design/...` (iconifyIconUrl)
 * and reads it through render_gpu/gpu/svg_source_registry.js, which in bare node
 * loads ONLY `/asset/<Project>/<file>` off disk (tests/svg_url_iconify_test.js
 * proves this: a real iconify id has no such route, so `emit` draws the loud red
 * error affordance, on purpose, rather than a silent blank) — and this sandbox
 * has no network reach to the real API either (measured: a plain HTTPS GET to
 * api.iconify.design returns HTTP 403 here). So there is no way to get a REAL
 * icon id through `emit`'s actual resolution path in this environment, and
 * `svg_source_registry.js` ships no seed/inject hook a caller could use instead
 * (grepped — none exists, and this file does not own that module to add one).
 *
 * What IS reachable, and what this file uses instead: `svgToIRWithWarnings`
 * (render_gpu/gpu/svg_raster.js), the SAME synchronous flatten `emit` calls the
 * instant it has SVG text in hand, fed a real fixture icon
 * (tests/fixtures/iconify/tabler-alert-triangle.svg — a genuine Iconify export,
 * `fill="none" stroke="currentColor"`, the mono-set shape the whole ink/fill
 * docblock is about). `renderIconTreatment` below reproduces `emit`'s POST-SOURCE
 * logic line for line (`svgOverridePaint` → `svgOverrideSlotPaint` → flatten →
 * `decorateSilhouetteBorder` → `applyEffects`), so what is proven here is exactly
 * the part of the widget a preset can affect — ink/fill/border/effects — and
 * NOT the network/registry seam, which `svg_url_iconify_test.js` already covers
 * on its own honest terms (the error affordance, not a rendered glyph).
 *
 * ── WHAT IT PROVES ────────────────────────────────────────────────────────────
 *  1. No two presets, and no preset against the widget's own UNTOUCHED DEFAULT,
 *     render the same picture (ledger C-16: a preset reproducing the default is
 *     a dead row invisible to any preset-vs-preset comparison).
 *  2. Every preset sets the full stroke-trim identity whenever it touches the
 *     border at all — proven directly against the props table (an omitted trim
 *     key is invisible in a lit-set comparison whenever the family's OTHER
 *     presets also leave it at the identity).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { iconifyPlugin } from "../plugins/iconify.js";
import { svgToIRWithWarnings, svgOverridePaint, svgOverrideSlotPaint } from "../render_gpu/gpu/svg_raster.js";
import { decorateSilhouetteBorder } from "../render_gpu/decorate.js";
import { applyEffects } from "../render_gpu/effects.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const registry = createRegistry();
registerAll(registry, createCommands());

// A real Iconify export (mono set: fill="none" stroke="currentColor") — the
// exact shape the ink/fill two-layer colour model in plugins/iconify.js's
// docblock is written about, so ink recolouring and fill-stencil recolouring
// both have something to visibly act on.
const FIXTURE_SVG = readFileSync(fileURLToPath(new URL("./fixtures/iconify/tabler-alert-triangle.svg", import.meta.url)), "utf8");

// A box well inside a canvas bigger than it, so the widest treatment's spill
// (Spotlight's bloom, App Icon Tile's shadow) is not clipped away by the canvas
// edge — the same lesson tests/image_presets_test.js records for its family.
const BOX = { x: 80, y: 60, w: 240, h: 180 };
const W = 400, H = 300;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
// Mid grey: neutral to both a light-ink/light-chip preset (Filled Circle Chip,
// App Icon Tile) and a dark-ink/multiply preset (Ink Stamp, Engraved) — the
// same measured reason tests/rect_presets_test.js's docblock gives for its own
// #808080 (a white canvas makes a `blendMode: "screen"` preset a no-op; a black
// canvas would do the same to a `multiply` preset).
const BACKGROUND = "#808080";

/**
 * Near-pure function (one Skia render; deterministic given the fixture SVG).
 * Reproduces `iconifyPlugin.emit`'s logic AFTER source resolution — the exact
 * part of the widget a preset can move — against the literal fixture text
 * instead of a network-fetched one, for the reason the file docblock states.
 *
 * @param {object} props - a preset's props, overlaid on iconifyPlugin.defaults
 * @returns {object[]} display-list ops, local space
 */
function emitFixtureIcon(props) {
  const s = { ...iconifyPlugin.defaults, ...BOX, ...props };
  const w = s.w, h = s.h;
  const style = { x: 0, y: 0, w, h, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: s.cornerRadius ?? 0 };
  const finish = (ops) => applyEffects(decorateSilhouetteBorder(ops, style, IDENTITY), s, IDENTITY, { x: 0, y: 0, w, h });
  const override = svgOverridePaint(s);
  const flat = svgToIRWithWarnings(FIXTURE_SVG, w, h, {
    ink: s.ink ?? "#000000",
    preserveAspect: s.preserveAspect !== false,
    opacity: s.opacity ?? 1,
    overridePaint: svgOverrideSlotPaint(override, "fill"),
    overrideStrokePaint: svgOverrideSlotPaint(override, "stroke"),
  });
  return finish(flat.ops);
}

async function frame(props) {
  return readPng(await renderToPng(emitFixtureIcon(props), VIEW, { width: W, height: H, background: BACKGROUND }));
}

test("the roster carries the iconify plugin with its preset table", () => {
  assert.equal(registry.get("iconify").type, "iconify");
  assert.ok(Array.isArray(iconifyPlugin.presets) && iconifyPlugin.presets.length >= 10,
    `iconify declares ${iconifyPlugin.presets?.length ?? 0} presets — the R7-39 law requires >= 10`);
});

test("every preset sets the full stroke-trim identity (strokeStart/End/Phase, both caps)", () => {
  // The five trim keys carry no DEFAULT (absent-is-legacy), so a row that
  // writes ANY border key must state all five, or a previously-hovered trim
  // (none of these twelve authors one, but a future row could) survives an
  // unrelated row's overlay.
  const TRIM_KEYS = ["strokeStart", "strokeEnd", "strokePhase", "strokeCapStart", "strokeCapEnd"];
  for (const preset of iconifyPlugin.presets) {
    const touchesBorder = ["stroke", "strokeWidth", "cornerRadius"].some((k) => k in preset.props);
    if (!touchesBorder) continue;
    for (const key of TRIM_KEYS)
      assert.ok(key in preset.props, `iconify "${preset.name}" touches the border but omits "${key}" — an overlay application would leave a previously-hovered trim in place`);
  }
});

const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H, background: BACKGROUND }));
const FRAMES = [{ name: "(DEFAULT)", png: await frame({}) }];
for (const preset of iconifyPlugin.presets) FRAMES.push({ name: preset.name, png: await frame(preset.props) });

test(`iconify: ${iconifyPlugin.presets.length} presets and the default all render a DIFFERENT picture`, () => {
  // Calibrated the same way as the sibling suites: the shared floor is
  // DISPLAYABLE_CODE_VALUE (one 8-bit code value); "far enough to be worth a
  // separate row" is a per-family judgement. Measured on this fixture, over
  // every pairing of the twelve presets and the untouched default (78 pairs):
  //   11.22  Outline Ghost <-> Watermark Faint — the NARROWEST pair shipped
  //          (both are faint, low-opacity or low-contrast neutral marks, and
  //          still a real distinction by eye: one is the icon's own ink at
  //          25% opacity, the other a forced pale-grey stencil at 18%).
  //   8      the bound used below — under the narrowest shipped pair, so it
  //          fails a table that regresses toward this collision, and still
  //          well above the DISPLAYABLE_CODE_VALUE floor.
  const MIN_SEPARATION = 8;
  let narrowest = null;
  for (let i = 0; i < FRAMES.length; i++)
    for (let j = i + 1; j < FRAMES.length; j++) {
      const d = litSetDistance(FRAMES[i].png, FRAMES[j].png, BLANK);
      if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: FRAMES[i].name, b: FRAMES[j].name, d };
      assert.ok(d.meanAbs >= MIN_SEPARATION,
        `iconify: "${FRAMES[i].name}" and "${FRAMES[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
    }
  console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
});

console.log(`\n${passed} iconify-preset tests passed`);
