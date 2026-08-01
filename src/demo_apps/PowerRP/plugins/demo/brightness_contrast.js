/**
 * BRIGHTNESS / CONTRAST — a DEMO WIDGET (plugins/demo/, the showcase folder) and a
 * BACKDROP material on the reusable MATERIAL FRAMEWORK. A rounded-rect region that
 * RE-TONES the content beneath it: two knobs (brightness, contrast), a MODE that picks
 * which tone math those knobs mean, and a hue lock. It is the manifest's "REGION
 * FILTER" archetype (a region material that PROCESSES the backdrop pixels within its
 * bounds and paints the result in place), the same family as CRT / comic halftone /
 * digital glitch — a TONE member of it rather than a stylistic one.
 *
 * Like CRT / comic / rainy-window it is a BACKDROP SAMPLER (capabilities.backdrop) and
 * a bbox widget (standard resize handles). It emits ONE `materialBackdrop` op naming
 * the "brightness_contrast" material (render_gpu/skia/materials.js →
 * brightness_contrast_shader.js). It also carries the shared EFFECTS BUNDLE (drop
 * shadow / bloom / blend / inner shadow / soft edges) — injected by core/registry.js,
 * applied by render_gpu/ports.js, so there is no line here to forget.
 *
 * ── WHY ONE WIDGET WITH BOTH KNOBS ────────────────────────────────────────────
 * Brightness and contrast are not independent operations on a display-referred signal:
 * they are two parameters of ONE tone curve, they are almost always dialled against
 * each other, and (in the default SMOOTH mode) they share a pivot. Splitting them into
 * two widgets would mean stacking two full-region backdrop samplers — two below-content
 * re-renders, two shader passes — to express one curve. `plugins/blur.js` being a
 * single-purpose widget is not a counter-precedent: blur has exactly one parameter.
 *
 * ── THE IDENTITY / DEFAULT PAIR (the blur.js precedent, exactly) ───────────────
 * `emit()` returns [] when the settings are NEUTRAL (brightness 0, contrast 1) —
 * byte-identical pass-through, guaranteed structurally rather than by trusting the
 * shader's floating point, and zero cost. That is precisely what blur.js does at
 * radius 0 (`if ((s.blur ?? 0) <= 0) return [];`), and blur is the oldest widget in
 * this family. blur.js also sets its DEFAULT to a plainly visible amount (6, not its
 * identity 0), so this widget's default is a visible punch (contrast 1.4) rather than a
 * no-op you cannot see you inserted. The neutral point is still exactly 0 / 1 and
 * still exactly identity — measured byte-for-byte in tests/brightness_contrast_test.js,
 * both through emit() and through the SHADER with neutral params forced past the
 * short-circuit.
 *
 * The tone math itself — the three modes, why the default cannot clip, why the pivots
 * are where they are, and what the hue lock trades — lives in
 * render_gpu/skia/brightness_contrast_shader.js, next to the SkSL that implements it.
 *
 * Every knob is a CUSTOM self.* property (core/properties.js customProps — the
 * Blender-style mechanism): each is an equation-capable widget-state key (a literal, an
 * expression, or a `= …` equation, referenceable as self.<name>) with ZERO
 * evaluation-engine changes — the material framework carries the params straight to the
 * SkSL uniforms. The look knobs LIVE IN THE SHADER ENTRY now
 * (brightness_contrast_shader.BRIGHTNESS_CONTRAST_FILL_PARAMS — the fill-material
 * framework's single-declaration rule, "custom properties become material properties",
 * comic.js's exact pattern): this widget spreads that same schema into its customProps
 * and adds only its geometry knob (cornerRadius). `mode` is a `select` knob stored as a
 * STRING; the shared brightnessContrastUniformParams maps it to the shader's numeric
 * code (the metaballs/comic TYPE_CODE pattern), for BOTH emit() and the fill path.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-free /
 * bare-node-safe at import time.
 */

import { EPHEMERAL } from "../../core/ephemeral.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { BRIGHTNESS_CONTRAST_FILL_PARAMS, brightnessContrastUniformParams } from "../../render_gpu/skia/brightness_contrast_shader.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// THE NEUTRAL POINT — the settings at which this widget is an exact identity, and the
// values emit() short-circuits on. Named because "0" and "1" alone do not say WHY those
// two numbers are the pair that matters.
export const NEUTRAL_BRIGHTNESS = 0;
export const NEUTRAL_CONTRAST = 1;

// The tone knobs, all self.* custom properties. Every one is DIMENSIONLESS (a curve
// parameter, not a length), so nothing here is resolution- or zoom-dependent;
// `cornerRadius` is the one WORLD-px knob (the backend scales it to device).
// THE LOOK KNOBS LIVE IN THE SHADER ENTRY now (BRIGHTNESS_CONTRAST_FILL_PARAMS
// — the fill-material framework's single-declaration rule: "custom properties
// become material properties"). This widget spreads that SAME schema (mode,
// brightness with its load-bearing scrub, contrast, preserveHue) into its
// customProps and adds only its widget-side geometry knob (cornerRadius). Byte-
// compatible with the pre-fill widget: the schema's defaults ARE the old inline
// defaults (contrast 1.4, brightness 0), and the NEUTRAL identity is still 0 / 1.
const CUSTOM = customProps([
  ...BRIGHTNESS_CONTRAST_FILL_PARAMS,
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the adjusted region (world px). 0 = sharp corners." },
]);

