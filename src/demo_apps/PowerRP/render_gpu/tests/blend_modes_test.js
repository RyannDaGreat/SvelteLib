/**
 * THE BLEND-MODE CORRECTNESS SUITE — plain node, no framework (core_test.js /
 * effects_test.js style). Run:
 *   node render_gpu/tests/blend_modes_test.js
 *
 * The claim under test is "PowerRP has Photoshop's blend modes", and the failure
 * mode that claim invites is a mode that RENDERS but computes the wrong thing —
 * invisible in review, because every blend mode produces *some* plausible
 * picture. So nothing here trusts the shader: an INDEPENDENT JavaScript
 * implementation of each documented formula (blend_oracle.js — written from the
 * PDF 32000-1 / W3C compositing spec and Photoshop's documented behaviour, NOT
 * transliterated from the SkSL) is the oracle, and every mode — native and SkSL
 * alike — must match it.
 *
 * The four checks, in order of what they rule out:
 *   1. WRAPPER — feed blendSkSL() reference bodies for the eleven modes Skia
 *      ALSO implements natively and require setBlender to match setBlendMode.
 *      This is what licenses the nine custom formulas: if the premultiply /
 *      union-alpha algebra were wrong, these eleven would drift.
 *   2. NATIVE MAP — every SKIA_NATIVE_BLEND_MODES entry names a real
 *      CanvasKit.BlendMode AND computes the reference formula. Catches a
 *      plausible-but-wrong mapping (screen→Plus, multiply→Modulate).
 *   3. SkSL FORMULAS — each of the nine custom blenders matches the reference.
 *   4. DISTINCTNESS — all 26 modes differ pairwise over the sample chart. This
 *      is the automated form of "a mode that looks like Normal is a bug".
 * Plus: the loud guards, and the four legacy ids' exact behaviour.
 *
 * Node-only (its own CanvasKit instance via createRequire — deliberately does
 * NOT touch node_render, so this process holds exactly one WASM module; the
 * end-to-end pipeline check through paintIR lives in blend_contact_sheet.js).
 */

import assert from "node:assert/strict";
import { createRequire } from "module";
import path from "path";
import { BLEND_MODES, BLEND_MODE_LABELS } from "../../core/properties.js";
import { SKIA_NATIVE_BLEND_MODES, BLEND_MIX_BODIES, blendSkSL, blendNeedsSkSL, blenderFor } from "../skia/blend_modes.js";
import { PDF_BLEND_NAMES, blendNeedsBelowRaster } from "../pdf_backend.js";
import { compositeReference } from "./blend_oracle.js";

const require = createRequire(import.meta.url);
const CanvasKitInit = require("canvaskit-wasm/bin/canvaskit.js");
const CK_BIN = path.dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const CanvasKit = await CanvasKitInit({ locateFile: (f) => path.join(CK_BIN, f) });

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

// ── TOLERANCES: every one is MEASURED, and every one has a stated cause ───────
// The surface is RGBA_8888, so a partial-alpha backdrop is stored premultiplied
// and quantized; unpremultiplying it back gives the shader a Cb up to ~1/255
// away from the float value the oracle uses. Hence a 1-level floor everywhere.
const LEVEL_TOLERANCE = 1;
// The NON-SEPARABLE modes run three more float steps (SetSat → SetLum →
// ClipColor) on that already-quantized Cb before the result is re-quantized.
// Measured worst: 1. Held at 2.
const NONSEPARABLE_TOLERANCE = 2;
const NONSEPARABLE_MODES = ["hue", "saturation", "color", "luminosity"];
// The RECIPROCAL modes divide by a channel, so a ~1/255 input error is amplified
// by 1/Cs near zero. Skia's own ColorBurn/ColorDodge raster stages additionally
// use an APPROXIMATE reciprocal (rcp), which is where most of this comes from —
// measured worst 5 for both, and 3 for the SkSL vividLight (real division, but
// two nested burn/dodge branches over a quantized backdrop). Held at 5.
// This is Skia's arithmetic, not a mapping error: the "closest formula" test
// below is what actually proves the mapping, with no tolerance at all.
const RECIPROCAL_TOLERANCE = 5;
const RECIPROCAL_MODES = ["colorBurn", "colorDodge", "vividLight", "divide"];
// The DISCONTINUOUS modes have a step in their definition (Hard Mix thresholds at
// Cb+Cs = 1; Darker/Lighter Color pick a whole colour by comparing channel
// totals). Within ~1/255 of that step, a quantized backdrop flips the branch and
// the channel jumps the FULL range — measured 255, which is the definition
// working, not a defect. They are therefore checked over MARGIN_SAFE_CASES
// (every decision comfortably clear of its boundary) plus their own explicit
// boundary-behaviour tests below.
const DISCONTINUOUS_MODES = ["hardMix", "darkerColor", "lighterColor"];

