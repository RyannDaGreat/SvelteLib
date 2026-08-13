/**
 * MATERIAL PLUGINS — the second plugin KIND, and the contract a `kind: "material"`
 * plugin asset must satisfy.
 *
 * ── THE USER RULING (verbatim) ────────────────────────────────────────────────
 * "Are material plugins possible? Should we distinguish widget plugins from
 * material plugins and open the door to possibly future new types of plugins? It
 * would be really cool if we could refactor liquid glass as a plugin, and the other
 * materials as plugins — then the user could actually edit the shader inside the
 * UI, and copy that built-in plugin into a new one."
 *
 * ── THE CONTRACT IS DATA-ONLY, WITH DECLARATIVE ESCAPE HATCHES ────────────────
 * THE DESIGN DECISION, and the one worth reading before touching anything here: a
 * material plugin carries NO JAILED JS ON THE RENDER PATH. Its shader is a STRING
 * (data, compiled by Skia, not by us) and every knob the built-in framework reaches
 * for as a FUNCTION is instead DECLARED AS DATA and interpreted here.
 *
 * The alternative — let a material declare `pack(u)`, `maxSampleReach(u)`,
 * `proxyBackdrop(params)` as jailed functions — was rejected. Those hooks run per
 * op, per frame, inside the painter: `pack` on every material draw,
 * `maxSampleReach` before every backdrop re-render. Putting jailed JS there would
 * mean blockDynamicCompilation()'s global prototype mutation on the hot path (it
 * is currently a load-time-only window by design), and a throw from a viewer's
 * plugin would land in the middle of a Skia composite rather than in a widget's
 * error box. Data cannot throw.
 *
 * WHAT THE FOUR GLASS HOOKS BECAME, which is the proof the data-only contract is
 * expressive enough for the hardest real material:
 *
 *   · `pack(u)` + `uniformFloats` → DERIVED from `uniforms`, an ordered list of
 *     {name, size} naming the shader's uniform block. packDeclaredUniforms walks it.
 *     Mechanical: the built-in packers are all "read these names in this order".
 *
 *   · `toUniformParams(p)` → DERIVED from per-param `unit` + `fixed`. A schema
 *     param declaring `unit: "degrees"` is converted to radians, `kind: "color"` is
 *     parsed to [r,g,b,a], `omit: true` is dropped (op-level knobs like blurRadius),
 *     and `fixed` supplies the constants a fill pins (glass's squircle/materialize).
 *
 *   · `maxSampleReach(u)` → DECLARED DATA `{product: [names…], times: <constant>}`,
 *     meaning "the product of these uniform values, times this constant". Glass's
 *     real formula is refractionStrength · scale · PRE_BULGE · (1 + chromatic), so
 *     it declares {product: ["refractionStrength", "scale"], times: GLASS_PRE_BULGE,
 *     plusFractionOf: "chromatic"} — see declaredSampleReach for why the third term
 *     needs its own field rather than being folded into the product.
 *     THIS ONE IS LOAD-BEARING AND NOT COSMETIC: dropping it does not break the
 *     picture, it silently falls back to a FULL-SURFACE backdrop re-render
 *     (materials.js materialSampleReach: null ⇒ whole surface), which is a large
 *     invisible perf regression — measured at 1,036,800 offscreen px for a panel
 *     whose own footprint is 38,400. tests/material_plugin_test.js pins the
 *     declared form against the old hook over a parameter sweep.
 *
 *   · `proxyBackdrop(params)` → DECLARED DATA `{fromParam: "tint"}`, meaning "the
 *     thumbnail stand-in is that param's colour". Dropping it recreates the exact
 *     defect materials.js:456 exists to end — a material configured to DARKEN
 *     showing up LIGHTER in its own thumbnail, because every backdrop material
 *     shared one hard-coded translucent white.
 *
 * `usesShapeSdf` and the second `fillSksl` are carried through as plain contract
 * FIELDS: they are already data (a boolean and a string).
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────────
 * A material plugin introduces NO new kind of state (CLAUDE.md's three kinds). Its
 * shader is a pure function of its uniforms and the fragment coordinate; the only
 * ambient input any material may read is the seamed clock, which arrives as an
 * ordinary uniform the framework packs (`animated: true` declares that it does).
 * There is no route to a wall clock: the shader is SkSL, which has no host access
 * at all, and the JS half is data.
 *
 * ── LOUD AT REGISTRATION ──────────────────────────────────────────────────────
 * A shader that will not compile is refused AT REGISTRATION with the SkSL
 * compiler's own error text, not at first paint. A broken shader that rendered
 * nothing would be indistinguishable from a correctly-transparent material.
 *
 * DOM-free and bare-node testable, like the rest of core/. The SkSL COMPILE is the
 * one thing that needs CanvasKit, so it is injected (compileProbe) rather than
 * imported — that keeps this module loadable in the node suites and lets the
 * browser seam pass the real compiler.
 */

