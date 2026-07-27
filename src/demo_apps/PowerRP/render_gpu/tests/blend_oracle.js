/**
 * THE BLEND-MODE ORACLE — an INDEPENDENT JavaScript implementation of every
 * blend mode's documented formula, plus the PNG read-back the pixel suites need.
 * A test-support module (the pdf_scenes.js / svg_scenes.js precedent): pure,
 * side-effect-free, no CanvasKit, so importing it costs nothing and three suites
 * share ONE definition of "correct".
 *
 * IT IS DELIBERATELY NOT DERIVED FROM THE SHADERS. Every function here is
 * transcribed from PDF 32000-1 §11.3.5 (which the W3C compositing spec restates)
 * and, for the modes no standard defines, from Photoshop's documented behaviour.
 * If it were a transliteration of render_gpu/skia/blend_modes.js it would agree
 * with a wrong shader, and the suites that consume it would prove nothing.
 *
 * Consumers:
 *   blend_modes_test.js         — formula correctness at the blender level
 *   blend_contact_sheet.js      — the labelled sheet + its own pixel assertions
 *   blend_export_parity_test.js — PDF/SVG export reproduces the editor
 *
 * Node-only for decodePngRGBA (uses `zlib`); the formula half is plain pure JS.
 */

import zlib from "zlib";

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Pure function. Lifts a per-channel blend function to an RGB triple, clamping.
 * @example perChannel((b, s) => b * s)([0.5, 0.5, 0.5], [0.5, 1, 0]) // [0.25, 0.5, 0]
 */
const perChannel = (f) => (Cb, Cs) => [0, 1, 2].map((i) => clamp01(f(Cb[i], Cs[i])));

// ── PDF/W3C separable primitives, spelled as the spec states them ─────────────
const colorBurnCh = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const colorDodgeCh = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const softLightCh = (b, s) => {
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b);
};
const hardLightCh = (b, s) => (s <= 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b));

// ── PDF/W3C non-separable primitives (PDF 32000-1 §11.3.5.3) ──────────────────
// LUM_WEIGHTS are the spec's own luminosity coefficients, which is what Skia's
// Hue/Saturation/Color/Luminosity use. Note these are NOT what Darker Color /
// Lighter Color compare — see channelTotal.
const LUM_WEIGHTS = [0.3, 0.59, 0.11];
const lum = (C) => LUM_WEIGHTS[0] * C[0] + LUM_WEIGHTS[1] * C[1] + LUM_WEIGHTS[2] * C[2];
const sat = (C) => Math.max(...C) - Math.min(...C);

/** Pure function. W3C ClipColor: pulls an out-of-gamut colour back into 0..1 while
 * preserving its luminosity.
 * @example clipColor([0.5, 0.5, 0.5]) // [0.5, 0.5, 0.5] (in gamut: unchanged)
 * @example clipColor([1.2, 0.5, 0.5]).every((v) => v <= 1) // true
 */
export function clipColor(C) {
  const l = lum(C), n = Math.min(...C), x = Math.max(...C);
  let out = [...C];
  if (n < 0) out = out.map((c) => l + ((c - l) * l) / (l - n));
  if (x > 1) out = out.map((c) => l + ((c - l) * (1 - l)) / (x - l));
  return out;
}

/** Pure function. W3C SetLum: `C` shifted to luminosity `l`, then gamut-clipped.
 * @example setLum([1, 0, 0], 0.3).map((v) => +v.toFixed(3)) // [1, 0, 0] (red's luminosity already IS 0.3)
 * @example setLum([1, 0, 0], 0.8).map((v) => +v.toFixed(2)) // [1, 0.71, 0.71] (lightened, hue kept)
 */
export const setLum = (C, l) => clipColor(C.map((c) => c + (l - lum(C))));

/** Pure function. W3C SetSat: `C` rescaled to saturation `s` about its own
 * min/max; a colour with no saturation to rescale becomes black.
 * @example setSat([0.8, 0.4, 0.2], 0.5) // [0.5, 0.16666666666666669, 0]
 * @example setSat([0.4, 0.4, 0.4], 0.5) // [0, 0, 0] (nothing to rescale)
 */
export function setSat(C, s) {
  const mn = Math.min(...C), mx = Math.max(...C);
  return C.map((c) => (mx > mn ? ((c - mn) * s) / (mx - mn) : 0));
}

/** Pure function. Total of all channel values — Adobe's documented comparison key
 * for Darker Color / Lighter Color ("compares the total of all channel values"),
 * i.e. EQUAL weights, deliberately not LUM_WEIGHTS.
 * @example channelTotal([0.25, 0.5, 0.75]) // 1.5
 * @example channelTotal([1, 1, 1]) // 3
 */
export const channelTotal = (C) => C[0] + C[1] + C[2];

/**
 * blend id → B(Cb, Cs): the mode's blend function on unpremultiplied 0..1 RGB
 * triples (Cb = backdrop, Cs = source). Keys match core/properties.js BLEND_MODES.
 *
 * "add" is Photoshop's Linear Dodge and Skia's Plus. At FULL alpha it equals
 * clamp(Cb + Cs), which is what this entry computes; at partial alpha Plus is
 * premultiplied addition with alpha min(1, αs+αb), NOT the union composite every
 * other mode uses, so callers must only compare "add" where both sides are opaque.
 */
