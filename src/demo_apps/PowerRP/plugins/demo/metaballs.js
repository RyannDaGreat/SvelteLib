/**
 * Metaballs — a DEMO WIDGET (plugins/demo/, the showcase folder) on the reusable
 * MATERIAL FRAMEWORK. Blender-style metaballs (metaSphere / metaTube / metaSquare)
 * that MERGE into smooth blobs via a polynomial smooth-union, lit and refracted so
 * they read as WATER DROPLETS on the content beneath — a backdrop material
 * (render_gpu/skia/metaballs_shader.js) that refracts the composite-so-far, exactly
 * like Liquid Glass and CRT.
 *
 * ── ONE BALL PER WIDGET ───────────────────────────────────────────────────────
 * Each metaball widget contributes EXACTLY ONE ball, whose geometry IS the widget's
 * bbox: a `shape` (Sphere / Tube / Box) fitted to (w, h). A Sphere fills the short
 * dimension; a Tube is a capsule and a Box a rounded box, both spanning the long
 * axis. There is NO internal roster — MERGING happens ACROSS widgets: every metaball
 * widget on the slide FUSES into one surface (core/derive.collectMetaballScene), so
 * you build a cluster by placing widgets close, not by editing per-ball rows.
 *
 * ── PER-WIDGET FLUID MATERIAL (color + refraction) that BLEND at merges ───────
 * Each widget carries its own FLUID COLOR (`fluidColor`, whose ALPHA is the
 * coloredness/strength) and `refraction`. These travel with the widget's ball into
 * the fused scene and are BLENDED per pixel by a field-weighted partition of unity
 * in the shader — so a RED droplet merging a BLUE one shows a smooth PURPLE neck and
 * refraction crosses the neck seamlessly, and changing ANY widget's color/refraction
 * is visibly local to its lobe. Surface-SHAPE knobs (merge/threshold/bulge) and
 * LIGHTING (light/specular/fresnel/ambient/chromatic) are GLOBAL — one fused body
 * under one light — and are taken from the LEADER widget.
 *
 * Like glass/CRT it is a BACKDROP SAMPLER (capabilities.backdrop) and a bbox widget
 * (standard resize handles). It emits ONE `materialBackdrop` op naming the
 * "metaballs" material; it does NOT compose the effects bundle (a backdrop sampler
 * cannot be wrapped in an effectSubtree, whose offscreen re-render would sample an
 * empty surface).
 *
 * Every knob is a CUSTOM self.* property (core/properties.js customProps — the
 * Blender-style mechanism): each numeric knob is equation-capable (edit as a
 * literal, expression, or `= …` equation, referenceable elsewhere as self.<name>)
 * with ZERO evaluation-engine changes — the material framework carries the params
 * straight to the SkSL uniforms. Deterministic: no time / no random.
 *
 * Surfaced ONLY through the "Insert Demo Widget" submenu (web/App.svelte), keeping
 * the core Add menus clean. DOM-free / bare-node-safe at import time.
 */

import * as T from "../../core/transform.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { reportOnce } from "../../core/report.js";
import { materialBackdrop, parseColor } from "../../render_gpu/ir.js";
import { MAX_METABALLS } from "../../render_gpu/skia/metaballs_shader.js";

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const LIGHT_ANGLE_DEFAULT = -Math.PI * 0.68; // direction TO the light: upper, slightly left — the water sheen
// The fused region is the balls' bounding box GROWN by this fraction of the largest
// ball's reach — a margin that comfortably holds the isosurface past the raw ball
// radii (threshold-fattening + smooth-union neck bulge + the coverage AA band) for
// default-range knobs, so the merged surface (incl. the connecting neck between two
// widgets) is never clipped at the region edge.
const REGION_PAD_FRAC = 0.6;

