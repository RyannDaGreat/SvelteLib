/**
 * THE MATERIAL FRAMEWORK — a registry of backdrop MATERIALS, the reusable
 * generalization of the one-off Liquid Glass path (glass_shader.js +
 * paint_skia.js handleGlassBackdrop). A "material" is an SkSL shader that
 * distorts / relights the composite-so-far inside a rounded-rect region, driven
 * by per-widget uniforms; the `materialBackdrop` IR op (render_gpu/ir.js) carries
 * a material `id` + a flat `params` map, and paint_skia.js handleMaterialBackdrop
 * dispatches through THIS registry — reusing ONE piece of machinery (the
 * below-content re-render, the sharp+blurred child image shaders, and the
 * RuntimeEffect compile+cache) for every material. Adding a material is a new
 * shader file + a one-line registry entry; it does NOT touch ir.js or the backend.
 *
 * ── THE MATERIAL CONTRACT ─────────────────────────────────────────────────────
 * A descriptor is `{ id, sksl, pack, uniformFloats }`:
 *   - `id`     — the string the `materialBackdrop` op names (matches the plugin).
 *   - `sksl`   — REAL SkSL. Its two children are the STANDARD backdrop pair, in
 *                THIS order: `uniform shader blurredBackdrop; uniform shader
 *                sharpBackdrop;` (both device-space image shaders of the scene
 *                below in z-order). `main(float2 p)` works in DEVICE px.
 *   - `pack(u)`— PURE. Maps the framework's normalized `u` to the uniform
 *                Float32Array in declaration order. `u` carries the region
 *                geometry ALREADY resolved to device px — {cx, cy, halfW, halfH,
 *                cornerRadius, angle} — plus `scale` (world→device length factor,
 *                for any world-unit knob a material chooses to expose) and the
 *                material's own knob values spread in by name (the op's `params`).
 *   - `uniformFloats` — the asserted packed length (the packer double-checks).
 *
 * Because a material's knobs are ordinary op `params` (already-evaluated item
 * state), ANY of them may be authored as a `=` equation upstream with zero
 * engine change — the same story glass's self.* knobs already prove.
 *
 * DOM-free at import (only string SkSL + pure packers), like glass_shader.js.
 */

import { parseColor } from "../ir.js";
import { GLASS_MATERIAL } from "./glass_shader.js"; // Liquid Glass as a FILL material (its legacy glassBackdrop op path is unchanged)
import { CRT_MATERIAL } from "./crt_shader.js";
import { METABALLS_MATERIAL } from "./metaballs_shader.js";
import { FROSTED_MATERIAL } from "./frosted_shader.js";
import { CORK_MATERIAL, NOTE_MATERIAL, TACK_MATERIAL } from "./corkboard_shader.js";
import { RAYCAST_DITHER_MATERIAL } from "./raycast_dither_shader.js";
import { RAINY_WINDOW_MATERIAL } from "./rainy_window_shader.js";
// The `sky*` archetype — physically-based sky family (generative foreground
// materials that INTERACT via the derive-time sibling query, core/derive.js).
import { SKY_MATERIAL } from "./sky_shader.js";
import { SKY_SUN_MATERIAL } from "./sky_sun_shader.js";
import { SKY_MOON_MATERIAL } from "./sky_moon_shader.js";
import { SKY_CLOUDS_MATERIAL } from "./sky_clouds_shader.js";
import { LENS_FLARE_MATERIAL } from "./lens_flare_shader.js";
import { getStrokeMaterial, hasStrokeMaterial, strokeMaterialIds } from "./stroke_materials.js"; // the STROKE-material framework's registry (arc-length gradients, width profiles, dashes, wavy)
import { COMIC_MATERIAL } from "./comic_shader.js"; // comic-book Ben-Day halftone (CMYK/RGB/duotone/mono dots)
import { GLITCH_MATERIAL } from "./glitch_shader.js"; // animated sci-fi datamosh / broken-signal glitch
import { MANDELBROT_MATERIAL } from "./mandelbrot_shader.js"; // deep-zoom Mandelbrot (perturbation + rebasing, orbit-average colouring)
import { BRIGHTNESS_CONTRAST_MATERIAL } from "./brightness_contrast_shader.js"; // tone adjustment (non-clipping logistic-gain contrast / linear-light exposure / naive sRGB)

