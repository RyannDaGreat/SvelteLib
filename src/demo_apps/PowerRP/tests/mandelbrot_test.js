/**
 * Mandelbrot widget tests — plain node, no framework, no browser.
 * Run: node src/demo_apps/PowerRP/tests/mandelbrot_test.js
 *
 * WHAT THIS GUARDS. The Mandelbrot is the app's most numerically delicate widget
 * and its cheapest failure mode is a PLAUSIBLE WRONG IMAGE — a render that looks
 * like a fractal and is not the fractal. So the tests bite on the two things that
 * would produce one silently:
 *
 *   (1) THE SPLIT CENTRE. Every property is a plain number so it can keyframe, and
 *       a deep centre therefore lives in `coarse + fine·10^(-fineExponent)`. If
 *       that sum ever loses digits, the widget renders a DIFFERENT LOCATION and
 *       nothing complains. So the fixed-point sum is checked against exact
 *       arbitrary-precision arithmetic.
 *   (2) THE REFERENCE ORBIT. Wrong orbit, wrong image. Checked against closed-form
 *       orbits (C = 0 is identically zero; C = -1 is the exact 2-cycle 0, -1, 0,
 *       -1; C = 1 escapes) and for the fp32 down-conversion the shader relies on.
 *
 *   (3) THE UNIFORM ROW BUDGET, added after the widget shipped INVISIBLE. GL charges
 *       uniform arrays one float4 ROW per element, the first version asked for more
 *       rows than 90% of devices have, and a GL program the driver refuses is
 *       dropped at DRAW time with no exception, no report and no pixels — a blank
 *       rectangle where the fractal should be, while the thumbnail's proxy path
 *       still drew its gradient. No node test can see that (there is no GL here) and
 *       no test on a generous GPU can either, so the shader's declared row cost is
 *       checked STATICALLY against the budget instead.
 *
 * Plus the mundane-but-load-bearing contracts: the packer's float count matches
 * what the SkSL declares (a mismatch silently shifts every uniform), the material
 * declares a proxyFill (so this — by far the heaviest material in the app — can
 * never blow up a thumbnail), the plugin's knobs are all equation-capable, and
 * emit() is a pure function of state with no camera input.
 *
 * The SkSL is not COMPILED here: that needs canvaskit-wasm and a surface, which is
 * the browser/CLI suites' job. Note that compiling it would NOT have caught (3)
 * either — SkSL compilation and makeShader both succeed; only a real GL driver at
 * real draw time refuses the program. What is checked here is everything that can be
 * wrong before a compiler is involved, plus the one thing only arithmetic can check.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CUSTOM_CATEGORY } from "../core/properties.js";
import { isEquationValue, numericPropertyPaths, evaluateState } from "../core/expressions.js";
import { createRegistry, presetFamiliesOf } from "../core/registry.js";
import { newDocument, withNewItem, withNewSlide, keyframed, foldState, tweenedState } from "../core/document.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { getMaterial, resolveProxyFill, isBackdropMaterial, materialIds } from "../render_gpu/skia/materials.js";
import { mandelbrotPlugin, cachedOrbit, cachedPalette, paletteStopsFor, approxCentre, paletteCycles, zoomTweenLam, zoomTweenAxis } from "../plugins/demo/mandelbrot.js";
import {
  MANDELBROT_ESCAPE_RADIUS,
  MANDELBROT_MATERIAL, MANDELBROT_REF_LEN, MANDELBROT_PALETTE_STOPS, MANDELBROT_MAX_ITERATIONS,
  MANDELBROT_ORBIT_ROWS, MANDELBROT_UNIFORM_ROWS, MANDELBROT_UNIFORM_ROW_BUDGET,
  bitsForDepth, scaledDecimal, splitCentreFixed, centreResolutionDecades, fixedToFloat, referenceOrbit,
  bakeMandelbrotPalette, packMandelbrot, mandelbrotProxyFill, srgbToLinear,
  linearSrgbToOklab, oklabToLinearSrgb,
} from "../render_gpu/skia/mandelbrot_shader.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Query→build. A folded item state: the plugin's defaults with `over` applied. */
function stateOf(over = {}) {
  return { ...mandelbrotPlugin.defaults, ...over };
}

/**
 * Pure function. The EXACT value of `coarse + fine·10^(-fineExponent)` as a
 * fixed-point BigInt with `bits` fractional bits, computed the long way round
 * (exact decimal strings, BigInt throughout) so it is an INDEPENDENT check on
 * splitCentreFixed rather than a restatement of it.
 *
 * @param {number} coarse - the leading digits
 * @param {number} fine - the fine offset
 * @param {number} fineExponent - non-negative integer
 * @param {number} bits - fractional bits
 * @returns {bigint}
 *
 * @example independentSplit(0.5, 0, 0, 8) // 128n
 * @example independentSplit(0.5, 5, 1, 8) // 256n
 */
function independentSplit(coarse, fine, fineExponent, bits) {
  const DECIMALS = 90; // far beyond what two float64s carry, so this is the judge
  const toScaled = (v) => {
    const s = v.toFixed(100);
    const neg = s.startsWith("-");
    const [ip, fp = ""] = (neg ? s.slice(1) : s).split(".");
    return (neg ? -1n : 1n) * BigInt(ip + fp.slice(0, DECIMALS).padEnd(DECIMALS, "0"));
  };
  // fine·10^(-fineExponent), still scaled by 10^DECIMALS
  const exact = toScaled(coarse) + toScaled(fine) / 10n ** BigInt(fineExponent);
  const scale10 = 10n ** BigInt(DECIMALS);
  const neg = exact < 0n;
  const a = (neg ? -exact : exact) << BigInt(bits);
  const q = a / scale10;
  const rounded = (a % scale10) * 2n >= scale10 ? q + 1n : q;
  return neg ? -rounded : rounded;
}

// ── (1) the split centre ──────────────────────────────────────────────────────

test("scaledDecimal: exact for the decimal places toFixed accepts", () => {
  assert.equal(scaledDecimal(0.5, 3), 500n);
  assert.equal(scaledDecimal(-2, 2), -200n);
  assert.equal(scaledDecimal(0, 5), 0n);
  // -0.7435669 to 18 places: toFixed is EXACT, so the trailing digits are the
  // float64's own binary expansion (…031), not zeros. That exactness is the whole
  // point — it is what lets the fine part continue where the coarse one stops.
  assert.equal(scaledDecimal(-0.7435669, 18), -743566900000000031n);
  assert.equal(Number(scaledDecimal(-0.7435669, 18)) / 1e18, -0.7435669, "the scaled decimal must round-trip");
});

test("scaledDecimal: LOUD on a non-finite value or an impossible precision", () => {
  assert.throws(() => scaledDecimal(NaN, 4), /finite number/);
  assert.throws(() => scaledDecimal(1, 101), /0\.\.100/);
});

test("splitCentreFixed: exact where the value is exact", () => {
  // Values whose decimal expansions terminate well inside the split's working
  // precision must come out EXACTLY equal to independent BigInt arithmetic.
  for (const [coarse, fine, fineExponent, bits] of [[0.5, 0, 0, 8], [-2, 0, 0, 8], [0.5, 5, 1, 8], [0.25, -1, 2, 32]]) {
    assert.equal(
      splitCentreFixed(coarse, fine, fineExponent, bits),
      independentSplit(coarse, fine, fineExponent, bits),
      `split centre for (${coarse}, ${fine}, 10^-${fineExponent}, ${bits} bits)`,
    );
  }
});