// ── THE ORACLE ────────────────────────────────────────────────────────────────
// blend_oracle.js holds it: an INDEPENDENT JS implementation of every documented
// formula, transcribed from PDF 32000-1 / Photoshop's docs and NOT from the SkSL.
// It lives in its own pure module so this suite, the contact sheet and the export
// parity suite all measure against ONE definition of correct (and so importing
// the oracle never drags a second CanvasKit instance into a process).

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ── the 1x1 render harness ────────────────────────────────────────────────────

/** Query. Draws `dst` then `src` through `setup`, and reads the unpremultiplied
 * 8-bit result. One pixel, CPU surface — the smallest possible blend probe. */
function blendPixel(dst, src, setup) {
  const surface = CanvasKit.MakeSurface(1, 1);
  if (!surface) throw new Error("blend_modes_test: MakeSurface(1,1) returned null");
  const canvas = surface.getCanvas();
  canvas.clear(CanvasKit.Color4f(0, 0, 0, 0));
  const pd = new CanvasKit.Paint();
  pd.setColor(CanvasKit.Color4f(...dst));
  pd.setBlendMode(CanvasKit.BlendMode.Src); // lay the backdrop down EXACTLY as given
  canvas.drawPaint(pd);
  pd.delete();
  const ps = new CanvasKit.Paint();
  ps.setColor(CanvasKit.Color4f(...src));
  setup(ps);
  canvas.drawPaint(ps);
  ps.delete();
  surface.flush();
  const bytes = canvas.readPixels(0, 0, {
    width: 1, height: 1,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Unpremul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  });
  const out = [bytes[0], bytes[1], bytes[2], bytes[3]];
  surface.dispose();
  return out;
}

const to8 = (c) => c.map((v) => Math.round(clamp01(v) * 255));
const maxDelta = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// Sample pairs. OPAQUE_CASES exercise the blend function itself (αo = 1, so the
// composite reduces to B); ALPHA_CASES additionally exercise the union algebra,
// including the near-0 and near-1 channels where colorBurn/colorDodge/divide
// switch branches.
const OPAQUE_CASES = [
  { dst: [0.25, 0.5, 0.75, 1], src: [0.8, 0.4, 0.2, 1] },
  { dst: [0, 1, 0.5, 1], src: [1, 0, 0.5, 1] },
  { dst: [0.02, 0.98, 0.5, 1], src: [0.98, 0.02, 0.5, 1] },
  { dst: [1, 1, 1, 1], src: [0, 0, 0, 1] },
  { dst: [0.6, 0.6, 0.6, 1], src: [0.5, 0.5, 0.5, 1] },
];
const ALPHA_CASES = [
  { dst: [0.25, 0.5, 0.75, 1], src: [0.8, 0.4, 0.2, 0.5] },
  { dst: [0.9, 0.1, 0.6, 0.7], src: [0.05, 0.95, 0.3, 0.6] },
  { dst: [0.02, 0.98, 0.5, 0.3], src: [0.98, 0.02, 0.5, 0.9] },
];
// For the DISCONTINUOUS modes: every per-channel sum is ≥ 0.05 clear of the Hard
// Mix threshold (1.0) and every channel-total comparison is ≥ 0.05 clear of a tie,
// so a 1/255 backdrop wobble cannot flip a branch. (The default cases above
// deliberately include exact ties/boundaries — great for the continuous modes,
// meaningless for a step function.)
const MARGIN_SAFE_CASES = [
  { dst: [0.20, 0.55, 0.80, 1], src: [0.70, 0.65, 0.15, 1] },   // sums .90/1.20/.95; totals 1.55 vs 1.50
  { dst: [0.85, 0.15, 0.45, 1], src: [0.30, 0.90, 0.70, 1] },   // sums 1.15/1.05/1.15; totals 1.45 vs 1.90
  { dst: [0.30, 0.40, 0.20, 1], src: [0.90, 0.80, 0.95, 1] },   // sums 1.20/1.20/1.15; totals 0.90 vs 2.65
  { dst: [0.80, 0.20, 0.60, 0.7], src: [0.10, 0.90, 0.30, 0.6] }, // partial alpha; sums .90/1.10/.90
];

