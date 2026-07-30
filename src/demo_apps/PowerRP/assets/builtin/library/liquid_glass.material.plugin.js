/**
 * LIQUID GLASS — the material plugin. THE PROOF that a material can be an ASSET:
 * a shader you can open, read and copy from inside the editor, exactly as the user
 * ruling asked ("It would be really cool if we could refactor liquid glass as a
 * plugin... then the user could actually edit the shader inside the UI, and copy
 * that built-in plugin into a new one").
 *
 * ── IT IS DATA, NOT CODE ─────────────────────────────────────────────────────
 * Everything below is a value. The two SkSL sources are STRINGS (Skia compiles
 * them; the plugin jail never sees them as code), the knob schema is an array, and
 * the four hooks the built-in descriptor declared as FUNCTIONS are declared here as
 * DATA — see core/material_plugins.js for why no JS may run on the render path:
 *
 *   pack + uniformFloats  -> `uniforms`, the ordered block below. Two entries carry
 *                            `scaleByDevice` because they are WORLD-px lengths the
 *                            packer scales by u.scale (packGlassMaterial did exactly
 *                            this for edgeFalloff and refractionStrength).
 *   toUniformParams       -> per-param `unit: "degrees"` (lightAngle), `omit: true`
 *                            (blurRadius/backdropScale are OP-level, not uniforms),
 *                            `uniform:` renames, and `fixed` for the three constants
 *                            a fill pins.
 *   maxSampleReach        -> the declared product below. NOT COSMETIC: without it the
 *                            backdrop re-render silently goes FULL-SURFACE
 *                            (materials.js materialSampleReach), which measured
 *                            1,036,800 offscreen px for a panel whose own footprint
 *                            is 38,400.
 *   proxyBackdrop         -> {fromParam: "tint"}. Without it every thumbnail gets the
 *                            shared translucent WHITE, so a dark glass preset shows up
 *                            LIGHTER in its own thumbnail — the exact defect
 *                            materials.js:456 exists to end.
 *
 * ── THE SkSL IS THE SHIPPED SHADER, VERBATIM ─────────────────────────────────
 * Both sources are byte-identical to render_gpu/skia/glass_shader.js's GLASS_SKSL
 * and GLASS_FILL_SKSL, and tests/material_plugin_test.js pins that: a document using
 * glass renders the SAME ops before and after this migration. Read the shader module's
 * header for what the shader actually does — the optics, the squircle SDF, and why
 * the region boundary is one curve defined twice (once in SkSL, once in JS).
 *
 * COPY THIS FILE to start a new material: the Asset Explorer's built-in tiles offer
 * "Save a Copy", which rewrites the `id` so the copy registers beside this one
 * instead of being refused as a shadow of it.
 */

// The refraction PRE_BULGE — the constant maxSampleReach multiplies by. It is
// interpolated into the shader source below too, so the reach declaration and the
// shader read the same number (glass_shader.js GLASS_PRE_BULGE).
const PRE_BULGE = 1.7;