test("splitCentreFixed: agrees with exact arithmetic to the resolution it claims", () => {
  // A float64's true value is a dyadic rational with a very long decimal
  // expansion, and the split deliberately keeps only (fineExponent + 18) places.
  // So the right question is not "is it exact" but "is it within the resolution
  // centreResolutionDecades advertises" — because that bound is what the widget
  // reports to the user and what the deep-zoom story rests on.
  for (const [coarse, fine, fineExponent, bits] of [
    [-0.7435669, 0, 0, 74],
    [-0.743643887037151, 1.234567, 16, 120],
    [0.131825904205311, -9.87654321, 20, 160],
    [-0.7468249983727664, 1.9467348106462117, 16, 200],
  ]) {
    const got = splitCentreFixed(coarse, fine, fineExponent, bits);
    const exact = independentSplit(coarse, fine, fineExponent, bits);
    const diff = got > exact ? got - exact : exact - got;
    // One unit in the last decimal place the split keeps, expressed on the
    // 2^(-bits) grid, plus a rounding unit.
    const allowed = (1n << BigInt(bits)) / 10n ** BigInt(centreResolutionDecades(fineExponent)) + 2n;
    assert.ok(diff <= allowed, `(${coarse}, ${fine}, 10^-${fineExponent}): off by ${diff}, budget ${allowed}`);
  }
});

test("centreResolutionDecades: states the deep-zoom precondition", () => {
  assert.equal(centreResolutionDecades(0), 17);
  assert.equal(centreResolutionDecades(16), 33);
  assert.ok(centreResolutionDecades(16) > 30, "a 1e-30 zoom must be inside the fine-exponent-16 budget");
  // And the fine part must genuinely buy those decades: the resolution has to
  // improve one-for-one with the exponent, or the split is decorative.
  assert.equal(centreResolutionDecades(30) - centreResolutionDecades(10), 20);
});

test("splitCentreFixed: the FINE part really adds digits the coarse one cannot hold", () => {
  // A float64 near 0.74 has an absolute resolution of about 1.1e-16, so a 1e-20
  // offset is invisible to it — but it must NOT be invisible to the split.
  const bits = bitsForDepth(30);
  const withoutFine = splitCentreFixed(-0.743643887037151, 0, 20, bits);
  const withFine = splitCentreFixed(-0.743643887037151, 1, 20, bits);
  assert.notEqual(withoutFine, withFine, "a 1e-20 fine offset changed nothing — the split lost the digits");
  // And it adds the RIGHT amount: (withFine - withoutFine) / 2^bits ≈ 1e-20.
  const delta = Number(withFine - withoutFine) / Math.pow(2, bits);
  assert.ok(Math.abs(delta / 1e-20 - 1) < 1e-9, `fine offset landed at ${delta}, expected 1e-20`);
});

test("splitCentreFixed: LOUD past the depth two plain numbers can express", () => {
  // decimals = fineExponent + 18, and toFixed stops at 100 places, so 83 is the
  // first exponent the split cannot express. The Inspector row's max is 80, well
  // inside that.
  assert.throws(() => splitCentreFixed(0, 0, 83, 400), /beyond the 100/);
  assert.ok(mandelbrotPlugin.inspector.find((r) => r.key === "fineExponent").max < 83);
  assert.throws(() => splitCentreFixed(0, 0, -1, 400), /non-negative integer/);
});

test("bitsForDepth: enough bits for the depth, plus guard bits", () => {
  assert.equal(bitsForDepth(0), 64);
  assert.equal(bitsForDepth(15), 114);
  assert.equal(bitsForDepth(100), 397);
  assert.ok(bitsForDepth(30) > 30 * Math.log2(10), "fewer bits than the decimal digits need");
});

test("fixedToFloat: exact for values a float64 can hold, at any precision", () => {
  assert.equal(fixedToFloat(128n, 8), 0.5);
  assert.equal(fixedToFloat(-512n, 8), -2);
  assert.equal(fixedToFloat(0n, 400), 0);
  // 0.5 at 400 fractional bits: Number(n) would overflow, the power-of-two
  // re-scaling must not.
  assert.equal(fixedToFloat(1n << 399n, 400), 0.5);
});

// ── (2) the reference orbit ───────────────────────────────────────────────────

test("referenceOrbit: C = 0 gives the identically-zero orbit, never escaping", () => {
  const r = referenceOrbit(0n, 0n, 32, 8);
  assert.equal(r.count, 8);
  assert.equal(r.escaped, false);
  assert.deepEqual([...r.orbit], new Array(16).fill(0));
});

test("referenceOrbit: C = -1 gives the exact 2-cycle 0, -1, 0, -1", () => {
  const bits = 40;
  const r = referenceOrbit(-1n << BigInt(bits), 0n, bits, 6);
  assert.equal(r.escaped, false);
  // interleaved [re, im] per point
  assert.deepEqual([...r.orbit], [0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1, 0]);
});

test("referenceOrbit: C = 1 escapes, and says so", () => {
  const bits = 40;
  const r = referenceOrbit(1n << BigInt(bits), 0n, bits, 32);
  assert.equal(r.escaped, true);
  assert.ok(r.count < 32, `an escaping reference must stop early, got ${r.count}`);
  assert.ok(r.count >= 2, "rebasing needs at least Z_0 and Z_1");
});

test("referenceOrbit: LOUD on a length rebasing cannot work with", () => {
  assert.throws(() => referenceOrbit(0n, 0n, 32, 1), /rebasing needs/i);
});

test("referenceOrbit: the orbit stays inside the escape disk while it lives", () => {
  // The seahorse-tail centre, at the precision the widget would use.
  const bits = bitsForDepth(3);
  const r = referenceOrbit(splitCentreFixed(-0.7435669, 0, 0, bits), splitCentreFixed(0.1314023, 0, 0, bits), bits, MANDELBROT_REF_LEN);
  for (let i = 0; i < r.count - 1; i++) {
    const m = Math.hypot(r.orbit[i * 2], r.orbit[i * 2 + 1]);
    assert.ok(m <= 2.001, `orbit point ${i} has |Z| = ${m}, outside the escape disk`);
  }
});

test("referenceOrbit: high precision does not corrupt the fp32 down-conversion", () => {
  // Same location, 74 bits vs 400 bits: the leading fp32 digits must agree.
  const a = referenceOrbit(splitCentreFixed(-0.7435669, 0, 0, 74), splitCentreFixed(0.1314023, 0, 0, 74), 74, 64);
  const b = referenceOrbit(splitCentreFixed(-0.7435669, 0, 0, 400), splitCentreFixed(0.1314023, 0, 0, 400), 400, 64);
  assert.equal(a.count, b.count);
  for (let i = 0; i < a.count * 2; i++) {
    assert.ok(Math.abs(a.orbit[i] - b.orbit[i]) < 1e-5, `orbit float ${i}: ${a.orbit[i]} vs ${b.orbit[i]}`);
  }
});

// ── (3) the palette bake ──────────────────────────────────────────────────────

test("OKLab round-trips linear sRGB", () => {
  for (const rgb of [[1, 1, 1], [0, 0, 0], [0.2, 0.5, 0.9], [1, 0, 0]]) {
    const back = oklabToLinearSrgb(...linearSrgbToOklab(...rgb));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - rgb[i]) < 1e-6, `OKLab round-trip on ${rgb}`);
  }
});

test("bakeMandelbrotPalette: shipped length, linear values, correct mean", () => {
  const white = bakeMandelbrotPalette(["#ffffff", "#ffffff"]);
  assert.equal(white.palette.length, MANDELBROT_PALETTE_STOPS * 3);
  for (const v of white.palette) assert.ok(Math.abs(v - 1) < 1e-6, "a white palette must bake to linear 1");
  assert.deepEqual(white.mean.map((v) => Math.round(v)), [1, 1, 1]);
  const black = bakeMandelbrotPalette(["#000000", "#000000"]);
  assert.deepEqual(black.mean, [0, 0, 0]);
});