/**
 * The MAGNIFY material — magnification, expressed as a member of the material
 * FAMILY. Unlike glass/CRT it carries NO SkSL: a magnifier does not distort the
 * composite-so-far in place, it SAMPLES it with a SCALE about an origin (and, on
 * the crisp path, RE-RENDERS just the minimal lens footprint at magnified zoom) —
 * something no in-place RuntimeEffect can do. It therefore keeps its own IR op
 * (`magnifyBackdrop`) + handler (paint_skia handleMagnifyBackdrop, whose minimal-
 * bbox footprint clamp must not regress). Registering it here is the third
 * material KIND — a SAMPLER — beside BACKDROP-SkSL (glass/CRT) and FOREGROUND-fill
 * (corkboard), so any widget can DISCOVER magnify through the ONE material
 * registry (materialIds) and learn, via isSamplerMaterial, that it dispatches the
 * `op` below rather than an SkSL effect. `sampler:true` keeps it out of the SkSL
 * compile/backdrop paths (isBackdropMaterial → false; materialEffect throws LOUD).
 */
export const MAGNIFY_MATERIAL = { id: "magnify", sampler: true, op: "magnifyBackdrop" };

// id → descriptor. A new material appends ONE import above + ONE entry here.
// A descriptor's `backdrop`/`sampler` flags split the framework in THREE:
//   - BACKDROP material (glass, CRT) — `backdrop` absent/true: its SkSL declares
//     the standard {blurredBackdrop, sharpBackdrop} children; the `materialBackdrop`
//     op + handleMaterialBackdrop re-render the content beneath to feed them.
//   - FOREGROUND material (the corkboard family) — `backdrop: false`: NO children,
//     NO re-render; the `materialFill` op + handleMaterialFill just makeShader+fill.
//   - SAMPLER material (magnify) — `sampler: true`: NO SkSL at all; it names its
//     own IR `op` (magnifyBackdrop) + dedicated handler (it samples/re-scales the
//     composite rather than shading it). Discoverable, but never SkSL-compiled.
// Absence of BOTH flags defaults to backdrop (back-compat: CRT/glass carry none).
const MATERIALS = Object.fromEntries(
  [GLASS_MATERIAL, CRT_MATERIAL, METABALLS_MATERIAL, FROSTED_MATERIAL, CORK_MATERIAL, NOTE_MATERIAL, TACK_MATERIAL, RAYCAST_DITHER_MATERIAL, RAINY_WINDOW_MATERIAL, SKY_MATERIAL, SKY_SUN_MATERIAL, SKY_MOON_MATERIAL, SKY_CLOUDS_MATERIAL, LENS_FLARE_MATERIAL, MAGNIFY_MATERIAL, COMIC_MATERIAL, GLITCH_MATERIAL, MANDELBROT_MATERIAL, BRIGHTNESS_CONTRAST_MATERIAL].map((m) => [m.id, m]),
);

/**
 * Query. Resolves a material id to its descriptor. Throws LOUDLY on an unknown
 * id (a typo must not silently no-op a whole region).
 *
 * @param {string} id
 * @returns {{id: string, sksl: string, pack: Function, uniformFloats: number}}
 *
 * @example getMaterial("crt").id // "crt"
 */
export function getMaterial(id) {
  const m = MATERIALS[id];
  if (!m) throw new Error(`materials.getMaterial: unknown material "${id}" (known: ${Object.keys(MATERIALS).join(", ")})`);
  return m;
}

/** Query. The registered material ids (for tests / discoverability).
 * @example materialIds().includes("crt") // true */
export function materialIds() {
  return Object.keys(MATERIALS);
}

