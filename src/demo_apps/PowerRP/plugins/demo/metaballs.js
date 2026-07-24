/**
 * Metaballs — a DEMO WIDGET (plugins/demo/, the showcase folder) on the reusable
 * MATERIAL FRAMEWORK. Blender-style metaballs (metaSphere / metaTube /
 * metaSquare) that MERGE into smooth blobs via a polynomial smooth-union, lit and
 * refracted so they read as WATER DROPLETS on the content beneath — a backdrop
 * material (render_gpu/skia/metaballs_shader.js) that refracts the composite-so-
 * far, exactly like Liquid Glass and CRT.
 *
 * Like glass/CRT it is a BACKDROP SAMPLER (capabilities.backdrop) and a bbox
 * widget (standard resize handles). It emits ONE `materialBackdrop` op naming the
 * "metaballs" material; it does NOT compose the effects bundle (a backdrop
 * sampler cannot be wrapped in an effectSubtree, whose offscreen re-render would
 * sample an empty surface). The widget box is the FIELD's coordinate frame: each
 * ball's center is a 0..1 fraction of the box, radii/lengths a fraction of the
 * short half-size — so the droplet layout is resolution- and size-independent.
 *
 * Every knob is a CUSTOM self.* property (core/properties.js customProps — the
 * Blender-style mechanism): each numeric knob is equation-capable (edit as a
 * literal, expression, or `= …` equation, referenceable elsewhere as self.<name>)
 * with ZERO evaluation-engine changes — the material framework carries the params
 * straight to the SkSL uniforms. Deterministic: no time / no random.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte),
 * keeping the core Add menus clean. DOM-free / bare-node-safe at import time.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { materialBackdrop, parseColor } from "../../render_gpu/ir.js";

// The demo's roster size. MUST be <= the shader's MAX_METABALLS (currently 6, in
// render_gpu/skia/metaballs_shader.js — the packer zero-pads/gates the rest). The
// active count is the `count` knob; extra roster balls sit dormant beyond it.
const ROSTER = 6;
const LIGHT_ANGLE_DEFAULT = -Math.PI * 0.68; // direction TO the light: upper, slightly left — the water sheen

// The three primitive kinds, mapped to the shader's numeric type code.
const TYPE_OPTIONS = ["sphere", "tube", "box"];
const TYPE_LABELS = { sphere: "Sphere", tube: "Tube", box: "Box" };
const TYPE_CODE = { sphere: 0, tube: 1, box: 2 };

/**
 * Pure function. The six self.* custom-prop defs for one roster ball `n`
 * (0-based), pre-filled from a preset. Center is a 0..1 fraction of the box;
 * radius/length are fractions of the short half-size; angle is radians (tube/box
 * orientation, ignored by spheres).
 *
 * @param {number} n - roster index (0-based)
 * @param {{type:string,x:number,y:number,r:number,len:number,ang:number}} preset
 * @returns {object[]} six customProps defs (a select + five numbers)
 *
 * @example ballDefs(0, {type:"sphere",x:0.4,y:0.44,r:0.32,len:0,ang:0}).length // 6
 */
function ballDefs(n, preset) {
  const P = n + 1; // 1-based label
  return [
    { name: `b${n}Type`, kind: "select", options: TYPE_OPTIONS, optionLabels: TYPE_LABELS, default: preset.type, label: `Ball ${P} · type`, help: "Primitive kind: Sphere (a round droplet), Tube (a capsule — merges two beads into a neck), or Box (a rounded-square droplet)." },
    { name: `b${n}X`, kind: "number", default: preset.x, min: 0, max: 1, label: `Ball ${P} · X`, help: "Center X as a fraction of the widget width (0 = left edge, 1 = right edge)." },
    { name: `b${n}Y`, kind: "number", default: preset.y, min: 0, max: 1, label: `Ball ${P} · Y`, help: "Center Y as a fraction of the widget height (0 = top, 1 = bottom)." },
    { name: `b${n}R`, kind: "number", default: preset.r, min: 0, label: `Ball ${P} · radius`, help: "Base radius as a fraction of the widget's short half-size. Overlapping radii are what MERGE beads together." },
    { name: `b${n}Len`, kind: "number", default: preset.len, min: 0, label: `Ball ${P} · length`, help: "Tube capsule half-length / box extra half-width (fraction of the short half-size). A sphere ignores this." },
    { name: `b${n}Ang`, kind: "number", default: preset.ang, label: `Ball ${P} · angle`, help: "Orientation in radians for a tube or box. A sphere ignores this." },
  ];
}

// The default preset: six beads reading as DISTINCT water droplets that MERGE
// locally where they touch (coalescing pairs + soft necks) rather than one
// amorphous puddle — a coalescing sphere pair (0+1), two standalone rounder
// drops (2, 3), a horizontal tube drop (4), and a rounded-square drop (5).
const PRESET = [
  { type: "sphere", x: 0.28, y: 0.40, r: 0.22, len: 0.00, ang: 0.00 },
  { type: "sphere", x: 0.40, y: 0.50, r: 0.15, len: 0.00, ang: 0.00 },
  { type: "sphere", x: 0.60, y: 0.35, r: 0.19, len: 0.00, ang: 0.00 },
  { type: "sphere", x: 0.71, y: 0.58, r: 0.15, len: 0.00, ang: 0.00 },
  { type: "tube", x: 0.48, y: 0.70, r: 0.10, len: 0.15, ang: 0.10 },
  { type: "box", x: 0.85, y: 0.40, r: 0.12, len: 0.03, ang: 0.20 },
];

