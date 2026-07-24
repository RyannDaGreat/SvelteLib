/**
 * The CRT SkSL material — the FIRST material on the reusable MATERIAL FRAMEWORK
 * (render_gpu/skia/materials.js), the generalization of the one-off Liquid Glass
 * path. A convincing cathode-ray-tube look drawn OVER the composite-so-far
 * inside a rounded-rect region: barrel/tube curvature, an aperture-grille
 * phosphor RGB mask, scanlines, chromatic (beam-convergence) fringing, a corner
 * vignette, a phosphor halation glow, and a black tube face around the curved
 * screen.
 *
 * It is REAL SkSL (compiles through CanvasKit.RuntimeEffect.Make; the framework
 * compiles + caches it once per CanvasKit instance, exactly like glass_shader.js).
 * Its two children are the framework's STANDARD material contract — a BLURRED and
 * a SHARP device-space image shader of everything below in z-order:
 *   sharpBackdrop  — the displayed image (sampled through the curvature)
 *   blurredBackdrop — the phosphor GLOW / halation source (a bright beam bleeds)
 *
 * Pipeline, per output pixel `p` (DEVICE px), given the region (center/half-size/
 * corner/angle) and the two child shaders:
 *   1. rotate p into the panel's LOCAL frame; the rounded-rect SDF → the tube
 *      FACE coverage (outside ⇒ nothing). This is what makes the CRT opaque.
 *   2. BARREL warp the normalized coord (bulge ∝ curvature·r²) and sample the
 *      sharp backdrop through it — the curved-glass image.
 *   3. a border-inset rounded rect = the LIT SCREEN; beyond it (bezel + curved
 *      corners) is the black tube face.
 *   4. CHROMATIC aberration: split R/B radially, growing toward the edge.
 *   5. add the blurred backdrop × glow (halation) and apply the beam GAIN.
 *   6. PHOSPHOR aperture-grille mask (three smooth RGB stripes 120° apart) ×
 *      SCANLINE bands × corner VIGNETTE.
 *
 * The MATERIAL-CHARACTER knobs (curvature, scanlines, phosphor, chromatic,
 * vignette, glow, brightness, bezel) are UNIFORMS the demo widget exposes as
 * self.* custom properties, so the whole look is user-tweakable / equation-
 * bindable. Only structural constants stay baked in.
 */

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
export const CRT_SKSL = `
const float AA_PX = 1.0;             // coverage antialias half-width (~1 device px)
const float TWO_PI = 6.28318530718;  // 2π — one full phosphor-triad / scanline period
const float VIGNETTE_START = 0.55;   // normalized radius (0=center, 1=corner) at which the vignette begins to darken
const float SCREEN_FEATHER_PX = 1.5; // soft falloff (device px) of the curved lit-screen edge into the black tube face
const float THIRD_TURN = TWO_PI / 3.0; // 120° phase between the R, G, B phosphor stripes

uniform shader blurredBackdrop;  // child 0: Gaussian-blurred composite-so-far (device space) — the halation GLOW source
uniform shader sharpBackdrop;    // child 1: the un-blurred composite-so-far (device space) — the displayed image
uniform float2 uCenter;          // region center (device px)
uniform float2 uHalfSize;        // region half-extents (device px)
uniform float uCornerRadius;     // rounded-rect corner radius (device px)
uniform float uAngle;            // panel rotation (radians): rotate the sampling frame so a rotated CRT stays correct
// ── user-tweakable knobs (self.* custom props) ───────────────────────────────
uniform float uCurvature;        // barrel/tube curvature: 0 = flat panel, higher = a fatter bulge
uniform float uScanlineCount;    // number of horizontal scanlines across the screen height
uniform float uScanlineDepth;    // 0..1 darkness of the gaps between scanlines
uniform float uApertureCount;    // number of RGB phosphor triads across the screen width
uniform float uMaskStrength;     // 0..1 strength of the phosphor (aperture-grille) RGB mask
uniform float uChromatic;        // chromatic aberration: radial R/B split as a fraction of the half-size at the very edge
uniform float uVignette;         // 0..1 corner darkening (tube edge falloff)
uniform float uGlow;             // 0..1 phosphor halation: how much of the blurred backdrop is added back
uniform float uBrightness;       // overall beam gain (a CRT runs hot; also compensates the mask/scanline dimming)
uniform float uBezel;            // fraction of the half-size taken by the black inner tube border around the lit screen

// Pure. Signed distance to a rounded rect (local, centered). <0 inside.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
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

  // (2) BARREL curvature: normalized coord in [-1,1] over the half-size, bulged
  // outward by uCurvature·r² (the image compresses at the center, stretches to
  // the edges — the classic curved-tube warp).
  float2 uv = pl / uHalfSize;
  float r2 = dot(uv, uv);
  float2 warp = uv * (1.0 + uCurvature * r2);
  float2 wl = warp * uHalfSize;                 // warped local px

  // (3) LIT SCREEN mask: a border-inset rounded rect; beyond it is black tube.
  float bezelPx = uBezel * min(uHalfSize.x, uHalfSize.y);
  float2 screenHalf = max(uHalfSize - bezelPx, float2(1.0));
  float screenR = min(r, min(screenHalf.x, screenHalf.y));
  float dScr = sdRoundRect(wl, screenHalf, screenR);
  float screen = 1.0 - smoothstep(-SCREEN_FEATHER_PX, SCREEN_FEATHER_PX, dScr);

  // device position to sample for the warped local coord (rotate back)
  float2 sampleDev = float2(ca * wl.x - sa * wl.y, sa * wl.x + ca * wl.y) + uCenter;

  // (4) CHROMATIC aberration: split R/B along the radial direction, growing to
  // the edge (beam convergence error). Offset in local px, rotated to device.
  float radLen = length(uv);
  float2 dir = radLen > 0.0 ? uv / radLen : float2(0.0);
  float caPx = uChromatic * min(uHalfSize.x, uHalfSize.y) * radLen;
  float2 offL = dir * caPx;
  float2 offDev = float2(ca * offL.x - sa * offL.y, sa * offL.x + ca * offL.y);
  half3 col = half3(
    sharpBackdrop.eval(sampleDev + offDev).r,
    sharpBackdrop.eval(sampleDev).g,
    sharpBackdrop.eval(sampleDev - offDev).b
  );

  // (5) phosphor GLOW / halation + beam GAIN
  col += blurredBackdrop.eval(sampleDev).rgb * half(uGlow);
  col *= half(uBrightness);

  // (6) PHOSPHOR aperture-grille mask: three smooth RGB stripes 120° apart
  // across the width. mix toward white by strength so 0 = no mask.
  float nx = warp.x * 0.5 + 0.5;                // 0..1 across the width
  float phase = nx * uApertureCount * TWO_PI;
  half3 tri = half3(
    0.5 + 0.5 * cos(phase),
    0.5 + 0.5 * cos(phase - THIRD_TURN),
    0.5 + 0.5 * cos(phase + THIRD_TURN)
  );
  col *= mix(half3(1.0), tri, half(uMaskStrength));

  // SCANLINES: bright bands across the height, dark gaps between (depth 0..1).
  float ny = warp.y * 0.5 + 0.5;                // 0..1 across the height
  float band = 0.5 + 0.5 * cos(ny * uScanlineCount * TWO_PI);
  col *= half(mix(1.0 - uScanlineDepth, 1.0, band));

  // VIGNETTE: darken toward the corners (tube edge falloff).
  float vig = 1.0 - uVignette * smoothstep(VIGNETTE_START, 1.0, radLen);
  col *= half(vig);

  // black tube face outside the lit screen; premultiplied by the footprint coverage.
  half a = half(covOut);
  col *= half(screen);
  return half4(col * a, a);
}
`;

