/**
 * GOD RAYS — screen-space volumetric light scattering as a POST-PROCESS, expressed
 * as a BACKDROP material on the reusable material framework (materials.js). It
 * marches N samples from each pixel TOWARD the light's screen position through the
 * composite-so-far, accumulates the BRIGHT part of what it finds with a per-sample
 * exponential decay, and returns that accumulation as an ADDITIVE (premultiplied)
 * layer. Everything already drawn beneath it in z-order is both the light source
 * AND the occluder, which is the whole point: a dark rect in front of the sun
 * blocks the beams with ZERO per-object logic.
 *
 * ── THE TECHNIQUE, AND WHAT IS ADOPTED vs REJECTED ────────────────────────────
 * The canonical reference is GPU Gems 3, ch. 13 — Kenny Mitchell, "Volumetric Light
 * Scattering as a Post-Process". Its model attenuates the analytic daylight
 * scattering integral by an occlusion factor D(l) and then discretizes the integral
 * into a screen-space sum along the ray from the pixel to the light:
 *
 *     color = Σ_{i<n} L(s, θ, i) · weight · decay^i · exposure
 *
 * ADOPTED, essentially verbatim, because it is the whole reason the effect is cheap
 * and the reason it composes with an arbitrary scene:
 *   • THE SAMPLE STEP. deltaTexCoord = (p − lightPos) · density / NUM_SAMPLES, the
 *     pixel walking TOWARD the light, one step per iteration. `density` therefore
 *     controls what FRACTION of the pixel→light distance the march covers: <1
 *     produces short, bright shafts near the light; 1 marches the whole way.
 *   • THE FOUR KNOBS with their published meanings — density (sample separation),
 *     weight (per-sample intensity), decay (exponential attenuation per step, [0,1]),
 *     exposure (overall output scale). They are exposed by those names so anyone who
 *     knows the chapter knows this widget.
 *   • THE OCCLUSION IDEA. Mitchell's method 1 is an occlusion PRE-PASS: render
 *     emitters bright and occluders black into a scratch buffer, blur that radially,
 *     and additively blend the result over the real frame.
 *
 * REJECTED, with reasons:
 *   • THE PRE-PASS ITSELF. We do not have — and deliberately do not want — a second
 *     scene render with per-object "is this an emitter" tagging. The material
 *     framework already hands a backdrop material the composite-so-far as a device-
 *     space child shader, and in this document model the SKY AND SUN ARE ALREADY THE
 *     BRIGHT PIXELS and an opaque widget in front of them is ALREADY the black one.
 *     So the backdrop IS the occlusion buffer, and a threshold (below) recovers the
 *     emitter/occluder split the pre-pass would have authored by hand. This is
 *     Mitchell's method 3 ("occlusion contrast") taken to its conclusion rather than
 *     method 1, and it is what makes the user's requirement — "if there's a square in
 *     front that blocks the Sun, it would block all the god rays" — fall out for free.
 *   • THE STENCIL VARIANT (his method 2, an SM2.0-era workaround for hardware that
 *     could not afford a second target). There is no stencil in this pipeline and it
 *     buys nothing on hardware from this century.
 *   • MULTIPASS CONCENTRIC-BAND ACCUMULATION (his optimization extension). It trades
 *     exactness for passes; a single pass at ≤128 samples is already real-time here,
 *     and extra passes would each need their own IR op.
 *   • AUTOMATIC LIGHT ADAPTATION (his last extension — analyze frame min/avg/max and
 *     apply a corrective ramp). It reads back the frame's statistics, so the output
 *     would depend on the WHOLE frame's content rather than on document state alone.
 *     That is a determinism hazard for no expressive gain: an author who wants the
 *     rays dimmer turns `exposure` down.
 *   • LOWER-RESOLUTION SAMPLING (his bandwidth extension). The framework's
 *     `backdropScale` already exposes exactly this knob, generically, for every
 *     backdrop material — so it is inherited rather than reimplemented.
 *
 * ── THE MASK DECISION: A SOFT LUMINANCE THRESHOLD, NOT THE RAW BACKDROP ───────
 * Marching the RAW backdrop (Mitchell's literal shader, which accumulates
 * tex2D(frameSampler, …) unmodified) is wrong for this app, and the reason is
 * structural rather than aesthetic. Mitchell marches a buffer that a pre-pass
 * already made bimodal — emitters at full brightness, everything else at zero — so
 * every sample he adds is either "light" or "nothing". We are marching the FINAL
 * COMPOSITE, where mid-tone content is everywhere: a slide's body text, a chart, a
 * photograph, a mid-blue sky at the horizon. Accumulating that raw means every
 * moderately-lit object smears a comet tail toward the sun, which reads as a
 * rendering bug, not as light. It also makes the effect brighten in proportion to
 * how much CONTENT the slide has, which is the opposite of what an author expects.
 *
 * So the march accumulates a KEYED mask: relative Rec.709 luminance, soft-kneed
 * about `threshold` with `maskSoftness` of falloff, and multiplied by the sample's
 * own colour so a warm sun makes warm beams. The knee is a smoothstep rather than a
 * step because a hard cut BANDS along every iso-luminance contour of the sky
 * gradient — the sky is a smooth ramp, so a hard threshold draws a visible line
 * across it exactly where the ramp crosses the cut.
 *
 * WHAT THIS BUYS, in the terms the user asked for:
 *   • THE SUN DISC reads as source: the sky_sun material paints a near-white disc
 *     with an aureole, far above any sane threshold, so it dominates the sum.
 *   • BRIGHT SKY near the disc contributes at partial weight through the knee, which
 *     is physically the right answer — the aureole IS scattered light.
 *   • MID-TONE CONTENT mostly does not, which is the requirement.
 *   • AN OCCLUDER blocks by being DARK — its luminance falls under the knee, so it
 *     contributes ~0 to every sample that lands on it, and because `decay` keeps
 *     multiplying, a run of blocked samples costs the rays behind it permanently.
 *     A dark rect therefore casts a genuine shadow VOLUME through the beam field.
 *   • CLOUDS attenuate rather than block, because a lit cloud edge is bright (it
 *     contributes) while its shadowed body is mid-grey (it does not) — which is
 *     exactly the dappled, broken-beam look the user asked for.
 * `maskStrength` mixes between the keyed mask (1) and the raw backdrop (0), so
 * Mitchell's literal behaviour remains reachable for anyone who wants it.
 *
 * ── BANDING, AND WHY THE DITHER IS A HASH AND NOT A CLOCK ─────────────────────
 * A fixed-stride march quantizes each ray into N discrete taps, so a bright edge
 * crossing the ray produces N hard steps — visible banding, the effect's signature
 * artifact, and the reason naive implementations need 128+ samples. The standard
 * mitigation (universal in modern engines; blue-noise offsetting is the usual
 * phrasing) is to JITTER each pixel's march start by a fraction of one step, which
 * converts the correlated banding into uncorrelated high-frequency noise the eye
 * integrates away — buying the look of many more samples.
 *
 * The jitter here is an INTERLEAVED-GRADIENT-NOISE hash (Jimenez) of the widget-LOCAL
 * pixel coordinate. Two properties matter and both are deliberate:
 *   • It is a PURE FUNCTION OF POSITION — no time, no Math.random, no frame counter.
 *     Δt = 0 therefore leaves it bit-identical, so this stays PROPERTY state (see
 *     CLAUDE.md's three-kinds-of-state taxonomy) and an export is reproducible.
 *   • It is keyed to the WIDGET-LOCAL frame, not the device frame, so panning or
 *     zooming the editor does not make the noise crawl across the artwork.
 * `dither` = 0 disables it exactly (the offset term becomes a literal 0.0 multiply),
 * for anyone who prefers honest banding to noise, or for a pixel-diff test.
 *
 * ── THE OFF-SCREEN / BEHIND-CAMERA LIGHT, WHICH THE CHAPTER CALLS A CAVEAT ────
 * Mitchell records two failure modes. First: as occluders cross the image boundary
 * the shafts FLICKER, because the samples that fed them leave the sampled range;
 * his mitigation is to render a guard band. Ours is inherited rather than authored —
 * the widget's rect is its own region and an author sizes it past the slide edge,
 * and the framework declares NO maxSampleReach for this material (see the
 * descriptor), so the backdrop children cover the whole surface instead of a tight
 * crop. A march that leaves the surface samples Clamp-tiled edge pixels, which is
 * stable and dark rather than garbage.
 * Second, and worse: when the view is near-perpendicular to the light, the light's
 * screen position tends toward INFINITY and the sample separation explodes. His
 * options are a guard-band clamp or a fade. We fade, via `uEdgeFalloff`: the rays
 * attenuate smoothly as the light travels beyond the region, reaching zero at
 * EDGE_FADE_SPAN half-diagonals out. A fade is the right choice over a clamp here
 * because the light position is an ordinary equation-bindable world coordinate — it
 * can be keyframed straight off the edge, or bound to a sun that sets — and a clamp
 * would PIN the rays to the border and hold them there at full strength forever,
 * which looks like a stuck effect. The fade also makes "the sun goes down and the
 * beams go with it" a one-equation animation.
 * There is no NaN path: the pixel→light delta is only ever scaled, never divided by,
 * and the one true division (the falloff's normalization by the region half-diagonal)
 * is guarded by a max() against a degenerate zero-extent box.
 *
 * ── KNOWN BOUND (the chapter's other caveat, unfixable in screen space) ───────
 * "Light shafts from background objects can appear in front of foreground objects."
 * A pixel's march samples whatever is on the SCREEN between it and the light, with
 * no depth: so a beam accumulated from the sky is added over a foreground widget
 * that happens to sit along that ray, rather than being occluded by it. That is
 * inherent to the post-process — the technique has no depth buffer to consult and
 * this app has no depth at all, only z-order. Mitchell notes it reads as a LENS
 * effect (veiling glare in the camera, which sits in front of everything), and that
 * is the honest framing here too: the rays are a camera artifact, so the widget's z
 * position is the control. Put it high and it veils; the occlusion still works,
 * because occlusion happens along the ray in the backdrop, not at the destination.
 *
 * ── DETERMINISM (RenderTree = pure(document, [[slide, alpha]])) ───────────────
 * The shader is a pure function of (fragCoord, uniforms, backdrop): no time uniform,
 * no Date, no Math.random. The dither is a positional hash. Same document ⇒
 * byte-identical pixels, in the editor, the CLI and both video backends.
 *
 * DOM-free at import (string SkSL + pure packers), like brightness_contrast_shader.js
 * / lens_flare_shader.js. `parseColor` (render_gpu/ir.js) is the shared node-safe
 * hex/rgb() parser — the tint arrives through the op as a string and is parsed HERE.
 */