test("bakeMandelbrotPalette: a mid-grey stop bakes to LINEAR light, not the encoded byte", () => {
  const grey = bakeMandelbrotPalette(["#808080", "#808080"]);
  assert.ok(Math.abs(grey.palette[0] - srgbToLinear(128 / 255)) < 1e-6,
    `expected linear ${srgbToLinear(128 / 255)}, got ${grey.palette[0]} — a palette baked in encoded sRGB makes every gradient too light`);
});

test("bakeMandelbrotPalette: LOUD on a palette that cannot cycle", () => {
  assert.throws(() => bakeMandelbrotPalette(["#000000"]), /at least 2 stops/);
  assert.throws(() => bakeMandelbrotPalette("nope"), /at least 2 stops/);
});

// ── (4) the material contract ─────────────────────────────────────────────────

test("the mandelbrot material is registered as a FOREGROUND material", () => {
  assert.ok(materialIds().includes("mandelbrot"));
  const m = getMaterial("mandelbrot");
  assert.equal(m, MANDELBROT_MATERIAL);
  assert.equal(isBackdropMaterial(m), false, "a generative fractal has no backdrop children");
});

/** Query. Every `uniform` the SkSL declares, as {type, name, elements} — the shader
 *  is the source of truth, so no hand-maintained constant can drift from it.
 *  @example // skslUniforms().find((u) => u.name === "uOrbit").type // "float4" */
function skslUniforms() {
  const out = [];
  for (const line of MANDELBROT_MATERIAL.sksl.split("\n")) {
    const m = /^uniform\s+(float[234]?)\s+(\w+)(?:\[(\w+)\])?\s*;/.exec(line.trim());
    if (!m) continue;
    const n = m[3] === undefined ? 1
      : m[3] === "REF_LEN" ? MANDELBROT_REF_LEN
      : m[3] === "ORBIT_ROWS" ? MANDELBROT_ORBIT_ROWS
      : m[3] === "PALETTE_STOPS" ? MANDELBROT_PALETTE_STOPS
      : Number(m[3]);
    assert.ok(Number.isFinite(n), `unresolved array size "${m[3]}"`);
    out.push({ type: m[1], name: m[2], elements: n, isArray: m[3] !== undefined });
  }
  return out;
}

test("the packer's float count is EXACTLY what the SkSL declares", () => {
  const sizes = { float: 1, float2: 2, float3: 3, float4: 4 };
  const declared = skslUniforms().reduce((sum, u) => sum + sizes[u.type] * u.elements, 0);
  assert.equal(declared, MANDELBROT_MATERIAL.uniformFloats, "SkSL uniform floats vs the descriptor's uniformFloats");
  const packed = packMandelbrot(packArgs());
  assert.equal(packed.length, declared, "packMandelbrot output vs the SkSL declaration");
});

test("THE UNIFORM ROW BUDGET: the program fits hardware that cannot report the failure", () => {
  // THE BUG THIS TEST EXISTS FOR. The first shipped version declared the orbit as
  // `float2 uOrbit[2048]`. GL charges uniform arrays BY THE ROW — one float4 row per
  // element, whatever the element's type (measured) — so it asked for ~2110 rows,
  // which only about 10% of surveyed devices can supply. The other 90% do not throw:
  // SkSL compiles, makeShader succeeds, and the driver silently DROPS THE DRAW at
  // draw time, so the widget renders as a blank rectangle with no error anywhere in
  // the app. That is invisible to every node test and to any GPU-less container, so
  // the shader's declared cost is asserted here instead, statically.
  const rows = skslUniforms().reduce((sum, u) => sum + (u.isArray ? u.elements : 0), 0);
  assert.equal(rows, MANDELBROT_ORBIT_ROWS + MANDELBROT_PALETTE_STOPS, "array rows in the SkSL vs the row model");
  // The row total is the array rows plus a measured fixed remainder (this shader's
  // scalars and small vectors after packing, plus the two uniforms Skia adds to
  // every runtime-effect program). It must ACCOUNT for that remainder — and it must
  // stay a remainder, not a second budget's worth of rows.
  const fixed = MANDELBROT_UNIFORM_ROWS - rows;
  assert.ok(fixed > 0 && fixed < 64, `the fixed uniform-row remainder is ${fixed}, which is not a plausible non-array cost`);
  assert.ok(MANDELBROT_UNIFORM_ROWS <= MANDELBROT_UNIFORM_ROW_BUDGET,
    `${MANDELBROT_UNIFORM_ROWS} uniform rows exceeds the ${MANDELBROT_UNIFORM_ROW_BUDGET}-row budget`);
  // The orbit MUST stay float4-packed: two complex points per row is the densest
  // layout a uniform can hold, and reverting it to float2 doubles the rows and
  // silently un-renders the widget on most hardware.
  const orbit = skslUniforms().find((u) => u.name === "uOrbit");
  assert.equal(orbit.type, "float4", "the orbit must be float4-packed (2 complex points per uniform row)");
  assert.equal(orbit.elements, MANDELBROT_ORBIT_ROWS);
  assert.equal(orbit.elements * 2, MANDELBROT_REF_LEN, "one row per two reference points");
  // And the framework must be able to pre-flight it against the device.
  assert.equal(MANDELBROT_MATERIAL.uniformRows, MANDELBROT_UNIFORM_ROWS,
    "the descriptor must DECLARE its row cost — nothing in the shader file can see the GL limit");
});

/** Query→build. A complete, legal argument object for packMandelbrot. */
function packArgs(over = {}) {
  const { palette, mean } = bakeMandelbrotPalette(["#000000", "#ffffff"]);
  return {
    cx: 0, cy: 0, halfW: 100, halfH: 75, cornerRadius: 0, angle: 0,
    centerApproxX: -0.5, centerApproxY: 0, halfWidth: 1,
    maxIter: 100, refCount: MANDELBROT_REF_LEN, escapeRadius: 256,
    interiorTest: 1, interiorThreshold: 1e-3, colorAxis: 0,
    paletteScale: 16, paletteOffset: 0,
    stripeAmount: 0, stripeDensity: 4, triangleAmount: 0,
    shadeAmount: 0, lightAngle: 0, lightHeight: 1.5,
    glowAmount: 0, glowWidth: 1, bandLimit: 1, boundaryAA: 1,
    interiorColor: "#000000", palette, paletteMean: mean,
    orbit: new Float32Array(MANDELBROT_REF_LEN * 2),
    ...over,
  };
}

test("packMandelbrot: LOUD on a missing knob, a bad number, or a wrong-length array", () => {
  assert.throws(() => packMandelbrot(packArgs({ paletteScale: undefined })), /paletteScale/);
  assert.throws(() => packMandelbrot(packArgs({ halfWidth: Infinity })), /halfWidth/);
  assert.throws(() => packMandelbrot(packArgs({ orbit: new Float32Array(4) })), /orbit.*floats/);
  assert.throws(() => packMandelbrot(packArgs({ palette: [1, 2, 3] })), /palette.*floats/);
  assert.throws(() => packMandelbrot(packArgs({ paletteMean: [0, 0] })), /paletteMean.*floats/);
});

test("packMandelbrot: the interior colour reaches the shader as LINEAR light", () => {
  const u = packMandelbrot(packArgs({ interiorColor: "#808080" }));
  // 27 scalars precede the float4 interior colour.
  const at = 27;
  assert.ok(Math.abs(u[at] - srgbToLinear(128 / 255)) < 1e-6, `interior colour packed as ${u[at]}, expected linear ${srgbToLinear(128 / 255)}`);
  assert.equal(u[at + 3], 1, "interior alpha passes through unchanged");
});

