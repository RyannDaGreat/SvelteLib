/**
 * The CORKBOARD family SkSL — the FIRST FOREGROUND materials on the reusable
 * MATERIAL FRAMEWORK (render_gpu/skia/materials.js). Where glass + CRT are
 * BACKDROP materials (a RuntimeEffect whose children sample the composite-so-far),
 * these three are their DUAL: FOREGROUND materials with NO children that synthesize
 * their ENTIRE look — colour, texture, AND apparent 3D relief — from uniforms + a
 * deterministic procedural texture (hash value noise). They ride the new
 * `materialFill` IR op + handleMaterialFill (paint_skia.js): a plain
 * `effect.makeShader(uniforms)` fill, clipped to the region, with NO below-content
 * re-render. Registered with `backdrop: false` so the framework binds no children.
 *
 * ── THE PSEUDO-3D TRICK ───────────────────────────────────────────────────────
 * Every object is a HEIGHT FIELD h(x,y): cork/paper = flat matte; tack = a spherical
 * CAP; the note curl = a rolling cylinder. We take the analytic surface NORMAL from
 * that height and light it with ONE directional light (uLightDir points TOWARD the
 * light, upper-left by default — the glass widget's convention). No geometry, no
 * depth buffer, no second GPU context; it composites + CLI-exports through the exact
 * path glass already uses. HDR/environment light is a LATER one-call-site drop-in.
 *
 * ── APP-INTEGRATION ADAPTATIONS vs the standalone prototype ───────────────────
 * (`.frenzy/corkboard/prototype/corkboard.sksl.js`, the VLM-verified shader source
 * of truth — these shaders are ports of it):
 *   • uAngle    — the widget's world rotation; `p` is unrotated into the widget's
 *                 LOCAL frame so ruling/holes/curl/texture rotate WITH the widget.
 *                 (The light stays SCREEN-space; curl lighting is exact at rotation
 *                 0 — the family targets pinned-flat notes — and drifts gracefully.)
 *   • uTexScale — device px per WORLD unit (= world.scale·zoom·dpr). Texture is
 *                 sampled from board-LOCAL world coords `(frag−center)/uTexScale`,
 *                 so the granule/fibre field is LOCKED to the widget (pan-stable,
 *                 zoom-scales-with-the-board) — deterministic, RenderTree = pure.
 *   • Geometry knobs (ruleSpacing, holeRadius, curlSize, …) arrive in DEVICE px
 *                 (the packer multiplies the plugin's WORLD-px knobs by scale, like
 *                 halfW/cornerRadius); frequency knobs are cycles-per-WORLD-unit.
 *
 * Contact/drop shadows are NOT in these shaders — they are ordinary blurred Skia
 * shapes drawn BENEATH each object (the materialFill op's `shadow` descriptor, the
 * glass drawGlassShadow precedent). The ONE in-shader shadow is the note-curl SELF
 * shadow (the lifted flap darkening the paper under it), intrinsic to the flap's
 * height field.
 *
 * DOM-free at import (only string SkSL + pure packers), like glass_shader.js /
 * crt_shader.js. `parseColor` (render_gpu/ir.js) is a pure, node-safe hex/rgb()
 * parser — colour knobs pass through the generic op as strings and are parsed HERE
 * (the packer knows which params are colours; the op stays colour-agnostic).
 */

import { parseColor } from "../ir.js";

// ── shared prelude: deterministic value noise + fbm + a Lambert+Blinn lighter ──
// Concatenated into every effect. All pure SkSL functions.
const PRELUDE = `
const float HASH_MUL_X = 123.34;    // hash mixing constants (standard shader-art value hash)
const float HASH_MUL_Y = 456.21;
const float HASH_ADD    = 45.32;
const int   FBM_OCTAVES = 4;         // octaves of value noise summed for the grain
const float FBM_GAIN    = 0.5;       // amplitude falloff per octave (pink-ish spectrum)
const float FBM_LACUNARITY = 2.0;    // frequency growth per octave
const float SMOOTH3 = 3.0;           // cubic smoothstep coefficients for value-noise interpolation
const float SMOOTH2 = 2.0;

// Pure. Deterministic 2D hash -> [0,1). Same p => same value on a given backend.
float hash21(float2 p) {
  p = fract(p * float2(HASH_MUL_X, HASH_MUL_Y));
  p += dot(p, p + HASH_ADD);
  return fract(p.x * p.y);
}
// Pure. Value noise in [0,1] with smooth (cubic) interpolation of a hash lattice.
float vnoise(float2 x) {
  float2 i = floor(x), f = fract(x);
  float2 u = f * f * (SMOOTH3 - SMOOTH2 * f);
  float a = hash21(i), b = hash21(i + float2(1.0, 0.0));
  float c = hash21(i + float2(0.0, 1.0)), d = hash21(i + float2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Pure. Fractal Brownian motion: FBM_OCTAVES of value noise. Range ~[0,1].
float fbm(float2 x) {
  float s = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
  for (int o = 0; o < FBM_OCTAVES; o++) {
    s += amp * vnoise(x * freq);
    norm += amp; freq *= FBM_LACUNARITY; amp *= FBM_GAIN;
  }
  return s / norm;
}
// Pure. Diffuse+specular for a unit surface normal N (3D) lit by direction L (TO
// the light, 3D unit), viewer straight-on (+Z). Returns (diffuse, specular).
float2 litDiffSpec(float3 N, float3 L, float shininess) {
  float diff = max(dot(N, L), 0.0);
  float3 V = float3(0.0, 0.0, 1.0);
  float3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), shininess) * step(0.0, diff);
  return float2(diff, spec);
}
// Pure. Rotate a 2-vector by angle a (rows: [c -s; s c]).
float2 rot2(float2 v, float a) {
  float c = cos(a), s = sin(a);
  return float2(c * v.x - s * v.y, s * v.x + c * v.y);
}
// Pure. Rounded-rect SDF (iq). <0 inside. p LOCAL & centered.
float sdRoundRect(float2 p, float2 h, float r) {
  float2 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

// ── CORK BOARD ────────────────────────────────────────────────────────────────
// Flat matte height field. Warm tan base + two-scale granular mottle (gentle
// cm-scale drift + a DOMINANT mm-scale granule field) + dense dark pores + bright
// granule faces + a gentle top-light gradient + an inner-edge vignette (inset
// panel) + an optional darker wood-frame rim.
export const CORK_SKSL = PRELUDE + `
const float PIT_SHARPNESS = 1.7;     // exponent -> dark PORES between granules
const float FLECK_SHARPNESS = 2.1;   // exponent -> bright granule faces catching light
const float PIT_FREQ = 2.2;          // pore frequency as a multiple of the base granule frequency
const float FLECK_FREQ = 2.9;        // fleck frequency multiple (finer still than pores)
const float GRANULE_CONTRAST = 0.17; // light/dark modulation of the mm-scale granules — cork's DOMINANT signature
const float GRANULE_ANISO = 0.55;    // x-scale for fleck coords: <1 stretches granules horizontally (real cork reads slightly elongated)
const float TOPLIGHT_GRAD = 0.06;    // strength of the gentle top-to-bottom light gradient (cork is nearly matte)
const float PIT_OFFSET = 91.0;       // lattice decorrelation offset for the pore field
const float FLECK_OFFSET = 133.0;    // lattice decorrelation offset for the fleck field
const float VIGNETTE_SPAN = 0.5;     // vignette falloff span as a fraction of the smaller half-size

