/**
 * THE TEXTURE BRUSH — a stroke material that sweeps a TEXTURE IMAGE along the
 * stroke as a RIBBON MESH. It is the JS twin of rp's `skia_draw_trail` (rp/r.py)
 * on CanvasKit, and the brush the user originally asked for
 * (rp/misc/skia_trail_interactive_paint_demo.py): pick a real brush-stroke
 * texture from a PALETTE (render_gpu/skia/brush_textures/), and the outline is
 * painted by dragging that texture along the path with a triangle strip.
 *
 * It registers as ONE stroke-material entry ("textureBrush") — the twin kind of
 * the procedural drawAtlas brush (brush_strokes.js), which STAYS. Where the
 * procedural brush STAMPS a generated mask, this one WEAVES a photographed stroke.
 *
 * ── HOW IT DRAWS (the ribbon, per rp.skia_draw_trail) ─────────────────────────
 * 1. Walk the LOCAL-space path by arc length (ContourMeasureIter), sampling N
 *    points with their tangent + left normal. Two refinements then fix the sharp-
 *    corner kinking the user reported (#43): (a) CORNER-ADAPTIVE sampling inserts
 *    extra centreline points where the tangent turns fast (refineDistances +
 *    cornerSubdivisions), which de-facets CURVES at a coarse spacing; and (b) a
 *    ROUND JOIN (insertRoundJoins) pivots the ribbon normal through each genuine
 *    CORNER — because an offset ribbon at a hard corner otherwise MITERS into a
 *    spike/notch that no amount of centreline sampling removes; the fan sweeps both
 *    rails around the vertex, exactly like a round line join (and like a real brush
 *    rounding a direction change). The `smoothness` knob is the gain and also
 *    brackets each corner tightly enough for the join (0 = legacy uniform, no join).
 *    The 2^16 vertex cap still bounds all of it (decimate loudly).
 * 2. At each sample, offset ±half-thickness along the normal to get an INNER and
 *    an OUTER rail; the half-thickness TAPERS from `sizeStart` to `sizeEnd` down
 *    the stroke (× strokeWidth) with an optional sinusoidal `wobble` — the demo's
 *    size-start/size-end sliders + brushy wobble.
 * 3. Fill `ROWS` vertex rows across the thickness between the rails. U runs along
 *    the arc (0→`repeats`, mapped to the texture's WIDTH in px), V across the
 *    thickness (0→1, mapped to the texture's HEIGHT) — the Skia vertices UV
 *    contract (image PIXELS), exactly as render_gpu/skia/paint_skia.js
 *    drawPaperCurl scales its mesh uvs by iw/ih. `repeats` (#45) TILES the texture
 *    along the arc: repeats = 1 (default) spans it once with a CLAMP tile mode
 *    (byte-identical to before); repeats > 1 wraps U with a REPEAT tile mode; an
 *    "auto" mode (autoRepeats) picks an aspect-preserving integer count so a long
 *    stroke stops looking stretched.
 * 4. `drawVertices(Triangles, BlendMode.Modulate, imageShaderPaint)` paints it in
 *    one call: the image shader supplies the texture, and per-vertex colours
 *    MODULATE it — white passes the texture through untouched, a tint multiplies
 *    it, and a seeded per-segment COLOUR JITTER pushes segments toward a jitter
 *    colour. The texColors carry FULL alpha (the page-curl lesson: a partial-alpha
 *    vertex colour silently dims the texture).
 *
 * ── THE 2^16 MESH CAP (rp discovered it empirically) ──────────────────────────
 * Skia's MakeVertices indexes vertices with 16-bit indices, so a mesh may hold at
 * most 2^16 vertices. rp's skia_draw_trail shrinks v_subdivs then decimates the
 * contour to stay under it; we do the same: `ribbonSampleBudget` caps the sample
 * count at floor(2^16 / ROWS) and reports LOUDLY when a path is long enough to be
 * decimated (a silently-truncated ribbon is the failure this guards).
 *
 * ── STATE KIND: PROPERTY STATE (CLAUDE.md "three kinds of state") ──────────────
 * A texture-brush stroke is a PURE function of (path, knobs, seed, texture). No
 * `t`, no wall clock, no history, no Math.random. All colour jitter is seeded via
 * core/particles.js randUnit(seed, i, stream) — the same deterministic hash the
 * sparkler and the procedural brush use — so Δt = 0 changes nothing and the same
 * document renders BYTE-IDENTICAL across the editor, the CLI, and both video
 * backends. The seed is stored document state.
 *
 * ── TEXTURE LOADING (async decode, sync render — the image_registry contract) ──
 * Textures decode ASYNChronously; render() is sync. So render() asks
 * render_gpu/gpu/image_registry.getSkiaImage(CanvasKit, url) — which kicks an
 * idempotent decode and returns the CanvasKit.Image when ready, else null. A null
 * means "not decoded yet": we draw NOTHING this frame and report ONCE (no silent
 * blank stroke), and image_registry's onImageLoad nudges the reactive repaint to
 * try again. A genuine load FAILURE is reported loudly by image_registry itself.
 * This path is browser/GL-only (createImageBitmap): the bare-node CLI still
 * renderer cannot decode an image, so it draws nothing and reports it — the same
 * media omission the CLI already counts.
 *
 * DOM-free AT IMPORT (pure JS + string schema + the manifest's string data);
 * CanvasKit and the decoded Image arrive only inside render(), exactly like
 * paint_skia.js and stroke_materials.js. Bare node imports this file for the
 * doctest gate, so nothing here fetches or touches a DOM at module load.
 */

import { randUnit } from "../../core/particles.js";
import { reportOnce } from "../../core/report.js";
import { unitNormal } from "../../core/geometry.js"; // the stroke family's shared perpendicular (was a local `leftNormalTB` copy)
import { parseColor } from "../ir.js";
import { getSkiaImage } from "../gpu/image_registry.js";
import { BRUSH_TEXTURES, textureIds, getTexture, textureUrl, firstTextureOf } from "./brush_textures/manifest.js";

