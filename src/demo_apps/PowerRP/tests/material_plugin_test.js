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
import { getMaterial, materialIds, resetPluginMaterials, isBuiltinMaterialId, isBackdropMaterial } from "../render_gpu/skia/materials.js";
import { GLASS_MATERIAL, GLASS_SKSL, GLASS_FILL_SKSL, GLASS_FILL_PARAMS, maxGlassDisplacement, glassUniformParams, packGlassMaterial, glassProxyBackdrop } from "../render_gpu/skia/glass_shader.js";
// The MIGRATED materials' modules still export their descriptors — that is the
// "stays exported as the regression reference" pattern, and these are the references.
import { CORK_MATERIAL, TACK_MATERIAL } from "../render_gpu/skia/corkboard_shader.js";
import { RAINY_WINDOW_MATERIAL } from "../render_gpu/skia/rainy_window_shader.js";
// …and the ones that did NOT migrate, whose blocking hooks are pinned below.
import { CRT_MATERIAL } from "../render_gpu/skia/crt_shader.js";
import { COMIC_MATERIAL } from "../render_gpu/skia/comic_shader.js";
import { FROSTED_MATERIAL } from "../render_gpu/skia/frosted_shader.js";
import { setParticleTimeOverride } from "../render_gpu/particle_clock.js";
import { setMaterialClock } from "../core/material_plugins.js";
import { particleTime } from "../render_gpu/particle_clock.js";
import { parseColor } from "../render_gpu/ir.js";
import { createRegistry } from "../core/registry.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed++;
}

setMaterialColorParser(parseColor);
// The clock seam, for the `fromClock` uniform rainy_window declares. Installed here
// because this suite loads material_plugins.js directly rather than through
// core/builtin_plugin_assets.js, which is where the app installs it.
setMaterialClock(particleTime);

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

// ── 3b. THE SECOND-WAVE MIGRATIONS: corkboard + rainy_window ─────────────────
//
// The same regression glass gets, per material, against the descriptor its module
// STILL EXPORTS (the "stays exported as the regression reference" pattern). Each
// exercises a declarative hatch glass did not need, which is the point of migrating
// more than one:
//   · corkboard — a FOREGROUND material (backdrop:false), `scale` packed as a uniform
//     in its own right, and `asVector` (an angle packed as [cos, sin]).
//   · rainy_window — `fromClock`, the ONE ambient input a material may read.
// The materials that did NOT migrate are recorded as blocked, with the exact hook, in
// the BLOCKED section below — a test, not a comment, so a future attempt starts from
// the real obstacle rather than rediscovering it.

/** Loads a migrated library material through the REAL jail, as a descriptor. */
function loadLibraryMaterial(file) {
  resetPluginMaterials();
  const source = readFileSync(new URL(`../assets/builtin/library/${file}`, import.meta.url), "utf8");
  const plugin = loadPluginAsset(source, file, new Set());
  assert.strictEqual(materialShapeProblem(plugin), null, `${file} must satisfy the material contract`);
  return materialDescriptor(plugin, parseColor);
}

/**
 * A parameter SWEEP over a material's OWN schema: its defaults, then every knob
 * perturbed one at a time in a way appropriate to its kind. Derived from the schema
 * rather than hand-listed, so a knob added to a material is swept without editing
 * this file — the glass sweep's 216 cases were hand-built because glass's regression
 * predates there being more than one migrated material to generalize over.
 */
function schemaSweep(fillParams) {
  const defaults = Object.fromEntries(fillParams.map((r) => [r.name, r.default]));
  const cases = [defaults];
  for (const row of fillParams) {
    if (row.kind === "number") cases.push({ ...defaults, [row.name]: (row.default ?? 0) + 0.37 });
    if (row.kind === "angle") cases.push({ ...defaults, [row.name]: 33.3 }, { ...defaults, [row.name]: -117 });
    if (row.kind === "boolean") cases.push({ ...defaults, [row.name]: !row.default });
    if (row.kind === "color") cases.push({ ...defaults, [row.name]: "rgba(18,200,26,0.62)" });
    if (row.kind === "select" && Array.isArray(row.options))
      for (const o of row.options) cases.push({ ...defaults, [row.name]: o });
  }
  return cases;
}

/** Two regions and three scales — the geometry axis every packer reads. */
const SWEEP_REGIONS = [
  { cx: 100, cy: 80, halfW: 90, halfH: 60, cornerRadius: 0, angle: 0 },
  { cx: -5, cy: 12, halfW: 220, halfH: 35, cornerRadius: 18, angle: 0.7 },
];
const SWEEP_SCALES = [0.5, 1, 2.75];