import { parseColor } from "../ir.js";
import { UNIT_SPAN_SCRUB } from "../../core/properties.js";

/**
 * The march's sample count is a COMPILE-TIME loop bound, not a uniform: SkSL requires
 * loops to be unrollable with a constant trip count, so the shader marches this many
 * times ALWAYS and `uSamples` masks the tail off. That makes `samples` a real quality
 * knob (fewer samples = fewer contributing taps, coarser rays) without recompiling a
 * variant per value, at the cost of running the full loop regardless. 128 is the
 * ceiling because past it the per-tap contribution is below one 8-bit level at any
 * sane exposure, so the extra taps cannot change a rendered pixel.
 */
const MAX_SAMPLES = 128;

/** The default march length: 64 taps is where banding stops being visible on a
 *  1080p beam at default density once the dither is on (below that the noise starts
 *  to read as noise rather than as smoothing). */
export const GOD_RAYS_DEFAULT_SAMPLES = 64;

export const GOD_RAYS_SKSL = `
const float AA_PX = 1.0;                 // coverage antialias half-width (~1 device px), matching the other region materials
const float3 REC709 = float3(0.2126, 0.7152, 0.0722);  // Rec.709 luma weights — the "is this pixel a light source" axis
const int MAX_SAMPLES = ${MAX_SAMPLES};  // compile-time loop bound; uSamples masks the tail (see the note in the JS)
const float EDGE_FADE_SPAN = 1.5;        // how far past the region (in half-diagonals) the light fades to nothing — Mitchell's perpendicular-view caveat, answered with a fade rather than a guard-band clamp
const float IGN_A = 0.06711056;          // interleaved gradient noise constants (Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare")
const float IGN_B = 0.00583715;
const float IGN_C = 52.9829189;
const float MIN_HALF_DIAG = 1.0;         // degenerate-box guard: a zero-extent region has no diagonal to normalize the falloff by

uniform shader blurredBackdrop;  // child 0: DECLARED ONLY to satisfy the framework's fixed {blurred, sharp} pair — a ray march reads SHARP taps (a pre-blurred occluder would leak light straight through the edges of a blocker, which is precisely the effect we must not have). See GOD_RAYS_MATERIAL.usesBlurredBackdrop
uniform shader sharpBackdrop;    // child 1: the composite-so-far (device space, sRGB-encoded, PREMULTIPLIED) — simultaneously the light source and the occlusion buffer
uniform float2 uCenter;          // region center (device px)
uniform float2 uHalfSize;        // region half-extents (device px)
uniform float uCornerRadius;     // rounded-rect corner radius (device px)
uniform float uAngle;            // region rotation (radians): rotate the SDF frame so a rotated region stays correct
uniform float2 uLight;           // THE LIGHT, in DEVICE px — the world point mapped through the camera by the plugin (see godRaysLightDevice). May lie far outside the region; that is the off-screen sun case
// ── the Mitchell knobs, by their published names ─────────────────────────────
uniform float uSamples;          // active taps (<= MAX_SAMPLES); the loop masks the tail
uniform float uDensity;          // fraction of the pixel->light distance the march covers
uniform float uDecay;            // per-step exponential attenuation, [0,1]
uniform float uWeight;           // per-sample intensity
uniform float uExposure;         // overall output scale
// ── the keyed-mask knobs (this file's departure from the chapter) ────────────
uniform float uThreshold;        // luminance below which a sample is an OCCLUDER, not a source
uniform float uMaskSoftness;     // width of the smoothstep knee above the threshold (a hard cut bands along the sky's iso-luminance contours)
uniform float uMaskStrength;     // 1 = keyed mask, 0 = Mitchell's raw backdrop
uniform float uDither;           // per-pixel march-start jitter, in fractions of one step (0 = off, exactly)
uniform float3 uTint;            // multiplies the assembled rays (the beam colour)

// Pure. Signed distance to a rounded rect (local, centered). <0 inside.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Pure. Interleaved gradient noise in [0,1) — a hash of POSITION alone, so the
// jitter it drives is property state (no clock, no RNG). Fed the widget-LOCAL pixel
// so the pattern is pinned to the artwork and does not crawl when the view pans.
float ign(float2 p) {
  return fract(IGN_C * fract(dot(p, float2(IGN_A, IGN_B))));
}

// Pure. UN-PREMULTIPLY a backdrop tap to straight colour. A fully transparent tap
// (nothing drawn beneath) carries no light: it returns black, which is exactly the
// occluder behaviour we want at the edges of the surface.
float3 straight(half4 s) {
  float a = float(s.a);
  return a > 0.0 ? clamp(float3(s.rgb) / a, 0.0, 1.0) : float3(0.0);
}

// Pure. THE SOURCE KEY: how much of this tap counts as scattering light. The keyed
// branch is the tap's own colour gated by a soft luminance knee about uThreshold —
// so a bright sun disc passes at ~1, a mid-grey slide body passes at ~0, and a dark
// occluder passes at 0 and thereby BLOCKS. uMaskStrength mixes back to the raw tap
// (Mitchell's literal accumulation) at 0.
float3 sourceKey(float3 c) {
  float lum = dot(c, REC709);
  float keyed = smoothstep(uThreshold, uThreshold + max(uMaskSoftness, 1e-4), lum);
  return c * mix(1.0, keyed, clamp(uMaskStrength, 0.0, 1.0));
}

half4 main(float2 p) {
  // Rotate the device pixel into the region's LOCAL centered frame, then rounded-rect
  // SDF -> antialiased coverage. Identical framing to every other region material.
  float ca = cos(uAngle), sa = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y);
  float r = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y)); // capsule-safe clamp
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, sdRoundRect(pl, uHalfSize, r));
  if (cov <= 0.0) { return half4(0.0); }   // outside the region: contribute nothing

  // THE OFF-SCREEN LIGHT FADE (Mitchell's perpendicular-view caveat). Distance from
  // the light to the region centre, normalized by the region's half-diagonal: 1 means
  // the light sits on the corner. Full strength while it is inside, then a smooth
  // ramp to nothing by EDGE_FADE_SPAN. The max() is the degenerate-box guard — this
  // is the shader's ONLY division, so this is where NaN would come from if it could.
  float halfDiag = max(length(uHalfSize), MIN_HALF_DIAG);
  float lightDist = length(uLight - uCenter) / halfDiag;
  float edgeFade = 1.0 - smoothstep(1.0, EDGE_FADE_SPAN, lightDist);
  if (edgeFade <= 0.0) { return half4(0.0); }  // light too far outside: no rays at all

  // THE MARCH (GPU Gems 3 ch.13). One step per iteration, walking from this pixel
  // TOWARD the light; uDensity sets what fraction of that distance is covered.
  float n = clamp(uSamples, 1.0, float(MAX_SAMPLES));
  float2 delta = (p - uLight) * (uDensity / n);

  // Jitter the START by a sub-step amount so the taps of neighbouring pixels are
  // decorrelated: banding becomes noise. A pure hash of the LOCAL pixel (see ign).
  float2 pos = p - delta * (uDither * ign(pl));

  float3 accum = float3(0.0);
  float decay = 1.0;
  for (int i = 0; i < MAX_SAMPLES; i++) {
    if (float(i) >= n) { break; }   // the tail mask: uSamples is a real quality knob
    pos -= delta;
    accum += sourceKey(straight(sharpBackdrop.eval(pos))) * decay * uWeight;
    decay *= uDecay;
  }

  // ADDITIVE OUTPUT. The rays are LIGHT: they are added over the scene, never a
  // replacement for it, so the alpha carries the ray's own luminance rather than the
  // region's coverage — a pixel the march found nothing at stays fully transparent
  // and the artwork beneath shows through untouched. (The plugin additionally
  // defaults the effects bundle's blendMode to "screen"; this premultiplied-additive
  // shape is what makes that composite correct instead of a grey wash.)
  float3 rays = accum * uExposure * uTint * edgeFade;
  rays = max(rays, float3(0.0));
  float a = clamp(dot(rays, REC709), 0.0, 1.0) * cov;
  return half4(half3(clamp(rays, 0.0, 1.0)) * half(a), half(a));
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
// geometry 6 (uCenter2 uHalfSize2 uCornerRadius1 uAngle1) + uLight 2
//   + 9 scalar knobs (samples density decay weight exposure threshold maskSoftness
//     maskStrength dither) + uTint 3 = 20.
const GOD_RAYS_UNIFORM_FLOATS = 20;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens the whole
 * region — fail loudly instead). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packGodRaysUniforms: "${name}" must be a finite number, got ${v}`);
  return v;
}

