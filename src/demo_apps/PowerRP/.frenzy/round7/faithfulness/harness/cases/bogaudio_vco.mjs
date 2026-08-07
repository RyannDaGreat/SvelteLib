/**
 * OUR SIDE — the whole Bogaudio VCO module, `synth/vc3b_kernels.js VcoKernel`.
 *
 * WHAT THIS ADDS OVER `bogaudio_osc`: that case proved the waveform primitives
 * agree sample for sample. This one drives the MODULE — knob to hertz, the ±5 V
 * pitch clamp, slow mode's −7 octaves, linear vs exponential FM, the oversample
 * crossfade around 0.06·fs, the pulse-width slew, and the 100-sample modulate
 * cadence. A tuning bug lives in exactly that layer and no primitive test can
 * see it.
 *
 * ── THE UNITS CONVERSION, AND WHY IT IS NOT CHEATING ────────────────────────
 * PowerRP's pitch wire and frequency knob are in SEMITONES; Rack's are in VOLTS
 * (`R7-UNITS clause 3`, stated in `VcoKernel.control`'s comment). So driving both
 * sides from the same musical setting REQUIRES a ×12, and applying it is what
 * makes the comparison meaningful rather than guaranteeing a 12× detune. The
 * conversion is confined to `oursKnobs`/`oursSignals` below so it is auditable,
 * and it is the ONLY transformation applied to either side.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const KERNELS = resolve(HERE, "../../../../../synth/vc3b_kernels.js");
const K = await import(KERNELS);

/** Where `copyGlue` puts the untouched upstream sources. ABSOLUTE, because a
 *  relative -I would be resolved against g++'s cwd, and a missed -I here does
 *  not error — it silently falls through to the REAL `src/VCO.hpp`, which then
 *  drags in Bogaudio's panel layer. That is how this case failed the first time. */
const GLUE_DIR = resolve(HERE, "../build/bogaudio_glue");

/** `dsp/pitch.hpp referenceFrequency` — C4, the frequency at which a Rack V/oct is 0. */
const REFERENCE_HZ = 261.626;
/** `BOG_SEMITONES_PER_VOLT`, restated so the conversion reads as arithmetic. */
const SEMITONES_PER_VOLT = 12;
/** `src/module.hpp:17 _modulationSteps` — `modulate()` runs once per 100 samples. */
const MODULATION_STEPS = 100;
/** VCO.hpp's OutputsIds order: square, saw, triangle, sine. */
const OUTPUT_COUNT = 4;
/** The three CV inlets this case drives, interleaved in the shared input file. */
const INPUT_COUNT = 3;

/**
 * WHERE EACH .cpp STOPS BEING DSP AND STARTS BEING A PANEL.
 *
 * Below these markers the files are pure Rack UI — knob positions, screws, SVG
 * panels, `createModel`. Shimming that layer would mean shimming nanovg and the
 * whole widget tree for zero measurable benefit, so the copy stops there.
 *
 * EVERY LINE ABOVE THE MARKER IS BYTE-FOR-BYTE UPSTREAM. That is the claim this
 * case rests on, so the truncation is done at a `struct`/function boundary that
 * is named here, and `copyGlue` FAILS LOUDLY if a marker is missing — if
 * upstream ever moves one, the case must stop rather than quietly compile a
 * different amount of their code than it says it does.
 */
const GLUE_FILES = Object.freeze([
  { file: "vco_base.hpp", cutAt: null },
  { file: "vco_base.cpp", cutAt: "void VCOBaseModuleWidget::contextMenu(Menu* menu) {" },
  { file: "VCO.hpp", cutAt: null },
  { file: "VCO.cpp", cutAt: "struct VCOWidget : VCOBaseModuleWidget {" },
]);

/**
 * Command. Copy the upstream glue into the build directory, verbatim down to
 * each file's panel section.
 *
 * They cannot be compiled in place: `#include "bogaudio.hpp"` resolves to the
 * includer's own directory first, so no -I can put a shim ahead of Bogaudio's
 * real panel-layer umbrella header. Copying is the only way, and copying rather
 * than patching is what keeps the module glue under test genuinely THEIRS.
 *
 * @param {{buildDir: string, repoPath: (k: string) => string}} ctx
 * @returns {void}
 */
