/**
 * THE deterministic DITHER — one ordered/blue-noise sub-LSB pattern, applied
 * PER PAINT (today: per gradient fill/stroke) rather than over the whole frame.
 *
 * WHAT IT FIXES: an 8-bit surface holds 256 levels per channel, so a smooth
 * gradient collapses into visible stair-step BANDS at the quantization boundary.
 * Adding a sub-LSB ordered pattern BEFORE the 8-bit write scatters each pixel
 * between the two nearest levels, so the eye averages them back to the true
 * value and the bands dissolve into fine grain.
 *
 * ── THIS FILE USED TO BE A WHOLE-FRAME CAMERA POST-PASS, AND THAT DESIGN IS GONE
 * (user ruling, 2026-08-07: "It will be a material-level thing you uproot any
 * code in the camera for dithering"). The camera carried `ditherMode` /
 * `ditherEmphasis` render props and `renderWithDither()` composited the entire
 * scene into an RGBA16F offscreen so the wobble could be added on the F16 → 8-bit
 * downconvert. Everything about that is deleted: the props, the presets, the
 * `cameraDither()` reader, `renderWithDither`, `ditherDownconvert`, the F16
 * ImageInfo and the "this context cannot allocate a half-float render target"
 * degradation. WHAT SURVIVES IS THE MATH — the Bayer recursion, the blue-noise
 * tile (blue_noise_64.js) and the ±half-LSB wobble — because none of it was ever
 * the problem.
 *
 * WHY THE PAINT-LEVEL VERSION NEEDS NO F16 INTERMEDIATE, WHICH IS THE WHOLE
 * REASON THIS IS A BETTER PLACE FOR IT. The camera pass needed one because it ran
 * AFTER the scene had already been rasterized: adding noise to an already-8-bit
 * surface is a NO-OP (the fractional information is gone, so an integer + a
 * fraction < 0.5 rounds back to the same integer), so it had to re-composite the
 * frame in half-float first and dither on the downconvert. A PAINT shader has no
 * such problem: its output is a float that Skia quantizes as it writes to the
 * destination, so the shader IS standing on the quantization boundary already.
 * MEASURED (bare node, software Skia, a near-black 10-level ramp over 400px):
 * emphasis 1 changes 18.5% of bytes by 1; emphasis 16 changes 68.5% by up to 8 —
 * the SAME numbers the F16 camera pass produced, with no offscreen and no
 * half-float support required anywhere.
 *
 * DEVICE-SPACE, VIA `uToDevice`. The pattern must land on the DEVICE PIXEL GRID:
 * one threshold per output pixel is the entire premise of dithering, and a
 * pattern computed in the shape's local space would grow into chunky blobs when
 * zoomed in and alias when zoomed out. A runtime-effect shader's `main(float2 p)`
 * receives LOCAL coordinates, so the caller passes the canvas CTM
 * (`canvas.getTotalMatrix()`) as a float3x3 uniform and the shader maps `p`
 * through it. MEASURED: the identical scene at dpr 1 and dpr 2 produces the same
 * differing-byte count and the same max delta, i.e. the grain is one device pixel
 * in both — which it would NOT be if this used local coordinates.
 *
 * DETERMINISTIC — the property-state law (CLAUDE.md, "the four kinds of state").
 * The threshold is a pure function of the integer device coordinate (bayer) or a
 * static precomputed texture (blueNoise). Never a clock, never Math.random. So
 * RenderTree = pure(document, view) holds and Δt = 0 yields a byte-identical
 * frame. The device coordinate is part of the RENDER REQUEST (view + CTM), not
 * ambient state, exactly as anti-aliasing coverage is.
 *
 * OFF == byte-identical to today: `ditherActive` is false for mode "off" or
 * emphasis <= 0, and render_gpu/ir.js parsePaint OMITS the leaves entirely in
 * that case, so a paint that has never been dithered produces the same parsed
 * object and the same untouched Skia gradient shader it always did.
 *
 * REUSES the glass compile+cache pattern (paint_skia.js glassEffect): the
 * RuntimeEffect and the blue-noise Image are each built ONCE per CanvasKit
 * instance and memoized; a compile failure throws LOUDLY (no silent fallback).
 */

