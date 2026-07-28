/**
 * THE SILHOUETTE SIGNED-DISTANCE-FIELD child — the machinery that lets a material
 * FILL conform its EDGE EFFECTS to the real shape outline instead of the analytic
 * bbox rectangle its shader was built for.
 *
 * ── THE PROBLEM IT SOLVES ─────────────────────────────────────────────────────
 * A material fill (glass/CRT/corkboard/… on a gear or star) is CLIPPED to the true
 * outline, so containment holds. But every material's rim bevel / frame / vignette /
 * dome came from the shader's OWN analytic rounded-rect SDF over the bbox — so a gear
 * got a rectangle's rim, cut to a gear. Containment held; CONFORMITY did not (a dark
 * cork FRAME drew a square inside the gear; glass' sheen ran as a bbox band with no
 * rim on the teeth).
 *
 * ── THE FIX ───────────────────────────────────────────────────────────────────
 * Rasterize the shape's DEVICE-space outline once into a small offscreen COVERAGE
 * mask, compute an exact Euclidean SIGNED distance field from it (negative inside,
 * device px), and hand it to the fill shader as an extra `uniform shader shapeSdf`
 * child. A material that DECLARES `usesShapeSdf: true` (and provides a `fillSksl`
 * variant) reads `shapeSdf.eval(p).r` in place of its analytic edge distance, and
 * takes its surface normal from the child's central difference — so the rim / frame /
 * dome follow every tooth and notch. Materials that do NOT declare it are untouched:
 * their fill still uses the base `sksl` and no child is built (byte-identical).
 *
 * ── RESOLUTION / ERROR TRADEOFF (ZOOM-INVARIANT) ──────────────────────────────
 * The mask is rasterized ONCE per GEOMETRY at a CAPPED resolution in the shape's LOCAL
 * space (longest edge = BUILD_MAX_EDGE build px), NOT at device resolution — so a zoom
 * never rebuilds it, the old 4096 device-px cap and its conformity-fallback report are
 * gone, and a shape zoomed past its build resolution is UPSAMPLED by the child's linear
 * filter. Distances are stored in BUILD px and multiplied to DEVICE px at sample time
 * (see the distance-scaler section): signed distance scales linearly under the similarity
 * transform, so this is exact up to the build grid. The distance transform (Felzenszwalb
 * & Huttenlocher) is EXACT Euclidean to that grid; a sub-pixel correction from the
 * antialiased coverage (`d -= cov - 0.5`) places the zero crossing to within ~0.3 build
 * px of the true edge. A distance field upsamples far better than a coverage mask (the
 * bevel is soft and the field is near-linear across it), so the only visible cost at high
 * zoom is a gently softer rim, never a stairstepped silhouette — the CLIP
 * (handleMaterialPaintShape) is still the true antialiased edge; the SDF only shapes what
 * happens INSIDE it.
 *
 * The image is RGBA_F16 (half-float): half-float linear filtering is core in WebGL2
 * (so the child samples smoothly on the runtime Skia/GL surface) and its precision is
 * finest near zero — exactly the small interior distances the normal is differenced
 * from. Distance is written to R/G/B (A = 1, UNPREMUL) so a `.r` read is the raw
 * signed distance regardless of alpha.
 *
 * DOM-free at import (pure math + CanvasKit calls only; no browser API), so it runs on
 * the bare-node software surface the CLI uses, where the whole conformity fix is
 * testable without a GPU.
 */

const EDT_INF = 1e20; // "no seed yet" squared distance for the distance transform

/**
 * Pure function. The half-float (IEEE-754 binary16) bit pattern of a JS number, as a
 * uint16 — the encoding CanvasKit.MakeImage expects for an RGBA_F16 image. Handles
 * sign, subnormals, overflow→Inf and the exponent rebias; NaN maps to a canonical NaN.
 *
 * @param {number} v - a finite (or Inf/NaN) float
 * @returns {number} the 16 bits of its half-float representation, 0..65535
 *
 * @example toHalf(0) // 0
 * @example toHalf(1) // 15360   (0x3C00)
 * @example toHalf(-2) // 49152  (0xC000: sign + exponent for 2)
 * @example toHalf(0.5) // 14336 (0x3800)
 */