import { definePluginKind } from "./plugin_assets.js";
import { registerMaterial, isBuiltinMaterialId, materialIds, onFirstMaterialCompile } from "../render_gpu/skia/materials.js";
/**
 * TWO KEYS SPELL THE UNIT, AND THEY MEAN OPPOSITE THINGS. Read this before
 * touching an angle anywhere in the app.
 *
 *   · `unit: "degrees"`    (HERE, plugin materials) — the value is STORED IN
 *     DEGREES and this module converts it to radians for the shader.
 *   · `display: "degrees"` (inspector rows, the built-in shader schemas) — the
 *     value is STORED IN RADIANS and the rotary dial merely SHOWS degrees
 *     (web/displayUnits.js divides by 180/π on commit).
 *
 * So the same word names opposite storage. That is unfortunate but it is NOT
 * ambiguity — a row carries one key or the other, never both, and
 * `core/properties.angleStorageUnit` is the single reader that resolves either
 * spelling to the actual unit. This module keeps `unit:` because a plugin
 * material's params are a DATA schema with no dial behind them, so "what unit is
 * this number" is the only question its author is answering.
 *
 * The conversion factor itself comes from core/properties (`DEG2RAD`), which is
 * THE definition; it was independently redefined in seven shader packers before
 * R7-44a, and two of those packers had drifted from their own row's declaration.
 */
import { DEG2RAD } from "./properties.js";

/** A material id must look like a material id: the same lower_snake_case rule a
 *  widget `type` obeys, so the two namespaces read alike and neither admits a name
 *  that would need quoting in a UI list or a document. */
const MATERIAL_ID_RE = /^[a-z][a-z0-9_]*$/;

/** The param `kind`s a material schema row may declare — the customProps row
 *  vocabulary the built-in fillParams schemas already use (materials.js's FILL
 *  CONTRACT), restated as a set so a typo is refused instead of rendering a blank
 *  Inspector row. */
export const MATERIAL_PARAM_KINDS = Object.freeze(new Set(["number", "angle", "color", "boolean", "select", "text"]));

/**
 * THE CLOCK KNOB. A material whose look advances with presentation time reads the
 * ONE seamed clock (render_gpu/particle_clock.particleTime) — never a wall clock —
 * and a DATA-ONLY plugin has no way to call it. So a uniform may declare
 * `fromClock: true` instead of naming a param, and the framework supplies the
 * current particle time when it packs.
 *
 * This adds NO new kind of state (CLAUDE.md's taxonomy): the value is exactly the
 * recordable-state seam every animated built-in already reads, which the editor and
 * CLI freeze and both exporters override per frame. Routing it through the declared
 * block rather than jailed JS is what keeps Δt = 0 ⟹ an identical frame TRUE for a
 * plugin material, because the plugin cannot reach any other clock.
 *
 * Injected for the same layering reason as the colour parser: core/ must stay
 * bare-node loadable and particle_clock lives in render_gpu/. Defaults to a LOUD
 * thrower so a material declaring `fromClock` before the seam is installed fails by
 * name instead of packing a silent zero and rendering a frozen frame.
 */
let clockSource = () => {
  throw new Error("material_plugins: no clock installed — setMaterialClock must run before a `fromClock` uniform is packed");
};

/** Command. Installs the presentation clock (render_gpu/particle_clock.particleTime).
 *  @example // setMaterialClock(particleTime) */
export function setMaterialClock(clock) {
  clockSource = clock;
}

/**
 * Pure function. Why is `params` not a usable material knob SCHEMA? Returns a
 * reason, or null. The schema is an array of customProps-shaped rows — the ONE
 * declaration the paint dropdown's param rows and the uniform packing both read
 * (materials.js's FILL-MATERIAL CONTRACT).
 *
 * @param {*} params - the value a material plugin's `params` field holds
 * @returns {string|null}
 *
 * @example materialParamsProblem([{name: "gain", kind: "number", default: 2}]) // null
 * @example materialParamsProblem("gain") // 'params must be an array of knob rows, got a string'
 * @example materialParamsProblem([{kind: "number", default: 1}]) // 'params[0] is missing "name"'
 * @example materialParamsProblem([{name: "g", kind: "wobble", default: 1}]) // 'params[0] ("g") declares kind "wobble" — must be one of angle, boolean, color, number, select, text'
 * @example materialParamsProblem([{name: "g", kind: "number"}]) // 'params[0] ("g") is missing "default" — a sparse stored param resolves against it'
 */
export function materialParamsProblem(params) {
  if (!Array.isArray(params)) return `params must be an array of knob rows, got ${params === null ? "null" : typeof params === "object" ? "an object" : `a ${typeof params}`}`;
  const seen = new Set();
  for (let i = 0; i < params.length; i++) {
    const row = params[i];
    if (row === null || typeof row !== "object") return `params[${i}] is not a knob row object`;
    if (typeof row.name !== "string" || !row.name) return `params[${i}] is missing "name"`;
    if (seen.has(row.name)) return `params[${i}] repeats the knob name "${row.name}"`;
    seen.add(row.name);
    if (!MATERIAL_PARAM_KINDS.has(row.kind))
      return `params[${i}] ("${row.name}") declares kind ${JSON.stringify(row.kind)} — must be one of ${[...MATERIAL_PARAM_KINDS].sort().join(", ")}`;
    if (!("default" in row)) return `params[${i}] ("${row.name}") is missing "default" — a sparse stored param resolves against it`;
    if ("codes" in row) {
      // A `codes` row replaces the built-ins' hand-written MODE_CODE / SHAPE_CODE
      // lookup. Its DEFAULT must have a code, or the material's own defaults would
      // throw at the first pack — a refusal at registration is the loud version.
      if (row.codes === null || typeof row.codes !== "object" || Array.isArray(row.codes))
        return `params[${i}] ("${row.name}") declares "codes" that is not an {option: number} map`;
      for (const [option, code] of Object.entries(row.codes))
        if (!Number.isFinite(code)) return `params[${i}] ("${row.name}") maps option "${option}" to ${JSON.stringify(code)} — a code must be a finite number`;
      if (!(row.default in row.codes))
        return `params[${i}] ("${row.name}") defaults to ${JSON.stringify(row.default)}, which has no code (declared: ${Object.keys(row.codes).join(", ")})`;
    }
  }
  return null;
}

