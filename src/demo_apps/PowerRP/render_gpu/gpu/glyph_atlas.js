/**
 * Glyph atlas: canvas2D-rasterized glyph textures for the WebGPU text
 * pipeline.
 *
 * THE TEXT DECISION (documented tradeoff, see FINDINGS.md for alternatives):
 * glyphs are rasterized white-on-transparent by an offscreen canvas2D context
 * at QUANTIZED device sizes (half-octave buckets) into one shelf-packed atlas
 * texture; text draws as one instanced quad per glyph, tinted in the shader.
 * This is the pragmatic choice: canvas2D gives us platform font rasterization,
 * shaping-free layout via measureText advances, and zero font-file plumbing.
 * The cost: small text MINIFIES up to √2 between lattice buckets (ceil —
 * never magnified); LARGE text (≥ EXACT_RASTER_MIN device px) rasterizes at
 * its exact display size, 1:1 native-crisp. No kerning/complex shaping,
 * and a full page evicts a whole generation (loud rebuild-once policy in the
 * compositor). MSDF or glyph-path tessellation fix crispness-at-ANY-zoom
 * later without touching the IR — the text command stays a text run either
 * way (Tier-2 assessment in the manifest).
 *
 * COLOR GLYPHS (emoji): "white-on-transparent tinted in the shader" only
 * holds for MONOCHROME glyphs. A color glyph (emoji, or any font whose
 * COLR/CBDT table substitutes its own artwork) ignores fillStyle entirely —
 * rasterizing it "white" paints its real colors, and the shader's
 * multiply-by-text-color tint would then corrupt those colors (the "emoji
 * render black" bug: white glyphs get multiplied by a black-ish text color).
 * isColorGlyph() classifies each glyph by RASTERIZING IT TWICE (fillStyle
 * black vs white) and comparing the pixels — see its docstring for why this
 * beats a Unicode-range heuristic. Color glyphs still rasterize into the SAME
 * atlas page (their true-color pixels, not a mask); the entry records
 * `color: true` so the compositor selects TEX_MODE.colorGlyph (sample as-is,
 * opacity-only) instead of TEX_MODE.glyph (tint by color × alpha mask).
 *
 * Stateful service object (owns the atlas canvas + GPU texture + packing
 * cursor). Not pure. Browser-only (needs document.createElement("canvas")).
 */

import { cssFamilyFor, DEFAULT_FONT } from "../fonts.js";

/** Atlas texture is one fixed page. When it fills, the compositor evicts the
 * whole generation (reset()) and rebuilds the frame — see render()'s
 * rebuild-once policy. Well under device.limits.maxTextureDimension2D
 * (spec minimum 8192). The per-run FONT id is part of each cell's key, so a
 * document mixing F fonts holds up to F× the distinct glyphs of a single-font
 * doc — but per-glyph culling still bounds what a FRAME rasterizes (only
 * on-screen glyphs of the fonts actually visible), and the same
 * generation-eviction path absorbs any genuine overflow, so no new capacity
 * machinery is needed for multi-font pages. */
const ATLAS_SIZE = 2048;
/** Empty px around each glyph cell so linear sampling never bleeds neighbors. */
const CELL_PAD = 2;
/** Device-px font-size bucket bounds. MIN: below 4px text is invisible.
 * MAX derivation (page capacity, the real bound): at bucket B a glyph cell is
 * ≈ (0.4..1.1)·B + 2·pad wide × ≈1.2·B + 2·pad tall. At B ≈ 724 (2^9.5) one
 * 2048² page holds ~10 distinct glyphs (2 shelves × ~5) — more than a
 * viewport can DISPLAY at that size (the compositor's per-glyph culling
 * guarantees only VISIBLE glyphs rasterize; a 1440px-wide view shows ~4-6
 * glyphs of 724px). ~860+ (cell ~1040 tall) drops capacity to ONE shelf ≈ 4
 * cells — at the edge of what a frame shows, risking eviction thrash. Beyond
 * MAX the quad upscales gradually (softness ∝ devicePx/MAX);
 * unbounded-zoom crispness is the MSDF tier's job. */
