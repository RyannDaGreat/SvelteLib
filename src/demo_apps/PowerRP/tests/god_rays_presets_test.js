/**
 * THE `demo_god_rays` PRESET LIBRARY suite — plain node, no browser.
 * Run: node src/demo_apps/PowerRP/tests/god_rays_presets_test.js
 *
 * WHY THIS FILE EXISTS, IN ONE SENTENCE: two of the five presets this widget
 * shipped were broken BY CONSTRUCTION and the whole gate was green, because
 * nothing rendered them.
 *
 * "Storm Break" sat at a peak gain of 1.017 — past the shader's own clamp, so
 * guaranteed flat white wherever the march is all-source, before any scene is
 * considered — and "Cinematic Beams" at 0.775 blew 91% of a realistic sky deck.
 * tests/god_rays_test.js checks shape, finiteness and determinism and would have
 * passed either forever. The absence of a per-preset PIXEL check was the actual
 * defect; this is it.
 *
 * The shape is tests/frosted_presets_test.js's, because these are the same facts
 * about a different material and a second dialect of the same suite is how the
 * hand-maintained-mirror defect spreads. The generic half of that shape —
 * placement keys, values legal for their own Inspector row, names, descriptions,
 * uniqueness, equation form, identical-props — is NOT repeated here: it lives
 * once in tests/preset_contract_test.js, over every plugin in the roster. What is
 * god-rays-specific lives in checks (1)-(3).
 *
 *   (1) THE TEN-KNOB CEILING. Unlike the lens flare, whose presets each carry a
 *     `blendMode`, a god-rays preset may name ONLY the ten GOD_RAYS_FILL_PARAMS —
 *     the knobs are declared in the SHADER and spread through `customProps`, and
 *     tests/god_rays_test.js:150 refuses any other key. So "every look knob" here
 *     is a ceiling as well as a floor, and this check reads the schema rather
 *     than a transcribed list.
 *
 *   (2) THE GAIN LAW, structurally. The march accumulates
 *     `sourceKey(tap)*decay^i*weight` and scales the sum by `exposure`, so the
 *     PEAK possible ray value is G = weight*exposure*S with
 *     S = (1-decay^samples)/(1-decay), and the shader clamps to 1. Two
 *     consequences are asserted, both of which the shipped set violated:
 *     G < 1 (above it a row is flat white by construction, no scene involved),
 *     and weight === exposure. The second is not a style rule: the two knobs
 *     appear ONLY as a product, so two rows trading one against the other at a
 *     fixed G are pixel-identical — a dead row wearing two names. Writing them
 *     equal makes that mistake unavailable rather than merely discouraged.
 *
 *   (3) DISTINCTNESS IN PIXELS, INCLUDING THE UNTOUCHED WIDGET. Every preset is
 *     rendered over one fixture and scored pairwise with the shared metric
 *     (tests/imageDistinctness.js — per-channel, colour-aware; NOT a byte digest,
 *     which passes any pair differing by one bit). The widget's own DEFAULTS are
 *     rendered as a row too: a default that matches a preset is a dead row no
 *     preset-vs-preset comparison can ever see, and the fix for one is to move
 *     the DEFAULT, since the preset models a real condition and carries a
 *     citation while the default is ours to choose.
 *
 *     THE BOUND IS `maxAbs`, NOT A MEAN, AND THAT IS THE POINT. A low-`density`
 *     preset only marches a small neighbourhood of the light, so ANY mean over a
 *     region larger than that neighbourhood dilutes it: measured, Harbour
 *     Searchlight and Dusty Window sit 0.886 apart on the whole-frame mean and
 *     3.774 on the lit set they actually touch — a 4.3x dilution — while their
 *     largest single channel differs by 12 under either. No averaging over any
 *     region can hide a single-channel outlier, so `maxAbs` needs no reduction
 *     choice at all. The lit-set mean is REPORTED beside it, because it is the
 *     honest number for an author reading how close two rows are getting.
 *
 *     THIS FAMILY IS NOT THE SPARSE CASE `litSetDistance` EXISTS FOR, and that
 *     was measured rather than assumed: coverage is 96.5% for most pairs here, so
 *     the two means agree within 3% and only the handful of low-density rows
 *     diverge. A connector, where the lit set is 0.5-2% of the canvas, is the
 *     case where the whole-frame mean gates nothing at all.
 *
 *   (4) SATURATION, in pixels. Distinct from (2) because G is the PEAK and the
 *     rays composite ADDITIVELY, so the real clip point is G + backdrop: a row
 *     clean over a dim interior can still blow out over a bright sky.
 */

import assert from "node:assert/strict";
import { godRaysPlugin } from "../plugins/demo/god_rays.js";
import { GOD_RAYS_FILL_PARAMS, godRaysUniformParams } from "../render_gpu/skia/god_rays_shader.js";
import { materialBackdrop, rect } from "../render_gpu/ir.js";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { imageDistance, litSetDistance, readPng } from "./imageDistinctness.js";