// The canonical looks, surfaced by web/ToolsPane.svelte (props = a flat knob map).
// Each writes ALL FOUR tone keys, so switching between them is deterministic rather
// than leaving a stray knob from whichever was picked before.
const PRESETS = [
  {
    name: "Dim for Overlay",
    description: "One and a bit stops down in linear light — dims EVERYTHING including the whites, so text laid over the region reads. The presentation move.",
    props: { mode: "linear", brightness: -1.2, contrast: 1, preserveHue: false },
  },
  {
    name: "Punch",
    description: "A steep S-curve that still fixes black and white: much more contrast, no crushed shadows and no blown highlights.",
    props: { mode: "smooth", brightness: 0, contrast: 1.6, preserveHue: false },
  },
  {
    name: "Wash Out",
    description: "Flatten toward grey and lift the midtones — pushes a region back so something else can come forward.",
    props: { mode: "smooth", brightness: 0.4, contrast: 0.45, preserveHue: false },
  },
  {
    name: "Exposure +1 Stop",
    description: "Twice the light, in linear light, with the curve otherwise untouched. Photographically what it says; the brightest highlights clip.",
    props: { mode: "linear", brightness: 1, contrast: 1, preserveHue: false },
  },
  {
    name: "Punch, Hue Locked",
    description: "The same S-curve applied to brightness ALONE: tone changes, hue and saturation are held exactly. Compare against Punch to see how much colour the per-channel version adds.",
    props: { mode: "smooth", brightness: 0, contrast: 1.6, preserveHue: true },
  },
  {
    name: "sRGB Direct (clips)",
    description: "The naive slider, for comparison: the same amount of contrast, but shadows crush to black and highlights blow to flat white. This is what the default mode exists to avoid.",
    props: { mode: "srgb", brightness: 0.04, contrast: 1.6, preserveHue: false },
  },
];

/**
 * Pure function. Is this state the NEUTRAL tone — the exact identity at which the
 * widget must be a byte-identical pass-through? Only the two curve parameters decide
 * it: `mode` picks which math is neutral-at-0/1 (all three are), and `preserveHue`
 * cannot change an identity into a non-identity (toning luma by an identity curve
 * re-scales the triple by exactly 1).
 *
 * @param {object} s - evaluated widget state
 * @returns {boolean}
 *
 * @example isNeutralTone({brightness: 0, contrast: 1}) // true
 * @example isNeutralTone({brightness: 0, contrast: 1, mode: "srgb", preserveHue: true}) // true (every mode is identity at 0/1)
 * @example isNeutralTone({brightness: 0, contrast: 1.4}) // false
 * @example isNeutralTone({brightness: -0.2, contrast: 1}) // false
 */
export function isNeutralTone(s) {
  return s.brightness === NEUTRAL_BRIGHTNESS && s.contrast === NEUTRAL_CONTRAST;
}

export const brightnessContrastPlugin = {
  type: "demo_brightness_contrast",
  ephemeral: EPHEMERAL.NONE,
  title: "Brightness / Contrast",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    type: "demo_brightness_contrast", x: 140, y: 140, w: 460, h: 360, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint hairline framing the adjusted region (optional; strokeWidth 0 = none).
    stroke: "rgba(255,255,255,0.35)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1 — and, because the shader replaces the pixel it
                            // adjusted, item opacity is also the wet/dry mix against the
                            // untouched original for free.
    ...CUSTOM.defaults,     // the tone knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the tone knobs (Inspector "Custom" region)
  ],
  presets: PRESETS,
  /**
   * Pure function. State → display-list: ONE materialBackdrop op naming the
   * "brightness_contrast" material — or NOTHING when the tone is neutral (the blur.js
   * radius-0 precedent: an identity adjustment is a byte-identical pass-through AND
   * free, instead of a full-cost round trip through a curve that does nothing).
   *
   * The bbox (w, h) IS the adjusted region (local space; sceneIR wraps it in the node's
   * world). The `mode` select string maps to the shader's numeric code here and
   * `preserveHue` to 0/1; the two curve parameters pass straight through.
   *
   * `blurRadius: 0` and `backdropScale: 1` are DELIBERATE and this material exposes no
   * knob for either. The material declares `usesBlurredBackdrop: false`, so the blurred
   * child is never built and its radius is dead. And a tone curve is a POINT operation:
   * re-rendering the content beneath at a higher resolution only to sample it back at
   * screen resolution would cost more and resolve strictly less, so there is nothing
   * for a supersample factor to buy.
   */
  emit(s) {
    if (isNeutralTone(s)) return [];
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "brightness_contrast",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: 0,
      backdropScale: 1,
      // The SAME schema→uniform mapping the fill-material path uses (one declaration):
      // maps the `mode` select string to its numeric code and `preserveHue` to 0/1, and
      // throws LOUD on an unknown mode (the crt.js maskType precedent).
      params: brightnessContrastUniformParams(s),
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
