/** Native Multipoint field → ordinary Skia shader. One numerical implementation
 * for browser and headless rendering; generated F16 texels are only a cache.
 *
 * RENDER RESOLUTION (claude_instructions.md "Multipoint render resolution and solve
 * speed"): the parsed paint's `resolution` is a grid side N, "auto", or absent
 * (= MULTIPOINT_DEFAULT_SIZE, byte-identical to before the setting existed). N counts
 * texels per side of the SOLVE DOMAIN (the square around the box and every source).
 * A field is addressed by its FIELD KEY `${N}:${content key}`. */
import { solveMultipoint, multipointDomain } from "../../core/multipoint_diffusion.js";
import { MULTIPOINT_RESOLUTION_AUTO } from "../../core/properties.js";
import { toHalf } from "./shape_sdf.js";
import { warnOnce } from "../../core/report.js";

export const MULTIPOINT_PREVIEW_SIZE = 128;
export const MULTIPOINT_DEFAULT_SIZE = 512;
export const MULTIPOINT_AUTO_MIN_SIZE = 128;
export const MULTIPOINT_AUTO_MAX_SIZE = 2048; // the solver needs ~1.5 GB while solving 2048²
// Largest first: the editor's interim field is the finest one already solved.
const FIELD_SIZES = [2048, 1024, 512, 256, 128];
// Per cache, in F16 texel bytes: two 2048² fields (32 MiB each) or thirty-two 512².
// Smaller would make two visible maximum-resolution fills evict each other every frame.
const CACHE_BYTES = 64 * 1024 * 1024;
const fields = new Map();
const images = new WeakMap();
const opacityEffects = new WeakMap();
let previewRequests = null;
const OPACITY_SKSL = `uniform shader field; uniform float opacity;
half4 main(float2 xy) { return field.eval(xy) * opacity; }`;

/**
 * Pure function. Content address, excluding object transform and opacity.
 * @param {object[]} features - Parsed, visible Multipoint source records.
 * @returns {string} Deterministic cache key.
 * @example multipointKey([]) // "[]"
 */
export function multipointKey(features) { return JSON.stringify(features); }

/**
 * Pure function. Device-pixel scale of a 3×3 canvas matrix's local x and y axes
 * (its 2×2 linear part; perspective is ignored). Null means identity.
 * @param {number[]|null} ctm - Row-major [a,b,tx, c,d,ty, p0,p1,p2] (CanvasKit order).
 * @returns {number[]} [sx, sy] (lengths of the images of the unit x and y vectors).
 * @example matrixAxisScales(null) // [1, 1]
 * @example matrixAxisScales([2,0,5, 0,3,7, 0,0,1]) // [2, 3]
 * @example matrixAxisScales([0,-2,0, 2,0,0, 0,0,1]) // [2, 2] (rotated 90°, zoom 2)
 */
export function matrixAxisScales(ctm) {
  if (!ctm) return [1, 1];
  return [Math.hypot(ctm[0], ctm[3]), Math.hypot(ctm[1], ctm[4])];
}

/**
 * Pure function. THE AUTO RULE: the smallest power-of-two grid side that gives the
 * field at least one texel per device pixel along its longer device span, clamped to
 * MULTIPOINT_AUTO_MIN_SIZE..MULTIPOINT_AUTO_MAX_SIZE. The span is the SOLVE DOMAIN's
 * (paint box × domain side), so off-box sources raise it too.
 * @param {{w:number,h:number}} bounds - Local paint box.
 * @param {{w:number,h:number}} domain - Square solve domain in paint-box units.
 * @param {number[]|null} ctm - This draw's canvas matrix (canvas.getTotalMatrix()).
 * @returns {number} Grid side N.
 * @example autoFieldSize({w:300,h:200},{w:1,h:1},null) // 512
 * @example autoFieldSize({w:300,h:200},{w:1,h:1},[4,0,0, 0,4,0, 0,0,1]) // 2048 (1200 device px)
 * @example autoFieldSize({w:300,h:200},{w:1.36,h:1.36},[2,0,0, 0,2,0, 0,0,1]) // 1024 (816 device px)
 * @example autoFieldSize({w:40,h:40},{w:1,h:1},null) // 128 (floor)
 * @example autoFieldSize({w:9000,h:10},{w:1,h:1},null) // 2048 (cap)
 */
export function autoFieldSize(bounds, domain, ctm) {
  const [sx, sy] = matrixAxisScales(ctm);
  const span = Math.max(Math.abs(bounds.w) * domain.w * sx, Math.abs(bounds.h) * domain.h * sy);
  let size = MULTIPOINT_AUTO_MIN_SIZE;
  while (size < span && size < MULTIPOINT_AUTO_MAX_SIZE) size *= 2;
  return size;
}