let passed = 0;
/** Command. Runs one check and prints its outcome (throws on failure). */
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const PRESETS = godRaysPlugin.presets;
const KNOB_NAMES = GOD_RAYS_FILL_PARAMS.map((d) => d.name);
const DEFAULT_KNOBS = Object.fromEntries(GOD_RAYS_FILL_PARAMS.map((d) => [d.name, d.default]));

// The shader's own clamp. `rays = clamp(accum * exposure * tint * edgeFade, 0, 1)`
// (render_gpu/skia/god_rays_shader.js), so a peak gain at or above 1 is flat white
// by construction. Not a tuning choice — it is the ceiling the shader states.
const SHADER_CLAMP = 1;
// The compile-time loop bound godRaysUniformParams rounds and clamps `samples` to.
const MAX_SAMPLES = GOD_RAYS_FILL_PARAMS.find((d) => d.name === "samples").max;

/**
 * Pure function. THE PEAK POSSIBLE RAY VALUE of a knob set: the march's geometric
 * decay ladder times the two gain knobs, before the shader's clamp.
 *
 *     G = weight · exposure · S,   S = (1 − decay^n) / (1 − decay),   n = samples
 *
 * @param {{samples: number, decay: number, weight: number, exposure: number}} knobs
 * @returns {number} peak ray value; >= 1 means flat white wherever the march is all-source
 *
 * @example Math.round(peakGain({samples: 64, decay: 0.975, weight: 0.1, exposure: 0.1}) * 1000) / 1000 // 0.321
 * @example // the shipped "Storm Break" that this library replaced, past the clamp:
 * Math.round(peakGain({samples: 96, decay: 0.986, weight: 0.16, exposure: 0.12}) * 1000) / 1000 // 1.017
 */
function peakGain({ samples, decay, weight, exposure }) {
  const n = Math.max(1, Math.min(MAX_SAMPLES, Math.round(samples)));
  const ladder = decay >= 1 ? n : (1 - Math.pow(decay, n)) / (1 - decay);
  return weight * exposure * ladder;
}

// ── (1) the ten-knob ceiling ─────────────────────────────────────────────────
test("(1) every preset writes EXACTLY the ten shader knobs — no more, no fewer", () => {
  assert.ok(PRESETS.length >= 10, `${PRESETS.length} presets — manifest item 70 asks for at least ten`);
  for (const preset of PRESETS) {
    const written = Object.keys(preset.props).sort();
    assert.deepEqual(written, [...KNOB_NAMES].sort(),
      `"${preset.name}" writes ${written.join(", ")} — application is an OVERLAY, so a knob a preset omits keeps whatever the previously HOVERED preset left there, and an ELEVENTH key takes tests/god_rays_test.js red`);
  }
});

// ── (2) the gain law ─────────────────────────────────────────────────────────
test("(2) no preset's peak gain reaches the shader's clamp", () => {
  for (const preset of PRESETS) {
    const g = peakGain(preset.props);
    assert.ok(g < SHADER_CLAMP,
      `"${preset.name}" has peak gain ${g.toFixed(3)} >= ${SHADER_CLAMP} — flat white wherever the march is all-source, before any scene is considered. That is how the shipped "Storm Break" (1.017) shipped broken.`);
  }
});

test("(2b) every preset writes weight === exposure, so the pair reads as ONE dial", () => {
  for (const preset of PRESETS)
    assert.equal(preset.props.weight, preset.props.exposure,
      `"${preset.name}" writes weight ${preset.props.weight} and exposure ${preset.props.exposure}. They appear only as a PRODUCT, so another row at the same product would render an identical picture under a different name.`);
});

// ── the RENDER rig, shared by checks (3) and (4) ─────────────────────────────
// Small on purpose: every frame is a per-pixel ray march on a SOFTWARE surface and
// this renders one per preset plus two references. Verified resolution-independent
// — at 400x250 the tightest pair measures maxAbs 7 / mean 2.955 and here 7 / 2.950,
// so the extra 2.4x of pixels buys no accuracy and 2.4x of wall clock.
const RENDER_W = 256, RENDER_H = 160;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
// A sky, a white sun disc high and centred, and one hard occluder below it — the
// fixture render_gpu/tests/god_rays_occlusion_test.js uses, in proportion, so the
// numbers here and there are about the same picture.
const SUN = { x: RENDER_W / 2, y: RENDER_H * 0.15, r: RENDER_H * 0.1375 };
const OCCLUDER = { x: RENDER_W * 0.39, y: RENDER_H * 0.375, w: RENDER_W * 0.1875, h: RENDER_H * 0.175 };
const SKY_FILL = "#8fb4d8";
// "This channel is at the top of the 8-bit range" — one code value of slack, so a
// dithered 254 counts as blown rather than sneaking under a ==255 test.
const CLIP_BYTE = 254;

/**
 * Query (renders on a software Skia surface). One frame of the fixture, with the
 * god-rays material over it if `knobs` is given.
 *
 * @param {object|null} knobs - preset props, {} for the widget defaults, null for unlit
 * @returns {Promise<{width: number, height: number, data: Buffer}>} decoded RGBA
 */
