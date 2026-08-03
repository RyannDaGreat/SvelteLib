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
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte), keeping
 * the core Add menus clean. DOM-free / bare-node-safe at import time.
 */

import { EPHEMERAL } from "../../core/ephemeral.js";
import * as T from "../../core/transform.js";
import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, customProps, defaults, props } from "../../core/properties.js";
import { reportOnce } from "../../core/report.js";
import { materialBackdrop, parseColor } from "../../render_gpu/ir.js";
import { MAX_METABALLS, METABALLS_FILL_PARAMS, metaballsGlobalParams } from "../../render_gpu/skia/metaballs_shader.js";

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
// The fused region is the balls' bounding box GROWN by this fraction of the largest
// ball's reach — a margin that comfortably holds the isosurface past the raw ball
// radii (threshold-fattening + smooth-union neck bulge + the coverage AA band) for
// default-range knobs, so the merged surface (incl. the connecting neck between two
// widgets) is never clipped at the region edge.
const REGION_PAD_FRAC = 0.6;

// A ball with no owning-widget appearance (a geometry-only test/direct-emit path):
// zero-strength color = no tint; zero refraction. Real widgets always supply both.
const FALLBACK_FLUID_COLOR = [0, 0, 0, 0];
const FALLBACK_REFRACTION = 0;

// The three primitive kinds, mapped to the shader's numeric type code.
const TYPE_OPTIONS = ["sphere", "tube", "box"];
const TYPE_LABELS = { sphere: "Sphere", tube: "Tube", box: "Box" };
const TYPE_CODE = { sphere: 0, tube: 1, box: 2 };

// THE LOOK KNOBS LIVE IN THE SHADER ENTRY now (metaballs_shader.METABALLS_FILL_PARAMS
// — the fill-material framework's single-declaration rule: "custom properties become
// material properties"). This widget spreads that SAME schema into its customProps and
// adds only its widget-side `shape` selector: the ball PRIMITIVE (Sphere/Tube/Box)
// needs the bbox aspect a material fill never has, so it stays widget-side (a fill is
// always a lone centered sphere — metaballs_shader.metaballsFillUniformParams).
const CUSTOM = customProps([
  // ── the ball (this widget's single primitive) — WIDGET-SIDE geometry ──────────
  { name: "shape", kind: "select", options: TYPE_OPTIONS, optionLabels: TYPE_LABELS, default: "sphere", label: "Shape", help: "This droplet's primitive: Sphere (a round drop filling the box's short side), Tube (a capsule spanning the long side — good for a neck), or Box (a rounded-square drop filling the box). Place two metaball widgets close to MERGE them." },
  // ── the fluid material + surface + lighting — the SHARED fill schema ──────────
  ...METABALLS_FILL_PARAMS,
]);

