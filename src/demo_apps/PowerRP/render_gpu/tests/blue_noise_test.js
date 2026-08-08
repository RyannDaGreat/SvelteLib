/**
 * THE BLUE-NOISE ASSET GATE — bare node, no Skia.
 * Run: node render_gpu/tests/blue_noise_test.js
 *
 * ── WHY THIS FILE EXISTS, AND IT IS THE SHARPEST LESSON OF THIS ROUND ────────
 * The tile this suite guards replaced one that was WHITE NOISE shipping under a
 * blue-noise docblock. `blue_noise_64.js` claimed "Ulichney void-and-cluster
 * method (SPIE 1993)", a "toroidal Gaussian energy field" and a "perceptually-flat
 * blue noise spectrum", and cited a generator script that did not exist in this
 * repo. Measured 2026-08-08: high/low spectral power ratio 0.90 (a white-noise
 * control scores ~1; real blue noise scores in the thousands) and a histogram of
 * min 8 / max 17 where ranking every texel must give exactly 16 of each.
 *
 * NOTHING CAUGHT IT. Not the render tests, which only asked whether the dither
 * changed pixels — white noise changes pixels perfectly well. Not review, because
 * the docblock asserted the property confidently and the data is kilobytes of
 * base64 nobody can read. THE USER CAUGHT IT BY EYE, from a 1-bit high-emphasis
 * gradient: "why do I see artifacts ... it should be uniformly scattered dots". An
 * agent then dismissed it as a known quality characteristic, which it was not:
 * blue noise having no low-frequency energy is its DEFINITION, so visible blobs
 * are proof of absence, not a tuning axis.
 *
 * SO THIS SUITE ASSERTS THE DEFINING PROPERTY ON THE SHIPPED BYTES. Both checks
 * are kept because they are INDEPENDENT and each one alone catches the old tile:
 * the spectrum can be right while the thresholds are unevenly distributed, and a
 * perfect histogram says nothing about clumping.
 *
 * THE ASSET IS DOWNLOADED, NOT GENERATED (user ruling, 2026-08-08: "you don't
 * generate blue noise. you download it"), so there is no generator to re-run and
 * no provenance test to write — the provenance is a URL and a licence in
 * blue_noise_512.js's docblock. What is testable is the DATA, which is what this
 * file measures.
 */

import assert from "node:assert/strict";
import { decodeBlueNoise, BLUE_NOISE_SIZE } from "../skia/blue_noise_512.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

// ── the instruments ──────────────────────────────────────────────────────────

/**
 * Command (in place). Radix-2 Cooley-Tukey FFT over one complex row.
 *
 * A DIRECT DFT IS NOT AN OPTION AT THIS SIZE and that is why this exists: the
 * naive O(N^4) transform that measured the old 64x64 tile in 0.25 s would take
 * 512^4 ≈ 7e10 operations here — hours. The FFT is O(N^2 log N) over the image,
 * which runs in under a second, and it is EXACT rather than an approximation, so
 * the assertion below is still the definitional one.
 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {          // bit-reversal permutation
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/**
 * Pure function. THE SPECTRAL ACCEPTANCE TEST: mean power in the HIGH-frequency
 * annulus (r >= N/4) divided by mean power in the LOW-frequency disc (r <= N/8),
 * with DC excluded because DC is the mean, not a frequency.
 *
 * BLUE NOISE IS *DEFINED* BY HAVING NO LOW-FREQUENCY ENERGY, so this ratio is the
 * property itself rather than a proxy for it. Calibrated against three controls
 * (asserted below, so the instrument cannot rot):
 *     white noise   ~1      energy spread evenly across all frequencies
 *     smooth blobs  ~0      all energy is low-frequency
 *     checkerboard  huge    all energy is at the Nyquist corner
 * A tile scoring near 1 IS white noise — exactly how the old asset was caught.
 *
 * Radii are TOROIDAL (frequency N-1 is one step from DC, not N-1 steps), which is
 * the correct metric for a tile that wraps.
 *
 * @param {Uint8Array} tile - N*N threshold bytes, row-major
 * @param {number} N - tile edge length (a power of two)
 * @returns {{lo: number, hi: number, ratio: number}}
 */
export function spectralRatio(tile, N) {
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  let mean = 0;
  for (let i = 0; i < N * N; i++) mean += tile[i] / 255;
  mean /= N * N;
  for (let i = 0; i < N * N; i++) re[i] = tile[i] / 255 - mean;

  const rowR = new Float64Array(N), rowI = new Float64Array(N);
  for (let y = 0; y < N; y++) {                  // rows
    for (let x = 0; x < N; x++) { rowR[x] = re[y * N + x]; rowI[x] = im[y * N + x]; }
    fft(rowR, rowI);
    for (let x = 0; x < N; x++) { re[y * N + x] = rowR[x]; im[y * N + x] = rowI[x]; }
  }
  for (let x = 0; x < N; x++) {                  // columns
    for (let y = 0; y < N; y++) { rowR[y] = re[y * N + x]; rowI[y] = im[y * N + x]; }
    fft(rowR, rowI);
    for (let y = 0; y < N; y++) { re[y * N + x] = rowR[y]; im[y * N + x] = rowI[y]; }
  }

  let lo = 0, loN = 0, hi = 0, hiN = 0;
  for (let u = 0; u < N; u++) for (let v = 0; v < N; v++) {
    if (u === 0 && v === 0) continue;
    const p = (re[v * N + u] ** 2 + im[v * N + u] ** 2) / (N * N);
    const du = Math.min(u, N - u), dv = Math.min(v, N - v);
    const r = Math.hypot(du, dv);
    if (r <= N / 8) { lo += p; loN++; } else if (r >= N / 4) { hi += p; hiN++; }
  }
  return { lo: lo / loN, hi: hi / hiN, ratio: (hi / hiN) / ((lo / loN) || 1e-30) };
}

