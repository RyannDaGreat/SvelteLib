/**
 * material_plugin_test.js — TYPED PLUGIN KINDS and the MATERIAL plugin contract.
 *
 * Four things are pinned here, in the order they matter:
 *
 *   1. KIND DISPATCH. A kind-less source is a widget, byte-identically to before
 *      (the compatibility contract every already-written plugin asset relies on);
 *      an explicit kind: "widget" is the same thing; an unknown kind is refused
 *      LOUDLY naming the kind AND the known set.
 *   2. THE MATERIAL CONTRACT. Shape validation, including the DATA-ONLY rule — a
 *      material declaring pack/toUniformParams/proxyBackdrop as a FUNCTION is
 *      refused, because that is the mistake an author porting a built-in makes.
 *   3. THE GLASS REGRESSION, which is the whole point. The migrated plugin's
 *      descriptor must be equivalent to the shipped GLASS_MATERIAL: same SkSL
 *      (byte-identical strings), same schema, same packed uniforms over a
 *      parameter sweep, same sample reach over a sweep, same proxy tint. If any of
 *      those drift, a document using glass renders differently after the
 *      migration — which is exactly what "byte-identical regression" forbids.
 *   4. THE DECLARED-DATA ESCAPE HATCHES against the hooks they replaced. The
 *      sample-reach sweep is the load-bearing one: dropping the declaration does
 *      not break the picture, it silently falls back to a FULL-SURFACE backdrop
 *      re-render, which is a large invisible perf regression.
 *
 * Bare node, DOM-free. The SkSL is never compiled here (no CanvasKit in node) —
 * the compile refusal is tested through the injected probe seam, and the real
 * compile is exercised by the browser probe.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  loadPluginAsset, registerPluginAssets, knownPluginKinds, pluginKind, DEFAULT_PLUGIN_KIND,
} from "../core/plugin_assets.js";
import {
  materialShapeProblem, materialParamsProblem, uniformsProblem, sampleReachProblem,
  declaredUniformParams, packDeclaredUniforms, declaredSampleReach, declaredProxyBackdrop,
  materialDescriptor, setMaterialCompileProbe, setMaterialColorParser, shaderCompileProblem,
} from "../core/material_plugins.js";
import { getMaterial, materialIds, resetPluginMaterials, isBuiltinMaterialId } from "../render_gpu/skia/materials.js";
import { GLASS_MATERIAL, GLASS_SKSL, GLASS_FILL_SKSL, GLASS_FILL_PARAMS, maxGlassDisplacement, glassUniformParams, packGlassMaterial, glassProxyBackdrop } from "../render_gpu/skia/glass_shader.js";
import { parseColor } from "../render_gpu/ir.js";
import { createRegistry } from "../core/registry.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

setMaterialColorParser(parseColor);

/** The shipped built-in glass material asset's source. */
const GLASS_ASSET_SOURCE = readFileSync(new URL("../assets/builtin/library/liquid_glass.material.plugin.js", import.meta.url), "utf8");

/** A minimal valid material plugin, for the shape tests. */
const MINIMAL = {
  kind: "material", id: "plasma", title: "Plasma",
  params: [{ name: "gain", kind: "number", default: 2 }],
  uniforms: [{ name: "gain", size: 1 }],
  sksl: "half4 main(float2 p) { return half4(1); }",
};
const minimalSource = (over = {}) => `return ${JSON.stringify({ ...MINIMAL, ...over })};`;

// ── 1. KIND DISPATCH ─────────────────────────────────────────────────────────

const WIDGET_SRC = "return {type:'w_test', title:'W', capabilities:{bbox:true}, defaults:{type:'w_test'}, emit:()=>[]};";

test("a kind-LESS source is a widget — the compatibility contract, unchanged", () => {
  const p = loadPluginAsset(WIDGET_SRC, "w.plugin.js", new Set());
  assert.strictEqual(p.type, "w_test");
  assert.strictEqual(p.kind, undefined, "a kind-less source must not gain a kind field");
  assert.strictEqual(pluginKind(p), DEFAULT_PLUGIN_KIND);
});

test('an explicit kind:"widget" loads identically to a kind-less one', () => {
  const kindless = loadPluginAsset(WIDGET_SRC, "a.plugin.js", new Set());
  const explicit = loadPluginAsset(WIDGET_SRC.replace("return {", "return {kind:'widget', "), "b.plugin.js", new Set());
  assert.strictEqual(explicit.type, kindless.type);
  assert.strictEqual(explicit.title, kindless.title);
  assert.deepStrictEqual(explicit.emit(), kindless.emit());
});

