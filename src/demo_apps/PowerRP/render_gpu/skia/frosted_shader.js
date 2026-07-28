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
 *   3. apply the tint through its TWO mechanisms, which is what makes the whole
 *      preset library possible from one colour knob:
 *        ABSORB — transmission. view · mix(white, tint, absorb): body-tinted glass
 *          SUBTRACTS, so black stays black and only lit areas take the hue.
 *        FROST  — scattering. mix(transmitted, tint, frost): surface frost ADDS,
 *          lifting every pixel toward the tint, which is what looks milky.
 *      frost 0 + absorb 0 = a clear blur; frost 1 = an opaque tinted panel.
 * The optional bright hairline border is the op's stroke (drawn by the shared
 * handleMaterialBackdrop border helper), NOT the shader — same as CRT / glass.
 *
 * ABSORB WAS ADDED FOR THE PRESET LIBRARY, GATED SO 0 CHANGES NOTHING. The veil
 * alone can only ADD light, so "green glass" over a dark backdrop came out as a
 * BRIGHT green film rather than a dark green pane — a coloured gel, not glass. At
 * absorb 0 the transmission spectrum is exactly white and the shader is the
 * expression this material shipped with; that was verified by rendering eight
 * parameter sets before and after the change and comparing the raster BYTES (9 of 9
 * buffers identical, including the panel-free backdrop). It also carries its own
 * standing guard — tests/frosted_presets_test.js renders frost 0 / absorb 0 with a
 * saturated tint and with white and requires the two to be byte-identical, so the
 * tint can never leak back in through an ungated term.
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
uniform float3 uTint;            // the tint COLOUR (rgb), shared by BOTH tint mechanisms below; its strengths are uFrost and uAbsorb. A plain flat tint — no luminance adaptivity, unlike Liquid Glass
uniform float uAbsorb;           // 0..1 how much the tint also acts as TRANSMISSION (multiplicative absorption) rather than only as the additive frost veil. 0 = transmission is white, i.e. exactly the veil-only shader this material shipped with

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
  // frost). Then the tint acts through TWO independent mechanisms, in the physical
  // order light meets them:
  //   1. TRANSMISSION (absorption). Body-tinted glass SUBTRACTS: what comes through
  //      is the backdrop times the pane's transmission spectrum, so black stays
  //      black and only what is already lit takes the hue. mix(white, tint, absorb)
  //      is that spectrum, so absorb 0 leaves it WHITE and multiplies by exactly 1.
  //   2. SCATTERING (the frost veil). Surface frost ADDS: mix toward the tint lifts
  //      every pixel, black included, which is what makes a panel look milky.
  // frost 0 + absorb 0 = a clear blur; frost 1 = a solid tinted panel.
  half3 view = blurredBackdrop.eval(p).rgb;
  half3 transmitted = view * mix(half3(1.0), half3(uTint), half(clamp(uAbsorb, 0.0, 1.0)));
  half3 frosted = mix(transmitted, half3(uTint), half(clamp(uFrost, 0.0, 1.0)));
  return half4(frosted * half(cov), half(cov));    // premultiplied by coverage
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
const FROSTED_UNIFORM_FLOATS = 11;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens the whole
 * region — fail loudly instead). Returns `v`. Shared by the packer AND the proxy
 * stand-in, so both reject the same bad knob with the same message.
 * @example num("frost", 0.2) // 0.2 */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`frosted material: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Pure. A colour knob (string / rgba array / paint) -> its rgb triple [r, g, b],
 * via the shared node-safe parseColor. Alpha is dropped — the tint's STRENGTH is
 * the separate uFrost / uAbsorb knobs, not the colour's own alpha.
 * @example rgb("tint", "rgb(255,0,0)") // [1, 0, 0] */
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
 * @param {object} u - {cx, cy, halfW, halfH, cornerRadius, angle, frost, tint, absorb}
 *   (device geometry + the material knobs; `scale` is present but unused — a plain
 *   frost exposes no world-unit shader knob)
 * @returns {Float32Array} length 11, in shader-uniform order
 *
 * @example
 * packFrostedUniforms({cx:200,cy:150,halfW:210,halfH:140,cornerRadius:32,angle:0,
 *   frost:0.2,tint:"#ffffff",absorb:0}).length // 11
 * @example
 * packFrostedUniforms({cx:0,cy:0,halfW:80,halfH:60,cornerRadius:20,angle:0,
 *   frost:0.2,tint:[1,1,1,1],absorb:0})[9] // 1  (tint blue channel)
 * @example
 * packFrostedUniforms({cx:0,cy:0,halfW:80,halfH:60,cornerRadius:20,angle:0,
 *   frost:0.35,tint:"#2f6b3a",absorb:0.8})[10] // 0.800000011920929  (absorb)
 */
