/**
 * Frosted Glass — a DEMO WIDGET (plugins/demo/, the showcase folder) and a
 * BACKDROP material on the reusable MATERIAL FRAMEWORK. A rounded-rect panel that
 * BLURS the content behind it and veils it with a subtle translucent frost tint —
 * a plain iOS/macOS "frosted material" card.
 *
 * It is deliberately the BASIC cousin of Liquid Glass (plugins/demo/glass.js):
 * same backdrop-blur groundwork, but NONE of the liquid-glass character — no
 * refraction / edge distortion, no specular / sheen, no chromatic aberration,
 * no luminance-adaptive tint. Just clean backdrop blur + frost. The PRESETS below
 * widen its RANGE (smoked, milky, tinted, obscuring) without touching that line:
 * every one of them is still a straight blur under a flat tint.
 *
 * Like CRT and Liquid Glass it is a BACKDROP SAMPLER (capabilities.backdrop) and
 * a bbox widget (standard resize handles). It emits ONE `materialBackdrop` op
 * naming the "frosted" material (render_gpu/skia/materials.js -> frosted_shader.js).
 *
 * It DOES carry the shared EFFECTS BUNDLE (drop shadow / bloom / blend / inner
 * shadow / soft edges) — injected by core/registry.js, applied by
 * render_gpu/ports.js, so there is no line for this file to forget. The claim that
 * used to stand here ("it does NOT compose the effects bundle: a backdrop sampler
 * cannot be wrapped in an effectSubtree, whose offscreen re-render would sample an
 * empty surface") was FALSE, and it is why the user asked "Why does Frosted Glass
 * not have a soft edges option like all the other things? Why is there no drop
 * shadow option on the Frosted Glass?". The panel's shader writes premultiplied
 * ZERO outside its own SDF, so its offscreen ALPHA *is* the panel silhouette —
 * exactly what those effects need. The only real defect was that the effect
 * scratch gave a nested sampler nothing to read (a dark smear, rgb(51,51,51)
 * instead of rgb(148,51,158)); paint_skia.js's `below` context now hands it the
 * outer composite.
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps —
 * the Blender-style mechanism): each is an equation-capable widget-state key (edit
 * as a literal, an expression, or a `= …` equation, and reference elsewhere as
 * self.<name>) with ZERO evaluation-engine changes — the material framework
 * carries the params straight to the SkSL uniforms. The bright hairline BORDER is
 * the op's stroke/strokeWidth (drawn by the shared material border helper), same
 * as CRT / glass — not a self.* knob.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte), keeping
 * the core Add menus clean. DOM-free / bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { FROSTED_FILL_PARAMS, frostedUniformParams } from "../../render_gpu/skia/frosted_shader.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// The frosted look knobs, all self.* custom properties. `blurRadius` / `cornerRadius`
// are WORLD px (the backend scales to device by world.scale·zoom·dpr); `frost` and
// `absorb` are resolution-independent 0..1 amounts; `tint` is a plain solid colour.
//
// FROST AND ABSORB ARE THE SAME COLOUR APPLIED IN OPPOSITE DIRECTIONS, which is what
// lets one tint knob serve both a milky pane and a body-tinted one. `absorb` defaults
// to 0, so the shipped widget is byte-for-byte the veil-only frost it always was.
//
// THE LOOK KNOBS LIVE IN THE SHADER ENTRY now (frosted_shader.FROSTED_FILL_PARAMS
// — the fill-material framework's single-declaration rule: "custom properties become
// material properties"). This widget spreads that SAME schema into its customProps
// and adds only its widget-side geometry knob (cornerRadius).
const CUSTOM = customProps([
  ...FROSTED_FILL_PARAMS,
  { name: "cornerRadius", kind: "number", default: 32, min: 0, help: "Rounded-corner radius of the panel (world px). A capsule when it reaches half the shorter side." },
]);

/**
 * THE PRESETS — `{name, description, props}`, ONE FLAT family, applied to the current
 * frame in one undo unit by the Presets pane (web/ToolsPane.svelte → app.applyPreset).
 * The user's complaint was that this widget shipped with NONE, so a look meant reading
 * four knobs and guessing; twelve named looks is the answer.
 *
 * ── WHAT A PRESET MAY WRITE, AND WHY THAT IS ONLY THE FOUR LOOK KNOBS ────────
 * Every preset sets `blurRadius`, `frost`, `tint` and `absorb` — ALL FOUR, ALWAYS.
 * app.applyPreset writes exactly the keys in `props` as an OVERLAY, so a knob one
 * preset omits keeps whatever the PREVIOUSLY hovered preset left there, and the pane's
 * whole purpose is comparing looks by running down the list. The rule is
 * plugins/demo/sky.js's, enforced for this widget by tests/frosted_presets_test.js.
 *
 * `cornerRadius` and `stroke`/`strokeWidth` are DELIBERATELY ABSENT. Both are things
 * the user shapes for their own layout — the panel's rounding and its hairline edge —
 * and a look pick must not undo a framing the user chose (the exclusion
 * plugins/demo/lens_flare.js makes for lightX/lightY/flareScale). This follows the
 * MAJORITY of the shipped backdrop-material libraries: comic, glitch and
 * brightness_contrast all expose the same three keys and none of their presets writes
 * one. CRT alone writes `cornerRadius`, because on a CRT the face's corner radius is
 * part of WHICH TUBE it is; on a plain panel it is just the card's rounding.
 *
 * ── THE ORDER IS BY MECHANISM, NOT BY TASTE ──────────────────────────────────
 * Neutrals first, along the frost ladder from a pane you can barely see to a solid
 * card (Clear Haze → Frosted Panel → Privacy Blur → Milk Glass → Opal Card); then the
 * two DARKS, which are dark by opposite means; then the three BODY-TINTED colours,
 * which absorb; then the two TINTED FROSTS, which scatter. Hue is the last thing that
 * varies, so neighbours in the list never differ by hue alone.
 *
 * ── THE TWO KNOBS THAT MAKE A COLOUR, AND WHY BOTH EXIST ─────────────────────
 * `tint` feeds Absorb and Frost, which pull in OPPOSITE directions: Frost lifts every
 * pixel toward the tint (milky, blacks go pale), Absorb multiplies by it (glassy,
 * blacks stay black). So the same green is "Bottle Green" at absorb 0.80 / frost 0.08
 * and would be a flat green film at frost 0.45 / absorb 0. Note what that means for
 * reading the table: an ABSORBING preset's tint is its TRANSMISSION SPECTRUM — the
 * light that gets through — so it is a LIGHT colour even when the panel is dark
 * (Bottle Green's rgb(118,204,148) makes a deep green pane, because the backdrop is
 * multiplied by it). A FROSTING preset's tint is the veil's own colour and reads
 * literally.
 *
 * ── DISTINCTNESS IS MEASURED, NOT ASSERTED ───────────────────────────────────
 * Every entry was rendered over ONE varied backdrop (a bright half and a dark half,
 * five saturated hues, and a stripe frequency ramp) and the set was scored by mean
 * CIE76 ΔE*ab over the panel interior, pairwise. Two candidates were CUT for failing
 * that and nothing else: a "Whiteout" (heavy blur + mid frost) sat at ΔE 8.9 from a
 * pale-blue haze and 11.8 from Milk Glass — it was the midpoint of a sweep rather than
 * a look — and a first "Charcoal" veil-dark sat at 9.5 from Smoked Glass, because for
 * a DARK NEUTRAL tint the two mechanisms collapse onto nearly the same tone curve
 * (mix(v, 0.12, 0.58) ≈ 0.42v + 0.07 against v · 0.38). The survivor pair is separated
 * on BLUR as well as tone, which is the axis that actually distinguishes them.
 * tests/frosted_presets_test.js holds the whole library to that bar in pixels.
 */