uniform float2 uCenter;              // board center (device px)
uniform float2 uHalfSize;            // board half-extents (device px)
uniform float  uCornerRadius;        // rounded-rect radius (device px)
uniform float  uAngle;               // widget world rotation (radians)
uniform float  uTexScale;            // device px per WORLD unit (texture is world-locked)
uniform float  uSeed;                // texture seed (deterministic; NOT time)
uniform float  uGrainScale;          // granule frequency (cycles per WORLD unit)
uniform float  uMottleScale;         // coarse blotch frequency (cycles per WORLD unit)
uniform float  uMottleStrength;      // 0..1 how much the coarse blotches drift the base tone
uniform float  uPitStrength;         // 0..1 depth of the dark pits
uniform float  uFleckStrength;       // 0..1 brightness of the pale flecks
uniform float3 uBaseColor;           // cork base tone (0..1), warm tan
uniform float  uVignette;            // 0..1 inner-edge darkening (inset-panel look)
uniform float  uFrameWidth;          // dark rim (frame) width in device px (0 = none)
uniform float3 uFrameColor;          // frame tone (0..1)
uniform float2 uLightDir;            // direction TO the light in SCREEN space, upper-left default

half4 main(float2 fragCoord) {
  float2 p = rot2(fragCoord - uCenter, -uAngle);   // device -> widget-local, centered
  float d = sdRoundRect(p, uHalfSize, uCornerRadius);
  float cov = 1.0 - smoothstep(-1.0, 1.0, d);
  if (cov <= 0.0) return half4(0.0);

  // Board-local WORLD coords (pan-stable, zoom-locked) + seed decorrelation.
  float2 tc = p / uTexScale + uSeed;
  float2 aniso = float2(GRANULE_ANISO, 1.0);
  float mottle  = fbm(tc * uMottleScale);
  float granule = fbm(tc * aniso * uGrainScale);
  float pit     = pow(fbm(tc * uGrainScale * PIT_FREQ + PIT_OFFSET), PIT_SHARPNESS);
  float fleck   = pow(fbm(tc * aniso * uGrainScale * FLECK_FREQ + FLECK_OFFSET), FLECK_SHARPNESS);

  half3 col = half3(uBaseColor);
  col *= half(1.0 + uMottleStrength * (mottle - 0.5) * 2.0);     // gentle cm-scale tone drift
  col *= half(1.0 + GRANULE_CONTRAST * (granule - 0.5) * 2.0);   // agglomerated granule faces (dominant)
  col -= half3(uPitStrength * pit);                              // small dark pores between granules
  col += half3(uFleckStrength * fleck);                          // bright granule faces catching light

  float grad = dot(normalize(p + float2(0.0001)), normalize(uLightDir));
  col += half3(TOPLIGHT_GRAD * grad * 0.5);                      // gentle directional top-light

  float distIn = -d;
  float vig = smoothstep(0.0, min(uHalfSize.x, uHalfSize.y) * VIGNETTE_SPAN, distIn);
  col *= half(mix(1.0 - uVignette, 1.0, vig));                   // inner-edge vignette

  if (uFrameWidth > 0.0) {
    float rim = 1.0 - smoothstep(uFrameWidth - 1.0, uFrameWidth + 1.0, distIn);
    col = mix(col, half3(uFrameColor), half(rim));               // dark wood rim
  }
  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov));
}
`;

// ── CORK BOARD — SHAPE-CONFORMING FILL VARIANT ───────────────────────────────────
// A cork fill of a gear/star must not draw a rectangular vignette + wood FRAME inside
// the clip (the "always a square" defect): the frame is the dominant read, so the whole
// panel looked square. This variant mirrors CORK_SKSL's texture exactly but takes the
// interior distance (which drives the vignette AND the frame rim) from the silhouette
// SDF child, so both follow the true outline — the wood rim traces every tooth. The
// granular texture is world-locked and unchanged (it is homogeneous, not an edge
// effect). Same uniform block as CORK_SKSL (packCork); uCornerRadius is unused (the SDF
// carries the silhouette). shapeSdf is the single child (foreground material).
export const CORK_FILL_SKSL = PRELUDE + `
const float PIT_SHARPNESS = 1.7;
const float FLECK_SHARPNESS = 2.1;
const float PIT_FREQ = 2.2;
const float FLECK_FREQ = 2.9;
const float GRANULE_CONTRAST = 0.17;
const float GRANULE_ANISO = 0.55;
const float TOPLIGHT_GRAD = 0.06;
const float PIT_OFFSET = 91.0;
const float FLECK_OFFSET = 133.0;
const float VIGNETTE_SPAN = 0.5;