test("an UNKNOWN kind is refused loudly, naming the kind AND the known set", () => {
  assert.throws(
    () => loadPluginAsset("return {kind:'transition', id:'x'};", "t.plugin.js", new Set()),
    (e) => e.message.includes('kind "transition"') && e.message.includes("known:") && e.message.includes("material") && e.message.includes("widget") && e.message.includes("t.plugin.js"),
  );
});

test("the kind table lists exactly the two shipped kinds", () => {
  assert.deepStrictEqual(knownPluginKinds(), ["material", "widget"]);
});

test("the two namespaces are SEPARATE — a material may take a widget's name", () => {
  resetPluginMaterials();
  const reg = createRegistry();
  const r = registerPluginAssets(reg, [
    { name: "w.plugin.js", source: "return {type:'twin', title:'T', capabilities:{bbox:true}, defaults:{type:'twin'}, emit:()=>[]};" },
    { name: "m.plugin.js", source: minimalSource({ id: "twin" }) },
  ]);
  assert.deepStrictEqual(r.reports, [], "a material named like a widget must NOT collide");
  assert.deepStrictEqual(r.loaded, ["twin", "twin"]);
  assert.ok(materialIds().includes("twin"));
  resetPluginMaterials();
});

test("a material may NOT shadow an ALREADY-REGISTERED material", () => {
  resetPluginMaterials();
  // `crt` is a genuine BUILT-IN (imported by materials.js). Glass deliberately is
  // NOT one any more — it MIGRATED to the library asset — so the built-in half of
  // this rule is asserted with a material that is still one.
  assert.ok(isBuiltinMaterialId("crt"));
  assert.strictEqual(isBuiltinMaterialId("glass"), false, "glass migrated: it is a plugin now, not a built-in descriptor");
  const r = registerPluginAssets(createRegistry(), [{ name: "evil.plugin.js", source: minimalSource({ id: "crt" }) }]);
  assert.deepStrictEqual(r.loaded, []);
  assert.match(r.reports[0], /id "crt" is already registered/);
  // The same refusal protects a PLUGIN-registered material from a later one.
  registerPluginAssets(createRegistry(), [{ name: "first.plugin.js", source: minimalSource() }]);
  const second = registerPluginAssets(createRegistry(), [{ name: "second.plugin.js", source: minimalSource() }]);
  assert.match(second.reports[0], /id "plasma" is already registered/);
  resetPluginMaterials();
});

test("a material registers into the MATERIAL registry and is retrievable", () => {
  resetPluginMaterials();
  const r = registerPluginAssets(createRegistry(), [{ name: "p.plugin.js", source: minimalSource() }]);
  assert.deepStrictEqual(r.reports, []);
  assert.deepStrictEqual(r.loaded, ["plasma"]);
  assert.deepStrictEqual(r.types, { "p.plugin.js": "plasma" });
  const d = getMaterial("plasma");
  assert.strictEqual(d.title, "Plasma");
  assert.strictEqual(d.uniformFloats, 1);
  assert.strictEqual(d.pluginSource, true);
  assert.strictEqual(isBuiltinMaterialId("plasma"), false);
  assert.deepStrictEqual(resetPluginMaterials(), ["plasma"]);
  assert.throws(() => getMaterial("plasma"), /unknown material/);
});

// ── 2. THE MATERIAL CONTRACT ─────────────────────────────────────────────────

test("materialShapeProblem accepts a minimal material and names every missing field", () => {
  assert.strictEqual(materialShapeProblem(MINIMAL), null);
  for (const field of ["id", "title", "params", "sksl", "uniforms"]) {
    const broken = { ...MINIMAL };
    delete broken[field];
    assert.strictEqual(materialShapeProblem(broken), `is missing "${field}"`);
  }
});

test("THE DATA-ONLY RULE: a function-valued hook is refused, with advice", () => {
  for (const hook of ["pack", "toUniformParams", "proxyBackdrop", "proxyFill", "sceneParams", "animated"]) {
    const problem = materialShapeProblem({ ...MINIMAL, [hook]: () => 1 });
    assert.match(problem, new RegExp(`declares "${hook}" as a function`), `${hook} must be refused`);
    assert.match(problem, /DATA ONLY/);
    assert.match(problem, /no JS runs on the render path/);
  }
});