// ── THE FILL-MATERIAL CONTRACT (materials as PAINT on any shape) ──────────────
// A fill paint {type: "material", material: {id, params?}} shades a SHAPE op
// (rect/ellipse/polygon/path) with a registered material: the painter clips to
// the op's own geometry and uses the op's bbox as the material's local frame,
// so a star-shaped CRT is the CRT panel clipped to the star — no shader edits,
// no new IR op (the end-state ruling: "demo widgets are just shapes with
// material; custom properties become material properties").
//
// A material OPTS IN by declaring `fillParams`: its knob SCHEMA, an array of
// rows in the customProps shape ({name, kind, default, min?, max?, step?,
// options?, optionLabels?, help}) — the ONE declaration both the PaintField's
// generic param rows AND the (interim) demo widget's customProps derive from.
// Stored paint params are SPARSE (only written knobs — no state until touched);
// resolveMaterialPaint folds schema defaults + stored + the optional
// `sceneParams(node, nodesById)` hook (sky reads its sibling suns there) into
// `resolvedParams` at scene-build time, so painters stay scene-blind.

/**
 * Pure function. Has this material opted into being a FILL (declared its knob
 * schema)?
 *
 * @param {{fillParams?: Array}} material - a descriptor from getMaterial()
 * @returns {boolean}
 *
 * @example isFillCapableMaterial({id: "x", fillParams: []}) // true
 * @example isFillCapableMaterial({id: "magnify", sampler: true}) // false
 */
export function isFillCapableMaterial(material) {
  return Array.isArray(material.fillParams);
}

/** Query. Every fill-capable material id — the PaintField dropdown's list and
 * the shape-matrix probe's axis, so both grow automatically as materials opt in.
 * @example Array.isArray(fillCapableMaterialIds()) // true */
export function fillCapableMaterialIds() {
  return Object.keys(MATERIALS).filter((id) => isFillCapableMaterial(MATERIALS[id]));
}

/**
 * Pure function. A fill-capable material's complete default knob map, from its
 * fillParams schema.
 *
 * @param {{id: string, fillParams: Array}} material - a fill-capable descriptor
 * @returns {object} {name: default}
 *
 * @example materialFillParamDefaults({id: "x", fillParams: [{name: "gain", kind: "number", default: 2}]}) // {gain: 2}
 */
export function materialFillParamDefaults(material) {
  if (!isFillCapableMaterial(material))
    throw new Error(`materials.materialFillParamDefaults: "${material.id}" declares no fillParams — it is not fill-capable.`);
  return Object.fromEntries(material.fillParams.map((row) => [row.name, row.default]));
}

/**
 * Query. The registry entry a material PAINT names, from EITHER registry — a fill
 * material (this file's MATERIALS) OR a stroke material (stroke_materials.js). The
 * ONE seam that lets resolveMaterialPaint resolve a stroke slot's material the same
 * way it resolves a fill slot's, without ports having to know which it is. The two
 * registries share no ids, so the lookup is unambiguous; an id in neither throws
 * LOUDLY (never a silent gray outline).
 *
 * @param {string} id
 * @returns {object} a fill descriptor or a stroke entry
 *
 * @example materialEntryForPaint("comic").id // "comic"
 * @example materialEntryForPaint("wavy").id // "wavy"
 */
function materialEntryForPaint(id) {
  if (Object.prototype.hasOwnProperty.call(MATERIALS, id)) return MATERIALS[id];
  if (hasStrokeMaterial(id)) return getStrokeMaterial(id);
  throw new Error(`materials.resolveMaterialPaint: unknown material "${id}" (fill: ${Object.keys(MATERIALS).join(", ")}; stroke: ${strokeMaterialIds().join(", ")})`);
}

/**
 * Pure function. A paint material entry's COMPLETE default knob map. Generalizes
 * materialFillParamDefaults to BOTH slots: it reads `strokeParams ?? fillParams`,
 * so a stroke entry resolves against its own schema while a fill entry stays
 * byte-identical (it has no strokeParams). The one place the two frameworks share
 * a resolution path.
 *
 * @param {{id:string, strokeParams?:Array, fillParams?:Array}} entry
 * @returns {object} {name: default}
 *
 * @example materialParamDefaults({id: "x", strokeParams: [{name: "gap", kind: "number", default: 10}]}) // {gap: 10}
 * @example materialParamDefaults({id: "y", fillParams: [{name: "gain", kind: "number", default: 2}]}) // {gain: 2}
 */
function materialParamDefaults(entry) {
  const schema = entry.strokeParams ?? entry.fillParams;
  if (!Array.isArray(schema))
    throw new Error(`materials.materialParamDefaults: "${entry.id}" declares neither strokeParams nor fillParams — it cannot be a paint.`);
  return Object.fromEntries(schema.map((row) => [row.name, row.default]));
}