/**
 * Pure function. Why is `uniforms` not a usable UNIFORM BLOCK declaration? Returns
 * a reason, or null.
 *
 * The block is an ordered list of `{name, size}` mirroring the shader's `uniform`
 * declarations, tightly packed exactly as CanvasKit expects (float = 1, float2 = 2,
 * float4 = 4). It REPLACES the built-in `pack` function: packDeclaredUniforms walks
 * this list, so the order here IS the shader's declaration order and getting it
 * wrong mis-packs every draw.
 *
 * @param {*} uniforms - the value a material plugin's `uniforms` field holds
 * @returns {string|null}
 *
 * @example uniformsProblem([{name: "uGain", size: 1}]) // null
 * @example uniformsProblem([]) // 'uniforms must declare at least one entry — a material shader with no uniforms cannot be driven by its params'
 * @example uniformsProblem([{name: "uT", size: 3.5}]) // 'uniforms[0] ("uT") declares size 3.5 — must be a positive integer float count (float=1, float2=2, float4=4)'
 */
export function uniformsProblem(uniforms) {
  if (!Array.isArray(uniforms)) return `uniforms must be an array of {name, size} entries, got ${uniforms === null ? "null" : typeof uniforms}`;
  if (uniforms.length === 0) return "uniforms must declare at least one entry — a material shader with no uniforms cannot be driven by its params";
  for (let i = 0; i < uniforms.length; i++) {
    const u = uniforms[i];
    if (u === null || typeof u !== "object") return `uniforms[${i}] is not a {name, size} entry`;
    if (typeof u.name !== "string" || !u.name) return `uniforms[${i}] is missing "name"`;
    if (!Number.isInteger(u.size) || u.size < 1)
      return `uniforms[${i}] ("${u.name}") declares size ${u.size} — must be a positive integer float count (float=1, float2=2, float4=4)`;
    if (u.fromClock !== undefined && u.fromClock !== true)
      return `uniforms[${i}] ("${u.name}") declares fromClock ${JSON.stringify(u.fromClock)} — the only legal value is true (the seamed presentation clock)`;
    if (u.fromClock === true && u.size !== 1)
      return `uniforms[${i}] ("${u.name}") declares fromClock with size ${u.size} — the clock is a single float`;
  }
  return null;
}

/**
 * Pure function. Why is `reach` not a usable DECLARED SAMPLE REACH? Returns a
 * reason, or null. Absence is LEGAL and means "undeclared" — the safe answer
 * materials.materialSampleReach documents (a full-surface backdrop: slow, never
 * wrong).
 *
 * @param {*} reach - the value a material plugin's `maxSampleReach` field holds
 * @returns {string|null}
 *
 * @example sampleReachProblem(undefined) // null (undeclared is legal)
 * @example sampleReachProblem({product: ["refractionStrength", "scale"], times: 1.7}) // null
 * @example sampleReachProblem({times: 2}) // 'maxSampleReach.product must be a non-empty array of uniform names'
 * @example sampleReachProblem(() => 5) // 'maxSampleReach must be DECLARED DATA ({product, times, plusFractionOf}), not a function — a material plugin runs no JS on the render path'
 */
export function sampleReachProblem(reach) {
  if (reach === undefined || reach === null) return null;
  if (typeof reach === "function")
    return "maxSampleReach must be DECLARED DATA ({product, times, plusFractionOf}), not a function — a material plugin runs no JS on the render path";
  if (typeof reach !== "object") return `maxSampleReach must be an object, got a ${typeof reach}`;
  if (!Array.isArray(reach.product) || reach.product.length === 0)
    return "maxSampleReach.product must be a non-empty array of uniform names";
  if (reach.product.some((n) => typeof n !== "string" || !n))
    return "maxSampleReach.product entries must be uniform names (non-empty strings)";
  if ("times" in reach && !Number.isFinite(reach.times))
    return `maxSampleReach.times must be a finite number, got ${reach.times}`;
  if ("plusFractionOf" in reach && (typeof reach.plusFractionOf !== "string" || !reach.plusFractionOf))
    return "maxSampleReach.plusFractionOf must be a uniform name";
  return null;
}

/**
 * Pure function. Why is this value NOT a usable MATERIAL plugin? Returns a
 * human-readable reason, or null when it passes — the `problem` half of the kind
 * dispatch entry, and the exact mirror of pluginShapeProblem for widgets.
 *
 * `emit` / `capabilities` / `defaults` are NOT required (those are the widget
 * contract). What a material needs is an id, a title, a knob schema, a shader
 * string and its uniform block.
 *
 * A FUNCTION-VALUED hook is refused BY NAME, with the field named, because that is
 * the mistake an author porting a built-in material will actually make: the
 * built-ins declare `pack` / `toUniformParams` / `proxyBackdrop` as functions, and
 * copying one verbatim must fail with "declare it as data" rather than registering
 * a material whose packer silently never runs.
 *
 * @param {*} plugin - the value a plugin asset returned
 * @returns {string|null}
 *
 * @example materialShapeProblem({kind: "material", id: "plasma", title: "Plasma", params: [], sksl: "half4 main(float2 p){return half4(1);}", uniforms: [{name: "uT", size: 1}]}) // null
 * @example materialShapeProblem({kind: "material", title: "P"}) // 'is missing "id"'
 * @example materialShapeProblem({kind: "material", id: "Plasma", title: "P", params: [], sksl: "x", uniforms: [{name: "u", size: 1}]}) // 'id "Plasma" must be a lower_snake_case identifier'
 * @example materialShapeProblem({kind: "material", id: "p", title: "P", params: [], sksl: "x", uniforms: [{name: "u", size: 1}], pack: () => []}) // 'declares "pack" as a function — a material plugin is DATA ONLY (declare its uniform block as `uniforms` and let the framework pack it); no JS runs on the render path'
 */
