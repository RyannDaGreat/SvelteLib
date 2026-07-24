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

import * as T from "../../core/transform.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { reportOnce } from "../../core/report.js";
import { materialBackdrop, parseColor } from "../../render_gpu/ir.js";
import { MAX_METABALLS } from "../../render_gpu/skia/metaballs_shader.js";

// One widget's INTERNAL roster size (dormant balls a single widget can hold beyond
// its active `count`). Slide-wide fusion means the total across ALL metaball widgets
// is bounded instead by the shader's MAX_METABALLS; the leader clamps + reports if a
// slide's fused ball total ever exceeds it (never a silent drop).
const ROSTER = 6;
const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const LIGHT_ANGLE_DEFAULT = -Math.PI * 0.68; // direction TO the light: upper, slightly left — the water sheen
// The fused region is the balls' bounding box GROWN by this fraction of the largest
// ball's reach — a margin that comfortably holds the isosurface past the raw ball
// radii (threshold-fattening + smooth-union neck bulge + the coverage AA band) for
// default-range knobs, so the merged surface (incl. the connecting neck between two
// widgets) is never clipped at the region edge.
const REGION_PAD_FRAC = 0.6;

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

// The default roster. A metaball widget DEFAULTS to ONE ball (ball 0 — a single
// centred droplet sized to nearly fill the box's short dimension), the atom you
// then MERGE with other metaball widgets by placing them close (slide-wide fusion).
// Balls 1..5 sit dormant beyond the default `count` of 1 — a single widget can still
// raise `count` to host its own internal cluster (all such balls join the fusion).
const PRESET = [
  { type: "sphere", x: 0.50, y: 0.50, r: 0.85, len: 0.00, ang: 0.00 },
  { type: "sphere", x: 0.30, y: 0.42, r: 0.30, len: 0.00, ang: 0.00 },
  { type: "sphere", x: 0.62, y: 0.36, r: 0.26, len: 0.00, ang: 0.00 },
  { type: "sphere", x: 0.72, y: 0.60, r: 0.22, len: 0.00, ang: 0.00 },
  { type: "tube", x: 0.46, y: 0.70, r: 0.14, len: 0.18, ang: 0.10 },
  { type: "box", x: 0.84, y: 0.44, r: 0.16, len: 0.04, ang: 0.20 },
];

const CUSTOM = customProps([
  // ── the field (merge + surface) ──────────────────────────────────────────────
  { name: "count", kind: "number", default: 1, min: 0, max: ROSTER, label: "Ball count", help: `How many of THIS widget's roster balls are active (0..${ROSTER}); default 1 — a single droplet. Every active ball, across every metaball widget on the slide, fuses into one surface. The rest sit dormant.` },
  { name: "smoothK", kind: "number", default: 0.90, min: 0, label: "Merge (smooth-k)", help: "Smooth-union merge amount (fraction of the MEAN BALL RADIUS). 0 = a hard union of separate shapes; larger fuses neighbours (including balls from other metaball widgets) into one bulging blob with a smooth neck — THE metaball merge." },
  { name: "threshold", kind: "number", default: 0.08, min: 0, label: "Threshold", help: "Isosurface level (fraction of the mean ball radius): raises the fluid 'level' so every blob fattens and gaps close. Higher = plumper, more-merged droplets." },
  { name: "bulge", kind: "number", default: 0.80, min: 0.05, label: "Bulge", help: "Dome thickness (fraction of the mean ball radius): small = tall, sharply-curved beads (strong refraction); large = flatter puddles." },
  // ── the water look (reuses the glass refraction + lighting math) ─────────────
  { name: "refraction", kind: "number", default: 0.27, min: 0, label: "Refraction", help: "Maximum lens displacement (fraction of the mean ball radius) of the refracted background — how hard each droplet magnifies/bends the content beneath it." },
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

/**
 * Pure function. This widget's ACTIVE balls in LOCAL widget units — the metaball
 * archetype's SOURCE hook, called by core/derive.collectMetaballScene (never
 * imported by another plugin). Each ball's centre is in local px ([0..w]×[0..h]),
 * its radius/length in local px (the stored 0..1 / short-half-size fractions
 * resolved against THIS box), and its angle in radians. Only the first `count`
 * (clamped 0..ROSTER) roster balls are active.
 *
 * @param {object} s - folded item state (w, h, count, b{n}Type/X/Y/R/Len/Ang)
 * @returns {{type:string,cx:number,cy:number,r:number,len:number,ang:number}[]}
 *
 * @example localBalls({w: 200, h: 200, count: 0, b0Type: "sphere", b0X: 0.5, b0Y: 0.5, b0R: 0.5, b0Len: 0, b0Ang: 0}) // [] (count 0: no active balls)
 * @example localBalls({w: 200, h: 200, count: 1, b0Type: "sphere", b0X: 0.5, b0Y: 0.5, b0R: 0.5, b0Len: 0, b0Ang: 0}) // [{type: "sphere", cx: 100, cy: 100, r: 50, len: 0, ang: 0}]
 * @example localBalls({w: 400, h: 200, count: 1, b0Type: "tube", b0X: 0.5, b0Y: 0.5, b0R: 0.2, b0Len: 0.5, b0Ang: 0}) // [{type: "tube", cx: 200, cy: 100, r: 20, len: 50, ang: 0}] (r/len scale by the SHORT half-size 100)
 */
export function localBalls(s) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const minHalf = Math.min(w, h) / 2;
  const count = Math.max(0, Math.min(ROSTER, Math.round(s.count ?? 0)));
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      type: s[`b${i}Type`] ?? "sphere",
      cx: (s[`b${i}X`] ?? 0.5) * w,
      cy: (s[`b${i}Y`] ?? 0.5) * h,
      r: (s[`b${i}R`] ?? 0) * minHalf,
      len: (s[`b${i}Len`] ?? 0) * minHalf,
      ang: s[`b${i}Ang`] ?? 0,
    });
  }
  return out;
}