import { DITHER_MODES, PAINT_DEFAULT_BIT_DEPTH, PAINT_DITHER_DEFAULT_BAYER_SIZE } from "../../core/properties.js";
import { decodeBlueNoise, BLUE_NOISE_SIZE } from "./blue_noise_512.js";

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
// The mode ids the SHADER branches on. Kept in lock-step with core/properties.js
// DITHER_MODES so the stored state, the property row, and the shader can never
// disagree; the import-time assert below proves the mapping still matches.
export const MODE_OFF = "off";
const MODE_BAYER = "bayer";
const MODE_BLUE_NOISE = "blueNoise";
// Shader-side numeric mode selector (float uniform — SkSL has no string type).
const MODE_CODE = { [MODE_BAYER]: 0, [MODE_BLUE_NOISE]: 1 };
// The ids this module knows how to render, asserted against the property registry
// so a new DITHER_MODES entry that the shader does not handle fails loudly here
// instead of silently rendering as a no-op.
export const KNOWN_MODES = [MODE_OFF, MODE_BAYER, MODE_BLUE_NOISE];
if (DITHER_MODES.slice().sort().join(",") !== KNOWN_MODES.slice().sort().join(","))
  throw new Error(`dither_shader: DITHER_MODES ${JSON.stringify(DITHER_MODES)} != known ${JSON.stringify(KNOWN_MODES)} — a mode was added without shader support.`);

// Bayer expansion. RGBA_8888 = 4 bytes/texel; the noise asset stores 1 gray byte
// per texel, expanded to r=g=b=v, a=255 so a child image shader's .r is the
// threshold. FULL_ALPHA is the opaque alpha byte of that expansion.
const RGBA_STRIDE = 4;
const FULL_ALPHA = 255;

// THE BAYER MATRIX IS COMPUTED ANALYTICALLY, AT ANY ORDER, FROM ONE GENERATOR.
// SkSL RuntimeEffect forbids array-constructor literals, so there is no baked
// matrix — and now that the order is selectable (2x2..16x16, core/properties.js
// DITHER_BAYER_SIZES) there are deliberately no FOUR baked matrices either.
//
// The classic recursion is b_{2n}(a) = b_n(a/2)/4 + b_2(a), which unrolls to a
// plain weighted SUM of the SAME 2x2 base cell sampled at halving scales:
//     b_{2^k}(a) = Σ_{j=0}^{k-1} b2(a / 2^j) · 4^-j
// so one `bayer2` and four terms cover every offered order; the order selects how
// many terms participate. A 2^k matrix holds 4^k distinct thresholds, which is the
// count each cell is centred against (see the half-cell offset in main).

/**
 * THE paint dither SkSL. Children: `base` (the shader being dithered — today a
 * Skia linear/radial gradient, in the SAME local space this effect is invoked in)
 * and `noise` (the tiled blue-noise texture). Output per pixel:
 *
 *   out.rgb = base.rgb + (threshold - 0.5) * uEmphasis * LSB * base.a
 *   out.a   = base.a
 *
 * `threshold` in [0,1) comes from the analytic Bayer matrix (uMode 0) or the
 * blue-noise texel (uMode 1), BOTH SAMPLED AT THE DEVICE COORDINATE `uToDevice`
 * maps `p` to — see the header. Centering by -0.5 makes it a zero-mean +/- half-
 * step wobble, so a dithered gradient has the SAME average colour as an
 * un-dithered one (dither must not shift the picture, only break its bands).
 * LSB = 1/255 is one 8-bit level in normalized colour, so uEmphasis == 1 spreads
 * a pixel across exactly the two nearest levels (peak-to-peak one LSB).
 * uEmphasis ABOVE 1 is supported and is a real authored look — a grittier, louder
 * grain; the property has NO upper cap and the shader does not clamp.
 *
 * `base.eval(p)` uses the LOCAL coordinate, not the device one: the gradient must
 * be sampled exactly where it would have been without this wrapper, or the fill
 * would shift. Only the THRESHOLD lookup goes to device space.
 *
 * Scaling the wobble by base.a keeps a premultiplied result valid and leaves
 * transparent pixels (a == 0) untouched, so a gradient fading to transparent
 * never gains coloured noise in its invisible region.
 */