/**
 * Pure function (the auto branch validates the features). The FINAL grid side for a
 * parsed Multipoint paint drawn over `bounds` under `ctm`.
 * @param {object} paint - Parsed paint: {features, resolution?} (absent = default).
 * @param {{w:number,h:number}} bounds - Local paint box.
 * @param {number[]|null} ctm - This draw's canvas matrix.
 * @returns {number} Grid side N (a power of two).
 * @example multipointFieldSize({features:[]},{w:100,h:100},null) // 512
 * @example multipointFieldSize({features:[],resolution:2048},{w:100,h:100},null) // 2048
 * @example multipointFieldSize({features:[],resolution:"auto"},{w:100,h:100},[3,0,0, 0,3,0, 0,0,1]) // 512 (300 device px)
 */
export function multipointFieldSize(paint, bounds, ctm) {
  if (paint.resolution === MULTIPOINT_RESOLUTION_AUTO) return autoFieldSize(bounds, multipointDomain(paint.features), ctm);
  return paint.resolution ?? MULTIPOINT_DEFAULT_SIZE;
}

/**
 * Pure function. Float32 texels → upload-ready IEEE binary16 bits, via the shared
 * toHalf. A plain loop: `Uint16Array.from(pixels, toHalf)` gives identical bits but
 * cost 92 ms at 512² and 1.46 s at 2048² (measured) — this is ~4.4× faster.
 * @param {Float32Array} pixels - (H,W,4) premultiplied RGBA, e.g. (512,512,4).
 * @returns {Uint16Array} Same shape, F16 bit patterns.
 * @example Array.from(halfTexels(new Float32Array([0, 1, 0.5, -2]))) // [0, 15360, 14336, 49152]
 */
export function halfTexels(pixels) {
  const half = new Uint16Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) half[i] = toHalf(pixels[i]);
  return half;
}

/**
 * Pure function. Solves one field at `size` and returns the cacheable F16 record.
 * Nonconvergence and non-finite output are refused here, where the Float32 exists
 * (the refinement worker calls this too, so the main thread never converts).
 * @param {object[]} features - Parsed sources.
 * @param {number} size - Power-of-two grid side, e.g. 512.
 * @returns {{size:number,half:Uint16Array,domain:object,iterations:number,relativeResidual:number}}
 *   `half` is (size,size,4) F16 premultiplied encoded-sRGB RGBA.
 * @example solvedField([], 4).half.length // 64
 */
export function solvedField(features, size) {
  const {pixels, domain, converged, relativeResidual, iterations} = solveMultipoint(features, {size});
  if (!converged) throw new Error(`Multipoint diffusion did not converge (relative residual ${relativeResidual}).`);
  for (let i = 0; i < pixels.length; i++) if (!Number.isFinite(pixels[i])) throw new Error("Multipoint diffusion must return finite Float32 RGBA pixels.");
  return {size, half: halfTexels(pixels), domain, iterations, relativeResidual};
}

/**
 * Command. Updates a bounded LRU; evicted WASM images are deleted by their owner.
 * @param {Map} cache - Cache to mutate.
 * @param {string} key - Entry address.
 * @param {object} value - Entry carrying bytes and optional image.
 * @returns {object} Inserted value.
 */
function remember(cache, key, value) {
  cache.delete(key); cache.set(key, value);
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.bytes;
  while (bytes > CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value, entry = cache.get(oldest);
    cache.delete(oldest); bytes -= entry.bytes; entry.image?.delete();
  }
  return value;
}

/**
 * Command. Reads and promotes an LRU entry; returns undefined on an ordinary miss.
 * @param {Map} cache - Cache whose recency changes.
 * @param {string} key - Content address.
 * @returns {object|undefined} Cached entry.
 */
function cached(cache, key) {
  const value = cache.get(key);
  if (value) { cache.delete(key); cache.set(key, value); }
  return value;
}

/**
 * Command. Validates and caches a solved field record (solvedField's output, from
 * this thread or a worker) under its field key; no generated data is saved.
 * @param {string} key - multipointKey(features), the CONTENT key.
 * @param {object} field - {size, half:(size,size,4) Uint16Array F16, domain}.
 * @returns {object} The validated field, e.g. a 512×512 RGBA F16 record.
 */
export function rememberMultipointField(key, field) {
  const {size, half, domain} = field;
  if (!Number.isInteger(size) || size < 4 || !(half instanceof Uint16Array) || half.length !== size * size * 4)
    throw new Error("Multipoint field must carry (size,size,4) F16 texels in a Uint16Array.");
  if (!domain || ![domain.x,domain.y,domain.w,domain.h].every(Number.isFinite) || domain.w <= 0 || domain.h <= 0)
    throw new Error("Multipoint diffusion returned invalid field bounds.");
  remember(fields, `${size}:${key}`, {field, bytes:half.byteLength});
  return field;
}

/**
 * Command. Runs one synchronous interactive paint and records all visible fields.
 * An idle worker may refine unready fields; exporting outside this scope
 * always solves the final size synchronously. Nested paints restore their caller.
 * @param {Function} draw - Synchronous render command.
 * @returns {{key:string,contentKey:string,features:object[],size:number,ready:boolean}[]}
 *   One record per visible FIELD KEY, with final-cache availability.
 */
