/**
 * Liquid Glass — the flagship DEMO WIDGET (plugins/demo/, the showcase folder).
 * A macOS-26 "Liquid Glass" panel: a rounded-rect region that REFRACTS, blurs,
 * tints (luminance-adaptively) and specular-lights the content beneath it — the
 * real backdrop-shader effect (NOT a CSS blur), drawn by the first live SkSL
 * RuntimeEffect in the renderer (render_gpu/skia/glass_shader.js via
 * paint_skia.js handleGlassBackdrop).
 *
 * Like the magnifier, it is a BACKDROP SAMPLER (capabilities.backdrop) and a
 * bbox widget (so it gets the standard resize handles). It emits ONE
 * `glassBackdrop` op — it does NOT compose the effects bundle (a backdrop
 * sampler cannot be wrapped in an effectSubtree, whose offscreen re-render would
 * sample an empty surface; the shader supplies its own specular + drop shadow).
 *
 * It declares its material knobs as CUSTOM self.* properties (core/properties.js
 * customProps — the same Blender-style mechanism the Demo Showcase proves): each
 * is an equation-capable widget-state key (edit as a literal, an expression, or
 * a `= …` equation, and reference elsewhere as self.<name>) with ZERO evaluation-
 * engine changes. `tint` is a PAINT row (solid or gradient); `materialize` is a
 * plain keyframable 0..1 appear ramp (v1: NOT wired to the presenter — hand-
 * animate it, or leave it at 1 for the settled glass).
 *
 * It also declares TWO orthogonal PRESET FAMILIES — Material (the optics) and
 * Silhouette (the outline curve, including the surface-tension axis) — see
 * MATERIAL_PRESETS / SILHOUETTE_PRESETS below for why they are split, and which
 * knobs deliberately appear in neither.
 *
 * Surfaced ONLY through the "Add Demo Widget" → "Liquid Glass" submenu
 * (web/App.svelte), keeping the core Add menus clean. DOM-free / bare-node-safe
 * at import time (mirrors showcase.js's import set).
 */

import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { glassBackdrop } from "../../render_gpu/ir.js";