uniform shader shapeSdf;             // child 0: silhouette signed distance (device px, <0 inside)
uniform float2 uCenter;
uniform float2 uHalfSize;
uniform float  uCornerRadius;        // unused in the fill variant (the SDF is the silhouette)
uniform float  uAngle;
uniform float  uTexScale;
uniform float  uSeed;
uniform float  uGrainScale;
uniform float  uMottleScale;
uniform float  uMottleStrength;
uniform float  uPitStrength;
uniform float  uFleckStrength;
uniform float3 uBaseColor;
uniform float  uVignette;
uniform float  uFrameWidth;
uniform float3 uFrameColor;
uniform float2 uLightDir;

half4 main(float2 fragCoord) {
  float2 p = rot2(fragCoord - uCenter, -uAngle);   // widget-local (for the world-locked texture)
  float d = shapeSdf.eval(fragCoord).r;            // silhouette distance (device px, <0 inside)
  float cov = 1.0 - smoothstep(-1.0, 1.0, d);
  if (cov <= 0.0) return half4(0.0);

  float2 tc = p / uTexScale + uSeed;
  float2 aniso = float2(GRANULE_ANISO, 1.0);
  float mottle  = fbm(tc * uMottleScale);
  float granule = fbm(tc * aniso * uGrainScale);
  float pit     = pow(fbm(tc * uGrainScale * PIT_FREQ + PIT_OFFSET), PIT_SHARPNESS);
  float fleck   = pow(fbm(tc * aniso * uGrainScale * FLECK_FREQ + FLECK_OFFSET), FLECK_SHARPNESS);

  half3 col = half3(uBaseColor);
  col *= half(1.0 + uMottleStrength * (mottle - 0.5) * 2.0);
  col *= half(1.0 + GRANULE_CONTRAST * (granule - 0.5) * 2.0);
  col -= half3(uPitStrength * pit);
  col += half3(uFleckStrength * fleck);

  float grad = dot(normalize(p + float2(0.0001)), normalize(uLightDir));
  col += half3(TOPLIGHT_GRAD * grad * 0.5);

  float distIn = -d;                               // interior distance from the SILHOUETTE
  float vig = smoothstep(0.0, min(uHalfSize.x, uHalfSize.y) * VIGNETTE_SPAN, distIn);
  col *= half(mix(1.0 - uVignette, 1.0, vig));      // inner-edge vignette follows the outline

  if (uFrameWidth > 0.0) {
    float rim = 1.0 - smoothstep(uFrameWidth - 1.0, uFrameWidth + 1.0, distIn);
    col = mix(col, half3(uFrameColor), half(rim));  // dark wood rim traces every tooth/notch
  }
  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov));
}
`;

// ── STICKY / LOOSE-LEAF NOTE ────────────────────────────────────────────────────
// Near-flat paper height field: base colour + subtle fibre; ruled lines (varying
// strength) + a red margin; optional loose-leaf HOLES and/or a RIPPED (ragged)
// left edge (both coverage CSG); and a CORNER CURL — an IMPROVED rolling-cylinder
// flap (foreshortened crest + curved-over dark underside + a crisp ridge sheen and
// tip edge) that casts a SELF shadow onto the flat paper just inside the fold.
export const NOTE_SKSL = PRELUDE + `
const float PI = 3.14159265;
const float FIBER_SCALE = 0.9;       // paper-fibre noise frequency (cycles per WORLD unit)
const float FIBER_STRENGTH = 0.05;   // paper-fibre contrast (subtle)
const float RULE_AA = 1.0;           // ruled-line antialias half-width (device px)
const float SHADE_GRAD = 0.05;       // gentle across-sheet light gradient
const float EDGE_AA = 1.2;           // coverage antialias (device px)
// curl (rolled-tube) model ----------------------------------------------------
const float CURL_CREST = 0.42;       // fraction of the flap where the tube crest (vertical, theta=PI/2) sits — <0.5 => more of the flap shows the rolling-over BACK (a tighter roll)
const float ASIN_CLAMP = 0.999;      // keep asin() inside its domain at the crest
const float CURL_ROLL_SCALE = 1.12;  // slight over-roll so the tip tucks just past vertical (a tighter roll)
const float FLAP_LIGHT_Z = 0.9;      // z of the light dir lifted off the board plane for the flap
const float CURL_SHININESS = 14.0;   // ridge sheen tightness (a crisp lengthwise tube highlight, not a metal hotspot)
const float FLAP_SHEEN = 0.14;       // specular weight on the flap ridge
const float FLAP_DIFF_BASE = 0.52;   // flap diffuse floor (ambient so the shaded flap is not black)
const float FLAP_DIFF_GAIN = 0.46;   // flap diffuse gain above the floor
const float FLAP_FIBER = 0.06;       // fibre grain on the flap so it reads as paper, not a smooth ramp
const float CURL_BACK_DARK = 0.4;    // how dark the flap UNDERSIDE (back of paper, in shade) goes
const float BACK_START = 1.35;       // roll angle (rad) at which the underside starts to show
const float BACK_FULL = 2.7;         // roll angle (rad) at which the underside fully shows
const float BACK_DIFF_GAIN = 0.5;    // how much diffuse the shaded underside still catches
const float EDGE_LO = 0.86;          // f at which the bright rolled-edge highlight (paper thickness) begins
const float EDGE_LIGHT = 0.2;        // brightness of that rolled tip edge
const float SHADOW_BAND_BASE = 0.35; // self-shadow band width as a fraction of L (grows with curl)
const float SHADOW_BAND_GAIN = 0.65;
const float CURL_SHADOW_MAX = 0.55;  // max darkness of the self cast shadow under the flap
const half3  BACK_TINT = half3(1.0, 0.965, 0.9); // warm cream cast of the paper's BACK side (fibres, no print)