export function withMultipointPreview(draw) {
  const previous = previewRequests, requests = new Map();
  previewRequests = requests;
  try { draw(); return [...requests.values()]; }
  finally { previewRequests = previous; }
}

/**
 * Command. Resolves an immutable F16 field, solving deterministically on a miss.
 * Outside a preview scope (exports, bare node) that is always the exact `size`.
 * Inside one (the editor) a miss shows the finest field already solved for this
 * content, else a synchronous min(MULTIPOINT_PREVIEW_SIZE, size) solve, and records
 * the exact size for idle refinement; at size ≤ the preview size that solve IS final.
 * @param {object[]} features - Parsed sources.
 * @param {string} key - multipointKey(features).
 * @param {number} size - Final grid side.
 * @returns {object} Field record; (size,size,4) when final, else an interim size.
 */
function fieldFor(features, key, size) {
  const fieldKey = `${size}:${key}`, exact = cached(fields, fieldKey)?.field;
  if (!previewRequests) return exact ?? rememberMultipointField(key, solvedField(features, size));
  const preview = Math.min(MULTIPOINT_PREVIEW_SIZE, size), ready = !!exact || preview === size;
  previewRequests.set(fieldKey, {key:fieldKey, contentKey:key, features, size, ready});
  if (ready) return exact ?? rememberMultipointField(key, solvedField(features, size));
  for (const interim of FIELD_SIZES) {
    const entry = interim !== size && cached(fields, `${interim}:${key}`);
    if (entry) return entry.field;
  }
  return rememberMultipointField(key, solvedField(features, preview));
}

/**
 * Command. Creates a native Skia shader and updates bounded F16-image caches.
 * @param {object} CK - Caller's existing CanvasKit instance, never a new GL context.
 * @param {object} paint - Parsed Multipoint paint: visible features, optional resolution.
 * @param {{x:number,y:number,w:number,h:number}} bounds - Local painted box.
 * @param {number} opacity - Item/group alpha multiplier.
 * @param {number[]|null} ctm - canvas.getTotalMatrix(); read only by "auto".
 * @returns {object} Shader owned/deleted by the ordinary gradient caller.
 */
export function multipointShader(CK, paint, bounds, opacity, ctm = null) {
  const width = bounds.w || Number.EPSILON, height = bounds.h || Number.EPSILON;
  const contentKey = multipointKey(paint.features);
  const {size, half, domain} = fieldFor(paint.features, contentKey, multipointFieldSize(paint, {w:width, h:height}, ctm));
  if (domain.w > 1 || domain.h > 1) warnOnce("multipoint-expanded-domain",
    "Multipoint sources outside the paint box expand its solve domain and reduce visible detail. Keep sources near the object for full resolution.");
  const key = `${size}:${contentKey}`;
  if (!images.has(CK)) images.set(CK, new Map());
  const cache = images.get(CK);
  let entry = cached(cache,key);
  if (!entry) {
    // WebGL2 filters half floats natively; RGBA_F32 was silently uploaded as RGBA8.
    const image = CK.MakeImage({width:size,height:size,colorType:CK.ColorType.RGBA_F16,
      alphaType:CK.AlphaType.Premul,colorSpace:CK.ColorSpace.SRGB},
    new Uint8Array(half.buffer, half.byteOffset, half.byteLength),size * 4 * Uint16Array.BYTES_PER_ELEMENT);
    if (!image) throw new Error("Skia rejected the Multipoint RGBA_F16 image.");
    entry = remember(cache,key,{image,bytes:half.byteLength});
  }
  const shader = entry.image.makeShaderOptions(CK.TileMode.Clamp,CK.TileMode.Clamp,
    CK.FilterMode.Linear,CK.MipmapMode.None,
    [width * domain.w / size,0,bounds.x + domain.x * width,
      0,height * domain.h / size,bounds.y + domain.y * height,0,0,1]);
  if (!shader) throw new Error("Skia could not build the Multipoint image shader.");
  if (opacity === 1) return shader;
  if (!opacityEffects.has(CK)) {
    const effect = CK.RuntimeEffect.Make(OPACITY_SKSL);
    if (!effect) { shader.delete(); throw new Error("Skia could not compile the Multipoint opacity shader."); }
    opacityEffects.set(CK,effect);
  }
  const faded = opacityEffects.get(CK).makeShaderWithChildren([opacity],[shader]);
  shader.delete();
  if (!faded) throw new Error("Skia could not apply Multipoint opacity.");
  return faded;
}

/**
 * Command. Frees this CanvasKit instance's cached images/effect, for host teardown.
 * @param {object} CK - Instance being retired. CPU fields remain bounded/reusable.
 * @returns {undefined}
 */
export function disposeMultipointImages(CK) {
  for (const entry of images.get(CK)?.values() ?? []) entry.image.delete();
  images.delete(CK); opacityEffects.get(CK)?.delete(); opacityEffects.delete(CK);
}