// The material knobs, all self.* custom properties (design.md Part 3 table). WORLD
// units for lengths (the backend scales to device px by world.scale·zoom·dpr).
const LIGHT_ANGLE_DEFAULT = -Math.PI * 0.62; // direction TO the light: just left of straight-up (top-left), the macOS sheen
const CUSTOM = customProps([
  { name: "blurRadius", kind: "number", default: 8, min: 0, help: "Gaussian blur radius (world px) of the backdrop seen through the glass. Moderate keeps it readable — Liquid Glass is a frost, not an opaque blur." },
  { name: "refractionStrength", kind: "number", default: 14, min: 0, help: "Maximum edge displacement (world px). The defining Liquid Glass trait: surrounding content bends inward at the rim (strong at the border, ~0 in the interior)." },
  { name: "edgeFalloff", kind: "number", default: 22, min: 0, help: "How far inward (world px) the refraction + specular band decays. Larger = a wider bevelled rim." },
  { name: "lightAngle", kind: "angle", display: "degrees", default: LIGHT_ANGLE_DEFAULT, help: "Direction TO the light (screen space; -90° is straight above, 0° is from the right). The lit edge catches the thin bright highlight." },
  { name: "lightIntensity", kind: "number", default: 0.8, min: 0, help: "Strength of the top-light specular (the thin rim hairline + the broad soft sheen)." },
  { name: "tint", kind: "color", default: "rgba(255,255,255,0.14)", paint: true, help: "The glass skin's color CAST (rgb) and STRENGTH (alpha). The neutral is luminance-adaptive — pale over dark content, smoky over light — and this tints it; keep the alpha low for clarity." },
  { name: "saturation", kind: "number", default: 0.92, min: 0, max: 1, help: "How much backdrop color is kept (1 = unchanged, 0 = gray). Slightly below 1 for the subtle frosted desaturation." },
  { name: "cornerRadius", kind: "number", default: 48, min: 0, help: "Rounded-corner radius (world px). Corners are continuous (squircle) curvature; a capsule when this reaches half the shorter side. Surface tension progressively takes over from this — at tension 1 it has no effect at all." },
  { name: "materialize", kind: "number", default: 1, min: 0, max: 1, help: "The Spotlight appear ramp: 0 = gone (backdrop merely bulges), 1 = fully settled glass. Keyframe it to animate an appear (v1: not driven by the presenter)." },
  // ── material-character knobs (the values that used to be baked shader
  // constants — now equation-capable self.* props feeding the material) ────────
  { name: "squircle", kind: "number", default: 4, min: 2, scrub: 0.05, help: "Corner curvature exponent: 2 = a plain circular arc, higher = continuous Apple-style squircle corners (4 ≈ macOS). Superellipse Lp-norm. Surface tension spreads THIS curve over the whole outline." },
  { name: "surfaceTension", kind: "number", default: 0, min: 0, max: 1, help: "How far the STRAIGHT EDGES have relaxed into the corner curve. 0 = a rectangle with curved corners (flat sides, the default). 1 = the fully relaxed superellipse inscribed in the box — every point of the outline is curved, nothing is flat. Physically it is what surface tension does to a pinned liquid: pull it toward the roundest shape its footprint allows. At 1 the corner radius no longer matters; the exponent alone shapes the whole outline (2 gives a true ellipse, 4 a fat squircle, 8 a nearly-square blob)." },
  { name: "chromatic", kind: "number", default: 0.08, min: 0, help: "Chromatic aberration at the refracting rim: the R/B channels sample slightly off the G. A TINY value gives a faint colored edge fringe like real glass; large = a rainbow smear." },
  { name: "sheen", kind: "number", default: 0.1, min: 0, help: "Strength of the broad surface sheen (the soft gradient of light across the face). Kept low so the interior stays clear." },
  { name: "specularPower", kind: "number", default: 8, min: 1, scrub: 0.1, help: "Tightness of the edge specular lobe: higher = a thinner, crisper bright hairline on the lit edge." },
  { name: "contactShadow", kind: "number", default: 0.26, min: 0, help: "Darkness of the faint contact shadow on the edge OPPOSITE the light (the glass sitting on the surface)." },
  { name: "caustic", kind: "number", default: 0.12, min: 0, help: "How much SHARP (unblurred) backdrop bleeds into the very rim — the bright refracted streaks. Low to avoid ghosting." },
  { name: "edgeLight", kind: "number", default: 0.14, min: 0, help: "Brightness of the crisp perimeter outline (the glass edge catching light all the way around)." },
  { name: "tintAdaptivity", kind: "number", default: 1, min: 0, max: 1, help: "0 = a fixed frosted tint; 1 = fully luminance-adaptive (pale skin over dark content, smoky over light — the macOS content-adaptive look)." },
  { name: "shadowStrength", kind: "number", default: 0.3, min: 0, help: "Darkness of the soft drop shadow cast beneath the panel (0 = no shadow)." },
  // ── render control: the resolution the below-content is sampled at ───────────
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, help: "RESOLUTION FACTOR the content beneath is re-rendered at for the distortion: 1 = screen (zoom) resolution, 2 = supersample (crisper refraction, slower), 0.5 = half res (faster, softer), higher = sharper still. Any GL-style backdrop effect must pick this trade-off. The min 0.25 floor is a PERFORMANCE guard, not a look choice — below it the backdrop is uselessly coarse." },
]);

/**
 * THE PRESETS, as TWO orthogonal families (core/registry.js presetFamiliesOf):
 * MATERIAL — what the glass is made of — and SILHOUETTE — what shape it is. They
 * write DISJOINT key sets, so a pick from one never erases a pick from the other
 * and any material composes with any silhouette (the Mandelbrot
 * location/colour/performance split; the disjointness is enforced for every
 * plugin by tests/tool_groups_test.js). That split is not cosmetic: this widget's
 * outline is now a two-parameter CURVE (exponent + surface tension) and its optics
 * are fourteen independent knobs, and the two have nothing to say to each other.
 * A flat list would have had to pick one shape per material and throw the other
 * axis away — which is the mistake the lens flare's twelve-alternative-looks note
 * warns about from the opposite direction (its presets overlap on all 19 keys, so
 * for IT a split would clobber).
 *
 * EVERY PRESET IN A FAMILY SETS EVERY KEY THAT FAMILY OWNS. app.applyPreset writes
 * exactly the keys in `props` as an OVERLAY, so a key one preset omits keeps
 * whatever the previously hovered preset left behind, and running down the list to
 * compare looks is the entire point of the pane.
 *
 * THREE KNOBS ARE DELIBERATELY IN NO PRESET, by the lens flare's
 * composition-vs-look test:
 *   `lightAngle`   — a light the user aimed is composition, not look (the flare
 *                    excludes lightX/lightY for exactly this reason). Every
 *                    material below reads correctly from any direction.
 *   `materialize`  — the appear RAMP. It is the one knob people keyframe, and a
 *                    preset that flattened it back to 1 would silently delete an
 *                    animation.
 *   `backdropScale`— the resolution/performance dial. A look must not quietly make
 *                    the widget four times more expensive to draw.
 *
 * WHERE THE MATERIAL NUMBERS COME FROM: each one is a named real substance, and the
 * knobs follow its physics rather than taste — high refraction and low blur for
 * thick clear solids (a lens bends light without scattering it), the reverse for
 * frosts (scattering without bending), saturation down and a fixed dark tint for
 * absorbing glasses, chromatic dispersion up only where a real material disperses
 * (prism, bubble film), and shadow/contact darkness up with apparent thickness.
 */
