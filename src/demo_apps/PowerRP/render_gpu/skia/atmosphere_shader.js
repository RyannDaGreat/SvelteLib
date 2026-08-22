/**
 * THE ATMOSPHERE material — the "pretty atmosphere" of the globe widget, and
 * NOTHING ELSE. A GENERATIVE FOREGROUND material (backdrop:false) on the shared
 * material framework: it synthesizes the limb glow, the terminator shading and the
 * space-side halo of a planet whose SURFACE is drawn separately, by ordinary image
 * ops carrying map tiles.
 *
 * ── WHY THE ATMOSPHERE IS A MATERIAL BUT THE SURFACE IS NOT ──────────────────
 * This split is the central design decision of the globe and it is forced, not
 * stylistic. An SkSL material in this framework receives UNIFORMS and, for a
 * backdrop material, the standard {blurredBackdrop, sharpBackdrop} child pair. It
 * cannot be handed an arbitrary set of TILE TEXTURES — there is no child-image
 * mechanism in the contract, and inventing one for a single widget would be a
 * framework change with a global blast radius.
 *
 * So the globe draws its surface the way every other textured thing in this app
 * draws one: as `image` ops (render_gpu/ir.js), one per tile, geometrically warped
 * onto the sphere by the plugin. That choice buys three things that a bespoke
 * texture-sampling shader would each have had to re-earn:
 *   · THE EXPORTERS WORK. `image` is in both VECTOR_OPS sets, so PDF and SVG
 *     export embed the tiles as rasters with no new backend code.
 *   · THE CLI TELLS THE TRUTH. `image` is in cli/render.js's MEDIA_OPS, so a bare-
 *     node still COUNTS AND REPORTS the tiles it cannot draw instead of writing a
 *     holed PNG and exiting 0 — the exact failure that file's header warns about.
 *   · THE REGISTRY IS THE ONE THAT ALREADY EXISTS. Tiles ride image_registry, so
 *     pendingImageRefs already stops the render-job worker from shipping a frame
 *     with tiles still in flight.
 * The atmosphere, by contrast, is PURE MATH over the disc — no texture at all — so
 * it is exactly what a material is for.
 *
 * ── THE ATMOSPHERE MODEL: THE CHEAP TRICK, NAMED ─────────────────────────────
 * Real atmospheric scattering is a ray-march through a density field. That is not
 * needed here and is not done: the standard real-time approximation is a FRESNEL /
 * RIM term, and it is the one adopted. For a sphere seen orthographically, the
 * surface normal's z component at disc radius r is
 *
 *     N·V = cos(asin(r)) = sqrt(1 - r²)
 *
 * so the rim factor is `1 - N·V`, which is 0 at the disc centre (looking straight
 * down through the thinnest air) and 1 at the limb (grazing incidence, the longest
 * path through atmosphere). Raising it to a power shapes the falloff:
 *
 *     glow = pow(1 - sqrt(1 - r²), rimPower)
 *
 * That single expression IS the atmosphere. It is physically motivated rather than
 * merely decorative — the limb really is bright because the line of sight there
 * traverses far more air — which is why it reads as a planet instead of as a blur.
 *
 * Three refinements, each earning its uniform:
 *   · LIMB DARKENING on the surface side. The same geometry that brightens the
 *     air darkens the GROUND near the limb (more atmosphere between the viewer and
 *     it). Applied as a multiply on the surface, so the globe's edge recedes.
 *   · THE OUTER HALO. Beyond r = 1 there is no planet, but there IS air: the glow
 *     continues outward with an exponential falloff to `haloWidth`, which is what
 *     makes the planet sit IN something rather than being pasted on black.
 *   · THE TERMINATOR. A directional light gives the day/night boundary. It is a
 *     smoothstep on N·L rather than a hard cut, because the real terminator is
 *     softened by exactly the atmosphere this shader is drawing.
 *
 * REJECTED, deliberately: volumetric/ray-marched scattering (Nishita, Bruneton
 * LUTs, O'Neil's GPU Gems 2 shader). All three are correct and all three cost a
 * march or a precomputed texture per frame for an effect that, at the size a globe
 * occupies on a SLIDE, is a few hundred pixels of rim. The brief said "no
 * volumetrics needed" and the measurement agrees.
 *
 * DETERMINISTIC: no clock, no random, no feedback. Every pixel is a function of
 * the uniforms alone, so this is PROPERTY STATE and a frozen document renders
 * byte-identically forever.
 *
 * DOM-free at import (string SkSL + a pure packer), like every material here.
 */