export function packFrostedUniforms(u) {
  const tint = rgb("tint", u.tint);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("frost", u.frost),
    tint[0], tint[1], tint[2],
    num("absorb", u.absorb)
  ]);
  if (out.length !== FROSTED_UNIFORM_FLOATS)
    throw new Error(`packFrostedUniforms: packed ${out.length} floats, expected ${FROSTED_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

// The flat backdrop the PROXY overlay is FITTED AT. One source-over overlay cannot
// reproduce a MULTIPLY at every input level — that is the whole compromise of the
// proxy path — so it is fitted at a single level, and mid-grey is the level the
// neighbouring brightness_contrast stand-in is fitted at too ("measured over flat
// mid-grey"). One convention, one number.
const PROXY_REFERENCE_GREY = 0.5;

/** Pure. Knob `name`'s value clamped to 0..1 — the same clamp the SkSL applies to
 * uFrost / uAbsorb, so the stand-in and the real shader agree on an out-of-range knob.
 * Non-finite is a LOUD throw naming the knob, via the shared `num`.
 * @example clamp01("frost", 0.4) // 0.4
 * @example clamp01("absorb", 1.7) // 1 */
function clamp01(name, v) {
  return Math.min(1, Math.max(0, num(name, v)));
}

/**
 * Pure function. The material's `proxyBackdrop` hook (materials.resolveProxyBackdrop):
 * the ONE translucent overlay rounded-rect that thumbnails and the minimap draw over
 * the already-composited content INSTEAD of running this SkSL per pixel.
 *
 * WHY IT IS DECLARED. The shared default stand-in is a faint translucent WHITE, which
 * LIGHTENS — right for an untinted frost and BACKWARDS for the rest of this material's
 * range. "Smoked Glass" and "Graphite Frost" DARKEN and "Bronze" is warm and dark, so
 * under the shared default each read as a pale panel in its own thumbnail: the same
 * contradiction brightness_contrast declared its hook to end.
 *
 * THE FIT. At a flat backdrop `g` the shader computes `g·T·(1−frost) + tint·frost`,
 * where `T = mix(white, tint, absorb)` is the transmission spectrum. A source-over of
 * (C, a) over `g` gives `g·(1−a) + C·a`. Taking `a` as the fraction of `g` the panel
 * removes on average — `1 − (1−frost)·mean(T)` — and solving for C at
 * g = PROXY_REFERENCE_GREY reproduces the panel's effect on mid-grey exactly, and its
 * DIRECTION (lighter / darker, and toward which hue) everywhere. C is clamped per
 * channel, because the exact solution can leave the unit cube when one channel is
 * absorbed far harder than the average (bronze's blue).
 *
 * `blurRadius` is deliberately DROPPED: a flat overlay cannot express a blur, and the
 * content beneath is already the honest answer for it (the blurBackdrop precedent).
 * `a <= 0` — a clear pane: frost 0 with either absorb 0 or a white tint — returns
 * alpha 0, the documented "draw no overlay at all".
 *
 * NO ABSENT-KNOB FALLBACKS, unlike the neighbouring brightnessContrastProxyBackdrop.
 * The plugin's `emit` writes all three params unconditionally, so a missing one is a
 * bug; packFrostedUniforms already throws on it, and this throwing too keeps the proxy
 * and the full path failing on the same input rather than one of them inventing a look.
 *
 * @param {{frost: number, tint: (string|number[]), absorb: number}} params - the op's flat params
 * @returns {{tint: [number, number, number, number]}} overlay colour, channels 0..1
 *
 * @example
 * frostedProxyBackdrop({frost: 0, tint: "rgb(255,255,255)", absorb: 0})
 * // {tint: [0, 0, 0, 0]}   (a clear pane: no overlay at all)
 * @example
 * frostedProxyBackdrop({frost: 0.2, tint: "rgb(255,255,255)", absorb: 0})
 * // {tint: [1, 1, 1, 0.19999999999999984]}   (the shipped default: white at the frost amount)
 * @example
 * frostedProxyBackdrop({frost: 0.02, tint: "rgb(78,82,96)", absorb: 0.88}).tint[3] > 0.5
 * // true   ("Smoked Glass" reads as a DARK panel, not the pale default stand-in)
 */
export function frostedProxyBackdrop(params) {
  const tint = rgb("tint", params.tint);
  const frost = clamp01("frost", params.frost), absorb = clamp01("absorb", params.absorb);
  const transmit = tint.map((c) => 1 + absorb * (c - 1));
  const survive = (1 - frost) * (transmit[0] + transmit[1] + transmit[2]) / 3;
  const alpha = 1 - survive;
  if (alpha <= 0) return { tint: [0, 0, 0, 0] };
  const g = PROXY_REFERENCE_GREY;
  const overlay = transmit.map((t, i) => Math.min(1, Math.max(0, (g * t * (1 - frost) + tint[i] * frost - g * survive) / alpha)));
  return { tint: [overlay[0], overlay[1], overlay[2], alpha] };
}

/**
 * THE FROSTED KNOB SCHEMA — the ONE declaration of the material's look knobs, in
 * the customProps row shape. Both consumers derive from it (the end-state ruling
 * "custom properties become material properties"):
 *   - plugins/demo/frosted_glass.js spreads it into its customProps (self.* rows);
 *   - the FILL-material UI renders it as the paint's param rows, resolved
 *     sparse-over-defaults by materials.resolveMaterialPaint.
 * `blurRadius` is a WORLD-px length the OP consumes directly (the below-content
 * blur sigma), so it lives in the schema but is READ by the fill router from
 * resolvedParams — toUniformParams does NOT forward it to the shader packer (the
 * SkSL has no blur uniform; the framework builds the blurred child). Geometry
 * knobs (cornerRadius) stay widget-side — a fill's shape IS its geometry.
 */
export const FROSTED_FILL_PARAMS = [
  { name: "blurRadius", kind: "number", default: 12, min: 0, help: "Gaussian blur radius (world px) of the content seen through the panel — the defining frosted-glass blur. Higher = a softer, more obscured backdrop." },
  { name: "frost", kind: "number", default: 0.2, min: 0, max: 1, help: "Frost/tint opacity, from 0 (a clear blur, no veil) to 1 (a solid tinted panel). A subtle value (~0.2) gives the milky frosted-material look while the backdrop still reads through." },
  { name: "tint", kind: "color", default: "rgb(255,255,255)", help: "The tint COLOUR, shared by Frost and Absorb. White is the classic frosted material; a hue makes it coloured glass. Its strength is those two knobs (this colour's own alpha is ignored)." },
  { name: "absorb", kind: "number", default: 0, min: 0, max: 1, help: "How much the tint also ABSORBS, from 0 (off — the frost veil alone) to 1 (the backdrop is multiplied by the tint). Frost ADDS the tint on top of everything, so it lifts blacks and reads as milky surface frost; Absorb SUBTRACTS through the pane, so blacks stay black and only lit areas take the hue — the body-tinted look of green, blue or bronze architectural glass." },
];

/**
 * Pure function. SCHEMA params (FROSTED_FILL_PARAMS names/kinds) → the PACKER's
 * numeric params (packFrostedUniforms's own key names). THE one mapping both
 * consumers share: the demo widget's emit() and the fill-material regionOp
 * synthesis (paint_skia handleMaterialPaintShape reads it as entry.toUniformParams).
 *
 * Unlike comic's mapping there is no unit conversion (no select codes, no
 * degrees→radians): the three shader knobs pass straight through under their own
 * names. `blurRadius` is DROPPED — it is not a shader uniform; the fill router
 * reads it from resolvedParams to size the below-content blur, exactly as the
 * widget's emit reads it into the op's `blurRadius` field.
 *
 * @param {object} p - schema-shaped params (resolved: every knob present)
 * @returns {{frost: number, tint: (string|number[]), absorb: number}} packFrostedUniforms-shaped params
 *
 * @example frostedUniformParams({blurRadius: 12, frost: 0.2, tint: "rgb(255,255,255)", absorb: 0}).frost // 0.2
 * @example frostedUniformParams({blurRadius: 40, frost: 0.45, tint: "rgb(168,212,240)", absorb: 0.3}).absorb // 0.3
 * @example frostedUniformParams({blurRadius: 10, frost: 0.02, tint: "rgb(78,82,96)", absorb: 0.88}).blurRadius // undefined  (op-level, not a shader knob)
 */
export function frostedUniformParams(p) {
  return {
    frost: p.frost,
    tint: p.tint,
    absorb: p.absorb,
  };
}

/**
 * THE FROSTED GLASS MATERIAL DESCRIPTOR — the registry entry
 * (render_gpu/skia/materials.js). A BACKDROP material (no `backdrop`/`sampler`
 * flag => defaults to backdrop): its SkSL declares the standard {blurredBackdrop,
 * sharpBackdrop} children, so the `materialBackdrop` op + handleMaterialBackdrop
 * re-render the content beneath to feed them. `id` matches the plugin's
 * `material` op field; `pack` maps the framework's normalized `u` to the uniform
 * Float32Array. `fillParams` + `toUniformParams` opt it into being a FILL on any
 * shape (the fill-material framework, materials.isFillCapableMaterial).
 */
export const FROSTED_MATERIAL = {
  id: "frosted",
  sksl: FROSTED_SKSL,
  pack: packFrostedUniforms,
  uniformFloats: FROSTED_UNIFORM_FLOATS,
  fillParams: FROSTED_FILL_PARAMS,
  toUniformParams: frostedUniformParams,
  proxyBackdrop: frostedProxyBackdrop,
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
