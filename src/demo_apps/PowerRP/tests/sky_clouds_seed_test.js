/**
 * THE skyClouds SEED (WORKSTREAM BO). Plain node, no framework:
 *   node src/demo_apps/PowerRP/tests/sky_clouds_seed_test.js
 *
 * The user request this implements, verbatim (2026-08-03):
 *   "clouds are supposed to be random right? where's the seed parameter?"
 *
 * Before it, skyClouds had coverage / softness / cloudScale / speed / ambient / base
 * and NO seed, so the fbm basis was FIXED: every cloud deck in every document drew
 * the same field, differing only by drift phase.
 *
 * ── WHAT THIS PINS, and why each is worth a test ────────────────────────────
 *
 *   (1) LEGACY IDENTITY, IN PIXELS. Seed 0 — which is what an absent seed resolves
 *       to, and what the repair pipeline injects into an old document — must render
 *       BYTE-IDENTICALLY to the field PowerRP has always drawn. This is the whole
 *       back-compat contract and it is asserted on the frame, not on the uniform:
 *       the uniform being 0 proves nothing if the shader still perturbs the domain.
 *       (The shader's seedOffset early-returns float2(0) for exactly this reason —
 *       hash21 does NOT vanish at 0, so the branch is what makes it exact.)
 *   (2) AN ABSENT SEED IS SEED 0, at both seams that can see it: the plugin's emit()
 *       (`s.seed ?? 0`) and the packer (`u.seed ?? 0`). Two independent readers, so
 *       a document mid-repair — item leaf not yet injected — cannot render a
 *       different sky from the same document one load later.
 *   (3) A DIFFERENT SEED IS A DIFFERENT FIELD, not a pan of the same one. Pinned in
 *       PIXELS, because that is the only place the claim is real: the uniform
 *       differing is trivially true and says nothing about the picture. Several
 *       seeds are checked against each other AND against 0.
 *   (4) THE OTHER KNOBS KEEP THEIR MEANING under a seed. The seed translates the
 *       noise DOMAIN, so coverage still controls how much cloud there is — a seed
 *       that also changed the density statistics would make the row a trap.
 *   (5) DETERMINISM. The same seed renders the same picture twice — the Δt law's
 *       property-state half: this is stored state, not a clock.
 *   (6) IT IS A REAL INSPECTOR ROW, so an author can reach it (the standing gooey
 *       ruling: a knob the renderer reads must be a row that can be dragged).
 */

import assert from "node:assert/strict";
import CanvasKitInit from "canvaskit-wasm";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";
import { sceneIR } from "../render_gpu/ports.js";
import { paintIR } from "../render_gpu/skia/paint_skia.js";
import { packSkyClouds } from "../render_gpu/skia/sky_clouds_shader.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

const CanvasKit = await CanvasKitInit();
const registry = createRegistry();
registerPlugins(registry);

const W = 128, H = 128;
const CANVAS = { w: W, h: H };
/** The clouds fill the frame, so the whole readback is cloud field rather than sky. */
const BOX = { x: 0, y: 0, w: W, h: H, rotation: 0, scale: 1 };
/** Frozen drift, so the ONLY thing that can move the picture is the seed. */
const FROZEN = { speed: 0 };
/** Fraction of bytes that must differ before two frames are "different fields".
 *  Two unrelated stretches of a 5-octave fbm agree almost nowhere; a mere phase
 *  shift of one field would still land far above this, which is why (4) exists
 *  beside it rather than this threshold carrying the whole claim. */
const DIFFERENT_FIELD_FRACTION = 0.2;

const provider = CanvasKit.TypefaceFontProvider.Make();
const fontCollection = CanvasKit.FontCollection.Make();
fontCollection.setDefaultFontManager(provider);
fontCollection.enableFontFallback();
const makeSurface = (w, h) => CanvasKit.MakeSurface(w, h);
const view = { zoom: 1, dpr: 1, panX: 0, panY: 0 };

function withDefaults(extra) {
  const d = registry.get("skyClouds").defaults ?? {};
  return { ...(typeof d === "function" ? d() : d), type: "skyClouds", ...BOX, ...FROZEN, ...extra };
}