test("the material declares a proxyFill — the heaviest shader in the app cannot reach a thumbnail", () => {
  assert.equal(typeof MANDELBROT_MATERIAL.proxyFill, "function");
  const { palette } = bakeMandelbrotPalette(["#001028", "#ffd27f"]);
  const spec = resolveProxyFill(MANDELBROT_MATERIAL, { palette, interiorColor: "#000000" }, { cx: 100, cy: 80, halfW: 100, halfH: 80 });
  assert.equal(spec.kind, "radial");
  assert.equal(spec.stops.length, 3);
  assert.deepEqual(spec.stops[0].color, [0, 0, 0, 1], "the proxy's centre is the interior colour");
  for (const s of spec.stops) {
    assert.equal(s.color.length, 4);
    for (const c of s.color) assert.ok(c >= 0 && c <= 1, `proxy stop channel out of range: ${c}`);
  }
});

test("mandelbrotProxyFill: survives params with no palette at all (a direct-emit path)", () => {
  const spec = mandelbrotProxyFill({}, { cx: 0, cy: 0, halfW: 10, halfH: 10 });
  assert.equal(spec.kind, "radial");
  assert.ok(spec.radius > 0);
});

// ── (5) the widget ────────────────────────────────────────────────────────────

test("the plugin registers, and its knobs are all in the Inspector custom region", () => {
  const registry = createRegistry();
  registry.register(mandelbrotPlugin);
  assert.equal(registry.get("demo_mandelbrot").type, "demo_mandelbrot");
  assert.equal(registry.get("demo_mandelbrot").title, mandelbrotPlugin.title);
  for (const key of ["centerX", "centerFineX", "fineExponent", "zoomExponent", "maxIterations", "paletteOffset"]) {
    const row = mandelbrotPlugin.inspector.find((r) => r.key === key);
    assert.ok(row, `no Inspector row for ${key}`);
    assert.equal(row.category, CUSTOM_CATEGORY);
    assert.ok(typeof mandelbrotPlugin.defaults[key] !== "undefined", `no default for ${key}`);
  }
});

test("THE TIER-0 REQUIREMENT: every numeric knob is keyframable and `=` bindable", () => {
  const numericKnobs = mandelbrotPlugin.inspector
    .filter((r) => r.kind === "number" || r.kind === "angle")
    .map((r) => r.key)
    .filter((k) => typeof mandelbrotPlugin.defaults[k] === "number");
  assert.ok(numericKnobs.length >= 20, `expected the full knob set, found ${numericKnobs.length}`);
  // numericPropertyPaths lists exactly what is typeable/referenceable in an
  // equation, in the Inspector's snake_case display form.
  const paths = numericPropertyPaths(mandelbrotPlugin);
  const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  for (const key of numericKnobs) {
    assert.ok(paths.includes(snake(key)), `${key} is not reachable as an equation path (have: ${paths.join(", ")})`);
  }
  // The load-bearing ones by name, so a rename cannot quietly drop them.
  for (const key of ["centerX", "centerY", "centerFineX", "centerFineY", "fineExponent", "zoomExponent", "maxIterations", "paletteOffset", "lightAngle"]) {
    assert.ok(paths.includes(snake(key)), `${key} must be equation-bindable`);
    assert.equal(isEquationValue(mandelbrotPlugin, [key], "= 1 + 1"), true, `${key} must accept a "= …" equation`);
  }
});

test("a `= …` equation on zoomExponent really evaluates through the shared pass", () => {
  const registry = createRegistry();
  registry.register(mandelbrotPlugin);
  const state = { vars: {}, items: { m1: { ...stateOf(), zoomExponent: "= 3 * 2" } } };
  const { state: out, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0);
  assert.equal(out.items.m1.zoomExponent, 6);
  // and the evaluated state emits the matching half-width
  assert.ok(Math.abs(mandelbrotPlugin.emit(out.items.m1)[0].params.halfWidth - 1e-6) < 1e-18);
});

test("emit: ONE materialFill op naming the mandelbrot material, in LOCAL space", () => {
  const s = stateOf();
  const ops = mandelbrotPlugin.emit(s);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "materialFill");
  assert.equal(ops[0].material, "mandelbrot");
  assert.equal(ops[0].cx, s.w / 2);
  assert.equal(ops[0].halfW, s.w / 2);
  assert.equal(ops[0].params.orbit.length, MANDELBROT_REF_LEN * 2);
  assert.equal(ops[0].params.palette.length, MANDELBROT_PALETTE_STOPS * 3);
  // and the op's params pack without complaint through the real packer
  const geom = { cx: ops[0].cx, cy: ops[0].cy, halfW: ops[0].halfW, halfH: ops[0].halfH, cornerRadius: ops[0].cornerRadius, angle: 0 };
  assert.equal(packMandelbrot({ ...geom, ...ops[0].params }).length, MANDELBROT_MATERIAL.uniformFloats);
});

test("emit: the CAMERA IS NOT AN INPUT — emit takes only state, and its op is camera-free", () => {
  assert.equal(mandelbrotPlugin.emit.length, 1, "emit must take (state) only — no world/sub argument to leak a camera in");
  const json = JSON.stringify(mandelbrotPlugin.emit(stateOf()), (k, v) => (v instanceof Float32Array ? [...v] : v));
  const leaked = json.match(/"(zoom|panX|panY|dpr|devicePixelRatio)"/);
  assert.equal(leaked, null, `emit's op carries a camera-space field: ${leaked && leaked[0]}`);
  // Two different widget SIZES must give the same complex window (the aspect is the
  // only thing w/h feed the fractal), so the op's fractal params are size-free.
  const small = mandelbrotPlugin.emit(stateOf({ w: 200, h: 150 }))[0].params;
  const large = mandelbrotPlugin.emit(stateOf({ w: 800, h: 600 }))[0].params;
  assert.equal(small.halfWidth, large.halfWidth);
  assert.equal(small.maxIter, large.maxIter);
  assert.deepEqual([...small.orbit], [...large.orbit]);
});

test("emit: state → op is DETERMINISTIC (identical params for identical state)", () => {
  const a = mandelbrotPlugin.emit(stateOf());
  const b = mandelbrotPlugin.emit(stateOf());
  const flat = (ops) => JSON.stringify(ops, (k, v) => (v instanceof Float32Array ? [...v] : v));
  assert.equal(flat(a), flat(b));
  // The memoized orbit must not be a HIDDEN input: a different centre must give a
  // different orbit, and going back must give the first one again.
  const other = mandelbrotPlugin.emit(stateOf({ centerX: -0.5 }));
  assert.notEqual(flat(other), flat(a));
  assert.equal(flat(mandelbrotPlugin.emit(stateOf())), flat(a));
});

test("emit: zoomExponent really is the half-width exponent", () => {
  for (const zoomExponent of [0, 3, 12, 30]) {
    const op = mandelbrotPlugin.emit(stateOf({ zoomExponent }))[0];
    assert.ok(Math.abs(op.params.halfWidth / Math.pow(10, -zoomExponent) - 1) < 1e-12, `halfWidth at zoomExponent ${zoomExponent}`);
  }
});

test("emit: select knobs become the shader's numeric codes", () => {
  assert.equal(mandelbrotPlugin.emit(stateOf({ interiorTest: "off" }))[0].params.interiorTest, 0);
  assert.equal(mandelbrotPlugin.emit(stateOf({ interiorTest: "derivative" }))[0].params.interiorTest, 1);
  assert.equal(mandelbrotPlugin.emit(stateOf({ colorAxis: "iteration" }))[0].params.colorAxis, 0);
  assert.equal(mandelbrotPlugin.emit(stateOf({ colorAxis: "logIteration" }))[0].params.colorAxis, 1);
  assert.equal(mandelbrotPlugin.emit(stateOf({ colorAxis: "distance" }))[0].params.colorAxis, 2);
  assert.equal(mandelbrotPlugin.emit(stateOf({ bandLimit: false }))[0].params.bandLimit, 0);
});