export const DITHER_SKSL = `
const float MODE_BLUE = ${MODE_CODE[MODE_BLUE_NOISE]}.0;

uniform shader base;        // child 0: the shader being dithered (local space)
uniform shader noise;       // child 1: the tiled blue-noise texel source (Repeat)
uniform float uMode;        // 0 = bayer (ordered matrix), 1 = blueNoise (texture)
uniform float uEmphasis;    // wobble amplitude, in QUANTISATION STEPS (1 == +/- half a step; may exceed 1; 0 == depth reduction with no noise)
uniform float uLevels;      // quantisation intervals per channel = 2^bits - 1 (255 at 8 bits, 1 at 1 bit)
uniform float uQuantize;    // 1 = quantise explicitly (bits < 8); 0 = leave it to the surface write (bits == 8)
uniform float uBayerOrder;  // log2(matrix edge): 1=2x2, 2=4x4, 3=8x8 (default), 4=16x16
uniform float3x3 uToDevice; // local → device px (the canvas CTM), so one threshold == one output pixel

// Pure. The 2x2 Bayer base cell as a fract-of-coordinate, values in {0,.25,.5,.75}.
float bayer2(float2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
// Pure. The ordered matrix of edge 2^order, as the unrolled recursion described
// above: the base cell at halving scales, each quarter the weight of the last.
// Terms past the chosen order are switched off rather than branched around, so all
// orders run the same straight-line code (no divergence, no per-order variant).
float bayerAt(float2 a, float order) {
  return bayer2(a)
       + (order >= 2.0 ? bayer2(a * 0.5)   * 0.25     : 0.0)
       + (order >= 3.0 ? bayer2(a * 0.25)  * 0.0625   : 0.0)
       + (order >= 4.0 ? bayer2(a * 0.125) * 0.015625 : 0.0);
}

half4 main(float2 p) {
  half4 c = base.eval(p);                          // sample the gradient where it actually lives
  float2 dev = (uToDevice * float3(p, 1.0)).xy;    // ...but threshold on the DEVICE pixel grid
  // Ordered Bayer threshold from the integer device coordinate, plus HALF A CELL so
  // the matrix's 4^order levels straddle 0.5 with zero DC bias. The offset must
  // track the order: a 2x2 matrix has 4 levels and needs 1/8, an 8x8 has 64 and
  // needs 1/128. A fixed offset would bias every order but the one it was written
  // for — the dither would lighten or darken the fill instead of only scattering it.
  float bayerT = bayerAt(dev, uBayerOrder) + 0.5 / pow(4.0, uBayerOrder);
  // blue-noise threshold: the Repeat-tiled texel value (stored as gray, read .r).
  float blueT = float(noise.eval(dev).r);
  float threshold = uMode < MODE_BLUE ? bayerT : blueT;
  // ONE quantisation step in normalized colour. At 8 bits this is 1/255 — the LSB
  // this shader used to hardcode — so the 8-bit picture is unchanged by the
  // generalisation. Emphasis is measured in these steps at EVERY depth, which is
  // what keeps "emphasis 1 == spread across the two nearest levels" true at 1 bit.
  float step = 1.0 / uLevels;
  half wobble = half((threshold - 0.5) * uEmphasis * step);

  // 8-BIT PATH — BYTE-IDENTICAL TO BEFORE bitDepth EXISTED, and deliberately not
  // merged with the branch below. At 8 bits the destination surface already
  // quantises on write, so adding our OWN round() here would be a second
  // quantisation whose rounding mode is not guaranteed to match Skia's — a way to
  // change every existing dithered gradient by a code value for no benefit.
  if (uQuantize < 0.5) return half4(c.rgb + wobble * c.a, c.a);

  // REDUCED-DEPTH PATH — quantise explicitly, in UNPREMULTIPLIED colour. The
  // incoming half4 is PREMULTIPLIED, and posterizing a premultiplied value would
  // quantise colour and alpha together: a 50%-transparent mid-grey would land on a
  // different colour than the same opaque grey, so a gradient fading out would
  // shift hue as it faded. Unpremultiply, quantise, re-premultiply.
  half a = c.a;
  half3 straight = a > 0.0 ? c.rgb / a : c.rgb;
  straight = clamp(straight + wobble, 0.0, 1.0);   // clamp BEFORE the round so the wobble cannot push past the end levels
  half3 q = half3(floor(float3(straight) * uLevels + 0.5) / uLevels);
  return half4(q * a, a);
}
`;

