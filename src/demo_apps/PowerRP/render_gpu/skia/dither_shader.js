/**
 * THE deterministic whole-frame DITHER final-pass — the second live SkSL
 * RuntimeEffect in the tree (after glass_shader.js), and the single home for the
 * camera's `ditherMode` / `ditherEmphasis` render props (core/properties.js),
 * which until now NOTHING consumed.
 *
 * WHAT IT FIXES: an 8-bit surface can only hold 256 levels per channel, so a
 * smooth gradient / soft shadow / blurred glass / bloom falloff collapses into
 * visible stair-step BANDS at the quantization boundary. Adding a sub-LSB
 * ordered pattern before the 8-bit write scatters each pixel between the two
 * nearest levels, so the eye averages them back to the true value and the bands
 * dissolve into fine grain. This is a GENERAL surface post-pass (fixes banding
 * everywhere on the composited frame — gradients AND shadows/blur/glass/bloom),
 * not a gradient-only trick.
 *
 * WHERE IN THE PIPELINE — and WHY a higher-precision intermediate is MANDATORY:
 * dithering only de-bands if the sub-LSB pattern is added in MORE precision than
 * the 8-bit output, in the SAME step that quantizes. Adding noise to an ALREADY
 * 8-bit surface is a NO-OP — the fractional information is already gone, so
 * rounding an integer + a fraction < 0.5 lands back on the same integer. So the
 * SHARED helper renderWithDither() composites the whole scene into an RGBA16F
 * (half-float) offscreen surface FIRST — where the gradient / blur / shadow /
 * glass falloff stays smooth — then the dither RuntimeEffect adds the wobble on
 * the F16 -> 8-bit DOWNCONVERT (BlendMode.Src onto the real 8-bit sink). That
 * downconvert IS the quantization boundary. The F16 offscreen and the 8-bit sink
 * share ONE color space (SRGB), so the child image shader returns the sRGB-
 * ENCODED value unchanged (no transfer conversion) and one LSB == 1/255 in the
 * encoded space that quantizes — exactly right. All THREE raster sinks
 * (browser_surface, gpuService, node_render) route through renderWithDither, so
 * the pass is general (fixes banding everywhere), not per-sink.
 *
 * OFF == byte-identical to today: renderWithDither with mode "off" (or emphasis
 * <= 0) skips the F16 intermediate entirely and paints straight into the 8-bit
 * sink, so a default document pays nothing and renders exactly as before.
 *
 * DETERMINISTIC: the pattern is a pure function of the integer fragment
 * coordinate (bayer) plus a static precomputed texture (blueNoise) — never time,
 * never Math.random — so RenderTree = pure(document) is preserved: the same
 * document renders byte-identically every time. RASTER-ONLY: this touches the
 * pixel surface; the vector exporters (PDF / SVG) never call it and are untouched.
 *
 * REUSES the glass compile+cache pattern (paint_skia.js glassEffect): the
 * RuntimeEffect and the blue-noise Image are each built ONCE per CanvasKit
 * instance and memoized; a compile failure throws LOUDLY (no silent fallback).
 */

import { DITHER_MODES } from "../../core/properties.js";
import { decodeBlueNoise, BLUE_NOISE_SIZE } from "./blue_noise_64.js";

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
// The mode ids the SHADER branches on. Kept in lock-step with core/properties.js
// DITHER_MODES so the stored state, the property row, and the shader can never
// disagree; a startup assert (below) proves the mapping still matches.
const MODE_OFF = "off";
const MODE_BAYER = "bayer";
const MODE_BLUE_NOISE = "blueNoise";
// Shader-side numeric mode selector (float uniform — SkSL has no string type).
const MODE_CODE = { [MODE_BAYER]: 0, [MODE_BLUE_NOISE]: 1 };
// The ids this module knows how to render, asserted against the property registry
// so a new DITHER_MODES entry that the shader does not handle fails loudly here
// instead of silently rendering as a no-op.
const KNOWN_MODES = [MODE_OFF, MODE_BAYER, MODE_BLUE_NOISE];
if (DITHER_MODES.slice().sort().join(",") !== KNOWN_MODES.slice().sort().join(","))
  throw new Error(`dither_shader: DITHER_MODES ${JSON.stringify(DITHER_MODES)} != known ${JSON.stringify(KNOWN_MODES)} — a mode was added without shader support.`);

