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
 *    points with their tangent + left normal.
 * 2. At each sample, offset ±half-thickness along the normal to get an INNER and
 *    an OUTER rail; the half-thickness TAPERS from `sizeStart` to `sizeEnd` down
 *    the stroke (× strokeWidth) with an optional sinusoidal `wobble` — the demo's
 *    size-start/size-end sliders + brushy wobble.
 * 3. Fill `ROWS` vertex rows across the thickness between the rails. U runs along
 *    the arc (0→1, mapped to the texture's WIDTH in px), V across the thickness
 *    (0→1, mapped to the texture's HEIGHT) — the Skia vertices UV contract (image
 *    PIXELS), exactly as render_gpu/skia/paint_skia.js drawPaperCurl scales its
 *    mesh uvs by iw/ih.
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
import { parseColor } from "../ir.js";
import { getSkiaImage } from "../gpu/image_registry.js";
import { BRUSH_TEXTURES, textureIds, getTexture, textureUrl, firstTextureOf } from "./brush_textures/manifest.js";

// ── constants (WHY each exists — no magic numbers) ────────────────────────────
const MESH_VERTEX_CAP = 1 << 16;   // Skia MakeVertices uses 16-bit indices → ≤ 2^16 vertices (rp discovered this empirically)
const RIBBON_ROWS = 6;             // vertex rows across the thickness; >2 lets a curved thick ribbon bend the texture smoothly, cheap
const RIBBON_SAMPLE_SPACING = 2.5; // local px per arc sample at spacing=1 — the stroke_materials ribbon spacing, fine enough that a wobble never aliases
const MIN_RIBBON_SAMPLES = 2;      // a degenerate-short contour still gets a 2-sample ribbon
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
 * Pure function. The LEFT unit normal of tangent (tx, ty) — a 90° CCW rotation,
 * normalized; a degenerate zero tangent returns [0, 0] rather than NaN. Offsets a
 * ribbon sample to its inner/outer rail.
 *
 * @example leftNormalTB(1, 0) // [0, 1]
 * @example leftNormalTB(0, 2) // [-1, 0]
 * @example leftNormalTB(0, 0) // [0, 0]
 */
export function leftNormalTB(tx, ty) {
  const len = Math.hypot(tx, ty);
  if (!(len > 0)) return [0, 0];
  return [-ty / len, tx / len];
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
 * Pure builder (allocates typed arrays; deterministic in its inputs). Builds the
 * ribbon's flat vertex arrays from arc SAMPLES. Each sample is {x, y, nx, ny, u,
 * half} — a path point, its left normal, its arc fraction, and its half-thickness.
 * For each sample, `rows` vertices are laid from the inner rail (V=0) to the outer
 * rail (V=1); U = sample.u·imgW, V = rowFrac·imgH (image pixels — the Skia
 * vertices UV contract). Quads are emitted in ARC ORDER so later-arc triangles
 * paint on TOP (correct self-intersection, rp's triangle-ordering fix).
 *
 * @param {Array<{x:number,y:number,nx:number,ny:number,u:number,half:number}>} samples
 * @param {number} rows - vertex rows across the thickness (≥ 2)
 * @param {number} imgW - texture width (px) — U scale
 * @param {number} imgH - texture height (px) — V scale
 * @param {Uint32Array} colors - one packed 0xAARRGGBB colour PER SAMPLE
 * @returns {{positions:Float32Array, uvs:Float32Array, vertColors:Uint32Array, indices:Uint16Array}}
 *
 * @example // two samples, two rows → 4 vertices, 1 quad = 2 triangles = 6 indices
 * @example ribbonVertices([{x:0,y:0,nx:0,ny:1,u:0,half:5},{x:10,y:0,nx:0,ny:1,u:1,half:5}], 2, 64, 16, Uint32Array.from([4294967295,4294967295])).positions.length // 8
 * @example ribbonVertices([{x:0,y:0,nx:0,ny:1,u:0,half:5},{x:10,y:0,nx:0,ny:1,u:1,half:5}], 2, 64, 16, Uint32Array.from([4294967295,4294967295])).indices.length // 6
 * @example ribbonVertices([{x:0,y:0,nx:0,ny:1,u:0,half:5},{x:10,y:0,nx:0,ny:1,u:1,half:5}], 2, 64, 16, Uint32Array.from([4294967295,4294967295])).positions[1] // -5
 */
export function ribbonVertices(samples, rows, imgW, imgH, colors) {
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
      uvs[2 * v] = s.u * imgW;
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

// ── real-world presets (researched: Procreate / Illustrator / Krita) ──────────
// Each preset picks a texture CATEGORY (resolved to a concrete id at apply time,
// so a preset survives a palette recuration) and writes the continuous knobs. The
// "preset-type pattern" (manifest G.23): the UI writes these knobs on select then
// reverts `preset` to "custom" for further editing; render() applies them when
// `preset` is not "custom" (so the probe and a freshly-picked preset both render
// their look). Values from the real brushes each emulates.

const PRESETS = {
  sumiInk: { title: "Sumi-e Ink", category: "ink", texture: "oil_crimson_bristle", sizeStart: 1.2, sizeEnd: 0.1, wobble: 0.15, wobbleFreq: 3, jitterAmount: 0.05, jitterColor: "#000000", blend: "multiply" },
  technicalPen: { title: "Technical Pen", category: "ink", texture: "oil_scarlet_hook", sizeStart: 1, sizeEnd: 1, wobble: 0, wobbleFreq: 3, jitterAmount: 0, jitterColor: "#000000", blend: "normal" },
  studioPen: { title: "Studio Pen", category: "ink", texture: "oil_crimson_bristle", sizeStart: 1, sizeEnd: 0.85, wobble: 0.02, wobbleFreq: 3, jitterAmount: 0, jitterColor: "#000000", blend: "normal" },
  calligraphyFlat: { title: "Calligraphy Flat", category: "marker", texture: "oil_cobalt_flat", sizeStart: 1.5, sizeEnd: 0.3, wobble: 0.05, wobbleFreq: 2, jitterAmount: 0.02, jitterColor: "#101018", blend: "normal" },
  dryInk: { title: "Dry Ink Pen", category: "dry-brush", texture: "oil_olive_rake", sizeStart: 0.9, sizeEnd: 0.7, wobble: 0.1, wobbleFreq: 4, jitterAmount: 0.12, jitterColor: "#1a1a1a", blend: "multiply" },
  bristleDry: { title: "Bristle Dry Brush", category: "dry-brush", texture: "oil_forest_drag", sizeStart: 0.8, sizeEnd: 0.6, wobble: 0.2, wobbleFreq: 5, jitterAmount: 0.12, jitterColor: "#222018", blend: "multiply" },
  pencil6B: { title: "6B Pencil Sketch", category: "dry-brush", texture: "wc_dry_streak", sizeStart: 0.9, sizeEnd: 0.4, wobble: 0.15, wobbleFreq: 4, jitterAmount: 0.06, jitterColor: "#2a2a2a", blend: "multiply" },
  watercolorWash: { title: "Watercolor Wash", category: "watercolor", texture: "wc_coral_wash", sizeStart: 1.4, sizeEnd: 1.3, wobble: 0.25, wobbleFreq: 3, jitterAmount: 0.15, jitterColor: "#3a5a8a", blend: "multiply" },
  taperedGouache: { title: "Tapered Gouache", category: "gouache", texture: "oil_peach_smear", sizeStart: 1.1, sizeEnd: 0.5, wobble: 0.12, wobbleFreq: 3, jitterAmount: 0.08, jitterColor: "#8a6a3a", blend: "normal" },
  grungeMarker: { title: "Grunge Marker", category: "grunge", texture: "wc_umber_scrub", sizeStart: 1, sizeEnd: 0.95, wobble: 0.08, wobbleFreq: 4, jitterAmount: 0.3, jitterColor: "#201810", blend: "multiply" },
  spatterGrunge: { title: "Spatter Grunge", category: "grunge", texture: "wc_granular_umber", sizeStart: 1.2, sizeEnd: 1.1, wobble: 0.3, wobbleFreq: 6, jitterAmount: 0.4, jitterColor: "#151515", blend: "multiply" },
  wetGlazeMarker: { title: "Wet Glaze Marker", category: "marker", texture: "wc_blue_wash", sizeStart: 1.05, sizeEnd: 1, wobble: 0.03, wobbleFreq: 3, jitterAmount: 0.05, jitterColor: "#2a3a5a", blend: "multiply" },
};

/**
 * Query. The preset ids in UI order (the preset SELECT knob's options after
 * "custom").
 *
 * @example presetIds().includes("watercolorWash") // true
 * @example presetIds().length // 12
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
 * @example applyPreset({preset: "sumiInk"}).sizeEnd // 0.1
 * @example applyPreset({preset: "sumiInk"}).blend // "multiply"
 * @example applyPreset({preset: "sumiInk"}).texture // "oil_crimson_bristle"
 * @example applyPreset({preset: "technicalPen"}).wobble // 0
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

  const paint = new CanvasKit.Paint();
  paint.setAntiAlias(aa);
  paint.setBlendMode(blendModeEnum(CanvasKit, p.blend));
  // mipmap'd + bilinear (rp: mipmap=True, interp="bilinear") — clamp so the ribbon
  // never tiles its own texture at the ends.
  const shader = img.makeShaderOptions(
    CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp,
    CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.Linear,
  );
  paint.setShader(shader);

  let anyDecimated = false;
  const iter = new CanvasKit.ContourMeasureIter(path, false, 1);
  let contour;
  let segBase = 0; // global segment index so jitter decorrelates across contours
  while ((contour = iter.next())) {
    const L = contour.length();
    if (L > 0) {
      const { samples: n, decimated } = ribbonSampleBudget(L, spacing, RIBBON_ROWS);
      anyDecimated = anyDecimated || decimated;
      const samples = new Array(n);
      const colors = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const u = n > 1 ? i / (n - 1) : 0;
        const pt = contour.getPosTan(L * u);
        const nrm = leftNormalTB(pt[2], pt[3]);
        samples[i] = { x: pt[0], y: pt[1], nx: nrm[0], ny: nrm[1], u, half: taperHalfWidth(u, strokeWidth, p.sizeStart ?? 1, p.sizeEnd ?? 1, p.wobble ?? 0, p.wobbleFreq ?? 3) };
        colors[i] = segmentColor(tint, jitterColor, jitterFraction(p.jitterAmount ?? 0, seed, segBase + i), alphaByte);
      }
      const mesh = ribbonVertices(samples, RIBBON_ROWS, imgW, imgH, colors);
      const verts = CanvasKit.MakeVertices(CanvasKit.VertexMode.Triangles, mesh.positions, mesh.uvs, mesh.vertColors, mesh.indices, false);
      canvas.drawVertices(verts, CanvasKit.BlendMode.Modulate, paint);
      verts.delete();
      segBase += n;
    }
    contour.delete();
  }
  iter.delete();
  shader.delete();
  paint.delete();

  if (anyDecimated)
    reportOnce(
      `texbrush-decimated:${tex.id}`,
      `PowerRP texture brush "${tex.id}": a contour was long enough to exceed the ${MESH_VERTEX_CAP}-vertex Skia mesh cap ` +
      `and was DECIMATED to fit (rp's 2^16 workaround). Raise "spacing" for a longer smooth ribbon.`,
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
    { name: "spacing", kind: "number", default: 1, min: 0, scrub: 0.01, help: "Resample density along the ribbon (× the base spacing). <1 = smoother/denser; >1 = coarser. (Floored to a safe minimum step so the walk terminates — no arbitrary cap.)" },
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
};
