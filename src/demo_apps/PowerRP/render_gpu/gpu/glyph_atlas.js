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
 * Stateful service object (owns the atlas canvas + GPU texture + packing
 * cursor). Not pure. Browser-only (needs document.createElement("canvas")).
 */

/** Atlas texture is one fixed page. When it fills, the compositor evicts the
 * whole generation (reset()) and rebuilds the frame — see render()'s
 * rebuild-once policy. Well under device.limits.maxTextureDimension2D
 * (spec minimum 8192). */
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

/** The font stack the canvas plugins use — keep identical for visual parity. */
export function fontString(sizePx, bold) {
  return `${bold ? "bold " : ""}${sizePx}px system-ui, sans-serif`;
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
    this.entries = new Map(); // "char|bucket|bold" → {u0, v0, du, dv, cellW, cellH, advance, ascent, pad}
    this.metrics = new Map(); // "char|bucket|bold" → measure-only metrics (never evicted — no atlas space)
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfH = 0;
    this.dirty = false;
  }

  /**
   * Query (memoizes; touches ctx.font). Glyph metrics at a size bucket
   * WITHOUT rasterizing or allocating atlas space. The compositor culls
   * offscreen glyphs on these — advances must accrue even for glyphs that
   * never draw, so measuring must never grow the atlas.
   */
  measure(ch, bucket, bold) {
    const key = `${ch}|${bucket}|${bold ? 1 : 0}`;
    const entry = this.entries.get(key); // a rasterized entry carries the same metrics
    if (entry) return entry;
    let m = this.metrics.get(key);
    if (!m) {
      this.ctx.font = fontString(bucket, bold);
      const t = this.ctx.measureText(ch);
      m = {
        cellW: Math.ceil(Math.max(t.width, 1)) + CELL_PAD * 2,
        cellH: Math.ceil(t.fontBoundingBoxAscent + t.fontBoundingBoxDescent) + CELL_PAD * 2,
        advance: t.width,
        ascent: t.fontBoundingBoxAscent,
        pad: CELL_PAD,
      };
      this.metrics.set(key, m);
    }
    return m;
  }

  /**
   * Command (may rasterize into the atlas canvas; marks dirty). Returns the
   * atlas entry for a glyph at a size bucket. Throws a marked error
   * (err.atlasPageFull) when the page is full — the compositor's render()
   * evicts the generation and rebuilds the frame ONCE on that marker; a
   * frame that still overflows genuinely exceeds one page and fails loudly.
   */
  get(ch, bucket, bold) {
    const key = `${ch}|${bucket}|${bold ? 1 : 0}`;
    const hit = this.entries.get(key);
    if (hit) return hit;

    const m = this.measure(ch, bucket, bold);
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
    ctx.font = fontString(bucket, bold); // measure() may have hit its cache — set the font for fillText
    ctx.fillStyle = "#ffffff"; // white mask — the shader tints
    ctx.textBaseline = "alphabetic";
    ctx.fillText(ch, x + CELL_PAD, y + CELL_PAD + m.ascent);

    const entry = {
      u0: x / ATLAS_SIZE, v0: y / ATLAS_SIZE,
      du: m.cellW / ATLAS_SIZE, dv: m.cellH / ATLAS_SIZE,
      cellW: m.cellW, cellH: m.cellH,
      advance: m.advance,
      ascent: m.ascent,
      pad: CELL_PAD,
    };
    this.entries.set(key, entry);
    this.dirty = true;
    return entry;
  }

  /**
   * Command. Evicts the whole generation: clears the page, the entry table,
   * and the packing cursor (shelf packing can't free single cells, so a full
   * page evicts EVERYTHING). Font metrics survive — they occupy no atlas
   * space. Reporting is the CALLER's job (compositor.render() warns loudly);
   * this class stays policy-free.
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