export const blendReference = {
  normal: (Cb, Cs) => Cs,
  darken: perChannel((b, s) => Math.min(b, s)),
  multiply: perChannel((b, s) => b * s),
  colorBurn: perChannel(colorBurnCh),
  linearBurn: perChannel((b, s) => b + s - 1),
  darkerColor: (Cb, Cs) => (channelTotal(Cs) < channelTotal(Cb) ? Cs : Cb),
  lighten: perChannel((b, s) => Math.max(b, s)),
  screen: perChannel((b, s) => b + s - b * s),
  colorDodge: perChannel(colorDodgeCh),
  add: perChannel((b, s) => b + s),
  lighterColor: (Cb, Cs) => (channelTotal(Cs) > channelTotal(Cb) ? Cs : Cb),
  overlay: perChannel((b, s) => hardLightCh(s, b)), // Hard Light with the layers swapped
  softLight: perChannel(softLightCh),
  hardLight: perChannel(hardLightCh),
  vividLight: perChannel((b, s) => (s <= 0.5 ? colorBurnCh(b, 2 * s) : colorDodgeCh(b, 2 * s - 1))),
  linearLight: perChannel((b, s) => b + 2 * s - 1),
  pinLight: perChannel((b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1))),
  hardMix: perChannel((b, s) => (b + s >= 1 ? 1 : 0)),
  difference: perChannel((b, s) => Math.abs(b - s)),
  exclusion: perChannel((b, s) => b + s - 2 * b * s),
  subtract: perChannel((b, s) => b - s),
  divide: perChannel((b, s) => (s <= 0 ? 1 : b / s)),
  hue: (Cb, Cs) => setLum(setSat(Cs, sat(Cb)), lum(Cb)),
  saturation: (Cb, Cs) => setLum(setSat(Cb, sat(Cs)), lum(Cb)),
  color: (Cb, Cs) => setLum(Cs, lum(Cb)),
  luminosity: (Cb, Cs) => setLum(Cb, lum(Cs)),
};

/**
 * Pure function. The W3C union composite of `src` over `dst` under `mode`, in
 * unpremultiplied [r,g,b,a] 0..1 — the value a rendered pixel is compared against.
 *
 *   co = (1-αb)·αs·Cs + (1-αs)·αb·Cb + αs·αb·B(Cb,Cs)   (premultiplied)
 *   αo = αs + αb - αs·αb
 *
 * @param {string} mode a BLEND_MODES id
 * @param {number[]} src [r,g,b,a] source, unpremultiplied 0..1
 * @param {number[]} dst [r,g,b,a] backdrop, unpremultiplied 0..1
 * @returns {number[]} [r,g,b,a] result, unpremultiplied 0..1
 *
 * @example compositeReference("multiply", [0.5, 1, 1, 1], [0.5, 0.5, 1, 1]) // [0.25, 0.5, 1, 1]
 * @example compositeReference("normal", [1, 0, 0, 1], [0, 0, 1, 1]) // [1, 0, 0, 1] (opaque source wins)
 * @example compositeReference("difference", [1, 1, 1, 1], [0.25, 0.5, 0.75, 1]) // [0.75, 0.5, 0.25, 1] (white source inverts)
 */
export function compositeReference(mode, src, dst) {
  const B = blendReference[mode];
  if (!B) throw new Error(`blend_oracle: no reference formula for "${mode}"`);
  const sa = src[3], da = dst[3];
  const Cs = src.slice(0, 3), Cb = dst.slice(0, 3);
  const b = B(Cb, Cs);
  const ao = sa + da - sa * da;
  const co = [0, 1, 2].map((i) => (1 - da) * sa * Cs[i] + (1 - sa) * da * Cb[i] + sa * da * b[i]);
  return [...(ao > 0 ? co.map((v) => v / ao) : [0, 0, 0]), ao];
}

/**
 * Pure function. Decodes a non-interlaced 8-bit RGBA PNG to
 * {width, height, data} with rows un-filtered. Deliberately minimal: it exists
 * only to read back what these suites just rendered, so any other colour type /
 * bit depth / interlace is a loud error rather than a silent guess.
 *
 * @param {Uint8Array} bytes an encoded PNG
 * @returns {{width: number, height: number, data: Uint8Array}} row-major RGBA
 *
 * @example // decodePngRGBA(await renderToPng(...)).data.length === width * height * 4
 */
export function decodePngRGBA(bytes) {
  const buf = Buffer.from(bytes);
  const SIGNATURE = "89504e470d0a1a0a";
  if (buf.subarray(0, 8).toString("hex") !== SIGNATURE) throw new Error("decodePngRGBA: not a PNG");
  let off = 8, width = 0, height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8], colorType = body[9], interlace = body[12];
      if (depth !== 8 || colorType !== 6 || interlace !== 0)
        throw new Error(`decodePngRGBA: only 8-bit RGBA non-interlaced is supported (got depth ${depth}, colorType ${colorType}, interlace ${interlace})`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const STRIDE = 4, rowBytes = width * STRIDE;
  const out = new Uint8Array(width * height * STRIDE);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const src = raw.subarray(y * (rowBytes + 1) + 1, y * (rowBytes + 1) + 1 + rowBytes);
    const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prior = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= STRIDE ? cur[i - STRIDE] : 0;
      const b = prior ? prior[i] : 0;
      const c = prior && i >= STRIDE ? prior[i - STRIDE] : 0;
      switch (filter) {
        case 0: cur[i] = src[i]; break;
        case 1: cur[i] = (src[i] + a) & 0xff; break;
        case 2: cur[i] = (src[i] + b) & 0xff; break;
        case 3: cur[i] = (src[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          cur[i] = (src[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`decodePngRGBA: unknown row filter ${filter} on row ${y}`);
      }
    }
  }
  return { width, height, data: out };
}