/**
 * Near-pure function (reports unknown stored knobs once). A material paint with
 * its COMPLETE `resolvedParams`: schema defaults ⊕ the paint's sparse stored
 * params ⊕ the material's optional scene hook. Unknown stored keys (a renamed
 * knob, a stale doc) are DROPPED with a loud report — never silently obeyed,
 * never a brick. Called once per op at scene-build time
 * (render_gpu/ports.js); painters REQUIRE the result.
 *
 * @param {object} paint - {type: "material", material: {id, params?}}
 * @param {object|null} node - the emitting render node (scene hooks read it)
 * @param {Map|object|null} nodesById - derived nodes by id (scene hooks read siblings)
 * @param {Function} report - reportOnce-shaped sink for the unknown-knob report
 * @returns {object} the same paint plus resolvedParams
 *
 * @example resolveMaterialPaint({type: "material", material: {id: "comic", params: {}}}, null, null, () => {}).resolvedParams.mode // "cmyk"
 */
export function resolveMaterialPaint(paint, node, nodesById, report) {
  const m = materialEntryForPaint(paint.material?.id);
  const defaults = materialParamDefaults(m);
  const stored = paint.material.params ?? {};
  const known = {};
  for (const [k, v] of Object.entries(stored)) {
    if (k in defaults) known[k] = v;
    else report(`material-fill:unknown-knob:${m.id}:${k}`,
      `PowerRP materials: fill paint stores unknown "${m.id}" knob "${k}" — dropped (schema: ${Object.keys(defaults).join(", ")}).`);
  }
  const scene = m.sceneParams ? m.sceneParams(node, nodesById) : {};
  return { ...paint, resolvedParams: { ...defaults, ...known, ...scene } };
}

/**
 * Pure function. Is `material` a BACKDROP material (samples the composite-so-far
 * via children) rather than a FOREGROUND fill? Absence of the flag defaults to
 * true (CRT/glass predate the flag). The two handlers use this to fail LOUDLY if
 * an op names a material of the wrong half (a `materialFill` naming CRT, say).
 *
 * @param {{backdrop?: boolean, sampler?: boolean}} material - a descriptor from getMaterial()
 * @returns {boolean}
 *
 * @example isBackdropMaterial({id: "crt"}) // true (no flag => backdrop)
 * @example isBackdropMaterial({id: "corkboard", backdrop: false}) // false
 * @example isBackdropMaterial({id: "magnify", sampler: true}) // false (a sampler, not an SkSL backdrop)
 */
export function isBackdropMaterial(material) {
  return material.backdrop !== false && !material.sampler;
}