/**
 * Pure function. THE FUSED-REGION SOLVER — maps every metaball ball (in WORLD
 * coords) into the leader's LOCAL frame, then builds the shader's normalized inputs
 * for ONE backdrop covering their UNION (so the connecting neck between two widgets
 * lands INSIDE the region, never clipped at a widget's box edge).
 *
 * A world ball is `{type, x, y, r, len, ang}` (centre + radius/half-length in world
 * px, angle radians). Each is inverted through `world` into leader-local space; a
 * similarity divides lengths by world.scale and subtracts world.rotation. The region
 * is the balls' local bounding box GROWN by `pad`·(largest ball reach). Ball geometry
 * is emitted as the SHADER's fractions — centre as 0..1 of the region box, r/len as a
 * fraction of the region's short half-size — so the region's SIZE cancels in the
 * shader's `frac·minHalf` decode (a ball keeps its world radius no matter how large
 * the union region is). `unit` (mean ball radius ÷ region short half-size) is the
 * ball-intrinsic scale the DISTANCE knobs ride, so a big region does not over-merge.
 *
 * Returns null when there are no balls of positive extent (nothing to draw).
 *
 * @param {object[]} worldBalls - balls in world coords
 * @param {object} world - the leader node's local→world similarity
 * @param {number} pad - region growth as a fraction of the largest ball reach
 * @returns {{cx,cy,halfW,halfH,balls:number[],count:number,unit:number}|null}
 *
 * @example metaballRegion([{type: "sphere", x: 0, y: 0, r: 100, len: 0, ang: 0}], {x: 0, y: 0, rotation: 0, scale: 1}, 0) // {cx: 0, cy: 0, halfW: 100, halfH: 100, balls: [0, 0.5, 0.5, 1, 0, 0], count: 1, unit: 1}
 * @example metaballRegion([], {x: 0, y: 0, rotation: 0, scale: 1}, 0.6) // null (no balls)
 * @example metaballRegion([{type: "sphere", x: 0, y: 0, r: 0, len: 0, ang: 0}], {x: 0, y: 0, rotation: 0, scale: 1}, 0.6) // null (zero-extent ball → degenerate region)
 */