/**
 * THE PRESETS — ONE FLAT `presets` family of `{name, description, props}`, applied to
 * the current frame in one undo unit by the Presets pane (web/ToolsPane.svelte →
 * app.applyPreset). Each is a named REAL FLUID whose knobs follow its physics: surface
 * tension sets how tightly it beads (`bulge`) and how wide a merge neck it pulls
 * (`smoothK`), refractive index sets `refraction`, viscosity sets `threshold` and neck
 * width, and transparency sets the fluid colour's ALPHA — which is the COLOREDNESS,
 * not an opacity: the tint MULTIPLIES the refracted backdrop, so it can only darken.
 *
 * FLAT, NOT `presetFamilies`. core/registry.js allows several named families and
 * requires them to write DISJOINT key sets so picks COMPOSE (enforced over every plugin
 * by tests/tool_groups_test.js). The schema does split cleanly here — per-ball material
 * (`fluidColor`, `refraction`) against global surface + lighting — but a real substance
 * couples its colour to its surface tension and its gloss: mercury's near-black body,
 * its mirror rim and its tall bead are ONE fact about mercury, and a pane that let you
 * pick "Quicksilver" colour with "Lava Lamp Wax" surface would compose a chimera. That
 * is plugins/demo/lens_flare.js:184-191's reasoning and it beats the structural
 * temptation.
 *
 * EVERY PRESET SETS EVERY LOOK KNOB. applyPreset writes `props` as an OVERLAY, so a
 * knob one row omits keeps whatever the PREVIOUSLY hovered row left there — rows that
 * disagree about which knobs they mention render differently depending on hover order,
 * and running down the list to compare whole materials is the entire point of the pane
 * (the plugins/demo/sky.js rule). All eleven are spelled out in all twelve maps.
 *
 * FIVE KNOBS ARE DELIBERATELY IN NO PRESET:
 *   `lightAngle`    — a light the author aimed is COMPOSITION, not look; every fluid
 *                     here reads correctly from any direction (the glass.js rule).
 *   `backdropScale` — the resolution/performance dial; a look must not quietly make the
 *                     widget four times more expensive to draw (glass.js again).
 *   `shape`         — the ball PRIMITIVE is fitted to the box the author drew, so it is
 *                     layout; leaving it alone means every fluid composes with whichever
 *                     primitive is already in place.
 *   `stroke`/`strokeWidth` — the optional hairline round the widget is the author's own
 *                     framing (the frosted_glass.js exclusion).
 * All values are LITERALS, so R6-25.1's `=` equation marker has nothing to mark here;
 * the shipped precedent for a whole-look family (lens_flare, sky, frosted_glass) is
 * literals too, and an equation in a preset can only reference `self.…`.
 *
 * ── THREE MEASURED FACTS THAT SHAPED THIS TABLE ──────────────────────────────────
 *
 * `bulge` IS CAP HEIGHT, AND SMALL MEANS FLAT. The ladder below runs the direction the
 * PIXELS give (render_gpu/skia/metaballs_shader.js's uBulge note; measurements under
 * .frenzy/round6/bulge and .frenzy/round6/W2-H-shots): at 0.05 the bead's interior is
 * 100% identical to the backdrop and the undisturbed fraction falls monotonically to
 * 18% by 3.0, so SMALL = a flat spread film and LARGE = a tall dome. Soap Film 0.22,
 * Olive Oil 0.30 and Blobby 0.10 are the films; Quicksilver 1.80, Lava Lamp Wax 2.20
 * and Leidenfrost 2.40 are the tall beads. THIS TABLE WAS ALREADY THE RIGHT WAY ROUND
 * and must not be "corrected": R6-25.5's flip instruction names the OTHER metaball
 * design, the Ohnesorge/sessile-drop one, which derived `bulge` from contact angle and
 * came out inverted. Flipping these twelve would break all twelve.
 *
 * `smoothK` IS PROVABLY INERT ON A LONE WIDGET and is written anyway. With one ball
 * sceneField's smooth-union seed is FIELD_FAR, so h clamps to 0 and f = d exactly —
 * measured: smoothK 0.05 against 2.6 on one widget is 0 BYTES different, and on two
 * adjacent widgets 46,961 bytes different. The value is the material's real surface
 * tension and it has to be right the moment two droplets touch, which is this widget's
 * whole premise (one ball per widget; you build a cluster by placing widgets close). It
 * therefore carries NO distinctness in a single-widget preview, exactly the way
 * plugins/demo/lens_flare.js:180-182 handles its own inert knobs.
 *
 * `threshold` STAYS AT OR UNDER 0.45, and the ceiling is NOT where the manifest says.
 * R6-3.14 records a hard clip above 0.6, reasoning that the fused region is padded by
 * REGION_PAD_FRAC of the ball reach so the isosurface r*(1+threshold) meets the region
 * EDGE at 0.6. Measured, on a small widget in a large frame: the ink tracks the analytic
 * radius exactly at 0.30 / 0.60 / 0.90 / 1.26 and only freezes above that. The real
 * bound is the material op's clip, which is the region CIRCUMRADIUS (r*1.6*sqrt(2)), so
 * the droplet is cut into a SQUARE at threshold ~1.26 — about 2.1x the recorded figure.
 * 0.45 was chosen against the old number and is left as a comfortable margin.
 *
 * ── WHAT IS NOT HERE, AND WHY (the anti-duplicate record) ────────────────────────
 * The knob set has no emission, no true opacity, no environment reflection and no
 * subsurface scattering, which rules five substances out before any of them can be
 * tuned: MOLTEN METAL is the same picture as mercury without emission; LIQUID NITROGEN
 * is water with every knob turned down (it is here instead as Leidenfrost Bead, which
 * earns its row on the vapour cushion — smoothK 0.12, ambient 0.02 — rather than on
 * being cold); an OIL LENS and molten glass sit within 0.02 of each other on refraction,
 * so only one gathers; SLIME is tinted water without SSS; and a THIN FILM's colour is
 * interference, which no knob expresses (Soap Film ships as a rim, not as a rainbow).
 * NOTHING WAS CUT FROM THE TWELVE BELOW — that was checked in pixels rather than
 * assumed: all 66 pairs were rendered over the varied backdrop and scored, and the
 * CLOSEST is Quicksilver against Ferrofluid at mean deltaE 17.8, more than double the
 * bar the frosted-glass family cut two candidates against. tests/metaball_presets_test.js
 * holds the table to that.
 *
 * ORDER IS BY MECHANISM (the frosted_glass.js:92-97 precedent), not by taste: the four
 * CLEAR REFRACTORS first, then the low-surface-tension SPREADER, then the two VISCOUS
 * TRANSLUCENTS, then the two ABSORBERS, then the two DARK REFLECTORS (whose rims are
 * exact opposites), and the cultural entry last. Neighbours never differ by hue alone.
 */