function copyGlue(ctx) {
  const src = ctx.repoPath("bogaudio");
  mkdirSync(GLUE_DIR, { recursive: true });
  for (const { file, cutAt } of GLUE_FILES) {
    const from = join(src, "src", file);
    if (cutAt === null) {
      copyFileSync(from, join(GLUE_DIR, file));
      continue;
    }
    const text = readFileSync(from, "utf8");
    const at = text.indexOf(cutAt);
    if (at < 0) {
      throw new Error(`bogaudio_vco: ${file} no longer contains its panel marker ${JSON.stringify(cutAt)} — the truncation this case documents is out of date and the case must not run`);
    }
    writeFileSync(join(GLUE_DIR, file), text.slice(0, at));
  }
}

/**
 * Pure function. A Rack V/oct knob setting, as OUR kernel's semitone knobs.
 *
 * @param {object} p - the upstream param settings
 * @returns {object} the `knobs` object VcoKernel.control expects
 *
 * @example oursKnobs({freq: 0, fine: 0, pw: 0, fmDepth: 0}).frequency // 0
 * @example oursKnobs({freq: 1, fine: 0, pw: 0, fmDepth: 0}).frequency // 12
 */
function oursKnobs(p) {
  return {
    frequency: p.freq * SEMITONES_PER_VOLT,
    fine: p.fine, // FINE_PARAM is already semitones on both sides
    pw: p.pw,
    fmDepth: p.fmDepth,
  };
}

/**
 * Command. Render `frames` samples of our VcoKernel over the shared input.
 *
 * @param {Float32Array} input - interleaved [pitchV, fmV, pwCvV]
 * @param {number} frames
 * @param {number} sampleRate
 * @param {object} p - the case's parameter settings
 * @returns {Float32Array} interleaved [square, saw, triangle, sine], volts
 */
function renderVco(input, frames, sampleRate, p) {
  const k = new K.VcoKernel(sampleRate);
  k.setSlow(p.slow ? "on" : "off");
  k.setTuning(p.linear ? "hertz" : "voct");
  // `VCO::modulate`: `_fmLinearMode = FM_TYPE_PARAM < 0.5`, so 0 is linear.
  k.setFmMode(p.fmType < 0.5 ? "linear" : "exponential");
  k.setDcCorrection("on");

  const knobs = oursKnobs(p);
  const wired = { pitch: p.pitchWired, fm: p.fmWired, pw_cv: p.pwWired, sync: false };
  const frame = new Float64Array(OUTPUT_COUNT);
  const out = new Float32Array(frames * OUTPUT_COUNT);
  // `BGModule::process` (src/module.cpp:56) starts `_steps` at −1 and modulates
  // when it REACHES 100, so the first modulate is the 101st sample — and until
  // then `_channels` is 0 and the module emits nothing at all. Mirrored here so
  // the two sides' startup transient is the same one, not two different ones.
  let steps = -1;
  let started = false;
  for (let i = 0; i < frames; i++) {
    const signals = {
      pitch: input[i * INPUT_COUNT + 0] * SEMITONES_PER_VOLT,
      fm: input[i * INPUT_COUNT + 1],
      pw_cv: input[i * INPUT_COUNT + 2],
      sync: 0,
    };
    steps++;
    if (steps >= MODULATION_STEPS) {
      steps = 0;
      started = true;
      k.control(knobs, signals, wired);
    }
    if (!started) continue; // their `_channels == 0` window: outputs stay at 0 V
    k.sample(knobs, signals, wired, frame);
    for (let c = 0; c < OUTPUT_COUNT; c++) out[i * OUTPUT_COUNT + c] = frame[c];
  }
  return out;
}

const SAMPLE_RATE = 48000;
const FRAMES = SAMPLE_RATE;
/** Long enough to clear their 100-sample silent window, the pulse-width slew
 *  (0.1 s attack in `squarePulseWidthSL`) and the decimators' 29-tap delay. */
const SKIP_FRAMES = 12000;

/**
 * Pure function. One VCO case at one knob setting.
 *
 * @param {string} label
 * @param {object} p - `{freq, fine, pw, fmDepth, slow, linear, fmType, pitchV, fmHz, pitchWired, fmWired, pwWired}`
 * @returns {object} a CASE
 *
 * @example vco("C4", {freq: 0}).name // "bogaudio.VCO.C4"
 */