const PRESETS = [
  {
    name: "Clear Haze",
    description: "The lightest touch in the set: a few pixels of blur and almost no veil, so the content behind stays legible and only softens. Use it when the panel should read as glass without hiding anything.",
    props: { blurRadius: 5, frost: 0.05, tint: "rgb(255,255,255)", absorb: 0 },
  },
  {
    name: "Frosted Panel",
    description: "The stock frosted-material card, and this widget's own defaults: a moderate blur under a subtle white veil. The everyday translucent panel to put a title or a control on.",
    props: { blurRadius: 12, frost: 0.2, tint: "rgb(255,255,255)", absorb: 0 },
  },
  {
    name: "Privacy Blur",
    description: "Blur alone, taken far past legibility, with essentially no veil — so the backdrop's own colours and darks still show through as soft shapes. The look of obscured bathroom glazing, and the one to reach for to hide a screenshot's contents.",
    props: { blurRadius: 60, frost: 0.04, tint: "rgb(255,255,255)", absorb: 0 },
  },
  {
    name: "Milk Glass",
    description: "A bright milky pane: a heavy white veil over a moderate blur, so the backdrop survives as pale ghosts of itself. Lifts a dark backdrop a long way — the panel becomes the light thing on the slide.",
    props: { blurRadius: 22, frost: 0.62, tint: "rgb(255,255,255)", absorb: 0 },
  },
  {
    name: "Opal Card",
    description: "Nearly solid: the veil is strong enough that the panel reads as a warm off-white card with only a hint of what is behind it. The end of the frost ladder, for when you want a surface to write on rather than a window.",
    props: { blurRadius: 16, frost: 0.88, tint: "rgb(246,244,238)", absorb: 0 },
  },
  {
    name: "Graphite Frost",
    description: "A dark matte slab: a heavy blur under a strong charcoal veil, so contrast is crushed and the panel reads as opaque stone. The dark that HIDES. Its opposite number is Smoked Glass, which is dark and still see-through.",
    props: { blurRadius: 34, frost: 0.55, tint: "rgb(46,49,60)", absorb: 0 },
  },
  {
    name: "Smoked Glass",
    description: "Dark by ABSORPTION rather than by veiling: a light blur and almost no frost, with the tint multiplying the backdrop, so blacks stay black and bright content still reads clearly through the pane. The dark that you can still see through.",
    props: { blurRadius: 10, frost: 0.02, tint: "rgb(78,82,96)", absorb: 0.88 },
  },
  {
    name: "Bottle Green",
    description: "Body-tinted green architectural glass. The tint is the TRANSMISSION spectrum, so a pale green makes a deep green pane: warm things behind it go olive, the dark side stays dark, and the whole thing looks like a thick float-glass edge.",
    props: { blurRadius: 12, frost: 0.08, tint: "rgb(118,204,148)", absorb: 0.8 },
  },
  {
    name: "Ocean Blue",
    description: "The blue member of the body-tinted family: the same absorbing pane in a cool cast, so warm content behind it is filtered away and the panel reads as thick blue glass rather than a blue overlay.",
    props: { blurRadius: 12, frost: 0.08, tint: "rgb(108,168,232)", absorb: 0.8 },
  },
  {
    name: "Bronze",
    description: "Warm smoked bronze — the amber-tinted glazing of a 70s office block. Absorbs the blue out of everything behind it, so a lit backdrop goes tan and a cool one goes muddy brown.",
    props: { blurRadius: 12, frost: 0.08, tint: "rgb(216,152,88)", absorb: 0.78 },
  },
  {
    name: "Rose Quartz",
    description: "A pink FROSTED pane rather than a pink absorbing one: the veil dominates, so the tint is added on top of everything and even the dark side of the backdrop goes soft and pale. Warm and light where Bottle Green and Ocean Blue are deep.",
    props: { blurRadius: 18, frost: 0.5, tint: "rgb(255,198,210)", absorb: 0.25 },
  },
  {
    name: "Arctic Ice",
    description: "A cold pale-blue haze: a big blur under a moderate icy veil, with just enough absorption to keep the darks from washing out completely. The chilly counterpart to Milk Glass, and much softer than Ocean Blue.",
    props: { blurRadius: 40, frost: 0.45, tint: "rgb(168,212,240)", absorb: 0.3 },
  },
];

export const frostedGlassPlugin = {
  type: "demo_frosted_glass",
  title: "Frosted Glass",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  presets: PRESETS,
  defaults: {
    type: "demo_frosted_glass", x: 130, y: 150, w: 420, h: 280, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint bright hairline border (the frosted panel's edge). strokeWidth 0 = none.
    stroke: "rgba(255,255,255,0.35)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // the frosted.* look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Border color" },
      strokeWidth: { label: "Border width" },
    }),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  /**
   * Pure function. State -> display-list: ONE materialBackdrop op naming the
   * "frosted" material. The bbox (w, h) IS the panel region (local space; sceneIR
   * wraps it in the node's world). The look knobs pass through as the op's
   * `params`; the op validates + clamps geometry and the SkSL packer clamps/parses
   * the uniforms.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "frosted",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      // The SAME schema→uniform mapping the fill-material path uses (one declaration).
      params: frostedUniformParams(s),
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