// ── constants (WHY each exists — no magic numbers) ────────────────────────────
const MESH_VERTEX_CAP = 1 << 16;   // Skia MakeVertices uses 16-bit indices → ≤ 2^16 vertices (rp discovered this empirically)
const RIBBON_ROWS = 6;             // vertex rows across the thickness; >2 lets a curved thick ribbon bend the texture smoothly, cheap
const RIBBON_SAMPLE_SPACING = 2.5; // local px per arc sample at spacing=1 — the stroke_materials ribbon spacing, fine enough that a wobble never aliases
const MIN_RIBBON_SAMPLES = 2;      // a degenerate-short contour still gets a 2-sample ribbon
// Corner-adaptive sampling (#43): between two UNIFORM samples whose tangents differ
// by more than this many radians, extra samples are inserted so a sharp corner (a
// gear tooth) is resolved by many centreline points instead of one kinked segment.
// ~5.7° per sample keeps a hard corner smooth without touching gentle curves.
const MAX_TURN_PER_SAMPLE = 0.10;
const DEFAULT_SMOOTHNESS = 1;      // corner-adaptive ON by default (#43: fix DEFAULT gear-tooth kinking); 0 = uniform-only (legacy)
// A genuine CORNER (a gear tooth), not a gentle curve: when two adjacent ribbon
// samples' tangents turn by more than this, the ribbon is given a ROUND JOIN there
// (a fan of vertices pivoting the normal through the corner) instead of letting the
// offset rails miter into a spike/notch. ~26° is well below any real corner and
// well above a densified curve step, so curves are untouched and corners round.
const CORNER_JOIN_ANGLE = 0.45;
const JOIN_STEP_ANGLE = 0.20;      // ~11.5° per fan vertex — smooth enough that a rounded corner reads as an arc, cheap
const TAU = Math.PI * 2;
const BYTE = 255;

// stream ids for randUnit(seed, i, stream) — one decorrelated channel per axis
const STREAM_JITTER = 0;           // per-segment colour-jitter magnitude

// ── pure math helpers (doctested, bare-node executable) ───────────────────────

/**
 * Pure function. Clamps x into [0, 1].
 *
 * @example clamp01(0.3) // 0.3
 * @example clamp01(1.5) // 1
 * @example clamp01(-0.2) // 0
 */
export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Pure function. Linear interpolation from a to b at parameter t.
 *
 * @example lerpN(0, 10, 0.25) // 2.5
 * @example lerpN(2, 4, 0.5) // 3
 */
