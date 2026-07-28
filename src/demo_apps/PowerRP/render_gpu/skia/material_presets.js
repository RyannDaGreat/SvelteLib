/**
 * MATERIAL PRESET LIBRARY — knob presets keyed by MATERIAL id.
 *
 * WHY THIS FILE EXISTS (manifest D.10–11): tool presets used to bind to the
 * WIDGET TYPE, so a plain rect carrying the sky material as its FILL showed no
 * presets at all — the presets lived on the sky WIDGET, not on the sky MATERIAL.
 * web/ToolsPane.svelte now reads the SELECTED item's current fill/stroke paints
 * and, when a slot holds `{type:"material", material:{id}}`, surfaces THIS
 * library's presets for that id (additive to any widget-type presets). So the
 * offering follows the material a paint carries, wherever it is carried.
 *
 * A preset is `{id, title, description?, params}` where `params` is a SPARSE map
 * of that material's own knob names (from its `fillParams`/`strokeParams` schema
 * in materials.js / stroke_materials.js — read READ-ONLY to compose these) to
 * values. ToolsPane applies a preset by writing each pair to
 * ["items", itemId, <slot>, "material", "params", <knob>] on the current frame
 * through the standard preview→commit path (ONE undo unit). Params are sparse by
 * the same rule the knob rows use: only the knobs a preset means to change are
 * listed; everything else keeps the material's default.
 *
 * The registry is keyed by material id (fill AND stroke ids share the lookup —
 * their id namespaces do not collide). A material with no entry is not an error:
 * presetsForMaterial returns [] and ToolsPane shows no section for it.
 *
 * EVERY PRESET HERE WAS RENDERED AND LOOKED AT (the ?cli=1 __powerrp_render seam,
 * screenshots in .claude_vlm_checks/preset_*.png) — no blind knob guesses, per
 * the manifest's recordable-state verification discipline.
 *
 * NOTE ON THE SKY MATERIAL: a sky FILL has no scene sun (suns come from sibling
 * sky-sun widgets, not from paint params), and the shader ramps day↔night off the
 * highest sun — "no sun ⇒ night" (sky_shader.js). So a sky-as-fill is ALWAYS a
 * NIGHT sky; these presets vary the night look (star density, Milky Way, night
 * colour, galaxy tint), which is what a fill can actually change.
 */