// Uniform slot count — asserted by the packer so a shader edit that changes the
// uniform block is caught loudly instead of packing a mis-sized array.
const CRT_UNIFORM_FLOATS = 16;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens a whole
 * shader region — fail loudly instead). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`packCrtUniforms: "${name}" must be a finite number, got ${v}`);
  return v;
}

/**
 * Pure function. Packs the CRT material's uniforms into the flat Float32Array
 * CanvasKit expects (uniform-declaration order; float2 = 2 slots). Geometry
 * (cx/cy/halfW/halfH/cornerRadius) is in DEVICE px and `angle` in radians — the
 * framework (paint_skia.js handleMaterialBackdrop) resolves world→device before
 * calling. The two child shaders are passed separately to makeShaderWithChildren.
 *
 * @param {object} u - {cx, cy, halfW, halfH, cornerRadius, angle, curvature,
 *   scanlineCount, scanlineDepth, apertureCount, maskStrength, chromatic,
 *   vignette, glow, brightness, bezel} (device geometry + the material knobs)
 * @returns {Float32Array} length 16, in shader-uniform order
 *
 * @example
 * packCrtUniforms({cx:200,cy:150,halfW:200,halfH:150,cornerRadius:40,angle:0,
 *   curvature:0.15,scanlineCount:180,scanlineDepth:0.35,apertureCount:120,
 *   maskStrength:0.3,chromatic:0.02,vignette:0.35,glow:0.25,brightness:1.25,
 *   bezel:0.06}).length // 16
 */
export function packCrtUniforms(u) {
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("curvature", u.curvature),
    num("scanlineCount", u.scanlineCount),
    num("scanlineDepth", u.scanlineDepth),
    num("apertureCount", u.apertureCount),
    num("maskStrength", u.maskStrength),
    num("chromatic", u.chromatic),
    num("vignette", u.vignette),
    num("glow", u.glow),
    num("brightness", u.brightness),
    num("bezel", u.bezel),
  ]);
  if (out.length !== CRT_UNIFORM_FLOATS)
    throw new Error(`packCrtUniforms: packed ${out.length} floats, expected ${CRT_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * THE CRT MATERIAL DESCRIPTOR — the registry entry (render_gpu/skia/materials.js).
 * `id` matches the plugin's `material` op field + the file's purpose; `sksl` is
 * the shader; `pack` maps the framework's normalized `u` (device geometry + the
 * material's own knobs) to the uniform Float32Array. A follow-up material
 * (dirty/distorted glass, magnify) adds a sibling file + one registry line.
 */
export const CRT_MATERIAL = { id: "crt", sksl: CRT_SKSL, pack: packCrtUniforms, uniformFloats: CRT_UNIFORM_FLOATS };