const MATERIAL_PRESETS = [
  {
    name: "Liquid Glass",
    description: "The reference: the macOS-26 panel this widget was built to be. Moderate frost, a clear interior, a bent rim and a thin top hairline.",
    props: {
      blurRadius: 8, refractionStrength: 14, edgeFalloff: 22, lightIntensity: 0.8,
      tint: "rgba(255,255,255,0.14)", saturation: 0.92, sheen: 0.1, specularPower: 8,
      contactShadow: 0.26, caustic: 0.12, edgeLight: 0.14, tintAdaptivity: 1,
      chromatic: 0.08, shadowStrength: 0.3,
    },
  },
  {
    name: "Clear Pane",
    description: "Window glass: almost nothing between you and the content. Barely any frost or skin, a narrow bevel, and a bright crisp edge doing all the work of saying it is there.",
    props: {
      blurRadius: 1, refractionStrength: 7, edgeFalloff: 10, lightIntensity: 0.7,
      tint: "rgba(255,255,255,0.03)", saturation: 1, sheen: 0.03, specularPower: 18,
      contactShadow: 0.14, caustic: 0.4, edgeLight: 0.4, tintAdaptivity: 1,
      chromatic: 0.02, shadowStrength: 0.14,
    },
  },
  {
    name: "Deep Frost",
    description: "Sandblasted glass: heavy scattering, almost no bending. The content beneath survives as colour and shape but not as detail; a wide soft bevel and a milky skin.",
    props: {
      blurRadius: 34, refractionStrength: 5, edgeFalloff: 42, lightIntensity: 0.75,
      tint: "rgba(255,255,255,0.42)", saturation: 0.35, sheen: 0.24, specularPower: 5,
      contactShadow: 0.2, caustic: 0, edgeLight: 0.07, tintAdaptivity: 1,
      chromatic: 0, shadowStrength: 0.3,
    },
  },
  {
    name: "Thick Lens",
    description: "A solid block of optical glass: it BENDS hard and scatters almost nothing, so the backdrop sweeps inward across a wide rim while the middle stays sharp. The signature is how far the surroundings pull in.",
    props: {
      blurRadius: 3, refractionStrength: 48, edgeFalloff: 62, lightIntensity: 0.9,
      tint: "rgba(255,255,255,0.05)", saturation: 1, sheen: 0.08, specularPower: 26,
      contactShadow: 0.4, caustic: 0.45, edgeLight: 0.3, tintAdaptivity: 1,
      chromatic: 0.18, shadowStrength: 0.45,
    },
  },
  {
    name: "Prism",
    description: "Dispersive crystal: the red and blue taps sample far apart, so the bent rim breaks into colour. Nearly no frost, so the fringing stays legible.",
    props: {
      blurRadius: 2, refractionStrength: 34, edgeFalloff: 44, lightIntensity: 0.85,
      tint: "rgba(255,255,255,0.04)", saturation: 1, sheen: 0.06, specularPower: 22,
      contactShadow: 0.3, caustic: 0.6, edgeLight: 0.4, tintAdaptivity: 1,
      chromatic: 0.9, shadowStrength: 0.4,
    },
  },
  {
    name: "Smoked Obsidian",
    description: "Dark absorbing glass, adaptivity OFF so it stays dark over dark content too. Colour is mostly absorbed, the surface is glossy, and it sits heavily on what is beneath it.",
    props: {
      blurRadius: 14, refractionStrength: 12, edgeFalloff: 26, lightIntensity: 1.1,
      tint: "rgba(18,18,26,0.62)", saturation: 0.25, sheen: 0.35, specularPower: 30,
      contactShadow: 0.6, caustic: 0.05, edgeLight: 0.5, tintAdaptivity: 0,
      chromatic: 0.04, shadowStrength: 0.6,
    },
  },
  {
    name: "Soap Bubble",
    description: "A film a few wavelengths thick: no body at all, all surface. Iridescent rim, a broad wandering sheen, a bright edge everywhere, and essentially no shadow — it has no weight.",
    props: {
      blurRadius: 1, refractionStrength: 22, edgeFalloff: 36, lightIntensity: 1.2,
      tint: "rgba(255,255,255,0.05)", saturation: 1, sheen: 0.6, specularPower: 3,
      contactShadow: 0.05, caustic: 0.5, edgeLight: 0.65, tintAdaptivity: 0,
      chromatic: 0.55, shadowStrength: 0.05,
    },
  },
  {
    name: "Mercury",
    description: "Liquid metal: saturation to zero and a fixed pewter tint, so it reads as a reflective surface rather than a window. Hard tight specular, a hot rim, and a deep contact shadow.",
    props: {
      blurRadius: 5, refractionStrength: 40, edgeFalloff: 50, lightIntensity: 1.3,
      tint: "rgba(212,218,228,0.5)", saturation: 0, sheen: 0.75, specularPower: 40,
      contactShadow: 0.7, caustic: 0.3, edgeLight: 0.8, tintAdaptivity: 0,
      chromatic: 0.02, shadowStrength: 0.55,
    },
  },
  {
    name: "Sea Glass",
    description: "Tumbled bottle glass: a fixed green cast, colour part-absorbed, and enough surface roughness to blur what is behind it. Matte rather than glossy.",
    props: {
      blurRadius: 18, refractionStrength: 18, edgeFalloff: 34, lightIntensity: 0.7,
      tint: "rgba(122,214,196,0.32)", saturation: 0.6, sheen: 0.18, specularPower: 9,
      contactShadow: 0.34, caustic: 0.08, edgeLight: 0.18, tintAdaptivity: 0,
      chromatic: 0.05, shadowStrength: 0.36,
    },
  },
  {
    name: "Amber Resin",
    description: "Cast resin with something dissolved in it: a warm fixed tint, moderate scattering, real thickness so the rim bends a lot, and a heavy shadow beneath.",
    props: {
      blurRadius: 10, refractionStrength: 28, edgeFalloff: 32, lightIntensity: 0.95,
      tint: "rgba(228,150,52,0.44)", saturation: 0.75, sheen: 0.3, specularPower: 14,
      contactShadow: 0.5, caustic: 0.25, edgeLight: 0.25, tintAdaptivity: 0,
      chromatic: 0.03, shadowStrength: 0.5,
    },
  },
  {
    name: "Vellum",
    description: "Not glass: translucent paper. Pure scattering with the refraction switched OFF, so nothing bends at the rim — the one preset here with no bevel at all. Warm, flat, and nearly weightless.",
    props: {
      blurRadius: 40, refractionStrength: 0, edgeFalloff: 8, lightIntensity: 0.5,
      tint: "rgba(248,246,238,0.5)", saturation: 0.5, sheen: 0.05, specularPower: 4,
      contactShadow: 0.05, caustic: 0, edgeLight: 0.03, tintAdaptivity: 0,
      chromatic: 0, shadowStrength: 0.12,
    },
  },
];