test("maxIterations is EXPLICIT and capped — never derived from the zoom", () => {
  const row = mandelbrotPlugin.inspector.find((r) => r.key === "maxIterations");
  assert.equal(row.max, MANDELBROT_MAX_ITERATIONS);
  assert.equal(row.min, 1);
  // Changing the zoom must NOT change the iteration count that reaches the shader.
  const shallow = mandelbrotPlugin.emit(stateOf({ zoomExponent: 1 }))[0].params.maxIter;
  const deep = mandelbrotPlugin.emit(stateOf({ zoomExponent: 25 }))[0].params.maxIter;
  assert.equal(shallow, deep);
  assert.equal(shallow, mandelbrotPlugin.defaults.maxIterations);
});

test("paletteStopsFor: the override needs two stops to cycle, else the named palette wins", () => {
  assert.deepEqual(paletteStopsFor({ palette: "gold", paletteStops: "#000000, #ffffff" }), ["#000000", "#ffffff"]);
  assert.equal(paletteStopsFor({ palette: "gold", paletteStops: "#ff0000" }).length, 8);
  assert.equal(paletteStopsFor({ palette: "gold", paletteStops: "" }).length, 8);
  assert.equal(paletteStopsFor({ palette: "nope" }).length, 8, "an unknown palette name falls back to a real one");
});

test("cachedOrbit / cachedPalette: memoized but still pure in their inputs", () => {
  const s = stateOf();
  assert.equal(cachedOrbit(s).count, cachedOrbit(s).count);
  assert.deepEqual([...cachedOrbit(s).orbit], [...cachedOrbit(stateOf()).orbit]);
  assert.notDeepEqual([...cachedOrbit(s).orbit], [...cachedOrbit(stateOf({ centerX: 0 })).orbit]);
  assert.deepEqual(cachedPalette(s).mean, cachedPalette(stateOf()).mean);
  assert.notDeepEqual(cachedPalette(stateOf({ palette: "ice" })).mean, cachedPalette(stateOf({ palette: "ember" })).mean);
});

test("approxCentre: coarse plus fine at the stated exponent", () => {
  assert.equal(approxCentre(-0.5, 0, 0), -0.5);
  assert.equal(approxCentre(0.5, 5, 1), 1);
  assert.equal(approxCentre(0, 0, 0), 0);
});

// ── (6) the three preset families ─────────────────────────────────────────────

/** Query→build. A preset's props with every `= …` equation RESOLVED through the
 *  shared evaluation pass, which is what the editor feeds emit(). Colour presets
 *  carry `paletteScale: "= self.max_iterations / N"`, so a test that emitted their
 *  raw props would be testing a state the app never has. */
function evaluatedPreset(preset) {
  const registry = createRegistry();
  registry.register(mandelbrotPlugin);
  const { state, errors } = evaluateState({ vars: {}, items: { m1: stateOf(preset.props) } }, registry);
  assert.equal(errors.size, 0, `preset "${preset.name}" has an equation that does not evaluate: ${[...errors.values()].join("; ")}`);
  return state.items.m1;
}

/** Query. The presets of one declared family, resolved through the REGISTRY's own
 *  presetFamiliesOf (which namespaces the ids to `presets.<id>`), so this test reads
 *  the same shape the Tools pane does and cannot drift from it. */
function family(id) {
  const fam = presetFamiliesOf(mandelbrotPlugin).find((f) => f.id === `presets.${id}`);
  assert.ok(fam, `no declared preset family "${id}"`);
  return fam.presets;
}

/** Query. Every shipped preset, across all families. */
function allPresets() {
  return presetFamiliesOf(mandelbrotPlugin).flatMap((f) => f.presets);
}

test("every preset applies cleanly and emits a legal op", () => {
  assert.ok(allPresets().length >= 4, "the brief asks for a handful of genuinely good presets");
  const knobKeys = new Set(mandelbrotPlugin.inspector.map((r) => r.key));
  for (const p of allPresets()) {
    assert.ok(typeof p.name === "string" && p.name.length > 0);
    assert.ok(typeof p.description === "string" && p.description.length > 0);
    for (const key of Object.keys(p.props)) {
      assert.ok(knobKeys.has(key), `preset "${p.name}" sets "${key}", which is not a knob`);
    }
    if (p.props.maxIterations !== undefined)
      assert.ok(p.props.maxIterations <= MANDELBROT_MAX_ITERATIONS, `preset "${p.name}" exceeds the iteration cap`);
    const op = mandelbrotPlugin.emit(evaluatedPreset(p))[0];
    assert.equal(op.op, "materialFill");
    assert.ok(op.params.refCount >= 2, `preset "${p.name}" produced an unusable reference orbit`);
    const geom = { cx: op.cx, cy: op.cy, halfW: op.halfW, halfH: op.halfH, cornerRadius: op.cornerRadius, angle: 0 };
    assert.equal(packMandelbrot({ ...geom, ...op.params }).length, MANDELBROT_MATERIAL.uniformFloats, `preset "${p.name}" does not pack`);
  }
});

test("THE FAMILIES ARE DISJOINT — a colour preset can never move the view", () => {
  // THE WHOLE POINT OF THREE FAMILIES. applyPreset writes exactly the keys a preset
  // lists, so two presets can only fight if they name the same key. Assert the three
  // key sets do not intersect, and pin the ONE assignment that matters: the centre,
  // the zoom and the iteration budget belong to LOCATION alone.
  const ids = ["location", "colour", "performance"];
  assert.deepEqual(presetFamiliesOf(mandelbrotPlugin).map((f) => f.id), ids.map((i) => `presets.${i}`));
  assert.equal(mandelbrotPlugin.presets, undefined, "declaring BOTH presets and presetFamilies is refused by the registry");
  const sets = ids.map((id) => new Set(family(id).flatMap((p) => Object.keys(p.props))));
  for (const id of ids) assert.ok(family(id).length >= 3, `family "${id}" has too few presets to be a family`);
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const shared = [...sets[i]].filter((k) => sets[j].has(k));
      assert.deepEqual(shared, [], `families "${ids[i]}" and "${ids[j]}" both write ${shared.join(", ")}`);
    }
  }
  for (const key of ["centerX", "centerY", "centerFineX", "centerFineY", "fineExponent", "zoomExponent", "maxIterations"])
    assert.ok(sets[0].has(key) && !sets[1].has(key) && !sets[2].has(key), `"${key}" must belong to the LOCATION family alone`);
});

test("COMPOSITION: a colour then a location, or the reverse, keeps both", () => {
  // The user-visible promise. Applying one family after another must leave the
  // FIRST one's keys untouched — checked on the emitted op, not on intentions.
  const location = family("location").find((p) => p.name.startsWith("Starfish"));
  const colour = family("colour").find((p) => p.name === "Ice Porcelain");
  const perf = family("performance").find((p) => p.name === "Fast Interior Test");
  const forward = evaluatedPreset({ name: "forward", props: { ...colour.props, ...location.props, ...perf.props } });
  const reverse = evaluatedPreset({ name: "reverse", props: { ...perf.props, ...location.props, ...colour.props } });
  const a = mandelbrotPlugin.emit(forward)[0].params;
  const b = mandelbrotPlugin.emit(reverse)[0].params;
  assert.equal(a.halfWidth, b.halfWidth, "order changed the view");
  assert.equal(a.maxIter, b.maxIter, "order changed the iteration budget");
  assert.deepEqual([...a.palette], [...b.palette], "order changed the palette");
  assert.equal(a.interiorThreshold, b.interiorThreshold, "order changed the interior test");
  // and the composite really is the location's view WITH the colour's palette
  assert.ok(Math.abs(a.halfWidth / Math.pow(10, -location.props.zoomExponent) - 1) < 1e-12);
  assert.deepEqual([...a.palette], [...cachedPalette(stateOf(colour.props)).palette]);
});