function vco(label, p) {
  const s = {
    freq: 0, fine: 0, pw: 0, fmDepth: 0, slow: 0, linear: 0, fmType: 1,
    pitchV: 0, fmHz: 0, fmAmpV: 0, pitchWired: false, fmWired: false, pwWired: false,
    ...p,
  };
  // The frequency the knob and the pitch CV together ask for, which is what the
  // tuning verdict is measured against. `cvToFrequency(cv) = 2^cv · 261.626`.
  const voct = s.freq + s.fine / SEMITONES_PER_VOLT + (s.pitchWired ? s.pitchV : 0) + (s.slow ? -7 : 0);
  const expectedHz = s.linear ? undefined : Math.pow(2, voct) * REFERENCE_HZ;
  return {
    name: `bogaudio.VCO.${label}`,
    upstream: "bogaudio",
    upstreamFiles: ["src/VCO.cpp", "src/VCO.hpp", "src/vco_base.cpp", "src/vco_base.hpp"],
    oursRef: "synth/vc3b_kernels.js VcoKernel",
    note: "whole module: knob mapping, pitch clamp, FM branch, oversample crossfade, modulate cadence",
    cpp: "bogaudio_vco.cpp",
    shimDirs: ["vc3b_module"],
    prep: copyGlue,
    // The copied glue lives in build/bogaudio_glue; it must come BEFORE the
    // repo's own src on the include path so `#include "VCO.hpp"` finds the copy.
    cxxflags: [`-I${GLUE_DIR}`, `${GLUE_DIR}/vco_base.cpp`, `${GLUE_DIR}/VCO.cpp`],
    extraSources: [],
    // The two .cpp copies are compiled straight from the build dir, so they are
    // passed as absolute paths rather than through `extraSources` (which is
    // relative to the upstream repo).
    sampleRate: SAMPLE_RATE,
    frames: FRAMES,
    skipFrames: SKIP_FRAMES,
    args: [s.freq, s.fine, s.pw, s.fmDepth, s.slow, s.linear, s.fmType,
      s.pitchWired ? 1 : 0, s.fmWired ? 1 : 0, s.pwWired ? 1 : 0],
    makeInput: (frames, sampleRate) => {
      const a = new Float32Array(frames * INPUT_COUNT);
      for (let i = 0; i < frames; i++) {
        a[i * INPUT_COUNT + 0] = s.pitchV;
        a[i * INPUT_COUNT + 1] = s.fmHz > 0 ? s.fmAmpV * Math.sin(2 * Math.PI * s.fmHz * i / sampleRate) : 0;
        a[i * INPUT_COUNT + 2] = 0;
      }
      return a;
    },
    render: (input, frames, sampleRate) => renderVco(input, frames, sampleRate, s),
    analysis: [
      { kind: "tone", name: "square", expectedHz },
      { kind: "tone", name: "saw", expectedHz },
      { kind: "tone", name: "triangle", expectedHz },
      { kind: "tone", name: "sine", expectedHz },
    ],
  };
}

export const CASES = [
  // The tuning sweep: five octaves of V/oct, which is where a semitone error
  // would show as a constant offset and a scaling error as a growing one.
  vco("voct-2", { pitchWired: true, pitchV: -2 }),
  vco("voct0", { pitchWired: true, pitchV: 0 }),
  vco("voct+1", { pitchWired: true, pitchV: 1 }),
  vco("voct+3", { pitchWired: true, pitchV: 3 }),
  // The knob's own range, and the fine trim.
  vco("knob+2", { freq: 2 }),
  vco("fine+50cents", { freq: 0, fine: 0.5 }),
  // Above 0.06·fs = 2880 Hz the module crossfades into its 8x oversampled path;
  // 3200 Hz is past the 100 Hz crossfade window, so it is fully oversampled.
  vco("oversampled-3.6kHz", { pitchWired: true, pitchV: 3.78 }),
  // Inside the crossfade window itself, where mix and oMix are both non-zero.
  vco("crossfade-2.93kHz", { pitchWired: true, pitchV: 3.485 }),
  // Slow mode drops seven octaves: an LFO, and a different code path.
  vco("slow", { slow: 1, pitchWired: true, pitchV: 2 }),
  // Pulse width away from 50%, which exercises the offset and DC correction.
  vco("pw-narrow", { pw: -0.6, pitchWired: true, pitchV: 0 }),
  // Exponential FM (FM_TYPE_PARAM = 1) and through-zero linear FM (= 0).
  vco("fm-exponential", { fmType: 1, fmDepth: 0.5, fmWired: true, fmHz: 30, fmAmpV: 1, pitchWired: true, pitchV: 0 }),
  vco("fm-linear", { fmType: 0, fmDepth: 0.5, fmWired: true, fmHz: 30, fmAmpV: 1, pitchWired: true, pitchV: 0 }),
];