// Bayer expansion. RGBA_8888 = 4 bytes/texel; the noise asset stores 1 gray byte
// per texel, expanded to r=g=b=v, a=255 so a child image shader's .r is the
// threshold. FULL_ALPHA is the opaque alpha byte of that expansion.
const RGBA_STRIDE = 4;
const FULL_ALPHA = 255;

// The Bayer 8x8 ORDERED matrix, computed ANALYTICALLY in the shader (the classic
// recursive dispersed-dot construction, via floor/fract — SkSL RuntimeEffect
// forbids array-constructor literals, so no baked matrix). bayer2 is the 2x2 base
// cell; each recursion refines by a quarter-step. DITHER_BAYER_LEVELS = dim^2 is
// the count of distinct thresholds (8x8 == 64), used to center each cell.
const DITHER_BAYER_LEVELS = 64;

/**
 * THE dither SkSL. Children: `frame` (the composited surface snapshot, device
 * space) and `noise` (the tiled blue-noise texture). Output per pixel:
 *
 *   out.rgb = frame.rgb + (threshold - 0.5) * uEmphasis * LSB * frame.a
 *   out.a   = frame.a
 *
 * `threshold` in [0,1) comes from the analytic Bayer matrix (uMode 0) or the
 * blue-noise texel (uMode 1); centering by -0.5 makes it a zero-mean +/- half-
 * step wobble. LSB = 1/255 is one 8-bit level in normalized color, so uEmphasis
 * == 1 spreads a pixel across exactly the two nearest levels (peak-to-peak one
 * LSB). uEmphasis ABOVE 1 is fully supported — a grittier, louder grain (the
 * property's arbitrary max:1 in core/properties.js is another lane's to lift; the
 * shader itself does NOT clamp emphasis). Scaling the wobble by frame.a keeps a
 * premultiplied surface valid and leaves transparent pixels (a==0) untouched, so
 * the editor's transparent backdrop never gains colored noise.
 */
export const DITHER_SKSL = `
const float LSB = 1.0 / 255.0;               // one 8-bit level, in normalized [0,1] color
const float BAYER_HALF = 0.5 / ${DITHER_BAYER_LEVELS}.0; // half-cell offset (of 64 levels) → zero DC bias after centering
const float MODE_BLUE = ${MODE_CODE[MODE_BLUE_NOISE]}.0;

uniform shader frame;   // child 0: the composited frame (device space, sRGB-encoded)
uniform shader noise;   // child 1: the tiled blue-noise texel source (device space, Repeat)
uniform float uMode;    // 0 = bayer (ordered matrix), 1 = blueNoise (texture)
uniform float uEmphasis;// wobble amplitude multiplier (1 == +/- half an 8-bit level; may exceed 1)

// Pure. The 2x2 Bayer base cell as a fract-of-coordinate, values in {0,.25,.5,.75}.
float bayer2(float2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
// Pure. 4x4 and 8x8 ordered matrices by the standard quarter-step recursion.
float bayer4(float2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(float2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

half4 main(float2 fragCoord) {
  half4 c = frame.eval(fragCoord);
  // ordered Bayer threshold from the integer fragment coordinate; + half a cell
  // so the 64 levels straddle 0.5 with zero DC bias.
  float bayerT = bayer8(fragCoord) + BAYER_HALF;
  // blue-noise threshold: the Repeat-tiled texel value (stored as gray, read .r).
  float blueT = float(noise.eval(fragCoord).r);
  float threshold = uMode < MODE_BLUE ? bayerT : blueT;
  half wobble = half((threshold - 0.5) * uEmphasis * LSB);
  return half4(c.rgb + wobble * c.a, c.a);
}
`;

