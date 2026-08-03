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
 * ── THE TEMPORAL STAGE (flicker + raster drift) ───────────────────────────────
 * A real tube is never perfectly still: the beam is re-drawn every field off a
 * supply that ripples, and the raster's vertical lock creeps. Both are RECORDABLE
 * STATE in this codebase's taxonomy (CLAUDE.md): a pure function of ELAPSED TIME
 * ALONE, read through the ONE seamed clock — `render_gpu/particle_clock.particleTime()`
 * — which the editor and CLI FREEZE and both exporters override per frame. So
 * Δt = 0 ⟹ this stage contributes an identical picture, and frame 200 renders
 * without frame 199 (the exporters' frame-range sharding depends on that).
 * NEVER a wall clock, never Math.random: the shader's variation is a `uSeed`-keyed
 * fract-hash of a QUANTIZED field index, the same house pattern glitch_shader.js
 * and core/particles.js use.
 *
 * It is OPT-IN and its OFF state is EXACT, not approximate. `flicker` and
 * `scanDrift` both default to 0, and at 0 the code takes an early-out that leaves
 * `lin` and the scanline phase bit-for-bit as they were before this stage existed
 * — an untouched CRT renders byte-identical to a CRT with no temporal stage at
 * all, at any t. (That is a law, not a hope: tests/crt_flicker_test.js pins it.)
 *
 * FLICKER is a LUMINANCE gain applied at the beam (stage 6, with brightBoost),
 * because that is where a supply ripple physically acts — it modulates beam
 * current, so it dims the picture without touching the glass, the mask or the
 * glow's colour. Two superposed components, which is what keeps it from reading
 * as a sine: a smooth mains RIPPLE at `flickerRate` Hz, and a per-FIELD hashed
 * step (the beam re-strikes at a discrete refresh, so real flicker has a stair
 * edge). Their amplitudes sum to `flicker`, so the knob is the full peak-to-peak
 * swing in fractional luminance and the value means the same thing at any rate.
 *
 * ── STILL DELIBERATELY INERT ─────────────────────────────────────────────────
 * `persistence` (phosphor decay) remains DOCUMENTED INERT: it needs a PREVIOUS-FRAME
 * texture, which this pipeline has no equivalent of — and, unlike flicker, it could
 * not be made recordable even with one, because a value carried from frame N-1 is a
 * function of HISTORY rather than of `t` (that is the disqualifying test in
 * CLAUDE.md's taxonomy, and it is why persistence would break frame-range sharding).
 * It is exposed for preset/inspector completeness and never faked.
 *
 * ── SINGLE-KERNEL GLOW LIMITATION ────────────────────────────────────────────
 * A real CRT has a TIGHT diffusion halo and a MUCH WIDER halation ring at
 * different radii. The framework binds exactly ONE blurred child (sigma =
 * op.blurRadius·scale), so halation and diffusion here SHARE that single kernel —
 * `blurRadius` tunes its radius, `halation` is the warm-tinted amount and
 * `diffusion` the neutral amount of the SAME blur. Two independent radii would
 * need a second blurred child; that is a documented follow-up, not a silent fake.
 *
 * DOM-free at import (string SkSL + a pure packer + one clock READ), like
 * glass_shader.js / frosted_shader.js / glitch_shader.js. `parseColor`
 * (render_gpu/ir.js) is the shared node-safe colour parser the packer reuses for
 * phosphorTint; `particleTime` (render_gpu/particle_clock.js) is the one seamed
 * presentation clock, read ONLY inside crtUniformParams (which is therefore
 * near-pure, exactly as glitchUniformParams is) and never at import time.
 */

import { parseColor } from "../ir.js";
import { particleTime } from "../particle_clock.js";

// The three constants the OUTWARD-REACH math (maxCrtSampleReach, below) shares with
// the shader. Exported as JS constants AND interpolated into the SkSL, so the
// backdrop-region bound and the shader that samples it read ONE source of truth —
// the glass_shader.js GLASS_PRE_BULGE precedent. String(1.0) === "1", so the
// compiled shader text keeps the same value it had as an inline literal.
const AA_PX = 1.0;              // coverage antialias half-width (~1 device px)
const BAND_SPAN_SIGMA = 2.5;    // the 7 band-limit taps span ±2.5σ (covers ~99% of the Gaussian)
const BAND_K = 0.512;           // TVL→σ constant at M=0.1 limiting contrast: σ device px = BAND_K · pictureWidth / sourceTVL
const MIN_BAND_SIGMA = 0.30;    // σ floor (device px): even a huge sourceTVL keeps a hair of softening

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
export const CRT_SKSL = `
const float AA_PX = ${AA_PX};               // coverage antialias half-width (~1 device px)
const float TWO_PI = 6.28318530718;    // 2π — one full phosphor-triad / scanline period
const float THIRD_TURN = 2.09439510239;// TWO_PI/3 — 120° phase between the R, G, B phosphor stripes
const float VIGNETTE_START = 0.55;     // normalized radius (0=center, 1=corner) at which the vignette begins to darken
const float SCREEN_FEATHER_PX = 1.5;   // soft falloff (device px) of the curved lit-screen edge into the black tube face
const float BAND_SPAN_SIGMA = ${BAND_SPAN_SIGMA};     // the 7 band-limit taps span ±2.5σ (covers ~99% of the Gaussian); kernel width scales WITH sigma so an extreme sourceTVL stays correct
const float BAND_K = ${BAND_K};            // TVL→σ constant at M=0.1 limiting-contrast (agent5): σ device px = BAND_K · pictureWidth / sourceTVL
const float MIN_BAND_SIGMA = ${MIN_BAND_SIGMA};       // σ floor (device px): even a huge sourceTVL keeps a hair of softening (and a nonzero step), never a hard 1:1
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
// ── TEMPORAL (flicker + raster drift) ────────────────────────────────────────
const float FLICKER_RIPPLE_SHARE = 0.6;  // fraction of the flicker knob spent on the SMOOTH mains ripple; the remaining 0.4 is the per-field hashed step. Ripple-dominant because a supply ripple is the larger real-world term and reads as breathing rather than noise.
const float FLICKER_STEP_SHARE = 0.4;    // = 1 - FLICKER_RIPPLE_SHARE, spelled out so the two shares are visibly a partition of the knob (their sum IS the peak-to-peak swing)
const float FLICKER_FIELD_RATE = 2.0;    // hashed steps per ripple cycle: the beam re-strikes each FIELD and a mains cycle spans two fields (60Hz fields on a 30Hz-ripple set), so the step cadence is twice the ripple's
const float HASH_MUL = 0.1031;           // fract-hash multiplier (the house constant, glitch_shader.hash11)
const float HASH_ADD = 33.33;            // fract-hash additive term (ditto)

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
// ── TEMPORAL — the ONLY time input, from particleTime() (recordable state) ────
uniform float uTime;             // presentation time (seconds): frozen in editor/CLI, driven live in the presenter, overridden per frame by both exporters
uniform float uSeed;             // per-widget seed keying the hashed field step, so two CRTs on one slide do not flicker in lockstep
uniform float uFlicker;          // 0..1 peak-to-peak luminance swing of the beam flicker; 0 = the temporal stage is skipped ENTIRELY (exact no-op)
uniform float uFlickerRate;      // mains-ripple frequency in Hz (a real set ripples at its supply's rate)
uniform float uScanDrift;        // vertical raster creep in SCANLINES per second: the picture's vertical lock slipping; 0 = no drift (exact no-op)

// Pure. 1D fract-hash → [0,1). The house pattern (glitch_shader.hash11).
float hash11(float p) {
  p = fract(p * HASH_MUL);
  p *= p + HASH_ADD;
  p *= p + p;
  return fract(p);
}

// Pure. The beam's FLICKER GAIN at time t — a multiplier around 1.0 whose
// peak-to-peak swing is "amount". Two superposed terms (see the header): a smooth
// mains RIPPLE, and a hashed per-FIELD step so the beam re-strike has a stair edge
// instead of a pure sine. Deterministic in (t, seed) alone: Δt = 0 ⟹ same gain.
// Returns EXACTLY 1.0 at amount 0, which is what makes the stage an exact no-op.
float flickerGain(float t, float amount, float rate, float seed) {
  if (amount <= 0.0) { return 1.0; }
  float ripple = sin(t * rate * TWO_PI);                                  // [-1,1]
  float field = hash11(floor(t * rate * FLICKER_FIELD_RATE) + seed) * 2.0 - 1.0; // [-1,1), one value per field
  float swing = ripple * FLICKER_RIPPLE_SHARE + field * FLICKER_STEP_SHARE;      // [-1,1]
  return 1.0 + swing * amount * 0.5;   // ×0.5: "amount" is the PEAK-TO-PEAK swing, so the half-amplitude is half of it
}

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
  // uScanDrift shifts the raster PHASE by scanlines/second, so the line pattern
  // creeps vertically the way an imperfect vertical lock does. At 0 the term is
  // exactly 0 and "dst" is bit-identical to the pre-temporal expression.
  float ny = warp.y * 0.5 + 0.5;                // 0..1 down the height
  float driftLines = uScanDrift * uTime;        // raster phase offset in LINE units
  float dst = fract(ny * uScanlineCount + driftLines) - 0.5; // distance to nearest line center ([-0.5,0.5])
  float hardness = mix(SCAN_HARD_DARK, SCAN_HARD_BRIGHT, clamp(lum, 0.0, 1.0) * clamp(uBeamBloom, 0.0, 1.0));
  float beam = exp2(hardness * dst * dst);      // 1 at line center, small in the gap
  float scan = mix(1.0 - clamp(uScanlineStrength, 0.0, 1.0), 1.0, beam);
  // FLICKER rides with the beam gain: a supply ripple modulates BEAM CURRENT, so it
  // dims the picture at the same point brightBoost sets its level. Exactly 1.0 when
  // uFlicker is 0, which is what keeps the off state byte-identical.
  float flick = flickerGain(uTime, uFlicker, uFlickerRate, uSeed);
  lin *= half(scan) * half(max(uBrightBoost, 0.0) * flick);

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

// ── SHAPE-CONFORMING FILL VARIANT ────────────────────────────────────────────
// A CRT fill of a gear/star drew a rectangular lit screen + black bezel + radial
// vignette inside the clip — the FRAME read as a square. This variant conforms the
// three SHAPE terms to the silhouette SDF child: the tube-FACE coverage, the lit-SCREEN
// region (the silhouette eroded inward by the bezel, so the black bezel traces every
// tooth), and the VIGNETTE (darkening toward the true edge). Everything that is the
// rectangular RASTER SIGNAL — barrel curvature, band-limit, convergence, scanlines,
// phosphor mask, glow — is UNCHANGED (a CRT's raster is rectangular; it is a homogeneous
// texture, not an edge effect, exactly like cork's noise). The pipeline mirrors CRT_SKSL
// stage for stage. Same uniform block as CRT_SKSL (packCrtUniforms); uCornerRadius is
// unused. Children: blurredBackdrop, sharpBackdrop, shapeSdf.
export const CRT_FILL_SKSL = `
const float AA_PX = ${AA_PX};
const float TWO_PI = 6.28318530718;
const float THIRD_TURN = 2.09439510239;
const float VIGNETTE_START = 0.55;     // normalized radius at which the (radial, bbox) vignette begins — UNCHANGED from CRT_SKSL so a rect fill matches the base (invariant #3)
const float SCREEN_FEATHER_PX = 1.5;
const float BAND_SPAN_SIGMA = ${BAND_SPAN_SIGMA};
const float BAND_K = ${BAND_K};
const float MIN_BAND_SIGMA = ${MIN_BAND_SIGMA};
const float CONV_EPS = 0.0005;
const float SCAN_HARD_DARK = -16.0;
const float SCAN_HARD_BRIGHT = -6.0;
const float MASK_APERTURE_MAX = 0.5;
const float MASK_SHADOW_MAX = 1.5;
const float MASK_NONE_MIN = 2.5;
const float MASK_ROW_FLOOR = 0.35;
const float MASK_SLOT_FLOOR = 0.35;
const half3 LUMA = half3(0.2126, 0.7152, 0.0722);
const half3 WB_COLD = half3(0.92, 0.97, 1.10);
const half3 WB_WARM = half3(1.06, 1.00, 0.90);
const half3 HALATION_WARM = half3(1.00, 0.55, 0.30);
// TEMPORAL — the same five the base variant declares; see CRT_SKSL for the WHY of
// each. Both shaders are standalone SkSL programs with no shared scope, so every
// constant either shader names must be declared in BOTH.
const float FLICKER_RIPPLE_SHARE = 0.6;
const float FLICKER_STEP_SHARE = 0.4;
const float FLICKER_FIELD_RATE = 2.0;
const float HASH_MUL = 0.1031;
const float HASH_ADD = 33.33;

uniform shader blurredBackdrop;  // child 0
uniform shader sharpBackdrop;    // child 1
uniform shader shapeSdf;         // child 2: silhouette signed distance (device px, <0 inside)
uniform float2 uCenter;
uniform float2 uHalfSize;
uniform float uCornerRadius;     // unused in the fill variant (the SDF is the silhouette)
uniform float uAngle;
uniform float uSourceTVL;
uniform float uGammaIn;
uniform float uGammaOut;
uniform float uScanlineStrength;
uniform float uScanlineCount;
uniform float uBrightBoost;
uniform float uBeamBloom;
uniform float uMaskType;
uniform float uMaskStrength;
uniform float uMaskPitch;
uniform float uHalation;
uniform float uDiffusion;
uniform float uCurvature;
uniform float uConvergence;
uniform float uVignette;
uniform float uBezel;
uniform float uMonochrome;
uniform float uWhiteBalance;
uniform float3 uPhosphorTint;
uniform float uTime;             // presentation time (seconds) from particleTime() — the ONE clock
uniform float uSeed;
uniform float uFlicker;
uniform float uFlickerRate;
uniform float uScanDrift;

// Pure. 1D fract-hash → [0,1) (glitch_shader.hash11).
float hash11(float p) {
  p = fract(p * HASH_MUL);
  p *= p + HASH_ADD;
  p *= p + p;
  return fract(p);
}

// Pure. The beam flicker gain — identical to CRT_SKSL's (see its header); exactly
// 1.0 at amount 0 so the fill variant's off state is byte-identical too.
float flickerGain(float t, float amount, float rate, float seed) {
  if (amount <= 0.0) { return 1.0; }
  float ripple = sin(t * rate * TWO_PI);
  float field = hash11(floor(t * rate * FLICKER_FIELD_RATE) + seed) * 2.0 - 1.0;
  float swing = ripple * FLICKER_RIPPLE_SHARE + field * FLICKER_STEP_SHARE;
  return 1.0 + swing * amount * 0.5;
}

half3 sampleBandLinear(float2 center, float2 xAxis, float sigma, float gin) {
  half3 acc = half3(0.0);
  float wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    float s = (float(i) / 3.0) * BAND_SPAN_SIGMA;
    float w = exp(-0.5 * s * s);
    half3 c = sharpBackdrop.eval(center + xAxis * (s * sigma)).rgb;
    acc += pow(c, half3(gin)) * half(w);
    wsum += w;
  }
  return acc / half(wsum);
}

half3 phosphorMask(float2 lp, float pitch, float type) {
  if (type > MASK_NONE_MIN) { return half3(1.0); }
  float triad = lp.x / pitch;
  float phase = triad * TWO_PI;
  half3 grille = half3(0.5 + 0.5 * cos(phase),
                       0.5 + 0.5 * cos(phase - THIRD_TURN),
                       0.5 + 0.5 * cos(phase + THIRD_TURN));
  if (type < MASK_APERTURE_MAX) { return grille; }
  float rows = lp.y / pitch;
  if (type < MASK_SHADOW_MAX) {
    float rowParity = step(0.5, fract(rows * 0.5));
    float phase2 = (triad + rowParity * 0.5) * TWO_PI;
    half3 dots = half3(0.5 + 0.5 * cos(phase2),
                       0.5 + 0.5 * cos(phase2 - THIRD_TURN),
                       0.5 + 0.5 * cos(phase2 + THIRD_TURN));
    float rowGap = 0.5 + 0.5 * cos(rows * TWO_PI);
    return dots * half(mix(MASK_ROW_FLOOR, 1.0, rowGap));
  }
  float slotParity = step(0.5, fract(triad * 0.5));
  float slot = 0.5 + 0.5 * cos((rows + slotParity * 0.5) * TWO_PI);
  return grille * half(mix(MASK_SLOT_FLOOR, 1.0, slot));
}

half4 main(float2 p) {
  float ca = cos(uAngle), sa = sin(uAngle);
  float2 d0 = p - uCenter;
  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y); // widget-local (for the raster)

  // (1) tube FACE coverage = the SILHOUETTE (SDF child), not the analytic rounded rect.
  float dSil = shapeSdf.eval(p).r;
  float covOut = 1.0 - smoothstep(-AA_PX, AA_PX, dSil);
  if (covOut <= 0.0) { return half4(0.0); }
  float distIn = -dSil;

  // (2) BARREL curvature over the bbox-normalized coord (the raster stays rectangular).
  float2 uv = pl / uHalfSize;
  float r2 = dot(uv, uv);
  float radLen = sqrt(r2);
  float2 warp = uv * (1.0 + uCurvature * r2);
  float2 wl = warp * uHalfSize;
  float bezelPx = uBezel * min(uHalfSize.x, uHalfSize.y);

  float2 xAxis = float2(ca, sa);
  float2 yAxis = float2(-sa, ca);
  float2 sampleDev = wl.x * xAxis + wl.y * yAxis + uCenter;

  // LIT SCREEN = the silhouette eroded inward by the bezel, sampled at the WARPED point
  // (shapeSdf at sampleDev) so the black bezel traces the outline AND matches the base
  // shader's warped bezel-inset on a plain rect (eroding a rect by bezelPx == the base's
  // inset rect) — invariant #3. The black bezel frame therefore follows every tooth.
  float dScr = shapeSdf.eval(sampleDev).r + bezelPx;
  float screen = 1.0 - smoothstep(-SCREEN_FEATHER_PX, SCREEN_FEATHER_PX, dScr);

  // (3) INPUT BAND-LIMIT (H only) + (4) CONVERGENCE (radial R/B split).
  float minHalf = min(uHalfSize.x, uHalfSize.y);
  float pictureWidth = 2.0 * uHalfSize.x;
  float bandSigma = max(BAND_K * pictureWidth / max(uSourceTVL, 1.0), MIN_BAND_SIGMA);
  half3 lin;
  if (uConvergence <= CONV_EPS || radLen <= 0.0) {
    lin = sampleBandLinear(sampleDev, xAxis, bandSigma, uGammaIn);
  } else {
    float2 dir = uv / radLen;
    float mag = uConvergence * minHalf * r2;
    float2 offDev = (dir.x * xAxis + dir.y * yAxis) * mag;
    lin = half3(sampleBandLinear(sampleDev + offDev, xAxis, bandSigma, uGammaIn).r,
                sampleBandLinear(sampleDev, xAxis, bandSigma, uGammaIn).g,
                sampleBandLinear(sampleDev - offDev, xAxis, bandSigma, uGammaIn).b);
  }

  // (5) COLOUR: monochrome collapse + white-balance (linear light).
  float lum = dot(lin, LUMA);
  half3 tintLin = pow(half3(uPhosphorTint), half3(uGammaIn));
  lin = mix(lin, half3(lum) * tintLin, half(clamp(uMonochrome, 0.0, 1.0)));
  half3 wb = uWhiteBalance >= 0.0
    ? mix(half3(1.0), WB_COLD, half(clamp(uWhiteBalance, 0.0, 1.0)))
    : mix(half3(1.0), WB_WARM, half(clamp(-uWhiteBalance, 0.0, 1.0)));
  lin *= wb;

  // (6) SCANLINES (warped y so lines curve with the tube) + the TEMPORAL stage:
  // uScanDrift creeps the raster phase, flickerGain modulates the beam. Both are
  // exact no-ops at 0 — the fill variant mirrors CRT_SKSL stage for stage.
  float ny = warp.y * 0.5 + 0.5;
  float driftLines = uScanDrift * uTime;
  float dst = fract(ny * uScanlineCount + driftLines) - 0.5;
  float hardness = mix(SCAN_HARD_DARK, SCAN_HARD_BRIGHT, clamp(lum, 0.0, 1.0) * clamp(uBeamBloom, 0.0, 1.0));
  float beam = exp2(hardness * dst * dst);
  float scan = mix(1.0 - clamp(uScanlineStrength, 0.0, 1.0), 1.0, beam);
  float flick = flickerGain(uTime, uFlicker, uFlickerRate, uSeed);
  lin *= half(scan) * half(max(uBrightBoost, 0.0) * flick);

  // (7) PHOSPHOR MASK (screen space).
  half3 mask = phosphorMask(pl, max(uMaskPitch, 1.0), uMaskType);
  lin *= mix(half3(1.0), mask, half(clamp(uMaskStrength, 0.0, 1.0)));

  // (8) GLOW (single blurred kernel).
  half3 bloomCol = pow(blurredBackdrop.eval(sampleDev).rgb, half3(uGammaIn));
  float bloomLum = dot(bloomCol, LUMA);
  float mono = clamp(uMonochrome, 0.0, 1.0);
  half3 halationTint = mix(HALATION_WARM, tintLin, half(mono));
  lin += half3(bloomLum) * half(max(uHalation, 0.0)) * halationTint;
  half3 diffCol = mix(bloomCol, half3(bloomLum) * tintLin, half(mono)) * wb;
  lin += diffCol * half(max(uDiffusion, 0.0));

  // (9) VIGNETTE: the RADIAL bbox corner-darkening, UNCHANGED from CRT_SKSL — a CRT's
  // vignette is a tube characteristic about the screen centre, not an outline effect, so
  // keeping it radial is what makes a rect fill match the base shader (invariant #3). The
  // conformed terms are the tube FACE + the black BEZEL FRAME (which was the rectangle).
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
// 6 geometry (cx,cy,halfW,halfH,cornerRadius,angle) + 18 scalar knobs + float3 tint (3)
// + 5 temporal (time, seed, flicker, flickerRate, scanDrift) = 32.
const CRT_UNIFORM_FLOATS = 32;

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
 * the device-px band-limit. The TEMPORAL block {time, seed, flicker, flickerRate,
 * scanDrift} IS packed — `time` is the ambient particle clock, injected upstream by
 * crtUniformParams so this function stays pure. `persistence` is still NOT part of
 * the block (documented inert — no frame-history source; see the shader header).
 *
 * @param {object} u - device geometry {cx, cy, halfW, halfH, cornerRadius, angle}
 *   + `scale` (world→device px) + the material knobs {sourceTVL, gammaIn,
 *   gammaOut, scanlineStrength, scanlineCount, brightBoost, beamBloom, maskType,
 *   maskStrength, maskPitch, halation, diffusion, curvature, convergence,
 *   vignette, bezel, monochrome, whiteBalance, phosphorTint} + the temporal block
 *   {time, seed, flicker, flickerRate, scanDrift}
 * @returns {Float32Array} length 32, in shader-uniform order
 *
 * @example
 * packCrtUniforms({cx:600,cy:400,halfW:220,halfH:165,cornerRadius:44,angle:0,
 *   scale:1,sourceTVL:240,gammaIn:2.4,gammaOut:2.2,scanlineStrength:0.5,
 *   scanlineCount:240,brightBoost:1.2,beamBloom:0.4,maskType:0,maskStrength:0.35,
 *   maskPitch:3,halation:0.12,diffusion:0.15,curvature:0.06,convergence:0.02,
 *   vignette:0.3,bezel:0.05,monochrome:0,whiteBalance:0,phosphorTint:"#ffffff",
 *   time:2,seed:1337,flicker:0,flickerRate:30,scanDrift:0}).length // 32
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
    // temporal — `time` is the ambient particle clock, injected by crtUniformParams
    num("time", u.time),
    num("seed", u.seed),
    num("flicker", u.flicker),
    num("flickerRate", u.flickerRate),
    num("scanDrift", u.scanDrift),
  ]);
  if (out.length !== CRT_UNIFORM_FLOATS)
    throw new Error(`packCrtUniforms: packed ${out.length} floats, expected ${CRT_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * Pure function. The CRT shader's MAXIMUM OUTWARD backdrop-sample displacement in
 * DEVICE px, measured PAST THE PANEL'S CIRCUMRADIUS — the reach the material
 * framework needs in order to bound the backdrop it builds (the CRT half of
 * glass_shader.maxGlassDisplacement; see materials.materialSampleReach for why an
 * under-estimate is a visible bug and why absence is the safe answer).
 *
 * A tube reads the backdrop through three displacements, all bounded by uniforms:
 *
 *   1. BARREL CURVATURE. `main` samples at wl = pl · (1 + curvature · r²), where
 *      pl is the fragment in local device px and r² = |pl / halfSize|². Only
 *      fragments the shader actually SHADES matter (it returns 0 outside its
 *      rounded-rect coverage), and coverage extends at most AA_PX past the box on
 *      each axis, so r² is bounded by uvMax below. The circumradius already
 *      covers pl itself; the reach is what the bulge adds on top.
 *   2. CONVERGENCE. The R/B taps are split radially by convergence · min(halfW,
 *      halfH) · r², worst at the same corner.
 *   3. INPUT BAND-LIMIT. Seven taps span ±BAND_SPAN_SIGMA · σ along the tube's
 *      local x, σ = max(BAND_K · 2·halfW / max(sourceTVL, 1), MIN_BAND_SIGMA) —
 *      the shader's own expression, from the shared constants above.
 *
 *   uvMax = ((halfW + AA_PX)/halfW, (halfH + AA_PX)/halfH)
 *   r2max = uvMax.x² + uvMax.y²
 *   R     = hypot(halfW, halfH)
 *   reach = (R + AA_PX·√2)·(1 + curvature·r2max) − R      // barrel, past the circumradius
 *         + convergence · min(halfW, halfH) · r2max        // radial R/B split
 *         + BAND_SPAN_SIGMA · σ                            // horizontal band-limit taps
 *
 * The Gaussian support of the BLURRED child (halation/diffusion sample it at the
 * same warped point) and the coverage-AA slop are added by the caller, not here —
 * they are framework-wide, not CRT-specific.
 *
 * @param {object} u - the framework's normalized uniform input (device geometry +
 *   the CRT knobs): {halfW, halfH, curvature, convergence, sourceTVL}
 * @returns {number} maximum outward displacement past the circumradius, device px
 *
 * @example maxCrtSampleReach({halfW: 120, halfH: 80, curvature: 0, convergence: 0, sourceTVL: 1e9}) // 2.1642135623731065 (flat panel: just the AA slop + the σ floor)
 * @example maxCrtSampleReach({halfW: 120, halfH: 80, curvature: 0.06, convergence: 0, sourceTVL: 1e9}) // 20.006628131286902 (a 6% bulge on a 240x160 panel)
 * @example maxCrtSampleReach({halfW: 120, halfH: 80, curvature: 0.06, convergence: 0.02, sourceTVL: 240}) // 23.80365590906468
 */
export function maxCrtSampleReach(u) {
  const uvX = (u.halfW + AA_PX) / u.halfW, uvY = (u.halfH + AA_PX) / u.halfH;
  const r2max = uvX * uvX + uvY * uvY;
  const R = Math.hypot(u.halfW, u.halfH);
  const barrel = (R + AA_PX * Math.SQRT2) * (1 + u.curvature * r2max) - R;
  const convergence = u.convergence * Math.min(u.halfW, u.halfH) * r2max;
  const sigma = Math.max(BAND_K * 2 * u.halfW / Math.max(u.sourceTVL, 1), MIN_BAND_SIGMA);
  return barrel + convergence + BAND_SPAN_SIGMA * sigma;
}

/**
 * THE CRT KNOB SCHEMA — the ONE declaration of the material's look knobs, in the
 * customProps row shape (the fill-material framework's single-declaration rule:
 * "custom properties become material properties"; comic_shader.COMIC_FILL_PARAMS
 * is the exemplar). Both consumers derive from it:
 *   - plugins/demo/crt.js spreads it into its customProps (self.* rows), then
 *     adds only its widget-side geometry knob (cornerRadius — a fill's shape IS
 *     its geometry, so a shape's corner radius lives with the shape);
 *   - the FILL-material PaintField renders it as the paint's param rows, resolved
 *     sparse-over-defaults by materials.resolveMaterialPaint.
 * Each row keeps its Inspector `category` so the widget's grouped accordions
 * (signal/scanlines/mask/glow/geometry/color/distress/render) are unchanged.
 *
 * `blurRadius` / `backdropScale` are LOOK knobs but not shader uniforms — the
 * framework reads them off resolvedParams directly (glow sigma + sample res);
 * `crtUniformParams` therefore DROPS them, exactly as comic drops its own two.
 * `flicker` / `persistence` are DOCUMENTED INERT (no time / frame-history source
 * in a still render — see the shader header); they are exposed for preset/UI
 * completeness and are likewise dropped by `crtUniformParams`, never faked.
 */
export const CRT_FILL_PARAMS = [
  // ── SIGNAL — the input band-limit + display gamma ────────────────────────────
  { name: "sourceTVL", kind: "number", default: 240, min: 0, scrub: 1, category: "signal", help: "Horizontal source resolution in TV Lines: the finite sharpness of the INPUT signal. ~240 = composite/VHS (soft), ~400 = consumer RGB, ~600 = Sony PVM, ~1000 = broadcast BVM (near-crisp). Applies a horizontal-only Gaussian band-limit of sigma = 0.512·pictureWidth/sourceTVL before scanlines/mask. NO CAP — the SkSL clamps the divisor with max(sourceTVL, 1) and floors the sigma at MIN_BAND_SIGMA, so any value stays sane." },
  { name: "gammaIn", kind: "number", default: 2.4, min: 0.1, scrub: 0.01, category: "signal", help: "Decode gamma: the exponent that linearizes the sampled content before all CRT processing (a real CRT's display gamma is ~2.4). All stages run in linear light. NO UPPER CAP; the min-0.1 floor is a PHYSICAL positivity guard (gamma is a positive exponent and this one has no in-shader max() — a non-positive value would blow up pow() on a black sample)." },
  { name: "gammaOut", kind: "number", default: 2.2, min: 0, scrub: 0.01, category: "signal", help: "Encode gamma: the exponent the finished linear colour is re-encoded with on output (~2.2 for a standard surface). NO CAP — the SkSL uses 1/max(gammaOut, 0.1), so even 0 is guarded." },
  // ── SCANLINES — the raster beam ──────────────────────────────────────────────
  { name: "scanlineStrength", kind: "number", default: 0.5, min: 0, max: 1, category: "scanlines", help: "How dark the gaps between scanlines are, from 0 (no lines) to 1 (black gaps). The signature CRT raster texture." },
  { name: "scanlineCount", kind: "number", default: 240, min: 0, category: "scanlines", help: "Number of source scanlines across the screen height (raster line pitch). ~240 for a 240p tube (arcade/console), ~480 for a hi-res VGA/BVM. NO CAP — a huge count just makes ever-finer lines; the beam math keeps the output bounded." },
  { name: "brightBoost", kind: "number", default: 1.2, min: 0, scrub: 0.04, category: "scanlines", help: "Overall beam gain. A CRT runs its beam hot; this also compensates the dimming from the phosphor mask and scanlines. NO UPPER CAP — the SkSL clamps the gain non-negative and anything above 1 that overshoots simply clips to white on output." },
  { name: "beamBloom", kind: "number", default: 0.4, min: 0, max: 1, category: "scanlines", help: "How much a BRIGHT line's beam widens: 0 = every line the same tight width; 1 = bright lines bloom fat and nearly fill the gap (the classic highlight bloom). Eases the scanline Gaussian from tight (dark) to fat (bright)." },
  // ── MASK — the phosphor sub-pixel structure ──────────────────────────────────
  { name: "maskType", kind: "select", default: "aperture", options: ["aperture", "shadow", "slot", "none"], optionLabels: { aperture: "Aperture grille", shadow: "Shadow mask", slot: "Slot mask", none: "None" }, category: "mask", help: "Phosphor mask geometry: Aperture grille (Trinitron vertical RGB stripes), Shadow mask (offset RGB dots), Slot mask (staggered vertical segments), or None (a single-gun monochrome tube — no colour triads)." },
  { name: "maskStrength", kind: "number", default: 0.35, min: 0, max: 1, category: "mask", help: "Strength of the phosphor RGB mask, from 0 (off) to 1 (full colour separation). The visible coloured sub-pixel structure of the tube." },
  { name: "maskPitch", kind: "number", default: 3, min: 1, category: "mask", help: "Phosphor triad width (dot pitch) in world px. Smaller = finer phosphor (a sharp pro monitor); larger = chunky consumer phosphor. The mask lives in screen space, so it does NOT curve with the tube. NO UPPER CAP — the SkSL clamps the pitch to at least 1 px and a big value just makes chunkier phosphor." },
  // ── GLOW — halation + diffusion (single blurred kernel; see shader header) ────
  { name: "halation", kind: "number", default: 0.12, min: 0, max: 1, category: "glow", help: "Warm under-glass halation: a diffuse orange-red ring bright areas bleed into (the phosphor colour on a monochrome terminal). Scaled by the blurred content's luminance." },
  { name: "diffusion", kind: "number", default: 0.15, min: 0, max: 1, category: "glow", help: "Neutral diffusion glow: a soft content-coloured bloom from the frosted glass. Shares the single blurred kernel with halation (blurRadius sets its softness)." },
  { name: "blurRadius", kind: "number", default: 6, min: 0, category: "glow", help: "Gaussian blur radius (world px) of the glow source shared by halation + diffusion — how soft/wide the bloom is. NO UPPER CAP — a wide radius is only slower, never unbounded." },
  // ── GEOMETRY — tube shape (cornerRadius stays widget-side: a fill's shape IS its geometry) ─
  { name: "curvature", kind: "number", default: 0.06, min: 0, scrub: 0.005, category: "geometry", help: "Tube/barrel curvature: 0 = a flat panel, higher = a fatter CRT bulge. The image compresses at the center and stretches to the edges. NO UPPER CAP — the sampled-reach bound scales with the value, so a big bulge stays a bulge." },
  { name: "convergence", kind: "number", default: 0.02, min: 0, scrub: 0.002, category: "geometry", help: "Beam-convergence error: how far the red/blue channels split radially, growing with r² toward the edge (as a fraction of the half-size). Tiny is realistic; pro monitors are near-perfectly converged. NO UPPER CAP — the reach bound tracks the split." },
  { name: "vignette", kind: "number", default: 0.3, min: 0, max: 1, category: "geometry", help: "Corner darkening, from 0 (even) to 1 (heavy). The falloff of light toward the edges of the curved tube." },
  { name: "bezel", kind: "number", default: 0.05, min: 0, max: 0.5, category: "geometry", help: "Width of the black inner tube border around the lit screen, as a fraction of the half-size. The dark frame between the glass edge and the picture." },
  // ── COLOR — phosphor tint + white point ──────────────────────────────────────
  { name: "monochrome", kind: "number", default: 0, min: 0, max: 1, category: "color", help: "Collapse the picture to a single phosphor colour: 0 = full colour tube, 1 = a monochrome phosphor terminal / B&W tube (luminance × the phosphor tint below)." },
  { name: "whiteBalance", kind: "number", default: 0, min: -1, max: 1, category: "color", help: "White point: -1 warm (~5000K amber), 0 neutral D65, +1 cold (NTSC-J ~9300K bluish). A scalar (not a colour) so the blue channel can exceed 1.0 on the cold end." },
  { name: "phosphorTint", kind: "color", default: "#ffffff", category: "color", help: "The monochrome phosphor colour, used only as Monochrome → 1: P39 green (#00ff2b), P3 amber (#ff8c00), a bluish-white B&W tube, etc." },
  // ── FLICKER — the TEMPORAL knobs. These are the FLICKER PRESET FAMILY's key set,
  // disjoint from every appearance knob above (plugins/demo/crt.js declares both
  // families over exactly this split). All four default to an EXACT no-op, so an
  // untouched CRT renders byte-identical to one with no temporal stage at all.
  { name: "flicker", kind: "number", default: 0, min: 0, max: 1, category: "flicker", help: "Beam flicker: the peak-to-peak luminance swing as the picture breathes, from 0 (rock steady — the default, and an EXACT no-op) to 1 (the whole picture pulsing). Real sets sit near 0.02-0.08; anything much above 0.2 reads as a fault rather than a tube. Superposes a smooth mains ripple with a hashed per-field step, so it does not read as a pure sine. NO CAP ABOVE 1 is needed — 1 is already the full swing." },
  { name: "flickerRate", kind: "number", default: 30, min: 0, scrub: 0.5, category: "flicker", help: "Mains-ripple frequency in Hz: how fast the flicker breathes. ~30 for a 60Hz-field NTSC set (the ripple beats at half the field rate), ~25 for 50Hz PAL; drop to 1-5 Hz for a slow sick-tube sway. Only matters when Flicker > 0. NO CAP — a high rate just flickers faster, and the hashed step follows it." },
  { name: "scanDrift", kind: "number", default: 0, min: 0, scrub: 0.1, category: "flicker", help: "Vertical raster creep in SCANLINES per second: the picture's vertical lock slipping, so the scanline pattern crawls up the screen. 0 = locked (the default, an EXACT no-op); a fraction of a line per second is a slow shimmer; whole lines per second is a visibly rolling raster. NO CAP — a large value simply rolls faster." },
  { name: "flickerSeed", kind: "number", default: 1337, min: 0, scrub: 1, category: "flicker", help: "Seed for the hashed per-field step, so two CRTs on one slide do not flicker in lockstep. Stored document state (not a live random), which is what keeps a render reproducible. Only matters when Flicker > 0." },
  // ── DISTRESS — still DOCUMENTED INERT (see the shader header) ─────────────────
  { name: "persistence", kind: "number", default: 0, min: 0, max: 1, category: "distress", help: "INERT in this build: phosphor persistence (motion trails) needs a previous-frame texture, which this pipeline has no equivalent of — and a value carried from the previous frame is a function of HISTORY rather than of time, so it could not be made reproducible the way flicker is. Exposed for presets/completeness; never faked." },
  // ── RENDER — sample resolution ───────────────────────────────────────────────
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, max: 2, category: "render", help: "RESOLUTION FACTOR the content beneath is re-rendered at for the distortion: 1 = screen resolution, 2 = supersample (crisper, slower), 0.5 = half res (faster, softer). The 0.25..2 bounds are a PERFORMANCE guard, not a look choice — below 0.25 the backdrop is uselessly coarse and above 2 the re-render cost balloons." },
];

/**
 * NEAR-PURE function (reads the AMBIENT particle clock particleTime(); pure w.r.t.
 * its argument — the glitchUniformParams contract, restated). SCHEMA params
 * (CRT_FILL_PARAMS names/kinds) → the PACKER's params (packCrtUniforms-shaped): maps
 * the `maskType` SELECT string to its numeric shader code, passes every other shader
 * knob through unchanged, and INJECTS `time` from particleTime() — frozen in the
 * editor/CLI (a deterministic still), the wall clock in the presenter, overridden per
 * frame by both exporters. THE one mapping both consumers share — the demo widget's
 * emit() and the fill-material regionOp synthesis (paint_skia
 * handleMaterialPaintShape reads it as entry.toUniformParams), so a CRT FILL flickers
 * exactly the way the widget does.
 *
 * DELIBERATELY OMITTED from the result: `blurRadius` / `backdropScale` (the framework
 * reads these off resolvedParams directly — glow sigma + sample res, not uniforms) and
 * `persistence` (documented inert — no frame-history source; see the shader header).
 * Any `cornerRadius` present (the widget's own state) is likewise not a shader uniform
 * and is dropped. `flickerSeed` IS carried, renamed to the packer's `seed`.
 *
 * @param {object} p - schema-shaped params (resolved: every knob present)
 * @returns {object} packCrtUniforms-shaped params
 *
 * @example crtUniformParams({maskType: "aperture", sourceTVL: 240, gammaIn: 2.4, gammaOut: 2.2, scanlineStrength: 0.5, scanlineCount: 240, brightBoost: 1.2, beamBloom: 0.4, maskStrength: 0.35, maskPitch: 3, halation: 0.12, diffusion: 0.15, curvature: 0.06, convergence: 0.02, vignette: 0.3, bezel: 0.05, monochrome: 0, whiteBalance: 0, phosphorTint: "#ffffff"}).maskType // 0
 * @example crtUniformParams({maskType: "slot", sourceTVL: 300, gammaIn: 2.4, gammaOut: 2.2, scanlineStrength: 0.5, scanlineCount: 240, brightBoost: 1.4, beamBloom: 0.55, maskStrength: 0.35, maskPitch: 4, halation: 0.14, diffusion: 0.12, curvature: 0.08, convergence: 0.02, vignette: 0.35, bezel: 0.05, monochrome: 0, whiteBalance: -0.05, phosphorTint: "#ffffff"}).maskType // 2
 * @example // the temporal block rides along, with `time` injected from the clock:
 * @example crtUniformParams({maskType: "aperture", flicker: 0.05, flickerRate: 30, scanDrift: 0.2, flickerSeed: 1337}).flicker // 0.05
 * @example crtUniformParams({maskType: "aperture", flickerSeed: 1337}).seed // 1337  (flickerSeed → the packer's `seed`)
 * @example crtUniformParams({maskType: "aperture"}).time // 2  (the paused editor freeze time)
 */
export function crtUniformParams(p) {
  const MASK_CODE = { aperture: 0, shadow: 1, slot: 2, none: 3 };
  const maskType = MASK_CODE[p.maskType];
  if (maskType === undefined)
    throw new Error(`crtUniformParams: unknown maskType ${JSON.stringify(p.maskType)} (expected one of ${Object.keys(MASK_CODE).join(", ")})`);
  return {
    sourceTVL: p.sourceTVL,
    gammaIn: p.gammaIn,
    gammaOut: p.gammaOut,
    scanlineStrength: p.scanlineStrength,
    scanlineCount: p.scanlineCount,
    brightBoost: p.brightBoost,
    beamBloom: p.beamBloom,
    maskType,
    maskStrength: p.maskStrength,
    maskPitch: p.maskPitch,
    halation: p.halation,
    diffusion: p.diffusion,
    curvature: p.curvature,
    convergence: p.convergence,
    vignette: p.vignette,
    bezel: p.bezel,
    monochrome: p.monochrome,
    whiteBalance: p.whiteBalance,
    phosphorTint: p.phosphorTint,
    // TEMPORAL — `time` is the ONE seamed presentation clock. Frozen in the editor,
    // the CLI and every pixel service (a deterministic still); the wall clock in the
    // presenter; overridden per frame by both exporters. Never Date.now.
    time: particleTime(),
    seed: p.flickerSeed,
    flicker: p.flicker,
    flickerRate: p.flickerRate,
    scanDrift: p.scanDrift,
  };
}

/**
 * THE CRT MATERIAL DESCRIPTOR — the registry entry (render_gpu/skia/materials.js).
 * `id` matches the plugin's `material` op field; `sksl` is the shader; `pack`
 * maps the framework's normalized `u` (device geometry + the material's own knobs)
 * to the uniform Float32Array. A BACKDROP material (no flag ⇒ defaults to
 * backdrop) — it needs no proxyFill (auto-covered by the generic frost stand-in).
 * `maxSampleReach` is how far outside itself it READS, so the framework can bound
 * the backdrop it builds instead of re-rendering + blurring the whole surface.
 *
 * `fillParams` + `toUniformParams` opt CRT into being the FILL of any shape (the
 * fill-material framework): the schema is the ONE knob declaration both the paint
 * UI and plugins/demo/crt.js derive from, and the mapping is the ONE schema→uniform
 * step both the widget emit() and the regionOp synthesis run through.
 *
 * `animated` is PARAM-PREDICATED, like WAVY_STROKE's `boil` — not unconditional like
 * glitch/sky/rainy_window/raycast_dither. Those always visibly change frame to frame;
 * CRT's temporal stage is the opposite by design (see the shader header's "STILL
 * DELIBERATELY INERT" / flicker-off law): at flicker=0 AND scanDrift=0 (the default
 * "Rock Steady" preset) the picture is BYTE-IDENTICAL at any t, so a repaint loop would
 * spin for nothing — exactly what paintIsAnimated exists to avoid (this file's own
 * completeness sweep is animated_paint_test.js).
 */
export const crtParamsAreAnimated = (params) => (params.flicker ?? 0) !== 0 || (params.scanDrift ?? 0) !== 0;

export const CRT_MATERIAL = { id: "crt", animated: crtParamsAreAnimated, sksl: CRT_SKSL, pack: packCrtUniforms, uniformFloats: CRT_UNIFORM_FLOATS, maxSampleReach: maxCrtSampleReach, fillParams: CRT_FILL_PARAMS, toUniformParams: crtUniformParams,
  // SHAPE-CONFORMING FILL: the tube face, the bezel/lit-screen and the vignette follow
  // the silhouette SDF child, so the black bezel frame traces every tooth instead of
  // drawing a rectangle inside the shape. The rectangular raster (scanlines/mask/
  // curvature) is unchanged. The widget path keeps CRT_SKSL, byte-identical.
  usesShapeSdf: true, fillSksl: CRT_FILL_SKSL };
