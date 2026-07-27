/**
 * The CRT ("Cathode") SkSL material — a physically-motivated cathode-ray-tube
 * emulation on the reusable MATERIAL FRAMEWORK (render_gpu/skia/materials.js),
 * drawn OVER the composite-so-far inside a rounded-rect region. It is a BACKDROP
 * material: absence of a `backdrop:false` / `sampler:true` flag defaults to
 * backdrop, so the `materialBackdrop` op + handleMaterialBackdrop re-render the
 * content beneath and bind the two standard children.
 *
 * It is REAL SkSL (compiles through CanvasKit.RuntimeEffect.Make; the framework
 * compiles + caches it once per CanvasKit instance, exactly like glass_shader.js).
 * Its two children are the framework's STANDARD backdrop contract — a BLURRED and
 * a SHARP device-space image shader of everything below in z-order, in THIS order:
 *   blurredBackdrop — child 0: the phosphor GLOW / halation + diffusion source
 *   sharpBackdrop   — child 1: the displayed image (band-limited + curved here)
 *
 * ── THE PIPELINE (a real CRT signal chain, run in LINEAR light) ──────────────
 * All per-pixel work happens in linear light: the sharp/blurred children are
 * sRGB-ish encoded (the composite lives in a nonlinear 8-bit surface), so every
 * sample is decoded by `pow(c, gammaIn)` on read and the final colour is re-
 * encoded by `pow(c, 1/gammaOut)` on write. Order, per output pixel `p` (DEVICE
 * px), matching the physics (signal → screen → glass):
 *   1. rotate p into the tube's LOCAL frame; rounded-rect SDF ⇒ the tube FACE
 *      coverage (outside ⇒ nothing). This is what makes the CRT opaque.
 *   2. BARREL curvature: bulge the normalized coord by curvature·r²; the sample
 *      position follows the curved glass. A border-inset rounded rect = the LIT
 *      SCREEN; beyond it (bezel + curved corners) is the black tube face.
 *   3. INPUT BAND-LIMIT (the `sourceTVL` knob): a HORIZONTAL-ONLY Gaussian of
 *      sigma = BAND_K·W/sourceTVL device px (W = picture width = 2·halfW) applied
 *      ONCE, in linear light, BEFORE the mask/scanline. This is the finite
 *      horizontal resolution of the SOURCE signal (composite ≈ 240 TVL, RGB
 *      monitors much higher). Vertical resolution is owned by the scanline stage,
 *      so we never band-limit vertically. sigma derivation lives in the plugin.
 *   4. CONVERGENCE: radial R/B split growing with r² (beam-convergence error),
 *      done by resampling the band-limit at ±offset (skipped when ≈0).
 *   5. COLOUR: optional monochrome collapse to luma × phosphorTint (P39 green,
 *      P3 amber, P4 bluish-white …) and a cold/warm WHITE-BALANCE multiplier
 *      (NTSC-J 9300K cold ↔ ~5000K warm).
 *   6. SCANLINES: a vertical Lottes Gaussian beam (exp2(hardness·d²)) whose
 *      hardness eases from tight (dark line) to fat (bright line) by beamBloom,
 *      times a brightBoost beam gain that compensates the mask/scanline dimming.
 *   7. PHOSPHOR MASK (device / screen space, its own AA — NOT warped): aperture
 *      grille / shadow mask / slot mask / none, multiplied in.
 *   8. GLOW: warm HALATION (orange under-glass backscatter) + neutral DIFFUSION,
 *      both from the single blurred child (see the single-kernel note below).
 *   9. VIGNETTE (corner falloff) → RE-ENCODE gamma → premultiply by coverage.
 *
 * ── DELIBERATE NO-OPS (honest, not faked) ────────────────────────────────────
 * This is a STILL-frame pipeline: there is NO previous-frame texture and NO time/
 * clock uniform threaded to materials. So the CRT's two temporal knobs —
 * `persistence` (phosphor decay, needs a feedback texture) and `flicker` (needs a
 * time uniform) — are DOCUMENTED INERT: the plugin exposes them (so presets and
 * the inspector are complete) but does NOT pass them into `params`, and they are
 * NOT declared as SkSL uniforms. They do nothing here by design, rather than
 * being silently faked. Wire a frame-history/time source in and they light up.
 *
 * ── SINGLE-KERNEL GLOW LIMITATION ────────────────────────────────────────────
 * A real CRT has a TIGHT diffusion halo and a MUCH WIDER halation ring at
 * different radii. The framework binds exactly ONE blurred child (sigma =
 * op.blurRadius·scale), so halation and diffusion here SHARE that single kernel —
 * `blurRadius` tunes its radius, `halation` is the warm-tinted amount and
 * `diffusion` the neutral amount of the SAME blur. Two independent radii would
 * need a second blurred child; that is a documented follow-up, not a silent fake.
 *
 * DOM-free at import (only string SkSL + a pure packer), like glass_shader.js /
 * frosted_shader.js. `parseColor` (render_gpu/ir.js) is the shared node-safe
 * colour parser the packer reuses for phosphorTint.
 */