/**
 * THE per-material regression: SkSL byte-identical, and packed uniforms deep-equal to
 * the shipped packer over the full sweep. Returns the comparison count so the suite
 * can report the sweep size it actually ran (a sweep that silently shrank to one case
 * would still pass every assertion).
 */
function assertMigrationParity(file, shipped) {
  const d = loadLibraryMaterial(file);
  assert.strictEqual(d.sksl, shipped.sksl, `${file}: sksl must be the shipped shader, byte for byte`);
  assert.strictEqual(d.fillSksl ?? null, shipped.fillSksl ?? null, `${file}: fillSksl must be byte-identical too`);
  assert.strictEqual(d.uniformFloats, shipped.uniformFloats, `${file}: the declared block must total the shipped float count`);
  // The BACKDROP/FOREGROUND half is compared through isBackdropMaterial, not by the
  // raw flag: absence and `true` both MEAN backdrop (materials.js: "absence of the
  // flag defaults to true"), and materialDescriptor only carries the flag when it is
  // false. Comparing the field would fail on a cosmetic difference while a genuine
  // flip — the thing that would bind children to a foreground material, or starve a
  // backdrop one — is exactly what this predicate catches.
  assert.strictEqual(isBackdropMaterial(d), isBackdropMaterial(shipped), `${file}: the backdrop/foreground half must not flip`);
  assert.strictEqual(d.fillParams.length, shipped.fillParams.length, `${file}: the knob schema must keep every row`);
  let n = 0;
  for (const region of SWEEP_REGIONS)
    for (const scale of SWEEP_SCALES)
      for (const p of schemaSweep(shipped.fillParams)) {
        const uShipped = { ...region, scale, ...(shipped.toUniformParams ? shipped.toUniformParams(p) : p) };
        const uPlugin = { ...region, scale, ...d.toUniformParams(p) };
        assert.deepStrictEqual(
          Array.from(d.pack(uPlugin)), Array.from(shipped.pack(uShipped)),
          `${file}: packed uniforms differ at scale=${scale} ${JSON.stringify(p)}`,
        );
        n++;
      }
  return n;
}

test("CORKBOARD REGRESSION: byte-identical SkSL + packed uniforms over its schema sweep", () => {
  const n = assertMigrationParity("corkboard.material.plugin.js", CORK_MATERIAL);
  assert.strictEqual(n, 78, "the corkboard sweep is 13 param cases x 2 regions x 3 scales — a shrunk sweep still passes every assertion, so its SIZE is pinned");
  console.log(`      (corkboard sweep: ${n} packed-uniform comparisons)`);
});

test("CORKBOARD: the FOREGROUND flag and the asVector light direction survive", () => {
  const d = loadLibraryMaterial("corkboard.material.plugin.js");
  assert.strictEqual(d.backdrop, false, "corkboard is a FOREGROUND material — it must bind no backdrop children");
  // lightAngle packs as [cos, sin]: at 0 rad that is exactly [1, 0], which pins the
  // convention rather than merely the parity (a swapped pair would still deep-equal
  // the shipped packer if the shipped packer were also swapped).
  const defaults = Object.fromEntries(CORK_MATERIAL.fillParams.map((r) => [r.name, r.default]));
  const u = { ...SWEEP_REGIONS[0], scale: 1, ...d.toUniformParams({ ...defaults, lightAngle: 0 }) };
  const packed = Array.from(d.pack(u));
  assert.deepStrictEqual(packed.slice(-2), [1, 0], "an angle of 0 must pack as the unit direction [1, 0]");
});

test("RAINY_WINDOW REGRESSION: byte-identical SkSL + packed uniforms over its schema sweep", () => {
  // The clock is FROZEN for the comparison so both sides read the same instant —
  // otherwise the shipped hook and the declared block could sample different times
  // and the test would flake rather than measure.
  setParticleTimeOverride(7.25);
  try {
    const n = assertMigrationParity("rainy_window.material.plugin.js", RAINY_WINDOW_MATERIAL);
    assert.strictEqual(n, 84, "the rainy_window sweep is 14 param cases x 2 regions x 3 scales — pinned for the same reason");
    console.log(`      (rainy_window sweep: ${n} packed-uniform comparisons)`);
  } finally {
    setParticleTimeOverride(null);
  }
});