// ── The registry ─────────────────────────────────────────────────────────────
// Keyed by material id → ordered preset list. Ordering is content: read top-down.
export const MATERIAL_PRESETS = {
  // FILL: sky (night-sky variants — see the file header note on the missing sun).
  sky: [
    { id: "starfield", title: "Starfield", description: "A crisp, star-dense night with a faint galaxy band.",
      params: { starDensity: 130, milkyWay: 0.35, night: "#03040c", galaxyTint: "#3a4a6a", ground: "#05070e", horizon: -0.6 } },
    { id: "milkyway", title: "Milky Way", description: "The galactic band blazing across a deep-blue sky.",
      params: { starDensity: 95, milkyWay: 1.6, timeOfDay: 0.35, night: "#04060f", galaxyTint: "#7184b8", ground: "#04060d", horizon: -0.75 } },
    { id: "deep_space", title: "Deep Space", description: "Near-black void with dense pinprick stars, no visible galaxy.",
      params: { starDensity: 210, milkyWay: 0.08, night: "#010104", galaxyTint: "#22304a", ground: "#010104", horizon: -0.9 } },
    { id: "aurora", title: "Aurora Night", description: "A green-tinted night, like a sky lit by distant aurora.",
      params: { starDensity: 70, milkyWay: 0.7, night: "#06141a", galaxyTint: "#2f8f74", ground: "#04120d", horizon: -0.55 } },
    { id: "twilight", title: "Clear Twilight", description: "A brighter blue dusk with sparse stars and a visible ground.",
      params: { starDensity: 34, milkyWay: 0.4, night: "#0b1636", galaxyTint: "#46567c", ground: "#0d1526", horizon: -0.15 } },
  ],

  // FILL: mandelbrot (classic locations; halfWidth = 10^-zoomExponent, verified to
  // ~1e-11 before the reference orbit runs out — kept shallower than that).
  mandelbrot: [
    { id: "whole_set", title: "Whole Set", description: "The full Mandelbrot set, zoomed all the way out.",
      params: { centerX: -0.5, centerY: 0, zoomExponent: -0.2, maxIterations: 500, paletteScale: 12 } },
    { id: "seahorse", title: "Seahorse Valley", description: "The famous seahorse-tail spirals on the neck of the set.",
      params: { centerX: -0.746, centerY: 0.105, zoomExponent: 2.4, maxIterations: 1000 } },
    { id: "elephant", title: "Elephant Valley", description: "The trunk-like spirals in the valley right of the main cardioid.",
      params: { centerX: 0.2755, centerY: 0.0075, zoomExponent: 2.6, maxIterations: 1000 } },
    { id: "triple_spiral", title: "Triple Spiral", description: "A three-armed spiral junction, high in the upper bulb.",
      params: { centerX: -0.0885, centerY: 0.6545, zoomExponent: 3.0, maxIterations: 1200 } },
    { id: "mini", title: "Minibrot", description: "A tiny self-similar copy of the whole set, on the antenna near -1.75.",
      params: { centerX: -1.7548777, centerY: 0, zoomExponent: 1.6, maxIterations: 1200 } },
    { id: "spiral_detail", title: "Spiral Detail", description: "A deep spiral in the upper bulb of the set.",
      params: { centerX: -0.235125, centerY: 0.827215, zoomExponent: 3.0, maxIterations: 1200, paletteScale: 20 } },
  ],

  // FILL: comic (halftone / print looks).
  comic: [
    { id: "newsprint", title: "Newsprint", description: "Coarse single-ink halftone on cream newsprint.",
      params: { mode: "mono", pitch: 6, dotShape: "round", grain: 0.16, registration: 0.05, paperColor: "#efe7d2" } },
    { id: "manga", title: "Manga", description: "High-contrast black ink with inked edges, screentone dots.",
      params: { mode: "duotone", pitch: 9, inkA: "#151515", inkB: "#fbf8f0", edgeInk: 0.5, grain: 0.05, paperColor: "#fbf8f0" } },
    { id: "pop_art", title: "Pop Art", description: "Big misregistered CMYK dots, Lichtenstein-style.",
      params: { mode: "cmyk", pitch: 16, dotShape: "round", registration: 0.4, dotGain: 0.1, paperColor: "#fff6d8" } },
    { id: "sunday_funnies", title: "Sunday Funnies", description: "Full-colour newspaper comic halftone.",
      params: { mode: "cmyk", pitch: 10, registration: 0.22, dotGain: 0.05, paperColor: "#fbf3e0" } },
    { id: "risograph", title: "Risograph", description: "Two-ink riso print in hot pink and blue.",
      params: { mode: "duotone", inkA: "#ff4870", inkB: "#0078bf", pitch: 12, grain: 0.1, paperColor: "#f4efe4" } },
  ],

  // FILL: crt (screen / monitor looks).
  crt: [
    { id: "arcade", title: "Arcade", description: "Bright aperture-grille cabinet with a curved, bloomy tube.",
      params: { maskType: "aperture", maskStrength: 0.5, scanlineStrength: 0.65, beamBloom: 0.6, curvature: 0.12, vignette: 0.4, halation: 0.2 } },
    { id: "green_terminal", title: "Green Terminal", description: "Monochrome P1 green phosphor terminal.",
      params: { monochrome: 1, phosphorTint: "#33ff66", maskType: "none", scanlineStrength: 0.6, curvature: 0.08, halation: 0.25, vignette: 0.35 } },
    { id: "amber_terminal", title: "Amber Terminal", description: "Monochrome amber phosphor terminal.",
      params: { monochrome: 1, phosphorTint: "#ffb000", maskType: "none", scanlineStrength: 0.5, curvature: 0.06, halation: 0.22 } },
    { id: "broadcast", title: "Broadcast TV", description: "Soft shadow-mask TV with heavy halation and convergence error.",
      params: { maskType: "shadow", maskStrength: 0.4, scanlineStrength: 0.4, halation: 0.35, convergence: 0.06, curvature: 0.16, vignette: 0.5, diffusion: 0.3 } },
    { id: "trinitron", title: "Trinitron", description: "Fine aperture-grille tube, nearly flat, crisp scanlines.",
      params: { maskType: "aperture", maskPitch: 4, maskStrength: 0.45, scanlineStrength: 0.55, curvature: 0.04, vignette: 0.25 } },
  ],

  // FILL: glitch (digital corruption looks).
  glitch: [
    { id: "datamosh", title: "Datamosh", description: "Big displaced blocks and colour smear, like a corrupted codec.",
      params: { intensity: 1, blockCount: 30, maxShiftPx: 26, density: 0.6, corrupt: 0.12, dropout: 0.08, glow: 0.2 } },
    { id: "vhs", title: "VHS", description: "Tape wobble, chroma split and heavy scanlines.",
      params: { rgbSplitPx: 4, scanlineDepth: 0.45, wobbleAmp: 3, wobbleFreq: 22, tearRate: 4, glow: 0.3, tint: "#e2ffe8", grain: 0.1 } },
    { id: "signal_loss", title: "Signal Loss", description: "Dropouts and rolling tears, a channel losing lock.",
      params: { intensity: 1, dropout: 0.3, density: 0.5, tearRate: 12, corrupt: 0.18, tearHeight: 0.2 } },
    { id: "chromatic_break", title: "Chromatic Break", description: "Strong radial RGB split with a bright bloom.",
      params: { rgbSplitPx: 9, splitMode: "radial", intensity: 0.8, blockCount: 10, glow: 0.45, density: 0.25 } },
    { id: "pixel_crush", title: "Pixel Crush", description: "Chunky pixelation and posterized colour bands.",
      params: { pixelate: 8, posterize: 6, intensity: 0.7, blockCount: 8, density: 0.3, glow: 0.1 } },
  ],

  // STROKE: brush (procedural-brush archetypes — mostly pick the archetype + ink).
  brush: [
    { id: "ink_pen", title: "Ink Pen", description: "A clean, confident ink line.",
      params: { brush: "inkPen", color: "#141420", flow: 1, spacing: 1 } },
    { id: "watercolor", title: "Watercolor Wash", description: "A soft, bleeding watercolour stroke.",
      params: { brush: "watercolor", color: "#3a6ea5", flow: 0.6, spacing: 1.2, scatter: 0.2 } },
    { id: "charcoal", title: "Charcoal", description: "A grainy, broken charcoal line.",
      params: { brush: "charcoal", color: "#1e1e1e", spacing: 1, sizeJitter: 0.3, angleJitter: 0.2 } },
    { id: "pencil", title: "Pencil", description: "A light graphite pencil stroke.",
      params: { brush: "pencilHB", color: "#333333", flow: 0.8, spacing: 1 } },
    { id: "marker", title: "Marker", description: "A bold, saturated felt-marker stroke.",
      params: { brush: "marker", color: "#e63946", flow: 0.9, spacing: 0.8 } },
    { id: "airbrush", title: "Spray Paint", description: "A scattered airbrush spray.",
      params: { brush: "airbrush", color: "#2a9d8f", scatter: 1.2, spacing: 1.5, sizeJitter: 0.4 } },
    { id: "oil", title: "Oil Impasto", description: "A thick, textured oil-paint stroke.",
      params: { brush: "oil", color: "#6a4c93", flow: 1, spacing: 1, sizeJitter: 0.2 } },
  ],
};

