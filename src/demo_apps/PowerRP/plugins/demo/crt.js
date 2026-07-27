/**
 * CRT ("Cathode") — a DEMO WIDGET (plugins/demo/, the showcase folder) on the
 * reusable MATERIAL FRAMEWORK. A rounded-rect region rendered as a realistic
 * cathode-ray-tube screen over the content beneath it, with PHYSICALLY-MOTIVATED
 * knobs and presets keyed to real displays. See render_gpu/skia/crt_shader.js for
 * the full linear-light signal chain; this file is the plugin surface: the knob
 * set, the one `materialBackdrop` op, and the preset table.
 *
 * It is a BACKDROP material (capabilities.backdrop) and a bbox widget (standard
 * resize handles). It emits ONE `materialBackdrop` op naming the "crt" material
 * (render_gpu/skia/materials.js → crt_shader.js); it does NOT compose the effects
 * bundle (a backdrop sampler cannot be wrapped in an effectSubtree, whose
 * offscreen re-render would sample an empty surface).
 *
 * Every look knob is a CUSTOM self.* property (core/properties.js customProps —
 * the Blender-style mechanism): each is an equation-capable widget-state key with
 * ZERO evaluation-engine changes — the material framework carries the params
 * straight to the SkSL uniforms. Knobs are grouped into Inspector categories
 * (signal / scanlines / mask / glow / geometry / color / distress / render) that
 * render as their own accordions after the shared ones.
 *
 * TWO knobs are DOCUMENTED INERT (see the shader header): `persistence` (phosphor
 * decay — needs a previous-frame texture) and `flicker` (needs a time uniform).
 * A still-frame render has neither, so they are exposed for completeness but NOT
 * passed into `params` — they do nothing here, honestly, rather than being faked.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte). DOM-
 * free / bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialBackdrop } from "../../render_gpu/ir.js";

// Phosphor-mask menu → the numeric code the SkSL uMaskType branch expects. The
// plugin exposes readable names; emit() maps to the code so the packer stays
// numeric (a select whose value never reaches the uniform block as a string).
const MASK_TYPES = ["aperture", "shadow", "slot", "none"];
const MASK_LABELS = { aperture: "Aperture grille", shadow: "Shadow mask", slot: "Slot mask", none: "None" };
const MASK_CODE = { aperture: 0, shadow: 1, slot: 2, none: 3 };

// The CRT look knobs, all self.* custom properties, grouped by Inspector category.
// Dimensionless knobs (fractions, gains, counts) are resolution-independent — the
// look holds at any zoom/size. maskPitch/cornerRadius/blurRadius are WORLD px (the
// backend scales world→device by world.scale·zoom·dpr).
const CUSTOM = customProps([
  // ── SIGNAL — the input band-limit + display gamma ────────────────────────────
  { name: "sourceTVL", kind: "number", default: 240, min: 120, max: 1200, category: "signal", help: "Horizontal source resolution in TV Lines: the finite sharpness of the INPUT signal. ~240 = composite/VHS (soft), ~400 = consumer RGB, ~600 = Sony PVM, ~1000 = broadcast BVM (near-crisp). Applies a horizontal-only Gaussian band-limit of sigma = 0.512·pictureWidth/sourceTVL before scanlines/mask." },
  { name: "gammaIn", kind: "number", default: 2.4, min: 1, max: 3, category: "signal", help: "Decode gamma: the exponent that linearizes the sampled content before all CRT processing (a real CRT's display gamma is ~2.4). All stages run in linear light." },
  { name: "gammaOut", kind: "number", default: 2.2, min: 1, max: 3, category: "signal", help: "Encode gamma: the exponent the finished linear colour is re-encoded with on output (~2.2 for a standard surface)." },
  // ── SCANLINES — the raster beam ──────────────────────────────────────────────
  { name: "scanlineStrength", kind: "number", default: 0.5, min: 0, max: 1, category: "scanlines", help: "How dark the gaps between scanlines are, from 0 (no lines) to 1 (black gaps). The signature CRT raster texture." },
  { name: "scanlineCount", kind: "number", default: 240, min: 0, max: 2000, category: "scanlines", help: "Number of source scanlines across the screen height (raster line pitch). ~240 for a 240p tube (arcade/console), ~480 for a hi-res VGA/BVM." },
  { name: "brightBoost", kind: "number", default: 1.2, min: 0, max: 4, category: "scanlines", help: "Overall beam gain. A CRT runs its beam hot; this also compensates the dimming from the phosphor mask and scanlines." },
  { name: "beamBloom", kind: "number", default: 0.4, min: 0, max: 1, category: "scanlines", help: "How much a BRIGHT line's beam widens: 0 = every line the same tight width; 1 = bright lines bloom fat and nearly fill the gap (the classic highlight bloom). Eases the scanline Gaussian from tight (dark) to fat (bright)." },
  // ── MASK — the phosphor sub-pixel structure ──────────────────────────────────
  { name: "maskType", kind: "select", default: "aperture", options: MASK_TYPES, optionLabels: MASK_LABELS, category: "mask", help: "Phosphor mask geometry: Aperture grille (Trinitron vertical RGB stripes), Shadow mask (offset RGB dots), Slot mask (staggered vertical segments), or None (a single-gun monochrome tube — no colour triads)." },
  { name: "maskStrength", kind: "number", default: 0.35, min: 0, max: 1, category: "mask", help: "Strength of the phosphor RGB mask, from 0 (off) to 1 (full colour separation). The visible coloured sub-pixel structure of the tube." },
  { name: "maskPitch", kind: "number", default: 3, min: 1, max: 20, category: "mask", help: "Phosphor triad width (dot pitch) in world px. Smaller = finer phosphor (a sharp pro monitor); larger = chunky consumer phosphor. The mask lives in screen space, so it does NOT curve with the tube." },
  // ── GLOW — halation + diffusion (single blurred kernel; see shader header) ────
  { name: "halation", kind: "number", default: 0.12, min: 0, max: 1, category: "glow", help: "Warm under-glass halation: a diffuse orange-red ring bright areas bleed into (the phosphor colour on a monochrome terminal). Scaled by the blurred content's luminance." },
  { name: "diffusion", kind: "number", default: 0.15, min: 0, max: 1, category: "glow", help: "Neutral diffusion glow: a soft content-coloured bloom from the frosted glass. Shares the single blurred kernel with halation (blurRadius sets its softness)." },
  { name: "blurRadius", kind: "number", default: 6, min: 0, max: 40, category: "glow", help: "Gaussian blur radius (world px) of the glow source shared by halation + diffusion — how soft/wide the bloom is." },
  // ── GEOMETRY — tube shape ────────────────────────────────────────────────────
  { name: "curvature", kind: "number", default: 0.06, min: 0, max: 0.5, category: "geometry", help: "Tube/barrel curvature: 0 = a flat panel, higher = a fatter CRT bulge. The image compresses at the center and stretches to the edges." },
  { name: "convergence", kind: "number", default: 0.02, min: 0, max: 0.2, category: "geometry", help: "Beam-convergence error: how far the red/blue channels split radially, growing with r² toward the edge (as a fraction of the half-size). Tiny is realistic; pro monitors are near-perfectly converged." },
  { name: "vignette", kind: "number", default: 0.3, min: 0, max: 1, category: "geometry", help: "Corner darkening, from 0 (even) to 1 (heavy). The falloff of light toward the edges of the curved tube." },
  { name: "bezel", kind: "number", default: 0.05, min: 0, max: 0.5, category: "geometry", help: "Width of the black inner tube border around the lit screen, as a fraction of the half-size. The dark frame between the glass edge and the picture." },
  { name: "cornerRadius", kind: "number", default: 44, min: 0, category: "geometry", help: "Rounded-corner radius of the tube face (world px). Old CRTs have generously rounded corners." },
  // ── COLOR — phosphor tint + white point ──────────────────────────────────────
  { name: "monochrome", kind: "number", default: 0, min: 0, max: 1, category: "color", help: "Collapse the picture to a single phosphor colour: 0 = full colour tube, 1 = a monochrome phosphor terminal / B&W tube (luminance × the phosphor tint below)." },
  { name: "whiteBalance", kind: "number", default: 0, min: -1, max: 1, category: "color", help: "White point: -1 warm (~5000K amber), 0 neutral D65, +1 cold (NTSC-J ~9300K bluish). A scalar (not a colour) so the blue channel can exceed 1.0 on the cold end." },
  { name: "phosphorTint", kind: "color", default: "#ffffff", category: "color", help: "The monochrome phosphor colour, used only as Monochrome → 1: P39 green (#00ff2b), P3 amber (#ff8c00), a bluish-white B&W tube, etc." },
  // ── DISTRESS — temporal knobs (DOCUMENTED INERT in a still render) ────────────
  { name: "flicker", kind: "number", default: 0, min: 0, max: 1, category: "distress", help: "INERT in this build: refresh-flicker needs a time uniform, which a still-frame render does not thread to materials. Exposed for presets/completeness; does nothing until a time source is wired in (not faked)." },
  { name: "persistence", kind: "number", default: 0, min: 0, max: 1, category: "distress", help: "INERT in this build: phosphor persistence (motion trails) needs a previous-frame texture, which this pipeline has no equivalent of. Exposed for presets/completeness; does nothing until a frame-history source is wired in (not faked)." },
  // ── RENDER — sample resolution ───────────────────────────────────────────────
  { name: "backdropScale", kind: "number", default: 1, min: 0.25, max: 2, category: "render", help: "RESOLUTION FACTOR the content beneath is re-rendered at for the distortion: 1 = screen resolution, 2 = supersample (crisper, slower), 0.5 = half res (faster, softer)." },
]);

/**
 * The PRESETS: `{name, description, props}` — each `props` is a flat map of the
 * self.* look knobs above, applied to the current frame in one undo unit by the
 * Presets pane (web/ToolsPane.svelte → app.applyPreset). Each is keyed to a
 * REAL display, with numbers following the physics: sourceTVL rises with the
 * display's true horizontal resolution (composite ~240 … BVM ~1000), consumer
 * tubes use shadow/slot masks with heavier curvature + halation, pro RGB monitors
 * use a fine aperture grille, flatter glass, tighter convergence, and phosphor
 * terminals go monochrome with maskType "none".
 */