const MIN_BUCKET = 4;
const MAX_BUCKET = 724; // ≈ 2^9.5 — see the capacity derivation above
/** Above this device size, buckets are EXACT (the display size itself,
 * rounded to 0.1px to bound cache-key churn): the quad draws its raster at
 * scale 1.0 — native crispness, no resampling. Affordable because per-glyph
 * culling bounds the on-screen glyph count at large sizes (a 1440px view
 * shows ≤ ~22 glyphs of 128px; page capacity at 128 is ~350 cells) — whereas
 * at SMALL sizes whole documents of text are visible at once, so those keep
 * the shared half-octave lattice (a zoom gesture reuses a handful of buckets
 * instead of re-rasterizing every glyph every frame). Measured: lattice
 * minification leaves text ~1.2-1.4× softer than native at deep zoom;
 * exact-size rasters are the platform rasterizer's output verbatim. */
export const EXACT_RASTER_MIN = 128;

/**
 * Pure function. The rasterization size for a displayed device font size.
 * Two regimes:
 *   - devicePx < EXACT_RASTER_MIN: half-octave lattice bucket (2^(k/2)),
 *     CEILed — the glyph rasterizes AT OR ABOVE display size so quads only
 *     ever MINIFY (scale ∈ [0.707, 1]; magnification is what reads as
 *     pixelation). A continuous zoom reuses a small set of buckets.
 *   - devicePx ≥ EXACT_RASTER_MIN: EXACT size (0.1px-rounded) — scale-1.0
 *     quads, as crisp as the platform rasterizer output (the deep-zoom fix;
 *     the compositor additionally integer-snaps unrotated exact quads so
 *     bilinear sampling never sees a fractional offset).
 * Everything clamps to [MIN_BUCKET, MAX_BUCKET] (page-capacity bound).
 *
 * @example bucketFor(36) // 45.254833995939045 (2^5.5 — small-text lattice, next half-octave up)
 * @example bucketFor(37) // 45.254833995939045 (same bucket — that's the point)
 * @example bucketFor(32) // 32 (exact lattice sizes stay put)
 * @example bucketFor(288.44) // 288.4 (exact-raster regime: the display size itself)
 * @example bucketFor(1) // 4 (clamped to MIN_BUCKET)
 * @example bucketFor(9999) // 724 (clamped to MAX_BUCKET — page capacity)
 */
export function bucketFor(devicePx) {
  const clamped = Math.min(Math.max(devicePx, MIN_BUCKET), MAX_BUCKET);
  if (clamped >= EXACT_RASTER_MIN) return Math.round(clamped * 10) / 10;
  const HALF_OCTAVE = 2; // buckets at 2^(k/2)
  return Math.pow(2, Math.ceil(Math.log2(clamped) * HALF_OCTAVE) / HALF_OCTAVE);
}

/**
 * Pure function. The atlas cache-key fragment for a glyph OUTLINE spec (Round
 * 13.4). null (no outline) → "" so a non-outlined cell keeps its historical key
 * exactly (byte-identical to pre-outline behavior — no cache churn for the
 * common case). An outline is keyed by its baked fill color, stroke color, and
 * device-px width (rounded to 0.1px to bound key churn) since all three are
 * rasterized INTO the cell.
 *
 * @example outlineKey(null) // ""
 * @example outlineKey({fill: "#000000", color: "#ff0000", width: 3}) // "o#000000|#ff0000|3"
 * @example outlineKey({fill: "#000000", color: "#ff0000", width: 3.04}) // "o#000000|#ff0000|3"
 */
export function outlineKey(outline) {
  if (!outline) return "";
  return `o${outline.fill}|${outline.color}|${Math.round(outline.width * 10) / 10}`;
}