export function toHalf(v) {
  if (Number.isNaN(v)) return 0x7e00;
  const sign = v < 0 || Object.is(v, -0) ? 0x8000 : 0;
  v = Math.abs(v);
  if (v === 0) return sign;
  if (!Number.isFinite(v)) return sign | 0x7c00;
  let e = Math.floor(Math.log2(v));
  if (e < -24) return sign;                       // underflow to zero
  if (e < -14) {                                  // subnormal
    const m = Math.round(v / 2 ** -24);
    return sign | (m & 0x3ff);
  }
  if (e > 15) return sign | 0x7c00;               // overflow to Inf
  let mant = Math.round((v / 2 ** e - 1) * 1024);
  if (mant === 1024) { e += 1; mant = 0; }        // rounding carried into the exponent
  if (e > 15) return sign | 0x7c00;
  return sign | ((e + 15) << 10) | mant;
}

/**
 * Pure function (mutates the scratch arrays it is given). One-dimensional squared
 * Euclidean distance transform — the Felzenszwalb & Huttenlocher lower-envelope
 * algorithm, O(n). `f[q]` is the squared seed value at column q (0 at a seed, EDT_INF
 * elsewhere); `d[q]` receives the squared distance to the nearest seed.
 *
 * @param {Float64Array} f - input squared seed values, length n
 * @param {Float64Array} d - output squared distances, length n
 * @param {Int32Array} v - scratch: parabola vertex indices, length >= n
 * @param {Float64Array} z - scratch: parabola break points, length >= n+1
 * @param {number} n - the row/column length
 *
 * @example
 * // a single seed at index 2 of a length-5 row: squared distances 4,1,0,1,4
 * const f=Float64Array.of(1e20,1e20,0,1e20,1e20), d=new Float64Array(5);
 * edt1d(f,d,new Int32Array(5),new Float64Array(6),5); Array.from(d) // [4, 1, 0, 1, 4]
 */
export function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0; z[0] = -EDT_INF; z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/**
 * Pure function (allocates its result). The 2D squared Euclidean distance transform
 * of a binary seed grid: seeds are the cells where `seeded(i)` is true, and every
 * cell receives the squared distance to the nearest seed. Column pass then row pass,
 * each an `edt1d`.
 *
 * @param {(i: number) => boolean} seeded - is grid cell i a seed?
 * @param {number} w - grid width
 * @param {number} h - grid height
 * @returns {Float64Array} squared distances, length w*h (row-major)
 */
function edt2d(seeded, w, h) {
  const g = new Float64Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w * h; i++) g[i] = seeded(i) ? 0 : EDT_INF;
  for (let x = 0; x < w; x++) {                    // columns
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {                    // rows
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = g[row + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) g[row + x] = d[x];
  }
  return g;
}

/**
 * Pure function (allocates its result). A SIGNED distance field (device px, NEGATIVE
 * inside, positive outside) from an antialiased COVERAGE mask. Inside = coverage >=
 * 0.5. The magnitude is the exact Euclidean distance to the opposite region (two
 * `edt2d` passes: distance-to-outside for inside cells, distance-to-inside for outside
 * cells), minus the antialias sub-pixel correction `cov - 0.5` that nudges the zero
 * crossing onto the true edge rather than the pixel-center boundary.
 *
 * @param {Float32Array|number[]} cov - coverage 0..1, length w*h (row-major)
 * @param {number} w - width in px
 * @param {number} h - height in px
 * @returns {Float32Array} signed distances, length w*h
 *
 * @example
 * // a 2x2 all-inside patch: every cell is inside, nearest outside is off-grid so the
 * // distance is the grid diagonal; the sign is negative. Just check the sign + centre.
 * const sdf = signedDistanceField(Float32Array.of(1,1,1,1), 2, 2); sdf[0] < 0 // true
 * @example
 * // a single inside cell in a 3x3 of outside: centre is inside (neg), corners outside (pos)
 * const c = Float32Array.of(0,0,0, 0,1,0, 0,0,0);
 * const s = signedDistanceField(c, 3, 3); [s[4] < 0, s[0] > 0] // [true, true]
 */