export function lerpN(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Pure function. The ribbon's HALF-thickness (local px) at arc fraction u: a
 * linear taper from `sizeStart` to `sizeEnd` (multipliers of the stroke width),
 * modulated by a sinusoidal `wobble` of `wobbleFreq` waves across the path. This
 * is the demo's size-start/size-end sliders plus its brushy wobble, folded into
 * one profile. A calligraphic taper is sizeStart≫sizeEnd; a flat wash is
 * sizeStart≈sizeEnd, wobble≈0.
 *
 *     half(u) = ½·strokeWidth · lerp(sizeStart, sizeEnd, u) · (1 + wobble·sin(2π·wobbleFreq·u))
 *
 * @param {number} u - arc fraction 0..1
 * @param {number} strokeWidth - the stroke's local width (px)
 * @param {number} sizeStart - thickness multiplier at u=0
 * @param {number} sizeEnd - thickness multiplier at u=1
 * @param {number} wobble - sinusoidal amplitude (fraction of thickness)
 * @param {number} wobbleFreq - full waves across the path
 * @returns {number} half-thickness in local px (never negative)
 *
 * @example taperHalfWidth(0, 10, 1, 1, 0, 0) // 5
 * @example taperHalfWidth(1, 10, 1, 0.5, 0, 0) // 2.5
 * @example taperHalfWidth(0.5, 20, 1, 1, 0, 3) // 10
 */
export function taperHalfWidth(u, strokeWidth, sizeStart, sizeEnd, wobble, wobbleFreq) {
  const thickness = strokeWidth * lerpN(sizeStart, sizeEnd, u) * (1 + wobble * Math.sin(TAU * wobbleFreq * u));
  return Math.max(0, thickness / 2);
}

/**
 * Pure function. The seeded colour-jitter fraction in [0, amount] for segment `i`
 * — how far this segment's colour is pushed toward the jitter colour.
 * Deterministic in (seed, i), so it is property state (Δt-invariant).
 *
 * @param {number} amount - jitter magnitude (≥ 0; 0 = no jitter)
 * @param {number} seed - stored stroke seed
 * @param {number} i - segment index along the stroke
 * @returns {number} fraction in [0, amount]
 *
 * @example jitterFraction(0, 5, 3) // 0
 * @example jitterFraction(0.5, 5, 3) === jitterFraction(0.5, 5, 3) // true
 */
export function jitterFraction(amount, seed, i) {
  if (!(amount > 0)) return 0;
  return amount * randUnit(seed | 0, i | 0, STREAM_JITTER);
}

/**
 * Pure function. Mixes rgb `a` toward rgb `b` by t (each a [r,g,b] in 0..1).
 *
 * @param {number[]} a - [r,g,b] in 0..1
 * @param {number[]} b - [r,g,b] in 0..1
 * @param {number} t - mix fraction 0..1
 * @returns {[number,number,number]} mixed [r,g,b] in 0..1
 *
 * @example mixRgb([1, 1, 1], [0, 0, 0], 0.5) // [0.5, 0.5, 0.5]
 * @example mixRgb([1, 0, 0], [0, 0, 1], 0) // [1, 0, 0]
 */
export function mixRgb(a, b, t) {
  return [lerpN(a[0], b[0], t), lerpN(a[1], b[1], t), lerpN(a[2], b[2], t)];
}

/**
 * Pure function. Packs (r,g,b,a) bytes into the 0xAARRGGBB unsigned int
 * CanvasKit.MakeVertices expects for per-vertex colours (the drawPaperCurl
 * packing). Inputs are 0..255 bytes.
 *
 * @example packARGB(255, 255, 255, 255) // 4294967295
 * @example packARGB(0, 0, 0, 255) // 4278190080
 * @example packARGB(255, 0, 0, 255) // 4294901760
 */
export function packARGB(r, g, b, a) {
  return (((a & BYTE) << 24) | ((r & BYTE) << 16) | ((g & BYTE) << 8) | (b & BYTE)) >>> 0;
}

/**
 * Pure function. The per-segment packed vertex colour: the tint (white →
 * tintColor by tintStrength) pushed toward the jitter colour by the seeded jitter
 * fraction, at the given alpha byte. White tint + no jitter = 0xFFAARRGGBB with
 * rgb = 255 (texture passes through under Modulate).
 *
 * @param {number[]} tint - [r,g,b] 0..1, already blended white→tintColor
 * @param {number[]} jitterColor - [r,g,b] 0..1
 * @param {number} jitterFrac - seeded fraction 0..1
 * @param {number} alphaByte - 0..255 alpha
 * @returns {number} packed 0xAARRGGBB unsigned int
 *
 * @example segmentColor([1, 1, 1], [0, 0, 0], 0, 255) // 4294967295
 * @example segmentColor([1, 1, 1], [0, 0, 0], 1, 255) // 4278190080
 */
export function segmentColor(tint, jitterColor, jitterFrac, alphaByte) {
  const [r, g, b] = mixRgb(tint, jitterColor, jitterFrac);
  return packARGB(Math.round(clamp01(r) * BYTE), Math.round(clamp01(g) * BYTE), Math.round(clamp01(b) * BYTE), alphaByte);
}

/**
 * Pure function. How many arc samples a contour of the given LOCAL length gets at
 * the chosen spacing, floored at MIN_RIBBON_SAMPLES and CAPPED so the ribbon mesh
 * (samples × ROWS vertices) can never exceed the 2^16 Skia limit. Returns the
 * sample count AND whether the cap forced a decimation (so render() can report it
 * loudly, matching rp's decimation notice).
 *
 * @param {number} length - contour length in local px
 * @param {number} spacing - local px between samples
 * @param {number} rows - vertex rows across the thickness
 * @returns {{samples:number, decimated:boolean}}
 *
 * @example ribbonSampleBudget(100, 2.5, 6) // {samples: 41, decimated: false}
 * @example ribbonSampleBudget(1, 2.5, 6) // {samples: 2, decimated: false}
 * @example ribbonSampleBudget(1e9, 2.5, 6).decimated // true
 */
export function ribbonSampleBudget(length, spacing, rows) {
  const maxSamples = Math.floor(MESH_VERTEX_CAP / rows);
  const want = Math.max(MIN_RIBBON_SAMPLES, Math.ceil(length / spacing) + 1);
  if (want > maxSamples) return { samples: maxSamples, decimated: true };
  return { samples: want, decimated: false };
}

/**
 * Pure function. The unsigned turn angle (radians, 0..π) between two tangent
 * vectors — how sharply the path bends from one sample to the next. A degenerate
 * zero tangent contributes no turn (returns 0). Used by corner-adaptive sampling.
 *
 * @example tangentTurn(1, 0, 1, 0) // 0
 * @example Math.round(tangentTurn(1, 0, 0, 1) * 1000) // 1571
 * @example Math.round(tangentTurn(1, 0, -1, 0) * 1000) // 3142
 */
export function tangentTurn(t0x, t0y, t1x, t1y) {
  const l0 = Math.hypot(t0x, t0y), l1 = Math.hypot(t1x, t1y);
  if (!(l0 > 0) || !(l1 > 0)) return 0;
  const dot = (t0x * t1x + t0y * t1y) / (l0 * l1);
  return Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
}

/**
 * Pure function. How many EXTRA samples to insert inside a segment whose endpoint
 * tangents differ by `turn` radians, at the given corner `smoothness`. Zero when
 * smoothness ≤ 0 (uniform-only, legacy) or the turn is already under one
 * `maxTurn` step. Otherwise ⌈turn·smoothness / maxTurn⌉ − 1, so a 90° corner at
 * smoothness 1 and maxTurn 0.10 gets ~15 extra points and stops kinking.
 *
 * @param {number} turn - tangent turn in radians (≥ 0)
 * @param {number} smoothness - corner-refinement gain (0 = off)
 * @param {number} maxTurn - target max turn per sample (radians)
 * @returns {number} extra samples to insert (≥ 0 integer)
 *
 * @example cornerSubdivisions(0.05, 1, 0.1) // 0
 * @example cornerSubdivisions(0, 1, 0.1) // 0
 * @example cornerSubdivisions(1.5708, 1, 0.1) // 15
 * @example cornerSubdivisions(1.5708, 0, 0.1) // 0
 * @example cornerSubdivisions(1.5708, 2, 0.1) // 31
 */
export function cornerSubdivisions(turn, smoothness, maxTurn) {
  if (!(smoothness > 0) || !(turn > 0)) return 0;
  return Math.max(0, Math.ceil((turn * smoothness) / maxTurn) - 1);
}

/**
 * Pure function. Refines a list of ascending arc-length distances by inserting
 * extra points inside segments where the path TURNS sharply (corner-adaptive
 * sampling, #43). `tangents[i]` is the unit-ish tangent [tx, ty] at `dists[i]`.
 * smoothness ≤ 0 (or < 2 points) returns a copy unchanged, so it is the legacy
 * uniform walk. The inserted points are evenly spaced in arc within the segment
 * (a corner's turn is concentrated at its vertex, so even in-segment spacing still
 * lands many centreline points across the corner region).
 *
 * @param {number[]} dists - ascending arc distances (0..L)
 * @param {Array<[number,number]>} tangents - tangent per dist (same length)
 * @param {number} smoothness - corner-refinement gain (0 = uniform)
 * @param {number} maxTurn - target max turn per sample (radians)
 * @returns {number[]} the refined distance list (≥ dists.length)
 *
 * @example refineDistances([0, 10], [[1, 0], [1, 0]], 1, 0.1) // [0, 10]
 * @example refineDistances([0, 10], [[1, 0], [1, 0]], 0, 0.1) // [0, 10]
 * @example refineDistances([0, 4], [[1, 0], [0, 1]], 1, 1.0) // [0, 2, 4]
 */
export function refineDistances(dists, tangents, smoothness, maxTurn) {
  if (!(smoothness > 0) || dists.length < 2) return dists.slice();
  const out = [];
  for (let i = 0; i < dists.length - 1; i++) {
    out.push(dists[i]);
    const turn = tangentTurn(tangents[i][0], tangents[i][1], tangents[i + 1][0], tangents[i + 1][1]);
    const extra = cornerSubdivisions(turn, smoothness, maxTurn);
    for (let k = 1; k <= extra; k++) out.push(lerpN(dists[i], dists[i + 1], k / (extra + 1)));
  }
  out.push(dists[dists.length - 1]);
  return out;
}

/**
 * Pure function. Rotates the 2D vector (x, y) by `ang` radians (CCW). Used to sweep
 * a ribbon normal through a corner for a round join.
 *
 * @example rotateVec(1, 0, 0) // [1, 0]
 * @example rotateVec(1, 0, Math.PI / 2).map((v) => Math.round(v)) // [0, 1]
 * @example rotateVec(0, 1, Math.PI / 2).map((v) => Math.round(v)) // [-1, 0]
 */
export function rotateVec(x, y, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Pure function. The SIGNED angle (radians, −π..π) from unit-ish vector a to b —
 * positive is CCW. Tells a round join which way (and how far) to sweep the normal.
 *
 * @example signedAngle(1, 0, 0, 1).toFixed(4) // "1.5708"
 * @example signedAngle(1, 0, 0, -1).toFixed(4) // "-1.5708"
 * @example signedAngle(1, 0, 1, 0) // 0
 */
export function signedAngle(ax, ay, bx, by) {
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/**
 * Pure function. Inserts ROUND-JOIN fans into a ribbon sample list so sharp corners
 * (gear teeth) render as a clean pivoting arc instead of a mitered spike/notch (#43).
 * Where two consecutive samples' normals turn by more than `joinAngle`, a fan of
 * samples is inserted AT the later sample's position, pivoting the normal from the
 * first sample's to the second's in ≤ `stepAngle` steps (so both offset rails sweep
 * an arc of radius = half-thickness around the corner — a standard round line join).
 * Samples are {x, y, nx, ny, u, half}; the fan reuses the corner's position, u and
 * half. A gentle curve (small turns) is returned unchanged — this only fires at real
 * corners, which is why densified curve samples are left alone.
 *
 * @param {Array<{x:number,y:number,nx:number,ny:number,u:number,half:number}>} samples
 * @param {number} joinAngle - the turn (radians) above which a corner is rounded
 * @param {number} stepAngle - max radians between fan vertices
 * @returns {Array} the sample list with corner fans spliced in (≥ samples.length)
 *
 * @example insertRoundJoins([{x:0,y:0,nx:0,ny:1,u:0,half:5},{x:10,y:0,nx:0,ny:1,u:1,half:5}], 0.45, 0.2).length // 2
 * @example insertRoundJoins([{x:0,y:0,nx:0,ny:1,u:0,half:5},{x:5,y:0,nx:0,ny:-1,u:0.5,half:5},{x:0,y:5,nx:0,ny:1,u:1,half:5}], 0.45, 0.5).length // 15
 */
export function insertRoundJoins(samples, joinAngle, stepAngle) {
  if (samples.length < 2) return samples.slice();
  const out = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const turn = tangentTurn(a.nx, a.ny, b.nx, b.ny);
    if (turn > joinAngle) {
      const sweep = signedAngle(a.nx, a.ny, b.nx, b.ny);
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / stepAngle));
      // fan vertices at the corner (b's position), normal pivoting a.normal → b.normal
      for (let k = 1; k < steps; k++) {
        const [nx, ny] = rotateVec(a.nx, a.ny, sweep * (k / steps));
        out.push({ x: b.x, y: b.y, nx, ny, u: b.u, half: b.half });
      }
    }
    out.push(b);
  }
  return out;
}

