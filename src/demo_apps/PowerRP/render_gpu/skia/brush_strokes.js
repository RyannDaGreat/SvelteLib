/**
 * THE BRUSH-STROKE STROKE MATERIAL — a textured "Skia Paint" brush that stamps a
 * procedural mask repeatedly along the stroke path with a single CanvasKit
 * `drawAtlas` call. It registers as ONE entry ("brush") in the stroke-material
 * registry (render_gpu/skia/stroke_materials.js); a `brush` SELECT knob picks one
 * of 23 archetypes (ink, pencil, marker, charcoal, watercolor, airbrush, …), and
 * the remaining knobs (spacing, jitter, scatter, flow, follow, seed, colour) are
 * shared multipliers/offsets that fine-tune whichever archetype is picked. This
 * keeps the PaintField "Mat" dropdown to a single readable line while still
 * shipping the full brush family.
 *
 * ── STATE KIND: PROPERTY STATE (CLAUDE.md "three kinds of state") ──────────────
 * A brush stroke is a PURE function of (path geometry, knobs, seed). No `t`, no
 * wall clock, no history, no Math.random. Δt = 0 changes nothing because there is
 * no `t` in the picture at all — a brush is simpler than a recordable particle
 * emitter. ALL jitter/scatter is seeded via core/particles.js randUnit(seed, i,
 * stream), the same deterministic hash the sparkler uses, so the same document
 * renders BYTE-IDENTICAL in the editor, the CLI still renderer, and both video
 * backends. The seed is stored document state (a strokeParam).
 *
 * ── HOW IT DRAWS ──────────────────────────────────────────────────────────────
 * 1. Each archetype owns a small procedural ALPHA MASK (white RGB + coverage
 *    alpha, premultiplied), generated once and cached as a CanvasKit.Image. No
 *    PNG assets, no network — the whole family is zero-asset and self-contained.
 * 2. render() walks the LOCAL-space path by arc length (ContourMeasureIter), and
 *    for each step pushes one sprite: a source rect (the whole mask), an RSXform
 *    (scale = stamp size, rotation = path tangent + jitter, translate = the
 *    arc-length point ± seeded scatter), and a packed colour (the stroke colour at
 *    the per-stamp flow·opacity alpha).
 * 3. One `drawAtlas(mask, src, xforms, paint, Modulate, colours)` paints every
 *    stamp: Modulate × white mask tints each stamp to the stroke colour, and the
 *    mask's own alpha × the colour's alpha gives per-stamp opacity (build-up where
 *    stamps overlap) for free — the "Skia Paint" technique.
 *
 * DOM-free at import (pure JS + string schema + Uint8Array mask builders); CanvasKit
 * arrives only as a render() / getStampImage() argument, exactly like paint_skia.js.
 */

import { parseColor } from "../ir.js";
import { randUnit } from "../../core/particles.js";
import { reportOnce } from "../../core/report.js";
import { unitNormal } from "../../core/geometry.js"; // the stroke family's shared perpendicular (was a local `leftNormal` copy)

// ── constants (WHY each exists — no magic numbers) ────────────────────────────
const STAMP_RES = 64;          // px side of every procedural mask; drawAtlas scales it to stamp size, so this is just texel resolution
const MASK_GEN_SEED = 0x5f3759; // fixed seed for MASK grain generation — the texture itself is stable; distinct from the per-stroke jitter seed knob
const MIN_STEP_PX = 0.5;       // floor on the arc-length gap between stamps (local px) so a tiny spacing can't spin an unbounded loop
const MAX_BRUSH_STAMPS = 20000; // hard cap on stamps per whole stroke — a pathological length/spacing can't stall a frame (reported loudly when hit)
const FLOW_DITHER = 0.15;      // seeded per-stamp opacity dither as a fraction of flow — breaks the mechanical look of uniform stamps
const TAU = Math.PI * 2;

// stream ids for randUnit(seed, i, stream) — one decorrelated channel per axis
const STREAM_SCALE = 0;
const STREAM_ROT = 1;
const STREAM_FLOW = 2;
const STREAM_SCATTER_N = 3;    // perpendicular (normal) scatter
const STREAM_SCATTER_T = 4;    // along-tangent scatter
const STREAM_COLOR = 5;        // per-stamp colour jitter toward the jitter colour

// ── pure math helpers (doctested) ─────────────────────────────────────────────

/**
 * Pure function. Clamps x into [0, 1].
 *
 * @example clampUnit(0.3) // 0.3
 * @example clampUnit(1.5) // 1
 * @example clampUnit(-0.2) // 0
 */
