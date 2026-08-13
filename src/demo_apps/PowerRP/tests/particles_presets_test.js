/**
 * THE PARTICLES-PRESET DISTINCTNESS GATE — bare node, real Skia, real pixels.
 *
 * WHAT IT PROVES: no two particle presets render the same picture, and none
 * renders the same picture as the widget's own UNTOUCHED DEFAULT (the
 * arrow_presets_test.js precedent — "a preset that reproduces the widget's
 * default is a DEAD ROW", so `(DEFAULT)` is swept alongside the presets, not
 * treated as a separate case).
 *
 * ── WHY BARE NODE ─────────────────────────────────────────────────────────────
 * particlesPlugin.emit() returns plain `ellipse` IR ops (plugins/particles.js
 * particleOps) — pure vector, no material/GPU — so it renders through the same
 * software Skia path cli/render.js and arrow_presets_test.js already use.
 *
 * ── WHY A FIXED particleTime ───────────────────────────────────────────────────
 * A particle emitter's picture is a function of (params, t, seed). Left alone,
 * emit() reads the ambient clock (render_gpu/particle_clock.js), which defaults
 * to the paused regime's EDITOR_FREEZE_TIME — already deterministic — but this
 * test pins it EXPLICITLY via setParticleTimeOverride so the render is correct
 * by construction rather than by relying on an unstated default, and restores it
 * afterward so this file has no effect on any test run after it.
 *
 * ── THE SEPARATION BOUND ──────────────────────────────────────────────────────
 * Reuses tests/imageDistinctness.js litSetDistance (mean absolute per-channel
 * difference over the pixels either frame actually touches) and
 * arrow_presets_test.js's calibrated MIN_SEPARATION = 10 — the midpoint between
 * one measured real collision (5.53) and one measured real distinction (15.14)
 * on that family. Particles are the same kind of sparse-canvas subject a
 * whole-frame mean would dilute (small dots over a mostly-empty box), so the
 * same lit-set metric and the same bound apply without re-deriving either.
 */

import assert from "node:assert/strict";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { readPng, litSetDistance } from "./imageDistinctness.js";
import { fitRectView } from "../core/view.js";
import { particlesPlugin } from "../plugins/particles.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { EDITOR_FREEZE_TIME } from "../core/particles.js";
import { BUNDLES } from "../core/properties.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

/** Lit-set levels below which two renders are the same row. The
 *  arrow_presets_test.js calibration (5.53 measured collision, 15.14 measured
 *  true distinction; 10 is their midpoint) — reused rather than re-derived,
 *  since both families compare sparse marks (arrow ink / particle dots) over a
 *  mostly-empty canvas via the same litSetDistance metric. */
const MIN_SEPARATION = 10;

const W = 300, H = 300;
const VIEW = fitRectView({ x: 0, y: 0, w: W, h: H }, W, H);
const WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

// "Nothing applied" for this widget is the canvas with no widget on it.
const BLANK = readPng(await renderToPng([], VIEW, { width: W, height: H }));

async function frame(props) {
  const s = { ...particlesPlugin.defaults, w: W, h: H, x: 0, y: 0, ...props };
  const ops = particlesPlugin.emit(s, null, WORLD);
  return readPng(await renderToPng(ops, VIEW, { width: W, height: H }));
}

await test("the roster still ships exactly the presets this gate was written for", () => {
  assert.ok(particlesPlugin.presets.length >= 10,
    `R7-39 requires >= 10 presets; found ${particlesPlugin.presets.length}`);
});

await test("no preset ships rate 0 or lifetime 0 (a ghost emitter — the widget draws nothing)", () => {
  for (const preset of particlesPlugin.presets) {
    assert.ok(preset.props.particleRate > 0, `"${preset.name}" ships particleRate <= 0`);
    assert.ok(preset.props.particleLifetime > 0, `"${preset.name}" ships particleLifetime <= 0`);
  }
});

await test("EVERY preset writes ALL 14 particle keys (the sky.js:73-82 hover-leak rule)", () => {
  const required = BUNDLES.particles.slice().sort();
  for (const preset of particlesPlugin.presets) {
    const got = Object.keys(preset.props).sort();
    assert.deepEqual(got, required,
      `"${preset.name}" writes ${JSON.stringify(got)}, expected exactly ${JSON.stringify(required)}`);
  }
});

await test("no two presets (nor the default) are data-identical", () => {
  const sigs = new Map();
  const sigOf = (props) => JSON.stringify(Object.entries(props).sort());
  sigs.set(sigOf(Object.fromEntries(BUNDLES.particles.map((k) => [k, particlesPlugin.defaults[k]]))), "(DEFAULT)");
  for (const preset of particlesPlugin.presets) {
    const sig = sigOf(preset.props);
    assert.ok(!sigs.has(sig), `"${preset.name}" has IDENTICAL props to "${sigs.get(sig)}"`);
    sigs.set(sig, preset.name);
  }
});

// Pin the ambient clock to a fixed, explicit time for the whole pixel sweep.
setParticleTimeOverride(EDITOR_FREEZE_TIME);
try {
  await test(`particles: ${particlesPlugin.presets.length} presets and the default all render a DIFFERENT picture (t=${EDITOR_FREEZE_TIME})`, async () => {
    const frames = [{ name: "(DEFAULT)", png: await frame({}) }];
    for (const preset of particlesPlugin.presets) frames.push({ name: preset.name, png: await frame(preset.props) });

    let narrowest = null;
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const d = litSetDistance(frames[i].png, frames[j].png, BLANK);
        if (!narrowest || d.meanAbs < narrowest.d.meanAbs) narrowest = { a: frames[i].name, b: frames[j].name, d };
        assert.ok(d.meanAbs >= MIN_SEPARATION,
          `"${frames[i].name}" and "${frames[j].name}" are ${d.meanAbs.toFixed(2)} lit-set levels apart (< ${MIN_SEPARATION}) — the same row twice`);
      }
    console.log(`      narrowest: ${narrowest.a} <-> ${narrowest.b}  mean=${narrowest.d.meanAbs.toFixed(2)} max=${narrowest.d.maxAbs} lit=${(narrowest.d.coverage * 100).toFixed(2)}%`);
  });
} finally {
  setParticleTimeOverride(null); // restore EDITOR_FREEZE_TIME's normal (unforced) precedence
}

console.log(`\n${passed} particles-preset tests passed`);