/**
 * Pure function. THE WORLD→SCREEN SEAM, completed. Maps the light's offset from the
 * region centre (rotated-region LOCAL units, carried by the op) into the DEVICE-px
 * position the shader marches toward, using the two pieces the material framework
 * has already resolved: the centre in device px (`cx`, `cy`) and the world→device
 * length factor (`scale`). The region's rotation is applied to the offset, because
 * `angle` rotates the shader's whole sampling frame and the light must rotate with
 * the box it is expressed relative to.
 *
 * This exists as its own function, rather than inline in the packer, because it is
 * the ONE line of the pipeline where a world coordinate becomes a screen coordinate,
 * and it is worth being able to test it alone.
 *
 * @param {{cx: number, cy: number, scale: number, angle?: number, lightOffsetX?: number, lightOffsetY?: number}} u
 * @returns {{x: number, y: number}} device px
 *
 * @example // Unrotated, 1:1: the offset is added straight to the device centre.
 * godRaysLightDevice({cx: 480, cy: 270, scale: 1, angle: 0, lightOffsetX: 100, lightOffsetY: -50}) // {x: 580, y: 220}
 * @example // Zoomed 2x: the same local offset is twice as many device px.
 * godRaysLightDevice({cx: 480, cy: 270, scale: 2, angle: 0, lightOffsetX: 100, lightOffsetY: 0}) // {x: 680, y: 270}
 * @example // A light AT the centre stays at the centre under any rotation or zoom.
 * godRaysLightDevice({cx: 300, cy: 200, scale: 3, angle: 1.2, lightOffsetX: 0, lightOffsetY: 0}) // {x: 300, y: 200}
 */