/**
 * Pure function. The integer texture-repeat count that tiles the texture along the
 * arc at its NATURAL aspect ratio (#45 "auto" mode) — so a long stroke stops
 * stretching one texture across its whole length. One tile spans arc length
 * L/repeats and thickness `thickness`; matching that to the texture's own
 * imgW:imgH gives repeats = round(L·imgH / (thickness·imgW)), floored at 1.
 * Any non-positive input falls back to 1 (a single un-tiled pass).
 *
 * @param {number} length - contour arc length (local px)
 * @param {number} thickness - ribbon thickness (local px)
 * @param {number} imgW - texture width (px)
 * @param {number} imgH - texture height (px)
 * @returns {number} repeat count (integer ≥ 1)
 *
 * @example autoRepeats(1000, 50, 100, 50) // 10
 * @example autoRepeats(100, 100, 100, 50) // 1
 * @example autoRepeats(0, 50, 100, 50) // 1
 * @example autoRepeats(600, 40, 200, 50) // 4
 */
export function autoRepeats(length, thickness, imgW, imgH) {
  if (!(length > 0) || !(thickness > 0) || !(imgW > 0) || !(imgH > 0)) return 1;
  return Math.max(1, Math.round((length * imgH) / (thickness * imgW)));
}

/**
 * Pure builder (allocates typed arrays; deterministic in its inputs). Builds the
 * ribbon's flat vertex arrays from arc SAMPLES. Each sample is {x, y, nx, ny, u,
 * half} — a path point, its left normal, its arc fraction, and its half-thickness.
 * For each sample, `rows` vertices are laid from the inner rail (V=0) to the outer
 * rail (V=1); U = sample.u·repeats·imgW, V = rowFrac·imgH (image pixels — the Skia
 * vertices UV contract). `repeats` tiles the texture along the arc (#45): the caller
 * pairs repeats > 1 with a REPEAT tile mode on U so U wraps; repeats = 1 (default)
 * spans the texture ONCE, byte-identical to the pre-repeats mesh. Quads are emitted
 * in ARC ORDER so later-arc triangles paint on TOP (rp's triangle-ordering fix).
 *
 * @param {Array<{x:number,y:number,nx:number,ny:number,u:number,half:number}>} samples
 * @param {number} rows - vertex rows across the thickness (≥ 2)
 * @param {number} imgW - texture width (px) — U scale
 * @param {number} imgH - texture height (px) — V scale
 * @param {Uint32Array} colors - one packed 0xAARRGGBB colour PER SAMPLE
 * @param {number} [repeats=1] - texture tiles along the arc (U = u·repeats·imgW)
 * @returns {{positions:Float32Array, uvs:Float32Array, vertColors:Uint32Array, indices:Uint16Array}}
 *
 * @example // two samples, two rows → 4 vertices, 1 quad = 2 triangles = 6 indices
 * @example ribbonVertices([{x:0,y:0,nx:0,ny:1,u:0,half:5},{x:10,y:0,nx:0,ny:1,u:1,half:5}], 2, 64, 16, Uint32Array.from([4294967295,4294967295])).positions.length // 8
 * @example ribbonVertices([{x:0,y:0,nx:0,ny:1,u:0,half:5},{x:10,y:0,nx:0,ny:1,u:1,half:5}], 2, 64, 16, Uint32Array.from([4294967295,4294967295])).indices.length // 6
 * @example ribbonVertices([{x:0,y:0,nx:0,ny:1,u:0,half:5},{x:10,y:0,nx:0,ny:1,u:1,half:5}], 2, 64, 16, Uint32Array.from([4294967295,4294967295])).positions[1] // -5
 * @example ribbonVertices([{x:0,y:0,nx:0,ny:1,u:0,half:5},{x:10,y:0,nx:0,ny:1,u:1,half:5}], 2, 64, 16, Uint32Array.from([4294967295,4294967295]), 3).uvs[6] // 192
 */