import { parseColor } from "../ir.js";
import { schemaAngleRadians } from "../../core/properties.js";

/**
 * The SkSL. `main(float2 p)` works in DEVICE px, as the framework specifies; the
 * uniforms carry the disc's device-space centre and radius so the shader can
 * normalize to the unit disc itself.
 *
 * NOTE ON THE ALPHA: this material draws ONLY the air. Inside the disc it is a
 * translucent tint over the tiles already painted beneath (the plugin emits the
 * atmosphere AFTER the surface), and outside the disc it is the halo fading to
 * fully transparent. It never paints an opaque planet, which is what lets the same
 * shader work over any basemap.
 */
export const ATMOSPHERE_SKSL = `
uniform float2 uCenter;      // disc centre, device px
uniform float  uRadius;      // planet radius, device px
uniform float4 uGlowColor;   // atmosphere colour (premultiplied-ready RGBA)
uniform float  uRimPower;    // falloff exponent of the limb glow
uniform float  uRimStrength; // glow intensity at the limb
uniform float  uHaloWidth;   // outer halo reach, as a fraction of the radius
uniform float2 uLightDir;    // direction TO the light, in the disc's own x/y (north-positive y)
uniform float  uLightZ;      // the light's out-of-plane component
uniform float  uNightAmount; // how dark the unlit side goes (0 = no terminator at all)
uniform float  uLimbDarken;  // how much the SURFACE darkens toward the limb

half4 main(float2 p) {
  float2 d = (p - uCenter) / uRadius;   // unit-disc coordinates
  float r = length(d);

  // ── OUTSIDE THE PLANET: the halo alone ─────────────────────────────────────
  // Exponential falloff over uHaloWidth radii. Normalized so that the halo's
  // brightness AT the limb matches the rim glow's, making the boundary seamless.
  if (r > 1.0) {
    float outward = (r - 1.0) / max(uHaloWidth, 1e-4);
    float halo = exp(-outward * 3.0) * uRimStrength;
    return half4(uGlowColor.rgb * halo * uGlowColor.a, halo * uGlowColor.a);
  }

  // ── THE SURFACE NORMAL, orthographic ───────────────────────────────────────
  // The visible hemisphere's normal at disc radius r has z = sqrt(1 - r^2); that
  // z IS N·V for an orthographic viewer looking down -z.
  float nz = sqrt(max(0.0, 1.0 - r * r));
  float3 N = float3(d, nz);

  // ── THE RIM / FRESNEL TERM: the atmosphere itself ──────────────────────────
  float rim = pow(1.0 - nz, uRimPower) * uRimStrength;

  // ── THE TERMINATOR ─────────────────────────────────────────────────────────
  // N·L with a SOFT boundary, because a real terminator is softened by the very
  // air this shader draws. smoothstep over a band around zero rather than a step.
  float3 L = normalize(float3(uLightDir, uLightZ));
  float ndl = dot(N, L);
  float day = smoothstep(-0.25, 0.35, ndl);
  // The unlit side keeps a little light: a planet's night side is not pure black
  // (earthshine, scattered light), and a hard black hemisphere reads as a bug.
  float shade = mix(1.0 - uNightAmount, 1.0, day);

  // ── LIMB DARKENING of the SURFACE ──────────────────────────────────────────
  // Darkens the tiles toward the edge — the same path-length argument that
  // brightens the air. Multiplied into the alpha of a BLACK veil rather than the
  // glow, so it dims what is beneath instead of tinting it.
  float darken = (1.0 - nz) * uLimbDarken;

  // The glow rides the LIT side: atmosphere is bright because it scatters
  // sunlight, so it must fade out across the terminator with everything else.
  float glow = rim * mix(0.15, 1.0, day);

  // Composite: a black veil (limb darkening + night) plus the coloured glow.
  float veil = clamp(darken + (1.0 - shade), 0.0, 1.0);
  float3 rgb = uGlowColor.rgb * glow * uGlowColor.a;
  float alpha = clamp(veil + glow * uGlowColor.a, 0.0, 1.0);
  // Premultiplied: the veil contributes darkness (zero rgb), the glow contributes
  // colour; both are already multiplied by their own coverage.
  return half4(rgb, alpha);
}
`;