// The fresh-droplet FLUID look: a watery aqua whose ALPHA is the "coloredness" —
// how strongly the fluid tints the refracted background. Clearly visible but
// translucent (the user wants "a color for the fluid"), NOT the near-colorless
// 0.06 of the old water tint.
const DEFAULT_FLUID_ALPHA = 0.35;
const DEFAULT_FLUID_RGB_HEX = "2fd9e0"; // aqua
const DEFAULT_FLUID_COLOR = `#${DEFAULT_FLUID_RGB_HEX}${Math.round(DEFAULT_FLUID_ALPHA * 255).toString(16).padStart(2, "0")}`;
// A ball with no owning-widget appearance (a geometry-only test/direct-emit path):
// zero-strength color = no tint; zero refraction. Real widgets always supply both.
const FALLBACK_FLUID_COLOR = [0, 0, 0, 0];
const FALLBACK_REFRACTION = 0;

// The three primitive kinds, mapped to the shader's numeric type code.
const TYPE_OPTIONS = ["sphere", "tube", "box"];
const TYPE_LABELS = { sphere: "Sphere", tube: "Tube", box: "Box" };
const TYPE_CODE = { sphere: 0, tube: 1, box: 2 };

const CUSTOM = customProps([
  // ── the ball (this widget's single primitive) ────────────────────────────────
  { name: "shape", kind: "select", options: TYPE_OPTIONS, optionLabels: TYPE_LABELS, default: "sphere", label: "Shape", help: "This droplet's primitive: Sphere (a round drop filling the box's short side), Tube (a capsule spanning the long side — good for a neck), or Box (a rounded-square drop filling the box). Place two metaball widgets close to MERGE them." },
  // ── the fluid material (PER-WIDGET; blends across merges) ─────────────────────
  { name: "fluidColor", kind: "color", default: DEFAULT_FLUID_COLOR, label: "Fluid color", help: "The fluid's body color; its ALPHA is how strongly the fluid is colored (0 = clear water, 1 = fully colored). When two droplets merge, their colors BLEND — a red drop meeting a blue drop gives a purple neck." },
  { name: "refraction", kind: "number", default: 0.27, min: 0, label: "Refraction", help: "Maximum lens displacement (fraction of the mean ball radius) of the refracted background — how hard this droplet magnifies/bends the content beneath it. Blends across a merge with a neighbour's refraction." },
  // ── the field (merge + surface) — GLOBAL (leader-wide) ────────────────────────
  { name: "smoothK", kind: "number", default: 0.90, min: 0, label: "Merge (smooth-k)", help: "Smooth-union merge amount (fraction of the MEAN BALL RADIUS). 0 = a hard union of separate shapes; larger fuses neighbours (including balls from other metaball widgets) into one bulging blob with a smooth neck — THE metaball merge." },
  { name: "threshold", kind: "number", default: 0.08, min: 0, label: "Threshold", help: "Isosurface level (fraction of the mean ball radius): raises the fluid 'level' so every blob fattens and gaps close. Higher = plumper, more-merged droplets." },
  { name: "bulge", kind: "number", default: 0.80, min: 0.05, label: "Bulge", help: "Dome thickness (fraction of the mean ball radius): small = tall, sharply-curved beads (strong refraction); large = flatter puddles." },
  // ── the water look (reuses the glass refraction + lighting math) — GLOBAL ─────
  { name: "chromatic", kind: "number", default: 0.05, min: 0, label: "Chromatic", help: "Chromatic dispersion at the rim: the R/B channels refract slightly more/less than G. A tiny value gives a real colored-edge fringe; too much makes a rainbow swirl at each bead's core." },
  { name: "lightAngle", kind: "number", default: LIGHT_ANGLE_DEFAULT, label: "Light angle", help: "Direction TO the light in radians (screen space; -π/2 is straight above). The upper face of each bead catches the specular glint." },
  { name: "specular", kind: "number", default: 1.75, min: 0, label: "Specular", help: "Strength of the Blinn-Phong glint — the bright sparkle a real water droplet throws back at the light. The key water cue." },
  { name: "shininess", kind: "number", default: 66, min: 1, label: "Shininess", help: "Specular exponent: higher = a tighter, sharper pinpoint glint; lower = a broad soft sheen." },
  { name: "fresnel", kind: "number", default: 0.95, min: 0, label: "Fresnel rim", help: "Brightness of the grazing rim, where a droplet catches a ring of the bright surroundings (environment reflection). Gives the bead its lit edge." },
  { name: "ambient", kind: "number", default: 0.28, min: 0, max: 1, label: "Contact shade", help: "Soft darkening on the unlit rim (0 = flat, higher = a rounder, seated bead). The shadow side that makes it read as 3D." },
  // ── render controls (world units + sample resolution) ────────────────────────
  { name: "blurRadius", kind: "number", default: 7, min: 0, label: "Environment blur", help: "Gaussian blur radius (world px) of the surroundings used for the fresnel rim glow. Softer = a smoother environment reflection." },
  { name: "backdropScale", kind: "number", default: 1.5, min: 0.25, max: 2, label: "Backdrop scale", help: "RESOLUTION FACTOR the content beneath is re-rendered at for the refraction: 1 = screen res, 2 = supersample (crisper droplets, slower), 0.5 = half res (faster, softer)." },
]);