// uMode, uEmphasis, uLevels, uQuantize, uBayerOrder, then the 9 floats of
// uToDevice — asserted by the packer.
const DITHER_UNIFORM_FLOATS = 5 + 9;
// A CanvasKit 3x3 from `canvas.getTotalMatrix()` is ROW-major [a,b,c, d,e,f, g,h,i];
// an SkSL float3x3 uniform is filled COLUMN-major. These are the row-major indices
// in column-major order — the transpose, named so the packer does not read as a
// shuffle of magic numbers.
const CTM_TRANSPOSED_ORDER = [0, 3, 6, 1, 4, 7, 2, 5, 8];
// The identity CTM, used when a caller cannot supply one (see ditheredShader).
const IDENTITY_CTM = [1, 0, 0, 0, 1, 0, 0, 0, 1];

let _effect = null;    // cached compiled RuntimeEffect
let _effectCK = null;  // the CanvasKit instance it was compiled against
let _noiseImg = null;  // cached decoded blue-noise Image
let _noiseCK = null;   // the CanvasKit instance it was built against

/**
 * Command (throws). THE TRIPWIRE FOR THE UPROOTED CAMERA PASS. Every raster sink
 * used to take a `dither` render option carrying THE camera's whole-frame
 * settings; that option is gone, and an options bag is a place where a removed key
 * is IGNORED IN SILENCE.
 *
 * That silence is the exact failure mode CLAUDE.md records for this codebase ("A
 * MISSING NAMED IMPORT IS SILENT HERE — NEITHER ERROR NOR WARNING … the failure
 * surfaces as `X is not a function` in the user's hands, on a green build"), and a
 * dropped render option is worse than that one, because there is no crash at all —
 * the frame simply renders undithered and looks plausible. Serialized render-job
 * payloads and the Python server tests both carried this key, so a caller that has
 * not been updated must SAY SO rather than quietly produce a different picture.
 *
 * @param {string} who - the sink's name, for the message
 * @param {object} opts - the render options bag to check
 */