/**
 * The SILHOUETTE family: the outline curve, and nothing else. Three keys —
 * cornerRadius, squircle (the corner exponent) and surfaceTension (how far the
 * flat edges have relaxed INTO that corner curve) — which between them span
 * everything from a sharp card to a true ellipse. The whole family is exactly what
 * render_gpu/skia/glass_shader.js sdGlassScaled parameterizes, and the hairline stroke,
 * the drop shadow and the thumbnail follow it too, so these are silhouettes and
 * not just shader tweaks.
 *
 * Reading the tension column: 0 keeps straight sides (the classic panel), and 1
 * removes them entirely — the outline becomes the superellipse inscribed in the
 * widget's box, where cornerRadius has no effect at all and the exponent alone
 * decides the shape (2 = a true ellipse, 4 = a fat squircle, 7 = a bowed slab).
 */
// A corner radius the shader is GUARANTEED to clamp down to half the shorter side,
// which is what makes a capsule at every size. Four times the default slide's long
// edge (1000 world units), so no panel that fits on a slide — at any zoom, since
// this is a world length — can have a shorter half-side anywhere near it. A literal
// rather than "= Math.min(self.w, self.h) / 2": every preset in this codebase writes
// LITERALS, and an equation here would silently convert the user's radius field into
// an equation-bound one, which is a different kind of state than a preset should
// install.
const CAPSULE_RADIUS = 4000;