/**
 * Pure function. THE STRUCTURAL ACCEPTANCE TEST: how far the byte histogram
 * deviates from perfectly uniform, as a fraction of the ideal count.
 *
 * A blue-noise threshold tile is a RANK PERMUTATION — every texel gets a distinct
 * rank, so scaling ranks to bytes puts exactly N²/256 texels on each value.
 * Deviation must be 0. This is independent of the spectrum and catches a different
 * failure: a tile that is spectrally fine but whose thresholds are unevenly
 * distributed dithers with a LEVEL BIAS. The old asset's min 8 / max 17 against an
 * ideal of 16 alone proved no ranking had happened.
 *
 * @param {Uint8Array} tile - N*N threshold bytes
 * @param {number} N - tile edge length
 * @returns {{min: number, max: number, ideal: number, meanDeviation: number}}
 */
export function histogramDeviation(tile, N) {
  const counts = new Array(256).fill(0);
  for (const v of tile) counts[v]++;
  const ideal = (N * N) / 256;
  let dev = 0;
  for (const c of counts) dev += Math.abs(c - ideal);
  return { min: Math.min(...counts), max: Math.max(...counts), ideal, meanDeviation: dev / 256 / ideal };
}

// ── the gate ─────────────────────────────────────────────────────────────────

const CONTROL_N = 64; // power of two, big enough for stable statistics, instant under FFT

/** Query→build. A CONTROL_N tile from a per-texel function. */
function controlTile(f) {
  const t = new Uint8Array(CONTROL_N * CONTROL_N);
  for (let y = 0; y < CONTROL_N; y++) for (let x = 0; x < CONTROL_N; x++) t[y * CONTROL_N + x] = f(x, y);
  return t;
}

test("the INSTRUMENT is calibrated — three controls bracket the measurement", () => {
  // A spectral test nobody has validated is worth nothing: it was the ABSENCE of
  // this calibration that let 0.90 read as acceptable. These pin the scale at both
  // ends and in the middle, so a reader can see what the shipped number MEANS
  // without trusting this file's prose.
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const white = spectralRatio(controlTile(() => Math.floor(rnd() * 256)), CONTROL_N).ratio;
  const blobs = spectralRatio(controlTile((x, y) => 128 + 120 * Math.sin(2 * Math.PI * x / CONTROL_N) * Math.sin(2 * Math.PI * y / CONTROL_N)), CONTROL_N).ratio;
  const checker = spectralRatio(controlTile((x, y) => ((x + y) & 1) ? 255 : 0), CONTROL_N).ratio;

  assert.ok(white > 0.3 && white < 3, `white noise scored ${white.toFixed(2)}; a flat spectrum must land near 1 or the instrument is wrong`);
  assert.ok(blobs < 0.01, `smooth low-frequency blobs scored ${blobs.toExponential(2)}; must be ~0`);
  assert.ok(checker > 1e6, `a checkerboard (all energy at Nyquist) scored ${checker.toExponential(2)}; must be enormous`);
  assert.ok(checker > white && white > blobs, "the three controls must order low < flat < high");
});

test("THE SHIPPED TILE IS BLUE NOISE — no low-frequency energy", () => {
  // THE ASSERTION THE OLD ASSET FAILED. It is stated against the SHIPPED bytes, so
  // swapping the asset for one that regresses the spectrum reds here — which is
  // the whole point of pinning a downloaded file rather than trusting its origin.
  const { ratio, lo, hi } = spectralRatio(decodeBlueNoise(), BLUE_NOISE_SIZE);
  assert.ok(ratio > 20,
    `the shipped tile's high/low spectral power ratio is ${ratio.toFixed(2)} — blue noise has NO low-frequency energy and must score far above 1 (the WHITE NOISE that used to ship here scored 0.90, and a white-noise control scores ~1). lo=${lo.toExponential(3)} hi=${hi.toExponential(3)}`);
});

test("THE SHIPPED TILE IS A RANK PERMUTATION — exactly N²/256 of every value", () => {
  const h = histogramDeviation(decodeBlueNoise(), BLUE_NOISE_SIZE);
  assert.equal(h.meanDeviation, 0,
    `histogram deviates by ${h.meanDeviation.toFixed(4)} (min ${h.min}, max ${h.max}, ideal ${h.ideal}) — a threshold tile ranks every texel, so each of the 256 values must appear EXACTLY the ideal number of times`);
  assert.equal(h.min, h.ideal);
  assert.equal(h.max, h.ideal);
});

test("the shipped tile decodes to exactly its declared size", () => {
  // Cheap, and it is the check that would catch a truncated paste of a 350 KB
  // base64 literal — a failure mode that otherwise surfaces as a corner-sampled
  // texture and a mysteriously repeating pattern.
  const tile = decodeBlueNoise();
  assert.equal(BLUE_NOISE_SIZE, 512);
  assert.equal(tile.length, BLUE_NOISE_SIZE * BLUE_NOISE_SIZE);
  assert.equal(tile.length, 262144);
});

console.log(`\n${passed} blue noise tests passed`);