export function godRaysLightDevice(u) {
  const angle = u.angle ?? 0;
  const ox = (u.lightOffsetX ?? 0) * u.scale;
  const oy = (u.lightOffsetY ?? 0) * u.scale;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return { x: u.cx + ca * ox - sa * oy, y: u.cy + sa * ox + ca * oy };
}

/**
 * Pure function. Packs the God Rays material's uniforms into the flat Float32Array
 * CanvasKit expects (SkSL declaration order, tight-packed: float2 = 2 slots, float3
 * = 3). `u` is the framework's normalized input: DEVICE-px region geometry
 * {cx, cy, halfW, halfH, cornerRadius, angle}, the world→device length factor
 * `scale`, plus this material's own already-evaluated knobs (the op's `params`).
 *
 * THE LIGHT'S DEVICE POSITION IS RECONSTRUCTED HERE, and this is the seam that
 * matters: a ray march is a SCREEN-space walk, so the shader needs the light in
 * DEVICE px, but a plugin's emit() cannot produce device px — it never sees the
 * camera (zoom/pan/dpr live in the backend's `view`). The op therefore carries
 * `lightOffsetX/Y`, the light's offset from the region CENTRE in ROTATED-REGION
 * LOCAL units, which the plugin CAN compute purely (plugins/demo/god_rays.js
 * godRaysLightOffset). This packer turns it into device px the only way that needs
 * no new plumbing: the framework has already resolved the centre to device
 * (`u.cx/cy`) and handed us the world→device length factor (`u.scale`), so
 * light_device = centre_device + offset_local · scale, rotated by the region angle.
 * A pure length scale plus a rotation is exactly what a similarity transform does to
 * an offset, so this is the same map handleMaterialBackdrop applied to the centre —
 * expressed at the one point that has both halves of it.
 *
 * @param {object} u - device geometry + `scale` + {lightOffsetX, lightOffsetY, samples,
 *   density, decay, weight, exposure, threshold, maskSoftness, maskStrength, dither, tint}
 * @returns {Float32Array} length 20, in shader-uniform order
 *
 * @example
 * packGodRaysUniforms({cx: 480, cy: 270, halfW: 480, halfH: 270, cornerRadius: 0,
 *   angle: 0, scale: 1, lightOffsetX: 220, lightOffsetY: -150, samples: 64, density: 0.9,
 *   decay: 0.95, weight: 0.35, exposure: 0.4, threshold: 0.62, maskSoftness: 0.18,
 *   maskStrength: 1, dither: 1, tint: "#ffffff"}).length // 20
 * @example
 * // Light 100 local units right of centre, at 2x device scale: 480 + 100·2 = 680.
 * packGodRaysUniforms({cx: 480, cy: 270, halfW: 480, halfH: 270, cornerRadius: 0,
 *   angle: 0, scale: 2, lightOffsetX: 100, lightOffsetY: 0, samples: 8, density: 1,
 *   decay: 0.9, weight: 0.5, exposure: 1, threshold: 0.5, maskSoftness: 0.1,
 *   maskStrength: 1, dither: 0, tint: "#ffffff"})[6] // 680
 */
