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
 * ── RESOLUTION / ERROR TRADEOFF ───────────────────────────────────────────────
 * The mask is rasterized at FULL device resolution (1 texel per device px) — no
 * downscale, so there is no downscale error; a downscaled mask + upsampled SDF is a
 * drop-in future optimization but was not needed (shapes are a few hundred px and the
 * transform is O(n)). The distance transform (Felzenszwalb & Huttenlocher) is EXACT
 * Euclidean to the pixel grid; a sub-pixel correction from the antialiased coverage
 * (`d -= cov - 0.5`) places the zero crossing to within ~0.3 px of the true edge,
 * measured. That residual only widens/narrows the soft effect BAND by a fraction of a
 * pixel; it can never move the silhouette, because the CLIP (handleMaterialPaintShape)
 * is the true antialiased edge — the SDF only shapes what happens INSIDE it.
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

// ── the byte-keyed SDF image cache ────────────────────────────────────────────
// Building an SDF (rasterize + two distance transforms + a MakeImage upload) is not
// free, and a static shape fill asks for the SAME silhouette every frame. So the
// image is memoized, keyed by the shape's CANONICAL outline (its device path with the
// bounds origin subtracted, so a PAN — which shifts the whole path — is the same key)
// plus the raster size. This mirrors brush_strokes' byte-keyed stamp cache and the
// material raster cache's "the key is the bytes the producer sees" doctrine. LRU
// bounded; a fresh CanvasKit instance (node vs browser) invalidates the whole cache.
const SHAPE_SDF_CACHE_MAX = 24; // distinct (shape × size) silhouettes kept at once
const SHAPE_SDF_MAX_DIM = 4096; // device-px edge cap for the SDF raster (a surface factory clamps above this, which would silently mis-map the field)
const _sdfCache = new Map();    // key → { img, box }
let _sdfCK = null;              // the CanvasKit the cached images belong to
const _oversizeWarned = new Set(); // report an over-cap shape ONCE, never silently drop conformity

/**
 * Query→build (near-pure: reads/writes the module SDF cache; the IMAGE is a pure
 * function of the outline + size). The silhouette SDF for a shape, as
 * `{ img, box }` where `box` is the integer device-px rectangle {x0, y0, w, h} the
 * field covers and `img` is the RGBA_F16 CanvasKit Image (the CACHE owns it — do NOT
 * delete it). Returns null when the shape has no positive-area device bounds (nothing
 * to build).
 *
 * `devicePath` is the shape's outline already transformed to DEVICE space (the same
 * `clip` handleMaterialPaintShape builds). `ctx.makeSurface` rasterizes the coverage
 * mask; on the bare-node CLI that is a software surface, which is why this is testable
 * without a GPU. `margin` is how far OUTSIDE the outline the field stays valid (device
 * px) — a few px is plenty, since the effect band reads INTERIOR distances and only
 * coverage AA reads just-outside ones.
 *
 * @param {object} CanvasKit
 * @param {object} ctx - the paint context (needs makeSurface, deviceW, deviceH)
 * @param {object} devicePath - a CanvasKit.Path in device space
 * @param {number} margin - outward validity margin in device px
 * @returns {{img: object, box: {x0: number, y0: number, w: number, h: number}}|null}
 */