export function ribbonVertices(samples, rows, imgW, imgH, colors, repeats = 1) {
  const n = samples.length;
  const V = n * rows;
  const positions = new Float32Array(2 * V);
  const uvs = new Float32Array(2 * V);
  const vertColors = new Uint32Array(V);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    // inner rail (V=0) = point − normal·half; outer rail (V=1) = point + normal·half
    const ix = s.x - s.nx * s.half, iy = s.y - s.ny * s.half;
    const ox = s.x + s.nx * s.half, oy = s.y + s.ny * s.half;
    for (let r = 0; r < rows; r++) {
      const f = rows > 1 ? r / (rows - 1) : 0;
      const v = i * rows + r;
      positions[2 * v] = lerpN(ix, ox, f);
      positions[2 * v + 1] = lerpN(iy, oy, f);
      uvs[2 * v] = s.u * repeats * imgW;
      uvs[2 * v + 1] = f * imgH;
      vertColors[v] = colors[i];
    }
  }
  const indices = new Uint16Array(6 * (n - 1) * (rows - 1));
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = i * rows + r, b = a + 1, c = (i + 1) * rows + r, d = c + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
    }
  }
  return { positions, uvs, vertColors, indices };
}

// ── blend modes (the demo's dropdown, mapped to CanvasKit enums) ──────────────

/** The knob's blend-mode options → CanvasKit.BlendMode enum names. Mirrors the
 * demo's _SKIA_BLEND_MODES; "normal" is SrcOver. */
const BLEND_ENUM = {
  normal: "SrcOver", multiply: "Multiply", screen: "Screen", overlay: "Overlay",
  darken: "Darken", lighten: "Lighten", add: "Plus",
};

/**
 * Query (reads CanvasKit). The CanvasKit.BlendMode for a blend knob string,
 * defaulting to SrcOver ("normal") on an unknown value. Not pure — CanvasKit is a
 * host object.
 *
 * @example // blendModeEnum(CanvasKit, "multiply") === CanvasKit.BlendMode.Multiply
 */
export function blendModeEnum(CanvasKit, name) {
  return CanvasKit.BlendMode[BLEND_ENUM[name] ?? "SrcOver"];
}

// ── real-world presets (researched: GIMP · Krita/Deevad · MyPaint · Photoshop
//    incl. Kyle's · Procreate default libraries — the cross-program canon) ──────
// Each preset names a real brush it emulates (the REFERENT comment) and writes the
// continuous knobs including COLOUR. KEY MECHANIC: the palette textures are
// PHOTOGRAPHED COLOUR strokes, so an ink/pencil emulation must RECOLOUR them —
// `tint`+`tintStrength` MODULATE the texture toward the target ink colour while the
// texture's own ALPHA (its dry nib/bristle edges) survives the tint, which is what
// gives a "black ink" preset real nib character instead of a flat fill. Wet-media
// presets keep tintStrength 0 (the texture's gorgeous own colours) and lean on
// `opacity` + Multiply for translucent build-up. `category` is the texture
// FALLBACK if the named id is ever recurated out (firstTextureOf).
//
// The "preset-type pattern" (manifest G.23): picking a preset EXPANDS these knobs
// onto the Inspector then reverts `preset` to "custom" for further editing;
// render() ALSO applies a stored preset, so a hand-authored doc renders its look.

const PRESETS = {
  // — INK. Coloured textures recoloured to classic ink; the dry alpha edges survive. —
  sumiInk:       { title: "Sumi-e Ink",      category: "ink",        texture: "oil_crimson_bristle", sizeStart: 1.3,  sizeEnd: 0.05, wobble: 0.14, wobbleFreq: 3, jitterAmount: 0.04, jitterColor: "#000000", tint: "#0a0a0a", tintStrength: 0.95, opacity: 1,    blend: "multiply" }, // Krita "Ink-8 Sumi-e": bristle-rake ink, dry striations
  gpenInker:     { title: "G-Pen Inker",     category: "ink",        texture: "oil_teal_slick",      sizeStart: 1.2,  sizeEnd: 0.12, wobble: 0,    wobbleFreq: 3, jitterAmount: 0,    jitterColor: "#000000", tint: "#0d0d12", tintStrength: 1,    opacity: 1,    blend: "normal" },   // Krita "Ink-3 Gpen" / Procreate "Studio Pen": hard round, strong pressure→size swell
  technicalPen:  { title: "Technical Pen",   category: "ink",        texture: "oil_cobalt_sweep",    sizeStart: 1,    sizeEnd: 1,    wobble: 0,    wobbleFreq: 3, jitterAmount: 0,    jitterColor: "#000000", tint: "#111114", tintStrength: 1,    opacity: 1,    blend: "normal" },   // Krita "Ink-2 Fineliner" / Procreate "Technical Pen": constant width, no dynamics
  vermilionInk:  { title: "Vermilion Ink",   category: "ink",        texture: "oil_scarlet_hook",    sizeStart: 1.25, sizeEnd: 0.1,  wobble: 0.05, wobbleFreq: 2, jitterAmount: 0,    jitterColor: "#3a0000", tint: "#ffffff", tintStrength: 0,    opacity: 1,    blend: "multiply" }, // Chinese vermilion brush ink (Procreate "Syrup" swell) — keeps the texture's own glossy scarlet
  roughInk:      { title: "Rough Ink Pen",   category: "dry-brush",  texture: "wc_dry_streak",       sizeStart: 1,    sizeEnd: 0.8,  wobble: 0.1,  wobbleFreq: 4, jitterAmount: 0.08, jitterColor: "#141414", tint: "#161616", tintStrength: 0.92, opacity: 0.95, blend: "multiply" }, // Krita "Ink-4 Pen Rough" / Procreate "Dry Ink": hard core, grain-broken edge

  // — GRAPHITE / DRY MEDIA. Grey/black recolour, translucent build-up, wobble grain. —
  pencil6B:      { title: "6B Pencil",       category: "dry-brush",  texture: "wc_dry_streak",       sizeStart: 0.9,  sizeEnd: 0.45, wobble: 0.14, wobbleFreq: 5, jitterAmount: 0.06, jitterColor: "#2a2a2a", tint: "#3c3c3c", tintStrength: 0.9,  opacity: 0.72, blend: "multiply" }, // Procreate "6B Pencil" / Krita "Pencil-2": grainy graphite, translucent
  charcoal:      { title: "Charcoal",        category: "grunge",     texture: "wc_umber_scrub",      sizeStart: 0.95, sizeEnd: 0.7,  wobble: 0.16, wobbleFreq: 5, jitterAmount: 0.14, jitterColor: "#101010", tint: "#171717", tintStrength: 0.93, opacity: 0.62, blend: "multiply" }, // cross-canon "Charcoal": soft grainy black, dusty build-up
  softPastel:    { title: "Soft Pastel",     category: "grunge",     texture: "wc_granular_umber",   sizeStart: 1.05, sizeEnd: 0.9,  wobble: 0.2,  wobbleFreq: 4, jitterAmount: 0.12, jitterColor: "#d8c4a0", tint: "#e8d8b8", tintStrength: 0.45, opacity: 0.72, blend: "multiply" }, // Procreate "Soft Pastel" / PS "Chalk on Canvas": chalky, keeps a warm pastel

  // — MARKER. Flat even opaque, keeps a saturated ink colour. —
  chiselMarker:  { title: "Chisel Marker",   category: "marker",     texture: "oil_cobalt_flat",     sizeStart: 1,    sizeEnd: 1,    wobble: 0.02, wobbleFreq: 3, jitterAmount: 0.03, jitterColor: "#0a1830", tint: "#ffffff", tintStrength: 0,    opacity: 0.88, blend: "multiply" }, // MyPaint "marker_fat" / GIMP "Block": flat chisel, opaque broad lay-down

  // — WATERCOLOUR. Own colours, translucent glaze, granulation jitter. —
  watercolorWash:{ title: "Watercolor Wash", category: "watercolor", texture: "wc_coral_wash",       sizeStart: 1.35, sizeEnd: 1.25, wobble: 0.22, wobbleFreq: 3, jitterAmount: 0.14, jitterColor: "#7a3a2a", tint: "#ffffff", tintStrength: 0,    opacity: 0.82, blend: "multiply" }, // universal "Watercolor": translucent, pigment granulation + edge pooling
  wetGlaze:      { title: "Wet Glaze",       category: "watercolor", texture: "wc_blue_wash",        sizeStart: 1.08, sizeEnd: 1,    wobble: 0.05, wobbleFreq: 3, jitterAmount: 0.06, jitterColor: "#20406a", tint: "#ffffff", tintStrength: 0,    opacity: 0.55, blend: "multiply" }, // PS "Watercolor Loaded" / Krita "Watercolor": thin layered glaze

  // — OPAQUE PAINT. Normal blend so it covers. —
  gouache:       { title: "Gouache",         category: "gouache",    texture: "oil_peach_smear",     sizeStart: 1.1,  sizeEnd: 0.9,  wobble: 0.06, wobbleFreq: 3, jitterAmount: 0.05, jitterColor: "#a07850", tint: "#ffffff", tintStrength: 0,    opacity: 1,    blend: "normal" },   // Procreate / Kyle's "Gouache": opaque flat matte
  oilImpasto:    { title: "Oil Impasto",     category: "oil",        texture: "oil_ember_smear",     sizeStart: 1.05, sizeEnd: 0.85, wobble: 0.1,  wobbleFreq: 4, jitterAmount: 0.08, jitterColor: "#5a2810", tint: "#ffffff", tintStrength: 0,    opacity: 1,    blend: "normal" },   // Procreate "Oil Paint" / Krita "Wet Bristle": bristle-streak impasto

  // — DRY BRISTLE RAKE. Sparse broken streaks. —
  dryBristle:    { title: "Dry Bristle Rake", category: "dry-brush", texture: "oil_olive_rake",      sizeStart: 0.9,  sizeEnd: 0.6,  wobble: 0.2,  wobbleFreq: 6, jitterAmount: 0.1,  jitterColor: "#3a3a20", tint: "#ffffff", tintStrength: 0,    opacity: 0.9,  blend: "multiply" }, // Krita "Dry Bristle" / PS "Rough Round Bristle": scumbling rake
};