test("a bad id / title / sksl is refused", () => {
  assert.match(materialShapeProblem({ ...MINIMAL, id: "Plasma" }), /must be a lower_snake_case identifier/);
  assert.match(materialShapeProblem({ ...MINIMAL, title: "" }), /title must be a non-empty string/);
  assert.match(materialShapeProblem({ ...MINIMAL, sksl: "   " }), /sksl must be a non-empty SkSL source string/);
  assert.match(materialShapeProblem(null), /not a material object/);
  assert.match(materialShapeProblem([1]), /returned an array/);
});

test("the knob SCHEMA is validated row by row", () => {
  assert.strictEqual(materialParamsProblem([{ name: "g", kind: "number", default: 1 }]), null);
  assert.match(materialParamsProblem("g"), /must be an array of knob rows/);
  assert.match(materialParamsProblem([{ kind: "number", default: 1 }]), /is missing "name"/);
  assert.match(materialParamsProblem([{ name: "g", kind: "wobble", default: 1 }]), /declares kind "wobble"/);
  assert.match(materialParamsProblem([{ name: "g", kind: "number" }]), /is missing "default"/);
  assert.match(materialParamsProblem([{ name: "g", kind: "number", default: 1 }, { name: "g", kind: "number", default: 2 }]), /repeats the knob name/);
});

test("the UNIFORM BLOCK is validated (it replaces pack + uniformFloats)", () => {
  assert.strictEqual(uniformsProblem([{ name: "u", size: 1 }]), null);
  assert.match(uniformsProblem([]), /at least one entry/);
  assert.match(uniformsProblem([{ name: "u", size: 3.5 }]), /must be a positive integer float count/);
  assert.match(uniformsProblem([{ size: 1 }]), /is missing "name"/);
});

test("maxSampleReach must be DECLARED DATA, never a function", () => {
  assert.strictEqual(sampleReachProblem(undefined), null, "absence is legal (= undeclared)");
  assert.strictEqual(sampleReachProblem({ product: ["a"], times: 2 }), null);
  assert.match(sampleReachProblem(() => 5), /must be DECLARED DATA/);
  assert.match(sampleReachProblem({ times: 2 }), /product must be a non-empty array/);
  assert.match(sampleReachProblem({ product: ["a"], times: NaN }), /times must be a finite number/);
});

test("proxyBackdrop must name one of the material's OWN params", () => {
  assert.match(
    materialShapeProblem({ ...MINIMAL, proxyBackdrop: { fromParam: "nope" } }),
    /fromParam names "nope", which is not one of its params \(gain\)/,
  );
  assert.strictEqual(materialShapeProblem({ ...MINIMAL, proxyBackdrop: { fromParam: "gain" } }), null);
});

test("usesShapeSdf without a fillSksl is refused (it would render the base shader)", () => {
  assert.match(materialShapeProblem({ ...MINIMAL, usesShapeSdf: true }), /declares usesShapeSdf but no fillSksl/);
  assert.strictEqual(materialShapeProblem({ ...MINIMAL, usesShapeSdf: true, fillSksl: "half4 main(float2 p){return half4(0);}" }), null);
});

test("a shader that will not COMPILE is refused at REGISTRATION with the compiler's text", () => {
  resetPluginMaterials();
  setMaterialCompileProbe((src) => (src.includes("SYNTAX_ERROR") ? "error: 1: unknown identifier 'SYNTAX_ERROR'" : null));
  try {
    const r = registerPluginAssets(createRegistry(), [{ name: "bad.plugin.js", source: minimalSource({ sksl: "half4 main(float2 p){ SYNTAX_ERROR; }" }) }]);
    assert.deepStrictEqual(r.loaded, [], "a shader that will not compile must not register");
    assert.match(r.reports[0], /sksl failed to compile/);
    assert.match(r.reports[0], /unknown identifier 'SYNTAX_ERROR'/, "the compiler's OWN error text must survive");
    assert.throws(() => getMaterial("plasma"), /unknown material/);
    // The FILL variant is compiled too — a base that compiles while its variant
    // does not would render right as a backdrop and blank as a shape fill.
    const fillBad = shaderCompileProblem({ id: "m", sksl: "ok", fillSksl: "SYNTAX_ERROR" });
    assert.match(fillBad, /fillSksl failed to compile/);
  } finally {
    setMaterialCompileProbe(null);
  }
});

// ── 3. THE GLASS REGRESSION ──────────────────────────────────────────────────