const DITHER_UNIFORM_FLOATS = 2; // uMode, uEmphasis — asserted by the packer

let _effect = null;    // cached compiled RuntimeEffect
let _effectCK = null;  // the CanvasKit instance it was compiled against
let _noiseImg = null;  // cached decoded blue-noise Image
let _noiseCK = null;   // the CanvasKit instance it was built against

/**
 * Query→build (compiles once, memoized per CanvasKit instance). Returns the
 * compiled dither RuntimeEffect. Throws LOUDLY with the SkSL compiler error on
 * failure (no silent fallback) — a shader that will not compile is a hard bug.
 *
 * @param {object} CanvasKit - the CanvasKit module
 * @returns {object} the compiled RuntimeEffect
 */
export function ditherEffect(CanvasKit) {
  if (_effect && _effectCK === CanvasKit) return _effect;
  let err = null;
  const eff = CanvasKit.RuntimeEffect.Make(DITHER_SKSL, (e) => { err = e; });
  if (!eff) throw new Error(`dither_shader: DITHER SkSL failed to compile:\n${err}`);
  _effect = eff;
  _effectCK = CanvasKit;
  return eff;
}

/**
 * Query→build (decodes the asset + allocates an Image once, memoized per
 * CanvasKit instance). Expands the 1-byte-per-texel blue-noise tile to an opaque
 * RGBA_8888 Image (r=g=b=threshold) so a child image shader's `.r` is the
 * threshold. SRGB color space matches the render surfaces, so evaluating it in
 * the dither RuntimeEffect applies NO transfer conversion — the stored value
 * passes through unchanged.
 *
 * @param {object} CanvasKit - the CanvasKit module
 * @returns {object} a BLUE_NOISE_SIZE x BLUE_NOISE_SIZE CanvasKit Image
 */
export function blueNoiseImage(CanvasKit) {
  if (_noiseImg && _noiseCK === CanvasKit) return _noiseImg;
  const gray = decodeBlueNoise();
  const rgba = new Uint8Array(gray.length * RGBA_STRIDE);
  for (let i = 0; i < gray.length; i++) {
    const o = i * RGBA_STRIDE;
    rgba[o] = gray[i]; rgba[o + 1] = gray[i]; rgba[o + 2] = gray[i]; rgba[o + 3] = FULL_ALPHA;
  }
  const info = {
    width: BLUE_NOISE_SIZE,
    height: BLUE_NOISE_SIZE,
    alphaType: CanvasKit.AlphaType.Opaque,
    colorType: CanvasKit.ColorType.RGBA_8888,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  };
  const img = CanvasKit.MakeImage(info, rgba, BLUE_NOISE_SIZE * RGBA_STRIDE);
  if (!img) throw new Error("dither_shader: CanvasKit.MakeImage returned null for the blue-noise tile");
  _noiseImg = img;
  _noiseCK = CanvasKit;
  return img;
}

/**
 * Pure function. Reads THE camera's dither settings out of a folded/evaluated
 * state — the first active camera item, mirroring core/derive.cameraRect's
 * selection (first active camera by id, deterministic). Absent camera / props →
 * the registry defaults (off, emphasis 1), so a pre-dither document is a no-op.
 *
 * @param {object} state - evaluated folded state ({items: {id: {type, ...}}})
 * @returns {{mode: string, emphasis: number}} the dither mode + emphasis
 *
 * @example cameraDither({items: {c: {type: "camera", ditherMode: "bayer", ditherEmphasis: 2}}}) // {mode: "bayer", emphasis: 2}
 * @example cameraDither({items: {}}).mode // "off"
 */