/** The packed uniform count — 2 + 1 + 4 + 1 + 1 + 1 + 2 + 1 + 1 + 1. Asserted by
 *  the framework's packer, so a mismatch fails loudly at compile rather than
 *  producing a shader reading garbage off the end of the buffer. */
export const ATMOSPHERE_UNIFORM_FLOATS = 15;

/**
 * The atmosphere's knobs, in the fill-schema shape the material framework and the
 * widget BOTH read (the single-declaration rule: a material's fillParams become
 * the widget's custom properties, so there is one list, not two that drift).
 *
 * Defaults are Earth's: a sky-blue rim at the strength that reads as air rather
 * than as a neon outline, and a terminator soft enough to look photographed.
 */
export const ATMOSPHERE_FILL_PARAMS = [
  { name: "glowColor", kind: "color", default: "#6cb8ff", label: "Atmosphere colour",
    help: "Colour of the limb glow and the outer halo. Earth's air is this blue because Rayleigh scattering goes as 1/wavelength^4; a Mars-like planet wants a dusty orange, and a gas giant a pale cream." },
  { name: "rimStrength", kind: "number", default: 0.85, min: 0, max: 3, step: 0.01, label: "Atmosphere strength",
    help: "How bright the atmosphere is at the limb. 0 turns it off entirely, leaving a bare textured ball. Past about 1.5 it stops reading as air and starts reading as an outline." },
  { name: "rimPower", kind: "number", default: 3, min: 0.25, max: 12, step: 0.05, label: "Atmosphere falloff",
    help: "How tightly the glow hugs the edge: the exponent in pow(1 - N.V, power). Low spreads haze across the whole disc; high confines it to a thin bright line at the limb. 3 is the Earth-like default." },
  { name: "haloWidth", kind: "number", default: 0.12, min: 0, max: 1, step: 0.01, label: "Halo width",
    help: "How far the glow reaches OUTWARD past the planet's edge, as a fraction of its radius. This is what makes the globe sit in something rather than being pasted onto the background. 0 clips the air at the surface." },
  { name: "nightAmount", kind: "number", default: 0.72, min: 0, max: 1, step: 0.01, label: "Night darkness",
    help: "How dark the unlit hemisphere goes. Never quite 1 by default: a real night side carries earthshine and scattered light, and a pure black hemisphere reads as a rendering bug rather than as night. 0 lights the whole globe evenly (no terminator)." },
  { name: "limbDarken", kind: "number", default: 0.35, min: 0, max: 1, step: 0.01, label: "Limb darkening",
    help: "How much the SURFACE dims toward the edge. The same longer air path that brightens the atmosphere dims the ground behind it, and this is what stops the globe looking like a flat sticker of a map." },
  // STORES DEGREES, so NO `display: "degrees"` (which would declare radians — see
  // core/properties.angleStorageUnit). This row carried that key for its whole life
  // while packAtmosphere below multiplied by π/180, which made the two disagree:
  // the dial rendered this -35 default as -2005°, and a -35° edit committed -0.611
  // and reached the shader as -0.0107 rad — the sun barely moved. globe_map's
  // presets store literal degrees (-170, -90, -60, -35), so DEGREES is what is
  // really stored and dropping the key is the zero-migration half of the fix.
  { name: "lightAngle", kind: "angle", default: -35, label: "Sun angle",
    help: "Direction TO the sun, in the widget's own frame (-90 is straight up the screen). KEYFRAME THIS to sweep the terminator across the planet — a day passing, in one property." },
  { name: "lightHeight", kind: "number", default: 0.35, min: -1, max: 1, step: 0.01, label: "Sun height",
    help: "How far the sun sits out of the screen plane. 1 puts it directly behind the viewer (a fully lit disc, no terminator); 0 puts it exactly at the side (half lit); negative moves it behind the planet for a crescent." },
];

