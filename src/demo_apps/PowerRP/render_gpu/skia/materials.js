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
import { COMIC_MATERIAL } from "./comic_shader.js"; // comic-book Ben-Day halftone (CMYK/RGB/duotone/mono dots)

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
  [CRT_MATERIAL, METABALLS_MATERIAL, FROSTED_MATERIAL, CORK_MATERIAL, NOTE_MATERIAL, TACK_MATERIAL, RAYCAST_DITHER_MATERIAL, RAINY_WINDOW_MATERIAL, SKY_MATERIAL, SKY_SUN_MATERIAL, SKY_MOON_MATERIAL, SKY_CLOUDS_MATERIAL, LENS_FLARE_MATERIAL, MAGNIFY_MATERIAL, COMIC_MATERIAL].map((m) => [m.id, m]),
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