test("paletteCycles: the colour families' scale tracks the LOCATION's iteration budget", () => {
  // The mechanism that lets a palette be orthogonal to a location at all: measured,
  // no single constant paletteScale survives 200 to 2048 iterations, because once one
  // pixel spans a colour cycle the band-limit fades the palette to its own mean.
  assert.equal(paletteCycles(25), "= self.max_iterations / 25");
  const colour = family("colour").find((p) => p.name === "Molten Gold");
  assert.equal(typeof colour.props.paletteScale, "string", "a colour preset's scale must be an equation");
  for (const [maxIterations, expected] of [[200, 4], [2048, 40.96]]) {
    const s = evaluatedPreset({ name: "x", props: { ...colour.props, maxIterations } });
    assert.ok(Math.abs(s.paletteScale - expected) < 1e-9, `at ${maxIterations} iterations the scale evaluated to ${s.paletteScale}, expected ${expected}`);
  }
});

test("NO SHIPPED PRESET TRIPS THE WIDGET'S OWN REPORTS", () => {
  // Both reports emit() can raise describe a PLAUSIBLE WRONG IMAGE, so a shipped
  // preset that trips one is shipping the bug the report exists to warn about. The
  // reference-exhaustion case is the live one: a Misiurewicz centre sits on a
  // REPELLING cycle, so its reference orbit eventually escapes (measured: 792 of
  // 1024 points for the double-spiral location), and past ~1e-6 a budget larger than
  // that reference loses the per-pixel offset in single precision and the frame goes
  // FLAT. The deep Misiurewicz preset holds its budget just under 792 for exactly
  // this reason, and this test is what keeps it there.
  const EXHAUSTION_SAFE_DECADES = 6;
  const COARSE_RESOLUTION_DECADES = centreResolutionDecades(0);
  for (const p of family("location")) {
    const s = evaluatedPreset(p);
    assert.ok(s.zoomExponent <= COARSE_RESOLUTION_DECADES,
      `"${p.name}" zooms to 1e-${s.zoomExponent}, past what the centre resolves at fine exponent ${s.fineExponent}`);
    const ref = cachedOrbit(s);
    const exhausted = ref.count < MANDELBROT_REF_LEN && s.maxIterations > ref.count && s.zoomExponent > EXHAUSTION_SAFE_DECADES;
    assert.equal(exhausted, false,
      `"${p.name}" asks for ${s.maxIterations} iterations on a reference of ${ref.count} at 1e-${s.zoomExponent} — the frame can go flat`);
  }
});

/**
 * Pure function. Fraction of a probe frame the shader would paint the INTERIOR
 * COLOUR only because it RAN OUT OF BUDGET — a float64 mirror of the shader kernel
 * (escape radius 256, derivative interior certificate), which is exact at every
 * depth this widget reaches (the float64 wall is a half-width of ~2e-13, and the
 * ceiling is ~3e-11).
 *
 * WHY THIS TEST EXISTS. Under-iterating is not a soft failure. A pixel that neither
 * escapes nor is certified interior is painted solid, and it is indistinguishable
 * from real set — the shipped "Embedded Julia Island" preset was 25.6% wrongly black
 * at 1e-10.59 while describing itself as the view that sells the depth, and no
 * existing test could see it. Cusp-centred views are the systematic case: dwell
 * beside a cardioid cusp is about pi/eps, so such a frame needs thousands of times
 * the budget this widget caps at.
 *
 * @param {object} s - evaluated widget state (centre, zoomExponent, maxIterations, interiorThreshold)
 * @param {number} gw - probe grid width
 * @param {number} gh - probe grid height
 * @returns {number} fraction in 0..1
 *
 * @example // wronglyBlackFraction({centerX: -0.6, centerY: 0, fineExponent: 0, zoomExponent: -0.2041, maxIterations: 2048, interiorThreshold: 1e-3}, 40, 30) // ~0.002
 * @example // a 1-iteration budget cannot finish anything outside the set
 * @example // wronglyBlackFraction({centerX: 0, centerY: 0, fineExponent: 0, zoomExponent: 0, maxIterations: 1, interiorThreshold: 1e-3}, 8, 6) // > 0.5
 */
function wronglyBlackFraction(s, gw, gh) {
  const ESCAPE_SQ = MANDELBROT_ESCAPE_RADIUS * MANDELBROT_ESCAPE_RADIUS;
  const MULT_CEILING = 1e30;
  const halfWidth = Math.pow(10, -s.zoomExponent);
  const aspect = gh / gw;
  const cx = approxCentre(s.centerX, s.centerFineX, s.fineExponent);
  const cy = approxCentre(s.centerY, s.centerFineY, s.fineExponent);
  const thresholdSq = s.interiorThreshold * s.interiorThreshold;
  let capped = 0;
  for (let py = 0; py < gh; py++) {
    for (let px = 0; px < gw; px++) {
      const cr = cx + ((px + 0.5) / gw * 2 - 1) * halfWidth;
      const ci = cy + ((py + 0.5) / gh * 2 - 1) * halfWidth * aspect;
      let zr = 0, zi = 0, qr = 1, qi = 0, escaped = false, inside = false, alive = true;
      for (let k = 0; k < s.maxIterations; k++) {
        if (alive && k > 0) {
          const nr = 2 * (zr * qr - zi * qi);
          qi = 2 * (zr * qi + zi * qr); qr = nr;
          const qm = qr * qr + qi * qi;
          if (qm < thresholdSq) { inside = true; break; }
          if (qm > MULT_CEILING) alive = false;
        }
        const nr = zr * zr - zi * zi + cr;
        zi = 2 * zr * zi + ci; zr = nr;
        if (zr * zr + zi * zi > ESCAPE_SQ) { escaped = true; break; }
      }
      if (!inside && !escaped) capped++;
    }
  }
  return capped / (gw * gh);
}

test("NO LOCATION PRESET IS WRONGLY BLACK — the under-iteration gate", () => {
  // The bug: a deep view whose budget cannot finish paints large regions the interior
  // colour, and they read as set. Measured on the preset that used to ship here,
  // Beyer's zoom step 14 at 1e-10.59 needs about 5000 iterations and had 25.6% of the
  // frame unfinished at the 2048 cap — with ZERO true interior in that view, so every
  // black pixel in it was an artifact. Each shipped location is held to 1%.
  const PROBE_W = 40, PROBE_H = 30;
  const BUDGET = 0.01;
  for (const p of family("location")) {
    const black = wronglyBlackFraction(evaluatedPreset(p), PROBE_W, PROBE_H);
    assert.ok(black <= BUDGET, `"${p.name}" leaves ${(100 * black).toFixed(1)}% of the frame wrongly black (budget ${100 * BUDGET}%)`);
  }
  // And the gate must be able to FAIL, or it is decoration: the same view starved of
  // iterations has to trip it.
  const starved = { ...stateOf(family("location").at(-1).props), maxIterations: 40 };
  assert.ok(wronglyBlackFraction(starved, PROBE_W, PROBE_H) > BUDGET, "the gate does not detect a starved view");
});