uniform float2 uCenter;              // note center (device px)
uniform float2 uHalfSize;            // note half-extents (device px)
uniform float  uCornerRadius;        // small corner radius (device px)
uniform float  uAngle;               // widget world rotation (radians)
uniform float  uTexScale;            // device px per WORLD unit (texture is world-locked)
uniform float  uSeed;
uniform float3 uPaperColor;          // paper tone (0..1)
uniform float2 uLightDir;            // TO the light (screen xy)
uniform float  uRuleSpacing;         // device px between horizontal rules (0 = none)
uniform float  uRuleStrength;        // 0..1 darkness of the rules ("varying line strength")
uniform float3 uRuleColor;           // rule ink (0..1), pale blue-grey
uniform float  uMarginX;             // vertical margin line x, in LOCAL device px from left edge (<0 = none)
uniform float3 uMarginColor;         // margin ink (0..1), red
uniform float  uHoleRadius;          // loose-leaf punch radius, device px (0 = none)
uniform float  uHoleSpacing;         // device px between hole centers
uniform float  uHoleInset;           // device px from top edge to hole centers
uniform float  uRipStrength;         // device px amplitude of the ragged left edge (0 = clean)
uniform float  uRipScale;            // ragged-edge noise frequency (cycles per WORLD unit)
uniform float  uCurlAmount;          // 0..1 fraction of the corner region that has lifted
uniform float  uCurlSize;            // device px: max diagonal length of the curling corner region
uniform float2 uCurlDir;             // corner selector, each component +-1 (e.g. (1,-1)=top-right)

half4 main(float2 fragCoord) {
  float2 p = rot2(fragCoord - uCenter, -uAngle);   // device -> widget-local, centered
  float2 hs = uHalfSize;

  // ---- coverage: rounded rect, minus ragged edge, minus holes ----
  float d = sdRoundRect(p, hs, uCornerRadius);
  if (uRipStrength > 0.0) {
    float rag = uRipStrength * fbm(float2(uSeed, (p.y / uTexScale) * uRipScale));
    float leftCut = (-hs.x + rag) - p.x;           // >0 where we are LEFT of the ragged boundary (cut away)
    d = max(d, leftCut);
  }
  if (uHoleRadius > 0.0) {
    float holeY = -hs.y + uHoleInset;              // hole-centre row (top)
    float colIdx = floor((p.x + uHoleSpacing * 0.5) / uHoleSpacing);
    float2 hc = float2(colIdx * uHoleSpacing, holeY);
    float dHole = length(p - hc) - uHoleRadius;
    d = max(d, -dHole);                            // CSG subtract
  }
  float cov = 1.0 - smoothstep(-EDGE_AA, EDGE_AA, d);
  if (cov <= 0.0) return half4(0.0);

  // ---- flat paper base: colour + fibre + gentle gradient ----
  float2 tc = p / uTexScale + uSeed;
  float fiber = fbm(tc * FIBER_SCALE);
  half3 col = half3(uPaperColor) * half(1.0 + FIBER_STRENGTH * (fiber - 0.5) * 2.0);
  float grad = dot(normalize(p + float2(0.0001)), normalize(uLightDir));
  col += half3(SHADE_GRAD * grad * 0.5);

  // ---- ruled horizontal lines (varying strength) + red margin ----
  if (uRuleSpacing > 0.0 && uRuleStrength > 0.0) {
    float ly = mod(p.y + hs.y, uRuleSpacing);
    float line = 1.0 - smoothstep(0.0, RULE_AA, min(ly, uRuleSpacing - ly));
    col = mix(col, half3(uRuleColor), half(line * uRuleStrength));
  }
  if (uMarginX >= 0.0) {
    float mx = abs((p.x + hs.x) - uMarginX);
    float m = 1.0 - smoothstep(0.0, RULE_AA, mx);
    col = mix(col, half3(uMarginColor), half(m * uRuleStrength));
  }

  // ---- CORNER CURL (improved rolled-tube flap) ----
  if (uCurlAmount > 0.0 && uCurlSize > 0.0) {
    float2 corner = float2(uCurlDir.x * hs.x, uCurlDir.y * hs.y);
    float2 q = (corner - p) * uCurlDir;            // >=0 components = distance INTO the sheet from the corner
    float diag = q.x + q.y;                        // manhattan distance from the corner along the fold diagonal
    float L = uCurlSize * uCurlAmount;             // fold-line distance from the corner (grows with the curl)
    if (diag < L) {
      float f = clamp((L - diag) / max(L, 1.0), 0.0, 1.0); // 0 at the fold -> 1 at the corner tip
      // Rolled-tube angle with FORESHORTENING: asin() packs many arc-lengths into
      // the thin screen band around the crest (a tight roll), then the BACK face
      // curves over toward the tip (theta -> ~PI, underside up).
      float theta;
      if (f < CURL_CREST) theta = asin(clamp(f / CURL_CREST, 0.0, 1.0) * ASIN_CLAMP);
      else theta = PI - asin(clamp((1.0 - f) / (1.0 - CURL_CREST), 0.0, 1.0) * ASIN_CLAMP);
      theta *= CURL_ROLL_SCALE;
      float2 diagDir = normalize(uCurlDir);
      float3 N = float3(-diagDir * sin(theta), cos(theta));    // ridge(up) at fold -> faces back at tip
      float2 lit = litDiffSpec(N, float3(normalize(uLightDir), FLAP_LIGHT_Z), CURL_SHININESS);
      float ff = fbm((p / uTexScale + uSeed) * FIBER_SCALE * 2.0);
      float back = smoothstep(BACK_START, BACK_FULL, theta);   // 0 front face -> 1 shaded underside
      half3 frontCol = half3(uPaperColor) * half(FLAP_DIFF_BASE + FLAP_DIFF_GAIN * lit.x);
      half3 backCol  = half3(uPaperColor) * BACK_TINT * half(CURL_BACK_DARK + (1.0 - CURL_BACK_DARK) * lit.x * BACK_DIFF_GAIN);
      half3 flap = mix(frontCol, backCol, half(back));
      flap *= half(1.0 + FLAP_FIBER * (ff - 0.5) * 2.0);       // fibre grain kills the smooth-ramp look
      flap += half3(lit.y * FLAP_SHEEN);                       // crisp lengthwise ridge sheen
      float edge = smoothstep(EDGE_LO, 1.0, f);
      flap += half3(EDGE_LIGHT * edge);                        // bright rolled tip edge (paper thickness)
      col = flap;
    } else {
      float band = L * (SHADOW_BAND_BASE + SHADOW_BAND_GAIN * uCurlAmount);
      float s = 1.0 - smoothstep(0.0, band, diag - L);
      col *= half(1.0 - CURL_SHADOW_MAX * s * uCurlAmount);    // self cast shadow inside the fold
    }
  }

  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov));
}
`;

// ── THUMBTACK (domed head, top-down) ────────────────────────────────────────────
// Spherical-cap height field h(r)=sqrt(R^2-r^2). Normal -> Lambert+Blinn (glossy
// plastic => a tight bright hotspot + an ambient floor so the colour stays bright).
// A darker AO ring at the base seats the dome; a faint rim light hints at thin
// translucent plastic. uDomeGain (press-in DEPTH) flattens the dome AND is what the
// caller uses to scale the external contact shadow.
export const TACK_SKSL = PRELUDE + `
const float AO_RING = 0.28;          // darkness of the seating shadow ring at the dome base
const float AO_WIDTH = 0.20;         // width of that ring as a fraction of the radius
const float AMBIENT = 0.5;           // ambient term: semi-gloss PLASTIC stays bright across the lit face (not a dark marble)
const float RIM_LIGHT = 0.14;        // faint rim light on the shadowed edge (plastic translucency hint)
const float DOME_FLAT = 0.6;         // <1 flattens the hemisphere toward a spherical CAP (a tack head, not a full ball)
const float DOME_MIN = 0.05;         // minimum apparent dome height (a fully pressed-in tack is still slightly proud)
const float LIGHT_XY = 0.85;         // xy weight of the light dir (lifted off the board plane)
const float LIGHT_Z = 0.55;          // z of the light dir
const float AA_PX = 2.0;             // edge antialias (device px) at the disk rim