const PRESETS = [
  {
    name: "Spring Water",
    description: "A clean water bead on glass: barely any colour, a strong lens at n = 1.333, and the tight pinpoint sparkle every real droplet throws back at the light.",
    props: {
      fluidColor: "#e8fbff10", refraction: 0.34,
      smoothK: 0.85, threshold: 0.08, bulge: 0.85,
      chromatic: 0.05, specular: 1.9, shininess: 90, fresnel: 1.05, ambient: 0.26,
      blurRadius: 6,
    },
  },
  {
    name: "Morning Dew",
    description: "A bead on a waxy leaf, where a contact angle near 140 degrees holds it almost spherical: fully domed, hardly merging with its neighbours, and a needle-sharp highlight.",
    props: {
      fluidColor: "#eafcff0d", refraction: 0.42,
      smoothK: 0.35, threshold: 0.02, bulge: 1.70,
      chromatic: 0.07, specular: 2.3, shininess: 150, fresnel: 1.15, ambient: 0.30,
      blurRadius: 5,
    },
  },
  {
    name: "Leidenfrost Bead",
    description: "A drop skittering on a plate far above its boiling point: it rides its own vapour cushion, so it REFUSES to coalesce with anything it touches and casts no contact shade, and at n = 1.20 it is the weakest lens here.",
    props: {
      fluidColor: "#dff4ff0d", refraction: 0.14,
      smoothK: 0.12, threshold: 0.0, bulge: 2.40,
      chromatic: 0.02, specular: 2.2, shininess: 160, fresnel: 0.80, ambient: 0.02,
      blurRadius: 6,
    },
  },
  {
    name: "Soap Film",
    description: "A bubble wall: two surfaces a wavelength apart bend almost nothing, so the film is invisible except where it turns grazing — nearly all of this look is the blazing rim and the dispersion along it.",
    props: {
      fluidColor: "#ffffff08", refraction: 0.06,
      smoothK: 1.60, threshold: 0.05, bulge: 0.22,
      chromatic: 0.30, specular: 1.4, shininess: 180, fresnel: 1.35, ambient: 0.06,
      blurRadius: 14,
    },
  },
  {
    name: "Olive Oil",
    description: "An oil lens spreading on water: low interfacial tension flattens it into a wide slick that merges eagerly, and n = 1.467 bends harder than water even though the drop is shallow.",
    props: {
      fluidColor: "#c8d04a66", refraction: 0.40,
      smoothK: 1.50, threshold: 0.16, bulge: 0.30,
      chromatic: 0.03, specular: 1.0, shininess: 30, fresnel: 0.55, ambient: 0.20,
      blurRadius: 9,
    },
  },
  {
    name: "Honey",
    description: "A few thousand centipoise of syrup: it pulls the longest neck in the set before it lets go, it is deeply absorbing amber, and its sheen is a broad slow gloss rather than a glint.",
    props: {
      fluidColor: "#c87910b3", refraction: 0.36,
      smoothK: 2.40, threshold: 0.22, bulge: 1.40,
      chromatic: 0.02, specular: 0.9, shininess: 26, fresnel: 0.50, ambient: 0.35,
      blurRadius: 10,
    },
  },
  {
    name: "Molten Glass",
    description: "A gather on the end of the pipe: n = 1.52 makes it the strongest lens here and the only one with visible dispersion through its body, and the viscosity keeps every blob fat and round.",
    props: {
      fluidColor: "#e8a24a80", refraction: 0.50,
      smoothK: 2.10, threshold: 0.28, bulge: 1.90,
      chromatic: 0.10, specular: 2.0, shininess: 60, fresnel: 0.90, ambient: 0.30,
      blurRadius: 8,
    },
  },
  {
    name: "Ink in Water",
    description: "A miscible plume, the one thing here with NO interface: nothing to catch a highlight, nothing to bend light, just a soft-edged absorbing stain that flows into its neighbours without a neck.",
    props: {
      fluidColor: "#0a1a4df2", refraction: 0.02,
      smoothK: 2.60, threshold: 0.45, bulge: 0.12,
      chromatic: 0.0, specular: 0.05, shininess: 6, fresnel: 0.05, ambient: 0.05,
      blurRadius: 16,
    },
  },
  {
    name: "Lava Lamp Wax",
    description: "Buoyant paraffin crossing the density of the liquid around it: fat, plump, near-opaque blobs that fuse slowly and carry a waxy sheen instead of a sparkle.",
    props: {
      fluidColor: "#ff5a1ee0", refraction: 0.05,
      smoothK: 1.90, threshold: 0.30, bulge: 2.20,
      chromatic: 0.0, specular: 0.5, shininess: 14, fresnel: 0.35, ambient: 0.45,
      blurRadius: 12,
    },
  },
  {
    name: "Quicksilver",
    description: "Mercury: the highest surface tension of any common liquid holds it up in a tall bead, and because it transmits nothing the whole look is a dark body with a blazing environment rim and one hard mirror glint.",
    props: {
      fluidColor: "#20242aff", refraction: 0.0,
      smoothK: 1.30, threshold: 0.0, bulge: 1.80,
      chromatic: 0.0, specular: 3.2, shininess: 200, fresnel: 1.40, ambient: 0.55,
      blurRadius: 10,
    },
  },
  {
    name: "Ferrofluid",
    description: "Magnetite suspended in carrier oil — the exact inverse of Quicksilver: just as black and just as opaque, but the rim is DEAD, so all you get is an oily sheen sliding over a matte body.",
    props: {
      fluidColor: "#050508ff", refraction: 0.03,
      smoothK: 0.50, threshold: 0.0, bulge: 1.20,
      chromatic: 0.0, specular: 1.6, shininess: 120, fresnel: 0.25, ambient: 0.70,
      blurRadius: 12,
    },
  },
  {
    name: "Blobby (1982)",
    description: "The original demoscene metaball, after Blinn's blobby model: a hard fat threshold, one saturated colour, a flat-shaded interior with a sharp terminator, and no refraction or dispersion whatsoever.",
    props: {
      fluidColor: "#00d8ffff", refraction: 0.0,
      smoothK: 2.20, threshold: 0.35, bulge: 0.10,
      chromatic: 0.0, specular: 0.0, shininess: 1, fresnel: 0.15, ambient: 0.90,
      blurRadius: 4,
    },
  },
];

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
  ephemeral: EPHEMERAL.NONE,
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
    ...bundle("transform"),
    ...props("stroke", "strokeWidth", "opacity", {
      stroke: { label: "Edge color" },
      strokeWidth: { label: "Edge width" },
    }),
    ...CUSTOM.rows, // the look knobs (Inspector "Custom" region)
  ],
  presets: PRESETS,
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
        // The fused-scene balls are the WIDGET path's own (metaballRegion); the
        // GLOBAL surface/light knobs use the SAME mapping the fill path shares.
        balls: region.balls,
        ballCount: region.count,
        unit: region.unit,
        ...metaballsGlobalParams(s),
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