/**
 * Query. The preset ids in UI order (the preset SELECT knob's options after
 * "custom").
 *
 * @example presetIds().includes("watercolorWash") // true
 * @example presetIds().length // 14
 */
export function presetIds() {
  return Object.keys(PRESETS);
}

/**
 * Pure function. Resolves the effective knob map after applying the chosen preset.
 * `preset === "custom"` (or an unknown id) returns `params` unchanged. Otherwise
 * the preset's continuous knobs OVERRIDE `params` and its category resolves to a
 * concrete texture (kept if the category is empty). This is what makes a preset
 * render its look in the probe / on first pick; the UI additionally writes these
 * back onto the knobs (integrator wiring).
 *
 * @param {object} params - the resolved strokeParams knob map
 * @returns {object} the effective knob map (a fresh object when a preset applies)
 *
 * @example applyPreset({preset: "custom", sizeStart: 0.7}).sizeStart // 0.7
 * @example applyPreset({preset: "sumiInk"}).sizeEnd // 0.05
 * @example applyPreset({preset: "sumiInk"}).blend // "multiply"
 * @example applyPreset({preset: "sumiInk"}).texture // "oil_crimson_bristle"
 * @example applyPreset({preset: "sumiInk"}).tint // "#0a0a0a"
 * @example applyPreset({preset: "technicalPen"}).wobble // 0
 * @example applyPreset({preset: "technicalPen"}).tintStrength // 1
 * @example applyPreset({preset: "watercolorWash"}).opacity // 0.82
 */
export function applyPreset(params) {
  const p = PRESETS[params.preset];
  if (!p) return params;
  return {
    ...params,
    texture: p.texture ?? firstTextureOf(p.category) ?? params.texture,
    sizeStart: p.sizeStart, sizeEnd: p.sizeEnd,
    wobble: p.wobble, wobbleFreq: p.wobbleFreq,
    jitterAmount: p.jitterAmount, jitterColor: p.jitterColor,
    blend: p.blend,
    // Colour knobs (an ink preset recolours the texture; a wash keeps its own).
    // ?? so a preset that omits one leaves that knob at the user's current value.
    tint: p.tint ?? params.tint,
    tintStrength: p.tintStrength ?? params.tintStrength,
    opacity: p.opacity ?? params.opacity,
  };
}

// ── the render command ────────────────────────────────────────────────────────

/**
 * Command (draws on `canvas`, which already rides the local→device CTM). THE
 * texture-brush stroke: for each contour of `path`, walk it by arc length, build
 * the tapered ribbon mesh, and paint it with a single drawVertices call using the
 * chosen texture as an image shader. Colour jitter + tint MODULATE the texture per
 * segment.
 *
 * Frees every ContourMeasure + iterator + Paint + shader it allocates; NEVER
 * deletes the cached texture Image (image_registry owns it) nor the caller's
 * `path`. Draws nothing (and reports once) when the texture is not yet decoded.
 *
 * @param {object} CanvasKit
 * @param {object} canvas - CanvasKit.Canvas on the local→device CTM
 * @param {object} path - the op's LOCAL-space CanvasKit.Path (not deleted here)
 * @param {object} params - resolved strokeParams (texture, preset, sizeStart, sizeEnd, wobble, wobbleFreq, spacing, tint, tintStrength, jitterAmount, jitterColor, opacity, blend, seed)
 * @param {number} strokeWidth - the stroke's LOCAL width (px) → base ribbon thickness
 * @param {number} opacity - the node opacity 0..1
 * @param {boolean} aa - antialias
 *
 * @example // renderTextureBrush(CanvasKit, canvas, localPath, {texture:"wc_blue_wash", preset:"custom", sizeStart:1, sizeEnd:1, wobble:0, wobbleFreq:3, spacing:1, tint:"#ffffff", tintStrength:0, jitterAmount:0, jitterColor:"#000000", opacity:1, blend:"normal", seed:12345}, 24, 1, true)
 */