/** The migrated glass plugin, loaded through the REAL jail, as a descriptor. */
function loadGlassDescriptor() {
  resetPluginMaterials();
  // Load with "glass" NOT taken, so the plugin claims its own id — this is exactly
  // what happens once the built-in descriptor is retired in favour of the asset.
  const plugin = loadPluginAsset(GLASS_ASSET_SOURCE, "liquid_glass.material.plugin.js", new Set());
  assert.strictEqual(materialShapeProblem(plugin), null, "the shipped glass asset must satisfy the contract");
  return materialDescriptor(plugin, parseColor);
}

test("the glass ASSET's SkSL is BYTE-IDENTICAL to the shipped shader", () => {
  const d = loadGlassDescriptor();
  assert.strictEqual(d.sksl, GLASS_SKSL, "sksl must be the shipped GLASS_SKSL, byte for byte");
  assert.strictEqual(d.fillSksl, GLASS_FILL_SKSL, "fillSksl must be the shipped GLASS_FILL_SKSL, byte for byte");
});

test("the glass ASSET's descriptor matches GLASS_MATERIAL's contract fields", () => {
  const d = loadGlassDescriptor();
  assert.strictEqual(d.id, GLASS_MATERIAL.id);
  assert.strictEqual(d.title, GLASS_MATERIAL.title);
  assert.strictEqual(d.uniformFloats, GLASS_MATERIAL.uniformFloats, "25 floats, derived from the declared block");
  assert.strictEqual(d.usesShapeSdf, GLASS_MATERIAL.usesShapeSdf);
  assert.strictEqual(d.backdrop, GLASS_MATERIAL.backdrop, "both default to backdrop (flag absent)");
  // The knob SCHEMA is the same rows, with only the declarative annotations added.
  assert.strictEqual(d.fillParams.length, GLASS_FILL_PARAMS.length);
  for (let i = 0; i < GLASS_FILL_PARAMS.length; i++) {
    const shipped = GLASS_FILL_PARAMS[i], plugin = d.fillParams[i];
    for (const key of Object.keys(shipped))
      assert.deepStrictEqual(plugin[key], shipped[key], `param ${shipped.name}.${key} must be unchanged`);
  }
});

/** A parameter SWEEP over the glass knobs — the regression's real surface. */
function glassSweep() {
  const out = [];
  for (const refractionStrength of [0, 1, 14, 60])
    for (const chromatic of [0, 0.08, 0.5])
      for (const scale of [0.5, 1, 2.75])
        for (const lightAngle of [-111.6, 0, 90])
          for (const tint of ["rgba(255,255,255,0.14)", "rgba(18,18,26,0.62)"])
            out.push({
              blurRadius: 8, refractionStrength, edgeFalloff: 22, lightAngle,
              lightIntensity: 0.8, tint, saturation: 0.92, sheen: 0.1,
              specularPower: 8, contactShadow: 0.26, caustic: 0.12, edgeLight: 0.14,
              tintAdaptivity: 1, chromatic, backdropScale: 1, _scale: scale,
            });
  return out;
}

/** The framework's normalized `u` for a params set (what the painter builds). */
const REGION = { cx: 100, cy: 80, halfW: 90, halfH: 60, cornerRadius: 0, angle: 0 };
const uFor = (toParams, p) => ({ ...REGION, scale: p._scale, ...toParams(p) });

test("GLASS REGRESSION: the plugin PACKS byte-identical uniforms over a 216-case sweep", () => {
  const d = loadGlassDescriptor();
  const cases = glassSweep();
  assert.strictEqual(cases.length, 216);
  for (const p of cases) {
    const shipped = packGlassMaterial(uFor(glassUniformParams, p));
    const plugin = d.pack(uFor(d.toUniformParams, p));
    assert.strictEqual(plugin.length, 25);
    assert.deepStrictEqual(
      Array.from(plugin), Array.from(shipped),
      `packed uniforms differ at ${JSON.stringify(p)}`,
    );
  }
});

test("GLASS REGRESSION: toUniformParams (degrees, colour, omit, fixed, renames) matches the hook", () => {
  const d = loadGlassDescriptor();
  for (const p of glassSweep()) {
    assert.deepStrictEqual(d.toUniformParams(p), glassUniformParams(p), `mapped params differ at ${JSON.stringify(p)}`);
  }
});

