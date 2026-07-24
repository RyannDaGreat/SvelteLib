/**
 * Precomputed 64x64 blue-noise DITHER threshold texture (asset). Generated ONCE
 * by the Ulichney void-and-cluster method (SPIE 1993) — a toroidal Gaussian
 * energy field ranks every pixel so ranks stay spatially well-separated at every
 * threshold, giving the perceptually-flat "blue noise" spectrum. The tile is
 * SEAMLESS (toroidal) so it repeats across the frame with no visible seams.
 *
 * Stored as base64 of 4096 single-byte gray THRESHOLD values (row-major, one
 * byte per texel; value/255 is the threshold in [0,1)). Consumed by
 * render_gpu/skia/dither_shader.js, which expands it to an RGBA CanvasKit Image.
 *
 * Regeneration params (scratchpad_agent_dither_gen.js): N=64, sigma=1.9,
 * initFraction=0.1, seed=1337. Deterministic — same output every run.
 */

/** The blue-noise tile edge length in texels. */
export const BLUE_NOISE_SIZE = 64;

/** Base64 of the 4096 row-major 8-bit threshold values. */
export const BLUE_NOISE_BASE64 =
  "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";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Pure function. Decodes a base64 string to a Uint8Array. Self-contained (no
 * atob/Buffer) so it runs identically in the browser and in Node.
 *
 * @param {string} b64 - base64 text (standard alphabet, optional '=' padding)
 * @returns {Uint8Array} the decoded bytes
 *
 * @example decodeBase64("QUJD") // Uint8Array [65, 66, 67]  ("ABC")
 */
export function decodeBase64(b64) {
  const clean = b64.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0, bits = 0, oi = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) throw new Error("decodeBase64: non-base64 character in input");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[oi++] = (acc >> bits) & 0xff; }
  }
  return out;
}

/**
 * Pure function. The decoded 4096-byte blue-noise threshold tile (row-major).
 *
 * @returns {Uint8Array} length 4096 (64x64), each byte a threshold value
 *
 * @example decodeBlueNoise().length // 4096
 */
export function decodeBlueNoise() {
  const bytes = decodeBase64(BLUE_NOISE_BASE64);
  if (bytes.length !== BLUE_NOISE_SIZE * BLUE_NOISE_SIZE)
    throw new Error(`decodeBlueNoise: expected ${BLUE_NOISE_SIZE * BLUE_NOISE_SIZE} bytes, got ${bytes.length}`);
  return bytes;
}