uniform float2 uCenter;              // head center (device px)
uniform float  uRadius;              // head radius (device px)
uniform float  uDomeGain;            // 0..1 apparent dome height fraction (press-in DEPTH: lower = flatter)
uniform float3 uColor;               // plastic head colour (0..1)
uniform float  uShininess;           // Blinn exponent (glossy plastic = high)
uniform float2 uLightDir;            // TO the light (screen xy)
// NO uSeed. It was declared here and packed for two releases with main() never reading
// it, and the Inspector row above it said so out loud ("no visible effect") — measured,
// seed 0 and 9999 rendered byte-identically. The stated reason, "uniform-block
// symmetry", never held: this shader's block is already its own shape (uCenter +
// uRadius, no cornerRadius / scale / time, unlike the cork and note materials beside
// it), because a tack is a DISK and not a rect region.

half4 main(float2 fragCoord) {
  float2 p = (fragCoord - uCenter) / uRadius;      // unit disk
  float r2 = dot(p, p);
  float cov = 1.0 - smoothstep(1.0 - AA_PX / uRadius, 1.0, sqrt(r2));
  if (cov <= 0.0) return half4(0.0);

  float h = sqrt(max(0.0, 1.0 - r2)) * clamp(uDomeGain, DOME_MIN, 1.0); // dome height (flatter when pressed in)
  float3 N = normalize(float3(p * DOME_FLAT, h + 1e-4));                // flatten xy => a spherical CAP, not a ball
  float3 L = normalize(float3(normalize(uLightDir) * LIGHT_XY, LIGHT_Z)); // light slightly above the board plane
  float2 lit = litDiffSpec(N, L, uShininess);

  half3 body = half3(uColor) * half(AMBIENT + (1.0 - AMBIENT) * lit.x);
  body += half3(lit.y);                                          // white glossy hotspot
  float rim = pow(1.0 - max(0.0, h), 2.0);
  body += half3(uColor) * half(RIM_LIGHT * rim);                 // faint translucent-plastic rim
  float ring = smoothstep(1.0 - AO_WIDTH, 1.0, sqrt(r2));
  body *= half(1.0 - AO_RING * ring);                            // AO seating ring at the base

  return half4(clamp(body, 0.0, 1.0) * half(cov), half(cov));
}
`;

// ── THUMBTACK — SHAPE-CONFORMING FILL VARIANT ────────────────────────────────────
// A tack head is a DISK, so its fill was ALWAYS a circular dome clipped to the shape.
// This variant makes the dome a HEIGHT FIELD over the SILHOUETTE: the height rises from
// 0 at the outline to a rounded plateau in the interior, driven by the interior
// distance from the SDF child, and the surface normal tilts along the SDF gradient — so
// a gear reads as a domed plastic gear with a bevelled, gear-shaped edge, its hotspot
// and seating AO ring following the outline. The lighting math (Lambert + Blinn hotspot,
// ambient floor, rim, AO ring) mirrors TACK_SKSL. Same uniform block as TACK_SKSL
// (packTack); the "radial" coordinate is (1 - distIn/R), the silhouette analog of the
// disk's |p|. shapeSdf is the single child.
export const TACK_FILL_SKSL = PRELUDE + `
const float AO_RING = 0.28;
const float AO_WIDTH = 0.20;
const float AMBIENT = 0.5;
const float RIM_LIGHT = 0.14;
const float DOME_FLAT = 0.6;
const float DOME_MIN = 0.05;
const float LIGHT_XY = 0.85;
const float LIGHT_Z = 0.55;
const float AA_PX = 2.0;
const float NORMAL_EPS_PX = 1.0;

uniform shader shapeSdf;             // child 0: silhouette signed distance (device px, <0 inside)
uniform float2 uCenter;
uniform float  uRadius;              // dome reach (device px = halfW); the plateau depth
uniform float  uDomeGain;
uniform float3 uColor;
uniform float  uShininess;
uniform float2 uLightDir;