export function cameraDither(state) {
  const cams = Object.entries(state?.items ?? {})
    .filter(([, s]) => s.type === "camera" && s.active !== false)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const cam = cams.length ? cams[0][1] : {};
  const mode = KNOWN_MODES.includes(cam.ditherMode) ? cam.ditherMode : MODE_OFF;
  const emphasis = typeof cam.ditherEmphasis === "number" && cam.ditherEmphasis >= 0 ? cam.ditherEmphasis : 1;
  return { mode, emphasis };
}

/**
 * Pure function. Packs the dither uniforms into the flat Float32Array CanvasKit
 * expects (uniform declaration order). Throws if the packed length drifts from
 * the shader's uniform block (loud, like packGlassUniforms).
 *
 * @param {{mode: string, emphasis: number}} d - dither settings
 * @returns {Float32Array} length 2: [modeCode, emphasis]
 *
 * @example packDitherUniforms({mode: "blueNoise", emphasis: 1})[0] // 1
 */
function packDitherUniforms(d) {
  const out = new Float32Array([MODE_CODE[d.mode], d.emphasis]);
  if (out.length !== DITHER_UNIFORM_FLOATS)
    throw new Error(`packDitherUniforms: packed ${out.length} floats, expected ${DITHER_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * Pure function. Whether a dither setting actually does anything (a mode other
 * than "off" AND a positive emphasis). Everything else is a no-op the sinks skip.
 *
 * @param {{mode?: string, emphasis?: number}} dither - camera dither settings
 * @returns {boolean}
 *
 * @example ditherActive({mode: "bayer", emphasis: 1}) // true
 * @example ditherActive({mode: "off", emphasis: 1}) // false
 * @example ditherActive({mode: "blueNoise", emphasis: 0}) // false
 */
export function ditherActive(dither) {
  const { mode, emphasis } = dither ?? {};
  return mode !== undefined && mode !== MODE_OFF && emphasis > 0;
}

/**
 * Command (draws onto `destCanvas`). THE downconvert: re-draw the composited F16
 * source through the dither RuntimeEffect (BlendMode.Src — the shader output
 * REPLACES the destination) so the sub-LSB wobble is added as the F16 value is
 * quantized to the 8-bit destination. Deletes every WASM handle it allocates.
 * Caller flushes the destination surface.
 *
 * @param {object} CanvasKit - the CanvasKit module
 * @param {object} srcSurface - the composited RGBA16F source surface
 * @param {object} destCanvas - the 8-bit destination canvas (drawn over)
 * @param {{mode: string, emphasis: number}} dither - active dither settings
 */
function ditherDownconvert(CanvasKit, srcSurface, destCanvas, dither) {
  const frame = srcSurface.makeImageSnapshot();
  if (!frame) throw new Error("ditherDownconvert: srcSurface.makeImageSnapshot returned null");
  const effect = ditherEffect(CanvasKit);
  const noise = blueNoiseImage(CanvasKit);
  // frame: 1:1 device-pixel read of the F16 source (Nearest, Clamp — identity matrix).
  const frameChild = frame.makeShaderOptions(CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Nearest, CanvasKit.MipmapMode.None);
  // noise: seamlessly TILED across the frame (Repeat), one texel per device px.
  const noiseChild = noise.makeShaderOptions(CanvasKit.TileMode.Repeat, CanvasKit.TileMode.Repeat, CanvasKit.FilterMode.Nearest, CanvasKit.MipmapMode.None);
  const shader = effect.makeShaderWithChildren(packDitherUniforms(dither), [frameChild, noiseChild]);
  if (!shader) throw new Error("ditherDownconvert: makeShaderWithChildren returned null");

  const paint = new CanvasKit.Paint();
  paint.setShader(shader);
  paint.setBlendMode(CanvasKit.BlendMode.Src); // the dithered F16 REPLACES the 8-bit dest
  destCanvas.drawPaint(paint);

  paint.delete();
  shader.delete();
  frameChild.delete();
  noiseChild.delete();
  frame.delete();
}

/**
 * Pure function. The RGBA16F ImageInfo (half-float, premultiplied, SRGB) for a
 * width x height dither intermediate. HALF-FLOAT so a gradient / blur / shadow
 * falloff keeps sub-8-bit precision until the dithered downconvert. SRGB matches
 * every 8-bit sink, so compositing is byte-for-byte the same values — just not
 * yet quantized — and the downconvert applies no transfer conversion.
 *
 * @param {object} CanvasKit - the CanvasKit module
 * @param {number} width - device px
 * @param {number} height - device px
 * @returns {object} a CanvasKit ImageInfo
 */
function f16Info(CanvasKit, width, height) {
  return {
    width,
    height,
    alphaType: CanvasKit.AlphaType.Premul,
    colorType: CanvasKit.ColorType.RGBA_F16,
    colorSpace: CanvasKit.ColorSpace.SRGB,
  };
}

/**
 * Command. THE shared dither entry point every raster sink uses. `paint(canvas)`
 * draws the whole scene into the canvas it is handed; renderWithDither decides
 * WHERE:
 *   - dither inactive ("off" / emphasis <= 0): paint straight into `destSurface`
 *     and flush — byte-identical to the pre-dither pipeline (zero extra cost).
 *   - dither active: paint into a fresh RGBA16F offscreen (derived from
 *     `destSurface` so it is GPU- or CPU-backed to match), then dither on the
 *     F16 -> 8-bit downconvert onto `destSurface`, and flush.
 *
 * This is the single place the precision intermediate lives, so all three sinks
 * de-band identically. If the F16 offscreen cannot be allocated (a WebGL2 context
 * with no half-float color-buffer support — common in browsers), it degrades
 * LOUDLY to a direct 8-bit paint (dither disabled here, reported once) rather
 * than bricking the frame. F16 still works where supported (node/headless
 * export), where dither de-bands as intended.
 *
 * @param {object} CanvasKit - the CanvasKit module
 * @param {object} destSurface - the real 8-bit output Surface
 * @param {number} width - surface width in device px
 * @param {number} height - surface height in device px
 * @param {{mode: string, emphasis: number}} dither - camera dither settings
 * @param {(canvas: object) => void} paint - draws the scene into the given canvas
 */
let _ditherUnavailableWarned = false;
/**
 * Command. Warns ONCE (never silent) that this context cannot allocate the F16
 * dither intermediate, so dithering is off here while the frame still renders.
 */
function warnDitherUnavailableOnce() {
  if (_ditherUnavailableWarned) return;
  _ditherUnavailableWarned = true;
  console.warn("renderWithDither: this GPU/WebGL2 context cannot allocate an RGBA16F render target (no half-float color buffer) — dithering is DISABLED here and the frame renders un-dithered. Dithering still works where F16 is supported (headless/node export).");
}

export function renderWithDither(CanvasKit, destSurface, width, height, dither, paint) {
  if (!ditherActive(dither)) {
    paint(destSurface.getCanvas());
    destSurface.flush();
    return;
  }
  // Dither needs an RGBA16F precision intermediate. Some WebGL2 contexts cannot
  // allocate a half-float render target (no EXT_color_buffer_float): makeSurface
  // then THROWS internally or returns null. Degrade LOUDLY to a direct 8-bit
  // paint rather than bricking every frame — reported once, never silent.
  let scene = null;
  try {
    scene = destSurface.makeSurface(f16Info(CanvasKit, width, height));
  } catch {
    scene = null;
  }
  if (!scene) {
    warnDitherUnavailableOnce();
    paint(destSurface.getCanvas());
    destSurface.flush();
    return;
  }
  try {
    paint(scene.getCanvas());
    scene.flush();
    ditherDownconvert(CanvasKit, scene, destSurface.getCanvas(), dither);
    destSurface.flush();
  } finally {
    scene.delete();
  }
}