async function render(knobs) {
  const scene = [
    rect({ x: 0, y: 0, w: RENDER_W, h: RENDER_H, fill: SKY_FILL }),
    rect({ x: SUN.x - SUN.r, y: SUN.y - SUN.r, w: SUN.r * 2, h: SUN.r * 2, fill: "#ffffff", cornerRadius: SUN.r }),
    rect({ ...OCCLUDER, fill: "#000000" })
  ];
  if (knobs) scene.push(materialBackdrop({
    material: "god_rays",
    cx: RENDER_W / 2, cy: RENDER_H / 2, halfW: RENDER_W / 2, halfH: RENDER_H / 2, cornerRadius: 0, blurRadius: 0,
    params: {
      lightOffsetX: SUN.x - RENDER_W / 2, lightOffsetY: SUN.y - RENDER_H / 2,
      ...godRaysUniformParams({ ...DEFAULT_KNOBS, ...knobs })
    }
  }));
  return readPng(await renderToPng(scene, VIEW, { width: RENDER_W, height: RENDER_H, background: "#111111" }));
}

const unlit = await render(null);
// THE UNTOUCHED WIDGET IS A ROW IN THE COMPARISON (ledger C-16): a default that
// renders as some preset is a dead row invisible to any preset-vs-preset check.
const frames = [{ name: "(widget defaults)", png: await render({}) }];
for (const preset of PRESETS) frames.push({ name: preset.name, png: await render(preset.props) });

// ── (3) pixel distinctness ───────────────────────────────────────────────────
// CALIBRATED, not picked (R6-25.3 leaves the bound to each family and derives only
// the floor). Measured over all 210 pairs of this table: the tightest is
// Subtle Morning <-> Cathedral Dust Shaft at maxAbs 7, two faint interior shafts
// separated by threshold 0.60 vs 0.86 — the certified correctly-distinct pair this
// bound is set against. 4 sits 1.75x below it and 4x above DISPLAYABLE_CODE_VALUE,
// the one derivable floor.
const MIN_PAIR_MAX_DELTA = 4;

test("(3) every pair renders distinguishably, the widget's own defaults included", () => {
  const tight = [];
  let narrowest = null;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++) {
      const d = imageDistance(frames[i].png, frames[j].png);
      const lit = litSetDistance(frames[i].png, frames[j].png, unlit);
      if (d.maxAbs < MIN_PAIR_MAX_DELTA) tight.push(`${frames[i].name} <-> ${frames[j].name} (maxAbs ${d.maxAbs}, lit-set mean ${lit.meanAbs.toFixed(3)})`);
      if (!narrowest || d.maxAbs < narrowest.d.maxAbs) narrowest = { a: frames[i].name, b: frames[j].name, d, lit };
    }
  assert.deepEqual(tight, [],
    `these render as the same picture: ${tight.join("; ")}. A preset whose props do not move a pixel is a dead row in the library — and if one side is "(widget defaults)", move the DEFAULT, not the sourced preset.`);
  console.log(`      narrowest: ${narrowest.a} vs ${narrowest.b} — maxAbs ${narrowest.d.maxAbs}, lit-set mean ${narrowest.lit.meanAbs.toFixed(3)} over ${(100 * narrowest.lit.coverage).toFixed(1)}% of the frame (whole-frame mean ${narrowest.d.meanAbs.toFixed(3)})`);
});

// ── (4) saturation in pixels ─────────────────────────────────────────────────
// The rays composite ADDITIVELY, so G bounds the ray contribution and not the
// result. Measured on this fixture: the loudest row of the library (Ruin Skylight)
// blows 0.283% and the widget defaults 0.264%, while the two broken presets this
// library replaced measured 5.87% and 5.47% on the occlusion suite's own fixture
// and 91% on a realistic sky deck. 1% is 3.5x above the worst legitimate row and
// well under a fifth of the smallest defect it has to catch.
const MAX_BLOWN_FRACTION = 0.01;

test("(4) no preset drives the frame to flat white", () => {
  for (const frame of frames) {
    let blown = 0;
    const lit = frame.png.data, dark = unlit.data;
    for (let i = 0; i < lit.length; i += 4) {
      const white = lit[i] >= CLIP_BYTE && lit[i + 1] >= CLIP_BYTE && lit[i + 2] >= CLIP_BYTE;
      // The sun disc is ALREADY white unlit; only count what the RAYS blew out.
      const wasWhite = dark[i] >= CLIP_BYTE && dark[i + 1] >= CLIP_BYTE && dark[i + 2] >= CLIP_BYTE;
      if (white && !wasWhite) blown++;
    }
    const fraction = blown / (lit.length / 4);
    assert.ok(fraction < MAX_BLOWN_FRACTION,
      `"${frame.name}" drives ${(100 * fraction).toFixed(2)}% of the frame to flat white. Saturation is a DISTINCTNESS bug, not only a taste one: two blown presets converge on the same picture.`);
  }
});

console.log(`\n${passed} checks passed over ${PRESETS.length} presets (${frames.length} frames at ${RENDER_W}x${RENDER_H})`);
