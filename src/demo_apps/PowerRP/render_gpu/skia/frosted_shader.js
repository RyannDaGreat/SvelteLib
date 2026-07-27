/**
 * The FROSTED GLASS SkSL material — a BASIC frosted-blur panel on the reusable
 * MATERIAL FRAMEWORK (render_gpu/skia/materials.js). Deliberately the PLAIN
 * cousin of Liquid Glass (glass_shader.js): it is a stripped SUBSET of that
 * shader — the blurred-backdrop view veiled by a translucent frost tint, with
 * NONE of the liquid-glass character (no refraction / edge distortion, no
 * specular / sheen / rim light, no chromatic aberration, no luminance-adaptive
 * tint). Just clean rounded-rect "backdrop blur + subtle frost", like a plain
 * iOS/macOS frosted material card.
 *
 * It is REAL SkSL (compiles through CanvasKit.RuntimeEffect.Make; the framework
 * compiles + caches it once per CanvasKit instance, exactly like glass_shader.js
 * / crt_shader.js). Its two children are the framework's STANDARD backdrop
 * contract — a BLURRED and a SHARP device-space image shader of everything below
 * in z-order, in THIS order:
 *   blurredBackdrop — the frosted view seen THROUGH the panel (the whole effect)
 *   sharpBackdrop   — declared to satisfy the fixed {blurred, sharp} child pair
 *                     handleMaterialBackdrop always binds; a plain frost does not
 *                     read it (no refraction), so it is intentionally unused.
 *
 * Pipeline, per output pixel `p` (DEVICE px), given the region (center / half-
 * size / corner / angle) and the blurred child:
 *   1. rotate p into the panel's LOCAL frame; rounded-rect SDF -> antialiased
 *      coverage (outside the panel => contribute nothing).
 *   2. sample the BLURRED backdrop STRAIGHT at p (no displacement — the absence
 *      of the outward-normal refraction is exactly what makes this "basic").
 *   3. veil it with a flat translucent tint: mix(view, tint, frost). frost 0 =
 *      clear blur, 1 = an opaque tinted panel; a subtle value is the frost.
 * The optional bright hairline border is the op's stroke (drawn by the shared
 * handleMaterialBackdrop border helper), NOT the shader — same as CRT / glass.
 *
 * DOM-free at import (only string SkSL + a pure packer), like glass_shader.js /
 * crt_shader.js / raycast_dither_shader.js. `parseColor` (render_gpu/ir.js) is
 * the shared node-safe colour parser the packer reuses.
 */