export function getShapeSdf(CanvasKit, ctx, devicePath, margin) {
  if (_sdfCK !== CanvasKit) { clearShapeSdfCache(); _sdfCK = CanvasKit; }
  const b = devicePath.getBounds(); // [l, t, r, b] device px
  const m = Math.ceil(margin) + 1;  // +1 for the AA band
  const x0 = Math.floor(b[0]) - m, y0 = Math.floor(b[1]) - m;
  const x1 = Math.ceil(b[2]) + m, y1 = Math.ceil(b[3]) + m;
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null; // offscreen / zero-area: nothing to conform (a legitimate no-op)
  if (w > SHAPE_SDF_MAX_DIM || h > SHAPE_SDF_MAX_DIM) {
    // Over the raster cap (a huge shape zoomed right in): the material fill FALLS BACK to
    // its analytic-bbox edge (non-conforming) rather than mis-mapping a clamped SDF — but
    // that fallback is REPORTED, never silent, so a lost conformity is discoverable.
    const wkey = `${w}x${h}`;
    if (!_oversizeWarned.has(wkey)) {
      _oversizeWarned.add(wkey);
      console.warn(`shape_sdf.getShapeSdf: shape device bounds ${wkey} exceed the ${SHAPE_SDF_MAX_DIM}px SDF cap — this fill falls back to its analytic-bbox edge (NOT shape-conforming) for this shape/zoom. Zoom out to restore conformity.`);
    }
    return null;
  }

  // CANONICAL key: the outline in box-local coordinates (origin subtracted) so a pan
  // does not change it, plus the size. Built through a PathBuilder (Path itself has no
  // transform in this CanvasKit build; the shapeOpDevicePath precedent transforms on the
  // builder), which is also the path we rasterize.
  const lb = new CanvasKit.PathBuilder();
  lb.addPath(devicePath);
  lb.transform(CanvasKit.Matrix.translated(-x0, -y0));
  const local = lb.detach();
  lb.delete();
  const key = `${w}x${h}|${local.toSVGString()}`;
  const hit = _sdfCache.get(key);
  if (hit) {
    local.delete();
    _sdfCache.delete(key); _sdfCache.set(key, hit); // LRU touch
    return { img: hit.img, box: { x0, y0, w, h } };
  }

  // Rasterize the coverage mask: the box-local path filled white on a transparent
  // surface, read back as alpha.
  const surf = ctx.makeSurface(w, h);
  if (!surf) throw new Error(`shape_sdf.getShapeSdf: makeSurface(${w}x${h}) returned null`);
  const canvas = surf.getCanvas();
  canvas.clear(CanvasKit.Color4f(0, 0, 0, 0));
  const paint = new CanvasKit.Paint();
  paint.setColor(CanvasKit.Color4f(1, 1, 1, 1));
  paint.setAntiAlias(true);
  canvas.drawPath(local, paint);
  surf.flush();
  const info = { width: w, height: h, alphaType: CanvasKit.AlphaType.Unpremul, colorType: CanvasKit.ColorType.RGBA_8888, colorSpace: CanvasKit.ColorSpace.SRGB };
  const snap = surf.makeImageSnapshot();
  const rgba = snap.readPixels(0, 0, info);
  if (!rgba) throw new Error("shape_sdf.getShapeSdf: readPixels returned null");
  snap.delete(); paint.delete(); surf.dispose(); local.delete();

  const cov = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) cov[i] = rgba[i * 4 + 3] / 255; // alpha channel = coverage
  const sdf = signedDistanceField(cov, w, h);
  const f16 = sdfToF16(sdf, w, h);
  const imgInfo = { width: w, height: h, alphaType: CanvasKit.AlphaType.Unpremul, colorType: CanvasKit.ColorType.RGBA_F16, colorSpace: CanvasKit.ColorSpace.SRGB };
  const img = CanvasKit.MakeImage(imgInfo, new Uint8Array(f16.buffer), w * 4 * 2);
  if (!img) throw new Error("shape_sdf.getShapeSdf: MakeImage(RGBA_F16) returned null");

  _sdfCache.set(key, { img, box: { x0, y0, w, h } });
  while (_sdfCache.size > SHAPE_SDF_CACHE_MAX) {
    const oldest = _sdfCache.keys().next().value;
    _sdfCache.get(oldest).img.delete();
    _sdfCache.delete(oldest);
  }
  return { img, box: { x0, y0, w, h } };
}

/** Command. Drops every cached SDF image (freeing their textures). Called on a
 * CanvasKit instance change and exposed for tests that assert a clean slate. */
export function clearShapeSdfCache() {
  for (const e of _sdfCache.values()) e.img.delete();
  _sdfCache.clear();
}
