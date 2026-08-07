/**
 * OUR SIDE — Bogaudio's oscillator primitives as `synth/vc3b_kernels.js` has them.
 *
 * The pull loop here is `Phasor::_next()`: advance the phase, then evaluate the
 * waveform at it. That loop is three lines in upstream and three lines here;
 * everything interesting (the BLEP correction, the pulse-width latch, the table
 * interpolation) is inside OUR exported functions, which is what is under test.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const KERNELS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../synth/vc3b_kernels.js");
const K = await import(KERNELS);

/** VCOBase::Engine's `setQuality(12)` on both band-limited oscillators. */
const VCO_BLEP_QUALITY = 12;

/** `BandLimitedSawOscillator::_update` — `q = min(quality, (int)(0.5·fs/f))`, then `q · delta`. */
function qdFor(freq, sampleRate, quality) {
  const q = Math.min(quality, Math.trunc(0.5 * (sampleRate / freq)));
  return q * K.bogPhaseDelta(freq, sampleRate);
}

/**
 * Command. Render `frames` samples of one Bogaudio oscillator.
 *
 * @param {number} which - 0 sine, 1 blep saw, 2 blep square, 3 triangle, 4 naive square, 5 sine table
 * @param {number} frames
 * @param {number} sampleRate
 * @param {number} freq - hertz
 * @param {number} pw - pulse width, for the two squares
 * @returns {Float32Array}
 *
 * @example renderOsc(0, 4, 48000, 100, 0.5).length // 4
 */
function renderOsc(which, frames, sampleRate, freq, pw) {
  const out = new Float32Array(frames);
  const delta = K.bogPhaseDelta(freq, sampleRate);
  const qd = qdFor(freq, sampleRate, VCO_BLEP_QUALITY);
  // Their `_phase` is an unbounded uint64; ours is wrapped with a separate
  // cycle counter (D11 in the kernels file). `cycle` here is what their
  // `phase / cyclePhase` computes.
  let phase = 0;
  let cycle = 0;
  const advance = () => {
    const next = phase + delta;
    cycle += Math.floor(next / K.BOG_CYCLE_PHASE);
    phase = K.bogWrapPhase(next);
  };

  if (which === 0) {
    const o = new K.BogSineOscillator(sampleRate, freq);
    for (let i = 0; i < frames; i++) out[i] = o.next();
    return out;
  }
  if (which === 1) {
    for (let i = 0; i < frames; i++) {
      advance();
      out[i] = K.bogBandLimitedSawForPhase(phase, qd, K.BOG_BLEP_TABLE);
    }
    return out;
  }
  if (which === 2) {
    const sq = new K.BogBandLimitedSquare();
    sq.setPulseWidth(pw, true);
    for (let i = 0; i < frames; i++) {
      advance();
      out[i] = sq.forPhase(phase, cycle, qd, K.BOG_BLEP_TABLE);
    }
    return out;
  }
  if (which === 3) {
    for (let i = 0; i < frames; i++) {
      advance();
      out[i] = K.bogTriangleForPhase(phase);
    }
    return out;
  }
  if (which === 4) {
    const sq = new K.BogSquare();
    sq.setPulseWidth(pw);
    for (let i = 0; i < frames; i++) {
      advance();
      out[i] = sq.forPhase(phase, cycle);
    }
    return out;
  }
  if (which === 5) {
    for (let i = 0; i < frames; i++) {
      advance();
      out[i] = K.bogTableForPhase(phase, K.BOG_SINE_TABLE);
    }
    return out;
  }
  throw new Error(`renderOsc: unknown which=${which}`);
}

const SAMPLE_RATE = 48000;
/** One second is 24 cycles of the lowest note tested and ~10 000 of the highest —
 *  enough for an 8192-point FFT to resolve a fundamental to a fraction of a cent. */
const FRAMES = SAMPLE_RATE;
/** C4 as VCV tunes it (dsp::FREQ_C4 = 261.6256), and a high note where the BLEP
 *  correction is wide enough to dominate the waveform. */
const C4_HZ = 261.6256;
const HIGH_HZ = 2093.0;

/** Pure function. One oscillator case at one frequency. */
function osc(label, which, freq, pw, files) {
  return {
    name: `bogaudio.${label}@${freq}Hz`,
    upstream: "bogaudio",
    upstreamFiles: files,
    oursRef: "synth/vc3b_kernels.js",
    cpp: "bogaudio_osc.cpp",
    sampleRate: SAMPLE_RATE,
    frames: FRAMES,
    args: [which, freq, pw],
    // The BLEP oscillators' first sample is a half-formed correction; a filter
    // has no state to settle here, so one cycle is plenty.
    skipFrames: 256,
    render: (_input, frames, sampleRate, args) => renderOsc(which, frames, sampleRate, freq, pw),
    analysis: [{ kind: "tone", name: label, expectedHz: freq }],
  };
}

const OSC_FILES = ["src/dsp/oscillator.hpp", "src/dsp/oscillator.cpp", "src/dsp/table.cpp"];

export const CASES = [
  osc("SineOscillator", 0, C4_HZ, 0.5, OSC_FILES),
  osc("BandLimitedSaw", 1, C4_HZ, 0.5, OSC_FILES),
  osc("BandLimitedSaw", 1, HIGH_HZ, 0.5, OSC_FILES),
  osc("BandLimitedSquare", 2, C4_HZ, 0.5, OSC_FILES),
  osc("BandLimitedSquare", 2, C4_HZ, 0.25, OSC_FILES),
  osc("BandLimitedSquare", 2, HIGH_HZ, 0.5, OSC_FILES),
  osc("Triangle", 3, C4_HZ, 0.5, OSC_FILES),
  osc("NaiveSquare", 4, C4_HZ, 0.3, OSC_FILES),
  osc("SineTable", 5, C4_HZ, 0.5, OSC_FILES),
];