export function renderTextureBrush(CanvasKit, canvas, path, params, strokeWidth, opacity, aa) {
  if (!(strokeWidth > 0)) return;
  const p = applyPreset(params);
  const tex = getTexture(p.texture); // throws loudly on a bad id
  const img = getSkiaImage(CanvasKit, textureUrl(tex.id));
  if (!img) {
    reportOnce(
      `texbrush-pending:${tex.id}`,
      `PowerRP texture brush: texture "${tex.id}" is not decoded yet — drew nothing this frame. ` +
      `A reactive repaint draws it once image_registry finishes; a genuine load failure is reported by image_registry. ` +
      `(The bare-node CLI cannot decode images and will always report this — use a GPU/browser render for textures.)`,
    );
    return;
  }
  const imgW = img.width(), imgH = img.height();

  // tint = white → tintColor by tintStrength; jitterColor as [r,g,b]
  const tintRgba = parseColor(p.tint ?? "#ffffff");
  const tint = mixRgb([1, 1, 1], [tintRgba[0], tintRgba[1], tintRgba[2]], clamp01(p.tintStrength ?? 0));
  const jc = parseColor(p.jitterColor ?? "#000000");
  const jitterColor = [jc[0], jc[1], jc[2]];
  const alphaByte = Math.round(clamp01((p.opacity ?? 1) * opacity) * BYTE);
  const seed = p.seed | 0;
  const spacing = Math.max(1e-3, RIBBON_SAMPLE_SPACING * (p.spacing ?? 1));
  const smoothness = Math.max(0, p.smoothness ?? DEFAULT_SMOOTHNESS);   // #43 corner-adaptive gain
  const repeatMode = p.repeatMode === "auto" ? "auto" : "manual";       // #45 tiling mode
  const repeatsManual = Math.max(1e-3, p.repeats ?? 1);
  const maxSamples = Math.floor(MESH_VERTEX_CAP / RIBBON_ROWS);
  const sizeStart = p.sizeStart ?? 1, sizeEnd = p.sizeEnd ?? 1;

  const paint = new CanvasKit.Paint();
  paint.setAntiAlias(aa);
  paint.setBlendMode(blendModeEnum(CanvasKit, p.blend));

  let anyDecimated = false;
  const iter = new CanvasKit.ContourMeasureIter(path, false, 1);
  let contour;
  let segBase = 0; // global segment index so jitter decorrelates across contours
  while ((contour = iter.next())) {
    const L = contour.length();
    if (L > 0) {
      // 1) UNIFORM base walk (capped at the mesh limit as before).
      const base = ribbonSampleBudget(L, spacing, RIBBON_ROWS);
      const baseDists = new Array(base.samples);
      const baseTans = new Array(base.samples);
      for (let i = 0; i < base.samples; i++) {
        const d = base.samples > 1 ? (L * i) / (base.samples - 1) : 0;
        const pt = contour.getPosTan(d);
        baseDists[i] = d;
        baseTans[i] = [pt[2], pt[3]];
      }
      // 2) CORNER-ADAPTIVE refinement (#43): denser samples where the path turns.
      let dists = refineDistances(baseDists, baseTans, smoothness, MAX_TURN_PER_SAMPLE);
      let decimated = base.decimated;
      // The 2^16 cap is the PHYSICAL bound; if adaptive pushed past it, fall back to
      // the uniform max-sample walk and report LOUDLY (as ribbonSampleBudget does).
      if (dists.length > maxSamples) {
        dists = new Array(maxSamples);
        for (let i = 0; i < maxSamples; i++) dists[i] = (L * i) / (maxSamples - 1);
        decimated = true;
      }
      anyDecimated = anyDecimated || decimated;

      // 3) REPEATS (#45): auto derives an aspect-preserving integer tiling per contour.
      const avgThick = strokeWidth * (sizeStart + sizeEnd) / 2;
      const repeats = repeatMode === "auto" ? autoRepeats(L, avgThick, imgW, imgH) : repeatsManual;

      const n = dists.length;
      const rawSamples = new Array(n);
      for (let i = 0; i < n; i++) {
        const d = dists[i];
        const u = clamp01(d / L); // arc FRACTION (drives taper + texture U), not index fraction
        const pt = contour.getPosTan(d);
        const nrm = unitNormal(pt[2], pt[3]);
        rawSamples[i] = { x: pt[0], y: pt[1], nx: nrm[0], ny: nrm[1], u, half: taperHalfWidth(u, strokeWidth, sizeStart, sizeEnd, p.wobble ?? 0, p.wobbleFreq ?? 3) };
      }
      // 4) ROUND JOINS (#43): pivot the normal through each sharp corner so a gear
      //    tooth reads as a clean arc, not a mitered spike. Gated on smoothness > 0
      //    (which also brackets the vertex closely via the refinement above), so
      //    smoothness = 0 is the untouched legacy walk — mitered corners and all.
      let samples = smoothness > 0 ? insertRoundJoins(rawSamples, CORNER_JOIN_ANGLE, JOIN_STEP_ANGLE) : rawSamples;
      if (samples.length > maxSamples) { samples = samples.slice(0, maxSamples); decimated = true; anyDecimated = true; }
      // colours are per-FINAL-sample (fan vertices included); seeded → deterministic.
      const colors = new Uint32Array(samples.length);
      for (let i = 0; i < samples.length; i++)
        colors[i] = segmentColor(tint, jitterColor, jitterFraction(p.jitterAmount ?? 0, seed, segBase + i), alphaByte);
      const mesh = ribbonVertices(samples, RIBBON_ROWS, imgW, imgH, colors, repeats);

      // mipmap'd + bilinear (rp: mipmap=True, interp="bilinear"). U tiles with REPEAT
      // when repeats ≠ 1 so the texture wraps along the arc (#45); at repeats = 1 it
      // CLAMPS, so the ribbon never tiles its own soft ends — byte-identical default.
      // V (across the thickness) always clamps. The shader is per-contour because
      // auto repeats varies by contour length.
      const tileU = repeats === 1 ? CanvasKit.TileMode.Clamp : CanvasKit.TileMode.Repeat;
      const shader = img.makeShaderOptions(tileU, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.Linear);
      paint.setShader(shader);
      const verts = CanvasKit.MakeVertices(CanvasKit.VertexMode.Triangles, mesh.positions, mesh.uvs, mesh.vertColors, mesh.indices, false);
      canvas.drawVertices(verts, CanvasKit.BlendMode.Modulate, paint);
      verts.delete();
      shader.delete();
      segBase += samples.length;
    }
    contour.delete();
  }
  iter.delete();
  paint.delete();

  if (anyDecimated)
    reportOnce(
      `texbrush-decimated:${tex.id}`,
      `PowerRP texture brush "${tex.id}": a contour exceeded the ${MESH_VERTEX_CAP}-vertex Skia mesh cap ` +
      `(after corner-adaptive refinement) and was DECIMATED to fit (rp's 2^16 workaround). ` +
      `Raise "spacing" or lower "smoothness" for a longer smooth ribbon.`,
    );
}