export function materialShapeProblem(plugin) {
  if (plugin === null || typeof plugin !== "object" || Array.isArray(plugin))
    return `returned ${Array.isArray(plugin) ? "an array" : String(plugin)}, not a material object — a material plugin's source must \`return {kind: "material", id, title, params, sksl, uniforms}\``;
  for (const field of ["id", "title", "params", "sksl", "uniforms"])
    if (!(field in plugin)) return `is missing "${field}"`;
  if (typeof plugin.id !== "string" || !MATERIAL_ID_RE.test(plugin.id))
    return `id ${JSON.stringify(plugin.id)} must be a lower_snake_case identifier`;
  if (typeof plugin.title !== "string" || !plugin.title) return "title must be a non-empty string";
  if (typeof plugin.sksl !== "string" || !plugin.sksl.trim())
    return "sksl must be a non-empty SkSL source string";
  const paramsProblem = materialParamsProblem(plugin.params);
  if (paramsProblem) return paramsProblem;
  const blockProblem = uniformsProblem(plugin.uniforms);
  if (blockProblem) return blockProblem;
  const reachProblem = sampleReachProblem(plugin.maxSampleReach);
  if (reachProblem) return reachProblem;
  // THE DATA-ONLY RULE, enforced by name. See the docblock: these are the four
  // fields a built-in declares as functions, and an author porting one must be told
  // to declare data rather than silently getting a material whose hook never runs.
  for (const hook of ["pack", "toUniformParams", "proxyBackdrop", "proxyFill", "sceneParams", "animated"])
    if (typeof plugin[hook] === "function")
      return `declares "${hook}" as a function — a material plugin is DATA ONLY (${DATA_ONLY_ADVICE[hook]}); no JS runs on the render path`;
  if ("fillSksl" in plugin && (typeof plugin.fillSksl !== "string" || !plugin.fillSksl.trim()))
    return "fillSksl, when present, must be a non-empty SkSL source string";
  if (plugin.usesShapeSdf === true && typeof plugin.fillSksl !== "string")
    return "declares usesShapeSdf but no fillSksl — a shape-conforming material needs the variant shader that samples the silhouette SDF child";
  if ("proxyBackdrop" in plugin && plugin.proxyBackdrop !== undefined) {
    const p = plugin.proxyBackdrop;
    if (typeof p !== "object" || p === null || typeof p.fromParam !== "string" || !p.fromParam)
      return 'proxyBackdrop must be declared data {fromParam: "<colour knob name>"} — the thumbnail stand-in reads that knob\'s colour';
    if (!plugin.params.some((row) => row.name === p.fromParam))
      return `proxyBackdrop.fromParam names "${p.fromParam}", which is not one of its params (${plugin.params.map((r) => r.name).join(", ")})`;
  }
  return null;
}

/** The "declare it as data instead" advice, per refused function hook — so the
 *  refusal tells an author what to write, not just what not to. */
const DATA_ONLY_ADVICE = Object.freeze({
  pack: "declare its uniform block as `uniforms` and let the framework pack it",
  toUniformParams: "declare per-param `unit`/`omit` and top-level `fixed` instead",
  proxyBackdrop: 'declare {fromParam: "<colour knob name>"} instead',
  proxyFill: "foreground proxies are derived from the params' mean colour automatically",
  sceneParams: "a plugin material may not query sibling nodes",
  animated: "declare `animated: true` — a predicate would be JS on the render path",
});