const PRESETS = [
  {
    name: "Composite Consumer TV",
    description: "A late-80s living-room set fed composite/RF: soft (~240 TVL), fat bulge, shadow-mask phosphor, warm-ish white, heavy halation and vignette.",
    props: {
      sourceTVL: 240, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.35, scanlineCount: 240, brightBoost: 1.35, beamBloom: 0.5,
      maskType: "shadow", maskStrength: 0.3, maskPitch: 4,
      halation: 0.18, diffusion: 0.18, blurRadius: 8,
      curvature: 0.12, convergence: 0.03, vignette: 0.42, bezel: 0.06, cornerRadius: 54,
      monochrome: 0, whiteBalance: -0.1, phosphorTint: "#ffffff",
      flicker: 0, persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Sony PVM (RGB)",
    description: "A prosumer Trinitron RGB monitor: sharp (~600 TVL), fine aperture grille, crisp visible scanlines, flat glass, near-perfect convergence, neutral-cool white.",
    props: {
      sourceTVL: 600, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.55, scanlineCount: 240, brightBoost: 1.25, beamBloom: 0.35,
      maskType: "aperture", maskStrength: 0.4, maskPitch: 3,
      halation: 0.08, diffusion: 0.08, blurRadius: 5,
      curvature: 0.04, convergence: 0.01, vignette: 0.25, bezel: 0.04, cornerRadius: 34,
      monochrome: 0, whiteBalance: 0.1, phosphorTint: "#ffffff",
      flicker: 0, persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Sony BVM",
    description: "The broadcast reference Trinitron: the sharpest tube (~1000 TVL), very fine aperture grille, minimal curvature, immaculate convergence, D65 white.",
    props: {
      sourceTVL: 1000, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.5, scanlineCount: 480, brightBoost: 1.2, beamBloom: 0.3,
      maskType: "aperture", maskStrength: 0.35, maskPitch: 2.5,
      halation: 0.06, diffusion: 0.06, blurRadius: 4,
      curvature: 0.02, convergence: 0.005, vignette: 0.2, bezel: 0.03, cornerRadius: 26,
      monochrome: 0, whiteBalance: 0.15, phosphorTint: "#ffffff",
      flicker: 0, persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Arcade 240p",
    description: "A JAMMA arcade tube: 240p, punchy and hot, slot-mask phosphor, strong bloomed scanlines, moderate curvature.",
    props: {
      sourceTVL: 300, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.5, scanlineCount: 240, brightBoost: 1.4, beamBloom: 0.55,
      maskType: "slot", maskStrength: 0.35, maskPitch: 4,
      halation: 0.14, diffusion: 0.12, blurRadius: 6,
      curvature: 0.08, convergence: 0.02, vignette: 0.35, bezel: 0.05, cornerRadius: 40,
      monochrome: 0, whiteBalance: -0.05, phosphorTint: "#ffffff",
      flicker: 0, persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "IBM VGA",
    description: "A 90s PC CRT at 640×480: shadow-mask dot pitch, ~560 TVL, near-flat glass, scanlines almost filled in, neutral-cool white.",
    props: {
      sourceTVL: 560, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.2, scanlineCount: 480, brightBoost: 1.2, beamBloom: 0.3,
      maskType: "shadow", maskStrength: 0.35, maskPitch: 3,
      halation: 0.06, diffusion: 0.08, blurRadius: 5,
      curvature: 0.05, convergence: 0.015, vignette: 0.28, bezel: 0.05, cornerRadius: 30,
      monochrome: 0, whiteBalance: 0.1, phosphorTint: "#ffffff",
      flicker: 0, persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Green Terminal (P39)",
    description: "A monochrome P39 green-phosphor computer terminal: no colour mask, visible bloomed scanlines, green halation, gentle bulge.",
    props: {
      sourceTVL: 400, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.4, scanlineCount: 300, brightBoost: 1.3, beamBloom: 0.6,
      maskType: "none", maskStrength: 0, maskPitch: 3,
      halation: 0.18, diffusion: 0.16, blurRadius: 7,
      curvature: 0.06, convergence: 0, vignette: 0.35, bezel: 0.05, cornerRadius: 40,
      monochrome: 1, whiteBalance: 0, phosphorTint: "#00ff2b",
      flicker: 0, persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "Amber Terminal (P3)",
    description: "A monochrome P3 amber-phosphor terminal: the warm-orange counterpart to the green terminal — no colour mask, bloomed scanlines, amber halation.",
    props: {
      sourceTVL: 400, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.4, scanlineCount: 300, brightBoost: 1.3, beamBloom: 0.6,
      maskType: "none", maskStrength: 0, maskPitch: 3,
      halation: 0.18, diffusion: 0.16, blurRadius: 7,
      curvature: 0.06, convergence: 0, vignette: 0.35, bezel: 0.05, cornerRadius: 40,
      monochrome: 1, whiteBalance: 0, phosphorTint: "#ff8c00",
      flicker: 0, persistence: 0, backdropScale: 1,
    },
  },
  {
    name: "B&W TV",
    description: "A single-gun black-and-white television: composite-soft (~240 TVL), no phosphor triads, bluish-white P4 tone, fat bulge, heavy halation and vignette.",
    props: {
      sourceTVL: 240, gammaIn: 2.4, gammaOut: 2.2,
      scanlineStrength: 0.4, scanlineCount: 240, brightBoost: 1.35, beamBloom: 0.55,
      maskType: "none", maskStrength: 0, maskPitch: 3,
      halation: 0.16, diffusion: 0.15, blurRadius: 8,
      curvature: 0.12, convergence: 0, vignette: 0.42, bezel: 0.06, cornerRadius: 54,
      monochrome: 1, whiteBalance: 0, phosphorTint: "#dce6ff",
      flicker: 0, persistence: 0, backdropScale: 1,
    },
  },
];

export const crtPlugin = {
  type: "demo_crt",
  title: "CRT",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  presets: PRESETS,
  defaults: {
    // 4:3, the classic CRT aspect.
    type: "demo_crt", x: 140, y: 140, w: 440, h: 330, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // A faint bright hairline around the tube face (optional; strokeWidth 0 = none).
    stroke: "rgba(255,255,255,0.20)", strokeWidth: 1,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // the crt.* look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the grouped look knobs (signal/scanlines/mask/glow/geometry/color/distress/render)
  ],
  /**
   * Pure function. State → display-list: ONE materialBackdrop op naming the "crt"
   * material. The bbox (w, h) IS the screen region (local space; sceneIR wraps it
   * in the node's world). The look knobs pass through as the op's `params`; the
   * maskType SELECT is mapped to its numeric shader code here so the packer stays
   * numeric. The temporal knobs (flicker, persistence) are DELIBERATELY OMITTED
   * from params — documented inert (no time / frame-history source in a still
   * render). cornerRadius / blurRadius / backdropScale are top-level op fields
   * (consumed by handleMaterialBackdrop for geometry, glow sigma, sample res),
   * not shader uniforms.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    const maskType = MASK_CODE[s.maskType];
    if (maskType === undefined)
      throw new Error(`crt.emit: unknown maskType ${JSON.stringify(s.maskType)} (expected one of ${MASK_TYPES.join(", ")})`);
    return [materialBackdrop({
      material: "crt",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: s.cornerRadius,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      params: {
        sourceTVL: s.sourceTVL,
        gammaIn: s.gammaIn,
        gammaOut: s.gammaOut,
        scanlineStrength: s.scanlineStrength,
        scanlineCount: s.scanlineCount,
        brightBoost: s.brightBoost,
        beamBloom: s.beamBloom,
        maskType,
        maskStrength: s.maskStrength,
        maskPitch: s.maskPitch,
        halation: s.halation,
        diffusion: s.diffusion,
        curvature: s.curvature,
        convergence: s.convergence,
        vignette: s.vignette,
        bezel: s.bezel,
        monochrome: s.monochrome,
        whiteBalance: s.whiteBalance,
        phosphorTint: s.phosphorTint,
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