// ── the registry entry (export ready to register; integrator adds it) ─────────

/**
 * The TEXTURE-BRUSH stroke-material registry entry. The integrator registers it
 * in render_gpu/skia/stroke_materials.js (import + one array slot); this module
 * never edits that file. Knob hygiene (manifest B.2/B.3): fractional knobs scrub
 * 0.01; only PHYSICAL bounds (min 0, spacing > 0) — no arbitrary maxima.
 */
export const TEXTURE_BRUSH = {
  id: "textureBrush",
  title: "Texture Brush",
  strokeParams: [
    {
      name: "texture", kind: "select",
      options: textureIds(),
      optionLabels: Object.fromEntries(BRUSH_TEXTURES.map((t) => [t.id, t.name])),
      default: "wc_coral_wash",
      help: "The brush-stroke texture swept along the stroke as a ribbon (real watercolour / oil / ink / gouache strokes). Pick from the palette.",
    },
    {
      name: "preset", kind: "select",
      options: ["custom", ...presetIds()],
      optionLabels: { custom: "Custom", ...Object.fromEntries(Object.entries(PRESETS).map(([id, v]) => [id, v.title])) },
      default: "custom",
      help: "A real-world brush preset (Sumi-e Ink, Watercolor Wash, Grunge Marker, …). Selecting one writes the knobs below; edit them and it becomes Custom.",
    },
    { name: "sizeStart", kind: "number", default: 1, min: 0, scrub: 0.01, help: "Ribbon thickness at the START of the stroke (× stroke width). Larger than sizeEnd = a taper. No arbitrary upper cap." },
    { name: "sizeEnd", kind: "number", default: 1, min: 0, scrub: 0.01, help: "Ribbon thickness at the END of the stroke (× stroke width). 0 = a sharp calligraphic point. No arbitrary upper cap." },
    { name: "wobble", kind: "number", default: 0, min: 0, scrub: 0.01, help: "Sinusoidal thickness wobble (fraction) — a living, hand-made edge. 0 = a clean ribbon. No arbitrary upper cap." },
    { name: "wobbleFreq", kind: "number", default: 3, min: 0, scrub: 0.1, help: "How many wobble waves run across the whole stroke." },
    { name: "spacing", kind: "number", default: 1, min: 0, scrub: 0.01, help: "Uniform resample density along the ribbon (× the base spacing). <1 = smoother/denser; >1 = coarser. (Floored to a safe minimum step so the walk terminates — no arbitrary cap.)" },
    { name: "smoothness", kind: "number", default: 1, min: 0, scrub: 0.1, help: "Corner smoothness — de-facets curves AND gives sharp corners (gear teeth) a ROUND JOIN instead of a mitered spike, so hard corners stop kinking. 0 = uniform sampling only, no join (legacy); higher resolves corners more finely. Bounded by the 2^16 mesh cap (decimates loudly), no arbitrary max." },
    {
      name: "repeatMode", kind: "select",
      options: ["manual", "auto"],
      optionLabels: { manual: "Manual (repeats)", auto: "Auto (keep aspect)" },
      default: "manual",
      help: "How many times the texture tiles along the stroke. Manual uses the 'repeats' value; Auto tiles it at its natural aspect ratio so a long stroke stops looking stretched.",
    },
    { name: "repeats", kind: "number", default: 1, min: 0, scrub: 0.1, help: "Tile the texture this many times along the arc (Manual mode). 1 = one un-tiled pass (default). Fractional allowed. No arbitrary upper cap." },
    { name: "tint", kind: "color", default: "#ffffff", help: "Recolour the texture toward this colour (Modulate). White = the texture's OWN colours." },
    { name: "tintStrength", kind: "number", default: 0, min: 0, max: 1, step: 0.01, help: "How strongly to tint (0 = texture's own colours; 1 = fully the tint colour)." },
    { name: "jitterAmount", kind: "number", default: 0, min: 0, scrub: 0.01, help: "Per-segment colour jitter magnitude toward the jitter colour (seeded, deterministic). 0 = none. No arbitrary upper cap." },
    { name: "jitterColor", kind: "color", default: "#000000", help: "The colour each segment is randomly pushed toward when jitter is on." },
    { name: "opacity", kind: "number", default: 1, min: 0, max: 1, step: 0.01, help: "Per-stroke opacity (flow). Combines with the item's opacity." },
    {
      name: "blend", kind: "select",
      options: ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add"],
      optionLabels: { normal: "Normal", multiply: "Multiply", screen: "Screen", overlay: "Overlay", darken: "Darken", lighten: "Lighten", add: "Add" },
      default: "normal",
      help: "How the ribbon composites onto the canvas (the demo's blend-mode dropdown). Multiply = paint builds up on overlap.",
    },
    { name: "seed", kind: "number", default: 12345, min: 0, step: 1, help: "Colour-jitter seed (STORED, deterministic — same seed, same jitter every render)." },
  ],
  render: renderTextureBrush,
  // ── UI contracts (read by PaintField's Mat mode; both node-safe data) ───────
  // PRESET-TYPE PATTERN: picking a non-neutral value on the `preset` select
  // EXPANDS to the continuous knobs (applyPreset) and resets the select to
  // `custom`, so the user tweaks real values afterward. render() ALSO applies a
  // stored preset (a hand-authored doc with preset:"sumiInk" renders right), but
  // the UI writes expanded knobs so the Inspector never shows values the render
  // is silently overriding.
  presetExpand: { knob: "preset", neutral: "custom", expand: applyPreset },
  // The named select knob is picked from a THUMBNAIL PALETTE (web/BrushPalette)
  // rather than only the dropdown row.
  texturePalette: "texture",
};