export function packGodRaysUniforms(u) {
  const tint = parseColor(u.tint ?? "#ffffff");
  const light = godRaysLightDevice(u);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("lightDeviceX", light.x), num("lightDeviceY", light.y),
    num("samples", u.samples),
    num("density", u.density),
    num("decay", u.decay),
    num("weight", u.weight),
    num("exposure", u.exposure),
    num("threshold", u.threshold),
    num("maskSoftness", u.maskSoftness),
    num("maskStrength", u.maskStrength),
    num("dither", u.dither),
    tint.r / 255, tint.g / 255, tint.b / 255,
  ]);
  if (out.length !== GOD_RAYS_UNIFORM_FLOATS)
    throw new Error(`packGodRaysUniforms: packed ${out.length} floats, expected ${GOD_RAYS_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE KNOB SCHEMA, declared HERE (the fill-material framework's single-declaration
 * rule — the plugin spreads this into its customProps rather than restating it).
 * The light position is NOT here: it is a WORLD point on the widget
 * (lightWorldX/lightWorldY), declared by the plugin, because it is equation-bindable
 * to a sibling sun and a fraction-of-the-box would break the moment either widget
 * moved. Categories group the Inspector rows: march / mask / look.
 */
export const GOD_RAYS_FILL_PARAMS = [
  { name: "samples", kind: "number", default: GOD_RAYS_DEFAULT_SAMPLES, min: 1, max: MAX_SAMPLES, category: "march",
    help: `How many taps each ray takes toward the light. More is smoother and slower; ${MAX_SAMPLES} is the ceiling (past it a tap cannot change an 8-bit pixel). Lower this first if the frame rate suffers.` },
  { name: "density", kind: "number", default: 0.9, min: 0, max: 1, scrub: UNIT_SPAN_SCRUB, category: "march",
    help: "What fraction of the distance to the light each ray covers. Lower = short, bright shafts hugging the light; 1 = the beam reaches all the way back to the pixel." },
  { name: "decay", kind: "number", default: 0.96, min: 0, max: 1, scrub: UNIT_SPAN_SCRUB, category: "march",
    help: "How fast a ray dims per step. Below ~0.9 the beams stay short and stubby; near 1 they carry right across the frame." },
  { name: "weight", kind: "number", default: 0.34, min: 0, scrub: UNIT_SPAN_SCRUB, category: "march",
    help: "How much each individual tap contributes. Raises overall beam intensity without changing their length." },
  { name: "exposure", kind: "number", default: 0.42, min: 0, scrub: UNIT_SPAN_SCRUB, category: "march",
    help: "Master brightness of the finished rays. The knob to reach for when the effect is right but too strong or too faint." },
  { name: "threshold", kind: "number", default: 0.62, min: 0, max: 1, scrub: UNIT_SPAN_SCRUB, category: "mask",
    help: "How bright a pixel must be to count as light rather than as an obstacle. Raise it if ordinary slide content is streaking; lower it to let a dimmer sky glow." },
  { name: "maskSoftness", kind: "number", default: 0.18, min: 0.001, max: 1, scrub: UNIT_SPAN_SCRUB, category: "mask",
    help: "How gradually a pixel goes from obstacle to light source across the threshold. Very low values band along a smooth sky gradient; this is why the cut is soft." },
  { name: "maskStrength", kind: "number", default: 1, min: 0, max: 1, scrub: UNIT_SPAN_SCRUB, category: "mask",
    help: "1 keys the rays to bright pixels only. 0 marches the scene raw (the original GPU Gems formulation), so everything smears toward the light — occasionally the look you want, usually not." },
  { name: "dither", kind: "number", default: 1, min: 0, max: 1, scrub: UNIT_SPAN_SCRUB, category: "look",
    help: "Breaks the ray march's stepping into fine noise instead of visible bands. Leave it on unless you specifically want the banded look; it costs nothing and is fully deterministic." },
  { name: "tint", kind: "color", default: "#ffffff", category: "look",
    help: "Colours the beams. White keeps whatever colour the light source itself has (a warm sun already makes warm rays); tint away from white to push them further." },
];

/**
 * Pure function. SCHEMA params (GOD_RAYS_FILL_PARAMS names) → packGodRaysUniforms
 * input. Every knob here is already numeric or a colour string, so this is a plain
 * projection — it exists so the plugin and any future fill-material path share ONE
 * mapping (the crt/comic/brightness_contrast precedent) rather than each spelling
 * the params out. The light is added by the caller (it is not a schema knob).
 *
 * @param {object} p - evaluated knob values
 * @returns {object} packGodRaysUniforms-shaped params (minus geometry and light)
 *
 * @example godRaysUniformParams({samples: 64, density: 0.9, decay: 0.96, weight: 0.34,
 *   exposure: 0.42, threshold: 0.62, maskSoftness: 0.18, maskStrength: 1, dither: 1,
 *   tint: "#ffe9c4"}).tint // "#ffe9c4"
 * @example godRaysUniformParams({samples: 200, density: 0.9, decay: 0.96, weight: 0.34,
 *   exposure: 0.42, threshold: 0.62, maskSoftness: 0.18, maskStrength: 1, dither: 1,
 *   tint: "#ffffff"}).samples // 128 (clamped to the compile-time loop bound)
 */
export function godRaysUniformParams(p) {
  return {
    samples: Math.max(1, Math.min(MAX_SAMPLES, Math.round(p.samples ?? GOD_RAYS_DEFAULT_SAMPLES))),
    density: p.density, decay: p.decay, weight: p.weight, exposure: p.exposure,
    threshold: p.threshold, maskSoftness: p.maskSoftness, maskStrength: p.maskStrength,
    dither: p.dither, tint: p.tint,
  };
}

/**
 * THE DESCRIPTOR. A BACKDROP material: its SkSL declares the standard
 * {blurredBackdrop, sharpBackdrop} children, so the `materialBackdrop` op +
 * handleMaterialBackdrop re-render the content beneath to feed them.
 *
 * `usesBlurredBackdrop: false` — a ray march reads SHARP taps, and this is a
 * correctness claim as much as a performance one: a pre-blurred occlusion buffer
 * would bleed the sun's brightness across the silhouette of a blocker, so light
 * would leak through the very square the user expects to stop it.
 *
 * NO `maxSampleReach` IS DECLARED, deliberately, and it is the one place this
 * material costs more than its neighbours. The declaration exists so a material that
 * samples only a little way outside itself gets a tightly-cropped backdrop
 * re-render; god rays is the opposite case — a pixel at one corner of the region
 * marches all the way to a light that may sit outside the region entirely, so the
 * honest reach is "the whole surface". Undeclared means exactly that (region = null
 * ⇒ full-surface re-render), which is expensive but never wrong; declaring a smaller
 * number would make the child sampler clamp mid-march and turn every beam into a
 * smear of one edge pixel.
 */
export const GOD_RAYS_MATERIAL = {
  id: "god_rays",
  sksl: GOD_RAYS_SKSL,
  pack: packGodRaysUniforms,
  uniformFloats: GOD_RAYS_UNIFORM_FLOATS,
  usesBlurredBackdrop: false,
  fillParams: GOD_RAYS_FILL_PARAMS,
  toUniformParams: godRaysUniformParams,
};

// IMPORT-TIME GUARDS — the same shape brightness_contrast_shader.js uses, so a shader
// edit that invalidates a descriptor claim fails at load rather than in a frame.
if (GOD_RAYS_MATERIAL.usesBlurredBackdrop === false && /\bblurredBackdrop\s*\.\s*eval\b/.test(GOD_RAYS_SKSL))
  throw new Error("god_rays_shader: GOD_RAYS_MATERIAL declares usesBlurredBackdrop:false but GOD_RAYS_SKSL evals blurredBackdrop — the handler skips building that child, so the march would read a SHARP texture where it expects a blurred one. Remove the flag or stop evaluating the child.");
if (!/\bsharpBackdrop\s*\.\s*eval\b/.test(GOD_RAYS_SKSL))
  throw new Error("god_rays_shader: GOD_RAYS_SKSL never evaluates sharpBackdrop — a screen-space ray march with no backdrop sample has nothing to scatter and nothing to be occluded by.");