/**
 * Pure function. A material plugin's `toUniformParams` equivalent, DERIVED from its
 * schema: schema-shaped resolved params → the numeric params the packer consumes.
 * The declarative replacement for the built-ins' hand-written mapping functions.
 *
 * Three transforms, each declared per-param, plus one top-level constant map:
 *   · `kind: "color"`   → parsed to [r, g, b, a] via the injected `parseColor`
 *     (injected rather than imported so this module stays render_gpu-free at the
 *     value level; the material registration seam passes ir.parseColor).
 *   · `unit: "degrees"` → multiplied to radians (the glass/comic convention).
 *   · `omit: true`      → DROPPED. An OP-LEVEL knob (blurRadius, backdropScale) is
 *     read by the router straight off resolvedParams and is not a shader uniform;
 *     forwarding it would pack a float the block has no slot for.
 * Then `fixed` (a plain object on the plugin) is spread in LAST: the constants a
 * fill pins rather than exposes, which is exactly what glassUniformParams does with
 * squircle / surfaceTension / materialize.
 *
 * @param {{params: Array, fixed?: object}} material - a validated material plugin
 * @param {object} resolved - resolved params (every schema knob present)
 * @param {function(string): number[]} parseColor - colour string → [r,g,b,a]
 * @returns {object} packer-shaped params
 *
 * @example
 * // A degrees knob becomes radians; an omitted op-level knob is dropped;
 * // `fixed` constants ride along.
 * declaredUniformParams(
 *   {params: [{name: "lightAngle", kind: "angle", unit: "degrees", default: 0},
 *             {name: "blurRadius", kind: "number", default: 8, omit: true},
 *             {name: "gain", kind: "number", default: 2}],
 *    fixed: {materialize: 1}},
 *   {lightAngle: 180, blurRadius: 8, gain: 2},
 *   () => [0, 0, 0, 1])
 * // => {lightAngle: 3.141592653589793, gain: 2, materialize: 1}
 * @example
 * // A colour knob is parsed through the injected parser.
 * declaredUniformParams({params: [{name: "tint", kind: "color", default: "#fff"}]},
 *   {tint: "#fff"}, () => [1, 1, 1, 1])
 * // => {tint: [1, 1, 1, 1]}
 * @example
 * // `uniform:` renames an author-facing knob to its uniform's key.
 * declaredUniformParams({params: [{name: "specularPower", kind: "number", default: 8, uniform: "specPower"}]},
 *   {specularPower: 8}, () => [])
 * // => {specPower: 8}
 * @example
 * // `codes` maps a SELECT's option strings to the integer the shader branches on
 * // (the crt/comic convention), and a BOOLEAN packs as 0/1.
 * declaredUniformParams(
 *   {params: [{name: "maskType", kind: "select", default: "shadow", codes: {aperture: 0, shadow: 1}},
 *             {name: "worldLocked", kind: "boolean", default: true}]},
 *   {maskType: "shadow", worldLocked: true}, () => [])
 * // => {maskType: 1, worldLocked: 1}
 */
export function declaredUniformParams(material, resolved, parseColor) {
  const out = {};
  for (const row of material.params) {
    if (row.omit) continue; // op-level, not a shader uniform (the frosted precedent)
    // A knob MAY be exposed under a friendlier name than its uniform's: glass's
    // schema says "specularPower" and "tintAdaptivity" where the block says
    // "specPower" and "adaptivity". `uniform:` declares that rename, which is what
    // lets the schema stay author-facing without the packer needing a mapping hook.
    const key = row.uniform ?? row.name;
    const value = resolved[row.name];
    if (row.kind === "color") out[key] = parseColor(value);
    else if (row.codes) out[key] = codeFor(material, row, value);
    else if (row.kind === "boolean") out[key] = value ? 1 : 0;
    else if (row.unit === "degrees") out[key] = value * DEG2RAD;
    else out[key] = value;
  }
  return { ...out, ...(material.fixed ?? {}) };
}

/** Pure. A `codes` row's option string → its shader integer, LOUD on an unknown
 *  option (crtUniformParams throws on exactly this, and a silent 0 would quietly
 *  select the WRONG branch of the shader rather than reporting a stale document). */
function codeFor(material, row, value) {
  const code = row.codes[value];
  if (code === undefined)
    throw new Error(`material "${material.id ?? "?"}": knob "${row.name}" has no code for ${JSON.stringify(value)} (declared: ${Object.keys(row.codes).join(", ")})`);
  return code;
}

/**
 * Pure function. Packs a material plugin's uniforms into the flat Float32Array
 * CanvasKit expects, by walking its DECLARED `uniforms` block in order — the
 * declarative replacement for a hand-written `pack(u)`.
 *
 * `u` is the framework's normalized uniform input: device-px region geometry
 * ({cx, cy, halfW, halfH, cornerRadius, angle}) plus `scale` plus the material's own
 * knobs spread in by name (materials.js's MATERIAL CONTRACT). A uniform naming a
 * WORLD-px length declares `scaleByDevice: true` and is multiplied by `u.scale`
 * here, which is the only arithmetic the built-in packers do beyond forwarding
 * (glass scales refractionStrength and edgeFalloff exactly this way).
 *
 * A missing or non-finite value is LOUD: packing NaN would render a silently black
 * or absent material with no error anywhere.
 *
 * @param {{id: string, uniforms: Array}} material - a validated material plugin
 * @param {object} u - the normalized uniform input
 * @returns {Float32Array} the packed block, in declaration order
 *
 * @example
 * // Scalars pack in declaration order.
 * Array.from(packDeclaredUniforms({id: "m", uniforms: [{name: "cx", size: 1}, {name: "cy", size: 1}]}, {cx: 10, cy: 20}))
 * // => [10, 20]
 * @example
 * // A float4 (a colour) spreads into four slots; a world-px length is scaled to
 * // device. The result is a Float32Array, so 0.5 round-trips exactly (0.14 would
 * // come back as 0.14000000059604645 — the value the shader really receives).
 * Array.from(packDeclaredUniforms(
 *   {id: "m", uniforms: [{name: "tint", size: 4}, {name: "reach", size: 1, scaleByDevice: true}]},
 *   {tint: [1, 1, 1, 0.5], reach: 14, scale: 2}))
 * // => [1, 1, 1, 0.5, 28]
 * @example
 * // A float3 colour packs RGB and DROPS the alpha — the `rgb()` helper the crt,
 * // comic and rainy_window packers all use for a knob whose alpha is meaningless.
 * Array.from(packDeclaredUniforms({id: "m", uniforms: [{name: "tint", size: 3}]}, {tint: [1, 0.5, 0.25, 1]}))
 * // => [1, 0.5, 0.25]
 */