export function signedDistanceField(cov, w, h) {
  const inside = (i) => cov[i] >= 0.5;
  const distToOutside = edt2d((i) => !inside(i), w, h); // seeds = outside cells
  const distToInside = edt2d((i) => inside(i), w, h);   // seeds = inside cells
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = inside(i) ? -Math.sqrt(distToOutside[i]) : Math.sqrt(distToInside[i]);
    out[i] = d - (cov[i] - 0.5); // antialias sub-pixel edge correction
  }
  return out;
}

/**
 * Pure function. An RGBA_F16 byte buffer (Uint16 view) carrying the signed distances
 * in R=G=B, A=1, so a child shader's `.r` read is the raw distance and half-float
 * LINEAR filtering interpolates the field smoothly. Unpremultiplied (see the module
 * header) so A never scales the stored distance.
 *
 * @param {Float32Array} sdf - signed distances, length w*h
 * @param {number} w
 * @param {number} h
 * @returns {Uint16Array} length w*h*4 (RGBA half-float)
 */
function sdfToF16(sdf, w, h) {
  const out = new Uint16Array(w * h * 4);
  const one = toHalf(1);
  for (let i = 0; i < w * h; i++) {
    const hv = toHalf(sdf[i]);
    const o = i * 4;
    out[o] = hv; out[o + 1] = hv; out[o + 2] = hv; out[o + 3] = one;
  }
  return out;
}

// ── the GEOMETRY-keyed, ZOOM-INVARIANT SDF image cache ────────────────────────
// Building an SDF (rasterize + two distance transforms + a MakeImage upload) is not
// free, and the OLD cache keyed it on the shape's DEVICE size — so EVERY zoom step was a
// cache miss and a full-resolution rebuild, and past a 4096 device-px cap conformity
// degraded to the analytic bbox with a (loud) console report. Both defects are gone:
//
//   · The field is built ONCE per GEOMETRY, at a capped resolution in the shape's LOCAL
//     space (its longest edge maps to BUILD_MAX_EDGE build px), and cached by that local
//     outline alone. A pan never changed the key before; a ZOOM does not now either,
//     because neither touches the local outline.
//   · The device PLACEMENT rides the returned `sampleMatrix` (texel→device, carrying the
//     zoom/rotation), and the field's BUILD-px distances are turned into DEVICE px at
//     SAMPLE time by ONE multiply — `distScale = deviceScale/buildScale` — applied by the
//     makeShapeSdfChild wrapper shader. Signed distance scales LINEARLY under a similarity
//     transform, so this is exact up to the build resolution; the only cost is the field's
//     upsample at high zoom, and a distance field upsamples far better than a coverage mask
//     (a soft bevel reads clean well past 8×). There is therefore NO device-px cap to hit
//     and nothing to report — any zoom reuses the same build.
//
// LRU bounded; a fresh CanvasKit instance (node vs browser) invalidates the whole cache.
const BUILD_MAX_EDGE = 1024;       // the SDF's longest edge, in build px (zoom-invariant)
const SHAPE_SDF_BUILD_MARGIN = 4;  // build-px validity band outside the outline (AA/refraction read just-outside it; TileMode.Clamp covers any farther reach)
const SHAPE_SDF_CACHE_MAX = 12;    // distinct geometries kept at once (each ≤ ~BUILD_MAX_EDGE² F16)
const _sdfCache = new Map();       // token → { img, buildW, buildH }
let _sdfCK = null;                 // the CanvasKit the cached images (and the scale effect) belong to

/**
 * Pure function. The uniform scale factor of a similarity (or reflection) matrix — the
 * device px per unit length its upper-2×2 block applies — from a CanvasKit.Matrix
 * (row-major [sx, kx, tx, ky, sy, ty, …]). A reflection (negative determinant) returns
 * its POSITIVE magnitude, which is exactly what a distance scale needs.
 *
 * @param {number[]} m - a length-9 CanvasKit.Matrix
 * @returns {number} sqrt(|sx·sy − kx·ky|)
 *
 * @example similarityScale([2, 0, 0, 0, 2, 0, 0, 0, 1]) // 2
 * @example similarityScale([0, -3, 0, 3, 0, 0, 0, 0, 1]) // 3
 */