import { parseColor } from "../ir.js";

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
export const CRT_SKSL = `
const float AA_PX = 1.0;               // coverage antialias half-width (~1 device px)
const float TWO_PI = 6.28318530718;    // 2π — one full phosphor-triad / scanline period
const float THIRD_TURN = 2.09439510239;// TWO_PI/3 — 120° phase between the R, G, B phosphor stripes
const float VIGNETTE_START = 0.55;     // normalized radius (0=center, 1=corner) at which the vignette begins to darken
const float SCREEN_FEATHER_PX = 1.5;   // soft falloff (device px) of the curved lit-screen edge into the black tube face
const float BAND_SPAN_SIGMA = 2.5;     // the 7 band-limit taps span ±2.5σ (covers ~99% of the Gaussian); kernel width scales WITH sigma so an extreme sourceTVL stays correct
const float BAND_K = 0.512;            // TVL→σ constant at M=0.1 limiting-contrast (agent5): σ device px = BAND_K · pictureWidth / sourceTVL
const float MIN_BAND_SIGMA = 0.30;     // σ floor (device px): even a huge sourceTVL keeps a hair of softening (and a nonzero step), never a hard 1:1
const float CONV_EPS = 0.0005;         // below this convergence, skip the 3× resample and take one band-limit call (R=G=B center)
const float SCAN_HARD_DARK = -16.0;    // Lottes scanline hardness for a DARK line: tight beam, deep black gaps (exp2(hardness·d²))
const float SCAN_HARD_BRIGHT = -6.0;   // ...for a FULLY-BRIGHT line: the beam blooms fat and nearly fills the gap (beamBloom eases dark→bright)
const float MASK_APERTURE_MAX = 0.5;   // maskType code < this ⇒ aperture grille (0)
const float MASK_SHADOW_MAX = 1.5;     // ...< this ⇒ shadow mask (1);  < 2.5 ⇒ slot mask (2)
const float MASK_NONE_MIN = 2.5;       // ...> this ⇒ none (3): a flat white mask (no phosphor structure)
const float MASK_ROW_FLOOR = 0.35;     // darkest multiplier between shadow-mask dot ROWS (vertical gap floor)
const float MASK_SLOT_FLOOR = 0.35;    // darkest multiplier between slot-mask vertical SEGMENTS
const half3 LUMA = half3(0.2126, 0.7152, 0.0722);   // Rec.709 LINEAR-light luma weights (monochrome collapse)
const half3 WB_COLD = half3(0.92, 0.97, 1.10);       // NTSC-J ~9300K cold-white multiplier (bluish) — applied at whiteBalance=+1
const half3 WB_WARM = half3(1.06, 1.00, 0.90);       // ~5000K warm-white multiplier (amber) — applied at whiteBalance=-1
const half3 HALATION_WARM = half3(1.00, 0.55, 0.30); // orange-red under-glass backscatter tint of the halation ring

uniform shader blurredBackdrop;  // child 0: Gaussian-blurred composite-so-far (device space) — the halation + diffusion GLOW source
uniform shader sharpBackdrop;    // child 1: the un-blurred composite-so-far (device space) — the displayed image
uniform float2 uCenter;          // region center (device px)
uniform float2 uHalfSize;        // region half-extents (device px)
uniform float uCornerRadius;     // rounded-rect corner radius (device px)
uniform float uAngle;            // tube rotation (radians): rotate the sampling frame so a rotated CRT stays correct
// ── SIGNAL ───────────────────────────────────────────────────────────────────
uniform float uSourceTVL;        // input horizontal resolution in TV Lines (≈240 composite … ≈1000 BVM); drives the H band-limit sigma
uniform float uGammaIn;          // decode exponent: linearize the sampled backdrop (CRT display gamma ~2.4)
uniform float uGammaOut;         // encode exponent: re-encode the final colour to the surface (~2.2)
// ── SCANLINES ──────────────────────────────────────────────────────────────
uniform float uScanlineStrength; // 0..1 darkness of the gaps between scanlines
uniform float uScanlineCount;    // number of source scanlines across the screen height (raster line pitch)
uniform float uBrightBoost;      // beam gain compensating the mask/scanline dimming (a CRT runs hot)
uniform float uBeamBloom;        // 0..1 how much a BRIGHT line's beam widens (eases scanline hardness dark→bright)
// ── MASK ─────────────────────────────────────────────────────────────────────
uniform float uMaskType;         // phosphor mask code: 0 aperture-grille, 1 shadow-mask, 2 slot-mask, 3 none
uniform float uMaskStrength;     // 0..1 strength of the phosphor RGB mask
uniform float uMaskPitch;        // phosphor triad width in DEVICE px (dot pitch); mask lives in screen space, not warped
// ── GLOW ─────────────────────────────────────────────────────────────────────
uniform float uHalation;         // 0..1 warm under-glass halation amount (of the single blurred child)
uniform float uDiffusion;        // 0..1 neutral diffusion-glow amount (of the SAME blurred child; shared kernel)
// ── GEOMETRY ─────────────────────────────────────────────────────────────────
uniform float uCurvature;        // barrel/tube curvature: 0 = flat panel, higher = a fatter bulge
uniform float uConvergence;      // radial R/B convergence split, growing with r² toward the edge
uniform float uVignette;         // 0..1 corner darkening (tube edge falloff)
uniform float uBezel;            // fraction of the half-size taken by the black inner tube border around the lit screen
// ── COLOR ────────────────────────────────────────────────────────────────────
uniform float uMonochrome;       // 0..1 collapse to luma × phosphorTint (1 = a monochrome phosphor terminal / B&W tube)
uniform float uWhiteBalance;     // -1 warm … 0 neutral D65 … +1 cold (NTSC-J); scalar so it can exceed a 0..1 colour on the blue channel
uniform float3 uPhosphorTint;    // the monochrome phosphor colour (P39 green, P3 amber, P4 bluish-white); only used as uMonochrome→1

// Pure. Signed distance to a rounded rect (local, centered). <0 inside.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Query (reads the sharpBackdrop child). Horizontal-only Gaussian band-limit in
// LINEAR light: 7 taps spanning ±BAND_SPAN_SIGMA·sigma along the screen-x axis,
// each decoded by gammaIn before weighting. Kernel width scales with sigma so a
// tiny sigma (high-TVL RGB monitor) round-trips near-crisp and a large sigma
// (composite) softens. xAxis is the tube's local +x direction in device px.
half3 sampleBandLinear(float2 center, float2 xAxis, float sigma, float gin) {
  half3 acc = half3(0.0);
  float wsum = 0.0;
  for (int i = -3; i <= 3; i++) {           // 7 taps: ±3 around center
    float s = (float(i) / 3.0) * BAND_SPAN_SIGMA;   // tap position in sigma units
    float w = exp(-0.5 * s * s);            // Gaussian weight
    half3 c = sharpBackdrop.eval(center + xAxis * (s * sigma)).rgb;
    acc += pow(c, half3(gin)) * half(w);    // decode to linear, then weight
    wsum += w;
  }
  return acc / half(wsum);
}

// Pure. Phosphor mask RGB weight in [0,1] at LOCAL screen px lp (unwarped, so
// the mask is a fixed faceplate grid), triad width "pitch" device px, "type"
// code 0/1/2/3. Stripes use smooth cos ⇒ inherent antialiasing; shadow/slot add
// a vertical structure with a soft row/segment floor.
half3 phosphorMask(float2 lp, float pitch, float type) {
  if (type > MASK_NONE_MIN) { return half3(1.0); }          // none
  float triad = lp.x / pitch;
  float phase = triad * TWO_PI;
  half3 grille = half3(0.5 + 0.5 * cos(phase),
                       0.5 + 0.5 * cos(phase - THIRD_TURN),
                       0.5 + 0.5 * cos(phase + THIRD_TURN));
  if (type < MASK_APERTURE_MAX) { return grille; }          // aperture grille: vertical stripes only
  float rows = lp.y / pitch;
  if (type < MASK_SHADOW_MAX) {                             // shadow mask: brick-offset dots + row gaps
    float rowParity = step(0.5, fract(rows * 0.5));
    float phase2 = (triad + rowParity * 0.5) * TWO_PI;
    half3 dots = half3(0.5 + 0.5 * cos(phase2),
                       0.5 + 0.5 * cos(phase2 - THIRD_TURN),
                       0.5 + 0.5 * cos(phase2 + THIRD_TURN));
    float rowGap = 0.5 + 0.5 * cos(rows * TWO_PI);
    return dots * half(mix(MASK_ROW_FLOOR, 1.0, rowGap));
  }
  float slotParity = step(0.5, fract(triad * 0.5));         // slot mask: grille broken into staggered vertical segments
  float slot = 0.5 + 0.5 * cos((rows + slotParity * 0.5) * TWO_PI);
  return grille * half(mix(MASK_SLOT_FLOOR, 1.0, slot));
}

half4 main(float2 p) {
  float ca = cos(uAngle), sa = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y); // device → local (centered)
  float r = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y));        // capsule-safe clamp

  // (1) OUTER coverage = the whole widget footprint (the tube FACE). Outside ⇒ nothing.
  float dOut = sdRoundRect(pl, uHalfSize, r);
  float covOut = 1.0 - smoothstep(-AA_PX, AA_PX, dOut);
  if (covOut <= 0.0) { return half4(0.0); }

  // (2) BARREL curvature: normalized coord bulged by uCurvature·r²; sample the
  // sharp child through the curved glass. LIT SCREEN = a bezel-inset rounded rect.
  float2 uv = pl / uHalfSize;
  float r2 = dot(uv, uv);
  float radLen = sqrt(r2);
  float2 warp = uv * (1.0 + uCurvature * r2);
  float2 wl = warp * uHalfSize;                 // warped local px
  float bezelPx = uBezel * min(uHalfSize.x, uHalfSize.y);
  float2 screenHalf = max(uHalfSize - bezelPx, float2(1.0));
  float screenR = min(r, min(screenHalf.x, screenHalf.y));
  float dScr = sdRoundRect(wl, screenHalf, screenR);
  float screen = 1.0 - smoothstep(-SCREEN_FEATHER_PX, SCREEN_FEATHER_PX, dScr);

  // local axes in device px (local +x and +y directions), and the sample center.
  float2 xAxis = float2(ca, sa);
  float2 yAxis = float2(-sa, ca);
  float2 sampleDev = wl.x * xAxis + wl.y * yAxis + uCenter;

  // (3) INPUT BAND-LIMIT (horizontal only) + (4) CONVERGENCE (radial R/B split).
  float minHalf = min(uHalfSize.x, uHalfSize.y);
  float pictureWidth = 2.0 * uHalfSize.x;                                   // picture width in device px
  float bandSigma = max(BAND_K * pictureWidth / max(uSourceTVL, 1.0), MIN_BAND_SIGMA); // σ = 0.512·W/TVL device px, H-only
  half3 lin;
  if (uConvergence <= CONV_EPS || radLen <= 0.0) {
    lin = sampleBandLinear(sampleDev, xAxis, bandSigma, uGammaIn);
  } else {
    float2 dir = uv / radLen;                             // radial unit dir (local)
    float mag = uConvergence * minHalf * r2;              // split grows with r²
    float2 offDev = (dir.x * xAxis + dir.y * yAxis) * mag; // rotate local radial offset to device
    lin = half3(sampleBandLinear(sampleDev + offDev, xAxis, bandSigma, uGammaIn).r,
                sampleBandLinear(sampleDev, xAxis, bandSigma, uGammaIn).g,
                sampleBandLinear(sampleDev - offDev, xAxis, bandSigma, uGammaIn).b);
  }

  // (5) COLOUR: monochrome phosphor collapse + white-balance, in linear light.
  float lum = dot(lin, LUMA);
  half3 tintLin = pow(half3(uPhosphorTint), half3(uGammaIn));
  lin = mix(lin, half3(lum) * tintLin, half(clamp(uMonochrome, 0.0, 1.0)));
  half3 wb = uWhiteBalance >= 0.0
    ? mix(half3(1.0), WB_COLD, half(clamp(uWhiteBalance, 0.0, 1.0)))
    : mix(half3(1.0), WB_WARM, half(clamp(-uWhiteBalance, 0.0, 1.0)));
  lin *= wb;

  // (6) SCANLINES: vertical Lottes Gaussian beam, hardness eased dark→bright by
  // beamBloom, × brightBoost gain. Uses the WARPED y so scanlines curve with the tube.
  float ny = warp.y * 0.5 + 0.5;                // 0..1 down the height
  float dst = fract(ny * uScanlineCount) - 0.5; // distance to nearest line center (line units, [-0.5,0.5])
  float hardness = mix(SCAN_HARD_DARK, SCAN_HARD_BRIGHT, clamp(lum, 0.0, 1.0) * clamp(uBeamBloom, 0.0, 1.0));
  float beam = exp2(hardness * dst * dst);      // 1 at line center, small in the gap
  float scan = mix(1.0 - clamp(uScanlineStrength, 0.0, 1.0), 1.0, beam);
  lin *= half(scan) * half(max(uBrightBoost, 0.0));

  // (7) PHOSPHOR MASK in screen space (local unwarped px), multiplied in.
  half3 mask = phosphorMask(pl, max(uMaskPitch, 1.0), uMaskType);
  lin *= mix(half3(1.0), mask, half(clamp(uMaskStrength, 0.0, 1.0)));

  // (8) GLOW from the SAME single blurred kernel (documented single-kernel limit):
  //   HALATION — a diffuse ring the COLOUR of the phosphor/glass, scaled by the
  //     bloom LUMINANCE: warm orange on a colour tube, the phosphor colour on a
  //     monochrome terminal (mix by uMonochrome) — never contaminates the hue.
  //   DIFFUSION — a soft content-coloured glow, itself monochrome-collapsed +
  //     white-balanced so a green/amber terminal's glow stays green/amber.
  half3 bloomCol = pow(blurredBackdrop.eval(sampleDev).rgb, half3(uGammaIn));
  float bloomLum = dot(bloomCol, LUMA);
  float mono = clamp(uMonochrome, 0.0, 1.0);
  half3 halationTint = mix(HALATION_WARM, tintLin, half(mono));
  lin += half3(bloomLum) * half(max(uHalation, 0.0)) * halationTint;
  half3 diffCol = mix(bloomCol, half3(bloomLum) * tintLin, half(mono)) * wb;
  lin += diffCol * half(max(uDiffusion, 0.0));

  // (9) VIGNETTE → re-encode gamma → premultiply. Black tube face outside the lit screen.
  float vig = 1.0 - clamp(uVignette, 0.0, 1.0) * smoothstep(VIGNETTE_START, 1.0, radLen);
  lin *= half(vig);
  half3 outc = pow(max(lin, half3(0.0)), half3(1.0 / max(uGammaOut, 0.1)));
  half a = half(covOut);
  outc *= half(screen);
  return half4(outc * a, a);
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
// 6 geometry (cx,cy,halfW,halfH,cornerRadius,angle) + 18 scalar knobs + float3 tint (3) = 27.
const CRT_UNIFORM_FLOATS = 27;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens a whole
 * shader region — fail loudly instead). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packCrtUniforms: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Pure. A colour knob (string / rgba array / paint) -> its rgb triple [r, g, b],
 * via the shared node-safe parseColor. Alpha is dropped — the phosphor tint's
 * effect is gated by the separate uMonochrome knob, not the colour's own alpha. */
function rgb(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])];
}

/**
 * Pure function. Packs the CRT material's uniforms into the flat Float32Array
 * CanvasKit expects (uniform-declaration order; float2 = 2 slots, float3 = 3).
 * Geometry (cx/cy/halfW/halfH/cornerRadius) is in DEVICE px and `angle` in
 * radians — the framework (paint_skia.js handleMaterialBackdrop) resolves
 * world→device before calling. The two child shaders are passed separately to
 * makeShaderWithChildren. `phosphorTint` is a colour the packer parses here.
 * `maskPitch` arrives in WORLD px and is scaled to DEVICE px by `u.scale`
 * (world→device px) so the phosphor grid magnifies with the tube, consistent with
 * the device-px band-limit. The temporal knobs (persistence, flicker) are
 * deliberately NOT part of the block (documented inert — no frame-history / time
 * source in a still render).
 *
 * @param {object} u - device geometry {cx, cy, halfW, halfH, cornerRadius, angle}
 *   + `scale` (world→device px) + the material knobs {sourceTVL, gammaIn,
 *   gammaOut, scanlineStrength, scanlineCount, brightBoost, beamBloom, maskType,
 *   maskStrength, maskPitch, halation, diffusion, curvature, convergence,
 *   vignette, bezel, monochrome, whiteBalance, phosphorTint}
 * @returns {Float32Array} length 27, in shader-uniform order
 *
 * @example
 * packCrtUniforms({cx:600,cy:400,halfW:220,halfH:165,cornerRadius:44,angle:0,
 *   scale:1,sourceTVL:240,gammaIn:2.4,gammaOut:2.2,scanlineStrength:0.5,
 *   scanlineCount:240,brightBoost:1.2,beamBloom:0.4,maskType:0,maskStrength:0.35,
 *   maskPitch:3,halation:0.12,diffusion:0.15,curvature:0.06,convergence:0.02,
 *   vignette:0.3,bezel:0.05,monochrome:0,whiteBalance:0,phosphorTint:"#ffffff"}).length // 27
 */
export function packCrtUniforms(u) {
  const tint = rgb("phosphorTint", u.phosphorTint);
  const maskPitchDev = num("maskPitch", u.maskPitch) * num("scale", u.scale); // world px → device px
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    // signal
    num("sourceTVL", u.sourceTVL),
    num("gammaIn", u.gammaIn),
    num("gammaOut", u.gammaOut),
    // scanlines
    num("scanlineStrength", u.scanlineStrength),
    num("scanlineCount", u.scanlineCount),
    num("brightBoost", u.brightBoost),
    num("beamBloom", u.beamBloom),
    // mask
    num("maskType", u.maskType),
    num("maskStrength", u.maskStrength),
    maskPitchDev,
    // glow
    num("halation", u.halation),
    num("diffusion", u.diffusion),
    // geometry
    num("curvature", u.curvature),
    num("convergence", u.convergence),
    num("vignette", u.vignette),
    num("bezel", u.bezel),
    // color
    num("monochrome", u.monochrome),
    num("whiteBalance", u.whiteBalance),
    tint[0], tint[1], tint[2],
  ]);
  if (out.length !== CRT_UNIFORM_FLOATS)
    throw new Error(`packCrtUniforms: packed ${out.length} floats, expected ${CRT_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE CRT MATERIAL DESCRIPTOR — the registry entry (render_gpu/skia/materials.js).
 * `id` matches the plugin's `material` op field; `sksl` is the shader; `pack`
 * maps the framework's normalized `u` (device geometry + the material's own knobs)
 * to the uniform Float32Array. A BACKDROP material (no flag ⇒ defaults to
 * backdrop) — it needs no proxyFill (auto-covered by the generic frost stand-in).
 */
export const CRT_MATERIAL = { id: "crt", sksl: CRT_SKSL, pack: packCrtUniforms, uniformFloats: CRT_UNIFORM_FLOATS };