export function packDeclaredUniforms(material, u) {
  const out = [];
  for (const slot of material.uniforms) {
    // A CLOCK slot takes no param: the framework supplies presentation time, which
    // is the only ambient input a material may read (see setMaterialClock).
    const raw = slot.fromClock ? clockSource() : u[slot.name];
    // A size-2 slot declaring `asVector` packs an ANGLE as its unit direction
    // [cos, sin] — the corkboard family's `lightVec`, which is a unit conversion on
    // an angle exactly as `unit: "degrees"` is, not a computation over other knobs.
    if (slot.asVector) { out.push(...angleVector(raw, material.id, slot.name)); continue; }
    const value = slot.scaleByDevice ? scaledLength(raw, u.scale, material.id, slot.name) : raw;
    if (slot.size === 1) {
      if (!Number.isFinite(value))
        throw new Error(`material "${material.id}": uniform "${slot.name}" is ${value} — every declared uniform must resolve to a finite number`);
      out.push(value);
    } else {
      // A COLOUR slot may still hold its STRING here. `toUniformParams` parses the
      // knobs it maps, but the fill path spreads the op's raw `params` into `u` and
      // some callers hand a material's own defaults straight to `pack` — which is why
      // the built-in `rgb()` packers parse defensively too (packCork does exactly
      // this). Parsing at the slot keeps the packer total over both shapes rather
      // than throwing on a string the shipped packer accepted.
      const parsed = typeof value === "string" ? colorParser(value) : value;
      // A size-3 slot then packs only RGB: `kind: "color"` always yields four
      // channels, while the built-in `rgb()` packers emit three for a knob whose
      // alpha carries no meaning. Truncating here is what lets the colour parse stay
      // uniform while the BLOCK stays byte-identical to the shader's.
      const channels = Array.isArray(parsed) && slot.size === 3 && parsed.length === 4 ? parsed.slice(0, 3) : parsed;
      if (!Array.isArray(channels) || channels.length !== slot.size)
        throw new Error(`material "${material.id}": uniform "${slot.name}" declares size ${slot.size} but its value is ${JSON.stringify(value)} — expected an array of ${slot.size} numbers`);
      for (const c of channels) {
        if (!Number.isFinite(c))
          throw new Error(`material "${material.id}": uniform "${slot.name}" contains a non-finite component (${c})`);
        out.push(c);
      }
    }
  }
  return new Float32Array(out);
}

/** Pure. An angle (radians) as its unit direction [cos, sin] — the corkboard
 *  family's lightVec. Loud on a non-finite angle, like every other slot. */
function angleVector(raw, id, name) {
  if (!Number.isFinite(raw))
    throw new Error(`material "${id}": uniform "${name}" declares asVector but its angle is ${raw} — expected a finite number of radians`);
  return [Math.cos(raw), Math.sin(raw)];
}

/** Pure. A world-px length in device px, loud when either factor is not finite. */
function scaledLength(raw, scale, id, name) {
  if (!Number.isFinite(raw) || !Number.isFinite(scale))
    throw new Error(`material "${id}": uniform "${name}" declares scaleByDevice but value=${raw} scale=${scale} — both must be finite`);
  return raw * scale;
}

/**
 * Pure function. A material plugin's MAXIMUM outward backdrop-sample reach in
 * DEVICE px, computed from its DECLARED `maxSampleReach` data — the declarative
 * replacement for the `maxSampleReach(u)` hook, and the thing that keeps a plugin
 * material's backdrop re-render REGION-BOUNDED instead of full-surface.
 *
 * The declared form is `{product: [uniform names…], times, plusFractionOf}`, read as
 *
 *     reach = (∏ u[name]) · times · (1 + u[plusFractionOf])
 *
 * WHY `plusFractionOf` IS ITS OWN FIELD rather than another product entry: the term
 * is (1 + x), not x. Glass's chromatic aberration pushes the blue tap a FURTHER
 * (1 + chromatic)×, so at chromatic = 0 the factor must be 1 — folding it into the
 * product would make a zero-aberration glass declare a reach of ZERO and clamp its
 * own refraction at the panel edge. That is the difference between mirroring the
 * real formula and approximating it, which is why the sweep test exists.
 *
 * Returns null when nothing is declared — materials.materialSampleReach's "not
 * declared" answer, which keeps today's whole-surface behaviour.
 *
 * @param {{maxSampleReach?: object}} material - a validated material plugin
 * @param {object} u - the normalized uniform input (device geometry + scale + knobs)
 * @returns {number|null} device-px outward reach, or null when undeclared
 *
 * @example declaredSampleReach({}, {}) // null (undeclared ⇒ whole surface)
 * @example
 * // Glass's real formula: refractionStrength · scale · PRE_BULGE · (1 + chromatic).
 * declaredSampleReach(
 *   {maxSampleReach: {product: ["refractionStrength", "scale"], times: 1.7, plusFractionOf: "chromatic"}},
 *   {refractionStrength: 10, scale: 1, chromatic: 0.08})
 * // => 18.36
 * @example
 * // Zero aberration keeps the (1 + x) factor at 1 — it does NOT zero the reach.
 * declaredSampleReach({maxSampleReach: {product: ["r"], times: 2, plusFractionOf: "c"}}, {r: 5, c: 0})
 * // => 10
 */