export function similarityScale(m) {
  return Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3]));
}

/**
 * Pure function. The build-space raster dimensions + scale for a shape's LOCAL bounds:
 * the longer local edge maps to `buildMax` build px (so the field is zoom-invariant and
 * capped), the shorter keeps aspect, and a `margin` band is added on all four sides. The
 * returned `buildScale` (build px per local unit) turns local geometry into the
 * build-space path and, against the device scale, drives the sample-time distance multiply.
 *
 * @param {number} localW - local-space bounds width
 * @param {number} localH - local-space bounds height
 * @param {number} buildMax - the longest build edge, in px
 * @param {number} margin - build-px band added on all four sides
 * @returns {{buildW: number, buildH: number, buildScale: number}}
 *
 * @example sdfBuildDims(100, 50, 1000, 5) // {buildW: 1010, buildH: 510, buildScale: 10}
 * @example sdfBuildDims(40, 80, 800, 0) // {buildW: 400, buildH: 800, buildScale: 10}
 */
export function sdfBuildDims(localW, localH, buildMax, margin) {
  const buildScale = buildMax / Math.max(localW, localH);
  return {
    buildW: Math.ceil(localW * buildScale) + 2 * margin,
    buildH: Math.ceil(localH * buildScale) + 2 * margin,
    buildScale,
  };
}

/**
 * Pure function. FNV-1a hash of a string as an 8-char hex — the compact geometry token
 * derived from the build-space outline's SVG (so a pan/zoom, which do not change the
 * local outline, share one field and one token).
 *
 * @example fnv1aHex("AB") // "2cd5218a"
 */