half4 main(float2 fragCoord) {
  float d = shapeSdf.eval(fragCoord).r;            // silhouette distance (device px, <0 inside)
  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, d);
  if (cov <= 0.0) return half4(0.0);
  float distIn = -d;                               // interior distance from the SILHOUETTE

  float R = max(uRadius, 1.0);
  float t = clamp(distIn / R, 0.0, 1.0);           // 0 at the rim -> 1 at the dome plateau
  float rr = 1.0 - t;                              // the disk's |p| analog: 1 at rim, 0 at plateau
  float h = sqrt(max(0.0, 1.0 - rr * rr)) * clamp(uDomeGain, DOME_MIN, 1.0);

  // outward silhouette direction (central difference of the SDF child) = the disk's radial dir.
  float2 g = float2(
    shapeSdf.eval(fragCoord + float2(NORMAL_EPS_PX, 0.0)).r - shapeSdf.eval(fragCoord - float2(NORMAL_EPS_PX, 0.0)).r,
    shapeSdf.eval(fragCoord + float2(0.0, NORMAL_EPS_PX)).r - shapeSdf.eval(fragCoord - float2(0.0, NORMAL_EPS_PX)).r);
  float glen = length(g);
  float2 dir = glen > 0.0 ? g / glen : float2(0.0);
  float3 N = normalize(float3(dir * rr * DOME_FLAT, h + 1e-4));   // spherical-CAP normal over the silhouette
  float3 L = normalize(float3(normalize(uLightDir) * LIGHT_XY, LIGHT_Z));
  float2 lit = litDiffSpec(N, L, uShininess);

  half3 body = half3(uColor) * half(AMBIENT + (1.0 - AMBIENT) * lit.x);
  body += half3(lit.y);                                          // white glossy hotspot
  float rim = pow(1.0 - max(0.0, h), 2.0);
  body += half3(uColor) * half(RIM_LIGHT * rim);                 // faint translucent-plastic rim
  float ring = smoothstep(1.0 - AO_WIDTH, 1.0, rr);              // seating AO ring at the outline
  body *= half(1.0 - AO_RING * ring);

  return half4(clamp(body, 0.0, 1.0) * half(cov), half(cov));
}
`;

// ── uniform packers ────────────────────────────────────────────────────────────
// Each maps the framework's normalized `u` (device geometry {cx, cy, halfW, halfH,
// cornerRadius, angle} + `scale` = device px per world unit + the material's own
// already-evaluated knobs) to the Float32Array in shader-declaration order, and
// asserts its float count so a shader-block edit is caught loudly.

const CORK_UNIFORM_FLOATS = 23;
const NOTE_UNIFORM_FLOATS = 31;
const TACK_UNIFORM_FLOATS = 10;

/** Pure. Asserts `v` is a finite number (a NaN uniform silently blackens a whole
 * region — fail loudly). Returns `v`. */
function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`corkboard pack: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Pure. A colour knob (string/array) -> its rgb triple [r,g,b], via the shared
 * node-safe parseColor. Alpha is dropped (the shaders are opaque fills). */
function rgb(name, v) {
  const c = parseColor(v);
  return [num(name + ".r", c[0]), num(name + ".g", c[1]), num(name + ".b", c[2])];
}

/** Pure. A light-direction ANGLE (radians, TO the light) -> a unit screen vector
 * [cos, sin]. One equation-friendly knob instead of a raw 2-vector. */
function lightVec(u) {
  const a = num("lightAngle", u.lightAngle);
  return [Math.cos(a), Math.sin(a)];
}

/**
 * Pure function. Packs the cork material's uniforms (CORK_SKSL declaration order).
 * WORLD-px knobs (frameWidth) are scaled to device by `u.scale`; frequency knobs
 * (grainScale/mottleScale) are cycles-per-world-unit and pass through.
 *
 * @param {object} u {cx,cy,halfW,halfH,cornerRadius,angle,scale, seed,grainScale,
 *   mottleScale,mottleStrength,pitStrength,fleckStrength,baseColor,vignette,
 *   frameWidth,frameColor,lightAngle}
 * @returns {Float32Array} length 23
 *
 * @example packCork({cx:0,cy:0,halfW:100,halfH:80,cornerRadius:10,angle:0,scale:1,
 *   seed:7,grainScale:0.2,mottleScale:0.02,mottleStrength:0.12,pitStrength:0.34,
 *   fleckStrength:0.24,baseColor:"#be8f56",vignette:0.2,frameWidth:20,
 *   frameColor:"#5c3a1e",lightAngle:-2.16}).length // 23
 */
export function packCork(u) {
  const base = rgb("baseColor", u.baseColor), frame = rgb("frameColor", u.frameColor), light = lightVec(u);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    num("scale", u.scale),
    num("seed", u.seed),
    num("grainScale", u.grainScale), num("mottleScale", u.mottleScale),
    num("mottleStrength", u.mottleStrength), num("pitStrength", u.pitStrength), num("fleckStrength", u.fleckStrength),
    base[0], base[1], base[2],
    num("vignette", u.vignette),
    num("frameWidth", u.frameWidth) * u.scale,
    frame[0], frame[1], frame[2],
    light[0], light[1],
  ]);
  if (out.length !== CORK_UNIFORM_FLOATS) throw new Error(`packCork: ${out.length} floats, expected ${CORK_UNIFORM_FLOATS}`);
  return out;
}

/**
 * Pure function. Packs the note material's uniforms (NOTE_SKSL declaration order).
 * WORLD-px geometry knobs (ruleSpacing, marginX, hole radius/spacing/inset, rip
 * strength, curlSize) are scaled to device by `u.scale`; a negative marginX
 * (= "no margin") passes through unscaled.
 *
 * @param {object} u device geometry + note knobs (see NOTE_SKSL uniforms)
 * @returns {Float32Array} length 31
 *
 * @example packNote({cx:0,cy:0,halfW:120,halfH:150,cornerRadius:4,angle:0,scale:1,
 *   seed:3,paperColor:"#f8f6ee",lightAngle:-2.16,ruleSpacing:26,ruleStrength:0.5,
 *   ruleColor:"#7896be",marginX:34,marginColor:"#c85a5a",holeRadius:0,holeSpacing:60,
 *   holeInset:22,ripStrength:12,ripScale:0.1,curlAmount:0.7,curlSize:150,
 *   curlDir:[1,-1]}).length // 31
 */