/**
 * Pure function. The canvas2D `ctx.font` string for a (size, bold, fontId,
 * italic) — the SINGLE SEAM that decides which face rasterizes. `fontId` selects
 * a committed family from the registry (fonts.js); the default is the OS system
 * stack, so old callers (and the `system` font) get the pre-fonts-task behavior
 * verbatim. ITALIC is synthesized here (manifest RICH TEXT: "ITALIC synthesis"):
 * a `italic` prefix makes canvas2D use the face's real italic if it has one, or
 * an oblique synthesized by the rasterizer otherwise — a TRUE oblique glyph
 * shape (chosen over a per-quad shear because it produces proper italic forms
 * for faces that have them, and needs no shader change). The chosen face must
 * already be LOADED (web/fontLoader.js) or canvas2D silently substitutes — the
 * compositor awaits font readiness before drawing.
 *
 * @example fontString(36, false) // "36px system-ui, sans-serif"
 * @example fontString(36, true) // "bold 36px system-ui, sans-serif"
 * @example fontString(36, false, "inter") // "36px \"PowerRP Inter\", sans-serif"
 * @example fontString(36, true, "jetbrains-mono") // "bold 36px \"PowerRP JetBrains Mono\", monospace"
 * @example fontString(36, false, "inter", true) // "italic 36px \"PowerRP Inter\", sans-serif"
 * @example fontString(36, true, "lora", true) // "italic bold 36px \"PowerRP Lora\", serif"
 */
export function fontString(sizePx, bold, fontId = DEFAULT_FONT, italic = false) {
  return `${italic ? "italic " : ""}${bold ? "bold " : ""}${sizePx}px ${cssFamilyFor(fontId)}`;
}

/** Probe raster size for the color-glyph classifier (device px, in the
 * scratch canvas — unrelated to any display bucket). Small enough to be
 * cheap per glyph, large enough that emoji artwork actually paints (a few
 * device px can round color detail away). Not a precedent-linked constant —
 * it only needs to be "big enough to rasterize, small enough to be cheap";
 * flagged PENDING RATIFICATION alongside the atlas's other capacity numbers. */
const COLOR_PROBE_PX = 32;

/**
 * Pure function (given a 2D context whose canvas is at least COLOR_PROBE_PX
 * square — the classifier only reads back RGBA bytes, never allocates or
 * mutates canvas STATE beyond what the caller's ctx already has). Detects
 * whether a glyph supplies its OWN color (an emoji / color-font glyph) as
 * opposed to a monochrome glyph that a shader can tint.
 *
 * METHOD: rasterize the glyph twice into the probe canvas — once with
 * fillStyle black, once with fillStyle white — and compare the resulting
 * RGBA byte buffers. A monochrome glyph is an ALPHA MASK: canvas2D paints
 * exactly `fillStyle` at every covered pixel, so the black and white passes
 * differ at every non-transparent pixel (0,0,0,a) vs (255,255,255,a) — by
 * construction, a mask's white and black rasterizations are always exact
 * bytewise inverses of RGB wherever alpha > 0. A COLOR glyph (emoji) ignores
 * fillStyle entirely — the platform substitutes its own bitmap/COLR artwork
 * — so both passes come out IDENTICAL. This is why comparing two fill colors
 * beats any unicode-range heuristic: it directly tests the actual behavior
 * (does fillStyle affect the pixels?) rather than guessing from a codepoint,
 * so it is correct for variation-selector emoji, future Unicode emoji, and
 * any OS/browser color-font quirk without a maintained range table.
 *
 * Args:
 *   ctx (CanvasRenderingContext2D): scratch context, already sized to at
 *     least COLOR_PROBE_PX square; caller sets ctx.font before calling.
 *   ch (string): the glyph's text run (may be a multi-codepoint grapheme,
 *     e.g. an emoji + variation selector — canvas2D shapes it as one glyph).
 *
 * Returns:
 *   boolean: true if the glyph is a color glyph (bypass tint), false if it
 *   is a monochrome mask (tint as today).
 *
 * Examples:
 *   >>> # isColorGlyph(ctx, "A") with ctx.font = "32px sans-serif" -> false
 *   >>> # isColorGlyph(ctx, "\u{1F7E5}") (🟥) with an emoji-capable font -> true
 */