export function declaredSampleReach(material, u) {
  const spec = material.maxSampleReach;
  if (!spec) return null;
  let reach = 1;
  for (const name of spec.product) {
    const v = u[name];
    if (!Number.isFinite(v))
      throw new Error(`material "${material.id}": maxSampleReach.product names "${name}", which is ${v} — it must be a finite uniform value`);
    reach *= v;
  }
  if ("times" in spec) reach *= spec.times;
  if (spec.plusFractionOf) {
    const f = u[spec.plusFractionOf];
    if (!Number.isFinite(f))
      throw new Error(`material "${material.id}": maxSampleReach.plusFractionOf names "${spec.plusFractionOf}", which is ${f} — it must be a finite uniform value`);
    reach *= 1 + f;
  }
  return reach;
}

/**
 * Pure function. A material plugin's proxy-backdrop TINT, from its declared
 * `{fromParam}` — the declarative replacement for the `proxyBackdrop(params)` hook.
 * Returns null when undeclared, which is materials.resolveProxyBackdrop's "use the
 * shared frost default" answer.
 *
 * The named param has already been through declaredUniformParams by the time the
 * painter asks, so a `kind: "color"` knob is an [r,g,b,a] array here.
 *
 * @param {{proxyBackdrop?: {fromParam: string}}} material - a validated material plugin
 * @param {object} params - the op's params (post-toUniformParams)
 * @returns {{tint: number[]}|null}
 *
 * @example declaredProxyBackdrop({}, {}) // null (undeclared ⇒ the shared frost)
 * @example declaredProxyBackdrop({proxyBackdrop: {fromParam: "tint"}}, {tint: [0, 0, 0, 0.5]}) // {tint: [0, 0, 0, 0.5]}
 */
export function declaredProxyBackdrop(material, params) {
  const spec = material.proxyBackdrop;
  if (!spec) return null;
  const c = params[spec.fromParam];
  if (!Array.isArray(c) || c.length !== 4)
    throw new Error(`material "${material.id}": proxyBackdrop.fromParam "${spec.fromParam}" resolved to ${JSON.stringify(c)} — expected a parsed [r, g, b, a] colour`);
  return { tint: [c[0], c[1], c[2], c[3]] };
}

/**
 * Pure function. A validated material PLUGIN → the DESCRIPTOR the material registry
 * takes (materials.js's MATERIAL CONTRACT: {id, sksl, pack, uniformFloats, …}).
 * THE adapter between the two contracts, and the place the declarative escape
 * hatches become the function-shaped hooks the painter already calls.
 *
 * The hooks it synthesizes are CLOSURES OVER DATA — pure, host-free, and defined in
 * THIS module, not in the plugin. That is the whole data-only design: the painter's
 * call signature is unchanged, and what runs inside it is framework code reading
 * declared values, never jailed source.
 *
 * `uniformFloats` is DERIVED (the sum of the declared sizes), so the packer's own
 * length assertion checks the plugin's block against itself — a shader edit that
 * adds a uniform without updating the block is caught at the first draw rather than
 * packing a mis-sized array.
 *
 * @param {object} plugin - a material plugin that passed materialShapeProblem
 * @param {function(string): number[]} parseColor - colour string → [r,g,b,a]
 * @returns {object} a materials.js descriptor
 *
 * @example
 * // The descriptor carries the registry's field names, with pack/toUniformParams
 * // synthesized from the declarations.
 * const d = materialDescriptor({kind: "material", id: "m", title: "M", sksl: "x",
 *   params: [{name: "gain", kind: "number", default: 2}], uniforms: [{name: "gain", size: 1}]}, () => []);
 * [d.id, d.uniformFloats, typeof d.pack, d.fillParams.length]
 * // => ["m", 1, "function", 1]
 */
export function materialDescriptor(plugin, parseColor) {
  const uniformFloats = plugin.uniforms.reduce((n, s) => n + s.size, 0);
  const descriptor = {
    id: plugin.id,
    title: plugin.title,
    sksl: plugin.sksl,
    // The knob SCHEMA is the registry's `fillParams` — the field name the paint
    // dropdown and materialParamDefaults already read. A plugin spells it `params`
    // because "fill" is a detail of where it is offered, not of what it is.
    fillParams: plugin.params,
    uniformFloats,
    pack: (u) => packDeclaredUniforms(plugin, u),
    toUniformParams: (p) => declaredUniformParams(plugin, p, parseColor),
    // Marks it as plugin-sourced, for the Explorer, the picker and error messages.
    pluginSource: true,
  };
  if (plugin.backdrop === false) descriptor.backdrop = false;
  if (plugin.animated === true) descriptor.animated = true;
  if (plugin.usesShapeSdf === true) {
    descriptor.usesShapeSdf = true;
    descriptor.fillSksl = plugin.fillSksl;
  }
  if (plugin.maxSampleReach) descriptor.maxSampleReach = (u) => declaredSampleReach(plugin, u);
  if (plugin.proxyBackdrop) descriptor.proxyBackdrop = (params) => declaredProxyBackdrop(plugin, params);
  return descriptor;
}

/**
 * The SkSL COMPILE PROBE — injected, because core/ must stay bare-node loadable and
 * a real compile needs CanvasKit. `setMaterialCompileProbe` is called by the browser
 * seam once CanvasKit is up; until then registration validates SHAPE only.
 *
 * WHY IT IS NOT OPTIONAL IN PRACTICE: a shader that will not compile renders
 * NOTHING, which is indistinguishable from a correctly-transparent material. The
 * probe is what turns that into a refusal naming the compiler's own error text.
 */
