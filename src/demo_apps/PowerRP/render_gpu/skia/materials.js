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

// id → descriptor. A new material appends ONE import above + ONE entry here.
const MATERIALS = Object.fromEntries([CRT_MATERIAL].map((m) => [m.id, m]));

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
  const cached = _effects.get(material.id);
  if (cached && cached.ck === CanvasKit) return cached.effect;
  let err = null;
  const eff = CanvasKit.RuntimeEffect.Make(material.sksl, (e) => { err = e; });
  if (!eff) throw new Error(`materials: "${material.id}" SkSL failed to compile:\n${err}`);
  _effects.set(material.id, { effect: eff, ck: CanvasKit });
  return eff;
}