export function refuseCameraDither(who, opts) {
  if (opts && "dither" in opts)
    throw new Error(`${who}: the \`dither\` render option is GONE — the whole-frame camera dither was uprooted (user ruling, 2026-08-07) and dithering is now a PAINT property (core/properties.js PAINT_DITHER_*, set per gradient). Remove the option and set ditherMode/ditherEmphasis on the paint that bands.`);
}

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
 * Pure function. Packs the dither uniforms into the flat Float32Array CanvasKit
 * expects (uniform declaration order). Throws if the packed length drifts from
 * the shader's uniform block (loud, like packGlassUniforms).
 *
 * @param {{mode: string, emphasis: number, bits?: number, bayerSize?: number}} d - depth/dither settings
 * @param {number[]} ctm - the canvas CTM, CanvasKit row-major 9-float form
 * @returns {Float32Array} length 14: [modeCode, emphasis, levels, quantize, bayerOrder, ...ctm column-major]
 *
 * @example packDitherUniforms({mode: "blueNoise", emphasis: 1, bits: 8}, [1,0,0,0,1,0,0,0,1])[0] // 1
 * @example packDitherUniforms({mode: "bayer", emphasis: 2, bits: 8}, [1,0,0,0,1,0,0,0,1])[2] // 255 (levels at 8 bits)
 * @example packDitherUniforms({mode: "bayer", emphasis: 2, bits: 8}, [1,0,0,0,1,0,0,0,1])[3] // 0 (no explicit quantise at 8 bits)
 * @example packDitherUniforms({mode: "bayer", emphasis: 1, bits: 1}, [1,0,0,0,1,0,0,0,1])[2] // 1 (levels at 1 bit)
 * @example packDitherUniforms({mode: "bayer", emphasis: 1, bits: 8, bayerSize: 16}, [1,0,0,0,1,0,0,0,1])[4] // 4 (log2 of the matrix edge)
 * @example packDitherUniforms({mode: "bayer", emphasis: 1, bits: 1}, [1,0,0,0,1,0,0,0,1]).length // 14
 */
export function packDitherUniforms(d, ctm) {
  const bits = d.bits ?? PAINT_DEFAULT_BIT_DEPTH;
  // 2^bits - 1 = the number of quantisation INTERVALS per channel: 255 at 8 bits
  // (so `step` is the familiar 1/255), 1 at 1 bit (levels 0 and 1).
  const levels = Math.pow(2, bits) - 1;
  // A depth-only paint has no dither mode; MODE_CODE would be undefined and the
  // uniform NaN, which silently poisons the branch. Its emphasis is 0, so the mode
  // is arithmetically irrelevant — but it must still be a NUMBER.
  const modeCode = MODE_CODE[d.mode] ?? MODE_CODE[MODE_BAYER];
  // log2 of the matrix edge. Math.log2(8) is exact for every power of two, and the
  // sizes are validated upstream, so this cannot land between orders.
  const bayerOrder = Math.log2(d.bayerSize ?? PAINT_DITHER_DEFAULT_BAYER_SIZE);
  const out = new Float32Array([modeCode, d.emphasis, levels, bits < PAINT_DEFAULT_BIT_DEPTH ? 1 : 0, bayerOrder, ...CTM_TRANSPOSED_ORDER.map((i) => ctm[i])]);
  if (out.length !== DITHER_UNIFORM_FLOATS)
    throw new Error(`packDitherUniforms: packed ${out.length} floats, expected ${DITHER_UNIFORM_FLOATS} (shader uniform block changed?)`);
  return out;
}

/**
 * Pure function. Whether a depth/dither setting actually does anything — i.e.
 * whether this paint needs the shader wrapper at all. TRUE when there is noise to
 * add (a mode other than "off" AND a positive emphasis) OR depth to remove (fewer
 * than 8 bits). Everything else is a no-op every caller skips, which is what keeps
 * an untouched paint byte-identical.
 *
 * IT TAKES BOTH HALVES BECAUSE EITHER ALONE IS A REAL EFFECT: `bitDepth` with no
 * dither is hard posterization, and a dither at 8 bits is what shipped first. A
 * predicate that only asked about the mode would silently drop every posterize.
 *
 * @param {{mode?: string, emphasis?: number, bits?: number}} d - paint depth/dither settings
 * @returns {boolean}
 *
 * @example paintDepthActive({mode: "bayer", emphasis: 1, bits: 8}) // true
 * @example paintDepthActive({mode: "off", emphasis: 1, bits: 8}) // false
 * @example paintDepthActive({mode: "blueNoise", emphasis: 0, bits: 8}) // false
 * @example paintDepthActive({mode: "off", emphasis: 0, bits: 2}) // true (posterize, no noise)
 * @example paintDepthActive(null) // false
 */