/** Pure function. The measured tolerance for `mode`, with its cause named above.
 * @example toleranceFor("multiply") // 1
 * @example toleranceFor("colorBurn") // 5
 */
function toleranceFor(mode) {
  if (RECIPROCAL_MODES.includes(mode)) return RECIPROCAL_TOLERANCE;
  if (NONSEPARABLE_MODES.includes(mode)) return NONSEPARABLE_TOLERANCE;
  return LEVEL_TOLERANCE;
}

/** Pure function. The sample cases `mode` is comparable over: a step function is
 * only meaningful away from its step.
 * @example casesFor("multiply").length // 8
 */
function casesFor(mode) {
  if (DISCONTINUOUS_MODES.includes(mode)) return MARGIN_SAFE_CASES;
  // `add` is Skia's Plus: premultiplied addition, NOT the union composite, so it
  // is only comparable where both sides are opaque (there the two agree).
  if (mode === "add") return OPAQUE_CASES;
  return [...OPAQUE_CASES, ...ALPHA_CASES];
}

/** Query. The composite `mode` actually renders through the SHIPPED dispatch —
 * native setBlendMode or the cached SkSL blender, exactly as paint_skia does it. */
function shippedSetup(mode) {
  return blendNeedsSkSL(mode)
    ? (p) => p.setBlender(blenderFor(CanvasKit, mode))
    : (p) => p.setBlendMode(CanvasKit.BlendMode[SKIA_NATIVE_BLEND_MODES[mode]]);
}

/** Query. The worst 8-bit deviation of a rendered mode from the oracle over `cases`. */
function worstDeviation(mode, cases, setup) {
  let worst = 0, at = null;
  for (const { dst, src } of cases) {
    const got = blendPixel(dst, src, setup);
    const want = to8(compositeReference(mode, src, dst));
    const d = maxDelta(got, want);
    if (d > worst) { worst = d; at = { dst, src, got, want }; }
  }
  return { worst, at };
}

// ── 1. THE WRAPPER (what licenses the nine custom formulas) ───────────────────

// Hand-written mixColor bodies for modes Skia ALSO implements natively. These are
// TEST-ONLY: they exist so blendSkSL's premultiply/union algebra can be compared
// against Skia's own compositor on eleven independent formulas.
const WRAPPER_PROOF_BODIES = {
  multiply: `return Cb * Cs;`,
  screen: `return Cb + Cs - Cb * Cs;`,
  darken: `return min(Cb, Cs);`,
  lighten: `return max(Cb, Cs);`,
  difference: `return abs(Cb - Cs);`,
  exclusion: `return Cb + Cs - 2.0 * Cb * Cs;`,
  overlay: `half3 r; for (int i = 0; i < 3; ++i) { half b = Cb[i], s = Cs[i];
              r[i] = (b <= 0.5) ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s)); } return r;`,
  hardLight: `half3 r; for (int i = 0; i < 3; ++i) { half b = Cb[i], s = Cs[i];
                r[i] = (s <= 0.5) ? (2.0 * s * b) : (1.0 - 2.0 * (1.0 - s) * (1.0 - b)); } return r;`,
  colorBurn: `half3 r; for (int i = 0; i < 3; ++i) { half b = Cb[i], s = Cs[i];
                r[i] = (b >= 1.0) ? 1.0 : (s <= 0.0) ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); } return r;`,
  colorDodge: `half3 r; for (int i = 0; i < 3; ++i) { half b = Cb[i], s = Cs[i];
                 r[i] = (b <= 0.0) ? 0.0 : (s >= 1.0) ? 1.0 : min(1.0, b / (1.0 - s)); } return r;`,
  softLight: `half3 r; for (int i = 0; i < 3; ++i) { half b = Cb[i], s = Cs[i];
                half d = (b <= 0.25) ? (((16.0 * b - 12.0) * b + 4.0) * b) : sqrt(b);
                r[i] = (s <= 0.5) ? (b - (1.0 - 2.0 * s) * b * (1.0 - b)) : (b + (2.0 * s - 1.0) * (d - b)); } return r;`,
};

/** Query→build. Compiles a blender from a mixColor body; throws with the SkSL error. */
function proofBlender(body) {
  let err = null;
  const effect = CanvasKit.RuntimeEffect.MakeForBlender(blendSkSL(body), (e) => { err = e; });
  if (!effect) throw new Error(`blend_modes_test: proof shader failed to compile:\n${err}`);
  return effect.makeBlender([]);
}