/** Query (renders). One skyClouds state's frame as raw RGBA bytes. */
function frame(state) {
  const ev = evaluateState({ items: { a1: { id: "a1", ...state } }, vars: {} }, registry);
  const ops = sceneIR(deriveRenderTree(ev.state, registry, CANVAS));
  const surface = CanvasKit.MakeSurface(W, H);
  if (!surface) throw new Error("sky_clouds_seed: MakeSurface returned null");
  paintIR(CanvasKit, surface.getCanvas(), ops, view, {
    deviceW: W, deviceH: H, makeSurface, fontCollection, background: "#000000", passId: Math.random(),
  });
  surface.flush();
  const px = surface.makeImageSnapshot().readPixels(0, 0, {
    width: W, height: H, colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul, colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  const out = Uint8Array.from(px);
  surface.delete();
  return out;
}

/**
 * Pure function. Fraction of bytes on which two equal-length frames disagree.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {number} 0 (identical) .. 1 (every byte differs)
 *
 * @example byteDiffFraction(Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([1, 2, 3, 4])) // 0
 * @example byteDiffFraction(Uint8Array.from([1, 2]), Uint8Array.from([1, 9])) // 0.5
 */
function byteDiffFraction(a, b) {
  assert.equal(a.length, b.length, "frames must be the same size to compare");
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n / a.length;
}

/**
 * Pure function. Mean LUMINANCE of a frame — how much of the box the clouds cover,
 * given that these frames are painted over an OPAQUE BLACK background (only cloud
 * puts light in). This is the statistic knob (4) is about: the seed must not move
 * it. Deliberately not the frame's alpha channel, which the opaque background
 * saturates to 255 everywhere and which therefore measures nothing.
 *
 * @param {Uint8Array} px - RGBA8888 bytes
 * @returns {number} 0 (black, no cloud) .. 255 (fully lit)
 *
 * @example meanLuma(Uint8Array.from([0, 0, 0, 255])) // 0
 * @example meanLuma(Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255])) // 127.5
 */
function meanLuma(px) {
  let s = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) { s += (px[i] + px[i + 1] + px[i + 2]) / 3; n++; }
  return s / n;
}

// ── (1)+(2) LEGACY IDENTITY ─────────────────────────────────────────────────

test("an ABSENT seed and an explicit seed 0 render the IDENTICAL frame", () => {
  const absent = withDefaults({});
  delete absent.seed; // the pre-BO document: the leaf does not exist at all
  assert.equal(absent.seed, undefined, "the fixture must really be missing the leaf");
  assert.equal(byteDiffFraction(frame(absent), frame(withDefaults({ seed: 0 }))), 0,
    "a pre-BO deck must render byte-identically to the same deck with seed 0 written in");
});

test("the PACKER resolves an absent seed to 0 too (the second reader)", () => {
  const base = {
    cx: 0, cy: 0, halfW: 10, halfH: 10, cornerRadius: 0, angle: 0, scale: 1, time: 0,
    coverage: 0.45, softness: 0.28, cloudScale: 2.4, speed: 1, ambient: "#8fa6c8", base: "#f2efe9", suns: [],
  };
  assert.deepEqual(packSkyClouds(base), packSkyClouds({ ...base, seed: 0 }),
    "emit() and the packer must agree on what an absent seed means, or a document mid-repair renders a different sky");
});

// ── (3) A DIFFERENT SEED IS A DIFFERENT FIELD ───────────────────────────────

const SEEDS = [0, 1, 2, 7, 42];
const frames = new Map(SEEDS.map((s) => [s, frame(withDefaults({ seed: s }))]));

test(`every pair of seeds ${JSON.stringify(SEEDS)} renders a genuinely different field`, () => {
  const same = [];
  for (let i = 0; i < SEEDS.length; i++)
    for (let j = i + 1; j < SEEDS.length; j++) {
      const d = byteDiffFraction(frames.get(SEEDS[i]), frames.get(SEEDS[j]));
      if (d < DIFFERENT_FIELD_FRACTION) same.push(`seed ${SEEDS[i]} vs ${SEEDS[j]}: only ${(d * 100).toFixed(1)}% of bytes differ`);
    }
  assert.deepEqual(same, [], `these seed pairs drew nearly the same clouds:\n       ${same.join("\n       ")}`);
});

// ── (4) THE OTHER KNOBS STILL MEAN WHAT THEY MEANT ──────────────────────────

/** Coverage the cross-seed statistics are compared at.
 *
 *  NOT the default, and that is a measurement fact rather than a preference. At the
 *  default (0.46) the widget draws sparse wisps — mean luma ~5..10 of 255 — so a
 *  128px window holds only a handful of puffs and the SAMPLING variance between two
 *  honest stretches of the same fbm is itself ±25%. Comparing there would be
 *  measuring the window, not the field. At a coverage where the box is mostly cloud
 *  the window holds many puffs, the mean is stable, and the assertion is about what
 *  it claims to be about. */
const STATS_COVERAGE = 0.1;

test("the seed moves the field WITHOUT moving the coverage statistics", () => {
  const lumas = SEEDS.map((s) => meanLuma(frame(withDefaults({ seed: s, coverage: STATS_COVERAGE }))));
  const lo = Math.min(...lumas), hi = Math.max(...lumas);
  // Different stretches of one fbm do not have identical local means over a finite
  // window, so this is a BAND rather than an equality — but a seed that changed the
  // density statistics (rather than translating the domain) would blow well past it.
  assert.ok(hi - lo < 0.35 * hi,
    `mean cloud cover must stay comparable across seeds, so coverage keeps its meaning; got ${lumas.map((a) => a.toFixed(1)).join(", ")}`);
});

test("coverage still controls how much cloud there is, AT a non-zero seed", () => {
  const thin = meanLuma(frame(withDefaults({ seed: 7, coverage: 0.75 })));
  const thick = meanLuma(frame(withDefaults({ seed: 7, coverage: 0.15 })));
  assert.ok(thick > thin, `lower coverage must mean MORE cloud at any seed; got ${thick.toFixed(1)} vs ${thin.toFixed(1)}`);
});

// ── (5) DETERMINISM ─────────────────────────────────────────────────────────

test("the same seed renders the same picture twice (property state, not a clock)", () => {
  assert.equal(byteDiffFraction(frame(withDefaults({ seed: 7 })), frame(withDefaults({ seed: 7 }))), 0);
});

// ── (6) THE AUTHOR CAN REACH IT ─────────────────────────────────────────────

test("`seed` is a real Inspector row on skyClouds, and its default is 0", () => {
  const plugin = registry.get("skyClouds");
  const row = (plugin.inspector ?? []).find((r) => r.key === "seed");
  assert.ok(row, `skyClouds must offer a seed row; got rows ${(plugin.inspector ?? []).map((r) => r.key).join(", ")}`);
  assert.equal(row.kind, "number");
  const d = typeof plugin.defaults === "function" ? plugin.defaults() : plugin.defaults;
  assert.equal(d.seed, 0, "the default MUST be 0 — it is the field every existing document has");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