test("RAINY_WINDOW: `fromClock` reads the ONE seamed clock, and Δt = 0 is byte-identical", () => {
  const d = loadLibraryMaterial("rainy_window.material.plugin.js");
  assert.strictEqual(d.animated, true, "an animated material must declare it, or the presenter stops repainting it");
  const defaults = Object.fromEntries(RAINY_WINDOW_MATERIAL.fillParams.map((r) => [r.name, r.default]));
  const packAt = (t) => {
    setParticleTimeOverride(t);
    try { return Array.from(d.pack({ ...SWEEP_REGIONS[0], scale: 1, ...d.toUniformParams(defaults) })); }
    finally { setParticleTimeOverride(null); }
  };
  // THE DEFINING TEST (CLAUDE.md): Δt = 0 ⟹ recordable state UNCHANGED. Twice at the
  // same instant must be byte-identical; a different instant must actually differ, or
  // the clock is not wired and the material would export as a FROZEN picture.
  assert.deepStrictEqual(packAt(3), packAt(3), "Δt = 0 must produce identical uniforms");
  assert.notDeepStrictEqual(packAt(3), packAt(9), "a different presentation time must move the clock uniform");
  // …and the moving slot is the CLOCK's, not some other knob's.
  const a = packAt(3), b = packAt(9);
  const moved = a.map((v, i) => (Object.is(v, b[i]) ? null : i)).filter((i) => i !== null);
  assert.deepStrictEqual(moved, [6], "exactly the `time` slot (index 6) may move with the clock");
  assert.strictEqual(a[6], 3, "the packed clock uniform must be the seamed presentation time");
});

// ── 3c. THE MATERIALS THAT DID NOT MIGRATE, AND THE EXACT HOOK THAT BLOCKED ──
//
// Recorded as ASSERTIONS rather than prose so they cannot rot: each one pins the
// property that makes the material inexpressible as DATA today. If a future contract
// extension makes one expressible, its assertion here fails and says so — which is the
// signal to migrate it, not to delete the test.

test("BLOCKED — crt: maxSampleReach is a SUM of geometry terms, not {product, times}", () => {
  const u = { halfW: 120, halfH: 80, scale: 1, curvature: 0.15, convergence: 0.06, sourceTVL: 480 };
  const reach = CRT_MATERIAL.maxSampleReach(u);
  // Not a product: zeroing curvature must NOT zero the reach (the convergence and
  // band-limit terms remain), which is precisely what a {product} form cannot express.
  const noCurve = CRT_MATERIAL.maxSampleReach({ ...u, curvature: 0 });
  assert.ok(noCurve > 0, "the reach is a SUM — zeroing one term must leave the others");
  assert.ok(reach > noCurve, "curvature must still contribute");
  // And it is LOAD-BEARING: dropping it falls back to a full-surface backdrop.
  assert.ok(isBuiltinMaterialId("crt"), "crt must stay BUILT-IN while its reach is inexpressible");
});

test("BLOCKED — comic: its cell size is a CONDITIONAL world/device lock with a floor", () => {
  const defaults = Object.fromEntries(COMIC_MATERIAL.fillParams.map((r) => [r.name, r.default]));
  const at = (worldLocked, scale) => {
    const u = { ...SWEEP_REGIONS[0], scale, ...COMIC_MATERIAL.toUniformParams({ ...defaults, worldLocked }) };
    return Array.from(COMIC_MATERIAL.pack(u))[7]; // the cell-size slot
  };
  // `scaleByDevice` is unconditional multiplication; comic's is a BRANCH on a knob.
  assert.strictEqual(at(true, 2), at(true, 1) * 2, "world-locked scales with the device");
  assert.strictEqual(at(false, 2), at(false, 1), "screen-locked does NOT — no declared slot can say that");
  assert.ok(isBuiltinMaterialId("comic"));
});

test("BLOCKED — corkboardThumbtack: its id is camelCase, which MATERIAL_ID_RE refuses", () => {
  assert.strictEqual(TACK_MATERIAL.id, "corkboardThumbtack");
  assert.match(
    materialShapeProblem({ ...MINIMAL, id: TACK_MATERIAL.id }),
    /must be a lower_snake_case identifier/,
  );
  // Renaming it would orphan the material paint of every document that stores the id,
  // so it stays built-in until a migration carries a rename with it.
  assert.ok(isBuiltinMaterialId("corkboardThumbtack"));
});

test("BLOCKED — frosted: proxyBackdrop SOLVES for a colour, far beyond {fromParam}", () => {
  // {fromParam} returns a knob's colour verbatim. Frosted's hook fits an overlay to a
  // transmission spectrum, so its result is NOT any of its params — the property that
  // makes it inexpressible, and the reason the hook is load-bearing (a darkening
  // preset must not stand in lighter).
  const dark = FROSTED_MATERIAL.proxyBackdrop({ frost: 0.02, tint: "rgb(78,82,96)", absorb: 0.88 });
  assert.ok(dark.tint[3] > 0.5, "a smoked preset must stand in DARK");
  const tintRgb = parseColor("rgb(78,82,96)");
  assert.notDeepStrictEqual(dark.tint.slice(0, 3), tintRgb.slice(0, 3), "the overlay is SOLVED, not copied from the knob");
  assert.ok(isBuiltinMaterialId("frosted"));
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