export function paintDepthActive(d) {
  if (!d) return false;
  const { mode, emphasis, bits } = d;
  const hasNoise = mode !== undefined && mode !== MODE_OFF && emphasis > 0;
  const reducesDepth = (bits ?? PAINT_DEFAULT_BIT_DEPTH) < PAINT_DEFAULT_BIT_DEPTH;
  return hasNoise || reducesDepth;
}

/**
 * Query→build (allocates a Shader — caller deletes; it also OWNS `base` from
 * here on, see below). Wraps `base` in the depth/dither RuntimeEffect: the sub-step
 * wobble is added, and (below 8 bits) the result is quantised, as Skia writes this
 * paint into the destination surface.
 *
 * OWNERSHIP: the returned shader is the ONLY handle the caller keeps. `base` is
 * consumed — it becomes a child of the runtime shader and is deleted here, so a
 * caller that stashes one handle for cleanup (paint_skia.js `_gradientShader`)
 * stays correct without learning that this wrapper exists. Returning `base`
 * itself when the dither is inactive is what makes that uniform.
 *
 * `ctm` is `canvas.getTotalMatrix()` — CanvasKit's row-major 9-float 3x3, the
 * local→device mapping in force for this draw. Passing null falls back to IDENTITY
 * (local == device), which merely coarsens the grain rather than corrupting it.
 *
 * NO AUTHORED GRADIENT CAN REACH THAT FALLBACK, and it is structural rather than a
 * matter of remembering. Audited across paint_skia.js: exactly three fill/stroke
 * paint sites pass no CTM — the polyline op's `cmd.color`, the proxy stand-in's
 * literal grey, and the lens border's `cmd.stroke` — and ALL THREE also pass
 * `bounds: null`, which makes `applyPaint` THROW ("a gradient paint needs the op's
 * local bounds") the instant a gradient arrives there. So those sites cannot paint
 * a gradient at all, let alone a dithered one: the null-CTM path is reachable only
 * by paints that have no dither to place. The parameter keeps its default so a
 * future internal solid-stroke call site needs no ceremony.
 *
 * @param {object} CanvasKit - the CanvasKit module
 * @param {object} base - the Shader to dither (consumed — do not delete it)
 * @param {{mode: string, emphasis: number, bits: number}|null} depth - paint depth/dither settings
 * @param {number[]|null} ctm - canvas.getTotalMatrix(), or null for identity
 * @returns {object} a Shader: the depth/dither wrapper, or `base` unchanged when inactive
 */
export function depthShader(CanvasKit, base, depth, ctm = null) {
  if (!paintDepthActive(depth)) return base; // pass a null base straight through: unchanged from before this feature
  // A null base can only come from a Skia constructor that failed. Say so HERE,
  // where the cause is still nameable, rather than deferring to a `.delete()` of
  // null two lines down or handing null to makeShaderWithChildren.
  if (!base) throw new Error("depthShader: the gradient shader to dither is null — a CanvasKit gradient constructor failed before the dither wrapper was reached");
  const effect = ditherEffect(CanvasKit);
  const noise = blueNoiseImage(CanvasKit);
  // noise: seamlessly TILED across the draw (Repeat), one texel per device px.
  const noiseChild = noise.makeShaderOptions(CanvasKit.TileMode.Repeat, CanvasKit.TileMode.Repeat, CanvasKit.FilterMode.Nearest, CanvasKit.MipmapMode.None);
  const shader = effect.makeShaderWithChildren(packDitherUniforms(depth, ctm ?? IDENTITY_CTM), [base, noiseChild]);
  noiseChild.delete();
  if (!shader) {
    base.delete();
    throw new Error("depthShader: makeShaderWithChildren returned null — the dither RuntimeEffect could not be instantiated");
  }
  base.delete(); // the runtime shader holds its own reference to the child
  return shader;
}