/** Stored angle → radians, reading each row's DECLARED storage unit from the
 *  schema above rather than restating it here (core/properties.schemaAngleRadians). */
const toRadians = schemaAngleRadians(ATMOSPHERE_FILL_PARAMS);

/**
 * Pure function. The framework's normalized `u` → the packed uniform array, in
 * SkSL declaration order. `u` carries the region geometry already resolved to
 * device px (cx, cy, halfW, halfH) plus this material's own knobs by name.
 *
 * The RADIUS is min(halfW, halfH): a planet is round, so a non-square box shows an
 * inscribed globe rather than an ellipsoid — the same inscribed-circle rule the
 * magnifier's circular lens follows.
 *
 * @param {object} u - framework uniforms + this material's params
 * @returns {Float32Array} ATMOSPHERE_UNIFORM_FLOATS long
 *
 * @example packAtmosphere({cx: 50, cy: 50, halfW: 40, halfH: 40, glowColor: "#6cb8ff", rimStrength: 1, rimPower: 3, haloWidth: 0.1, nightAmount: 0.7, limbDarken: 0.3, lightAngle: 0, lightHeight: 0}).length // 15
 * @example packAtmosphere({cx: 50, cy: 50, halfW: 40, halfH: 60, glowColor: "#6cb8ff", rimStrength: 1, rimPower: 3, haloWidth: 0.1, nightAmount: 0.7, limbDarken: 0.3, lightAngle: 0, lightHeight: 0})[2] // 40 (a tall box still shows a ROUND planet)
 */
export function packAtmosphere(u) {
  const [r, g, b, a] = parseColor(u.glowColor ?? "#6cb8ff");
  const radius = Math.max(1e-4, Math.min(u.halfW ?? 1, u.halfH ?? 1));
  const angle = toRadians("lightAngle", u.lightAngle ?? 0);
  return new Float32Array([
    u.cx ?? 0, u.cy ?? 0,
    radius,
    r, g, b, a,
    u.rimPower ?? 3,
    u.rimStrength ?? 0.85,
    u.haloWidth ?? 0.12,
    // The light direction in the DISC's frame. Screen y grows downward while the
    // shader's disc y also grows downward (both are device px), so the angle needs
    // no flip here — it is applied exactly as an angle prop elsewhere in the app.
    Math.cos(angle), Math.sin(angle),
    u.lightHeight ?? 0.35,
    u.nightAmount ?? 0.72,
    u.limbDarken ?? 0.35,
  ]);
}

/**
 * THE DESCRIPTOR. A generative FOREGROUND material (backdrop:false): no children,
 * no below-content re-render — one effect.makeShader fill over the region, exactly
 * like the sky family.
 */
export const ATMOSPHERE_MATERIAL = {
  id: "atmosphere",
  sksl: ATMOSPHERE_SKSL,
  pack: packAtmosphere,
  uniformFloats: ATMOSPHERE_UNIFORM_FLOATS,
  backdrop: false,
  fillParams: ATMOSPHERE_FILL_PARAMS,
};
