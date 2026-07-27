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
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte). DOM-free
 * / bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
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
const CUSTOM = customProps([
  { name: "mode", kind: "select", options: MODE_OPTIONS, optionLabels: MODE_LABELS, default: "cmyk", help: "Which ink separation to print. CMYK = the classic 4-colour comic; RGB = additive light dots over a dark paper (the desync look); Duotone = two spot inks (riso); Mono = a single black screen (newsprint / manga)." },
  { name: "pitch", kind: "number", default: 11, min: 1, help: "Halftone CELL size in world px — the dot pitch (lower = finer, higher LPI). With World-locked on, this is the dot size ON the artwork." },
  { name: "worldLocked", kind: "boolean", default: true, help: "On (the printed look): the dots live in CANVAS space — printed ON the artwork, so zooming in magnifies them along with the content. Off: the dots hold a fixed SIZE on screen while the artwork scales under them. Either way the lattice is anchored to this panel and never swims when you pan or zoom." },
  { name: "dotShape", kind: "select", options: SHAPE_OPTIONS, optionLabels: SHAPE_LABELS, default: "round", help: "Dot silhouette. Round is the classic Ben-Day dot; Square gives a coarse pixelly screen; Ellipse is the elongated chain-dot." },
  { name: "angleC", kind: "angle", default: 15, help: "Screen angle (degrees) for Cyan — also REUSED as Red (RGB mode) and the highlight ink (Duotone). Classic C = 15°." },
  { name: "angleM", kind: "angle", default: 75, help: "Screen angle (degrees) for Magenta — also REUSED as Blue (RGB mode). Classic M = 75°." },
  { name: "angleY", kind: "angle", default: 0, help: "Screen angle (degrees) for Yellow. Classic Y = 0°." },
  { name: "angleK", kind: "angle", default: 45, help: "Screen angle (degrees) for blacK — also REUSED as Green (RGB), the shadow ink (Duotone), and the single Mono screen. Classic K = 45°." },
  { name: "registration", kind: "number", default: 0.15, min: 0, max: 1, help: "Mis-registration / desync: how far each channel's dot grid is shifted (fraction of a cell). 0 = perfect print registration; high = the deliberate off-register / anaglyph split." },
  { name: "dotGain", kind: "number", default: 0.03, min: 0, max: 0.5, help: "Dot gain — extra dot radius (fraction of a cell) simulating ink spreading on absorbent paper. Fattens every dot slightly (darker print)." },
  { name: "gamma", kind: "number", default: 1.0, min: 0.1, help: "Tone gamma applied to coverage before the dot. >1 lightens the mid-tones (smaller mid dots); <1 darkens them." },
  { name: "posterize", kind: "number", default: 0, min: 0, help: "Flatten the tone into this many levels before separation (flat comic fills). 0 or 1 = off (smooth tone); e.g. 4–6 = crisp poster bands." },
  { name: "edgeInk", kind: "number", default: 0, min: 0, max: 1, help: "Black outline ink strength: inks the strong tone edges (a Sobel gradient) black, like a comic's line art. 0 = no outlines." },
  { name: "edgeLo", kind: "number", default: 0.15, min: 0, help: "Edge threshold LOW: gradient magnitude where the outline ink starts to appear." },
  { name: "edgeHi", kind: "number", default: 0.35, min: 0, help: "Edge threshold HIGH: gradient magnitude where the outline ink is fully black." },
  { name: "grain", kind: "number", default: 0.06, min: 0, max: 1, help: "Paper grain: a subtle static speckle over the print (aged newsprint tooth). 0 = clean paper." },
  { name: "paperColor", kind: "color", default: "#fbf3e0", help: "Paper base colour — what shows through between the dots (a warm cream reads as aged newsprint; a dark colour suits the additive-RGB mode)." },
  { name: "inkA", kind: "color", default: "#ff48b0", help: "Duotone SHADOW ink (the darker-tone spot colour). Only used in Duotone mode." },
  { name: "inkB", kind: "color", default: "#0078bf", help: "Duotone HIGHLIGHT ink (the lighter-tone spot colour). Only used in Duotone mode." },
  // ── geometry / render controls (world units + the sample resolution) ─────────
  { name: "cornerRadius", kind: "number", default: 0, min: 0, help: "Rounded-corner radius of the print region (world px). 0 = sharp corners (a full comic panel)." },
  { name: "blurRadius", kind: "number", default: 2, min: 0, help: "Gaussian blur radius (world px) of the (unused) blurred child — kept minimal; a print reads the sharp tone." },
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, max: 2, help: "RESOLUTION FACTOR the content beneath is re-rendered at for the screening: 1 = screen resolution, 2 = supersample (crisper cell-centre tone, slower)." },
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
      params: {
        mode: MODE_CODE[s.mode] ?? 0,
        pitch: s.pitch,
        worldLocked: s.worldLocked ? 1 : 0,
        dotShape: SHAPE_CODE[s.dotShape] ?? 0,
        angleC: s.angleC * DEG2RAD,
        angleM: s.angleM * DEG2RAD,
        angleY: s.angleY * DEG2RAD,
        angleK: s.angleK * DEG2RAD,
        reg: s.registration,
        dotGain: s.dotGain,
        gamma: s.gamma,
        posterize: s.posterize,
        edgeInk: s.edgeInk,
        edgeLo: s.edgeLo,
        edgeHi: s.edgeHi,
        grain: s.grain,
        paper: s.paperColor,
        inkA: s.inkA,
        inkB: s.inkB,
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
  // NO top-level `commands`: reached ONLY via the "Insert Demo Widget" submenu.
};
