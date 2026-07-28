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
 * SkSL uniforms. `mode` is a `select` knob stored as a STRING; emit() maps it to the
 * shader's numeric code (the metaballs/comic TYPE_CODE pattern).
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-free /
 * bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { UNIT_SPAN_SCRUB, bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// select ids → the shader's numeric mode codes (brightness_contrast_shader.js).
const MODE_OPTIONS = ["smooth", "linear", "srgb"];
const MODE_LABELS = {
  smooth: "Smooth (cannot clip)",
  linear: "Linear light (exposure in stops)",
  srgb: "sRGB direct (naive — clips)",
};
const MODE_CODE = { smooth: 0, linear: 1, srgb: 2 };

// THE NEUTRAL POINT — the settings at which this widget is an exact identity, and the
// values emit() short-circuits on. Named because "0" and "1" alone do not say WHY those
// two numbers are the pair that matters.
export const NEUTRAL_BRIGHTNESS = 0;
export const NEUTRAL_CONTRAST = 1;

// The tone knobs, all self.* custom properties. Every one is DIMENSIONLESS (a curve
// parameter, not a length), so nothing here is resolution- or zoom-dependent;
// `cornerRadius` is the one WORLD-px knob (the backend scales it to device).
const CUSTOM = customProps([
  { name: "mode", kind: "select", options: MODE_OPTIONS, optionLabels: MODE_LABELS, default: "smooth", help: "Which tone math the two knobs mean. Smooth (the default) is built for a finished on-screen image: it fixes black and white, so it CANNOT crush shadows or blow highlights however far you push it. Linear light treats brightness as a real exposure change in stops and contrast as a power about 18% grey — physically what a camera does, and it CAN clip past white. sRGB direct is the naive slider every other tool ships; it is here so you can see what the other two avoid." },
  // SCRUB, measured against `contrast` below — its twin in this widget, and the row
  // that shows how far out this one was. `contrast` (default 1.4) scrubs at 0.014/px
  // by inference from its fractional default; `brightness` is the ZERO-default,
  // fully-open shape inference provably cannot reach (the census's "paletteOffset
  // shape": no bounds, no magnitude, so nothing in the row says it is fractional), so
  // it fell back to 1 unit/px — SEVENTY TIMES coarser than its twin on a knob whose
  // own help says +1 is a whole STOP of exposure. One drag-pixel therefore blew the
  // image out. The useful domain is unit-scaled about 0 in every one of the three
  // modes (a midtone lift, a stop, or a flat channel offset), so one 100px drag run
  // now spans one unit, i.e. one stop.
  { name: "brightness", kind: "number", default: NEUTRAL_BRIGHTNESS, scrub: UNIT_SPAN_SCRUB, help: "0 = unchanged. Positive brightens, negative darkens. In Smooth mode this is a midtone lift that leaves pure black and pure white alone (+1 lifts 25% grey to 50%). In Linear-light mode it is an EXPOSURE in stops (+1 = twice the light, and whites clip). In sRGB mode it is a flat offset added to every channel." },
  { name: "contrast", kind: "number", default: 1.4, min: 0, help: "1 = unchanged, higher = punchier, 0 = flat grey. This is the SLOPE of the tone curve at mid-grey in every mode, so it means the same thing here as a contrast slider anywhere else — the modes differ only in what happens far from mid-grey, where the naive version clips and Smooth rolls off instead." },
  { name: "preserveHue", kind: "boolean", default: false, help: "Off (the usual look): each colour channel is toned on its own, so raising contrast also deepens colour. On: only the brightness of each pixel changes and its hue and saturation are held exactly — the honest choice when the point is to re-tone a photo or figure without recolouring it. Boosting a saturated colour with this on can push a channel out of range and clip it." },
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
    // LOUD on an unknown mode (the crt.js maskType precedent): silently grading with
    // the wrong tone math is worse than a stopped render.
    const mode = MODE_CODE[s.mode];
    if (mode === undefined)
      throw new Error(`brightness_contrast.emit: unknown mode ${JSON.stringify(s.mode)} (expected one of ${MODE_OPTIONS.join(", ")})`);
    return [materialBackdrop({
      material: "brightness_contrast",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: 0,
      backdropScale: 1,
      params: {
        mode,
        brightness: s.brightness,
        contrast: s.contrast,
        preserveHue: s.preserveHue ? 1 : 0,
      },
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