test("WRAPPER: blendSkSL's composite matches Skia's OWN compositor for 11 formulas", () => {
  const cases = [...OPAQUE_CASES, ...ALPHA_CASES];
  for (const [mode, body] of Object.entries(WRAPPER_PROOF_BODIES)) {
    const nativeKey = SKIA_NATIVE_BLEND_MODES[mode];
    assert.ok(nativeKey, `${mode} should be native — the proof compares against setBlendMode`);
    const blender = proofBlender(body);
    for (const { dst, src } of cases) {
      const viaNative = blendPixel(dst, src, (p) => p.setBlendMode(CanvasKit.BlendMode[nativeKey]));
      const viaSkSL = blendPixel(dst, src, (p) => p.setBlender(blender));
      const d = maxDelta(viaNative, viaSkSL);
      assert.ok(d <= LEVEL_TOLERANCE, `blendSkSL(${mode}) drifted from CanvasKit.BlendMode.${nativeKey} by ${d}/255 at dst=${dst} src=${src}: native=${viaNative} sksl=${viaSkSL} — the premultiply/union algebra in the wrapper is wrong, so every custom mode is wrong too`);
    }
  }
});

// ── 2. THE NATIVE MAP (a plausible-but-wrong mapping) ─────────────────────────

test("NATIVE: every mapped mode names a real CanvasKit.BlendMode", () => {
  for (const [mode, key] of Object.entries(SKIA_NATIVE_BLEND_MODES))
    assert.ok(CanvasKit.BlendMode[key] !== undefined, `blend "${mode}" maps to CanvasKit.BlendMode.${key}, which does not exist in this build`);
});

test("NATIVE: every mapped mode COMPUTES its reference formula (not a lookalike)", () => {
  for (const [mode, key] of Object.entries(SKIA_NATIVE_BLEND_MODES)) {
    const tol = toleranceFor(mode);
    const { worst, at } = worstDeviation(mode, casesFor(mode), (p) => p.setBlendMode(CanvasKit.BlendMode[key]));
    assert.ok(worst <= tol, `"${mode}" → CanvasKit.BlendMode.${key} deviates ${worst}/255 from the ${mode} formula (tolerance ${tol}) at ${JSON.stringify(at)} — the mapping computes a DIFFERENT blend than its name promises`);
  }
});

// ── 3. THE NINE SkSL FORMULAS ─────────────────────────────────────────────────

test("SkSL: each custom blender compiles and matches its reference formula", () => {
  for (const mode of Object.keys(BLEND_MIX_BODIES)) {
    const blender = blenderFor(CanvasKit, mode);
    const tol = toleranceFor(mode);
    const { worst, at } = worstDeviation(mode, casesFor(mode), (p) => p.setBlender(blender));
    assert.ok(worst <= tol, `SkSL blend "${mode}" deviates ${worst}/255 from its documented formula (tolerance ${tol}) at ${JSON.stringify(at)}`);
  }
});

test("CLOSEST: every mode is nearer its OWN formula than any of the other 25", () => {
  // The tolerance-free correctness statement, and the one that actually rules out
  // a swapped mapping (screen↔add, overlay↔hardLight, darken↔darkerColor): a
  // rendered mode must be strictly closer to its own oracle than to every rival's
  // over the shared MARGIN_SAFE_CASES chart. A tolerance can be argued about; this
  // cannot.
  for (const mode of BLEND_MODES) {
    const setup = shippedSetup(mode);
    const own = worstDeviation(mode, MARGIN_SAFE_CASES, setup).worst;
    for (const rival of BLEND_MODES) {
      if (rival === mode) continue;
      const other = worstDeviation(rival, MARGIN_SAFE_CASES, setup).worst;
      assert.ok(other > own, `"${mode}" renders at distance ${own} from its own formula but ${other} from "${rival}"'s — it is computing ${rival === "normal" ? "no blend at all" : `"${rival}"`}, not "${mode}"`);
    }
  }
});

test("SkSL: blenderFor MEMOIZES per mode (recompiling every draw would be a stall)", () => {
  for (const mode of Object.keys(BLEND_MIX_BODIES))
    assert.equal(blenderFor(CanvasKit, mode), blenderFor(CanvasKit, mode), `blenderFor("${mode}") returned a fresh blender — the cache is broken`);
});