const SILHOUETTE_PRESETS = [
  {
    name: "Rounded Panel",
    description: "The reference: straight sides with continuous-curvature corners, the macOS panel shape.",
    props: { cornerRadius: 48, squircle: 4, surfaceTension: 0 },
  },
  {
    name: "Sharp Card",
    description: "Almost a rectangle — a small circular corner and nothing else. Use it when the glass has to sit flush against other rectangular content.",
    props: { cornerRadius: 6, squircle: 2, surfaceTension: 0 },
  },
  {
    name: "Capsule",
    description: "A stadium: circular ends joined by straight sides. The radius is deliberately larger than any panel's shorter half-side, and the shader clamps it down to exactly that, so this stays a capsule at every size.",
    props: { cornerRadius: CAPSULE_RADIUS, squircle: 2, surfaceTension: 0 },
  },
  {
    name: "Continuous Squircle",
    description: "A deep continuous corner: a big radius at a higher exponent, so the corner blends into the side with no visible seam where the arc starts.",
    props: { cornerRadius: 96, squircle: 5, surfaceTension: 0 },
  },
  {
    name: "Softened",
    description: "The first step off flat: the sides bow out very slightly, enough to kill the dead-straight look without reading as a blob.",
    props: { cornerRadius: 48, squircle: 4, surfaceTension: 0.35 },
  },
  {
    name: "Relaxed Cushion",
    description: "Most of the way relaxed: the sides are clearly curved but the shape still reads as a panel rather than an oval. The middle of the new axis.",
    props: { cornerRadius: 48, squircle: 4, surfaceTension: 0.7 },
  },
  {
    name: "Droplet",
    description: "Fully relaxed at the default exponent: a pure squircle filling the box, curved at every single point of its outline. This is what surface tension does when you let it finish.",
    props: { cornerRadius: 48, squircle: 4, surfaceTension: 1 },
  },
  {
    name: "Ellipse",
    description: "Fully relaxed at exponent 2: the true ellipse inscribed in the widget's box. The roundest shape the footprint allows — where surface tension would actually settle.",
    props: { cornerRadius: 48, squircle: 2, surfaceTension: 1 },
  },
  {
    name: "Pillow",
    description: "Fully relaxed at a high exponent: it fills nearly the whole box like a rectangle, but every edge bows gently outward and no part of it is straight.",
    props: { cornerRadius: 48, squircle: 7, surfaceTension: 1 },
  },
];

export const glassPlugin = {
  type: "demo_glass",
  ephemeral: EPHEMERAL.NONE,
  title: "Liquid Glass",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  presetFamilies: [
    { id: "material", title: "Material", presets: MATERIAL_PRESETS },
    { id: "silhouette", title: "Silhouette", presets: SILHOUETTE_PRESETS },
  ],
  defaults: {
    type: "demo_glass", x: 120, y: 160, w: 420, h: 150, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint bright hairline border (the glass edge catch-light). The shader
    // already draws a subtle perimeter outline; this optional stroke reinforces
    // the shape on busy backdrops. strokeWidth 0 ⇒ shader-only edge.
    stroke: "rgba(255,255,255,0.35)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // the glass.* material knobs (self.*)
  },
  inspector: [
    ...bundle("transform"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the material knobs (Inspector "Custom" region)
  ],
  /**
   * Pure function. State → display-list: ONE glassBackdrop op. The bbox (w, h)
   * IS the glass region — cx/cy/halfW/halfH are the local box, emitted in local
   * space (sceneIR wraps them in the node's world). The material knobs pass
   * straight through to the op (which validates + clamps).
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [glassBackdrop({
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      refractionStrength: s.refractionStrength,
      edgeFalloff: s.edgeFalloff,
      lightAngle: s.lightAngle,
      lightIntensity: s.lightIntensity,
      tint: s.tint,
      saturation: s.saturation,
      materialize: s.materialize,
      squircle: s.squircle,
      surfaceTension: s.surfaceTension,
      chromatic: s.chromatic,
      sheen: s.sheen,
      specularPower: s.specularPower,
      contactShadow: s.contactShadow,
      caustic: s.caustic,
      edgeLight: s.edgeLight,
      tintAdaptivity: s.tintAdaptivity,
      shadowStrength: s.shadowStrength,
      backdropScale: s.backdropScale,
      stroke: strokeW > 0 ? s.stroke : null,
      strokeWidth: strokeW,
      opacity: s.opacity ?? 1,
    })];
  },
  hitTest(s, lx, ly) {
    return lx >= 0 && lx <= s.w && ly >= 0 && ly <= s.h;
  },
  snapFeatures(s) {
    return [{ kind: "point", x: s.w / 2, y: s.h / 2, id: "center" }];
  },
  anchors: standardBBoxAnchors,
  // NO top-level `commands`: reached ONLY via the "Add Demo Widget" submenu.
};