/**
 * Pure function. This widget's SINGLE ball in LOCAL widget units — the metaball
 * archetype's SOURCE hook, called by core/derive.collectMetaballScene (never
 * imported by another plugin). GEOMETRY ONLY (the owning widget's fluid appearance
 * is attached later, in collectMetaballScene). The ball IS the bbox: centred at
 * (w/2, h/2), radius = the short half-size. A Sphere is a disk of that radius; a
 * Tube is a capsule and a Box a rounded box, both spanning the LONG axis (elong =
 * long-half − short-half, angle = 0 if wide else π/2). Returns [] for a degenerate
 * (zero-area) box so nothing is drawn.
 *
 * @param {object} s - folded item state (w, h, shape)
 * @returns {{type:string,cx:number,cy:number,r:number,len:number,ang:number}[]}
 *
 * @example localBalls({w: 200, h: 200, shape: "sphere"}) // [{type: "sphere", cx: 100, cy: 100, r: 100, len: 0, ang: 0}]
 * @example localBalls({w: 400, h: 200, shape: "tube"}) // [{type: "tube", cx: 200, cy: 100, r: 100, len: 100, ang: 0}] (capsule spans the long axis, radius = short half)
 * @example localBalls({w: 200, h: 400, shape: "box"}) // [{type: "box", cx: 100, cy: 200, r: 100, len: 100, ang: 1.5707963267948966}] (tall box: angle π/2)
 * @example localBalls({w: 0, h: 0, shape: "sphere"}) // [] (degenerate box: nothing to draw)
 */
export function localBalls(s) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const shortHalf = Math.min(w, h) / 2;
  if (shortHalf <= 0) return [];
  const longHalf = Math.max(w, h) / 2;
  const shape = TYPE_OPTIONS.includes(s.shape) ? s.shape : "sphere";
  const cx = w / 2, cy = h / 2;
  if (shape === "sphere") return [{ type: "sphere", cx, cy, r: shortHalf, len: 0, ang: 0 }];
  // Tube / Box: fit the LONG axis. elong carries the excess half-length; angle
  // orients along the long side (0 when wide, π/2 when tall).
  const ang = w >= h ? 0 : Math.PI / 2;
  return [{ type: shape, cx, cy, r: shortHalf, len: longHalf - shortHalf, ang }];
}

