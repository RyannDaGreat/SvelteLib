/** Native Multipoint field → ordinary Skia shader. One numerical implementation
 * for browser and headless rendering; generated float pixels are only a cache. */
import { solveMultipoint } from "../../core/multipoint_diffusion.js";
import { toHalf } from "./shape_sdf.js";
import { warnOnce } from "../../core/report.js";

export const MULTIPOINT_PREVIEW_SIZE = 128;
export const MULTIPOINT_FINAL_SIZE = 512;
const CACHE_BYTES = 32 * 1024 * 1024; // eight final RGBA_F32 fields, independent of document length
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
 * Command. Validates and caches a worker/computed field; no generated data is saved.
 * @param {string} key - multipointKey(features).
 * @param {object} result - Converged (H,W,4) Float32 premultiplied RGBA; H=W=size.
 * @returns {object} Validated result, e.g. a 512×512 RGBA field.
 */
export function rememberMultipointField(key, result) {
  const {size,pixels,domain,converged,relativeResidual} = result;
  if (!converged) throw new Error(`Multipoint diffusion did not converge (relative residual ${relativeResidual}).`);
  if (!(pixels instanceof Float32Array) || pixels.length !== size * size * 4 || !pixels.every(Number.isFinite))
    throw new Error("Multipoint diffusion must return finite Float32 RGBA pixels.");
  if (!domain || ![domain.x,domain.y,domain.w,domain.h].every(Number.isFinite) || domain.w <= 0 || domain.h <= 0)
    throw new Error("Multipoint diffusion returned invalid field bounds.");
  remember(fields, `${size}:${key}`, {result, bytes:pixels.byteLength});
  return result;
}

/**
 * Command. Runs one synchronous interactive paint and records all visible fields.
 * An idle worker may refine cache misses; exporting outside this scope
 * always solves final quality synchronously. Nested paints restore their caller.
 * @param {Function} draw - Synchronous render command.
 * @returns {{key:string,features:object[],ready:boolean}[]} Sources and final-cache availability.
 */
export function withMultipointPreview(draw) {
  const previous = previewRequests, requests = new Map();
  previewRequests = requests;
  try { draw(); return [...requests.values()]; }
  finally { previewRequests = previous; }
}

/**
 * Command. Resolves an immutable float field, doing a deterministic solve on a miss.
 * @param {object[]} features - Parsed sources.
 * @returns {object} Solver result; (128,128,4) preview or (512,512,4) final RGBA.
 */
function fieldFor(features) {
  const key = multipointKey(features);
  const final = cached(fields, `${MULTIPOINT_FINAL_SIZE}:${key}`);
  if (previewRequests) previewRequests.set(key, {key,features,ready:!!final});
  if (final) return final.result;
  const size = previewRequests ? MULTIPOINT_PREVIEW_SIZE : MULTIPOINT_FINAL_SIZE;
  return cached(fields, `${size}:${key}`)?.result
    ?? rememberMultipointField(key, solveMultipoint(features, {size}));
}

/**
 * Command. Creates a native Skia shader and updates bounded float-image caches.
 * @param {object} CK - Caller's existing CanvasKit instance, never a new GL context.
 * @param {object} paint - Parsed Multipoint paint, with visible features.
 * @param {{x:number,y:number,w:number,h:number}} bounds - Local painted box.
 * @param {number} opacity - Item/group alpha multiplier.
 * @returns {object} Shader owned/deleted by the ordinary gradient caller.
 */
export function multipointShader(CK, paint, bounds, opacity) {
  const result = fieldFor(paint.features), {size,pixels,domain} = result;
  if (domain.w > 1 || domain.h > 1) warnOnce("multipoint-expanded-domain",
    "Multipoint sources outside the paint box expand its solve domain and reduce visible detail. Keep sources near the object for full resolution.");
  const key = `${size}:${multipointKey(paint.features)}`;
  if (!images.has(CK)) images.set(CK, new Map());
  const cache = images.get(CK);
  let entry = cached(cache,key);
  if (!entry) {
    // WebGL2 filters half floats natively; RGBA_F32 was silently uploaded as RGBA8.
    const half = Uint16Array.from(pixels,toHalf);
    const image = CK.MakeImage({width:size,height:size,colorType:CK.ColorType.RGBA_F16,
      alphaType:CK.AlphaType.Premul,colorSpace:CK.ColorSpace.SRGB},
    new Uint8Array(half.buffer),size * 4 * Uint16Array.BYTES_PER_ELEMENT);
    if (!image) throw new Error("Skia rejected the Multipoint RGBA_F16 image.");
    entry = remember(cache,key,{image,bytes:half.byteLength});
  }
  const width = bounds.w || Number.EPSILON, height = bounds.h || Number.EPSILON;
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
