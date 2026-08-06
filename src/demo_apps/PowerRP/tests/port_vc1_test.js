/**
 * VC-1 PORT TEST — the AudibleInstruments block, checked against a transcription of the
 * C++ rather than against its own algebra.
 *
 * ── WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT ──────────────────
 * `tests/port_ax3_test.js` is the gold standard for a port test and its method is the one
 * followed here: reproduce the ORIGINAL's arithmetic independently, then diff. For an
 * Axoloti port that meant modelling `___SMMUL`/`__SSAT` in BigInt so every truncation
 * lands where theirs does. A VCV port is float→float, so the equivalent is:
 *
 *   1. **A LINE-BY-LINE TRANSCRIPTION of the C++ recurrence, written from the source and
 *      NOT from the kernel**, run beside the kernel on the same input, diffed. That is
 *      what `transcribed*` below are: they are deliberately naive, deliberately allocate,
 *      and deliberately duplicate the kernel — a check that shares an implementation with
 *      the thing it checks proves nothing.
 *   2. **MEASURED FIGURES for anything whose correctness is a NUMBER** — a filter's gain,
 *      a resonator's fundamental, a Bernoulli gate's distribution, a table's endpoints.
 *   3. **THE SPEC↔ROSTER↔KERNEL CONTRACT**, in every direction, because a knob that
 *      reaches no param and a param that reaches no knob are both silent failures.
 *
 * IT IS NOT a coverage sweep and not a regression net. The round's budget for tests is
 * 10 % and this is one file; what is here is the arithmetic that a wrong sound would diff
 * against, plus the three seams that fail SILENTLY when they drift.
 *
 * Run: `node src/demo_apps/PowerRP/tests/port_vc1_test.js`
 */

import { BLOCK_SPECS } from "../core/audio_specs_vc1.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES } from "../synth/modules_vc1.js";
import { VC1_PROCESSORS, vc1OptionSetter } from "../synth/worklets/processors_vc1.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_vc1.js";
import { typesCompatible } from "../core/nodeflow.js";
import {
  BranchesKernel, CLOUDS_MAX_GRAINS, CLOUDS_PLAYBACK_MODES, CLOUDS_QUALITIES,
  CloudsKernel, DelayLine, FxEngine, FX_FORMAT_FLOAT, RINGS_MODELS, RingsKernel,
  Svf, ShadesKernel, buildGrainSizeTable, buildMuLawTable, buildStiffnessTable,
  buildSvfShiftTable, buildWindowTable, buildXfadeTables, cloudsBufferSamples,
  cloudsGrainCount, cloudsGranularMeta, fxLines, interpolate, lin2MuLaw,
  quadraticBipolar, quarticBipolar, semitonesToRatio, softConvert, softLimit,
  squashRings, tanFast,
} from "../synth/vc1_kernels.js";

let failures = 0;
let checks = 0;

/** Command. Assert and count. Reports the sentence, not just the boolean. */
function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Command. Assert two numbers agree within `tolerance`, reporting the error. */
function near(label, actual, expected, tolerance) {
  checks += 1;
  const error = Math.abs(actual - expected);
  if (!(error <= tolerance)) {
    failures += 1;
    console.error(`  FAIL  ${label} — got ${actual}, want ${expected} ±${tolerance} (error ${error})`);
  }
}