// Human display names for the Tools-area section titles ("Sky material presets").
// Fill materials carry no `label` in their descriptor; stroke materials do, but a
// single map keeps the two slots consistent and is where a new material's name goes.
const MATERIAL_DISPLAY_NAMES = {
  sky: "Sky",
  mandelbrot: "Mandelbrot",
  comic: "Comic",
  crt: "CRT",
  glitch: "Glitch",
  brush: "Brush",
};

/**
 * Query. The display name for a material id, used to title its preset section —
 * falls back to the id itself (never blank) when the map has no entry.
 *
 * @param {string} id - a material id ("sky", "brush", …)
 * @returns {string}
 *
 * @example materialDisplayName("sky") // "Sky"
 * @example materialDisplayName("mandelbrot") // "Mandelbrot"
 * @example materialDisplayName("unknownMat") // "unknownMat"
 */
export function materialDisplayName(id) {
  return MATERIAL_DISPLAY_NAMES[id] ?? id;
}

/**
 * Pure function. The preset list for a material id, or [] when the material has
 * none (not an error — most materials ship no presets yet). Throws LOUDLY on a
 * MALFORMED entry: a preset must be a `{id, title, params}` object whose `params`
 * is a plain object, because a silent bad entry would surface a blank, no-op row.
 *
 * @param {string} id - a material id ("sky", "mandelbrot", "brush", …)
 * @returns {Array<{id: string, title: string, description?: string, params: object}>}
 *
 * @example presetsForMaterial("sky").length // 5
 * @example presetsForMaterial("sky")[0].title // "Starfield"
 * @example presetsForMaterial("brush")[0].params.brush // "inkPen"
 * @example presetsForMaterial("nope") // []
 */
export function presetsForMaterial(id) {
  const list = MATERIAL_PRESETS[id];
  if (!list) return [];
  if (!Array.isArray(list))
    throw new Error(`material_presets: entry for "${id}" is not an array (got ${typeof list})`);
  for (const p of list) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || typeof p.title !== "string")
      throw new Error(`material_presets: malformed preset in "${id}" — need string id + title: ${JSON.stringify(p)?.slice(0, 120)}`);
    if (!p.params || typeof p.params !== "object" || Array.isArray(p.params))
      throw new Error(`material_presets: preset "${id}/${p.id}" has no plain-object params: ${JSON.stringify(p.params)?.slice(0, 120)}`);
  }
  return list;
}
