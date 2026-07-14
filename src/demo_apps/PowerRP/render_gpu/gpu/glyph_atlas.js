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
 * The cost: glyphs scale up to ~19% between buckets (slight softness mid-zoom),
 * no kerning/complex shaping, and the atlas can fill up. MSDF or glyph-path
 * tessellation fix crispness-at-any-zoom later without touching the IR — the
 * text command stays a text run either way.
 *
 * Stateful service object (owns the atlas canvas + GPU texture + packing
 * cursor). Not pure. Browser-only (needs document.createElement("canvas")).
 */

/** Atlas texture is one fixed page; loud error when full (prototype bound). */
const ATLAS_SIZE = 2048;
/** Empty px around each glyph cell so linear sampling never bleeds neighbors. */
const CELL_PAD = 2;
/** Device-px font-size bucket bounds — below 4px text is invisible, above 256px a glyph would eat the atlas. */
const MIN_BUCKET = 4;
const MAX_BUCKET = 256;

/**
 * Pure function. Quantizes a device font size to a half-octave bucket, so a
 * continuous zoom hits a small, reusable set of rasterized sizes (scale error
 * ≤ 2^(1/4) ≈ 19% before the next bucket takes over).
 *
 * @example bucketFor(36) // 38.0546...
 * @example bucketFor(37) // 38.0546... (same bucket — that's the point)
 * @example bucketFor(1) // 4 (clamped to MIN_BUCKET)
 */
export function bucketFor(devicePx) {
  const clamped = Math.min(Math.max(devicePx, MIN_BUCKET), MAX_BUCKET);
  const HALF_OCTAVE = 2; // buckets at 2^(k/2)
  return Math.pow(2, Math.round(Math.log2(clamped) * HALF_OCTAVE) / HALF_OCTAVE);
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
    this.entries = new Map(); // "char|bucket|bold" → {u0, v0, du, dv, cellW, cellH, advance, ascent}
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfH = 0;
    this.dirty = false;
  }

  /**
   * Command (may rasterize into the atlas canvas; marks dirty). Returns the
   * atlas entry for a glyph at a size bucket. Throws when the atlas page is
   * full — the prototype's documented bound (production: multi-page/LRU).
   */
  get(ch, bucket, bold) {
    const key = `${ch}|${bucket}|${bold ? 1 : 0}`;
    const hit = this.entries.get(key);
    if (hit) return hit;

    const ctx = this.ctx;
    ctx.font = fontString(bucket, bold);
    const m = ctx.measureText(ch);
    const ascent = m.fontBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent;
    const cellW = Math.ceil(Math.max(m.width, 1)) + CELL_PAD * 2;
    const cellH = Math.ceil(ascent + descent) + CELL_PAD * 2;

    if (this.shelfX + cellW > ATLAS_SIZE) {
      this.shelfX = 0;
      this.shelfY += this.shelfH;
      this.shelfH = 0;
    }
    if (this.shelfY + cellH > ATLAS_SIZE)
      throw new Error(`GlyphAtlas: ${ATLAS_SIZE}px atlas page full (${this.entries.size} glyphs cached)`);
    const x = this.shelfX, y = this.shelfY;
    this.shelfX += cellW;
    this.shelfH = Math.max(this.shelfH, cellH);

    ctx.fillStyle = "#ffffff"; // white mask — the shader tints
    ctx.textBaseline = "alphabetic";
    ctx.fillText(ch, x + CELL_PAD, y + CELL_PAD + ascent);

    const entry = {
      u0: x / ATLAS_SIZE, v0: y / ATLAS_SIZE,
      du: cellW / ATLAS_SIZE, dv: cellH / ATLAS_SIZE,
      cellW, cellH,
      advance: m.width,
      pad: CELL_PAD,
    };
    this.entries.set(key, entry);
    this.dirty = true;
    return entry;
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