// ── (6) THE ZOOM TWEEN (the coupled centre/zoom interpolation) ────────────────
//
// THE BUG THIS SECTION EXISTS FOR, in the user's words: "when I tween two positions
// on the Mandelbrot zoom, it seems like the X and Y didn't quite synchronize with the
// zoom factor, so it didn't look like it zoomed into the point. It just, it kind of
// curved around and it was weird."
//
// THE CAUSE. `zoomExponent` is a LOGARITHM (half-width = 10^(-z)), so tweening it
// linearly shrinks the frame exponentially — which is right, and is the constant-rate
// zoom the widget documents. The CENTRE, though, was tweened linearly in alpha by the
// generic leaf-wise lerp, so the point being zoomed into sat at screen offset
// (1 - a)·(cTo - cFrom)/w(a) — a decaying numerator over an exploding denominator,
// which PEAKS NEAR THE END. Measured over z: 0.5 → 6, c: -0.6 → -0.7435669 the target
// swung 4170 half-widths out of frame and snapped back at alpha 1.
//
// THE REAL INVARIANT, and what these tests assert, is NOT a table of sample points:
// it is that |offset(alpha)| — the target's distance from the frame centre in
// half-widths — is MONOTONE NON-INCREASING over a dense sweep. A zoom in which the
// thing you are zooming into ever moves further away is the bug, whatever its
// numbers happen to be.

const TWEEN_SAMPLES = 400; // dense enough that the old law's 1842-step excursion cannot hide

/** Query→build. A one-widget document with the mandelbrot state `from` on slide 1
 *  and each key of `to` keyframed on slide 2. Returns {doc, id, registry}.
 *
 *  THE FULL registry (registerAll), not a one-plugin one: newDocument() mints THE
 *  CAMERA, and `tweenedState` resolves every item's plugin exactly as
 *  deriveRenderTree does — so a partial registry throws there for the same reason
 *  it throws in the render path, which is the loud behaviour both want. */
function zoomDoc(from, to) {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const [withItem, id] = withNewItem(newDocument(), 0, stateOf(from));
  let doc = withNewSlide(withItem, 0)[0];
  for (const [key, value] of Object.entries(to)) doc = keyframed(doc, 1, ["items", id, key], value);
  return { doc, id, registry };
}

/**
 * Pure function. A complex target's horizontal offset from a state's frame centre,
 * IN HALF-WIDTHS (1.0 = the frame's own edge). Read off the plugin's OWN
 * `interiorView.window`, so this measures the window that actually renders rather
 * than restating its arithmetic.
 */
function offsetInHalfWidths(state, targetX) {
  const win = mandelbrotPlugin.interiorView.window(state);
  return (targetX - (win.x + win.w / 2)) / (win.w / 2);
}

/** Query. |offset| sampled TWEEN_SAMPLES+1 times across a transition, through the
 *  real fold (`fold(alpha) → state`). */
function offsetSweep(fold, id, targetX) {
  const out = [];
  for (let i = 0; i <= TWEEN_SAMPLES; i++) out.push(Math.abs(offsetInHalfWidths(fold(i / TWEEN_SAMPLES).items[id], targetX)));
  return out;
}

test("zoomTweenLam: 1 at the start, 0 at the target, and NaN when there is no zoom", () => {
  assert.equal(zoomTweenLam(0, 2, 0), 1);
  assert.equal(zoomTweenLam(0, 2, 1), 0);
  // At alpha 0.5 of a 2-decade zoom the frame is a TENTH the size, so nine tenths of
  // the offset is already gone — the whole point: lam follows the FRAME, not alpha.
  assert.ok(Math.abs(zoomTweenLam(0, 2, 0.5) - 1 / 11) < 1e-15);
  assert.ok(Number.isNaN(zoomTweenLam(4, 4, 0.5)), "equal zooms have no lam — a pure pan must stay linear");
  // TIME-REVERSAL SYMMETRY: zooming out is the same path run backwards. This is what
  // makes "zoom out" correct for free rather than a second case to get right.
  for (const a of [0.1, 0.37, 0.5, 0.9])
    assert.ok(Math.abs(zoomTweenLam(0.5, 6, a) - (1 - zoomTweenLam(6, 0.5, 1 - a))) < 1e-12, `not time-reversible at ${a}`);
});

test("zoomTweenAxis: exact at both ends, and the deep digits live in the FINE leaf", () => {
  const from = { coarse: -0.6, fine: 0, fineExponent: 0 };
  const to = { coarse: -0.7435669, fine: 0, fineExponent: 0 };
  assert.deepEqual(zoomTweenAxis(from, to, 0), { coarse: to.coarse, fine: 0 });
  const start = zoomTweenAxis(from, to, 1);
  assert.ok(Math.abs(approxCentre(start.coarse, start.fine, 0) - from.coarse) < 1e-15, "lam 1 must reproduce the START centre");
  // fineExponent 0 means "float64 is enough here", so the COARSE leaf carries the
  // whole tween and the fine slot is left off — the Inspector's Centre X keeps
  // reading the actual centre all the way through.
  assert.equal(start.fine, 0, "fineExponent 0 must not grow a fine part mid-tween");
  // A DEEP pair sharing coarse digits: the interpolation happens entirely in FINE
  // units, so all 16 extra digits survive and alpha 1 lands on them exactly.
  const deepFrom = { coarse: -0.7435669, fine: 3, fineExponent: 16 };
  const deepTo = { coarse: -0.7435669, fine: 3.123456789012345, fineExponent: 16 };
  assert.deepEqual(zoomTweenAxis(deepFrom, deepTo, 0), { coarse: -0.7435669, fine: 3.123456789012345 });
  assert.ok(Math.abs(zoomTweenAxis(deepFrom, deepTo, 0.5).fine - 3.0617283945061725) < 1e-12);
});

test("THE ZOOM IS MONOTONE: the target never leaves the frame and comes back", () => {
  // The reported case: the whole set → the seahorse tail, 5.5 decades of zoom.
  const TARGET_X = -0.7435669;
  const { doc, id, registry } = zoomDoc(
    { centerX: -0.6, centerY: 0.1314023, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 0.5 },
    { centerX: TARGET_X, zoomExponent: 6 },
  );
  const naive = offsetSweep((a) => foldState(doc, 1, a), id, TARGET_X);
  const fixed = offsetSweep((a) => tweenedState(doc, 1, a, registry), id, TARGET_X);

  // (a) THE GATE MUST BE ABLE TO FAIL. The generic leaf-wise lerp is exactly the
  // broken law, so it has to trip every assertion below — otherwise this test is
  // decoration. Measured: 4170 half-widths at worst, 1842 of 400 sampled steps rising.
  assert.ok(Math.max(...naive) > 1000, `the leaf-wise lerp should swing the target far off frame, worst was ${Math.max(...naive)}`);
  assert.ok(naive.some((v, i) => i > 0 && v > naive[i - 1] + 1e-9), "the leaf-wise lerp should be non-monotone");

  // (b) THE INVARIANT: |offset| never increases, anywhere in the sweep.
  for (let i = 1; i < fixed.length; i++)
    assert.ok(fixed[i] <= fixed[i - 1] + 1e-9, `offset grew at alpha ${(i / TWEEN_SAMPLES).toFixed(3)}: ${fixed[i - 1]} → ${fixed[i]}`);
  // (c) and it stays INSIDE the frame the whole way — the visible half of the bug.
  assert.ok(Math.max(...fixed) <= 1, `the target left the frame (worst ${Math.max(...fixed)} half-widths)`);
  // (c2) at fineExponent 0 the readable Centre X row IS the centre at every alpha.
  for (const a of [0.1, 0.5, 0.9]) {
    const s = tweenedState(doc, 1, a, registry).items[id];
    assert.equal(s.centerFineX, 0, `fineExponent 0 grew a fine part at alpha ${a}`);
    assert.equal(s.centerX, approxCentre(s.centerX, s.centerFineX, 0));
  }
  // (d) ENDPOINTS UNTOUCHED: a tween may not move the states it interpolates between.
  for (const a of [0, 1]) {
    const naiveEnd = foldState(doc, 1, a).items[id], fixedEnd = tweenedState(doc, 1, a, registry).items[id];
    for (const key of ["centerX", "centerY", "centerFineX", "centerFineY", "fineExponent", "zoomExponent"])
      assert.equal(fixedEnd[key], naiveEnd[key], `alpha ${a} changed ${key}`);
  }
});