import { parseColor } from "../ir.js";

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
export const FROSTED_SKSL = `
const float AA_PX = 1.0;   // coverage antialias half-width (~1 device px), matching glass/CRT

uniform shader blurredBackdrop;  // child 0: Gaussian-blurred composite-so-far (device space) — the frosted view through the panel
uniform shader sharpBackdrop;    // child 1: the un-blurred composite-so-far (device space); UNUSED — declared only to satisfy the framework's fixed {blurred, sharp} child pair (a plain frost has no refraction that would read it)
uniform float2 uCenter;          // region center (device px)
uniform float2 uHalfSize;        // region half-extents (device px)
uniform float uCornerRadius;     // rounded-rect corner radius (device px)
uniform float uAngle;            // panel rotation (radians): rotate the SDF frame so a rotated panel stays correct
// ── user-tweakable knobs (self.* custom props) ───────────────────────────────
uniform float uFrost;            // 0..1 frost/tint opacity: how much the translucent tint veils the blurred view (0 = clear blur, 1 = opaque tint)
uniform float3 uTint;            // the frost tint COLOUR (rgb); its STRENGTH is uFrost. A plain flat tint — no luminance adaptivity, unlike Liquid Glass

// Pure. Signed distance to a rounded rect (local, centered). <0 inside.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

half4 main(float2 p) {
  // Rotate the device pixel into the panel's LOCAL centered frame (uAngle == 0
  // is the axis-aligned common case). cos/sin of the widget rotation.
  float ca = cos(uAngle), sa = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y);
  float r = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y)); // capsule-safe clamp

  float d = sdRoundRect(pl, uHalfSize, r);
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, d);
  if (cov <= 0.0) { return half4(0.0); }          // outside the panel: contribute nothing

  // Sample the BLURRED backdrop STRAIGHT at p — no outward-normal displacement,
  // so there is NO glass refraction / edge bend (the whole point of the basic
  // frost) — then veil it with a flat translucent tint. mix(view, tint, frost):
  // frost 0 = a clear blur, frost 1 = a solid tinted panel.
  half3 view = blurredBackdrop.eval(p).rgb;
  half3 frosted = mix(view, half3(uTint), half(clamp(uFrost, 0.0, 1.0)));
  return half4(frosted * half(cov), half(cov));    // premultiplied by coverage
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
const FROSTED_UNIFORM_FLOATS = 10;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens the whole
 * region — fail loudly instead). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packFrostedUniforms: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Pure. A colour knob (string / rgba array / paint) -> its rgb triple [r, g, b],
 * via the shared node-safe parseColor. Alpha is dropped — the tint's STRENGTH is
 * the separate uFrost knob, not the colour's own alpha. */
function rgb(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])];
}

/**
 * Pure function. Packs the Frosted Glass material's uniforms into the flat
 * Float32Array CanvasKit expects (SkSL declaration order, tight-packed: float2 =
 * 2 slots, float3 = 3). `u` is the material framework's normalized input:
 * DEVICE-px region geometry {cx, cy, halfW, halfH, cornerRadius, angle} (the
 * framework resolves world -> device before calling) + this material's own
 * already-evaluated knobs (the op's `params`, spread in by name). `frost` is
 * 0..1; `tint` is a colour the packer parses here. The two child shaders are
 * passed separately to makeShaderWithChildren.
 *
 * @param {object} u - {cx, cy, halfW, halfH, cornerRadius, angle, frost, tint}
 *   (device geometry + the material knobs; `scale` is present but unused — a plain
 *   frost exposes no world-unit shader knob)
 * @returns {Float32Array} length 10, in shader-uniform order
 *
 * @example
 * packFrostedUniforms({cx:200,cy:150,halfW:210,halfH:140,cornerRadius:32,angle:0,
 *   frost:0.2,tint:"#ffffff"}).length // 10
 * @example
 * packFrostedUniforms({cx:0,cy:0,halfW:80,halfH:60,cornerRadius:20,angle:0,
 *   frost:0.2,tint:[1,1,1,1]})[9] // 1  (tint blue channel)
 */
export function packFrostedUniforms(u) {
  const tint = rgb("tint", u.tint);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("frost", u.frost),
    tint[0], tint[1], tint[2]
  ]);
  if (out.length !== FROSTED_UNIFORM_FLOATS)
    throw new Error(`packFrostedUniforms: packed ${out.length} floats, expected ${FROSTED_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE FROSTED GLASS MATERIAL DESCRIPTOR — the registry entry
 * (render_gpu/skia/materials.js). A BACKDROP material (no `backdrop`/`sampler`
 * flag => defaults to backdrop): its SkSL declares the standard {blurredBackdrop,
 * sharpBackdrop} children, so the `materialBackdrop` op + handleMaterialBackdrop
 * re-render the content beneath to feed them. `id` matches the plugin's
 * `material` op field; `pack` maps the framework's normalized `u` to the uniform
 * Float32Array.
 */
export const FROSTED_MATERIAL = {
  id: "frosted",
  sksl: FROSTED_SKSL,
  pack: packFrostedUniforms,
  uniformFloats: FROSTED_UNIFORM_FLOATS,
  // ZERO outward reach — the DEFINING property of the basic frost, not a tuning
  // choice: `main` evaluates `blurredBackdrop.eval(p)` at the fragment's own device
  // coordinate and nowhere else (see the SkSL comment "Sample the BLURRED backdrop
  // STRAIGHT at p — no outward-normal displacement"), which is exactly what
  // distinguishes it from glass. So the backdrop only has to cover the panel
  // itself, and the framework adds the Gaussian support for the blurred child.
  // Declaring it lets handleMaterialBackdrop bound the region instead of
  // re-rendering + blurring the whole surface (materials.materialSampleReach).
  maxSampleReach: () => 0,
};