export function packNote(u) {
  const paper = rgb("paperColor", u.paperColor), ruleC = rgb("ruleColor", u.ruleColor), marginC = rgb("marginColor", u.marginColor);
  const light = lightVec(u), s = num("scale", u.scale);
  const marginX = num("marginX", u.marginX);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius),
    num("angle", u.angle),
    s,
    num("seed", u.seed),
    paper[0], paper[1], paper[2],
    light[0], light[1],
    num("ruleSpacing", u.ruleSpacing) * s, num("ruleStrength", u.ruleStrength),
    ruleC[0], ruleC[1], ruleC[2],
    marginX < 0 ? marginX : marginX * s,
    marginC[0], marginC[1], marginC[2],
    num("holeRadius", u.holeRadius) * s, num("holeSpacing", u.holeSpacing) * s, num("holeInset", u.holeInset) * s,
    num("ripStrength", u.ripStrength) * s, num("ripScale", u.ripScale),
    num("curlAmount", u.curlAmount), num("curlSize", u.curlSize) * s,
    num("curlDirX", u.curlDir[0]), num("curlDirY", u.curlDir[1]),
  ]);
  if (out.length !== NOTE_UNIFORM_FLOATS) throw new Error(`packNote: ${out.length} floats, expected ${NOTE_UNIFORM_FLOATS}`);
  return out;
}

/**
 * Pure function. Packs the thumbtack material's uniforms (TACK_SKSL declaration
 * order). All geometry is already device px (uRadius = halfW); no world-unit knobs.
 *
 * @param {object} u {cx,cy,halfW,halfH,scale, domeGain,color,shininess,lightAngle}
 * @returns {Float32Array} length 10
 *
 * @example packTack({cx:0,cy:0,halfW:20,halfH:20,scale:1,domeGain:0.95,
 *   color:"#d22d2d",shininess:20,lightAngle:-2.16}).length // 10
 */
export function packTack(u) {
  const color = rgb("color", u.color), light = lightVec(u);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy),
    num("radius", u.halfW),
    num("domeGain", u.domeGain),
    color[0], color[1], color[2],
    num("shininess", u.shininess),
    light[0], light[1],
  ]);
  if (out.length !== TACK_UNIFORM_FLOATS) throw new Error(`packTack: ${out.length} floats, expected ${TACK_UNIFORM_FLOATS}`);
  return out;
}

// ── PROXY stand-ins (thumbnail quality) ─────────────────────────────────────────
// The corkboard family is lighter than the sky/flare shaders but still runs 4-octave
// fbm per pixel — non-trivial over a whole thumbnail. Their look is DOMINATED by one
// flat colour, so the proxy is that colour: cork/note fill their rounded-rect box
// (solid); the thumbtack is a DISC (radial → transparent rim, so it reads round and
// does not occlude the board behind it). No SkSL. paint_skia.js draws the spec.
const PROXY_TACK_RIM_ALPHA = 0.9; // alpha at the tack-disc rim before the soft transparent falloff

/**
 * Pure function. The corkboard PROXY spec: a solid fill of the board's base tan.
 *
 * @param {object} params - the board's op params ({baseColor, ...})
 * @returns {{kind:"solid", color:[number,number,number,number]}}
 *
 * @example corkboardProxyFill({baseColor: "#be8f56"}).kind // "solid"
 * @example corkboardProxyFill({}).color[3] // 1 (opaque board)
 */
export function corkboardProxyFill(params) {
  const c = parseColor(params.baseColor ?? "#be8f56");
  return { kind: "solid", color: [c[0], c[1], c[2], 1] };
}

/**
 * Pure function. The corkboardNote PROXY spec: a solid fill of the paper tone.
 *
 * @param {object} params - the note's op params ({paperColor, ...})
 * @returns {{kind:"solid", color:[number,number,number,number]}}
 *
 * @example corkboardNoteProxyFill({paperColor: "#f8f6ee"}).kind // "solid"
 * @example corkboardNoteProxyFill({}).color[3] // 1 (opaque paper)
 */
export function corkboardNoteProxyFill(params) {
  const c = parseColor(params.paperColor ?? "#f8f6ee");
  return { kind: "solid", color: [c[0], c[1], c[2], 1] };
}

/**
 * Pure function. The corkboardThumbtack PROXY spec: a small radial disc of the tack
 * colour fading to transparent at the rim, so it reads as a round tack over the board
 * rather than a coloured square. Coordinates are in the region's LOCAL space.
 *
 * @param {object} params - the tack's op params ({color, ...})
 * @param {{cx:number, cy:number, halfW:number, halfH:number}} region - local-space geometry
 * @returns {{kind:"radial", cx:number, cy:number, radius:number, stops:Array<{offset:number, color:[number,number,number,number]}>}}
 *
 * @example corkboardThumbtackProxyFill({color: "#d22d2d"}, {cx: 20, cy: 20, halfW: 20, halfH: 20}).kind // "radial"
 * @example corkboardThumbtackProxyFill({color: "#d22d2d"}, {cx: 0, cy: 0, halfW: 20, halfH: 20}).radius // 20
 */
export function corkboardThumbtackProxyFill(params, region) {
  const c = parseColor(params.color ?? "#d22d2d");
  const radius = Math.max(Math.min(region.halfW, region.halfH), 1);
  return {
    kind: "radial",
    cx: region.cx, cy: region.cy, radius,
    stops: [
      { offset: 0, color: [c[0], c[1], c[2], 1] },
      { offset: PROXY_TACK_RIM_ALPHA, color: [c[0], c[1], c[2], PROXY_TACK_RIM_ALPHA] },
      { offset: 1, color: [c[0], c[1], c[2], 0] },
    ],
  };
}