export function clampUnit(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Pure function. Smooth Hermite step: 0 below edge0, 1 above edge1, an
 * ease-in-out ramp between. The soft brush falloff and mask edges use it so a
 * scaled stamp reads soft rather than stair-stepped.
 *
 * @param {number} edge0 - lower edge
 * @param {number} edge1 - upper edge
 * @param {number} x - query
 * @returns {number} eased value in [0, 1]
 *
 * @example smoothStep(0, 1, 0.5) // 0.5
 * @example smoothStep(0, 1, 0) // 0
 * @example smoothStep(0, 1, 1) // 1
 * @example smoothStep(0, 1, -3) // 0
 */
export function smoothStep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clampUnit((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Pure function. A signed seeded value in [-1, 1) for stamp `i` on `stream` — the
 * symmetric form of randUnit used for size/rotation/scatter jitter (a draw of 0.5
 * maps to 0, i.e. no jitter). Deterministic in (seed, i, stream), so it is
 * property state.
 *
 * @param {number} seed - the stroke's stored seed
 * @param {number} i - stamp index (0-based, along the whole stroke)
 * @param {number} stream - decorrelated channel id
 * @returns {number} value in [-1, 1)
 *
 * @example signedJitter(7, 3, 0) === signedJitter(7, 3, 0) // true
 * @example signedJitter(7, 3, 0) >= -1 && signedJitter(7, 3, 0) < 1 // true
 */
export function signedJitter(seed, i, stream) {
  return randUnit(seed, i, stream) * 2 - 1;
}

/**
 * Pure function. The RSXform row [scos, ssin, tx, ty] that maps a `bw`×`bh` mask
 * (anchored at its CENTRE) to a stamp of scale `s` rotated by `ang` radians and
 * centred at device point (cx, cy) — the exact transform drawAtlas expects. RSXform
 * maps image (x,y) → (scos·x − ssin·y + tx, ssin·x + scos·y + ty); solving for the
 * translate that lands the mask centre on (cx, cy) gives the tx/ty below.
 *
 * @param {number} s - uniform scale (stamp size / mask size)
 * @param {number} ang - rotation in radians
 * @param {number} cx - stamp centre x (local px)
 * @param {number} cy - stamp centre y (local px)
 * @param {number} bw - mask width (px)
 * @param {number} bh - mask height (px)
 * @returns {[number, number, number, number]} [scos, ssin, tx, ty]
 *
 * @example stampRSXform(1, 0, 10, 20, 64, 64) // [1, 0, -22, -12]
 * @example stampRSXform(2, 0, 0, 0, 64, 64) // [2, 0, -64, -64]
 */
export function stampRSXform(s, ang, cx, cy, bw, bh) {
  const scos = s * Math.cos(ang);
  const ssin = s * Math.sin(ang);
  const ax = bw / 2, ay = bh / 2;
  return [scos, ssin, cx - (scos * ax - ssin * ay), cy - (ssin * ax + scos * ay)];
}

/**
 * Pure function. Resolves the ARCHETYPE base tuning ⊕ the user's shared knobs into
 * the concrete numbers render() walks with. Spacing and flow are MULTIPLIERS on the
 * archetype (1 = its natural value); sizeJitter/angleJitter/scatter ADD to the
 * archetype's own character (0 = leave it alone); `follow` is "auto" (use the
 * archetype), "on", or "off". Everything is clamped to a sane range.
 *
 * @param {object} preset - a BRUSH_PRESETS entry (spacing, scaleJitter, rotJitter, flow, followPath, scatter, sizeMul)
 * @param {object} params - the resolved strokeParams knob map
 * @returns {{spacingFrac:number, scaleJitter:number, rotJitter:number, scatter:number, flow:number, follow:boolean, sizeMul:number}}
 *
 * @example effectiveBrush({spacing: 0.1, scaleJitter: 0.2, rotJitter: 0.1, flow: 0.6, followPath: true, scatter: 0, sizeMul: 1}, {spacing: 1, sizeJitter: 0, angleJitter: 0, scatter: 0, flow: 1, follow: "auto"}) // {spacingFrac: 0.1, scaleJitter: 0.2, rotJitter: 0.1, scatter: 0, flow: 0.6, follow: true, sizeMul: 1}
 * @example effectiveBrush({spacing: 0.1, scaleJitter: 0, rotJitter: 0, flow: 1, followPath: true, scatter: 0, sizeMul: 1}, {spacing: 2, sizeJitter: 0.3, angleJitter: 0, scatter: 0.5, flow: 0.5, follow: "off"}).follow // false
 */
export function effectiveBrush(preset, params) {
  return {
    spacingFrac: Math.max(0.01, preset.spacing * (params.spacing ?? 1)),
    scaleJitter: clampUnit(preset.scaleJitter + (params.sizeJitter ?? 0)),
    rotJitter: Math.max(0, preset.rotJitter + (params.angleJitter ?? 0)),
    scatter: Math.max(0, preset.scatter + (params.scatter ?? 0)),
    flow: clampUnit(preset.flow * (params.flow ?? 1)),
    follow: params.follow === "on" ? true : params.follow === "off" ? false : preset.followPath,
    sizeMul: preset.sizeMul ?? 1,
  };
}

// ── procedural mask coverage fields (pure per-pixel functions, 0..1) ──────────
// Each takes normalized coords nx, ny in [-1, 1] (mask centre = 0,0) and the
// linear pixel index (for seeded grain). They return coverage in [0, 1].

/**
 * Pure function. A round tip's coverage at (nx, ny): 1 in the solid core (radius <
 * `hardness`), a smooth falloff to 0 at the rim (radius = 1), 0 outside. hardness→1
 * is a crisp disc (ink); hardness→0 is a soft cone (airbrush/watercolour base).
 *
 * @param {number} nx - x in [-1, 1]
 * @param {number} ny - y in [-1, 1]
 * @param {number} hardness - solid-core radius fraction in [0, 1)
 * @returns {number} coverage 0..1
 *
 * @example roundCoverage(0, 0, 0.5) // 1
 * @example roundCoverage(1, 0, 0.5) // 0
 * @example roundCoverage(0.75, 0, 0.5) // 0.5
 */
export function roundCoverage(nx, ny, hardness) {
  const r = Math.hypot(nx, ny);
  if (r >= 1) return 0;
  if (r <= hardness) return 1;
  return (1 - r) / (1 - hardness);
}

/**
 * Pure function. Seeded multiplicative grain in [1-amount, 1] for pixel `idx` — the
 * dry, speckled texture of chalk/charcoal/pencil. amount=0 is smooth (returns 1).
 * Deterministic in (idx, amount) via the fixed MASK_GEN_SEED, so the texture is
 * stable across renders (it is baked into the cached mask, not the live stroke).
 *
 * @param {number} idx - linear pixel index
 * @param {number} amount - grain depth in [0, 1]
 * @returns {number} multiplier in [1-amount, 1]
 *
 * @example grainAt(0, 0) // 1
 * @example grainAt(5, 0.5) >= 0.5 && grainAt(5, 0.5) <= 1 // true
 */
export function grainAt(idx, amount) {
  if (amount <= 0) return 1;
  return 1 - amount * randUnit(MASK_GEN_SEED, idx, 7);
}

/**
 * Near-pure function (allocates a Uint8Array; deterministic in its inputs). Builds
 * a STAMP_RES×STAMP_RES premultiplied-white RGBA mask from a per-pixel coverage
 * function covFn(nx, ny, idx) → 0..1. Premultiplied white means every channel holds
 * the coverage byte, so drawAtlas + BlendMode.Modulate tints it to any stroke
 * colour with correct alpha (§3c of the SPEC). Returns the flat RGBA bytes.
 *
 * @param {number} size - mask side in px
 * @param {(nx:number, ny:number, idx:number)=>number} covFn - coverage field
 * @returns {Uint8Array} size·size·4 premultiplied-white RGBA bytes
 *
 * @example buildMask(2, () => 1)[0] // 255
 * @example buildMask(2, () => 0)[0] // 0
 * @example buildMask(2, () => 0.5)[3] // 128
 */
export function buildMask(size, covFn) {
  const out = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const nx = (x + 0.5 - half) / half;
      const ny = (y + 0.5 - half) / half;
      const cov = clampUnit(covFn(nx, ny, idx));
      const b = Math.round(cov * 255);
      const o = idx * 4;
      out[o] = b; out[o + 1] = b; out[o + 2] = b; out[o + 3] = b;
    }
  }
  return out;
}

// ── the mask coverage fields per shape (pure closures) ────────────────────────

/** Query-like factory (pure). Returns a covFn for a round tip of the given
 * hardness and grain. Grain 0 = smooth ink/marker; grain high = dry chalk. */
function roundField(hardness, grain) {
  return (nx, ny, idx) => roundCoverage(nx, ny, hardness) * grainAt(idx, grain);
}

/** Pure covFn. A calligraphy NIB: a hard ellipse whose long axis is fixed at 45°,
 * thin across (aspect < 1). At a fixed angle (followPath off) it yields the
 * classic thick/thin calligraphic modulation as the stroke changes direction. */
function nibField(aspect) {
  const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
  return (nx, ny) => {
    const u = nx * c + ny * s;        // along the nib's long axis
    const v = -nx * s + ny * c;       // across the nib (the thin dimension)
    const r = Math.hypot(u, v / aspect);
    return smoothStep(1, 0.85, r);    // hard-ish ellipse edge
  };
}

/** Pure covFn. A felt-MARKER tip: a soft-cornered rounded square, near-uniform
 * interior — the broad even lay-down of a marker. */
function markerField() {
  return (nx, ny) => {
    const d = Math.max(Math.abs(nx), Math.abs(ny)); // square distance (Chebyshev)
    return smoothStep(0.95, 0.7, d);
  };
}

/** Pure covFn. BRISTLE rake: several seeded parallel streaks along the mask's
 * y-axis inside a round envelope — dry oil/acrylic drag marks (followPath aligns
 * the streaks with the direction of motion). */
function bristleField(count) {
  const centers = [];
  for (let k = 0; k < count; k++) centers.push(randUnit(MASK_GEN_SEED, k, 11) * 2 - 1);
  const halfW = 0.9 / count; // each bristle's half-width in normalized x
  return (nx, ny) => {
    const env = roundCoverage(nx, ny, 0.1); // round envelope, soft
    if (env <= 0) return 0;
    let best = 0;
    for (const c of centers) best = Math.max(best, smoothStep(halfW, halfW * 0.3, Math.abs(nx - c)));
    return env * best;
  };
}

/** Pure covFn. Airbrush SPECKLE: many tiny seeded dots, densest at the centre and
 * thinning to the rim — the grainy spray cloud of an airbrush. */
function speckleField(count, dotR) {
  const dots = [];
  for (let k = 0; k < count; k++) {
    const rr = Math.sqrt(randUnit(MASK_GEN_SEED, k, 13)); // sqrt → area-uniform, denser toward centre after weighting
    const th = randUnit(MASK_GEN_SEED, k, 14) * TAU;
    dots.push([rr * Math.cos(th) * 0.95, rr * Math.sin(th) * 0.95, 0.4 + 0.6 * randUnit(MASK_GEN_SEED, k, 15)]);
  }
  return (nx, ny) => {
    let a = 0;
    for (const [dx, dy, str] of dots) {
      const d = Math.hypot(nx - dx, ny - dy);
      if (d < dotR) a = Math.max(a, str * smoothStep(dotR, dotR * 0.2, d));
    }
    return a;
  };
}

/** Pure covFn. SPATTER: a soft central blob plus a ring of seeded satellite
 * droplets of varied size — an ink-fling / paint-spatter stamp. */
function spatterField() {
  const drops = [];
  const N = 9;
  for (let k = 0; k < N; k++) {
    const rr = 0.35 + 0.6 * randUnit(MASK_GEN_SEED, k, 21);
    const th = randUnit(MASK_GEN_SEED, k, 22) * TAU;
    drops.push([rr * Math.cos(th), rr * Math.sin(th), 0.06 + 0.16 * randUnit(MASK_GEN_SEED, k, 23)]);
  }
  return (nx, ny) => {
    let a = roundCoverage(nx, ny, 0.0) * 0.9; // soft core
    for (const [dx, dy, rad] of drops) {
      const d = Math.hypot(nx - dx, ny - dy);
      if (d < rad) a = Math.max(a, smoothStep(rad, rad * 0.3, d));
    }
    return a;
  };
}

/** Pure covFn. WATERCOLOUR blob: a soft round with an irregular (angularly
 * noised) edge and a mottled interior — a pigment pool that layers up where
 * strokes overlap (low flow does the rest). */
function watercolorField() {
  return (nx, ny, idx) => {
    const r = Math.hypot(nx, ny);
    const th = Math.atan2(ny, nx);
    const edge = 0.82 + 0.14 * (randUnit(MASK_GEN_SEED, Math.floor((th + Math.PI) * 6), 31) - 0.5) * 2;
    const body = smoothStep(edge, edge - 0.35, r);
    const mottle = 0.7 + 0.3 * randUnit(MASK_GEN_SEED, idx, 32);
    return body * mottle;
  };
}

// ── the 23 brush archetypes ───────────────────────────────────────────────────
// Each: {title, field, spacing (frac of stamp size between stamp CENTRES),
//        scaleJitter, rotJitter (turns), flow, followPath, scatter (frac of stamp
//        size), sizeMul (stamp size / stroke width)}. `field` is the mask coverage
//        function; the mask is generated once and cached by brush id.

const BRUSH_PRESETS = {
  // — INK / PEN (crisp, dry, no jitter) —
  inkPen: { title: "Ink Pen", field: roundField(0.85, 0), spacing: 0.05, scaleJitter: 0, rotJitter: 0, flow: 1, followPath: true, scatter: 0 },
  fineliner: { title: "Fineliner", field: roundField(0.9, 0), spacing: 0.04, scaleJitter: 0, rotJitter: 0, flow: 1, followPath: true, scatter: 0, sizeMul: 0.8 },
  technicalPen: { title: "Technical Pen", field: roundField(0.95, 0), spacing: 0.03, scaleJitter: 0, rotJitter: 0, flow: 1, followPath: true, scatter: 0, sizeMul: 0.6 },
  brushPen: { title: "Brush Pen", field: roundField(0.4, 0), spacing: 0.05, scaleJitter: 0.05, rotJitter: 0, flow: 0.95, followPath: true, scatter: 0 },
  // — PENCIL (grainy, light build-up) —
  pencilHB: { title: "Pencil HB", field: roundField(0.5, 0.55), spacing: 0.08, scaleJitter: 0.1, rotJitter: 0.05, flow: 0.55, followPath: true, scatter: 0.04 },
  pencil2B: { title: "Pencil 2B", field: roundField(0.55, 0.45), spacing: 0.08, scaleJitter: 0.12, rotJitter: 0.05, flow: 0.75, followPath: true, scatter: 0.04 },
  mechanicalPencil: { title: "Mechanical Pencil", field: roundField(0.7, 0.3), spacing: 0.06, scaleJitter: 0.06, rotJitter: 0, flow: 0.7, followPath: true, scatter: 0.02, sizeMul: 0.7 },
  coloredPencil: { title: "Colored Pencil", field: roundField(0.45, 0.5), spacing: 0.08, scaleJitter: 0.1, rotJitter: 0.08, flow: 0.6, followPath: true, scatter: 0.05 },
  // — MARKER / FELT —
  marker: { title: "Marker", field: markerField(), spacing: 0.06, scaleJitter: 0, rotJitter: 0, flow: 0.85, followPath: true, scatter: 0 },
  highlighter: { title: "Highlighter", field: markerField(), spacing: 0.05, scaleJitter: 0, rotJitter: 0, flow: 0.35, followPath: true, scatter: 0, sizeMul: 1.15, layerFlow: true },
  brushMarker: { title: "Brush Marker", field: roundField(0.35, 0), spacing: 0.05, scaleJitter: 0.05, rotJitter: 0, flow: 0.8, followPath: true, scatter: 0 },
  felt: { title: "Felt Tip", field: markerField(), spacing: 0.07, scaleJitter: 0.05, rotJitter: 0, flow: 0.8, followPath: true, scatter: 0.03 },
  // — CHARCOAL / CHALK / CRAYON / PASTEL (dry, textured) —
  charcoal: { title: "Charcoal", field: roundField(0.35, 0.7), spacing: 0.12, scaleJitter: 0.25, rotJitter: 0.15, flow: 0.6, followPath: true, scatter: 0.1 },
  chalk: { title: "Chalk", field: roundField(0.3, 0.8), spacing: 0.14, scaleJitter: 0.2, rotJitter: 0.2, flow: 0.55, followPath: true, scatter: 0.12 },
  crayon: { title: "Crayon", field: roundField(0.4, 0.55), spacing: 0.13, scaleJitter: 0.2, rotJitter: 0.15, flow: 0.6, followPath: true, scatter: 0.1 },
  conte: { title: "Conté", field: roundField(0.35, 0.6), spacing: 0.11, scaleJitter: 0.18, rotJitter: 0.12, flow: 0.65, followPath: true, scatter: 0.08 },
  pastel: { title: "Soft Pastel", field: roundField(0.25, 0.65), spacing: 0.12, scaleJitter: 0.15, rotJitter: 0.15, flow: 0.5, followPath: true, scatter: 0.1 },
  // — PAINT / WET —
  watercolor: { title: "Watercolor", field: watercolorField(), spacing: 0.1, scaleJitter: 0.15, rotJitter: 0.1, flow: 0.32, followPath: true, scatter: 0.06 },
  oil: { title: "Oil Bristle", field: bristleField(6), spacing: 0.06, scaleJitter: 0.1, rotJitter: 0, flow: 0.85, followPath: true, scatter: 0.04 },
  acrylicDry: { title: "Dry Acrylic", field: bristleField(8), spacing: 0.09, scaleJitter: 0.15, rotJitter: 0, flow: 0.7, followPath: true, scatter: 0.06 },
  // — FX / SPRAY —
  airbrush: { title: "Airbrush", field: speckleField(70, 0.16), spacing: 0.12, scaleJitter: 0.3, rotJitter: 0.5, flow: 0.32, followPath: false, scatter: 0.4 },
  spatter: { title: "Spatter", field: spatterField(), spacing: 0.3, scaleJitter: 0.4, rotJitter: 0.5, flow: 0.65, followPath: false, scatter: 0.6 },
  calligraphy: { title: "Calligraphy Nib", field: nibField(0.28), spacing: 0.03, scaleJitter: 0, rotJitter: 0, flow: 1, followPath: false, scatter: 0 },
};

/**
 * Query. The list of brush archetype ids — the SELECT knob's options and the
 * discoverability surface for tests. Order is the schema/UI order.
 *
 * @example brushIds().includes("charcoal") // true
 * @example brushIds().length // 23
 */
export function brushIds() {
  return Object.keys(BRUSH_PRESETS);
}

/**
 * Query. Resolves a brush id to its archetype preset. Throws LOUDLY on an unknown
 * id (a typo must never silently no-op the whole stroke — CLAUDE.md forbids silent
 * fallbacks).
 *
 * @param {string} id
 * @returns {object} the preset
 *
 * @example getBrushPreset("marker").title // "Marker"
 */
export function getBrushPreset(id) {
  const p = BRUSH_PRESETS[id];
  if (!p) throw new Error(`brush_strokes.getBrushPreset: unknown brush "${id}" (known: ${Object.keys(BRUSH_PRESETS).join(", ")})`);
  return p;
}

// ── stamp-mask image cache ────────────────────────────────────────────────────
// One CanvasKit.Image per brush id, built lazily and cached. Keyed by id; a process
// has exactly one CanvasKit instance (node CPU or browser GL), so the id is a
// sufficient key — the same precedent gpu/image_registry.js sets.
const STAMP_CACHE = new Map();

/**
 * Command (memoized; allocates a cached CanvasKit.Image). The procedural mask for
 * brush `id` as a premultiplied-white RGBA CanvasKit.Image, built once and cached.
 * The mask is a PURE function of the archetype's coverage field, so it is identical
 * on every backend. Never deleted (the cache owns it for the process lifetime, like
 * the glyph atlas). Throws if MakeImage fails rather than drawing nothing silently.
 *
 * @param {object} CanvasKit - the CanvasKit namespace
 * @param {string} id - brush id
 * @returns {{img: object, w: number, h: number}}
 *
 * @example // getStampImage(CanvasKit, "marker").w === 64
 */
export function getStampImage(CanvasKit, id) {
  const hit = STAMP_CACHE.get(id);
  if (hit) return hit;
  const preset = getBrushPreset(id);
  const bytes = buildMask(STAMP_RES, preset.field);
  const info = {
    width: STAMP_RES,
    height: STAMP_RES,
    colorType: CanvasKit.ColorType.RGBA_8888,
    alphaType: CanvasKit.AlphaType.Premul,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  };
  const img = CanvasKit.MakeImage(info, bytes, STAMP_RES * 4);
  if (!img) throw new Error(`brush_strokes.getStampImage: CanvasKit.MakeImage returned null for brush "${id}"`);
  const rec = { img, w: STAMP_RES, h: STAMP_RES };
  STAMP_CACHE.set(id, rec);
  return rec;
}

// ── the render command ────────────────────────────────────────────────────────

/**
 * Command (draws on `canvas`, which already rides the local→device CTM). THE brush
 * stroke: walk `path` by arc length, and for each step emit one sprite (source
 * rect, RSXform, packed colour) into three flat arrays, then paint them all in a
 * single drawAtlas call with BlendMode.Modulate so the white mask is tinted to the
 * stroke colour and each stamp carries its own flow·opacity alpha.
 *
 * Determinism: the arc-length walk is a pure function of the path (resScale fixed
 * at 1), and every jitter/scatter draw is seeded — same doc ⇒ same pixels. Frees
 * every ContourMeasure + the iterator + the Paint it allocates; NEVER deletes the
 * cached stamp Image or the caller's `path`.
 *
 * @param {object} CanvasKit
 * @param {object} canvas - CanvasKit.Canvas, on the local→device CTM
 * @param {object} path - the op's LOCAL-space CanvasKit.Path (not deleted here)
 * @param {object} params - resolved strokeParams (brush, color, spacing, sizeJitter, angleJitter, scatter, flow, follow, seed)
 * @param {number} strokeWidth - the stroke's LOCAL width (px) → base stamp size
 * @param {number} opacity - the node opacity 0..1
 * @param {boolean} aa - antialias
 *
 * @example // renderBrush(CanvasKit, canvas, localPath, {brush:"marker", color:"#111", spacing:1, sizeJitter:0, angleJitter:0, scatter:0, flow:1, follow:"auto", seed:12345}, 14, 1, true)
 */
export function renderBrush(CanvasKit, canvas, path, params, strokeWidth, opacity, aa) {
  if (!(strokeWidth > 0)) return;
  const preset = getBrushPreset(params.brush);
  const eff = effectiveBrush(preset, params);
  // layerFlow archetypes (highlighter) stay UNIFORMLY translucent: their stamps
  // are drawn OPAQUE (so the overlapping union is a solid band, not a patchwork of
  // build-up) into a saveLayer that is then composited at flow·opacity as a whole.
  // Plain build-up brushes (pencil, watercolour) instead accumulate per-stamp alpha
  // via SrcOver, which is what darkens where their strokes cross.
  const useLayer = preset.layerFlow === true;
  const stamp = getStampImage(CanvasKit, params.brush);
  const bw = stamp.w, bh = stamp.h;
  const stampSize = strokeWidth * eff.sizeMul;
  const step = Math.max(MIN_STEP_PX, eff.spacingFrac * stampSize);

  const rgba = parseColor(params.color);
  const R = Math.round(clampUnit(rgba[0]) * 255);
  const G = Math.round(clampUnit(rgba[1]) * 255);
  const B = Math.round(clampUnit(rgba[2]) * 255);
  const colorAlpha = (rgba[3] ?? 1) * opacity;
  const seed = params.seed | 0;
  // COLOUR JITTER: each stamp's ink is pushed toward `jitterColor` by a seeded
  // fraction of `colorJitter` (0 = off). Seeded via randUnit → property state,
  // Δt-invariant, no Math.random (CLAUDE.md). No arbitrary max on the amount.
  const jitterAmt = Math.max(0, params.colorJitter ?? 0);
  const jc = parseColor(params.jitterColor ?? "#000000");
  const jR = Math.round(clampUnit(jc[0]) * 255), jG = Math.round(clampUnit(jc[1]) * 255), jB = Math.round(clampUnit(jc[2]) * 255);

  const srcRects = [];
  const dstXforms = [];
  const colors = [];
  let i = 0;
  let capped = false;

  const iter = new CanvasKit.ContourMeasureIter(path, false, 1);
  let contour;
  while ((contour = iter.next())) {
    const len = contour.length();
    // d <= len inclusive so the endpoint is stamped; a zero-length contour still
    // gets its single d=0 stamp.
    for (let d = 0; d <= len + 1e-6; d += step) {
      if (i >= MAX_BRUSH_STAMPS) { capped = true; break; }
      const pt = contour.getPosTan(Math.min(d, len));
      const n = unitNormal(pt[2], pt[3]);
      const offN = signedJitter(seed, i, STREAM_SCATTER_N) * eff.scatter * stampSize;
      const offT = signedJitter(seed, i, STREAM_SCATTER_T) * eff.scatter * stampSize * 0.5;
      const cx = pt[0] + n[0] * offN + pt[2] * offT;
      const cy = pt[1] + n[1] * offN + pt[3] * offT;
      const s = (stampSize / bh) * (1 + signedJitter(seed, i, STREAM_SCALE) * eff.scaleJitter);
      const ang = (eff.follow ? Math.atan2(pt[3], pt[2]) : 0) + signedJitter(seed, i, STREAM_ROT) * eff.rotJitter * TAU;
      const xf = stampRSXform(s, ang, cx, cy, bw, bh);
      srcRects.push(0, 0, bw, bh);
      dstXforms.push(xf[0], xf[1], xf[2], xf[3]);
      // Opaque stamps in layer mode (the layer alpha applies flow·opacity once);
      // per-stamp seeded flow build-up otherwise.
      const stampFlow = eff.flow * (1 - FLOW_DITHER * randUnit(seed, i, STREAM_FLOW));
      const alphaByte = useLayer ? 255 : Math.round(clampUnit(stampFlow * colorAlpha) * 255);
      // seeded per-stamp colour toward the jitter colour (STREAM_COLOR decorrelates it)
      const jt = jitterAmt > 0 ? jitterAmt * randUnit(seed, i, STREAM_COLOR) : 0;
      const sr = jt > 0 ? Math.round(R + (jR - R) * jt) : R;
      const sg = jt > 0 ? Math.round(G + (jG - G) * jt) : G;
      const sb = jt > 0 ? Math.round(B + (jB - B) * jt) : B;
      colors.push(CanvasKit.ColorAsInt(sr, sg, sb, alphaByte));
      i++;
    }
    contour.delete();
    if (capped) break;
  }
  iter.delete();

  if (capped)
    reportOnce(
      `brush-stamp-cap:${params.brush}`,
      `PowerRP brush stroke "${params.brush}" hit the ${MAX_BRUSH_STAMPS}-stamp cap ` +
      `(path too long for spacing ${eff.spacingFrac.toFixed(3)} at width ${strokeWidth}) — raise spacing. Rendering the first ${MAX_BRUSH_STAMPS} stamps.`,
    );

  if (i === 0) return;
  const paint = new CanvasKit.Paint();
  paint.setAntiAlias(aa);
  // colors MUST be an unsigned Uint32Array: ColorAsInt returns a SIGNED 32-bit int
  // (a dark colour's alpha byte sets bit 31), and a plain JS number[] mis-marshals
  // that as a float — the sprite then draws untinted (white). Uint32Array.from
  // applies ToUint32, restoring the packed ARGB the binding expects.
  const colorArray = Uint32Array.from(colors);
  let layerPaint = null;
  if (useLayer) {
    layerPaint = new CanvasKit.Paint();
    layerPaint.setAlphaf(clampUnit(eff.flow * colorAlpha));
    canvas.saveLayer(layerPaint);
  }
  canvas.drawAtlas(
    stamp.img, srcRects, dstXforms, paint,
    CanvasKit.BlendMode.Modulate, colorArray,
    { filter: CanvasKit.FilterMode.Linear, mipmap: CanvasKit.MipmapMode.None },
  );
  if (useLayer) {
    canvas.restore();
    layerPaint.delete();
  }
  paint.delete();
}

// ── the registry entry ────────────────────────────────────────────────────────

/**
 * The BRUSH stroke-material registry entry: one entry, a `brush` SELECT knob that
 * picks one of the 23 archetypes, plus shared fine-tuning knobs. Registered in
 * render_gpu/skia/stroke_materials.js (import + one array slot).
 */
export const BRUSH_STROKE = {
  id: "brush",
  title: "Brush",
  strokeParams: [
    {
      name: "brush", kind: "select",
      options: brushIds(),
      optionLabels: Object.fromEntries(Object.entries(BRUSH_PRESETS).map(([id, p]) => [id, p.title])),
      default: "inkPen",
      help: "Which brush archetype to stamp along the stroke (ink, pencil, marker, charcoal, watercolor, airbrush, calligraphy, …).",
    },
    { name: "color", kind: "color", default: "#1b1b2f", help: "The ink colour every stamp is tinted to." },
    { name: "spacing", kind: "number", default: 1, min: 0, scrub: 0.01, help: "Multiplies the brush's natural stamp spacing. 1 = default; <1 denser/smoother; >1 gappier. (A near-zero value is floored to a safe minimum step so the walk terminates — no arbitrary upper cap.)" },
    { name: "sizeJitter", kind: "number", default: 0, min: 0, scrub: 0.01, help: "ADDS seeded per-stamp size variation on top of the brush's own (0 = brush default). Saturates in the stamp math — no arbitrary upper cap." },
    { name: "angleJitter", kind: "number", default: 0, min: 0, scrub: 0.01, help: "ADDS seeded per-stamp rotation in turns (1 = a full turn) on top of the brush's own — no arbitrary upper cap." },
    { name: "scatter", kind: "number", default: 0, min: 0, scrub: 0.01, help: "ADDS seeded scatter off the path (× stamp size) — pushes stamps sideways for spray/spatter looks. Wider spray is legitimate; no arbitrary upper cap." },
    { name: "colorJitter", kind: "number", default: 0, min: 0, scrub: 0.01, help: "Per-stamp colour jitter toward the jitter colour (seeded, deterministic). 0 = none; no arbitrary upper cap (saturates at the jitter colour)." },
    { name: "jitterColor", kind: "color", default: "#000000", help: "The colour each stamp is randomly pushed toward when colour jitter is on." },
    { name: "flow", kind: "number", default: 1, min: 0, max: 1, step: 0.01, help: "Per-stamp opacity multiplier (build-up). Combines with the brush default and the stroke's opacity." },
    {
      name: "follow", kind: "select",
      options: ["auto", "on", "off"],
      optionLabels: { auto: "Auto (brush default)", on: "Follow path", off: "Upright" },
      default: "auto",
      help: "Rotate each stamp to the path tangent. Auto uses the brush's natural setting (calligraphy/airbrush stay fixed).",
    },
    { name: "seed", kind: "number", default: 12345, min: 0, step: 1, help: "Randomness seed (STORED document state, deterministic — same seed, same jitter/scatter every render)." },
  ],
  render: renderBrush,
};