export function isColorGlyph(ctx, ch) {
  const n = COLOR_PROBE_PX;
  ctx.clearRect(0, 0, n, n);
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000000";
  ctx.fillText(ch, 0, 0);
  const black = ctx.getImageData(0, 0, n, n).data;
  ctx.clearRect(0, 0, n, n);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(ch, 0, 0);
  const white = ctx.getImageData(0, 0, n, n).data;
  ctx.clearRect(0, 0, n, n); // leave the scratch context clean for the next caller
  let sawCoverage = false;
  for (let i = 0; i < black.length; i += 4) {
    if (black[i + 3] === 0 && white[i + 3] === 0) continue; // both transparent — uninked, skip
    sawCoverage = true;
    // A MONOCHROME mask paints exactly fillStyle at every covered pixel, so
    // black vs white DIFFER here (0,0,0,a) vs (255,255,255,a); a COLOR glyph
    // ignores fillStyle, so its RGB is IDENTICAL between the two passes. A
    // pixel that differs is proof of a mask — bail out false immediately.
    if (black[i] !== white[i] || black[i + 1] !== white[i + 1] || black[i + 2] !== white[i + 2]) return false;
  }
  // No inked pixel ever differed between the two fills: either every covered
  // pixel ignored fillStyle (a color glyph) or nothing rasterized at all (an
  // unsupported/whitespace glyph — harmless to call it "color": get() then
  // rasterizes it plain, and an empty glyph draws nothing regardless of mode).
  return sawCoverage;
}