// ── FILL-MATERIAL SCHEMAS (materials as PAINT on any shape) ──────────────────────
// The look knobs of the fill-capable family members, in the customProps row shape —
// the ONE declaration both consumers derive from (the end-state ruling: "custom
// properties become material properties"): plugins/demo/corkboard.js spreads each into
// its widget customProps (self.* rows), and the FILL-material UI (PaintField) renders
// it as the paint's param rows, resolved sparse-over-defaults by resolveMaterialPaint.
// The board and the thumbtack opt in; both are FOREGROUND fills that synthesize their
// whole look from uniforms. Their schema knob NAMES equal the packer's own param keys
// (packCork / packTack read them straight), and no knob needs a unit conversion — the
// light angle is stored in radians and the packer's lightVec reads radians — so NEITHER
// declares `toUniformParams`: the framework passes the resolved params to `pack`
// unchanged. Widget-side keys stay in the plugin: the region's `cornerRadius` is
// GEOMETRY (a fill's shape IS its geometry; a shape fill carries cornerRadius 0 and the
// clip shapes it), and the note/tack drop-shadow is a materialFill `shadow` descriptor,
// which a shape fill does not carry. (The NOTE is deliberately NOT opted in: its
// curlCorner→curlDir select mapping plus its interleaved widget-only shadow knobs make
// it widget-specific, not a trivial identity like these two.)
//
// The family's SINGLE light lives here beside the schema that defaults to it: the
// direction TO the light in SCREEN space, upper-left (design Part 3). cork / note / tack
// / yarn all default their `lightAngle` to it, so the whole family shares one look yet
// each knob stays independently overridable / equation-bindable.
export const FAMILY_LIGHT_ANGLE = Math.atan2(-0.83, -0.55); // ≈ -2.157 rad; dir ≈ (-0.55, -0.83)

/**
 * THE CORKBOARD (board) FILL-PARAM SCHEMA — every packCork look knob EXCEPT the
 * region cornerRadius (widget geometry). Schema names = packCork's param keys, so
 * the identity resolved-params map feeds the packer directly (no toUniformParams).
 */
export const CORK_FILL_PARAMS = [
  { name: "baseColor", kind: "color", default: "rgb(190,143,86)", help: "The warm tan base tone of the cork panel (before the granular texture)." },
  { name: "grainScale", kind: "number", default: 0.2, min: 0, help: "Granule frequency (cycles per world unit) — the fine mm-scale speckle that is cork's dominant signature. Higher = finer, denser granules." },
  { name: "mottleScale", kind: "number", default: 0.02, min: 0, help: "Coarse blotch frequency (cycles per world unit) — the gentle cm-scale tone drift beneath the granules." },
  { name: "mottleStrength", kind: "number", default: 0.12, min: 0, max: 1, help: "How strong the coarse tone drift is. Keep LOW — too high and the board reads as smoke instead of cork." },
  { name: "pitStrength", kind: "number", default: 0.34, min: 0, max: 1, help: "Density/darkness of the small dark pores between granules." },
  { name: "fleckStrength", kind: "number", default: 0.24, min: 0, max: 1, help: "Brightness of the pale granule faces catching the light." },
  { name: "vignette", kind: "number", default: 0.2, min: 0, max: 1, help: "Inner-edge darkening, so the board reads as an inset panel." },
  { name: "frameWidth", kind: "number", default: 26, min: 0, help: "Width (world px) of the dark wood frame rim around the board. 0 = no frame." },
  { name: "frameColor", kind: "color", default: "rgb(92,58,30)", help: "The colour of the wood frame rim." },
  { name: "seed", kind: "number", default: 7, help: "Texture seed — changes the granule pattern deterministically (NOT animated)." },
  { name: "lightAngle", kind: "angle", display: "degrees", default: FAMILY_LIGHT_ANGLE, help: "Direction TO the family light (screen space; upper-left by default). Drives the shading + shadow direction of the whole family." },
];

/**
 * THE THUMBTACK FILL-PARAM SCHEMA — packTack's four look knobs (the head is a DISK,
 * so it exposes no region cornerRadius; its contact shadow is a widget-side descriptor,
 * not a knob). Schema names = packTack's param keys ⇒ identity, no toUniformParams.
 * There is deliberately NO `seed` row: a tack head is a smooth plastic dome with no
 * procedural texture to decorrelate (TACK_SKSL reads no seed; measured byte-identical
 * across seeds) — an Inspector control that promised a change and delivered none.
 */
export const TACK_FILL_PARAMS = [
  { name: "color", kind: "color", default: "rgb(210,45,45)", help: "The plastic head colour of the pin." },
  { name: "domeGain", kind: "number", default: 0.95, min: 0, max: 1, help: "Press-in DEPTH, 1 = fully out/proud (a tall glossy dome), low = pushed in flat. ANIMATE this: it flattens the dome AND shrinks the contact shadow." },
  { name: "shininess", kind: "number", default: 20, min: 1, scrub: 0.5, help: "Glossiness of the head's specular hotspot — higher = a tighter, brighter highlight." },
  { name: "lightAngle", kind: "angle", display: "degrees", default: FAMILY_LIGHT_ANGLE, help: "Direction TO the light (screen space). Shared with the family; places the hotspot and the contact shadow." },
];

// ── material descriptors (registry entries) ─────────────────────────────────────
// FOREGROUND materials: `backdrop: false` tells the framework to bind NO children
// and the materialFill handler to skip the below-content re-render. `id` matches
// the plugin's `material` op field. `proxyFill` gives each a cheap thumbnail stand-in.
// `fillParams` opts a material into being PAINT on any shape (cork + tack; both identity
// mappings ⇒ no toUniformParams). The NOTE stays widget-only (see the schema note above).
export const CORK_MATERIAL = { id: "corkboard", sksl: CORK_SKSL, pack: packCork, uniformFloats: CORK_UNIFORM_FLOATS, backdrop: false, proxyFill: corkboardProxyFill, fillParams: CORK_FILL_PARAMS, usesShapeSdf: true, fillSksl: CORK_FILL_SKSL };
export const NOTE_MATERIAL = { id: "corkboardNote", sksl: NOTE_SKSL, pack: packNote, uniformFloats: NOTE_UNIFORM_FLOATS, backdrop: false, proxyFill: corkboardNoteProxyFill };
export const TACK_MATERIAL = { id: "corkboardThumbtack", sksl: TACK_SKSL, pack: packTack, uniformFloats: TACK_UNIFORM_FLOATS, backdrop: false, proxyFill: corkboardThumbtackProxyFill, fillParams: TACK_FILL_PARAMS, usesShapeSdf: true, fillSksl: TACK_FILL_SKSL };