test("SkSL: divide by a ZERO source is white, and no mode ever yields NaN", () => {
  // The two hazards a per-pixel division introduces: Photoshop's documented
  // divide-by-zero result, and a NaN channel (which no clamp can repair and which
  // reads back as an arbitrary byte).
  const white = blendPixel([0.5, 0.5, 0.5, 1], [0, 0, 0, 1], (p) => p.setBlender(blenderFor(CanvasKit, "divide")));
  assert.deepEqual(white, [255, 255, 255, 255], "divide with a black (zero) source must be white");
  const extremes = [0, 1e-6, 0.5, 1 - 1e-6, 1];
  for (const mode of Object.keys(BLEND_MIX_BODIES)) {
    const blender = blenderFor(CanvasKit, mode);
    for (const b of extremes) for (const s of extremes) {
      const got = blendPixel([b, b, b, 1], [s, s, s, 1], (p) => p.setBlender(blender));
      for (const v of got) assert.ok(Number.isFinite(v) && v >= 0 && v <= 255, `blend "${mode}" produced ${got} at Cb=${b} Cs=${s} — a non-finite intermediate leaked through`);
    }
  }
});

test("DISCONTINUOUS: the step modes behave as their definitions say at the step", () => {
  const px = (mode, b, s) => blendPixel([...b, 1], [...s, 1], shippedSetup(mode));
  // HARD MIX posterizes: each channel goes fully on above the Cb+Cs = 1 threshold
  // and fully off below it — never anything between.
  assert.deepEqual(px("hardMix", [0.4, 0.4, 0.4], [0.4, 0.4, 0.4]), [0, 0, 0, 255], "0.4+0.4 < 1 ⇒ black");
  assert.deepEqual(px("hardMix", [0.6, 0.6, 0.6], [0.6, 0.6, 0.6]), [255, 255, 255, 255], "0.6+0.6 > 1 ⇒ white");
  assert.deepEqual(px("hardMix", [0.8, 0.3, 0.7], [0.4, 0.4, 0.9]), [255, 0, 255, 255], "per channel: 1.2>1, 0.7<1, 1.6>1");
  // DARKER / LIGHTER COLOR return one of the two colours WHOLE (this is what makes
  // them different from Darken/Lighten, which mix channels from both).
  const warm = [0.9, 0.6, 0.2], cool = [0.2, 0.3, 0.8];   // totals 1.7 vs 1.3
  assert.deepEqual(px("darkerColor", warm, cool), to8([...cool, 1]), "the lower-total colour, whole");
  assert.deepEqual(px("lighterColor", warm, cool), to8([...warm, 1]), "the higher-total colour, whole");
  assert.deepEqual(px("darkerColor", cool, warm), to8([...cool, 1]), "order-independent: still the lower total");
  // The contrast with Darken, which CAN synthesize a third colour:
  assert.deepEqual(px("darken", warm, cool), to8([0.2, 0.3, 0.2, 1]), "Darken mixes per channel — a colour in NEITHER layer");
});

// ── 4. DISTINCTNESS ("a mode that looks like Normal is a bug") ────────────────

/** Query. A mode's fingerprint over a chart of (backdrop, source) pairs spanning
 * greys and saturated colours — the numeric form of one contact-sheet cell. */
function fingerprint(mode) {
  const setup = shippedSetup(mode);
  const swatches = [
    [0, 0, 0], [0.33, 0.33, 0.33], [0.67, 0.67, 0.67], [1, 1, 1],
    [0.88, 0.25, 0.25], [0.95, 0.85, 0.2], [0.25, 0.72, 0.35], [0.25, 0.38, 0.88],
  ];
  const out = [];
  for (const b of swatches) for (const s of swatches) out.push(...blendPixel([...b, 1], [...s, 1], setup));
  return out;
}

test("DISTINCT: all 26 modes render differently from each other over the chart", () => {
  const prints = new Map(BLEND_MODES.map((m) => [m, fingerprint(m).join(",")]));
  const seen = new Map();
  for (const [mode, print] of prints) {
    const twin = seen.get(print);
    assert.equal(twin, undefined, `blend "${mode}" is PIXEL-IDENTICAL to "${twin}" over the whole chart — one of them is not doing what its name claims`);
    seen.set(print, mode);
  }
  const normal = prints.get("normal");
  for (const [mode, print] of prints)
    if (mode !== "normal") assert.notEqual(print, normal, `blend "${mode}" is indistinguishable from Normal — it is not composited at all`);
});

// ── 5. THE GUARDS, THE LABELS, AND LEGACY BEHAVIOUR ───────────────────────────