/**
 * Query. A BACKDROP material's MAXIMUM OUTWARD backdrop-sample displacement in
 * DEVICE px — how far OUTSIDE its own panel the shader reads — or null when the
 * material does not declare one.
 *
 * WHY IT EXISTS. handleMaterialBackdrop feeds its shader from a re-render of the
 * content beneath, and until a material could answer this question that re-render
 * (and its Gaussian blur) covered the WHOLE surface, because clipping the backdrop
 * to a region SMALLER than the shader reads makes the sampler clamp at the region
 * edge and visibly wrecks the material. Measured on a 240×160 panel over a 960×540
 * frame: two full-surface offscreens (1,036,800 px) for a panel whose own footprint
 * is 38,400 px. `glassBackdrop` never paid that — it has always known its own reach
 * (glass_shader.maxGlassDisplacement) and so bounds its region (glassRegion).
 * This is that same knowledge, generalized to the registry.
 *
 * NULL MEANS "REACH NOT DECLARED", AND KEEPS TODAY'S BEHAVIOR. Absence is the safe
 * answer, not an error: the caller renders the whole surface exactly as before, so
 * a material whose reach nobody has derived yet is slow but never wrong, and a
 * material that genuinely samples without bound (a hypothetical whole-canvas
 * environment sampler) has an honest way to say so. This is deliberately the
 * OPPOSITE polarity to `usesBlurredBackdrop`, where absence means "build it":
 * there, absence must keep the expensive-but-correct texture; here, absence must
 * keep the expensive-but-correct region. Both default to correctness.
 *
 * The declared hook is `maxSampleReach(u) → device px`, taking the SAME normalized
 * `u` the material's `pack` receives (device geometry + `scale` + the material's
 * own knobs), so a reach is derived from exactly the uniforms that drive the
 * displacement. It must be an OVER-estimate, never an under-estimate; the Gaussian
 * blur support and the coverage-AA slop are added by the caller, not here.
 *
 * ── DECLARING A REACH IS NOT PIXEL-EXACT, AND THE REASON IS NOT THE REACH ─────
 * A region-bounded backdrop re-renders the content beneath into a SMALLER surface
 * at an integer device offset, and Skia's rasterization is not invariant under that
 * change: rendering the identical scene into 640×360 and into 200×200 at (+220,+85)
 * differs by 419 of 160,000 bytes in the overlap, max delta 52, ALL of it on a
 * circle's antialiased rim (measured directly, with no material and no shader in the
 * picture — .frenzy/render_cost/probe_rerender_shift.js). Skia picks its
 * antialiasing scan converter partly from the clip extent, so a curved edge's
 * coverage can land a level or two differently. This is a property of the region
 * optimization itself, which `glassBackdrop` has always used, not of this protocol.
 *
 * What that costs depends entirely on HOW A MATERIAL USES THE SAMPLE, so the choice
 * to declare is per-material and empirical, not automatic:
 *   · A material that shades the sample (crt, frosted) passes the wobble through at
 *     roughly its own size: measured ≤ 2 levels on ≤ 0.003% of a 640×360 frame,
 *     against 3.1-3.9x fewer offscreen pixels. Declared.
 *   · A material that DIVIDES BY THE SAMPLED ALPHA amplifies it enormously. The
 *     brightness_contrast tone curve un-premultiplies (rgb / a) before grading, and
 *     a one-level alpha wobble on a near-black rim pixel becomes up to 82 levels of
 *     colour: measured 148-238 differing bytes at max delta 82. Its true reach is
 *     zero and declaring it would be honest, yet it deliberately does NOT — see the
 *     note on BRIGHTNESS_CONTRAST_MATERIAL. Fixing the seam (a rasterization-stable
 *     region re-render) is what unblocks that one, not a bigger reach.
 *
 * @param {{id: string, maxSampleReach?: Function}} material - a descriptor from getMaterial()
 * @param {object} u - the normalized uniform input handleMaterialBackdrop builds
 * @returns {number|null} device-px outward reach, or null when undeclared
 *
 * @example materialSampleReach({id: "x"}, {halfW: 100, halfH: 80}) // null (undeclared ⇒ whole surface)
 * @example materialSampleReach({id: "frosted", maxSampleReach: () => 0}, {}) // 0 (samples straight down, no displacement)
 * @example materialSampleReach({id: "y", maxSampleReach: (u) => u.halfW * 0.1}, {halfW: 100}) // 10
 */
export function materialSampleReach(material, u) {
  if (typeof material.maxSampleReach !== "function") return null;
  const reach = material.maxSampleReach(u);
  if (!Number.isFinite(reach) || reach < 0)
    throw new Error(`materials: maxSampleReach for "${material.id}" must return a finite non-negative device-px reach, got ${reach}`);
  return reach;
}

/**
 * Pure function. Is `material` a SAMPLER material (magnify) — one that carries NO
 * SkSL and instead names its own IR `op`, sampling/re-scaling the composite rather
 * than shading it? These are registered for DISCOVERABILITY but must never reach
 * the SkSL compile path (materialEffect throws on them).
 *
 * @param {{sampler?: boolean}} material - a descriptor from getMaterial()
 * @returns {boolean}
 *
 * @example isSamplerMaterial({id: "magnify", sampler: true}) // true
 * @example isSamplerMaterial({id: "crt"}) // false
 */
export function isSamplerMaterial(material) {
  return material.sampler === true;
}