test("THE ZOOM IS MONOTONE ZOOMING OUT TOO (the time-reverse of the same path)", () => {
  // Zooming out, the thing that must not swing away is where you STARTED, so the
  // target here is the deep centre the transition leaves behind.
  const TARGET_X = -0.7435669;
  const { doc, id, registry } = zoomDoc(
    { centerX: TARGET_X, centerY: 0.1314023, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 6 },
    { centerX: -0.6, zoomExponent: 0.5 },
  );
  const fixed = offsetSweep((a) => tweenedState(doc, 1, a, registry), id, TARGET_X);
  for (let i = 1; i < fixed.length; i++)
    assert.ok(fixed[i] >= fixed[i - 1] - 1e-9, `zooming out, the start point should recede monotonically; it jumped back at alpha ${(i / TWEEN_SAMPLES).toFixed(3)}`);
  assert.ok(fixed[0] < 1e-12, "at alpha 0 the start centre IS the frame centre");
});

test("A PURE PAN AT FIXED ZOOM STAYS LINEAR (the degenerate case, not a special case)", () => {
  // Fractional endpoints on purpose: an INT↔INT pair takes core/interpolators' own
  // rounding rule, which would be testing that instead of this.
  const { doc, id, registry } = zoomDoc(
    { centerX: 0.25, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 2 },
    { centerX: 1.25, centerY: 0.5 },
  );
  for (const a of [0, 0.25, 0.5, 0.75, 1]) {
    const s = tweenedState(doc, 1, a, registry).items[id];
    assert.equal(s.centerX, foldState(doc, 1, a).items[id].centerX, `a pan must be the plain lerp at alpha ${a}`);
    assert.ok(Math.abs(s.centerX - (0.25 + a)) < 1e-15, `pan should be linear in alpha, got ${s.centerX} at ${a}`);
    assert.ok(Math.abs(s.centerY - a * 0.5) < 1e-15);
  }
});

test("THE SPLIT CENTRE SURVIVES THE TWEEN: a deep zoom keeps every fine digit", () => {
  // A 1e-12 → 1e-30 zoom whose only moving coordinate is the FINE slot. The coarse
  // digits must not budge (a float64 ulp of the coarse part is thousands of
  // half-widths down there) and alpha 1 must land on the stored deep value exactly.
  const DEEP_FINE = 3.123456789012345;
  const { doc, id, registry } = zoomDoc(
    { centerX: -0.7435669, centerY: 0.1314023, centerFineX: 3, centerFineY: -2, fineExponent: 16, zoomExponent: 12 },
    { centerFineX: DEEP_FINE, zoomExponent: 30 },
  );
  for (const a of [0, 0.2, 0.5, 0.8, 1]) {
    const s = tweenedState(doc, 1, a, registry).items[id];
    assert.equal(s.centerX, -0.7435669, `the coarse part moved at alpha ${a}`);
    assert.equal(s.fineExponent, 16);
  }
  assert.equal(tweenedState(doc, 1, 1, registry).items[id].centerFineX, DEEP_FINE, "alpha 1 must be the stored deep value, bit for bit");
  assert.equal(tweenedState(doc, 1, 0, registry).items[id].centerFineX, 3, "alpha 0 must be the stored start value, bit for bit");
  // The exact-decimal sum the shader actually consumes must be MONOTONE in the fine
  // digits too — i.e. the tween moves toward the target and never overshoots.
  const fines = [];
  for (let i = 0; i <= TWEEN_SAMPLES; i++) fines.push(tweenedState(doc, 1, i / TWEEN_SAMPLES, registry).items[id].centerFineX);
  for (let i = 1; i < fines.length; i++) assert.ok(fines[i] >= fines[i - 1] - 1e-15, `fine digits went backwards at step ${i}`);
});

test("AN `=` EQUATION ON THE CENTRE DEFERS TO THE EQUATION, and does not throw", () => {
  const { doc, id, registry } = zoomDoc(
    { centerX: -0.6, centerY: 0, centerFineX: 0, centerFineY: 0, fineExponent: 0, zoomExponent: 0.5 },
    { centerX: "= 0 - 0.75", zoomExponent: 6 },
  );
  const raw = tweenedState(doc, 1, 0.5, registry).items[id];
  assert.equal(raw.centerX, "= 0 - 0.75", "the coupling law must not overwrite an equation with a number");
  const { state, errors } = evaluateState(tweenedState(doc, 1, 0.5, registry), registry);
  assert.equal(errors.size, 0);
  assert.equal(state.items[id].centerX, -0.75);
});

test("the hook is DECLARED on the plugin, so the generic tween can find it", () => {
  assert.equal(typeof mandelbrotPlugin.interpolateState, "function", "no interpolateState — the tween would silently fall back to the broken leaf-wise lerp");
  // PURE: same inputs, same output, and it must not mutate what it is handed.
  const from = stateOf({ centerX: -0.6, zoomExponent: 0.5 }), to = stateOf({ centerX: -0.75, zoomExponent: 6 });
  const frozen = JSON.stringify([from, to]);
  const a = mandelbrotPlugin.interpolateState(from, to, 0.4);
  const b = mandelbrotPlugin.interpolateState(from, to, 0.4);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify([from, to]), frozen, "interpolateState mutated its inputs");
  // It speaks ONLY in keyframable leaves of this widget's own state.
  for (const key of Object.keys(a)) assert.ok(key in mandelbrotPlugin.defaults, `interpolateState writes "${key}", which is not a state key of this widget`);
  // And it leaves the zoom itself to the linear lerp — that IS the constant-rate zoom.
  assert.ok(!("zoomExponent" in a), "zoomExponent must stay linear in alpha");
});

// The widget must be REACHABLE, and by exactly ONE route. This used to assert it
// shipped its own palette command — which it did, but only as a workaround: the
// "Insert Demo Widget" submenu is a hand-written list in web/App.svelte and nothing
// lets a plugin join it, so a plugin-level command was the sole way to make the
// widget insertable at all. It is now in the submenu proper like every sibling, so
// the assertion is INVERTED rather than dropped: reachable via the submenu, and NOT
// also via its own command (the registry throws on a duplicate id, and two ids for
// one action is what the one-owner convention forbids).
test("the widget is reachable by exactly one route: the Insert Demo Widget submenu", () => {
  const appSvelte = readFileSync(new URL("../web/App.svelte", import.meta.url), "utf8");
  assert.match(
    appSvelte, /id: "demo-insert-mandelbrot"[^}]*demo_mandelbrot/,
    'no "demo-insert-mandelbrot" entry in web/App.svelte — the widget would be unreachable, since it deliberately ships no command of its own'
  );
  assert.equal(
    (mandelbrotPlugin.commands ?? []).length, 0,
    "the plugin declares its own command AGAIN — that is a second id for the one insert action; the submenu entry is the single owner"
  );
});

console.log(`\n${passed} mandelbrot tests passed`);