const CUSTOM = customProps([
  // ── the field (merge + surface) ──────────────────────────────────────────────
  { name: "count", kind: "number", default: 6, min: 0, max: ROSTER, label: "Ball count", help: `How many roster balls are active (0..${ROSTER}). The rest sit dormant.` },
  { name: "smoothK", kind: "number", default: 0.18, min: 0, label: "Merge (smooth-k)", help: "Smooth-union merge amount (fraction of the short half-size). 0 = a hard union of separate shapes; larger fuses neighbours into one bulging blob with a smooth neck — THE metaball merge." },
  { name: "threshold", kind: "number", default: 0.05, min: 0, label: "Threshold", help: "Isosurface level (fraction of the short half-size): raises the fluid 'level' so every blob fattens and gaps close. Higher = plumper, more-merged droplets." },
  { name: "bulge", kind: "number", default: 0.80, min: 0.05, label: "Bulge", help: "Dome thickness (fraction of the short half-size): small = tall, sharply-curved beads (strong refraction); large = flatter puddles." },
  // ── the water look (reuses the glass refraction + lighting math) ─────────────
  { name: "refraction", kind: "number", default: 0.27, min: 0, label: "Refraction", help: "Maximum lens displacement (fraction of the short half-size) of the refracted background — how hard each droplet magnifies/bends the content beneath it." },
  { name: "chromatic", kind: "number", default: 0.05, min: 0, label: "Chromatic", help: "Chromatic dispersion at the rim: the R/B channels refract slightly more/less than G. A tiny value gives a real colored-edge fringe; too much makes a rainbow swirl at each bead's core." },
  { name: "tint", kind: "color", default: "rgba(210,238,255,0.06)", paint: true, help: "Water tint: a color CAST (rgb) at low STRENGTH (alpha) multiplied into the refracted body. Keep the alpha low — clear water is nearly colorless." },
  { name: "lightAngle", kind: "number", default: LIGHT_ANGLE_DEFAULT, label: "Light angle", help: "Direction TO the light in radians (screen space; -π/2 is straight above). The upper face of each bead catches the specular glint." },
  { name: "specular", kind: "number", default: 1.75, min: 0, label: "Specular", help: "Strength of the Blinn-Phong glint — the bright sparkle a real water droplet throws back at the light. The key water cue." },
  { name: "shininess", kind: "number", default: 66, min: 1, label: "Shininess", help: "Specular exponent: higher = a tighter, sharper pinpoint glint; lower = a broad soft sheen." },
  { name: "fresnel", kind: "number", default: 0.95, min: 0, label: "Fresnel rim", help: "Brightness of the grazing rim, where a droplet catches a ring of the bright surroundings (environment reflection). Gives the bead its lit edge." },
  { name: "ambient", kind: "number", default: 0.28, min: 0, max: 1, label: "Contact shade", help: "Soft darkening on the unlit rim (0 = flat, higher = a rounder, seated bead). The shadow side that makes it read as 3D." },
  // ── render controls (world units + sample resolution) ────────────────────────
  { name: "blurRadius", kind: "number", default: 7, min: 0, label: "Environment blur", help: "Gaussian blur radius (world px) of the surroundings used for the fresnel rim glow. Softer = a smoother environment reflection." },
  { name: "backdropScale", kind: "number", default: 1.5, min: 0.25, max: 2, label: "Backdrop scale", help: "RESOLUTION FACTOR the content beneath is re-rendered at for the refraction: 1 = screen res, 2 = supersample (crisper droplets, slower), 0.5 = half res (faster, softer)." },
  // ── the roster (six balls; `count` selects how many are active) ──────────────
  ...PRESET.flatMap((preset, n) => ballDefs(n, preset)),
]);

export const metaballsPlugin = {
  type: "metaball",
  title: "Metaball",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true },
  defaults: {
    type: "metaball", x: 130, y: 130, w: 720, h: 440, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // No container border by default — the droplets ARE the shape. strokeWidth 0.
    stroke: "rgba(255,255,255,0.20)", strokeWidth: 0,
    ...defaults("opacity"), // opacity:1
    ...CUSTOM.defaults,     // the metaballs.* look knobs (self.*)
  },
  inspector: [
    ...bundle("positioning"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  /**
   * Pure function. State → display-list: ONE materialBackdrop op naming the
   * "metaballs" material. The bbox (w, h) IS the field region (local space;
   * sceneIR wraps it in the node's world). The roster is flattened into the
   * `balls` param [type, cx, cy, r, len, ang, …] (type mapped to its numeric
   * code); the look knobs pass through as params and the SkSL packer clamps them.
   */
  emit(s) {
    const strokeW = s.strokeWidth ?? 0;
    const balls = [];
    for (let n = 0; n < ROSTER; n++) {
      balls.push(
        TYPE_CODE[s[`b${n}Type`]] ?? 0,
        s[`b${n}X`], s[`b${n}Y`], s[`b${n}R`], s[`b${n}Len`], s[`b${n}Ang`],
      );
    }
    return [materialBackdrop({
      material: "metaballs",
      cx: s.w / 2, cy: s.h / 2, halfW: s.w / 2, halfH: s.h / 2,
      cornerRadius: 0,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      params: {
        balls,
        ballCount: s.count,
        smoothK: s.smoothK,
        threshold: s.threshold,
        refraction: s.refraction,
        chromatic: s.chromatic,
        tint: parseColor(s.tint),
        lightAngle: s.lightAngle,
        specular: s.specular,
        shininess: s.shininess,
        fresnel: s.fresnel,
        bulge: s.bulge,
        ambient: s.ambient,
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