test("GUARD: the native map and the SkSL bodies PARTITION BLEND_MODES", () => {
  for (const mode of BLEND_MODES) {
    const native = mode in SKIA_NATIVE_BLEND_MODES, sksl = mode in BLEND_MIX_BODIES;
    assert.ok(native !== sksl, `"${mode}" is implemented ${native && sksl ? "TWICE" : "NOWHERE"}`);
    assert.ok(blendNeedsSkSL(mode) === sksl);
  }
  assert.equal(Object.keys(SKIA_NATIVE_BLEND_MODES).length + Object.keys(BLEND_MIX_BODIES).length, BLEND_MODES.length);
});

test("GUARD: an unknown mode throws instead of quietly compositing as Normal", () => {
  assert.throws(() => blenderFor(CanvasKit, "notABlendMode"), /not a known blend mode/);
  assert.throws(() => blenderFor(CanvasKit, "multiply"), /it is NATIVE/); // wrong dispatch half = a bug, not a fallback
});

test("LABELS: every mode has a human label, and Photoshop's names are used", () => {
  for (const mode of BLEND_MODES) assert.ok(BLEND_MODE_LABELS[mode], `no label for "${mode}"`);
  assert.equal(BLEND_MODE_LABELS.add, "Linear Dodge (Add)", "the legacy `add` id must carry Photoshop's own name for it");
  assert.equal(BLEND_MODE_LABELS.linearBurn, "Linear Burn");
  assert.equal(BLEND_MODES[0], "normal", "Normal must stay first — it is the default and Photoshop lists it first");
});

test("LEGACY: the four pre-parity ids still composite EXACTLY as they used to", () => {
  // The pre-parity dispatch was: multiply→Multiply, add→Plus, screen→Screen,
  // everything else→SrcOver. Pinned literally so a refactor of the mapping
  // cannot silently change what a stored document renders.
  const before = { normal: "SrcOver", multiply: "Multiply", add: "Plus", screen: "Screen" };
  for (const [mode, key] of Object.entries(before)) {
    assert.equal(SKIA_NATIVE_BLEND_MODES[mode], key, `"${mode}" no longer maps to ${key} — every existing document changes appearance`);
    for (const { dst, src } of [...OPAQUE_CASES, ...ALPHA_CASES]) {
      const now = blendPixel(dst, src, (p) => {
        if (blendNeedsSkSL(mode)) throw new Error(`"${mode}" became an SkSL mode`);
        p.setBlendMode(CanvasKit.BlendMode[SKIA_NATIVE_BLEND_MODES[mode]]);
      });
      const then = blendPixel(dst, src, (p) => p.setBlendMode(CanvasKit.BlendMode[key]));
      assert.deepEqual(now, then, `"${mode}" changed pixels at dst=${dst} src=${src}`);
    }
  }
});

// ── 6. EXPORT CLASSIFICATION (every mode is classified, one way or the other) ──

test("EXPORT: every mode is either /BM-expressible or takes the below-raster split", () => {
  for (const mode of BLEND_MODES) {
    const hasBM = mode in PDF_BLEND_NAMES;
    const splits = blendNeedsBelowRaster(mode);
    if (mode === "normal") { assert.equal(hasBM, false); assert.equal(splits, false); continue; }
    assert.ok(hasBM !== splits, `"${mode}" is ${hasBM && splits ? "BOTH /BM-mapped and split-only" : "NEITHER /BM-mapped nor split-routed"} — an unclassified mode exports as unblended pixels`);
  }
  // Every mode Skia can only do in SkSL has no page-description equivalent, so it
  // MUST split; and every /BM name must be a mode Skia does natively (a PDF
  // reader would otherwise show a blend the editor cannot).
  for (const mode of Object.keys(BLEND_MIX_BODIES))
    assert.equal(blendNeedsBelowRaster(mode), true, `SkSL-only mode "${mode}" must take the below-raster split`);
  for (const mode of Object.keys(PDF_BLEND_NAMES))
    assert.ok(mode in SKIA_NATIVE_BLEND_MODES, `"${mode}" has a PDF /BM name but is not a native Skia mode`);
  assert.equal(blendNeedsBelowRaster("add"), true, "add/Plus has no PDF /BM — it must keep the raster split it always had");
});

console.log(`\n${passed} blend-mode checks passed (${BLEND_MODES.length} modes: ${Object.keys(SKIA_NATIVE_BLEND_MODES).length} native, ${Object.keys(BLEND_MIX_BODIES).length} SkSL)`);
