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

import { CRT_MATERIAL } from "./crt_shader.js";
import { CORK_MATERIAL, NOTE_MATERIAL, TACK_MATERIAL } from "./corkboard_shader.js";
import { RAYCAST_DITHER_MATERIAL } from "./raycast_dither_shader.js";
import { RAINY_WINDOW_MATERIAL } from "./rainy_window_shader.js";

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
  [CRT_MATERIAL, CORK_MATERIAL, NOTE_MATERIAL, TACK_MATERIAL, RAYCAST_DITHER_MATERIAL, RAINY_WINDOW_MATERIAL, MAGNIFY_MATERIAL].map((m) => [m.id, m]),
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
