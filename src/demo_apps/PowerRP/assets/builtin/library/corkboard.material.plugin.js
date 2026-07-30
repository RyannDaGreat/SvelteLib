/**
 * CORKBOARD — the pinboard FOREGROUND material, as a plugin ASSET.
 *
 * A FOREGROUND material (`backdrop: false`): no children, no backdrop re-render, so it
 * declares no sample reach. Its packer needs three declarative hatches:
 *   · `scale` is packed as a uniform in its OWN right (the shader scales its noise by
 *     it), which the block names directly — the framework already puts u.scale in scope.
 *   · frameWidth is a WORLD-px length -> `scaleByDevice: true`.
 *   · lightAngle packs as its unit DIRECTION [cos, sin] (packCork's lightVec) -> a
 *     size-2 slot declaring `asVector`, which is a unit conversion on an angle in the
 *     same family as `unit: "degrees"`, not a computation over other knobs.
 * baseColor / frameColor pack as THREE floats each.
 *
 * Its `proxyFill` hook is NOT migrated and does not need to be: it returns the mean of
 * the params' colours, which is exactly what materials.defaultProxyFill computes for a
 * material declaring none — see the migration report.
 *
 * GENERATED from the shipped module by scratchpad/gen_materials.mjs — the SkSL and the
 * knob schema are copied, never retyped, so they are byte-identical by construction.
 * COPY THIS FILE to start a new material: the Explorer's built-in tiles offer
 * "Save a Copy", which rewrites the id so the copy registers beside this one.
 */