/** Command. Section heading, so a red says WHICH law broke. */
function section(name) {
  console.log(`\n${name}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE LOOKUP TABLES, AGAINST THEIR GENERATING EXPRESSIONS
// ════════════════════════════════════════════════════════════════════════════
// Each table is built from a formula transcribed from Mutable's own
// `resources/lookup_tables.py`. Checking the endpoints and one interior point of each is
// what catches an off-by-one in the domain, which is the failure these have.

section("1. Lookup tables vs their Python generators");
{
  const window = buildWindowTable(4096);
  check("lut_window has size+1 entries", window.length === 4097, `got ${window.length}`);
  near("lut_window[0]", window[0], 0, 0);
  near("lut_window[4096]", window[4096], 1, 1e-6);
  near("lut_window mid is a raised cosine at 0.5", window[2048], 0.5, 1e-6);

  const xfade = buildXfadeTables(16);
  near("lut_xfade_in[0]", xfade.fadeIn[0], 0, 0);
  near("lut_xfade_out[16]", xfade.fadeOut[16], 0, 1e-7);
  // THE 1.04/−0.02 SKEW IS WHY THE ENDS REACH: a plain sine fade would give
  // sin(π/2)·2^-0.5 = 0.7071 at the top and cos(0)·2^-0.5 = 0.7071 at the bottom, i.e.
  // it would never fully mute either side. The skew clamps both ends flat.
  near("lut_xfade_in[16] is the constant-power unity", xfade.fadeIn[16], Math.pow(2, -0.5), 1e-7);
  check("lut_xfade_in is monotone", xfade.fadeIn.every((v, i) => i === 0 || v >= xfade.fadeIn[i - 1]));

  const grain = buildGrainSizeTable(256);
  near("lut_grain_size[0]", grain[0], 1024, 0);
  near("lut_grain_size[256]", grain[256], 16384, 0);
  near("lut_grain_size spans four octaves at the quarter point", grain[64], 2048, 0);
  check("lut_grain_size is floored to whole samples",
    Array.from(grain).every((v) => Number.isInteger(v)));

  // The µ-law table is DERIVED from the bit formula the source commented out above its
  // 256-entry literal. These four are that literal's corners — the derivation's proof.
  const mu = buildMuLawTable();
  near("lut_ulaw[0]", mu[0], -32124, 0);
  near("lut_ulaw[127]", mu[127], 0, 0);
  near("lut_ulaw[128]", mu[128], 32124, 0);
  near("lut_ulaw[255]", mu[255], 0, 0);
  // And the encoder must invert the decoder at the codes the decoder can represent.
  check("lin2MuLaw round-trips its own table", mu[lin2MuLaw(mu[40])] === mu[40],
    `code 40 decodes to ${mu[40]}, re-encodes to ${lin2MuLaw(mu[40])}`);

  const stiffness = buildStiffnessTable(256);
  near("lut_stiffness[0] is negative (a membrane)", stiffness[0], -0.0625, 1e-6);
  near("lut_stiffness at 0.27 is exactly harmonic", stiffness[70], 0, 0);
  near("lut_stiffness[256] is 2 (a bell)", stiffness[256], 2, 0);
  near("lut_stiffness[255] is forced to 2 as well", stiffness[255], 2, 0);

  const shift = buildSvfShiftTable(256);
  near("lut_svf_shift[0] = atan(1)/π", shift[0], Math.atan(1) / Math.PI, 1e-6);
  check("lut_svf_shift falls with cutoff", shift[12] < shift[0]);
}

// ════════════════════════════════════════════════════════════════════════════
// 2. THE STMLIB HELPERS, AGAINST CLOSED FORM
// ════════════════════════════════════════════════════════════════════════════

section("2. stmlib helpers vs closed form");
{
  // `interpolate`'s short-circuit is what stops a LATENT OUT-OF-BOUNDS READ in the
  // original from becoming a NaN here. THIS CHECK IS THE BUG'S HEADSTONE: without it,
  // Clouds emitted 3778 non-finite samples out of 3840 at dryWet exactly 1.
  const seventeen = new Float32Array(17);
  for (let i = 0; i < 17; i++) seventeen[i] = i / 16;
  near("interpolate at index 1.0 does not read table[size+1]", interpolate(seventeen, 1, 16), 1, 0);
  check("interpolate at index 1.0 is finite", Number.isFinite(interpolate(seventeen, 1, 16)));

  near("semitonesToRatio(0)", semitonesToRatio(0), 1, 0);
  near("semitonesToRatio(12)", semitonesToRatio(12), 2, 1e-12);
  near("semitonesToRatio(-12)", semitonesToRatio(-12), 0.5, 1e-12);

  // `tan<FREQUENCY_FAST>` is what Mutable's filters are TUNED against, so it is ported
  // rather than replaced by Math.tan. It must track tan closely across the audio band and
  // its error must be BELOW a cent of mode detune for a 64-mode bank.
  for (const f of [0.001, 0.01, 0.05, 0.1, 0.2]) {
    near(`tanFast tracks tan at f=${f}`, tanFast(f), Math.tan(Math.PI * f), Math.abs(Math.tan(Math.PI * f)) * 2e-3);
  }

  near("softLimit(0)", softLimit(0), 0, 0);
  near("softLimit is unity-slope at the origin", softLimit(1e-4) / 1e-4, 1, 1e-4);
  near("softLimit(1)", softLimit(1), 28 / 36, 1e-12);
  // `SoftConvert` halves before limiting, which is why ±1 does NOT clip to full scale.
  // 15263 is `clip16(softLimit(0.5)·32768)` computed by hand: softLimit(0.5) is
  // 0.5·27.25/29.25 = 0.465812, and 0.465812·32768 = 15263.7, truncated. That is 47 % of
  // full scale, i.e. six decibels of headroom above Clouds' nominal output.
  near("softConvert(1) leaves headroom", softConvert(1), 15263, 1);
  near("softConvert(0)", softConvert(0), 0, 0);

  near("quadraticBipolar(0.5)", quadraticBipolar(0.5), 0.25, 0);
  near("quadraticBipolar(-0.5) keeps the sign", quadraticBipolar(-0.5), -0.25, 0);
  near("quarticBipolar(0.5)", quarticBipolar(0.5), 0.0625, 0);
  near("quarticBipolar(-1)", quarticBipolar(-1), -1, 0);

  near("squashRings is an identity at the ends and the middle", squashRings(0.5), 0.5, 0);
  check("squashRings snaps hard away from centre", squashRings(0.25) < 1e-4,
    `got ${squashRings(0.25)}`);

  // `DelayLine`'s write pointer moves BACKWARDS, which is the single easiest thing to get
  // wrong in this whole port: `Read(d)` must return the sample written d pushes ago.
  const line = new DelayLine(16);
  for (let i = 1; i <= 8; i++) line.write(i);
  near("DelayLine.readInt(1) is the newest sample", line.readInt(1), 8, 0);
  near("DelayLine.readInt(3) is three pushes ago", line.readInt(3), 6, 0);

  // The FxEngine's line layout gives each delay ONE guard sample, which is what makes an
  // interpolating read at the very end of a line legal.
  check("fxLines lays out with one guard sample per line",
    fxLines([126, 180])[1].base === 127, JSON.stringify(fxLines([126, 180])));
  let threw = false;
  try {
    new FxEngine(2000, FX_FORMAT_FLOAT, [10]);
  } catch {
    threw = true;
  }
  check("FxEngine refuses a non-power-of-two size loudly", threw);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. THE SVF, AGAINST A MEASURED FREQUENCY RESPONSE
// ════════════════════════════════════════════════════════════════════════════
// Every Mutable filter in this block is `stmlib::Svf`. A transcription check would be
// circular (the recurrence is five lines either way), so this measures the thing that
// matters instead: the −3 dB point of a lowpass really is where it was asked to be, and a
// resonant band-pass really peaks at its centre with the Q it was given.

section("3. Svf measured frequency response");
{
  /** Pure function. The magnitude response of a filter at one normalised frequency, by
   *  driving it with a sine and measuring the settled amplitude.
   *  @example // svfMagnitude(0.1, 0.7071, 0, 0.1) is about 0.707 at the cutoff */
  function svfMagnitude(cutoff, q, mode, probe) {
    const filter = new Svf();
    filter.setFQ(cutoff, q);
    let peak = 0;
    const total = 40000;
    for (let n = 0; n < total; n++) {
      const y = filter.process(Math.sin(2 * Math.PI * probe * n), mode);
      if (n > total / 2) peak = Math.max(peak, Math.abs(y));
    }
    return peak;
  }

  const cutoff = 0.05;
  const butterworthQ = Math.SQRT1_2;
  const atCutoff = svfMagnitude(cutoff, butterworthQ, 0, cutoff);
  near("Svf lowpass is -3 dB at its cutoff", atCutoff, Math.SQRT1_2, 0.05);
  const dc = svfMagnitude(cutoff, butterworthQ, 0, cutoff / 50);
  near("Svf lowpass passes DC at unity", dc, 1, 0.02);
  const wayUp = svfMagnitude(cutoff, butterworthQ, 0, cutoff * 8);
  check("Svf lowpass rolls off 12 dB/oct", wayUp < 0.03, `got ${wayUp} at eight times cutoff`);

  // A resonant band-pass's peak gain IS its Q — that is the property Rings' 64-mode bank
  // depends on, and getting `h = 1/(1 + r·g + g²)` wrong scales it.
  const q = 10;
  const bandPeak = svfMagnitude(cutoff, q, 1, cutoff);
  near("Svf band-pass peak gain is its Q", bandPeak, q, q * 0.06);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. CLOUDS — the grain scheduler against a transcription, and the dead zone
// ════════════════════════════════════════════════════════════════════════════

section("4. Clouds");
{
  // ── The three meta-mappings, transcribed from granular_processor.cc:96 ─────
  // Written from the C++, not from the kernel. If the kernel's `cloudsGranularMeta`
  // drifts, these lines are what it diffs against.
  /** Pure function. `parameters_.granular.overlap` exactly as the C computes it.
   *  @example transcribedOverlap(0.5) // 0 */
  function transcribedOverlap(density) {
    if (density >= 0.53) return (density - 0.53) * 2.12;
    if (density <= 0.47) return (0.47 - density) * 2.12;
    return 0.0;
  }
  /** Pure function. `parameters_.granular.window_shape`.
   *  @example transcribedWindowShape(0.9) // 1 */
  function transcribedWindowShape(texture) {
    return texture < 0.75 ? texture * 1.333 : 1.0;
  }
  /** Pure function. `diffusion` in the granular branch of granular_processor.cc:217.
   *  @example transcribedDiffusion(0.5) // 0 */
  function transcribedDiffusion(texture) {
    return texture > 0.75 ? (texture - 0.75) * 4.0 : 0.0;
  }

  const out = {};
  for (let i = 0; i <= 100; i++) {
    const density = i / 100;
    const texture = 1 - i / 100;
    cloudsGranularMeta(density, texture, out);
    near(`overlap at density ${density}`, out.overlap, transcribedOverlap(density), 0);
    near(`window shape at texture ${texture}`, out.windowShape, transcribedWindowShape(texture), 0);
    near(`diffusion at texture ${texture}`, out.diffusion, transcribedDiffusion(texture), 0);
    check(`deterministic seed at density ${density}`, out.useDeterministicSeed === (density < 0.5));
  }

  // ── The buffer and grain-pool sizes, against the four menu labels ──────────
  // `Clouds.cpp` allocates 118784 and 65408 bytes; the four qualities' documented
  // lengths are 1 / 2 / 4 / 8 seconds. Deriving them rather than tabulating them means
  // those labels are a CONSEQUENCE, and this is where that is checked.
  const rate = 32000;
  near("quality 0 buffer is about 1 s at 32 kHz", cloudsBufferSamples(false, false) / rate, 1, 0.03);
  near("quality 1 buffer is about 2 s at 32 kHz", cloudsBufferSamples(true, false) / rate, 1.86, 0.03);
  near("quality 2 buffer is about 4 s at 16 kHz", cloudsBufferSamples(false, true) / (rate / 2), 4.09, 0.03);
  near("quality 3 buffer is about 8 s at 16 kHz", cloudsBufferSamples(true, true) / (rate / 2), 7.42, 0.03);
  near("grain pool, stereo hi-fi", cloudsGrainCount(false, false), 32, 0);
  near("grain pool, mono hi-fi", cloudsGrainCount(true, false), 40, 0);
  near("grain pool, stereo lo-fi", cloudsGrainCount(false, true), 46, 0);
  near("grain pool, mono lo-fi", cloudsGrainCount(true, true), 57, 0);
  check("every grain pool fits kMaxNumGrains",
    [[false, false], [true, false], [false, true], [true, true]]
      .every(([m, l]) => cloudsGrainCount(m, l) <= CLOUDS_MAX_GRAINS));

  // ── THE DEAD ZONE IS THE MODULE'S MOST SURPRISING BEHAVIOUR, so it is measured
  //    end to end rather than inferred from `overlap` alone: at density 0.5 the engine
  //    renders SILENCE, and just outside it renders sound.
  /** Query. RMS of Clouds' output after the buffer has filled, at one density. */
  function cloudsRmsAtDensity(density) {
    const kernel = new CloudsKernel(48000, { seed: 1 });
    const input = new Float32Array(64);
    const output = new Float32Array(64);
    let sum = 0;
    let count = 0;
    const controls = {
      position: 0.3, size: 0.5, pitch: 0, inGain: 1, density, texture: 0.5,
      blend: 1, spread: 0.5, feedback: 0, reverb: 0, freeze: false, trig: false,
    };
    for (let block = 0; block < 2600; block++) {
      for (let i = 0; i < 64; i++) input[i] = Math.sin((block * 32 + (i >> 1)) * 0.09) * 0.5;
      kernel.render(controls, input, output);
      if (block >= 2500) {
        for (let i = 0; i < 64; i++) {
          sum += output[i] * output[i];
          count += 1;
        }
      }
    }
    return Math.sqrt(sum / count);
  }
  const deadZone = cloudsRmsAtDensity(0.5);
  const probabilistic = cloudsRmsAtDensity(0.9);
  const deterministic = cloudsRmsAtDensity(0.2);
  check("Clouds is SILENT in the density dead zone", deadZone === 0, `rms ${deadZone}`);
  check("Clouds renders above the dead zone", probabilistic > 0.05, `rms ${probabilistic}`);
  check("Clouds renders below the dead zone", deterministic > 0.05, `rms ${deterministic}`);

  // Silence in must be silence out, in every quality and both modes — a granular engine
  // that idles at a non-zero level would add a floor to every patch that uses it.
  for (const quality of CLOUDS_QUALITIES) {
    for (const playback of CLOUDS_PLAYBACK_MODES) {
      const kernel = new CloudsKernel(48000, { quality, seed: 1 });
      kernel.setPlayback(playback);
      const zero = new Float32Array(64);
      const output = new Float32Array(64);
      let peak = 0;
      let nonFinite = 0;
      for (let block = 0; block < 120; block++) {
        kernel.render({
          position: 0.5, size: 0.5, pitch: 0, inGain: 0.5, density: 0.9, texture: 0.5,
          blend: 1, spread: 0.5, feedback: 0.5, reverb: 0.5, freeze: false, trig: block === 0,
        }, zero, output);
        for (let i = 0; i < 64; i++) {
          if (!Number.isFinite(output[i])) nonFinite += 1;
          peak = Math.max(peak, Math.abs(output[i]));
        }
      }
      check(`silence in, silence out (${quality}/${playback})`, peak === 0, `peak ${peak}`);
      check(`no non-finite samples (${quality}/${playback})`, nonFinite === 0, `${nonFinite} of 7680`);
    }
  }

  // An unported playback mode must FAIL, not silently fall back to granular — deviation C1
  // says the mode is missing, and a silent substitution is the failure this round exists
  // to avoid.
  let refused = false;
  try {
    new CloudsKernel(48000, {}).setPlayback("spectral");
  } catch {
    refused = true;
  }
  check("Clouds refuses an unported playback mode loudly", refused);
}

// ════════════════════════════════════════════════════════════════════════════
// 5. RINGS — pitch, the position null, and the odd/even decorrelation
// ════════════════════════════════════════════════════════════════════════════

section("5. Rings");
{
  /** Query. Render Rings and return its two output channels after the strike settles. */
  function ringsRun(overrides, blocks = 900) {
    const kernel = new RingsKernel(48000, { seed: 1 });
    if (overrides.model) kernel.setModel(overrides.model);
    if (overrides.polyphony) kernel.setPolyphony(overrides.polyphony);
    kernel.setNoteSource("external");
    kernel.setStrumSource("external");
    kernel.setExciter("internal");
    const input = new Float32Array(24);
    const output = new Float32Array(48);
    const odd = [];
    const even = [];
    const controls = {
      frequency: 36, structure: 0.27, brightness: 0.6, damping: 0.85, position: 0.5,
      frequencyTrim: 0, structureTrim: 0, brightnessTrim: 0, dampingTrim: 0, positionTrim: 0,
      pitch: 0, frequency_mod: 0, structure_mod: 0, brightness_mod: 0,
      damping_mod: 0, position_mod: 0, strum: 0,
      ...overrides.controls,
    };
    for (let block = 0; block < blocks; block++) {
      controls.strum = block === 10 ? 1 : 0;
      kernel.render(controls, input, output);
      if (block > 200) {
        for (let i = 0; i < 24; i++) {
          odd.push(output[i * 2]);
          even.push(output[i * 2 + 1]);
        }
      }
    }
    return { odd, even };
  }

  /** Pure function. Fundamental frequency by autocorrelation peak. */
  function fundamental(signal, sampleRate) {
    let best = 0;
    let bestLag = 0;
    for (let lag = 20; lag < 800; lag++) {
      let sum = 0;
      for (let i = 0; i < signal.length - lag; i++) sum += signal[i] * signal[i + lag];
      if (sum > best) {
        best = sum;
        bestLag = lag;
      }
    }
    return sampleRate / bestLag;
  }

  /** Pure function. Zero-mean correlation coefficient of two equal-length signals. */
  function correlation(a, b) {
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < a.length; i++) {
      num += a[i] * b[i];
      da += a[i] * a[i];
      db += b[i] * b[i];
    }
    return num / Math.sqrt(da * db);
  }

  /** Pure function. RMS. */
  function rms(x) {
    return Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  }

  // THE PITCH. `frequency` 36 with `noteSource: external` rounds to 36, so the internal
  // MIDI note is 12 + 36 + 0 = 48 and the fundamental must be 440·2^((48−69)/12).
  const expectedHz = 440 * Math.pow(2, (48 - 69) / 12);
  for (const model of RINGS_MODELS) {
    const run = ringsRun({ model, controls: { position: 0.3 } });
    const measured = fundamental(run.odd, 48000);
    // A cent is 0.0578 % — the tolerance below is 0.5 %, which is the autocorrelation
    // lag's own quantisation at this pitch and not the port's error.
    near(`${model} fundamental is MIDI 48`, measured, expectedHz, expectedHz * 0.005);
  }

  // THE POSITION NULL. At exactly 0.5 the pickup sits at the midpoint, where the even
  // harmonics cancel — `CosineOscillator(0.5)` emits 1, 0, 1, 0, … so the even modes are
  // weighted by ZERO. This is not an approximation and the test says so.
  const atMidpoint = ringsRun({ model: "modal", controls: { position: 0.5 } });
  check("Rings' even output is EXACTLY silent at position 0.5",
    rms(atMidpoint.even) === 0, `rms ${rms(atMidpoint.even)}`);
  check("Rings' odd output is not", rms(atMidpoint.odd) > 0.01, `rms ${rms(atMidpoint.odd)}`);

  // THE DECORRELATION. P1 feeds ODD and EVEN to Clouds as a stereo pair, so one correct
  // output is not enough: the two must be genuinely independent.
  for (const position of [0.1, 0.3, 0.6482]) {
    const run = ringsRun({ model: "modal", controls: { position } });
    const r = correlation(run.odd, run.even);
    check(`Rings' odd/even are decorrelated at position ${position}`,
      Math.abs(r) < 0.05, `r = ${r.toFixed(4)}`);
    check(`both Rings outputs carry signal at position ${position}`,
      rms(run.odd) > 0.01 && rms(run.even) > 0.01,
      `odd ${rms(run.odd).toFixed(4)} even ${rms(run.even).toFixed(4)}`);
  }

  // Every model and polyphony must render finite audio and self-excite on a strum.
  for (const model of RINGS_MODELS) {
    for (const polyphony of [1, 2, 4]) {
      const run = ringsRun({ model, polyphony, controls: { position: 0.3 } }, 600);
      check(`${model}/poly${polyphony} renders finite audio`,
        run.odd.every(Number.isFinite) && run.even.every(Number.isFinite));
      check(`${model}/poly${polyphony} self-excites`,
        rms(run.odd) + rms(run.even) > 0.005,
        `rms ${(rms(run.odd) + rms(run.even)).toFixed(5)}`);
    }
  }

  let refusedModel = false;
  try {
    new RingsKernel(48000, {}).setModel("fmVoice");
  } catch {
    refusedModel = true;
  }
  check("Rings refuses an unreachable model loudly", refusedModel);

  let refusedPoly = false;
  try {
    new RingsKernel(48000, {}).setPolyphony(3);
  } catch {
    refusedPoly = true;
  }
  check("Rings refuses a polyphony Rack cannot select", refusedPoly);
}