function fnv1aHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Query→build (near-pure: reads/writes the module SDF cache; the IMAGE is a pure function
 * of the local outline + build size). The silhouette SDF for a shape, as
 * `{ img, buildW, buildH, sampleMatrix, distScale, token }`:
 *   · `img` — the RGBA_F16 CanvasKit Image of the BUILD-space field (distances in BUILD
 *     px, NEGATIVE inside). The CACHE owns it — do NOT delete it.
 *   · `sampleMatrix` — maps an image TEXEL to its DEVICE coordinate (so the child image
 *     shader's localMatrix places the field under the current zoom/rotation).
 *   · `distScale` — multiply a sampled BUILD-px distance by this to get DEVICE px
 *     (deviceScale/buildScale); applied by makeShapeSdfChild.
 *   · `token` — the geometry identity, stable across pan/zoom, for the raster cache key.
 * Returns null when the shape has no positive-area local bounds (nothing to build).
 *
 * `localPath` is the shape's outline in LOCAL (pre-device) space — zoom-invariant, which
 * is what makes the field cacheable across zoom (shapeOpLocalPath builds it). `deviceM`
 * is the local→device similarity (deviceMatrix) that positions and scales that outline on
 * screen this frame. `ctx.makeSurface` rasterizes the build-space coverage mask; on the
 * bare-node CLI that is a software surface, which is why this is testable without a GPU.
 *
 * @param {object} CanvasKit
 * @param {object} ctx - the paint context (needs makeSurface)
 * @param {object} localPath - a CanvasKit.Path in local space
 * @param {number[]} deviceM - the local→device CanvasKit.Matrix
 * @returns {{img: object, buildW: number, buildH: number, sampleMatrix: number[], distScale: number, token: string}|null}
 */
export function getShapeSdf(CanvasKit, ctx, localPath, deviceM) {
  if (_sdfCK !== CanvasKit) { clearShapeSdfCache(); _sdfCK = CanvasKit; }
  const lb = localPath.getBounds(); // [l, t, r, b] local units
  const localW = lb[2] - lb[0], localH = lb[3] - lb[1];
  if (localW <= 0 || localH <= 0) return null; // degenerate / zero-area: nothing to conform (a legitimate no-op)

  const m = SHAPE_SDF_BUILD_MARGIN;
  const { buildW, buildH, buildScale } = sdfBuildDims(localW, localH, BUILD_MAX_EDGE, m);

  // The device-independent bind data, computed per call (cheap — a matrix multiply and a
  // scalar): where THIS frame's zoom puts the (cached) field, and by how much to scale its
  // stored build-px distances back into device px.
  const deviceScale = similarityScale(deviceM);
  const distScale = deviceScale / buildScale;
  // sampleMatrix (texel → device) = deviceM · translate(l,t) · scale(1/buildScale) · translate(-m,-m):
  // texel → build-space content → local (undo the build placement below) → device.
  const sampleMatrix = CanvasKit.Matrix.multiply(
    deviceM,
    CanvasKit.Matrix.translated(lb[0], lb[1]),
    CanvasKit.Matrix.scaled(1 / buildScale, 1 / buildScale),
    CanvasKit.Matrix.translated(-m, -m),
  );

  // The build-space outline: the local path scaled by buildScale into a buildW×buildH box
  // with the margin as origin. It is BOTH the raster we fill AND (as SVG) the cache token.
  const buildMatrix = CanvasKit.Matrix.multiply(
    CanvasKit.Matrix.translated(m, m),
    CanvasKit.Matrix.scaled(buildScale, buildScale),
    CanvasKit.Matrix.translated(-lb[0], -lb[1]),
  );
  const pb = new CanvasKit.PathBuilder();
  pb.addPath(localPath);
  pb.transform(buildMatrix);
  const buildPath = pb.detach();
  pb.delete();
  const token = `${buildW}x${buildH}|${fnv1aHex(buildPath.toSVGString())}`;

  const hit = _sdfCache.get(token);
  if (hit) {
    buildPath.delete();
    _sdfCache.delete(token); _sdfCache.set(token, hit); // LRU touch
    return { img: hit.img, buildW, buildH, sampleMatrix, distScale, token };
  }

  // Rasterize the coverage mask: the build-space path filled white on a transparent
  // surface, read back as alpha.
  const surf = ctx.makeSurface(buildW, buildH);
  if (!surf) throw new Error(`shape_sdf.getShapeSdf: makeSurface(${buildW}x${buildH}) returned null`);
  const canvas = surf.getCanvas();
  canvas.clear(CanvasKit.Color4f(0, 0, 0, 0));
  const paint = new CanvasKit.Paint();
  paint.setColor(CanvasKit.Color4f(1, 1, 1, 1));
  paint.setAntiAlias(true);
  canvas.drawPath(buildPath, paint);
  surf.flush();
  const info = { width: buildW, height: buildH, alphaType: CanvasKit.AlphaType.Unpremul, colorType: CanvasKit.ColorType.RGBA_8888, colorSpace: CanvasKit.ColorSpace.SRGB };
  const snap = surf.makeImageSnapshot();
  const rgba = snap.readPixels(0, 0, info);
  if (!rgba) throw new Error("shape_sdf.getShapeSdf: readPixels returned null");
  snap.delete(); paint.delete(); surf.dispose(); buildPath.delete();

  const cov = new Float32Array(buildW * buildH);
  for (let i = 0; i < buildW * buildH; i++) cov[i] = rgba[i * 4 + 3] / 255; // alpha channel = coverage
  const sdf = signedDistanceField(cov, buildW, buildH);
  const f16 = sdfToF16(sdf, buildW, buildH);
  const imgInfo = { width: buildW, height: buildH, alphaType: CanvasKit.AlphaType.Unpremul, colorType: CanvasKit.ColorType.RGBA_F16, colorSpace: CanvasKit.ColorSpace.SRGB };
  const img = CanvasKit.MakeImage(imgInfo, new Uint8Array(f16.buffer), buildW * 4 * 2);
  if (!img) throw new Error("shape_sdf.getShapeSdf: MakeImage(RGBA_F16) returned null");

  _sdfCache.set(token, { img, buildW, buildH });
  while (_sdfCache.size > SHAPE_SDF_CACHE_MAX) {
    const oldest = _sdfCache.keys().next().value;
    _sdfCache.get(oldest).img.delete();
    _sdfCache.delete(oldest);
  }
  return { img, buildW, buildH, sampleMatrix, distScale, token };
}

// ── the sample-time DISTANCE SCALER ───────────────────────────────────────────
// The stored field is in BUILD px; every material fillSksl reads `shapeSdf.eval(p).r` as
// a DEVICE-px distance (its uEdgeFalloff/rim thresholds are device px and scale with
// zoom). Rather than re-encode the image per zoom — or edit four material shaders — the
// `shapeSdf` child is this tiny pass-through RuntimeEffect: it samples the build-space
// image (whose OWN localMatrix carries the device→build coordinate map) and multiplies
// the distance by uDistScale to hand back device px. The material shaders are untouched;
// a zoom only changes the uDistScale uniform and the child localMatrix, never the image.
const SDF_SCALE_SKSL = `
uniform shader sdfImage;    // the build-space silhouette SDF (distance in BUILD px)
uniform float uDistScale;   // BUILD px -> DEVICE px (deviceScale / buildScale)
half4 main(float2 p) {
  half d = half(sdfImage.eval(p).r * uDistScale);
  return half4(d, d, d, 1.0);
}`;

let _scaleEff = null; // the compiled SDF_SCALE_SKSL, memoized per CanvasKit (with the cache)

/** Query→build (near-pure: memoizes the compiled effect per CanvasKit). The distance-scaler
 * RuntimeEffect, compiled once. */
function scaleEffect(CanvasKit) {
  if (_sdfCK !== CanvasKit) { clearShapeSdfCache(); _sdfCK = CanvasKit; }
  if (_scaleEff) return _scaleEff;
  let err = "";
  const eff = CanvasKit.RuntimeEffect.Make(SDF_SCALE_SKSL, (e) => { err = e; });
  if (!eff) throw new Error(`shape_sdf: SDF distance-scaler failed to compile:\n${err}`);
  _scaleEff = eff;
  return eff;
}

/**
 * Query→build (allocates a shader the CALLER must delete). The `shapeSdf` child shader for
 * a material fill: the geometry-keyed build-space SDF image, wrapped in the distance
 * scaler so an `.eval(p).r` read returns DEVICE-px signed distance. `extraMatrix` (or
 * null) is prepended to the field's texel→device sampleMatrix — pass
 * `translate(-region.x0, -region.y0)` when the parent shader is evaluated in REGION-LOCAL
 * device space (the foreground raster path), null when it is evaluated at the DEVICE root
 * (the backdrop path).
 *
 * @param {object} CanvasKit
 * @param {object} sdf - a getShapeSdf() result ({img, sampleMatrix, distScale, …})
 * @param {number[]|null} extraMatrix - a CanvasKit.Matrix prepended to sampleMatrix, or null
 * @returns {object} a CanvasKit shader (delete after building the parent shader)
 */
export function makeShapeSdfChild(CanvasKit, sdf, extraMatrix) {
  const localM = extraMatrix ? CanvasKit.Matrix.multiply(extraMatrix, sdf.sampleMatrix) : sdf.sampleMatrix;
  const imgChild = sdf.img.makeShaderOptions(CanvasKit.TileMode.Clamp, CanvasKit.TileMode.Clamp, CanvasKit.FilterMode.Linear, CanvasKit.MipmapMode.None, localM);
  const shader = scaleEffect(CanvasKit).makeShaderWithChildren(new Float32Array([sdf.distScale]), [imgChild]);
  imgChild.delete();
  if (!shader) throw new Error("shape_sdf.makeShapeSdfChild: makeShaderWithChildren returned null");
  return shader;
}

/** Command. Drops every cached SDF image (freeing their textures) and forgets the
 * compiled scaler effect. Called on a CanvasKit instance change and exposed for tests
 * that assert a clean slate. */
export function clearShapeSdfCache() {
  for (const e of _sdfCache.values()) e.img.delete();
  _sdfCache.clear();
  _scaleEff = null;
}