export class GlyphAtlas {
  /**
   * Command (allocates GPU texture + canvas).
   *
   * Args:
   *   device (GPUDevice)
   */
  constructor(device) {
    this.device = device;
    this.canvas = document.createElement("canvas");
    this.canvas.width = ATLAS_SIZE;
    this.canvas.height = ATLAS_SIZE;
    this.ctx = this.canvas.getContext("2d");
    this.texture = device.createTexture({
      label: "glyph-atlas",
      size: [ATLAS_SIZE, ATLAS_SIZE],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.entries = new Map(); // "char|bucket|bold|font|italic" → {u0, v0, du, dv, cellW, cellH, advance, ascent, pad, color}
    this.metrics = new Map(); // "char|bucket|bold|font|italic" → measure-only metrics (never evicted — no atlas space)
    // Color-glyph verdicts: keyed "char|font" ONLY (bold/bucket-independent —
    // whether a glyph ignores fillStyle is a font-substitution fact, not a
    // size fact, so buckets/bold weights of the same glyph share one verdict).
    // Matches the `metrics` map's documented no-eviction caveat: verdicts cost
    // no atlas space and survive generation resets (see reset()).
    this.colorVerdicts = new Map();
    // Scratch context for isColorGlyph's probe rasterizations — SEPARATE from
    // this.ctx (the atlas page): probing must never clearRect/paint over
    // already-packed shelf cells.
    this._probeCanvas = document.createElement("canvas");
    this._probeCanvas.width = this._probeCanvas.height = COLOR_PROBE_PX;
    this._probeCtx = this._probeCanvas.getContext("2d", { willReadFrequently: true });
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfH = 0;
    this.dirty = false;
  }

  /**
   * Query (memoizes on char|font|italic — see colorVerdicts). Is this glyph a
   * color glyph (emoji / color-font artwork) that must bypass the shader's
   * tint? (italic-independent in practice, but keyed with it so a synthesized-
   * oblique color glyph is still classified once per style.)
   */
  isColor(ch, bold, font = DEFAULT_FONT, italic = false) {
    const key = `${ch}|${font}|${italic ? 1 : 0}`;
    let verdict = this.colorVerdicts.get(key);
    if (verdict === undefined) {
      this._probeCtx.font = fontString(COLOR_PROBE_PX, bold, font, italic);
      verdict = isColorGlyph(this._probeCtx, ch);
      this.colorVerdicts.set(key, verdict);
    }
    return verdict;
  }

  /**
   * Query (memoizes; touches ctx.font). Glyph metrics at a size bucket
   * WITHOUT rasterizing or allocating atlas space. The compositor culls
   * offscreen glyphs on these — advances must accrue even for glyphs that
   * never draw, so measuring must never grow the atlas.
   */
  measure(ch, bucket, bold, font = DEFAULT_FONT, italic = false, outline = null) {
    // outline = {color, width} where width is in BUCKET (device) px, or null for
    // no outline (Round 13.4). An outlined cell needs EXTRA padding: the stroke
    // extends half its width beyond the glyph ink on every side, so CELL_PAD=2
    // alone would clip a wider stroke. pad grows to CELL_PAD + ceil(width/2).
    const okey = outlineKey(outline);
    const key = `${ch}|${bucket}|${bold ? 1 : 0}|${font}|${italic ? 1 : 0}|${okey}`;
    const entry = this.entries.get(key); // a rasterized entry carries the same metrics
    if (entry) return entry;
    let m = this.metrics.get(key);
    if (!m) {
      this.ctx.font = fontString(bucket, bold, font, italic);
      const t = this.ctx.measureText(ch);
      const pad = outline ? CELL_PAD + Math.ceil(outline.width / 2) : CELL_PAD;
      m = {
        cellW: Math.ceil(Math.max(t.width, 1)) + pad * 2,
        cellH: Math.ceil(t.fontBoundingBoxAscent + t.fontBoundingBoxDescent) + pad * 2,
        advance: t.width,
        ascent: t.fontBoundingBoxAscent,
        pad,
      };
      this.metrics.set(key, m);
    }
    return m;
  }

  /**
   * Query (touches ctx.font). Whole-string metrics at a run's NOMINAL size (not
   * a device bucket): the seam the shared rich-text layout uses to measure run
   * advances DOM-free-ly through the atlas's canvas. Returns local-unit
   * {width, ascent, descent} so layoutRichText can wrap + align + baseline-
   * align. Distinct from measure() (per-glyph, at a device bucket, for culling):
   * this is a per-RUN measure at the true size the backend will draw.
   */
  measureText(str, size, bold, font = DEFAULT_FONT, italic = false) {
    this.ctx.font = fontString(size, bold, font, italic);
    const t = this.ctx.measureText(str);
    return { width: t.width, ascent: t.fontBoundingBoxAscent, descent: t.fontBoundingBoxDescent };
  }

  /**
   * Command (may rasterize into the atlas canvas; marks dirty). Returns the
   * atlas entry for a glyph at a size bucket. Throws a marked error
   * (err.atlasPageFull) when the page is full — the compositor's render()
   * evicts the generation and rebuilds the frame ONCE on that marker; a
   * frame that still overflows genuinely exceeds one page and fails loudly.
   */
  get(ch, bucket, bold, font = DEFAULT_FONT, italic = false, outline = null) {
    const okey = outlineKey(outline);
    const key = `${ch}|${bucket}|${bold ? 1 : 0}|${font}|${italic ? 1 : 0}|${okey}`;
    const hit = this.entries.get(key);
    if (hit) return hit;

    const m = this.measure(ch, bucket, bold, font, italic, outline);
    if (this.shelfX + m.cellW > ATLAS_SIZE) {
      this.shelfX = 0;
      this.shelfY += this.shelfH;
      this.shelfH = 0;
    }
    if (this.shelfY + m.cellH > ATLAS_SIZE) {
      const err = new Error(`glyph atlas page full (${this.entries.size} glyphs cached, ${ATLAS_SIZE}px page)`);
      err.atlasPageFull = true; // the compositor evicts + rebuilds once on this marker
      throw err;
    }
    const x = this.shelfX, y = this.shelfY;
    this.shelfX += m.cellW;
    this.shelfH = Math.max(this.shelfH, m.cellH);

    const ctx = this.ctx;
    ctx.font = fontString(bucket, bold, font, italic); // measure() may have hit its cache — set the font for fillText
    ctx.textBaseline = "alphabetic";
    const px = x + m.pad, py = y + m.pad + m.ascent; // baseline origin (pad-aware)
    let color;
    if (outline) {
      // OUTLINED cell (Round 13.4): stroke the glyph contour in the outline
      // color, then fill it in the run color — a REAL RGBA cell (not a mask),
      // so the compositor draws it via TEX_MODE.colorGlyph (no shader tint;
      // e.color=true routes there). The outline is BEHIND the fill (stroke
      // first, then fill on top) so the letter body stays crisp — the
      // paint-order="stroke" idiom, done in the rasterizer. lineJoin "round"
      // keeps sharp corners from spiking. The RUN color is baked here because
      // an outlined cell can't be shader-tinted; the cell is keyed by the run's
      // full outline spec so distinct (color, outlineColor, width) get distinct
      // cells — outlines are a rare per-run style, per the atlas capacity note.
      ctx.lineWidth = outline.width;
      ctx.lineJoin = "round";
      ctx.strokeStyle = outline.color;
      ctx.strokeText(ch, px, py);
      ctx.fillStyle = outline.fill;
      ctx.fillText(ch, px, py);
      color = true; // baked RGBA → bypass the shader tint
    } else {
      // Monochrome glyphs rasterize as a WHITE ALPHA MASK (the shader tints by
      // the text color). Color glyphs (emoji) ignore fillStyle and paint their
      // own artwork regardless — fillStyle is left at whatever it already is,
      // purely so the source is deterministic across atlas rebuilds.
      color = this.isColor(ch, bold, font, italic);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(ch, px, py);
    }

    const entry = {
      u0: x / ATLAS_SIZE, v0: y / ATLAS_SIZE,
      du: m.cellW / ATLAS_SIZE, dv: m.cellH / ATLAS_SIZE,
      cellW: m.cellW, cellH: m.cellH,
      advance: m.advance,
      ascent: m.ascent,
      pad: m.pad,
      color, // true = COLOR glyph OR outlined cell (bypass shader tint); false = alpha mask
    };
    this.entries.set(key, entry);
    this.dirty = true;
    return entry;
  }

  /**
   * Command. Evicts the whole generation: clears the page, the entry table,
   * and the packing cursor (shelf packing can't free single cells, so a full
   * page evicts EVERYTHING). Font metrics AND color-glyph verdicts survive —
   * neither occupies atlas space. Reporting is the CALLER's job
   * (compositor.render() warns loudly); this class stays policy-free.
   */
  reset() {
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    this.entries.clear();
    this.shelfX = this.shelfY = this.shelfH = 0;
    this.dirty = true; // the cleared page must reach the GPU even if nothing re-rasterizes
  }

  /**
   * Command (GPU upload). Pushes the atlas canvas to the GPU texture if any
   * glyph was added since the last flush. Whole-page upload — simple and
   * plenty fast for a prototype (2048² ≈ 16 MB, only on new-glyph frames).
   */
  flush() {
    if (!this.dirty) return;
    this.device.queue.copyExternalImageToTexture(
      { source: this.canvas },
      { texture: this.texture, premultipliedAlpha: true },
      [ATLAS_SIZE, ATLAS_SIZE],
    );
    this.dirty = false;
  }
}