test("GLASS REGRESSION: the DECLARED sample reach equals maxGlassDisplacement over the sweep", () => {
  const d = loadGlassDescriptor();
  assert.strictEqual(typeof d.maxSampleReach, "function", "the reach must be DECLARED — dropping it silently falls back to a FULL-SURFACE backdrop re-render");
  for (const p of glassSweep()) {
    const u = uFor(d.toUniformParams, p);
    const declared = d.maxSampleReach(u);
    const shipped = GLASS_MATERIAL.maxSampleReach(u);
    assert.strictEqual(declared, shipped, `reach differs at ${JSON.stringify(p)}`);
    // …and both equal the real formula, so this is pinned to the SHADER, not just
    // to the other implementation.
    assert.strictEqual(declared, maxGlassDisplacement(p.refractionStrength * p._scale, p.chromatic));
  }
});

test("the (1 + chromatic) term is NOT folded into the product — zero aberration keeps a reach", () => {
  const d = loadGlassDescriptor();
  const u = uFor(d.toUniformParams, { ...glassSweep()[0], refractionStrength: 10, chromatic: 0, _scale: 1 });
  assert.ok(d.maxSampleReach(u) > 0, "chromatic 0 must NOT zero the reach (it would clamp the refraction at the panel edge)");
  assert.strictEqual(d.maxSampleReach(u), 17, "10 · 1 · 1.7 · (1 + 0)");
});

test("GLASS REGRESSION: the declared proxyBackdrop equals the hook (the darkens-lighter defect)", () => {
  const d = loadGlassDescriptor();
  for (const tint of ["rgba(255,255,255,0.14)", "rgba(18,18,26,0.62)", "rgba(0,0,0,0)"]) {
    const params = d.toUniformParams({ ...glassSweep()[0], tint });
    assert.deepStrictEqual(d.proxyBackdrop(params), glassProxyBackdrop(params), `proxy tint differs for ${tint}`);
  }
  // The defect this exists to end: a DARK preset must yield a DARK overlay.
  const dark = d.proxyBackdrop(d.toUniformParams({ ...glassSweep()[0], tint: "rgba(18,18,26,0.62)" }));
  assert.ok(dark.tint[0] < 0.2 && dark.tint[3] > 0.5, "a dark glass preset must stand in DARK, not the shared white frost");
});

// ── 4. THE DECLARED-DATA HELPERS, DIRECTLY ───────────────────────────────────

test("packDeclaredUniforms walks the block in order, scales world lengths, and is LOUD", () => {
  const m = { id: "m", uniforms: [{ name: "tint", size: 4 }, { name: "reach", size: 1, scaleByDevice: true }] };
  // Float32Array, so 0.5 is exact and 0.14 would not be — the block's values are
  // compared as the shader will actually see them.
  assert.deepStrictEqual(Array.from(packDeclaredUniforms(m, { tint: [1, 1, 1, 0.5], reach: 14, scale: 2 })), [1, 1, 1, 0.5, 28]);
  assert.throws(() => packDeclaredUniforms({ id: "m", uniforms: [{ name: "g", size: 1 }] }, {}), /must resolve to a finite number/);
  assert.throws(() => packDeclaredUniforms({ id: "m", uniforms: [{ name: "c", size: 4 }] }, { c: [1, 2] }), /expected an array of 4 numbers/);
});

test("declaredUniformParams applies degrees / colour / omit / rename / fixed", () => {
  const m = {
    params: [
      { name: "lightAngle", kind: "angle", unit: "degrees", default: 0 },
      { name: "blurRadius", kind: "number", default: 8, omit: true },
      { name: "specularPower", kind: "number", default: 8, uniform: "specPower" },
      { name: "tint", kind: "color", default: "#fff" },
    ],
    fixed: { materialize: 1 },
  };
  const got = declaredUniformParams(m, { lightAngle: 180, blurRadius: 8, specularPower: 8, tint: "#fff" }, () => [1, 1, 1, 1]);
  assert.deepStrictEqual(got, { lightAngle: Math.PI, specPower: 8, tint: [1, 1, 1, 1], materialize: 1 });
  assert.ok(!("blurRadius" in got), "an op-level knob must be DROPPED, not packed");
});

test("declaredSampleReach / declaredProxyBackdrop return null when undeclared", () => {
  assert.strictEqual(declaredSampleReach({}, {}), null, "undeclared ⇒ whole surface (materials.materialSampleReach's contract)");
  assert.strictEqual(declaredProxyBackdrop({}, {}), null, "undeclared ⇒ the shared frost default");
});

console.log(`\nmaterial_plugin_test: ${passed} checks passed`);