return {
  "kind": "material",

  "id": "corkboard",

  "title": "Corkboard",

  "params": [
    {
      "name": "baseColor",
      "kind": "color",
      "default": "rgb(190,143,86)",
      "help": "The warm tan base tone of the cork panel (before the granular texture)."
    },
    {
      "name": "grainScale",
      "kind": "number",
      "default": 0.2,
      "min": 0,
      "help": "Granule frequency (cycles per world unit) — the fine mm-scale speckle that is cork's dominant signature. Higher = finer, denser granules."
    },
    {
      "name": "mottleScale",
      "kind": "number",
      "default": 0.02,
      "min": 0,
      "help": "Coarse blotch frequency (cycles per world unit) — the gentle cm-scale tone drift beneath the granules."
    },
    {
      "name": "mottleStrength",
      "kind": "number",
      "default": 0.12,
      "min": 0,
      "max": 1,
      "help": "How strong the coarse tone drift is. Keep LOW — too high and the board reads as smoke instead of cork."
    },
    {
      "name": "pitStrength",
      "kind": "number",
      "default": 0.34,
      "min": 0,
      "max": 1,
      "help": "Density/darkness of the small dark pores between granules."
    },
    {
      "name": "fleckStrength",
      "kind": "number",
      "default": 0.24,
      "min": 0,
      "max": 1,
      "help": "Brightness of the pale granule faces catching the light."
    },
    {
      "name": "vignette",
      "kind": "number",
      "default": 0.2,
      "min": 0,
      "max": 1,
      "help": "Inner-edge darkening, so the board reads as an inset panel."
    },
    {
      "name": "frameWidth",
      "kind": "number",
      "default": 26,
      "min": 0,
      "help": "Width (world px) of the dark wood frame rim around the board. 0 = no frame."
    },
    {
      "name": "frameColor",
      "kind": "color",
      "default": "rgb(92,58,30)",
      "help": "The colour of the wood frame rim."
    },
    {
      "name": "seed",
      "kind": "number",
      "default": 7,
      "help": "Texture seed — changes the granule pattern deterministically (NOT animated)."
    },
    {
      "name": "lightAngle",
      "kind": "angle",
      "display": "degrees",
      "default": -2.156013422226456,
      "help": "Direction TO the family light (screen space; upper-left by default). Drives the shading + shadow direction of the whole family."
    }
  ],

  "uniforms": [
    {
      "name": "cx",
      "size": 1
    },
    {
      "name": "cy",
      "size": 1
    },
    {
      "name": "halfW",
      "size": 1
    },
    {
      "name": "halfH",
      "size": 1
    },
    {
      "name": "cornerRadius",
      "size": 1
    },
    {
      "name": "angle",
      "size": 1
    },
    {
      "name": "scale",
      "size": 1
    },
    {
      "name": "seed",
      "size": 1
    },
    {
      "name": "grainScale",
      "size": 1
    },
    {
      "name": "mottleScale",
      "size": 1
    },
    {
      "name": "mottleStrength",
      "size": 1
    },
    {
      "name": "pitStrength",
      "size": 1
    },
    {
      "name": "fleckStrength",
      "size": 1
    },
    {
      "name": "baseColor",
      "size": 3
    },
    {
      "name": "vignette",
      "size": 1
    },
    {
      "name": "frameWidth",
      "size": 1,
      "scaleByDevice": true
    },
    {
      "name": "frameColor",
      "size": 3
    },
    {
      "name": "lightAngle",
      "size": 2,
      "asVector": true
    }
  ],

  "backdrop": false,

  "usesShapeSdf": true,

  "sksl": "\nconst float HASH_MUL_X = 123.34;    // hash mixing constants (standard shader-art value hash)\nconst float HASH_MUL_Y = 456.21;\nconst float HASH_ADD    = 45.32;\nconst int   FBM_OCTAVES = 4;         // octaves of value noise summed for the grain\nconst float FBM_GAIN    = 0.5;       // amplitude falloff per octave (pink-ish spectrum)\nconst float FBM_LACUNARITY = 2.0;    // frequency growth per octave\nconst float SMOOTH3 = 3.0;           // cubic smoothstep coefficients for value-noise interpolation\nconst float SMOOTH2 = 2.0;\n\n// Pure. Deterministic 2D hash -> [0,1). Same p => same value on a given backend.\nfloat hash21(float2 p) {\n  p = fract(p * float2(HASH_MUL_X, HASH_MUL_Y));\n  p += dot(p, p + HASH_ADD);\n  return fract(p.x * p.y);\n}\n// Pure. Value noise in [0,1] with smooth (cubic) interpolation of a hash lattice.\nfloat vnoise(float2 x) {\n  float2 i = floor(x), f = fract(x);\n  float2 u = f * f * (SMOOTH3 - SMOOTH2 * f);\n  float a = hash21(i), b = hash21(i + float2(1.0, 0.0));\n  float c = hash21(i + float2(0.0, 1.0)), d = hash21(i + float2(1.0, 1.0));\n  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n}\n// Pure. Fractal Brownian motion: FBM_OCTAVES of value noise. Range ~[0,1].\nfloat fbm(float2 x) {\n  float s = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;\n  for (int o = 0; o < FBM_OCTAVES; o++) {\n    s += amp * vnoise(x * freq);\n    norm += amp; freq *= FBM_LACUNARITY; amp *= FBM_GAIN;\n  }\n  return s / norm;\n}\n// Pure. Diffuse+specular for a unit surface normal N (3D) lit by direction L (TO\n// the light, 3D unit), viewer straight-on (+Z). Returns (diffuse, specular).\nfloat2 litDiffSpec(float3 N, float3 L, float shininess) {\n  float diff = max(dot(N, L), 0.0);\n  float3 V = float3(0.0, 0.0, 1.0);\n  float3 H = normalize(L + V);\n  float spec = pow(max(dot(N, H), 0.0), shininess) * step(0.0, diff);\n  return float2(diff, spec);\n}\n// Pure. Rotate a 2-vector by angle a (rows: [c -s; s c]).\nfloat2 rot2(float2 v, float a) {\n  float c = cos(a), s = sin(a);\n  return float2(c * v.x - s * v.y, s * v.x + c * v.y);\n}\n// Pure. Rounded-rect SDF (iq). <0 inside. p LOCAL & centered.\nfloat sdRoundRect(float2 p, float2 h, float r) {\n  float2 q = abs(p) - (h - r);\n  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;\n}\n\nconst float PIT_SHARPNESS = 1.7;     // exponent -> dark PORES between granules\nconst float FLECK_SHARPNESS = 2.1;   // exponent -> bright granule faces catching light\nconst float PIT_FREQ = 2.2;          // pore frequency as a multiple of the base granule frequency\nconst float FLECK_FREQ = 2.9;        // fleck frequency multiple (finer still than pores)\nconst float GRANULE_CONTRAST = 0.17; // light/dark modulation of the mm-scale granules — cork's DOMINANT signature\nconst float GRANULE_ANISO = 0.55;    // x-scale for fleck coords: <1 stretches granules horizontally (real cork reads slightly elongated)\nconst float TOPLIGHT_GRAD = 0.06;    // strength of the gentle top-to-bottom light gradient (cork is nearly matte)\nconst float PIT_OFFSET = 91.0;       // lattice decorrelation offset for the pore field\nconst float FLECK_OFFSET = 133.0;    // lattice decorrelation offset for the fleck field\nconst float VIGNETTE_SPAN = 0.5;     // vignette falloff span as a fraction of the smaller half-size\n\nuniform float2 uCenter;              // board center (device px)\nuniform float2 uHalfSize;            // board half-extents (device px)\nuniform float  uCornerRadius;        // rounded-rect radius (device px)\nuniform float  uAngle;               // widget world rotation (radians)\nuniform float  uTexScale;            // device px per WORLD unit (texture is world-locked)\nuniform float  uSeed;                // texture seed (deterministic; NOT time)\nuniform float  uGrainScale;          // granule frequency (cycles per WORLD unit)\nuniform float  uMottleScale;         // coarse blotch frequency (cycles per WORLD unit)\nuniform float  uMottleStrength;      // 0..1 how much the coarse blotches drift the base tone\nuniform float  uPitStrength;         // 0..1 depth of the dark pits\nuniform float  uFleckStrength;       // 0..1 brightness of the pale flecks\nuniform float3 uBaseColor;           // cork base tone (0..1), warm tan\nuniform float  uVignette;            // 0..1 inner-edge darkening (inset-panel look)\nuniform float  uFrameWidth;          // dark rim (frame) width in device px (0 = none)\nuniform float3 uFrameColor;          // frame tone (0..1)\nuniform float2 uLightDir;            // direction TO the light in SCREEN space, upper-left default\n\nhalf4 main(float2 fragCoord) {\n  float2 p = rot2(fragCoord - uCenter, -uAngle);   // device -> widget-local, centered\n  float d = sdRoundRect(p, uHalfSize, uCornerRadius);\n  float cov = 1.0 - smoothstep(-1.0, 1.0, d);\n  if (cov <= 0.0) return half4(0.0);\n\n  // Board-local WORLD coords (pan-stable, zoom-locked) + seed decorrelation.\n  float2 tc = p / uTexScale + uSeed;\n  float2 aniso = float2(GRANULE_ANISO, 1.0);\n  float mottle  = fbm(tc * uMottleScale);\n  float granule = fbm(tc * aniso * uGrainScale);\n  float pit     = pow(fbm(tc * uGrainScale * PIT_FREQ + PIT_OFFSET), PIT_SHARPNESS);\n  float fleck   = pow(fbm(tc * aniso * uGrainScale * FLECK_FREQ + FLECK_OFFSET), FLECK_SHARPNESS);\n\n  half3 col = half3(uBaseColor);\n  col *= half(1.0 + uMottleStrength * (mottle - 0.5) * 2.0);     // gentle cm-scale tone drift\n  col *= half(1.0 + GRANULE_CONTRAST * (granule - 0.5) * 2.0);   // agglomerated granule faces (dominant)\n  col -= half3(uPitStrength * pit);                              // small dark pores between granules\n  col += half3(uFleckStrength * fleck);                          // bright granule faces catching light\n\n  float grad = dot(normalize(p + float2(0.0001)), normalize(uLightDir));\n  col += half3(TOPLIGHT_GRAD * grad * 0.5);                      // gentle directional top-light\n\n  float distIn = -d;\n  float vig = smoothstep(0.0, min(uHalfSize.x, uHalfSize.y) * VIGNETTE_SPAN, distIn);\n  col *= half(mix(1.0 - uVignette, 1.0, vig));                   // inner-edge vignette\n\n  if (uFrameWidth > 0.0) {\n    float rim = 1.0 - smoothstep(uFrameWidth - 1.0, uFrameWidth + 1.0, distIn);\n    col = mix(col, half3(uFrameColor), half(rim));               // dark wood rim\n  }\n  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov));\n}\n",

  "fillSksl": "\nconst float HASH_MUL_X = 123.34;    // hash mixing constants (standard shader-art value hash)\nconst float HASH_MUL_Y = 456.21;\nconst float HASH_ADD    = 45.32;\nconst int   FBM_OCTAVES = 4;         // octaves of value noise summed for the grain\nconst float FBM_GAIN    = 0.5;       // amplitude falloff per octave (pink-ish spectrum)\nconst float FBM_LACUNARITY = 2.0;    // frequency growth per octave\nconst float SMOOTH3 = 3.0;           // cubic smoothstep coefficients for value-noise interpolation\nconst float SMOOTH2 = 2.0;\n\n// Pure. Deterministic 2D hash -> [0,1). Same p => same value on a given backend.\nfloat hash21(float2 p) {\n  p = fract(p * float2(HASH_MUL_X, HASH_MUL_Y));\n  p += dot(p, p + HASH_ADD);\n  return fract(p.x * p.y);\n}\n// Pure. Value noise in [0,1] with smooth (cubic) interpolation of a hash lattice.\nfloat vnoise(float2 x) {\n  float2 i = floor(x), f = fract(x);\n  float2 u = f * f * (SMOOTH3 - SMOOTH2 * f);\n  float a = hash21(i), b = hash21(i + float2(1.0, 0.0));\n  float c = hash21(i + float2(0.0, 1.0)), d = hash21(i + float2(1.0, 1.0));\n  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n}\n// Pure. Fractal Brownian motion: FBM_OCTAVES of value noise. Range ~[0,1].\nfloat fbm(float2 x) {\n  float s = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;\n  for (int o = 0; o < FBM_OCTAVES; o++) {\n    s += amp * vnoise(x * freq);\n    norm += amp; freq *= FBM_LACUNARITY; amp *= FBM_GAIN;\n  }\n  return s / norm;\n}\n// Pure. Diffuse+specular for a unit surface normal N (3D) lit by direction L (TO\n// the light, 3D unit), viewer straight-on (+Z). Returns (diffuse, specular).\nfloat2 litDiffSpec(float3 N, float3 L, float shininess) {\n  float diff = max(dot(N, L), 0.0);\n  float3 V = float3(0.0, 0.0, 1.0);\n  float3 H = normalize(L + V);\n  float spec = pow(max(dot(N, H), 0.0), shininess) * step(0.0, diff);\n  return float2(diff, spec);\n}\n// Pure. Rotate a 2-vector by angle a (rows: [c -s; s c]).\nfloat2 rot2(float2 v, float a) {\n  float c = cos(a), s = sin(a);\n  return float2(c * v.x - s * v.y, s * v.x + c * v.y);\n}\n// Pure. Rounded-rect SDF (iq). <0 inside. p LOCAL & centered.\nfloat sdRoundRect(float2 p, float2 h, float r) {\n  float2 q = abs(p) - (h - r);\n  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;\n}\n\nconst float PIT_SHARPNESS = 1.7;\nconst float FLECK_SHARPNESS = 2.1;\nconst float PIT_FREQ = 2.2;\nconst float FLECK_FREQ = 2.9;\nconst float GRANULE_CONTRAST = 0.17;\nconst float GRANULE_ANISO = 0.55;\nconst float TOPLIGHT_GRAD = 0.06;\nconst float PIT_OFFSET = 91.0;\nconst float FLECK_OFFSET = 133.0;\nconst float VIGNETTE_SPAN = 0.5;\n\nuniform shader shapeSdf;             // child 0: silhouette signed distance (device px, <0 inside)\nuniform float2 uCenter;\nuniform float2 uHalfSize;\nuniform float  uCornerRadius;        // unused in the fill variant (the SDF is the silhouette)\nuniform float  uAngle;\nuniform float  uTexScale;\nuniform float  uSeed;\nuniform float  uGrainScale;\nuniform float  uMottleScale;\nuniform float  uMottleStrength;\nuniform float  uPitStrength;\nuniform float  uFleckStrength;\nuniform float3 uBaseColor;\nuniform float  uVignette;\nuniform float  uFrameWidth;\nuniform float3 uFrameColor;\nuniform float2 uLightDir;\n\nhalf4 main(float2 fragCoord) {\n  float2 p = rot2(fragCoord - uCenter, -uAngle);   // widget-local (for the world-locked texture)\n  float d = shapeSdf.eval(fragCoord).r;            // silhouette distance (device px, <0 inside)\n  float cov = 1.0 - smoothstep(-1.0, 1.0, d);\n  if (cov <= 0.0) return half4(0.0);\n\n  float2 tc = p / uTexScale + uSeed;\n  float2 aniso = float2(GRANULE_ANISO, 1.0);\n  float mottle  = fbm(tc * uMottleScale);\n  float granule = fbm(tc * aniso * uGrainScale);\n  float pit     = pow(fbm(tc * uGrainScale * PIT_FREQ + PIT_OFFSET), PIT_SHARPNESS);\n  float fleck   = pow(fbm(tc * aniso * uGrainScale * FLECK_FREQ + FLECK_OFFSET), FLECK_SHARPNESS);\n\n  half3 col = half3(uBaseColor);\n  col *= half(1.0 + uMottleStrength * (mottle - 0.5) * 2.0);\n  col *= half(1.0 + GRANULE_CONTRAST * (granule - 0.5) * 2.0);\n  col -= half3(uPitStrength * pit);\n  col += half3(uFleckStrength * fleck);\n\n  float grad = dot(normalize(p + float2(0.0001)), normalize(uLightDir));\n  col += half3(TOPLIGHT_GRAD * grad * 0.5);\n\n  float distIn = -d;                               // interior distance from the SILHOUETTE\n  float vig = smoothstep(0.0, min(uHalfSize.x, uHalfSize.y) * VIGNETTE_SPAN, distIn);\n  col *= half(mix(1.0 - uVignette, 1.0, vig));      // inner-edge vignette follows the outline\n\n  if (uFrameWidth > 0.0) {\n    float rim = 1.0 - smoothstep(uFrameWidth - 1.0, uFrameWidth + 1.0, distIn);\n    col = mix(col, half3(uFrameColor), half(rim));  // dark wood rim traces every tooth/notch\n  }\n  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov));\n}\n",
};