/**
 * Pure function. THE FUSED-REGION SOLVER — maps every metaball ball (in WORLD
 * coords) into the leader's LOCAL frame, then builds the shader's normalized inputs
 * for ONE backdrop covering their UNION (so the connecting neck between two widgets
 * lands INSIDE the region, never clipped at a widget's box edge).
 *
 * A world ball is `{type, x, y, r, len, ang, fluidColor?, refraction?}` (centre +
 * radius/half-length in world px, angle radians, plus its owning widget's FLUID
 * APPEARANCE: `fluidColor` a color string, `refraction` a number). Geometry is
 * inverted through `world` into leader-local space (a similarity divides lengths by
 * world.scale and subtracts world.rotation); appearance is a scalar material
 * property and passes through untransformed (color parsed to [r,g,b,a], a missing
 * appearance falling back to no-tint / zero refraction). The region is the balls'
 * local bounding box GROWN by `pad`·(largest ball reach). Ball geometry is emitted
 * as the SHADER's fractions — centre as 0..1 of the region box, r/len as a fraction
 * of the region's short half-size — so the region's SIZE cancels in the shader's
 * `frac·minHalf` decode (a ball keeps its world radius no matter how large the union
 * region is). Each ball's 11 packed floats are
 * [type, cx, cy, r, elong, angle, colR, colG, colB, colStrength, refraction].
 * `unit` (mean ball radius ÷ region short half-size) is the ball-intrinsic scale the
 * DISTANCE knobs ride, so a big region does not over-merge.
 *
 * Returns null when there are no balls of positive extent (nothing to draw).
 *
 * @param {object[]} worldBalls - balls in world coords (+ optional appearance)
 * @param {object} world - the leader node's local→world similarity
 * @param {number} pad - region growth as a fraction of the largest ball reach
 * @returns {{cx,cy,halfW,halfH,balls:number[],count:number,unit:number}|null}
 *
 * @example metaballRegion([{type: "sphere", x: 0, y: 0, r: 100, len: 0, ang: 0}], {x: 0, y: 0, rotation: 0, scale: 1}, 0) // {cx: 0, cy: 0, halfW: 100, halfH: 100, balls: [0, 0.5, 0.5, 1, 0, 0, 0, 0, 0, 0, 0], count: 1, unit: 1} (no appearance → no tint)
 * @example metaballRegion([], {x: 0, y: 0, rotation: 0, scale: 1}, 0.6) // null (no balls)
 * @example metaballRegion([{type: "sphere", x: 0, y: 0, r: 0, len: 0, ang: 0}], {x: 0, y: 0, rotation: 0, scale: 1}, 0.6) // null (zero-extent ball → degenerate region)
 */
export function metaballRegion(worldBalls, world, pad) {
  if (!worldBalls.length) return null;
  const inv = T.invert(world);
  const scale = (world.scale ?? 1) || 1, rot = world.rotation ?? 0;
  const local = worldBalls.map((b) => {
    const c = T.apply(inv, b.x, b.y);
    return {
      type: b.type, cx: c.x, cy: c.y, r: (b.r ?? 0) / scale, len: (b.len ?? 0) / scale, ang: (b.ang ?? 0) - rot,
      color: b.fluidColor != null ? parseColor(b.fluidColor) : FALLBACK_FLUID_COLOR,
      refraction: b.refraction ?? FALLBACK_REFRACTION,
    };
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
    b.color[0], b.color[1], b.color[2], b.color[3],
    b.refraction,
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
    type: "metaball", x: 130, y: 130, w: 440, h: 440, z: 100, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // No container border by default — the droplet IS the shape. strokeWidth 0.
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
   * over the UNION region of EVERY metaball widget's ball (the fused surface); for
   * every non-leader, nothing (a pure ghost — still a draggable widget, its frame
   * drawn by the widget system, not emit).
   *
   * The world-space ball set is the derive-time sibling summary (s.metaballScene,
   * attached by core/derive.resolveMetaballScene — each ball already carrying its
   * owning widget's fluidColor + refraction). If absent (a direct-emit path — a test
   * or crop target) the widget falls back to rendering its OWN ball lifted to world
   * through its own transform, tagged with its OWN appearance — identical output to
   * being a lone leader. metaballRegion maps the balls into this leader's local frame
   * and packs the shader's fractions (per-ball color + refraction blend in the
   * shader); the GLOBAL surface/light knobs pass through from THIS (leader) widget.
   */
  emit(s, _sub, world) {
    if (s.metaballLeader === false) return []; // non-leader: the leader draws the whole field
    const w = world ?? IDENTITY;
    const worldBalls = s.metaballScene
      ? s.metaballScene.balls
      : localBalls(s).map((b) => {
          const c = T.apply(w, b.cx, b.cy);
          return { type: b.type, x: c.x, y: c.y, r: b.r * (w.scale ?? 1), len: b.len * (w.scale ?? 1), ang: b.ang + (w.rotation ?? 0), fluidColor: s.fluidColor, refraction: s.refraction };
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
        chromatic: s.chromatic,
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