return {
  kind: "material",
  id: "glass",
  title: "Liquid Glass",

  // THE KNOB SCHEMA — the ONE declaration the paint dropdown's param rows and the
  // uniform packing both read.
  params: [
    {
      "name": "blurRadius",
      "kind": "number",
      "default": 8,
      "min": 0,
      "help": "Gaussian blur radius (world px) of the backdrop seen THROUGH the glass. Moderate keeps it readable — Liquid Glass is a frost, not an opaque blur.",
      "omit": true
    },
    {
      "name": "refractionStrength",
      "kind": "number",
      "default": 14,
      "min": 0,
      "help": "Maximum edge displacement (world px). The defining Liquid Glass trait: surrounding content bends inward at the rim (strong at the border, ~0 in the interior). For a fill the rim is the shape's bbox edge."
    },
    {
      "name": "edgeFalloff",
      "kind": "number",
      "default": 22,
      "min": 0,
      "help": "How far inward (world px) the refraction + specular band decays. Larger = a wider bevelled rim."
    },
    {
      "name": "lightAngle",
      "kind": "angle",
      "default": -111.6,
      "help": "Direction TO the light (degrees, screen space; -90° is straight above, 0° from the right). The lit edge catches the thin bright highlight.",
      "unit": "degrees"
    },
    {
      "name": "lightIntensity",
      "kind": "number",
      "default": 0.8,
      "min": 0,
      "step": 0.01,
      "help": "Strength of the top-light specular (the thin rim hairline + the broad soft sheen)."
    },
    {
      "name": "tint",
      "kind": "color",
      "default": "rgba(255,255,255,0.14)",
      "help": "The glass skin's colour CAST (rgb) and STRENGTH (alpha). The neutral is luminance-adaptive — pale over dark content, smoky over light — and this tints it; keep the alpha low for clarity."
    },
    {
      "name": "saturation",
      "kind": "number",
      "default": 0.92,
      "min": 0,
      "max": 1,
      "step": 0.01,
      "help": "How much backdrop colour is kept (1 = unchanged, 0 = gray). Slightly below 1 for the subtle frosted desaturation."
    },
    {
      "name": "sheen",
      "kind": "number",
      "default": 0.1,
      "min": 0,
      "step": 0.01,
      "help": "Strength of the broad surface sheen (the soft gradient of light across the face). Kept low so the interior stays clear."
    },
    {
      "name": "specularPower",
      "kind": "number",
      "default": 8,
      "min": 1,
      "help": "Tightness of the edge specular lobe: higher = a thinner, crisper bright hairline on the lit edge.",
      "uniform": "specPower"
    },
    {
      "name": "contactShadow",
      "kind": "number",
      "default": 0.26,
      "min": 0,
      "step": 0.01,
      "help": "Darkness of the faint contact shadow on the edge OPPOSITE the light (the glass sitting on the surface)."
    },
    {
      "name": "caustic",
      "kind": "number",
      "default": 0.12,
      "min": 0,
      "step": 0.01,
      "help": "How much SHARP (unblurred) backdrop bleeds into the very rim — the bright refracted streaks. Low to avoid ghosting."
    },
    {
      "name": "edgeLight",
      "kind": "number",
      "default": 0.14,
      "min": 0,
      "step": 0.01,
      "help": "Brightness of the crisp perimeter outline (the glass edge catching light all the way around)."
    },
    {
      "name": "tintAdaptivity",
      "kind": "number",
      "default": 1,
      "min": 0,
      "max": 1,
      "step": 0.01,
      "help": "0 = a fixed frosted tint; 1 = fully luminance-adaptive (pale skin over dark content, smoky over light — the macOS content-adaptive look).",
      "uniform": "adaptivity"
    },
    {
      "name": "chromatic",
      "kind": "number",
      "default": 0.08,
      "min": 0,
      "step": 0.01,
      "help": "Chromatic aberration at the refracting rim: the R/B channels sample slightly off the G. A TINY value gives a faint coloured edge fringe like real glass; large = a rainbow smear."
    },
    {
      "name": "backdropScale",
      "kind": "number",
      "default": 1,
      "min": 0.25,
      "step": 0.05,
      "help": "RESOLUTION FACTOR the content beneath is re-rendered at for the refraction: 1 = screen resolution, 2 = supersample (crisper refraction, slower), 0.5 = half res (faster, softer).",
      "omit": true
    }
  ],

  // Constants a FILL pins rather than exposes. The clip is the silhouette, so the
  // glass region is the full bbox RECTANGLE (squircle 2 / tension 0 is the shader's
  // degenerate plain-rect case) and it is settled (no appear ramp).
  fixed: { squircle: 2, surfaceTension: 0, materialize: 1 },

  // THE UNIFORM BLOCK, in the shader's own declaration order, tightly packed
  // (float = 1, float2 = 2, float4 = 4). 25 floats total.
  uniforms: [
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
      "name": "edgeFalloff",
      "size": 1,
      "scaleByDevice": true
    },
    {
      "name": "refractionStrength",
      "size": 1,
      "scaleByDevice": true
    },
    {
      "name": "angle",
      "size": 1
    },
    {
      "name": "lightAngle",
      "size": 1
    },
    {
      "name": "lightIntensity",
      "size": 1
    },
    {
      "name": "saturation",
      "size": 1
    },
    {
      "name": "tint",
      "size": 4
    },
    {
      "name": "materialize",
      "size": 1
    },
    {
      "name": "squircle",
      "size": 1
    },
    {
      "name": "sheen",
      "size": 1
    },
    {
      "name": "specPower",
      "size": 1
    },
    {
      "name": "contactShadow",
      "size": 1
    },
    {
      "name": "caustic",
      "size": 1
    },
    {
      "name": "edgeLight",
      "size": 1
    },
    {
      "name": "adaptivity",
      "size": 1
    },
    {
      "name": "chromatic",
      "size": 1
    },
    {
      "name": "surfaceTension",
      "size": 1
    }
  ],

  // Backdrop-sample reach: refractionStrength · scale · PRE_BULGE · (1 + chromatic).
  // `plusFractionOf` is its own field because the term is (1 + x), not x — at zero
  // aberration the factor must be 1, not 0.
  maxSampleReach: { product: ["refractionStrength", "scale"], times: PRE_BULGE, plusFractionOf: "chromatic" },

  // The thumbnail stand-in is the glass skin's own tint (glass IS mostly a tinted
  // veil), so a dark preset reads as a dark panel at proxy quality.
  proxyBackdrop: { fromParam: "tint" },

  // SHAPE-CONFORMING FILL: the fill variant takes its region distance + rim normal
  // from the silhouette SDF child, so a glass gear reads as a GLASS GEAR.
  usesShapeSdf: true,

  sksl: "\nconst float AA_PX = 1.0;            // coverage antialias half-width (~1 device px)\nconst float NORMAL_EPS_PX = 1.0;    // central-difference step for the SDF normal: one device pixel, the finest step the raster can resolve\nconst float SHEEN_POWER = 5.0;      // falloff SHAPE of the broad surface sheen (its STRENGTH is the uSheen uniform)\nconst float RIM_WEIGHT = 1.15;      // relative weight of the thin edge hairline vs the broad sheen (the crisp top rim IS the signature highlight)\nconst float PRE_BULGE = 1.7;        // extra refraction at materialize->0 (Stage 0: backdrop bulges before the glass settles)\nconst float APPEAR_END = 0.8;       // materialize value by which the frosted skin is fully faded in\nconst float PERIMETER_PX = 2.5;     // width of the crisp bright edge OUTLINE (its brightness is the uEdgeLight uniform)\nconst float ADAPT_LO = 0.30;        // backdrop luminance at/below which the tint neutral is fully PALE (light glass over dark content)\nconst float ADAPT_HI = 0.70;        // backdrop luminance at/above which the tint neutral is fully SMOKY (dark glass over light content)\nconst float ADAPT_LIGHT = 0.96;     // the PALE neutral value used over DARK content (adaptive tint pass b)\nconst float ADAPT_DARK = 0.06;      // the SMOKY neutral value used over LIGHT content (adaptive tint pass b)\nconst float ADAPT_FIXED = 0.75;     // the NON-adaptive frosted neutral (used when uAdaptivity -> 0: a plain pale tint)\nconst half3 REC709 = half3(0.2126, 0.7152, 0.0722); // luminance weights for desaturation + adaptive tint\n\nuniform shader blurredBackdrop;     // child 0: Gaussian-blurred composite-so-far (device space)\nuniform shader sharpBackdrop;       // child 1: the un-blurred composite-so-far (device space)\nuniform float2 uCenter;             // region center (device px)\nuniform float2 uHalfSize;           // region half-extents (device px)\nuniform float uCornerRadius;        // rounded-rect corner radius (device px)\nuniform float uEdgeFalloff;         // inward decay distance of the effect band (device px)\nuniform float uRefractionStrength;  // max edge displacement at the rim (device px)\nuniform float uAngle;               // panel rotation (radians): rotates the SDF frame so a rotated widget stays correct\nuniform float uLightAngle;          // direction TO the light (radians; -PI/2 = straight above), in SCREEN space\nuniform float uLightIntensity;      // specular strength\nuniform float uSaturation;          // backdrop saturation kept (1 = unchanged, 0 = gray)\nuniform float4 uTint;               // tint COLOR CAST (rgb, multiplies the adaptive neutral) + STRENGTH (a); low alpha = clear\nuniform float uMaterialize;         // 0 = gone, 1 = fully settled glass\n// ── user-tweakable material-character knobs (self.* custom props) ────────────\nuniform float uSquircle;            // corner Lp-norm exponent: 2 == circular arc, >2 == continuous \"squircle\" curvature (Apple's corners)\nuniform float uSheen;               // STRENGTH of the broad surface sheen (kept low for clarity)\nuniform float uSpecPower;           // tightness of the edge specular lobe: higher => thinner bright hairline on the lit edge\nuniform float uContactShadow;       // strength of the faint dark edge OPPOSITE the light (glass contact shading)\nuniform float uCaustic;             // how much SHARP (unblurred) backdrop bleeds into the very rim (bright refracted streaks)\nuniform float uEdgeLight;           // brightness of the crisp perimeter outline (glass edge catch-light)\nuniform float uAdaptivity;          // 0 = fixed frosted tint, 1 = fully luminance-adaptive (pale over dark, smoky over light)\nuniform float uChromatic;           // chromatic aberration: R/B channels sample at +/- this fraction of the refraction displacement (rim fringing)\nuniform float uSurfaceTension;      // 0 = a rectangle with squircle corners (flat edges), 1 = the fully RELAXED superellipse inscribed in the box (no flat edge anywhere)\n\n// Pure. The region SDF in PRE-SCALED space: negative inside, p LOCAL+centered.\n// Divide by glassAniso below to read it as a device-px distance.\n//\n// THE SHAPE. The region is the Minkowski sum of an inner RECTANGLE of half-size\n// INNER with an Lp \"ball\" of exponent n whose semi-axes are the corner radii\n// rr, so its boundary in the first quadrant is\n//\n//     ((x - inner.x)/rr.x)^n + ((y - inner.y)/rr.y)^n = 1\n//\n// clipped to x >= inner.x, y >= inner.y, plus the straight runs of the inner\n// rectangle. SURFACE TENSION shrinks INNER to zero and grows RR to the\n// half-size in step (rr = mix(r, h, tension), inner = h - rr), which\n//   * keeps the OUTER extent at h for every tension (the widget still fills its\n//     own bbox, so resize handles and hit tests stay honest), and\n//   * removes the straight runs entirely at tension 1, leaving the pure\n//     superellipse |x/h.x|^n + |y/h.y|^n = 1 — a curve with NO flat region.\n// That is the physical picture: surface tension pulls a pinned liquid toward\n// minimum perimeter, i.e. toward the roundest shape its footprint allows.\n//\n// THE DISTANCE. An anisotropic Lp gauge has no closed-form distance, so this takes\n// the standard route: pre-scale the plane by s = ref/rr, which turns the\n// anisotropic gauge into the ISOTROPIC one this shader has always used (gauge\n// radius REF), and evaluate the isotropic Lp rounded-box SDF there. What comes back\n// is a distance measured in the STRETCHED metric; glassAniso returns the stretch so\n// the caller can divide it out. At tension 0 — and at ANY tension on a square panel\n// — s is exactly (1, 1) and every line here reduces, operation for operation, to\n// the squircle SDF that shipped before surface tension existed.\n//\n// The point arrives ALREADY pre-scaled (main does pl * s once) rather than being\n// scaled inside, because this is evaluated five times per pixel — once for the\n// distance and four times for the numerical normal — and s is positive, so\n// abs(p)*s == abs(p*s) and the scaling commutes out of all five. That is what makes\n// the tension machinery cost two multiplies per PIXEL instead of ten.\nfloat sdGlassScaled(float2 ps, float2 innerScaled, float ref, float n) {\n  float2 q = abs(ps) - innerScaled;\n  float2 qp = max(q, 0.0);\n  return pow(pow(qp.x, n) + pow(qp.y, n), 1.0 / n) + min(max(q.x, q.y), 0.0) - ref;\n}\n\n// Pure. The local metric stretch the pre-scale introduced, as a positive factor:\n//\n//     aniso = |s * grad| / |grad|      (grad = the gauge gradient, unnormalized)\n//\n// The RATIO — not |s * grad| alone — is deliberate. It removes exactly the error\n// the pre-scale introduced and NOTHING else. |s * grad| alone would ALSO divide out\n// the isotropic Lp SDF's own inherited inexactness (|grad| != 1 for n > 2, the\n// price of the radial-gauge form), which would change every existing glass render;\n// and measured, it is also simply worse — over a +-22 px band the mean error\n// against true Euclidean distance is 11.5 px that way against 0.8 px this way.\n//\n// MEASURED accuracy of the ratio form (scratchpad sweep over aspect x radius x\n// exponent x tension): within the +-1 px coverage band the error against true\n// Euclidean distance is <= 0.25 px at EVERY tension, so the silhouette and its\n// antialiasing are exact to well under a pixel. Further in, the radial-gauge error\n// grows with tension and aspect ratio: over the default 22 px effect band it goes\n// 3.5 px -> 6.0 px (tension 0 -> 1) on the default 440x150 panel, and reaches ~60 px\n// on an extreme 7.5:1 panel at tension 1. That only makes the soft bevel band\n// non-uniform in width; it can never move the edge.\nfloat glassAniso(float2 ps, float2 innerScaled, float2 s, float n) {\n  float2 q = abs(ps) - innerScaled;\n  float2 qp = max(q, 0.0);\n  // Where the point is inside the INNER rectangle the gauge is flat and the\n  // distance is governed by the max-component term instead, whose gradient is that\n  // axis; the guarded components keep pow(0, n-1) from becoming 0/0.\n  float2 g = (qp.x > 0.0 || qp.y > 0.0)\n    ? float2(qp.x > 0.0 ? pow(qp.x, n - 1.0) : 0.0, qp.y > 0.0 ? pow(qp.y, n - 1.0) : 0.0)\n    : (q.x > q.y ? float2(1.0, 0.0) : float2(0.0, 1.0));\n  float gn = length(g);\n  // gn == 0 only at a critical point of the gauge (underflow of qp^(n-1) right on\n  // the inner corner); 1.0 is the no-stretch value, so the guard cannot perturb it.\n  return gn > 0.0 ? length(s * g) / gn : 1.0;\n}\n\n// Pure. Outward unit normal of the region via central differences of the PRE-SCALED\n// distance. The pre-scaled field's gradient is already normal to the true boundary —\n// dividing a field by a positive scalar cannot rotate its gradient at a zero\n// crossing — so the normal needs no anisotropy correction, and skipping it here is\n// what keeps the four extra evaluations as cheap as they always were.\n//\n// STEPSCALED is NORMAL_EPS_PX * s: a step of s.x in pre-scaled space is a step of\n// exactly one device pixel in the panel's own frame, so each difference comes out as\n// the LOCAL derivative and the two components stay commensurate (they would not if\n// both axes stepped by the same amount in a stretched space, and the normal would\n// tilt toward the compressed axis).\nfloat2 normalLocal(float2 ps, float2 innerScaled, float2 stepScaled, float ref, float n) {\n  float dx = sdGlassScaled(ps + float2(stepScaled.x, 0.0), innerScaled, ref, n) - sdGlassScaled(ps - float2(stepScaled.x, 0.0), innerScaled, ref, n);\n  float dy = sdGlassScaled(ps + float2(0.0, stepScaled.y), innerScaled, ref, n) - sdGlassScaled(ps - float2(0.0, stepScaled.y), innerScaled, ref, n);\n  float2 g = float2(dx, dy);\n  float len = length(g);\n  return len > 0.0 ? g / len : float2(0.0, -1.0);\n}\n\nhalf4 main(float2 p) {\n  // Rotate the device pixel into the panel's LOCAL centered frame (uAngle == 0\n  // is the axis-aligned common case). cos/sin of the widget rotation.\n  float ca = cos(uAngle), sa = sin(uAngle);\n  float2 d0 = p - uCenter;\n  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y);\n  float r = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y)); // capsule-safe clamp\n  float n = max(uSquircle, 2.0);                   // >=2: never concave (2 == circular arc)\n  // The boundary family (see sdGlassScaled): corner semi-axes rr, inner rectangle\n  // h - rr, and the pre-scale that makes the corner gauge isotropic. All of it is\n  // uniform-derived. At tension 0, rr is (r, r), the pre-scale is exactly (1, 1),\n  // inner is exactly h - r, and every line below reduces to the pre-tension\n  // expression term for term.\n  float tension = clamp(uSurfaceTension, 0.0, 1.0);\n  float2 rr = mix(float2(r), uHalfSize, tension);\n  float2 inner = uHalfSize - rr;\n  float ref = max(rr.x, rr.y);\n  // ref/rr, guarded: rr is 0 only for a zero-extent axis or for r == 0 at tension\n  // 0, and in both of those the shape has no corner to scale, so 1 is the value.\n  float2 s = float2(rr.x > 0.0 ? ref / rr.x : 1.0, rr.y > 0.0 ? ref / rr.y : 1.0);\n  float2 ps = pl * s;                              // the point in the isotropic gauge frame\n  float2 innerScaled = inner * s;\n\n  // The pre-scale is the IDENTITY whenever the two corner semi-axes agree — at\n  // tension 0 always, and at any tension on a SQUARE panel. There is then no stretch\n  // to divide out and 1.0 is the exact answer, so the whole anisotropy evaluation is\n  // skipped. The test is exact by construction (s is ref/rr over equal operands,\n  // which is 1.0 to the bit) and the general branch is also correct if it is ever\n  // taken, so this is an algebraic shortcut and not a special case — it is why the\n  // default look costs what it cost before.\n  float dScaled = sdGlassScaled(ps, innerScaled, ref, n);\n  float d = (s.x == 1.0 && s.y == 1.0) ? dScaled : dScaled / glassAniso(ps, innerScaled, s, n);\n  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, d);\n  if (cov <= 0.0) { return half4(0.0); }          // outside region: contribute nothing\n  float distInside = -d;\n  float edge = 1.0 - smoothstep(0.0, uEdgeFalloff, distInside);\n  float2 Nl = normalLocal(ps, innerScaled, s * NORMAL_EPS_PX, ref, n);\n  // Rotate the local normal back to DEVICE space (refraction + light live in\n  // screen space, so the light stays \"from above\" however the panel is turned).\n  float2 N = float2(ca * Nl.x - sa * Nl.y, sa * Nl.x + ca * Nl.y);\n  float m = clamp(uMaterialize, 0.0, 1.0);\n  float appear = smoothstep(0.0, APPEAR_END, m);\n  float refrAmt = mix(PRE_BULGE, 1.0, m);\n\n  // (4) refraction — displace outward along the normal, scaled by the edge band.\n  // CHROMATIC ABERRATION (edge-only dispersion): sample each channel at a slightly\n  // different displacement — RED toward the glass center (less outward), GREEN at\n  // the base, BLUE away from center (more outward) — the documented Liquid Glass\n  // convention (matches real dispersion: shorter wavelengths bend more). Scaled by\n  // the edge band so it is a faint rim fringe, ~0 in the interior; tiny by default.\n  float2 disp = N * (uRefractionStrength * edge * refrAmt);\n  float caAmt = uChromatic * edge;\n  half3 body = half3(\n    blurredBackdrop.eval(p + disp * (1.0 - caAmt)).r,\n    blurredBackdrop.eval(p + disp).g,\n    blurredBackdrop.eval(p + disp * (1.0 + caAmt)).b\n  );\n  half3 caustic = sharpBackdrop.eval(p + disp).rgb;\n  body = mix(body, caustic, half(uCaustic * edge));\n\n  // (5) desaturate + LUMINANCE-ADAPTIVE tint (pass a clarity + pass b adaptive).\n  // uAdaptivity blends the neutral between a fixed frosted tint and the\n  // luminance-adaptive neutral (pale over dark content, smoky over light).\n  half lum = dot(body, REC709);\n  body = mix(half3(lum), body, half(uSaturation));\n  float adapt = smoothstep(ADAPT_LO, ADAPT_HI, float(lum));       // 0 over dark, 1 over light\n  half3 adaptiveNeutral = mix(half3(ADAPT_LIGHT), half3(ADAPT_DARK), half(adapt));\n  half3 neutral = mix(half3(ADAPT_FIXED), adaptiveNeutral, half(clamp(uAdaptivity, 0.0, 1.0)));\n  half3 tintColor = neutral * half3(uTint.rgb);                  // user hue tints the neutral\n  body = mix(body, tintColor, half(uTint.a * appear));\n\n  // (6) specular — light from above (screen space). The broad sheen is a SMOOTH\n  // gradient along the light direction (brighter toward the light), normalized by\n  // the panel size — NOT a radial-from-center term, which creases where the\n  // center direction flips. rim/contact are edge-band lobes on the SDF normal.\n  float2 L = float2(cos(uLightAngle), sin(uLightAngle));\n  float rim = pow(max(dot(N, L), 0.0), uSpecPower) * edge;\n  float grad = dot(p - uCenter, L) / max(length(uHalfSize), 1.0); // ~ -1..1, + toward the light\n  float sheen = pow(clamp(grad * 0.5 + 0.5, 0.0, 1.0), SHEEN_POWER);\n  float dark = pow(max(dot(N, -L), 0.0), uSpecPower) * edge;\n  float spec = (rim * RIM_WEIGHT + sheen * uSheen) * uLightIntensity;\n\n  // crisp bright edge outline all around (brighter on the lit edge)\n  float perim = 1.0 - smoothstep(0.0, PERIMETER_PX, distInside);\n  float outline = perim * uEdgeLight * (0.6 + 0.4 * max(dot(N, L), 0.0));\n\n  half3 outc = body + half3((spec + outline) * appear) - half3(dark * uContactShadow * appear);\n  return half4(outc * half(cov), half(cov));       // premultiplied\n}\n",

  fillSksl: "\nconst float AA_PX = 1.0;\nconst float NORMAL_EPS_PX = 1.0;\nconst float SHEEN_POWER = 5.0;\nconst float RIM_WEIGHT = 1.15;\nconst float PRE_BULGE = 1.7;\nconst float APPEAR_END = 0.8;\nconst float PERIMETER_PX = 2.5;\nconst float ADAPT_LO = 0.30;\nconst float ADAPT_HI = 0.70;\nconst float ADAPT_LIGHT = 0.96;\nconst float ADAPT_DARK = 0.06;\nconst float ADAPT_FIXED = 0.75;\nconst half3 REC709 = half3(0.2126, 0.7152, 0.0722);\n\nuniform shader blurredBackdrop;     // child 0\nuniform shader sharpBackdrop;       // child 1\nuniform shader shapeSdf;            // child 2: silhouette signed distance (device px, <0 inside)\nuniform float2 uCenter;\nuniform float2 uHalfSize;\nuniform float uCornerRadius;        // unused in the fill variant (the SDF is the silhouette)\nuniform float uEdgeFalloff;\nuniform float uRefractionStrength;\nuniform float uAngle;               // unused (the device-space SDF already carries rotation)\nuniform float uLightAngle;\nuniform float uLightIntensity;\nuniform float uSaturation;\nuniform float4 uTint;\nuniform float uMaterialize;\nuniform float uSquircle;            // unused\nuniform float uSheen;\nuniform float uSpecPower;\nuniform float uContactShadow;\nuniform float uCaustic;\nuniform float uEdgeLight;\nuniform float uAdaptivity;\nuniform float uChromatic;\nuniform float uSurfaceTension;      // unused\n\nhalf4 main(float2 p) {\n  // Silhouette distance + normal, straight from the SDF child (device space).\n  float d = shapeSdf.eval(p).r;\n  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, d);\n  if (cov <= 0.0) { return half4(0.0); }\n  float distInside = -d;\n  float edge = 1.0 - smoothstep(0.0, uEdgeFalloff, distInside);\n  float2 g = float2(\n    shapeSdf.eval(p + float2(NORMAL_EPS_PX, 0.0)).r - shapeSdf.eval(p - float2(NORMAL_EPS_PX, 0.0)).r,\n    shapeSdf.eval(p + float2(0.0, NORMAL_EPS_PX)).r - shapeSdf.eval(p - float2(0.0, NORMAL_EPS_PX)).r);\n  float glen = length(g);\n  float2 N = glen > 0.0 ? g / glen : float2(0.0, -1.0);   // outward silhouette normal (device space)\n\n  float m = clamp(uMaterialize, 0.0, 1.0);\n  float appear = smoothstep(0.0, APPEAR_END, m);\n  float refrAmt = mix(PRE_BULGE, 1.0, m);\n\n  // (4) refraction along the silhouette normal (chromatic split, as the base shader).\n  float2 disp = N * (uRefractionStrength * edge * refrAmt);\n  float caAmt = uChromatic * edge;\n  half3 body = half3(\n    blurredBackdrop.eval(p + disp * (1.0 - caAmt)).r,\n    blurredBackdrop.eval(p + disp).g,\n    blurredBackdrop.eval(p + disp * (1.0 + caAmt)).b\n  );\n  half3 caustic = sharpBackdrop.eval(p + disp).rgb;\n  body = mix(body, caustic, half(uCaustic * edge));\n\n  // (5) desaturate + luminance-adaptive tint (identical to GLASS_SKSL).\n  half lum = dot(body, REC709);\n  body = mix(half3(lum), body, half(uSaturation));\n  float adapt = smoothstep(ADAPT_LO, ADAPT_HI, float(lum));\n  half3 adaptiveNeutral = mix(half3(ADAPT_LIGHT), half3(ADAPT_DARK), half(adapt));\n  half3 neutral = mix(half3(ADAPT_FIXED), adaptiveNeutral, half(clamp(uAdaptivity, 0.0, 1.0)));\n  half3 tintColor = neutral * half3(uTint.rgb);\n  body = mix(body, tintColor, half(uTint.a * appear));\n\n  // (6) specular: rim/contact on the silhouette normal; the broad sheen stays a soft\n  // bbox-directional gradient (it is a face wash, not an edge effect).\n  float2 L = float2(cos(uLightAngle), sin(uLightAngle));\n  float rim = pow(max(dot(N, L), 0.0), uSpecPower) * edge;\n  float grad = dot(p - uCenter, L) / max(length(uHalfSize), 1.0);\n  float sheen = pow(clamp(grad * 0.5 + 0.5, 0.0, 1.0), SHEEN_POWER);\n  float dark = pow(max(dot(N, -L), 0.0), uSpecPower) * edge;\n  float spec = (rim * RIM_WEIGHT + sheen * uSheen) * uLightIntensity;\n\n  float perim = 1.0 - smoothstep(0.0, PERIMETER_PX, distInside);\n  float outline = perim * uEdgeLight * (0.6 + 0.4 * max(dot(N, L), 0.0));\n\n  half3 outc = body + half3((spec + outline) * appear) - half3(dark * uContactShadow * appear);\n  return half4(outc * half(cov), half(cov));\n}\n",
};