// ── PROXY-quality stand-ins (thumbnail / minimap) ─────────────────────────────
// A FOREGROUND material (materialFill op) synthesizes its whole look with per-pixel
// SkSL and NO backdrop machinery — so unlike backdrop samplers it allocates no
// offscreen surface, but running the shader over a whole thumbnail is still real CPU
// cost (measured: lens_flare ≈ 1.3s, sky ≈ 1.1s, skyClouds ≈ 3s per 256×144
// software-surface thumbnail; corkboard/raycast lighter but non-trivial). At proxy
// quality EVERY materialFill is replaced by a CHEAP Skia stand-in (solid / linear /
// radial gradient — NO SkSL). This is UNIVERSAL, not an allowlist: a material MAY
// declare a nice `proxyFill(params, region)` beside its SkSL; one that declares NONE
// gets defaultProxyFill (a representative flat colour), so a future materialFill can
// NEVER silently blow up thumbnails again (the class of bug that let lens flare slip
// through). FULL quality is untouched.
export const PROXY_FILL_KINDS = new Set(["solid", "linear", "radial"]);

const DEFAULT_PROXY_NEUTRAL = [0.5, 0.5, 0.5]; // mid-grey when a material exposes no param colour to average
const DEFAULT_PROXY_ALPHA = 1;                 // opaque flat fill (a foreground material occupies its region)
const COLOR_PARAM_RE = /^(#|rgba?\()/i;        // param string values parseColor accepts (skip "screen", numbers, arrays…)

/**
 * Pure function. The mean RGB of all COLOUR-string values in a flat `params` map
 * (values matching #hex / rgb() — everything else, incl. numbers/arrays/objects, is
 * ignored). Returns null when `params` carries no colour, so the caller can fall
 * back to a neutral tone. This is the generic "dominant colour" a material with no
 * hand-tuned proxyFill is stood in with.
 *
 * @param {object} params - a material's flat op params
 * @returns {[number, number, number]|null} mean [r,g,b] in 0..1, or null
 *
 * @example meanParamColor({baseColor: "#000000", frameColor: "#ffffff", grain: 0.2}) // [0.5, 0.5, 0.5]
 * @example meanParamColor({speed: 1, blendMode: "screen"}) // null
 */
export function meanParamColor(params) {
  const acc = [0, 0, 0];
  let n = 0;
  for (const v of Object.values(params ?? {})) {
    if (typeof v === "string" && COLOR_PARAM_RE.test(v)) {
      const c = parseColor(v);
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n++;
    }
  }
  return n === 0 ? null : [acc[0] / n, acc[1] / n, acc[2] / n];
}

/**
 * Pure function. The DEFAULT proxy stand-in for a materialFill that declares no
 * `proxyFill`: a solid flat fill of its mean param colour (or a neutral mid-grey if
 * none), opaque, so the region reads as "a material is here" at thumbnail size — no
 * SkSL. This is the future-proofing floor: a brand-new material is covered the moment
 * it is registered, even before anyone tunes a nicer stand-in.
 *
 * @param {object} params - the material's flat op params
 * @returns {{kind: "solid", color: [number, number, number, number]}}
 *
 * @example defaultProxyFill({baseColor: "#be8f56"}).kind // "solid"
 * @example defaultProxyFill({}).color // [0.5, 0.5, 0.5, 1] (neutral, no param colour)
 */
export function defaultProxyFill(params) {
  const c = meanParamColor(params) ?? DEFAULT_PROXY_NEUTRAL;
  return { kind: "solid", color: [c[0], c[1], c[2], DEFAULT_PROXY_ALPHA] };
}

/**
 * Query. Resolves the proxy stand-in spec for a FOREGROUND `material` at the given
 * params + local-space region: the material's own `proxyFill(params, region)` if it
 * declares one, else defaultProxyFill(params). Validates the spec's `kind` LOUDLY
 * (a bad builder must fail, not silently draw nothing). The single seam the
 * paint_skia.js proxy branch and the future-proofing guard test both go through.
 *
 * @param {{id: string, proxyFill?: Function}} material - a descriptor from getMaterial()
 * @param {object} params - the material's flat op params
 * @param {{cx:number, cy:number, halfW:number, halfH:number}} region - local-space geometry
 * @returns {{kind: string}} a proxy-fill spec (kind ∈ PROXY_FILL_KINDS)
 *
 * @example resolveProxyFill({id: "x"}, {baseColor: "#be8f56"}, {cx: 0, cy: 0, halfW: 10, halfH: 10}).kind // "solid" (default)
 * @example resolveProxyFill({id: "y", proxyFill: () => ({kind: "radial", cx: 0, cy: 0, radius: 5, stops: []})}, {}, {}).kind // "radial"
 */
export function resolveProxyFill(material, params, region) {
  const spec = typeof material.proxyFill === "function" ? material.proxyFill(params, region) : defaultProxyFill(params);
  if (!spec || !PROXY_FILL_KINDS.has(spec.kind))
    throw new Error(`materials: proxyFill for "${material.id}" returned an invalid spec (kind must be one of ${[...PROXY_FILL_KINDS].join(", ")}), got ${JSON.stringify(spec)}`);
  return spec;
}

// ── the BACKDROP half of the same idea ────────────────────────────────────────
// A BACKDROP material (materialBackdrop op) is stood in with a translucent OVERLAY
// drawn over the already-composited content, not a fill of its own region — that is
// the whole difference: the content beneath IS most of the answer, and the overlay
// only has to say what the material DOES to it.
//
// THE DEFECT THIS HOOK FIXES. Every backdrop material shared ONE hard-coded stand-in,
// a faint translucent WHITE, which says "a frosted panel is here". That is right for
// glass and harmless for CRT, and BACKWARDS for a material that DARKENS: a
// brightness_contrast widget configured to dim showed up LIGHTER in its own thumbnail
// and minimap. The foreground half had solved exactly this a while ago — a material
// MAY declare `proxyFill` and get a stand-in that looks like itself — so this is that
// same seam, mirrored, and the shared frost becomes the DEFAULT rather than the only
// option (an undeclared backdrop material is still covered, as before).
//
// SPEC SHAPE, and why it is not proxyFill's. proxyFill returns a solid/linear/radial
// FILL spec because a foreground material paints its whole region. A backdrop stand-in
// must stay ONE drawRRect over the composite — that cheapness is the entire point of
// the proxy path (zero offscreen surfaces, no SkSL compile, no per-pixel pass) — so the
// hook returns just the overlay colour. A gradient would buy a second shader
// allocation for no perceptible gain at 256x144.
export const DEFAULT_PROXY_BACKDROP_ALPHA = 0.14;
/**
 * The stand-in overlay for a backdrop panel with no colour of its own: faint
 * translucent white, so the region still reads as a PANEL rather than a hole over the
 * composited content beneath. Also the untinted-glass fallback in
 * paint_skia.drawProxyBackdrop — one constant, one meaning.
 */
export const DEFAULT_PROXY_BACKDROP_TINT = [1, 1, 1, DEFAULT_PROXY_BACKDROP_ALPHA];

/**
 * Query. Resolves the proxy OVERLAY tint for a BACKDROP `material` at the given
 * params: the material's own `proxyBackdrop(params)` if it declares one, else
 * DEFAULT_PROXY_BACKDROP_TINT. The exact mirror of resolveProxyFill, including the
 * LOUD validation — a stand-in that returned nonsense would silently paint a wrong
 * colour over every thumbnail, which is the class of bug this hook exists to end.
 *
 * A returned alpha of 0 is LEGAL and means "draw no overlay at all": for some
 * materials the honest stand-in is the untouched content beneath (the blurBackdrop
 * precedent, which already draws nothing).
 *
 * @param {{id: string, proxyBackdrop?: Function}} material - a descriptor from getMaterial()
 * @param {object} params - the material's flat op params
 * @returns {[number, number, number, number]} an [r,g,b,a] overlay tint, channels 0..1
 *
 * @example resolveProxyBackdrop({id: "crt"}, {}) // [1, 1, 1, 0.14] (the shared frost default)
 * @example resolveProxyBackdrop({id: "x", proxyBackdrop: () => ({tint: [0, 0, 0, 0.33]})}, {}) // [0, 0, 0, 0.33]
 * @example resolveProxyBackdrop({id: "y", proxyBackdrop: () => ({tint: [1, 1, 1, 0]})}, {}) // [1, 1, 1, 0] (legal: no overlay)
 */
export function resolveProxyBackdrop(material, params) {
  if (typeof material.proxyBackdrop !== "function") return DEFAULT_PROXY_BACKDROP_TINT;
  const spec = material.proxyBackdrop(params);
  const tint = spec?.tint;
  if (!Array.isArray(tint) || tint.length !== 4 || tint.some((c) => !Number.isFinite(c) || c < 0 || c > 1))
    throw new Error(`materials: proxyBackdrop for "${material.id}" must return {tint: [r,g,b,a]} with four finite channels in 0..1, got ${JSON.stringify(spec)}`);
  return tint;
}

// Compiled RuntimeEffect cache, keyed by material id + guarded by the CanvasKit
// instance it was compiled against (mirrors glass_shader's glassEffect memo — the
// SAME compile-once technique, generalized to N materials).
const _effects = new Map(); // id → { effect, ck }

/**
 * Query→build (compiles once per material per CanvasKit instance; memoized).
 * Returns the compiled RuntimeEffect for `material`. Throws LOUDLY with the SkSL
 * compiler error on failure (no silent fallback) — a shader that will not compile
 * is a hard bug, exactly like glassEffect.
 *
 * @param CanvasKit - the initialized CanvasKit module
 * @param material - a descriptor from getMaterial()
 */
export function materialEffect(CanvasKit, material) {
  if (isSamplerMaterial(material))
    throw new Error(`materials: "${material.id}" is a SAMPLER material (no SkSL) — dispatch its op "${material.op}", do not compile it as an effect`);
  const cached = _effects.get(material.id);
  if (cached && cached.ck === CanvasKit) return cached.effect;
  let err = null;
  const eff = CanvasKit.RuntimeEffect.Make(material.sksl, (e) => { err = e; });
  if (!eff) throw new Error(`materials: "${material.id}" SkSL failed to compile:\n${err}`);
  _effects.set(material.id, { effect: eff, ck: CanvasKit });
  return eff;
}

/**
 * Pure function. Does this material declare a SHAPE-CONFORMING FILL variant — a
 * `fillSksl` that samples the silhouette SDF child (render_gpu/skia/shape_sdf.js) so
 * its edge effects follow the real outline instead of the analytic bbox rectangle?
 * Absence keeps the fill on the base `sksl` (byte-identical to before), so a material
 * is conforming ONLY when it opts in with both flags.
 *
 * @param {{usesShapeSdf?: boolean, fillSksl?: string}} material - a descriptor from getMaterial()
 * @returns {boolean}
 *
 * @example materialUsesShapeSdf({id: "glass", usesShapeSdf: true, fillSksl: "..."}) // true
 * @example materialUsesShapeSdf({id: "frosted"}) // false (homogeneous fill — nothing to conform)
 */
export function materialUsesShapeSdf(material) {
  return material.usesShapeSdf === true && typeof material.fillSksl === "string";
}

// The conforming-fill variant effects, keyed id + ":fill" (a shape-conforming fill
// compiles a DIFFERENT shader than the widget/base path — it declares the extra
// `shapeSdf` child — so it caches under its own key, the base `_effects` map untouched).
const _fillEffects = new Map(); // id → { effect, ck }

/**
 * Query→build (compiles once per material per CanvasKit instance; memoized). The
 * compiled RuntimeEffect for a material's SHAPE-CONFORMING FILL variant (`fillSksl`).
 * Throws LOUDLY with the SkSL compiler error on failure — never a silent fallback to
 * the analytic path (the caller decides that visibly). Only call when
 * materialUsesShapeSdf(material).
 *
 * @param CanvasKit - the initialized CanvasKit module
 * @param material - a descriptor from getMaterial() declaring `fillSksl`
 */
export function materialFillEffect(CanvasKit, material) {
  if (!materialUsesShapeSdf(material))
    throw new Error(`materials: "${material.id}" declares no shape-conforming fillSksl — materialFillEffect must not be called for it`);
  const cached = _fillEffects.get(material.id);
  if (cached && cached.ck === CanvasKit) return cached.effect;
  let err = null;
  const eff = CanvasKit.RuntimeEffect.Make(material.fillSksl, (e) => { err = e; });
  if (!eff) throw new Error(`materials: "${material.id}" fillSksl failed to compile:\n${err}`);
  _fillEffects.set(material.id, { effect: eff, ck: CanvasKit });
  return eff;
}
