/**
 * COMIC HALFTONE — a DEMO WIDGET (plugins/demo/, the showcase folder) and a
 * BACKDROP material on the reusable MATERIAL FRAMEWORK. A rounded-rect region that
 * REPRINTS the content beneath it as an old-school comic / newsprint HALFTONE:
 * the tone below is separated into ink channels and each is redrawn as a grid of
 * Ben-Day DOTS whose size tracks coverage, on its own rotated screen angle, over a
 * paper base. Four modes (CMYK / additive-RGB / duotone / mono), optional flat-fill
 * posterize, a Sobel edge-ink outline, and paper grain.
 *
 * Like CRT / rainy-window it is a BACKDROP SAMPLER (capabilities.backdrop) and a
 * bbox widget (standard resize handles). It emits ONE `materialBackdrop` op naming
 * the "comic" material (render_gpu/skia/materials.js → comic_shader.js); it does
 * NOT compose the effects bundle (a backdrop sampler cannot be wrapped in an
 * effectSubtree, whose offscreen re-render would sample an empty surface).
 *
 * The look is STATIC (no animation) — a pure reprint of the tone below, so it needs
 * no `animated` flag or particle clock. Every knob is a CUSTOM self.* property
 * (core/properties.js customProps — the Blender-style mechanism): each is an
 * equation-capable widget-state key (a literal, an expression, or a `= …` equation,
 * referenceable as self.<name>) with ZERO evaluation-engine changes — the material
 * framework carries the params straight to the SkSL uniforms. `mode` and `dotShape`
 * are `select` knobs stored as STRINGS; emit() maps them to the shader's numeric
 * codes (the metaballs TYPE_CODE pattern) and converts the angle knobs from the
 * user-facing DEGREES to the shader's radians.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte). DOM-free
 * / bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { COMIC_FILL_PARAMS, comicUniformParams } from "../../render_gpu/skia/comic_shader.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// select ids → the shader's numeric mode / dot-shape codes (comic_shader.js).
const MODE_OPTIONS = ["cmyk", "rgb", "duotone", "mono"];
const MODE_LABELS = { cmyk: "CMYK (4-colour)", rgb: "RGB (additive)", duotone: "Duotone (2 spot inks)", mono: "Mono (single black)" };
const MODE_CODE = { cmyk: 0, rgb: 1, duotone: 2, mono: 3 };
const SHAPE_OPTIONS = ["round", "square", "ellipse"];
const SHAPE_LABELS = { round: "Round", square: "Square", ellipse: "Ellipse" };
const SHAPE_CODE = { round: 0, square: 1, ellipse: 2 };

// degrees → radians for the four screen-angle knobs (user edits familiar degrees).
const DEG2RAD = Math.PI / 180;

// The comic look knobs, all self.* custom properties. Dimensionless knobs
// (fractions, counts, angles) are resolution-independent; `pitch`/`cornerRadius`/
// `blurRadius` are WORLD px (the backend scales to device — and `worldLocked`
// chooses whether the dots ride the artwork or stay a fixed screen grid).
// `worldLocked` DEFAULTS ON and every preset ships it on: the halftone is a print
// in CANVAS space, so zooming magnifies the dots with the content. (The shader
// phases the lattice in the widget's local frame in BOTH states, so neither can
// swim under a camera move — see render_gpu/skia/comic_shader.js.)
// THE LOOK KNOBS LIVE IN THE SHADER ENTRY now (comic_shader.COMIC_FILL_PARAMS
// — the fill-material framework's single-declaration rule: "custom properties
// become material properties"). This widget spreads that SAME schema into its
// customProps and adds only its widget-side geometry knob (cornerRadius).
const CUSTOM = customProps([
  ...COMIC_FILL_PARAMS,
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the print region (world px). 0 = sharp corners (a full comic panel)." },
]);

// The 5 canonical looks, surfaced by web/ToolsPane.svelte (props = a flat knob map).
const PRESETS = [
  {
    name: "Classic 4-Color Comic",
    description: "Warm cream paper, CMYK rosette, bold black line art — a Silver-Age comic panel.",
    props: { mode: "cmyk", pitch: 11, worldLocked: true, dotShape: "round", angleC: 15, angleM: 75, angleY: 0, angleK: 45, registration: 0.20, dotGain: 0.04, gamma: 1.1, posterize: 5, edgeInk: 0.85, edgeLo: 0.14, edgeHi: 0.34, grain: 0.08, paperColor: "#fbf3e0" },
  },
  {
    name: "Newsprint",
    description: "Coarse single-black screen with heavy dot gain and grimy paper grain — a printed newspaper photo.",
    props: { mode: "mono", pitch: 6, worldLocked: true, dotShape: "round", angleK: 45, registration: 0, dotGain: 0.10, gamma: 0.95, posterize: 0, edgeInk: 0, grain: 0.16, paperColor: "#e7e2d3" },
  },
  {
    name: "2-Color Riso",
    description: "Pink + blue spot inks split by luminance, overprinting to purple, on off-register paper — a riso/duotone zine.",
    props: { mode: "duotone", pitch: 8, worldLocked: true, dotShape: "round", angleC: 15, angleK: 45, registration: 0.38, dotGain: 0.06, gamma: 1.0, posterize: 4, edgeInk: 0, grain: 0.30, paperColor: "#f5f0e1", inkA: "#ff48b0", inkB: "#0078bf" },
  },
  {
    name: "Manga B/W",
    description: "Crisp fine black screen with strong ink outlines on clean white — screentone manga art.",
    props: { mode: "mono", pitch: 6, worldLocked: true, dotShape: "round", angleK: 45, registration: 0, dotGain: 0.02, gamma: 1.2, posterize: 4, edgeInk: 1.0, edgeLo: 0.10, edgeHi: 0.22, grain: 0, paperColor: "#ffffff" },
  },
  {
    name: "Desync RGB",
    description: "Additive R/G/B dot screens fanned onto three axes over near-black — a heavy chromatic-aberration / anaglyph split.",
    props: { mode: "rgb", pitch: 9, worldLocked: true, dotShape: "round", angleC: 15, angleM: 75, angleY: 0, angleK: 45, registration: 0.45, dotGain: 0, gamma: 1.0, posterize: 0, edgeInk: 0, grain: 0, paperColor: "#0a0a0f" },
  },
];

export const comicPlugin = {
  type: "demo_comic",
  title: "Comic Halftone",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    type: "demo_comic", x: 140, y: 140, w: 460, h: 360, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint dark hairline framing the panel (optional; strokeWidth 0 = none).
    stroke: "rgba(20,18,14,0.35)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // the comic.* look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  presets: PRESETS,
  /**
   * Pure function. State → display-list: ONE materialBackdrop op naming the "comic"
   * material. The bbox (w, h) IS the print region (local space; sceneIR wraps it in
   * the node's world). The `mode` / `dotShape` select strings map to the shader's
   * numeric codes and the angle knobs convert degrees → radians here; everything
   * else passes through and the SkSL packer clamps/parses it.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "comic",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      // The SAME schema→uniform mapping the fill-material path uses (one declaration).
      params: comicUniformParams(s),
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