export function metaballRegion(worldBalls, world, pad) {
  if (!worldBalls.length) return null;
  const inv = T.invert(world);
  const scale = (world.scale ?? 1) || 1, rot = world.rotation ?? 0;
  const local = worldBalls.map((b) => {
    const c = T.apply(inv, b.x, b.y);
    return { type: b.type, cx: c.x, cy: c.y, r: (b.r ?? 0) / scale, len: (b.len ?? 0) / scale, ang: (b.ang ?? 0) - rot };
  });
  let maxReach = 0;
  for (const b of local) maxReach = Math.max(maxReach, b.r + b.len);
  if (maxReach <= 0) return null; // all zero-size balls → nothing to draw
  const margin = maxReach * pad;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of local) {
    const reach = b.r + b.len + margin;
    minX = Math.min(minX, b.cx - reach); maxX = Math.max(maxX, b.cx + reach);
    minY = Math.min(minY, b.cy - reach); maxY = Math.max(maxY, b.cy + reach);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const halfW = (maxX - minX) / 2, halfH = (maxY - minY) / 2;
  const minHalf = Math.min(halfW, halfH);
  if (minHalf <= 0) return null;
  const balls = local.flatMap((b) => [
    TYPE_CODE[b.type] ?? 0,
    (b.cx - cx) / (2 * halfW) + 0.5,
    (b.cy - cy) / (2 * halfH) + 0.5,
    b.r / minHalf,
    b.len / minHalf,
    b.ang,
  ]);
  const meanR = local.reduce((a, b) => a + b.r, 0) / local.length;
  return { cx, cy, halfW, halfH, balls, count: local.length, unit: meanR / minHalf };
}

export const metaballsPlugin = {
  type: "metaball",
  title: "Metaball",
  // `metaball: true` marks this widget a fusion PARTICIPANT for the derive-time
  // sibling query (core/derive.collectMetaballScene reads `localBalls` off it).
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: true, metaball: true },
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
  localBalls,
  /**
   * Near-pure function (reports ONCE if the fused-ball total exceeds the shader
   * cap). State → display-list: for the LEADER metaball, ONE materialBackdrop op
   * over the UNION region of EVERY metaball widget's balls (the fused surface);
   * for every non-leader, nothing (a pure ghost — still a draggable widget, its
   * frame drawn by the widget system, not emit).
   *
   * The world-space ball set is the derive-time sibling summary (s.metaballScene,
   * attached by core/derive.resolveMetaballScene). If absent (a direct-emit path —
   * a test or crop target) the widget falls back to rendering its OWN balls lifted
   * to world through its own transform — identical output to being a lone leader.
   * metaballRegion maps the balls into this leader's local frame and packs the
   * shader's fractions; the look knobs pass through and the SkSL packer clamps them.
   */
  emit(s, _sub, world) {
    if (s.metaballLeader === false) return []; // non-leader: the leader draws the whole field
    const w = world ?? IDENTITY;
    const worldBalls = s.metaballScene
      ? s.metaballScene.balls
      : localBalls(s).map((b) => {
          const c = T.apply(w, b.cx, b.cy);
          return { type: b.type, x: c.x, y: c.y, r: b.r * (w.scale ?? 1), len: b.len * (w.scale ?? 1), ang: b.ang + (w.rotation ?? 0) };
        });
    // Cap: the shader's fused-ball array is fixed. Clamp + report LOUDLY (never a
    // silent drop) when a slide holds more balls than the budget.
    let balls = worldBalls;
    if (balls.length > MAX_METABALLS) {
      reportOnce("metaball-ball-cap", `PowerRP metaball: ${balls.length} fused balls on the slide exceed the shader cap of ${MAX_METABALLS} — rendering the first ${MAX_METABALLS} (raise MAX_METABALLS in render_gpu/skia/metaballs_shader.js to show more).`);
      balls = balls.slice(0, MAX_METABALLS);
    }
    const region = metaballRegion(balls, w, REGION_PAD_FRAC);
    if (!region) return []; // no balls of positive extent → nothing to draw
    const strokeW = s.strokeWidth ?? 0;
    return [materialBackdrop({
      material: "metaballs",
      cx: region.cx, cy: region.cy, halfW: region.halfW, halfH: region.halfH,
      cornerRadius: 0,
      blurRadius: s.blurRadius,
      backdropScale: s.backdropScale,
      params: {
        balls: region.balls,
        ballCount: region.count,
        unit: region.unit,
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