// ════════════════════════════════════════════════════════════════════════════
// 6. BRANCHES — the Bernoulli distribution, measured
// ════════════════════════════════════════════════════════════════════════════
// The one thing that can be wrong about a Bernoulli gate and still look right is its
// BIAS, and the firmware has it inverted relative to Rack. This measures the direction as
// well as the magnitude.

section("6. Branches");
{
  /** Query. The fraction of triggers routed to B at one probability setting. */
  function branchesBias(probability, mode) {
    const kernel = new BranchesKernel(48000, { seed: 1 });
    const output = new Float32Array(4);
    let toB = 0;
    let triggers = 0;
    for (let i = 0; i < 40000; i++) {
      const gate = i % 10 < 5 ? 1 : 0;
      kernel.render({ p1: probability, p2: 0.5, mode1: mode, mode2: 0, in1: gate, in2: 0 }, null, output);
      if (i % 10 === 0) {
        triggers += 1;
        if (output[1] > 0) toB += 1;
      }
    }
    return { fraction: toB / triggers, triggers };
  }

  // HIGHER PROBABILITY MEANS MORE B. The firmware's polarity is the opposite; if this
  // check ever reads inverted, someone has ported the firmware instead of Rack.
  for (const p of [0.25, 0.5, 0.75]) {
    const measured = branchesBias(p, 0);
    near(`Branches routes ${p} of triggers to B`, measured.fraction, p, 0.03);
    check(`Branches saw the expected trigger count at p=${p}`, measured.triggers === 4000,
      `${measured.triggers}`);
  }
  near("Branches at p=0 never routes to B", branchesBias(0, 0).fraction, 0, 0);
  // 3999 OF 4000, NOT 4000 OF 4000, and the missing one is B4 rather than a rounding
  // error: Rack's `BooleanTrigger` starts UNINITIALIZED, so the module's very first high
  // sample does not fire. The counter here samples at `i % 10 === 0`, which IS that first
  // sample, so trigger zero is always absent. Asserting the exact count rather than
  // loosening the tolerance is what keeps that behaviour pinned in both directions.
  const atCertainty = branchesBias(1, 0);
  near("Branches at p=1 routes every trigger but the uninitialised first to B",
    atCertainty.fraction, (atCertainty.triggers - 1) / atCertainty.triggers, 0);

  // TOGGLE MODE IS A FLIP-FLOP: exactly one of A/B is high at every instant, gate or no
  // gate. Latch mode is not — it follows the gate, so both are low between triggers.
  {
    const kernel = new BranchesKernel(48000, { seed: 1 });
    const output = new Float32Array(4);
    let violations = 0;
    for (let i = 0; i < 5000; i++) {
      kernel.render({ p1: 0.5, p2: 0.5, mode1: 1, mode2: 0, in1: i % 10 < 5 ? 1 : 0, in2: 0 }, null, output);
      const high = (output[0] > 0 ? 1 : 0) + (output[1] > 0 ? 1 : 0);
      if (high !== 1) violations += 1;
    }
    check("Branches toggle mode holds exactly one output high", violations === 0,
      `${violations} of 5000 samples`);
  }
  {
    const kernel = new BranchesKernel(48000, { seed: 1 });
    const output = new Float32Array(4);
    let lowWhileGateLow = 0;
    for (let i = 0; i < 100; i++) {
      kernel.render({ p1: 0.5, p2: 0.5, mode1: 0, mode2: 0, in1: 0, in2: 0 }, null, output);
      if (output[0] === 0 && output[1] === 0) lowWhileGateLow += 1;
    }
    check("Branches latch mode follows the gate", lowWhileGateLow === 100, `${lowWhileGateLow}`);
  }

  // Rack's `BooleanTrigger` starts UNINITIALIZED, so the very first high does not fire.
  {
    const kernel = new BranchesKernel(48000, { seed: 1 });
    const output = new Float32Array(4);
    kernel.render({ p1: 1, p2: 0.5, mode1: 0, mode2: 0, in1: 1, in2: 0 }, null, output);
    check("Branches does not fire on its very first high sample", output[1] === 0,
      `B was ${output[1]}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 7. BLINDS AND SHADES — the multiply, and the two silent defaults
// ════════════════════════════════════════════════════════════════════════════

section("7. Blinds and Shades");
{
  // Blinds' ring modulator IS one multiply. Checking it against `a·b` directly is the
  // whole of its arithmetic, and it also proves the CV path's scaling.
  const blinds = new (await import("../synth/vc1_kernels.js")).BlindsKernel(48000, {});
  const input = new Float32Array(8);
  const output = new Float32Array(5);
  const controls = {};
  for (let n = 1; n <= 4; n++) {
    controls[`gain${n}`] = 0;
    controls[`mod${n}`] = n === 1 ? 1 : 0;
    controls[`offset${n}`] = 0;
  }
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const a = Math.sin(i * 0.3);
    const b = Math.sin(i * 0.07);
    input.fill(0);
    input[0] = a;
    input[1] = b;
    blinds.render(controls, input, output);
    worst = Math.max(worst, Math.abs(output[0] - a * b));
  }
  check("Blinds' ring modulator is exactly a·b", worst < 1e-6, `worst error ${worst}`);

  // THE ±2 CLAMP IS ON THE GAIN, NOT THE AUDIO — so a full-scale input at gain 2 leaves
  // at 2.0, unclipped. That is Rack's behaviour and a clamp on the product would be a
  // silent improvement nobody asked for.
  for (let n = 1; n <= 4; n++) {
    controls[`gain${n}`] = 1;
    controls[`mod${n}`] = 1;
  }
  input.fill(0);
  input[0] = 1;
  input[1] = 1;
  blinds.render(controls, input, output);
  near("Blinds' gain clamps at +2 and the audio does not", output[0], 2, 1e-6);

  // Shades at its defaults is SILENT, because attenuverter mode maps knob 0.5 to gain 0.
  const shades = new ShadesKernel(48000, {});
  const shadesOut = new Float32Array(4);
  const unity = new Float32Array([1, 1, 1]);
  const defaults = {};
  for (let n = 1; n <= 3; n++) {
    defaults[`gain${n}`] = 0.5;
    defaults[`mode${n}`] = 1;
    defaults[`offset${n}`] = 1;
  }
  shades.render(defaults, unity, shadesOut);
  check("Shades at its defaults is silent", Array.from(shadesOut).every((v) => v === 0),
    JSON.stringify(Array.from(shadesOut)));

  // And it is a real offset generator with nothing patched.
  shades.render({
    gain1: 1, mode1: 1, offset1: 1,
    gain2: 0, mode2: 1, offset2: 1,
    gain3: 0.5, mode3: 0, offset3: 1,
  }, new Float32Array(3), shadesOut);
  near("Shades channel 1 offsets to +1", shadesOut[0], 1, 1e-6);
  near("Shades channel 2 offsets to -1", shadesOut[1], -1, 1e-6);
  near("Shades channel 3 attenuates to +0.5", shadesOut[2], 0.5, 1e-6);
  near("Shades' mix sums the three", shadesOut[3], 0.5, 1e-6);
}

// ════════════════════════════════════════════════════════════════════════════
// 7b. MARBLES — the Beta ICDF against closed form, and DEJA VU against its own law
// ════════════════════════════════════════════════════════════════════════════

section("7b. Marbles");
{
  const kernels = await import("../synth/vc1_kernels.js");

  // ── THE BETA ICDF (deviation M3) ──────────────────────────────────────────
  // The source interpolates 45 precomputed `scipy.stats.beta.ppf` tables, which cannot be
  // generated here. So the ICDF is EVALUATED instead, and checked against the three Beta
  // cases that have closed forms — which proves the evaluator outright rather than
  // comparing it to tables we do not have. The (mu, nu) grid warp above it is transcribed
  // and remains UNMEASURED; that split is stated in M3 and is the honest one.
  near("Beta(1,1) ICDF is the identity", kernels.betaIcdf(0.3, 1, 1), 0.3, 1e-9);
  near("Beta(2,1) ICDF is sqrt(u)", kernels.betaIcdf(0.25, 2, 1), 0.5, 1e-9);
  near("Beta(1,2) ICDF is 1 - sqrt(1-u)", kernels.betaIcdf(0.75, 1, 2), 0.5, 1e-9);
  near("Beta(a,a) is symmetric about 0.5", kernels.betaIcdf(0.5, 2.8284, 2.8284), 0.5, 1e-9);
  near("the incomplete beta agrees with Beta(2,1)'s CDF", kernels.incompleteBeta(0.25, 2, 1), 0.0625, 1e-12);
  near("logGamma(5) is ln 24", kernels.logGamma(5), Math.log(24), 1e-10);
  // The jitter draw is Beta(2.828, 2.828) — the source's "beta(3,3) with a fatter tail".
  near("the jitter distribution is centred", kernels.fastBetaDistributionSample(0.5), 0.5, 1e-9);
  check("the jitter distribution is concentrated", kernels.fastBetaDistributionSample(0.1) < 0.3,
    `got ${kernels.fastBetaDistributionSample(0.1)}`);

  // The v1 hysteresis quantizer's cell mapping is load-bearing: with 17 steps, knob centre
  // MUST land on index 8, which is the unison divider pattern. `HysteresisQuantizer2`'s
  // mapping would put something else there.
  near("the v1 quantizer puts unison at knob centre",
    new kernels.HysteresisQuantizer().process(0.5, 17), 8, 0);

  /** Query. Sample X1 on every T1 rising edge, for `seconds` of audio. */
  function marblesXOnEdges(dejaVu, lengthKnob, seconds) {
    const kernel = new kernels.MarblesKernel(48000, { seed: 1 });
    kernel.setTMode("independentBernoulli");
    kernel.setTRange("4x");
    kernel.setXMode("identical");
    kernel.setXRange("full");
    kernel.setXScale("major");
    kernel.setYDivider("1/4");
    kernel.setXClockSource("t1");
    kernel.setClockMode("internal");
    kernel.setXClockMode("internal");
    kernel.setRegisterMode("internal");
    const input = new Float32Array(kernels.MARBLES_BLOCK_SIZE * 2);
    const output = new Float32Array(kernels.MARBLES_BLOCK_SIZE * 7);
    const controls = {
      dejaVu, dejaVuLength: lengthKnob, tRate: 0.4, tBias: 0.5, tJitter: 0,
      xSpread: 0.9, xBias: 0.5, xSteps: 0.9, tDejaVu: 1, xDejaVu: 1,
      t_rate: 0, t_bias: 0, t_jitter: 0, deja_vu: 0, x_spread: 0, x_bias: 0, x_steps: 0,
    };
    const values = [];
    let armed = true;
    for (let block = 0; block < (48000 / kernels.MARBLES_BLOCK_SIZE) * seconds; block++) {
      kernel.render(controls, input, output);
      for (let i = 0; i < kernels.MARBLES_BLOCK_SIZE; i++) {
        const high = output[i * 7] > 0;
        if (high && !armed) values.push(Number(output[i * 7 + 4].toFixed(6)));
        armed = high;
      }
    }
    return values;
  }

  /** Pure function. The shortest period a sequence repeats with, or −1. */
  function repeatPeriod(values, limit) {
    for (let p = 1; p <= limit; p++) {
      let ok = true;
      for (let i = p; i < values.length; i++) {
        if (values[i] !== values[i - p]) {
          ok = false;
          break;
        }
      }
      if (ok) return p;
    }
    return -1;
  }

  // ── THE DEJA-VU LAW, MEASURED END TO END ──────────────────────────────────
  // This is the module's whole reason to exist and it is the one claim worth proving
  // rather than describing: at 0.5 the X sequence must repeat with a period of EXACTLY the
  // loop length; at 0 it must not repeat at all; at 1 the loop's CONTENTS must be frozen
  // (so no more than `length` distinct values appear) while the order varies.
  // Knob index 24 of the 36-entry ladder is loop length 8.
  const lengthKnob = 24 / 35;
  const locked = marblesXOnEdges(0.5, lengthKnob, 20).slice(8);
  check("Marbles produced enough X values to test", locked.length >= 40, `${locked.length}`);
  near("deja vu 0.5 repeats with a period of exactly the loop length",
    repeatPeriod(locked, 16), 8, 0);
  const free = marblesXOnEdges(0, lengthKnob, 20).slice(8);
  near("deja vu 0 never repeats", repeatPeriod(free, 16), -1, 0);
  const shuffled = marblesXOnEdges(1, lengthKnob, 20).slice(8);
  check("deja vu 1 freezes the loop's CONTENTS", new Set(shuffled).size <= 8,
    `${new Set(shuffled).size} distinct values in ${shuffled.length} draws`);
  check("deja vu 1 still varies the ORDER", repeatPeriod(shuffled, 8) === -1,
    `period ${repeatPeriod(shuffled, 8)}`);

  // ── THE CLOCK RATE, per range, measured as T2's edge count ────────────────
  /** Query. T2 rising edges over `seconds`, which is the master phase's own rate. */
  function marblesClockHz(range, seconds) {
    const kernel = new kernels.MarblesKernel(48000, { seed: 1 });
    kernel.setTMode("independentBernoulli");
    kernel.setTRange(range);
    kernel.setXMode("identical");
    kernel.setXRange("full");
    kernel.setXScale("major");
    kernel.setYDivider("1/4");
    kernel.setXClockSource("t1t2t3");
    kernel.setClockMode("internal");
    kernel.setXClockMode("internal");
    kernel.setRegisterMode("internal");
    const input = new Float32Array(kernels.MARBLES_BLOCK_SIZE * 2);
    const output = new Float32Array(kernels.MARBLES_BLOCK_SIZE * 7);
    const controls = {
      dejaVu: 0.5, dejaVuLength: 0.5, tRate: 0, tBias: 0.5, tJitter: 0,
      xSpread: 0.5, xBias: 0.5, xSteps: 0.5, tDejaVu: 1, xDejaVu: 1,
      t_rate: 0, t_bias: 0, t_jitter: 0, deja_vu: 0, x_spread: 0, x_bias: 0, x_steps: 0,
    };
    let edges = 0;
    let armed = false;
    for (let block = 0; block < (48000 / kernels.MARBLES_BLOCK_SIZE) * seconds; block++) {
      kernel.render(controls, input, output);
      for (let i = 0; i < kernels.MARBLES_BLOCK_SIZE; i++) {
        const high = output[i * 7 + 1] > 0;
        if (high && !armed) edges += 1;
        armed = high;
      }
    }
    return edges / seconds;
  }
  // At rate 0 the three ranges' base rates are 0.5, 2 and 8 Hz. The tolerance is one edge
  // over the window, which is the counter's own resolution and not the port's error.
  near("the 0.25x range clocks at 0.5 Hz", marblesClockHz("0.25x", 8), 0.5, 1 / 8);
  near("the 1x range clocks at 2 Hz", marblesClockHz("1x", 8), 2, 1 / 8);
  near("the 4x range clocks at 8 Hz", marblesClockHz("4x", 8), 8, 1 / 8);

  // ── THE RATE CLAMP (deviation M6) ─────────────────────────────────────────
  // Rack leaves this sum unclamped and the hardware does not. MEASURED before the clamp
  // existed: at 1440 semitones the master phase reached 2.2e32 in five samples and every
  // voltage output became NaN for the rest of the session.
  for (const tRate of [-3, -1, 0, 1, 3]) {
    const kernel = new kernels.MarblesKernel(48000, { seed: 1 });
    kernel.setTMode("independentBernoulli");
    kernel.setTRange("4x");
    kernel.setXMode("identical");
    kernel.setXRange("full");
    kernel.setXScale("major");
    kernel.setYDivider("1/4");
    kernel.setXClockSource("t1");
    kernel.setClockMode("internal");
    kernel.setXClockMode("internal");
    kernel.setRegisterMode("internal");
    const input = new Float32Array(kernels.MARBLES_BLOCK_SIZE * 2);
    const output = new Float32Array(kernels.MARBLES_BLOCK_SIZE * 7);
    let nonFinite = 0;
    let peak = 0;
    for (let block = 0; block < 2000; block++) {
      kernel.render({
        dejaVu: 0.5, dejaVuLength: 0.5, tRate, tBias: 0.5, tJitter: 0.5,
        xSpread: 0.9, xBias: 0.5, xSteps: 0.9, tDejaVu: 1, xDejaVu: 1,
        t_rate: tRate, t_bias: 0, t_jitter: 0, deja_vu: 0, x_spread: 0, x_bias: 0, x_steps: 0,
      }, input, output);
      for (let i = 0; i < output.length; i++) {
        if (!Number.isFinite(output[i])) nonFinite += 1;
        peak = Math.max(peak, Math.abs(output[i]));
      }
    }
    check(`Marbles stays finite at rate ${tRate} plus the same again in CV`, nonFinite === 0,
      `${nonFinite} non-finite samples`);
    check(`Marbles stays in range at rate ${tRate}`, peak <= 1.001, `peak ${peak}`);
  }

  // Every t model must render finite output and actually fire.
  for (const model of kernels.MARBLES_T_MODELS) {
    const kernel = new kernels.MarblesKernel(48000, { seed: 1 });
    kernel.setTMode(model);
    kernel.setTRange("4x");
    kernel.setXMode("tilt");
    kernel.setXRange("full");
    kernel.setXScale("pelog");
    kernel.setYDivider("1/8");
    kernel.setXClockSource("t2");
    kernel.setClockMode("internal");
    kernel.setXClockMode("internal");
    kernel.setRegisterMode("internal");
    const input = new Float32Array(kernels.MARBLES_BLOCK_SIZE * 2);
    const output = new Float32Array(kernels.MARBLES_BLOCK_SIZE * 7);
    let fired = 0;
    let nonFinite = 0;
    for (let block = 0; block < 20000; block++) {
      kernel.render({
        dejaVu: 0.3, dejaVuLength: 0.6, tRate: 0.5, tBias: 0.7, tJitter: 0.3,
        xSpread: 0.7, xBias: 0.4, xSteps: 0.3, tDejaVu: 1, xDejaVu: 1,
        t_rate: 0, t_bias: 0, t_jitter: 0, deja_vu: 0, x_spread: 0, x_bias: 0, x_steps: 0,
      }, input, output);
      for (let i = 0; i < kernels.MARBLES_BLOCK_SIZE; i++) {
        if (output[i * 7] > 0 || output[i * 7 + 2] > 0) fired += 1;
        for (let c = 0; c < 7; c++) if (!Number.isFinite(output[i * 7 + c])) nonFinite += 1;
      }
    }
    check(`Marbles model ${model} is finite`, nonFinite === 0, `${nonFinite} non-finite`);
    check(`Marbles model ${model} fires`, fired > 0, `${fired} samples high`);
  }

  let refusedModel = false;
  try {
    new kernels.MarblesKernel(48000, {}).setTMode("nonesuch");
  } catch {
    refusedModel = true;
  }
  check("Marbles refuses an unknown t model loudly", refusedModel);
}

// ════════════════════════════════════════════════════════════════════════════
// 7c. RIPPLES — the circuit's own test vectors, and a measured response
// ════════════════════════════════════════════════════════════════════════════

section("7c. Ripples");
{
  const kernels = await import("../synth/vc1_kernels.js");

  // ── THE ONE INDEPENDENT TEST VECTOR THE CIRCUIT HAS ───────────────────────
  // `ripples.hpp`'s V-to-I converter is a resistor network with a clipped collector, and its
  // gain-unpatched case can be worked out by hand: rfb 47k, rc 42k, vc 12 V gives
  // vnom = −13.42857, clipped to −10, vneg = 1.617978, and iout = 11.617978/47000. That
  // 2.47191e-4 A is the "VCA fully open" bias current, and it is the one number in this
  // module that can be derived on paper and checked against the code.
  near("the V-to-I converter's gain-unpatched bias current",
    kernels.ripplesVtoI(47e3, 12, 42e3), 2.47191e-4, 1e-9);
  near("a zero CV gives zero current", kernels.ripplesVtoI(47e3, 0, 22e3, 0, 1e12), 0, 0);
  // The current is FLOORED AT ZERO, which is why a negative resonance CV shuts resonance
  // off rather than inverting it.
  check("a negative CV cannot make a negative current",
    kernels.ripplesVtoI(47e3, -5, 22e3, 0, 1e12) >= 0);

  // The OTA is a Padé approximant clamped at its own PEAK (2√3), so it saturates at exactly
  // ±1 and stays monotone. `Math.tanh` would give a different curve and this module's whole
  // character is that curve.
  near("the OTA is odd about zero", kernels.ripplesOtaVca(0, 0, 1e-3), 0, 0);
  // THE CEILING IS 0.989743319 OF THE BIAS CURRENT, NOT ALL OF IT. The approximant peaks at
  // exactly z = 2√3 (scanned) and that peak is 0.989743319, so the clamp makes it monotone
  // one percent below unity. `Math.tanh(2√3)` is 0.998042399 — substituting tanh would raise
  // the resonance path's ceiling by 0.83 %, which is the ceiling a self-oscillating filter
  // settles against. Asserting the real number rather than 1 is what keeps that honest.
  const OTA_CEILING = 0.989743319;
  near("the OTA saturates at 0.9897 of its bias current, not all of it",
    kernels.ripplesOtaVca(1, 0, 1e-3), OTA_CEILING * 1e-3, 1e-9);
  near("the OTA saturates symmetrically",
    kernels.ripplesOtaVca(-1, 0, 1e-3), -OTA_CEILING * 1e-3, 1e-9);
  check("the OTA's ceiling is BELOW tanh's, which is why tanh is not a substitute",
    OTA_CEILING < Math.tanh(2 * Math.sqrt(3)),
    `${OTA_CEILING} vs ${Math.tanh(2 * Math.sqrt(3))}`);
  check("the OTA is monotone past its clamp",
    kernels.ripplesOtaVca(5, 0, 1e-3) === kernels.ripplesOtaVca(50, 0, 1e-3));

  // The cog/scipy cascade table, at the two rates a browser actually runs at.
  near("48 kHz gets 3x oversampling", kernels.ripplesCascade(48000).factor, 3, 0);
  near("48 kHz gets a 12th-order cascade", kernels.ripplesCascade(48000).sections.length, 6, 0);
  near("44.1 kHz gets 3x oversampling", kernels.ripplesCascade(44100).factor, 3, 0);
  near("44.1 kHz gets a 14th-order cascade", kernels.ripplesCascade(44100).sections.length, 7, 0);
  check("a rate below the table falls back to the 8 kHz cascade",
    kernels.ripplesCascade(4000).factor === 15);

  /** Query. The measured magnitude of one output tap at one probe frequency. */
  function ripplesMagnitude(cutoffHz, resonance, probeHz, tap) {
    const kernel = new kernels.RipplesKernel(48000, { seed: 1 });
    const output = new Float32Array(4);
    const controls = {
      frequency: Math.log2(cutoffHz), resonance, fmTrim: 0,
      res: 0, freq: 0, fm: 0, gain: 0, gainPatched: 0,
    };
    const level = 0.2;
    const total = 24000;
    let peak = 0;
    for (let n = 0; n < total; n++) {
      kernel.render(controls, [level * Math.sin((2 * Math.PI * probeHz * n) / 48000)], output);
      if (n > total / 2) peak = Math.max(peak, Math.abs(output[tap]));
    }
    return peak / level;
  }

  // ── THE RESPONSE, AND THE −12 dB IS THE SHARP ASSERTION HERE ──────────────
  // Four IDENTICAL one-pole cells at the same corner give exactly −3 dB each at the nominal
  // cutoff, so the 4-pole output is −12 dB THERE — not −3. That is a property of the
  // topology rather than of a design choice, so it is the tightest thing this measurement
  // can claim, and it would break if the cells were given different corners or if
  // `rad_per_s` were scaled.
  const cutoff = 1000;
  const LP4 = 2;
  near("LP4 passes DC at unity", ripplesMagnitude(cutoff, 0, cutoff / 40, LP4), 1, 0.01);
  near("LP4 is -12 dB at the nominal cutoff — four one-poles, -3 dB each",
    ripplesMagnitude(cutoff, 0, cutoff, LP4), Math.pow(10, -12 / 20), 0.01);
  const oneOctave = ripplesMagnitude(cutoff, 0, cutoff * 2, LP4);
  const twoOctaves = ripplesMagnitude(cutoff, 0, cutoff * 4, LP4);
  // A four-pole approaches −24 dB/oct ASYMPTOTICALLY; one octave past the corner it is not
  // there yet, and the closed form for four one-poles gives −21.3 dB between these two
  // probes. Measuring the wrong expectation here is how a filter gets "fixed" into a
  // different filter, so the bound is on the closed form and not on the asymptote.
  const slope = 20 * Math.log10(twoOctaves / oneOctave);
  check("LP4's slope between +1 and +2 octaves is a four-pole's, not a two-pole's",
    slope < -15 && slope > -24, `${slope.toFixed(1)} dB/oct`);

  // Resonance must LIFT the corner, and it must do so through the saturating path — so the
  // lift is bounded rather than divergent.
  const flat = ripplesMagnitude(cutoff, 0, cutoff, LP4);
  const resonant = ripplesMagnitude(cutoff, 0.9, cutoff, LP4);
  check("resonance lifts the corner substantially", resonant > flat * 8,
    `${flat.toFixed(4)} -> ${resonant.toFixed(4)}`);
  check("resonance does not diverge", Number.isFinite(resonant) && resonant < 100,
    `${resonant}`);

  // ── SELF-OSCILLATION FROM SILENCE, WHICH IS WHAT THE DITHER IS FOR ────────
  // Zero is the ladder's only equilibrium, so without the half-microvolt dither a fully
  // resonant Ripples fed silence would stay silent forever. This is the check that proves
  // deviation P1 is load-bearing rather than decorative.
  {
    const kernel = new kernels.RipplesKernel(48000, { seed: 1 });
    const output = new Float32Array(4);
    const controls = {
      frequency: Math.log2(500), resonance: 1, fmTrim: 0,
      res: 0, freq: 0, fm: 0, gain: 0, gainPatched: 0,
    };
    let peak = 0;
    let nonFinite = 0;
    for (let n = 0; n < 48000 * 3; n++) {
      kernel.render(controls, [0], output);
      for (let i = 0; i < 4; i++) if (!Number.isFinite(output[i])) nonFinite += 1;
      if (n > 48000 * 2) peak = Math.max(peak, Math.abs(output[LP4]));
    }
    check("Ripples SELF-OSCILLATES from silence at full resonance", peak > 0.1,
      `peak ${peak.toFixed(5)} — if this is zero, the dither is gone and P1 was not decorative`);
    check("Ripples stays finite while self-oscillating", nonFinite === 0, `${nonFinite}`);
  }

  // Every output tap must carry signal, and the VCA tap must be the NON-inverting one.
  {
    const kernel = new kernels.RipplesKernel(48000, { seed: 1 });
    const output = new Float32Array(4);
    const controls = {
      frequency: Math.log2(2000), resonance: 0.3, fmTrim: 0,
      res: 0, freq: 0, fm: 0, gain: 0, gainPatched: 0,
    };
    const sums = [0, 0, 0, 0];
    const peaks = [0, 0, 0, 0];
    for (let n = 0; n < 12000; n++) {
      kernel.render(controls, [0.3 * Math.sin((2 * Math.PI * 200 * n) / 48000)], output);
      if (n > 6000) {
        for (let i = 0; i < 4; i++) {
          sums[i] += output[i] * output[i];
          peaks[i] = Math.max(peaks[i], Math.abs(output[i]));
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      check(`Ripples output ${i} carries signal`, peaks[i] > 0.001, `peak ${peaks[i]}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 7d. THE BOUNDARY RESAMPLER — the one part of the bridge bare node CAN check
// ════════════════════════════════════════════════════════════════════════════
// Clouds runs at 32 kHz and Rings at 48 kHz, so at a 48 kHz context Clouds' audio crosses a
// rate converter twice and Rings' does not cross one at all. That converter is the piece
// whose failure is least visible: a wrong ratio transposes, and a reader that overtakes its
// writer clicks — and NEITHER shows up in a peak, an RMS or a pitch measurement.

section("7d. The boundary resampler");
{
  const kernels = await import("../synth/vc1_kernels.js");

  // ── THE ARITHMETIC, ASSERTED ON THE READ POINTER ITSELF ──────────────────
  // Asserting it on the VALUES instead needs the ring to be full, because the reader starts
  // a primed lag behind the writer and therefore reads the region the writer reaches LAST —
  // zeros, until the first wrap. That startup silence is correct behaviour and is the
  // converter's latency; it is not what this check is about. The pointer is.
  const frame = new Float32Array(1);
  const stepping = new kernels.Resampler(1, 1024);
  const before = stepping.readPosition;
  for (let i = 0; i < 10; i++) stepping.pull(1.5, frame);
  near("ten pulls at ratio 1.5 advance the read pointer by exactly 15",
    (stepping.readPosition - before + 1024) % 1024, 15, 1e-9);
  const unity = new kernels.Resampler(1, 1024);
  const unityBefore = unity.readPosition;
  for (let i = 0; i < 10; i++) unity.pull(1, frame);
  near("ten pulls at ratio 1 advance the read pointer by exactly 10",
    (unity.readPosition - unityBefore + 1024) % 1024, 10, 1e-9);

  // And once the ring HAS been filled past the reader, a ratio of 1 really is a delay line.
  const filled = new kernels.Resampler(1, 1024);
  for (let i = 0; i < 4096; i++) {
    frame[0] = i % 64;
    filled.push(frame);
  }
  const read = [];
  for (let i = 0; i < 8; i++) {
    filled.pull(1, frame);
    read.push(frame[0]);
  }
  check("ratio 1 reads consecutive stored frames once the ring is full",
    read.every((v, i) => i === 0 || v === (read[i - 1] + 1) % 64),
    read.join(","));

  // A non-power-of-two ring would alias two positions onto each other, and a lag below the
  // interpolation kernel's reach would read unwritten frames. Both refuse loudly.
  let refusedCapacity = false;
  try {
    new kernels.Resampler(1, 1000);
  } catch {
    refusedCapacity = true;
  }
  check("the resampler refuses a non-power-of-two ring", refusedCapacity);
  let refusedLag = false;
  try {
    new kernels.Resampler(1, 1024, 1);
  } catch {
    refusedLag = true;
  }
  check("the resampler refuses a lag shorter than its interpolation kernel", refusedLag);

  // ── THE ROUND TRIP, WHICH IS WHAT THE PROCESSOR ACTUALLY DOES ─────────────
  // Push at 48 kHz, pull at 32 kHz in `blockSize` chunks, push the result back and pull at
  // 48 kHz — exactly `processors_vc1.js`'s loop. A unit sine must come back as a UNIT SINE:
  // right frequency, right amplitude, AND a peak of exactly 1, because a reader that
  // overtakes its writer shows up in the peak and in nothing else. MEASURED before the
  // primed lag existed: peak 1.20873 on a unit sine, with the frequency and RMS both still
  // correct — which is why this check asserts the peak and not just the tone.
  {
    const host = 48000;
    const inner = 32000;
    const up = inner / host;
    const down = host / inner;
    const blockSize = 32;
    const inputResampler = new kernels.Resampler(1, 1024);
    const outputResampler = new kernels.Resampler(1, 1024);
    const probe = 440;
    let pending = blockSize * 2;
    let n = 0;
    const out = [];
    for (let quantum = 0; quantum < 800; quantum++) {
      for (let i = 0; i < 128; i++) {
        frame[0] = Math.sin((2 * Math.PI * probe * n) / host);
        n += 1;
        inputResampler.push(frame);
      }
      pending += 128 * up;
      while (pending >= blockSize) {
        for (let i = 0; i < blockSize; i++) {
          inputResampler.pull(down, frame);
          outputResampler.push(frame);
        }
        pending -= blockSize;
      }
      for (let i = 0; i < 128; i++) {
        outputResampler.pull(up, frame);
        out.push(frame[0]);
      }
    }
    const tail = out.slice(40000);
    /** Query. The amplitude of one frequency in a signal, by a single Goertzel bin. */
    const amplitudeAt = (signal, rate, hz) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < signal.length; i++) {
        const angle = (2 * Math.PI * hz * i) / rate;
        re += signal[i] * Math.cos(angle);
        im -= signal[i] * Math.sin(angle);
      }
      return (2 * Math.sqrt(re * re + im * im)) / signal.length;
    };
    near("the round trip keeps the tone at 440 Hz and at unit amplitude",
      amplitudeAt(tail, host, probe), 1, 0.01);
    check("the round trip puts nothing at 220 or 880 Hz",
      amplitudeAt(tail, host, 220) < 0.01 && amplitudeAt(tail, host, 880) < 0.01,
      `${amplitudeAt(tail, host, 220)} / ${amplitudeAt(tail, host, 880)}`);
    // THE PEAK IS THE CHECK THAT CATCHES A READER OVERTAKING ITS WRITER.
    near("a unit sine comes back with a peak of exactly 1",
      Math.max(...tail.map(Math.abs)), 1, 0.005);
    near("…and the RMS of a unit sine", Math.sqrt(tail.reduce((s, v) => s + v * v, 0) / tail.length),
      Math.SQRT1_2, 0.005);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 8. THE CONTRACT — spec, roster, kernel and plugin barrel, in every direction
// ════════════════════════════════════════════════════════════════════════════
// These are the seams that fail SILENTLY. A knob with no param is an Inspector row that
// does nothing; a param with no knob is state no author can reach; a spec option list
// that has drifted from the kernel's is a dropdown offering a value the kernel refuses.

section("8. Spec / roster / kernel / plugin contract");
{
  const rosterByModule = new Map(VC1_PROCESSORS.map((row) => [row.module, row]));

  check("every spec has a roster row and vice versa",
    BLOCK_SPECS.length === VC1_PROCESSORS.length,
    `${BLOCK_SPECS.length} specs, ${VC1_PROCESSORS.length} roster rows`);
  check("BLOCK_WORKLET_MODULES is an ARRAY, not a Set",
    Array.isArray(BLOCK_WORKLET_MODULES),
    "AX-3 shipped a Set and it was swept back — see core/audio_blocks.js's contract");
  check("BLOCK_PLUGINS covers BLOCK_SPECS exactly",
    BLOCK_PLUGINS.length === BLOCK_SPECS.length,
    `${BLOCK_PLUGINS.length} plugins, ${BLOCK_SPECS.length} specs`);
  BLOCK_SPECS.forEach((spec, index) => {
    check(`plugin ${index} is the spec at the same index`,
      BLOCK_PLUGINS[index] && BLOCK_PLUGINS[index].type === spec.type,
      `${BLOCK_PLUGINS[index] && BLOCK_PLUGINS[index].type} vs ${spec.type}`);
    check(`${spec.type} has a module factory`,
      typeof BLOCK_MODULE_FACTORIES[spec.module] === "function");
    check(`${spec.type} is in BLOCK_WORKLET_MODULES`,
      BLOCK_WORKLET_MODULES.includes(spec.module));
    check(`${spec.type}'s title carries neither the prefix nor the suffix the registry adds`,
      !spec.title.startsWith("Audio ") && !spec.title.endsWith(" Node"),
      `title is ${JSON.stringify(spec.title)}`);
  });

  for (const spec of BLOCK_SPECS) {
    const row = rosterByModule.get(spec.module);
    if (!row) {
      check(`${spec.type} has a roster row`, false);
      continue;
    }
    const params = new Map(row.params.map((p) => [p.name, p]));
    const audio = new Set(row.audioInputs);

    // A PORT MUST REACH EXACTLY ONE OF THE TWO ROUTES. An `audio`-typed port is always an
    // audio input; a `number` port is always an a-rate param; a `trigger` port may be
    // EITHER, and Marbles is why — its clock ports are triggers that the kernel needs at
    // sample accuracy, so they come in as audio inputs, while Clouds' and Branches' gates
    // are params sampled at the block boundary. Both are legal; being in neither, or in
    // both, is not.
    for (const port of spec.inputs) {
      const asParam = params.has(port.key);
      const asAudio = audio.has(port.key);
      check(`${spec.type}: port ${port.key} reaches exactly one route`,
        (asParam ? 1 : 0) + (asAudio ? 1 : 0) === 1,
        `param ${asParam}, audio ${asAudio}`);
      if (port.type === "audio") {
        check(`${spec.type}: an audio port must be an audio input (${port.key})`, asAudio);
      } else if (port.type === "number") {
        check(`${spec.type}: a number port must be an AudioParam (${port.key})`, asParam);
      }
    }
    for (const port of spec.outputs) {
      check(`${spec.type}: output ${port.key} is in the roster`, row.outputs.includes(port.key));
    }
    for (const knob of spec.knobs) {
      const isOption = row.options.includes(knob.key) || row.construct.includes(knob.key);
      check(`${spec.type}: knob ${knob.key} reaches a param or an option`,
        isOption || params.has(knob.key));
      const param = params.get(knob.key);
      if (!param) continue;
      // A KNOB'S DEFAULT AND ITS PARAM'S DEFAULT MUST AGREE, or a fresh node sounds
      // different from what its Inspector says. Measured: Shades' mode defaulted to 0 in
      // the roster and 1 in the spec, which made a fresh Shades an attenuator that
      // emitted 2.1 of DC instead of the silent attenuverter Rack gives you.
      near(`${spec.type}: ${knob.key} default agrees with its param`,
        param.defaultValue, knob.default, 0);
      if (knob.min !== undefined) {
        near(`${spec.type}: ${knob.key} min agrees with its param`, param.minValue, knob.min, 0);
      }
      if (knob.max !== undefined) {
        near(`${spec.type}: ${knob.key} max agrees with its param`, param.maxValue, knob.max, 0);
      }
    }
    for (const option of [...row.options, ...row.construct]) {
      check(`${spec.type}: option ${option} has a knob`,
        spec.knobs.some((k) => k.key === option));
    }
    for (const param of row.params) {
      check(`${spec.type}: param ${param.name} is not also an audio port`, !audio.has(param.name),
        "one would silently shadow the other in the module factory");
      check(`${spec.type}: param ${param.name} is a-rate`, param.automationRate === "a-rate");
    }
    // Every option must have a setter on the kernel, or the processor throws at the first
    // message instead of at build.
    const kernel = new row.kernel(48000, { seed: 1 });
    for (const option of row.options) {
      check(`${spec.type}: kernel has ${vc1OptionSetter(option)}`,
        typeof kernel[vc1OptionSetter(option)] === "function");
    }
    check(`${spec.type}: kernel declares its channels`,
      row.kernel.channels && typeof row.kernel.blockSize === "number");
    check(`${spec.type}: roster output count matches the kernel's`,
      row.outputs.length === row.kernel.channels.out,
      `${row.outputs.length} vs ${row.kernel.channels.out}`);
    check(`${spec.type}: roster audio-input count matches the kernel's`,
      row.audioInputs.length === row.kernel.channels.in,
      `${row.audioInputs.length} vs ${row.kernel.channels.in}`);
  }

  // The spec files may not import synth/**, so their option lists are RESTATED. Pin them.
  const cloudsPlayback = BLOCK_SPECS.find((s) => s.module === "vcvClouds")
    .knobs.find((k) => k.key === "playback").options;
  check("Clouds' spec playback options match the kernel's",
    JSON.stringify(cloudsPlayback) === JSON.stringify(CLOUDS_PLAYBACK_MODES),
    `${JSON.stringify(cloudsPlayback)} vs ${JSON.stringify(CLOUDS_PLAYBACK_MODES)}`);
  const cloudsQuality = BLOCK_SPECS.find((s) => s.module === "vcvClouds")
    .knobs.find((k) => k.key === "quality").options;
  check("Clouds' spec quality options match the kernel's",
    JSON.stringify(cloudsQuality) === JSON.stringify(CLOUDS_QUALITIES),
    `${JSON.stringify(cloudsQuality)} vs ${JSON.stringify(CLOUDS_QUALITIES)}`);
  const ringsModels = BLOCK_SPECS.find((s) => s.module === "vcvRings")
    .knobs.find((k) => k.key === "model").options;
  check("Rings' spec model options match the kernel's",
    JSON.stringify(ringsModels) === JSON.stringify(RINGS_MODELS),
    `${JSON.stringify(ringsModels)} vs ${JSON.stringify(RINGS_MODELS)}`);

  // ── THE CABLES THE SELECTED DECKS ACTUALLY DRAW MUST BE LEGAL DROPS ───────
  // This is not a style check. `core/nodeflow.COERCIONS` has NO `audio -> trigger` entry, so
  // declaring a clock output `audio` silently makes it un-wireable to any trigger input —
  // and the first version of this block did exactly that, which would have made
  // `Marbles[t2] -> Rings[strum]` an illegal drop. That cable is in the canonical
  // granular-ambient deck. So the deck's own cable list is the test.
  const portType = (type, direction, key) => {
    const spec = BLOCK_SPECS.find((s) => s.type === type);
    const list = direction === "output" ? spec.outputs : spec.inputs;
    const port = list.find((p) => p.key === key);
    return port ? port.type : null;
  };
  const deckCables = [
    ["audio_vcv_marbles", "t2", "audio_vcv_rings", "strum"],
    ["audio_vcv_marbles", "t1", "audio_vcv_clouds", "trig"],
    ["audio_vcv_marbles", "t3", "audio_vcv_branches", "in1"],
    ["audio_vcv_branches", "out1a", "audio_vcv_clouds", "trig"],
    // P1's self-patch. The port is `y_out` and not `y`, because a bare `y` would shadow the
    // item's stored POSITION — see the spec file's note 4.
    ["audio_vcv_marbles", "y_out", "audio_vcv_marbles", "t_jitter"],
    ["audio_vcv_marbles", "x2", "audio_vcv_rings", "pitch"],
    ["audio_vcv_rings", "odd", "audio_vcv_clouds", "in_l"],
    ["audio_vcv_rings", "even", "audio_vcv_clouds", "in_r"],
    ["audio_vcv_marbles", "t1", "audio_vcv_clouds", "freeze"],
    ["audio_vcv_shades", "out1", "audio_vcv_rings", "position_mod"],
    ["audio_vcv_blinds", "mix", "audio_vcv_clouds", "in_l"],
  ];
  for (const [fromType, fromPort, toType, toPort] of deckCables) {
    const from = portType(fromType, "output", fromPort);
    const to = portType(toType, "input", toPort);
    check(`${fromType}[${fromPort}] -> ${toType}[${toPort}] is a legal drop`,
      from !== null && to !== null && typesCompatible(from, to),
      `${from} -> ${to}`);
  }

  // Every knob must carry help, because a ported module's knob is meaningless without it.
  for (const spec of BLOCK_SPECS) {
    for (const knob of spec.knobs) {
      check(`${spec.type}: knob ${knob.key} has help`,
        typeof knob.help === "string" && knob.help.length > 20);
    }
    check(`${spec.type} has help`, typeof spec.help === "string" && spec.help.length > 40);
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks`);
if (failures > 0) process.exit(1);