let compileProbe = null;

/**
 * Command (sets the module-level probe). Installs the SkSL compile check used at
 * material registration. The probe takes a source string and returns null when it
 * compiles, or the compiler's error text when it does not.
 *
 * @param {function(string): (string|null)} probe
 * @returns {void}
 *
 * @example // setMaterialCompileProbe((src) => { let e = null; const eff = CanvasKit.RuntimeEffect.Make(src, (m) => (e = m)); return eff ? null : e; })
 */
export function setMaterialCompileProbe(probe) {
  compileProbe = probe;
}

/**
 * ARM THE PROBE AUTOMATICALLY, at the first material compile. materials.js fires this
 * one-shot hook with the CanvasKit instance the moment any material compiles, which
 * is the earliest point a real SkSL compiler is known to exist in ANY mode (editor,
 * render-job page, or the software surface cli/render.js uses). Registering the hook
 * HERE — rather than materials.js importing this module — is what keeps the two out
 * of an import cycle.
 *
 * A caller that already installed a probe (the shader-refusal test) wins: the hook
 * only fills an empty slot, so a test's stub is never clobbered by a real compile.
 */
onFirstMaterialCompile((CanvasKit) => {
  if (compileProbe) return;
  setMaterialCompileProbe((source) => {
    let err = null;
    const effect = CanvasKit.RuntimeEffect.Make(source, (message) => { err = message; });
    if (effect) { effect.delete?.(); return null; }
    return err ?? "the SkSL compiler reported no message";
  });
});

/**
 * Query (runs the injected probe, if installed). Why will this material's shader(s)
 * not compile? Returns the compiler's error text, or null when they compile — or
 * when no probe is installed (bare node, where there is no CanvasKit).
 *
 * BOTH shaders are checked: a material declaring `usesShapeSdf` carries a SECOND
 * source (`fillSksl`), and a material whose base compiles while its fill variant
 * does not would render correctly as a widget backdrop and blank as a shape fill.
 *
 * @param {{id: string, sksl: string, fillSksl?: string}} plugin
 * @returns {string|null}
 *
 * @example shaderCompileProblem({id: "m", sksl: "half4 main(float2 p){return half4(1);}"}) // null (no probe installed in bare node)
 */
export function shaderCompileProblem(plugin) {
  if (!compileProbe) return null;
  const base = compileProbe(plugin.sksl);
  if (base) return `sksl failed to compile:\n${base}`;
  if (typeof plugin.fillSksl === "string") {
    const fill = compileProbe(plugin.fillSksl);
    if (fill) return `fillSksl failed to compile:\n${fill}`;
  }
  return null;
}

/**
 * The colour parser the synthesized `toUniformParams` uses. Injected for the same
 * layering reason as the compile probe — `parseColor` lives in render_gpu/ir.js, and
 * while core/ does import that module elsewhere, keeping the value-level dependency
 * injectable is what lets the node suites exercise this file with a stub.
 * Defaults to a loud thrower so a missing injection is never a silent black colour.
 */
let colorParser = (v) => {
  throw new Error(`material_plugins: no colour parser installed — setMaterialColorParser must run before a colour knob is packed (asked for ${JSON.stringify(v)})`);
};

/** Command. Installs the colour parser (render_gpu/ir.js parseColor).
 *  @example // setMaterialColorParser(parseColor) */
export function setMaterialColorParser(parse) {
  colorParser = parse;
}

/**
 * Command (registers into the MATERIAL registry; loud on refusal). The `register`
 * half of the material kind's dispatch entry: validate the shader COMPILES, adapt
 * the plugin to a registry descriptor, and register it.
 *
 * The `registry` argument (a core/registry.js widget registry) is IGNORED — the
 * material registry is a module singleton in render_gpu/skia/materials.js, not a
 * per-document object. That asymmetry is why the dispatch entry carries a
 * `register` function at all rather than the loader assuming one registry.
 *
 * @param {object} _registry - the widget registry (unused; see above)
 * @param {object} plugin - a material plugin that passed materialShapeProblem
 * @returns {void}
 */
function registerMaterialPlugin(_registry, plugin) {
  const compile = shaderCompileProblem(plugin);
  if (compile) throw new Error(compile);
  registerMaterial(materialDescriptor(plugin, (v) => colorParser(v)));
}

/**
 * THE "material" KIND'S DISPATCH ENTRY, installed at module init.
 *
 * This is the ONE line that makes `kind: "material"` a thing the loader accepts, and
 * it is why core/plugin_assets.js needs no knowledge of SkSL: the kind's whole
 * contract (shape validation, the name it claims, where it registers) is owned here
 * and handed over as data. A future kind — a transition, an easing curve — adds one
 * more call like this from its own module.
 */
definePluginKind("material", {
  noun: "material",
  nameField: "id",
  problem: materialShapeProblem,
  nameOf: (p) => p.id,
  register: registerMaterialPlugin,
  // The material registry is a module SINGLETON, so unlike widgets its taken-name
  // set cannot be seeded from the registry object the loader was handed — it has to
  // be asked for. This is the seam that makes `id: "glass"` in a stranger's deck a
  // loud refusal rather than a silent repaint of every glass fill in the document.
  takenNames: () => materialIds(),
});

export { isBuiltinMaterialId };
