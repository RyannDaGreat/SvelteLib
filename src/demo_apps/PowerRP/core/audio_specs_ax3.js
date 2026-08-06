/**
 * THE AX-3 FILTER SPECS — nine ported Axoloti filters, one declarative record each.
 *
 * Same shape and same contract as core/audio_specs.js (read its header first: what
 * a spec is, what the port types mean, what `construct: true` buys). This file adds
 * ONE field, and it is required of every ported node.
 *
 * ── `derivation` — R7-17's DEBUGGING RECORD, NOT AN ATTRIBUTION ─────────────
 * User: *"it's so we can debug shit and find flaws in the emulation"*. That purpose
 * is what decides the shape: a licence tag would be useless for it, so each record
 * carries the exact source object AND THE COMMIT IT WAS READ AT, WHICH CODE BLOCK
 * the recurrence came from, THE RECURRENCE ITSELF IN FLOAT, and EVERY DELIBERATE
 * DEVIATION BY NAME. When a patch sounds wrong, this is the entry point; without
 * it, finding the flaw means re-reading the original library from scratch.
 *
 * The recurrences here and the code in synth/worklets/processors_ax3.js are the
 * same arithmetic said twice, once for a reader and once for the machine — and
 * BOTH are checked against an INTEGER model of the original C by
 * tests/port_ax3_test.js, which is what stops the prose from drifting into a
 * confident wrong answer.
 *
 * ── ⚠ THESE NODES ARE TUNED IN SEMITONES, NOT HERTZ. STATED HERE ONCE ───────
 * Every other module in the library takes a cutoff in hertz, and this file
 * deliberately breaks with that. THE REASON IS THE MODULATION INPUT, not the knob.
 * Axoloti's filters sum `param_pitch + inlet_pitch` in the PITCH domain and convert
 * once, so an LFO of depth 12 sweeps an octave WHEREVER the knob is parked. A
 * hertz-domain input summing the same 12 would be an octave at 12 Hz and nothing at
 * 12 kHz — a different sweep, and the sweep IS the sound these filters were voiced
 * for. R7-11's ruling is to port the SOUND faithfully and make the LABEL honest, so
 * the unit is theirs (`st`, semitones from E4) and every `help` gives the hertz.
 *
 *     pitch 0 = MIDI 64 = E4 = 329.6276 Hz;  hz = 440 * 2^((pitch - 5)/12)
 *
 * A hertz knob is still one expression away: `= log2(800 / 329.6276) * 12`.
 *
 * ── AND RESONANCE IS THE DIAL, NOT Q ────────────────────────────────────────
 * For the same reason, one level down. `1 - dial/64` IS the coefficient the
 * firmware multiplies by — `Q = 32/(64 - dial)` is only what `FilterQ.java` prints.
 * A Q knob would need the map inverted on every read, and its pole at dial 64 would
 * turn the top of the range into a cliff no author could aim at.
 *
 * Zero PowerRP-runtime and zero synth imports: this is data, exactly as
 * core/audio_specs.js is. (`semitonesToHz` is core/, and is the ONE core-side statement
 * of the law above — see its docblock for why it must be restated at all.)
 */

import { semitonesToHz } from "./audio_nodes.js";

/** A frac32 dial's full scale. 64 is 1.0 — `ValueFrac32.getFrac()` is `v * 2^21`
 *  and `__USAT(., 27)` saturates at `64 * 2^21`. Every 0…64 range below is this. */
const AX_DIAL_FULL = 64;

/** `frac32.s.map.pitch`'s own dial: signed, ±64 semitones, ticking whole semitones
 *  (`ParameterInstanceFrac32SMap.getMin/getMax/getTick`). ±64 st from E4 is
 *  8.2 Hz … 13.3 kHz, which is the whole audible band and then some.
 *
 *  `hz` IS THE RULING'S MITIGATION, carried here so it reaches every pitch knob at
 *  once: these nodes diverge from the rest of the library by being tuned in semitones,
 *  so every card that reads one out also shows the frequency (core/audio_nodes.js
 *  audioReadout states why). */
const AX_PITCH = { min: -AX_DIAL_FULL, max: AX_DIAL_FULL, step: 1, unit: " st", hz: semitonesToHz };

/** The SVFs read their pitch through `MTOFEXTENDED`, whose `__SSAT(., 29)` is one
 *  bit wider — ±128 semitones. The KNOB is still the ±64 dial; the extra range is
 *  headroom for what a modulation input may add on top, exactly as theirs is. */
const AX_PITCH_EXTENDED_LIMIT = 128;

/** The resonance dial every biquad and SVF in this file shares. Restated per spec
 *  only where the DEFAULT differs, because the meaning does not. */
const AX_RESO = {
  key: "reso", label: "Resonance", default: 32, min: 0, max: AX_DIAL_FULL, step: 0.5,
  help: "Axoloti's own 0…64 resonance dial, which IS the coefficient: the filter multiplies by `1 - dial/64`, and `Q = 32/(64 - dial)` is only how their editor prints it. 0 is Q = 0.5, 32 is Q = 1, 48 is Q = 2, 56 is Q = 4, and 64 is a pole the dial can approach but their saturation never lets it reach.",
};

/** The delay lines are sized at the largest either source allows: TSG's biggest
 *  `buffsize` combo entry, 16384 samples — 341 ms at 48 kHz. `filter/allpass`'s own
 *  spinner stops at 10000, so this covers both. */
const AX_DELAY_MAX_SAMPLES = 16383;

/** TSG refuses to read closer than eight samples behind the write head. */
const AX_DELAY_MIN_SAMPLES = 8;

// ── THE BIQUAD FAMILY ───────────────────────────────────────────────────────

export const AX_BIQUAD_SPEC = {
  type: "audio_ax_biquad", module: "axBiquad", title: "Axoloti Biquad", family: "filter",
  icon: "mdi:filter-variant", readout: "pitch",
  help: "Axoloti's `filter/lp`, `bp` and `hp` — the 2-pole resonant biquad their factory patches are built on. ITS RESONANCE DOES NOT CHANGE ITS LEVEL: the numerator carries an extra 1/(2Q) that the RBJ cookbook does not, so the gain at the corner is 0.5 at every Q. That is what makes it safe to sweep hard, and it is the single most-cited difference between this and our own `Filter`.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "pitch", type: "number", label: "pitch" },
    { key: "reso", type: "number", label: "reso" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "pitch", label: "Cutoff", default: 24, ...AX_PITCH, help: "Cutoff in SEMITONES from E4 (pitch 0 = 329.6276 Hz, so 24 is 1318.5 Hz). Semitones rather than hertz because the `pitch` INPUT sums here in the pitch domain, which is what makes an LFO sweep the same octave wherever the knob is parked. Clamps at half the sample rate, exactly as `mtof` does." },
    { ...AX_RESO },
    { key: "mode", label: "Mode", default: "lowpass", discrete: true, options: ["lowpass", "bandpass", "highpass"], help: "Which of the three objects this is. LOWPASS and HIGHPASS carry the extra 1/(2Q) normalisation; BANDPASS does not need it, because `b0 = alpha/a0` is already constant-peak — their own source comment says so." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/filter/{lp, lp m, bp, bp m, hp, hp m}.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.krate -> biquad_lp_coefs / biquad_bp_coefs / biquad_hp_coefs + biquad_dsp, axoloti/axoloti firmware/axoloti_filters.h:97-169 @ tag 1.0.12",
    recurrence: [
      "// once per 16-sample control tick",
      "fc    = min(440 * 2**((pitch - 5) / 12), fs / 2)   // mtof, with its 24 kHz clamp at 48 kHz",
      "qinv  = 1 - reso / 64                              // == 1/(2Q), Q = 32/(64 - reso)",
      "w0    = 2 * PI * fc / fs",
      "alpha = sin(w0) * qinv",
      "a0    = 1 + alpha",
      "lp:  b0 = ((1 - cos w0) / 2) * qinv / a0 ; b1 =  2 * b0 ; b2 =  b0   // <-- THE EXTRA qinv",
      "bp:  b0 = alpha / a0                     ; b1 =  0      ; b2 = -b0   // <-- and NONE here",
      "hp:  b0 = ((1 + cos w0) / 2) * qinv / a0 ; b1 = -2 * b0 ; b2 =  b0",
      "cy1   = (-2 * cos w0) / a0 ; cy2 = (1 - alpha) / a0",
      "// per sample, Direct Form 1",
      "y = b0*x + b1*x1 + b2*x2 - cy1*y1 - cy2*y2",
      "x2 = x1 ; x1 = x ; y2 = y1 ; y1 = y        // the STATE keeps the unsaturated y",
      "out = clamp(y, -1, 1)                      // __SSAT(., 28) on the OUTPUT only",
    ].join("\n"),
    deviations: [
      "THE EXTRA qinv IS REPRODUCED and is the whole point: omitting it makes every resonant sweep 1/(2Q) too loud — measured at 8.0x (18 dB) at Q = 4 in tests/port_ax3_test.js.",
      "TUNED IN SEMITONES, and the modulation input sums in the pitch domain. Faithful to theirs; a break with the rest of our library, argued in this file's header.",
      "`mtof`'s PIECEWISE-LINEAR pitch table is not reproduced. It is a 257-entry lookup that exists to avoid a pow() on a Cortex-M4 and its error is <=0.7 cents; we compute the exponential directly, so the port is slightly MORE in tune than the original.",
      "`arm_sin_q31` is a 512-entry interpolated table (~1e-5 relative); we call Math.sin.",
      "COEFFICIENTS ARE DOUBLES, not int32 on a 2^28 scale with a single-precision reciprocal. Measured worst coefficient disagreement across 126 (mode, pitch, reso) points: 1.7e-7, which is the firmware's own resolution.",
      "THE SAMPLE RATE IS THE CONTEXT'S, not a hard-wired 48000. At 44.1 kHz the filter still tunes correctly but is not sample-identical to the hardware.",
      "THE STATE WRAPS AT +/-16.0 because `filter_y_n1 = filteroutput` is a bare int32 assignment while only the OUTPUT gets `__SSAT(., 28)`. Reproduced — but MEASURED AS UNREACHABLE: at resonance 64, 60000 samples of on-corner drive leave the state at 3.5e-5, because the extra qinv shrinks the input gain as 1/(2Q) exactly as fast as the ring-up grows. It is kept because it costs nothing and removes the Infinity failure mode a float recursion otherwise has, not because this filter needs it.",
    ],
  },
};

export const AX_VCF3_SPEC = {
  type: "audio_ax_vcf3", module: "axVcf3", title: "Axoloti VCF3", family: "filter",
  icon: "mdi:filter", readout: "pitch",
  help: "Axoloti's `filter/vcf3` — and it is NOT the Biquad above with a different name. It calls the OLDER `f_filter_biquad_A`, which has no constant-peak normalisation (so it really does get louder as you open the resonance) and whose numerator is [2, 1, 2] where a lowpass wants [1, 2, 1] (so it has no null at Nyquist and sits about 1.9 dB high). Both look like slips in the original; both are what a vcf3 patch was voiced against, so both are ported.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "pitch", type: "number", label: "pitch" },
    { key: "reso", type: "number", label: "reso" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "pitch", label: "Cutoff", default: 24, ...AX_PITCH, help: "Cutoff in semitones from E4. Note this object's param is a plain `frac32.s.map`, not `.map.pitch` — the same number, printed without a note name." },
    { ...AX_RESO, help: `${AX_RESO.help} ⚠ ON THIS FILTER RESONANCE ALSO RAISES THE LEVEL, because vcf3 predates the normalisation the Biquad has. Expect to pull its output down as you open it.` },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/filter/vcf3.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.krate -> f_filter_biquad_A, axoloti/axoloti firmware/axoloti_filters.c:72-118 @ tag 1.0.12",
    recurrence: [
      "// once per 16-sample control tick — same alpha and denominator as the Biquad",
      "fc = min(440 * 2**((pitch - 5)/12), fs/2) ; qinv = 1 - reso/64",
      "w0 = 2*PI*fc/fs ; alpha = sin(w0)*qinv ; a0 = 1 + alpha",
      "bOuter = (1 - cos w0) / a0        // x[n] AND x[n-2]  — no extra qinv",
      "bInner = bOuter / 2               // x[n-1]           — a HALVING, not a doubling",
      "cy1 = (-2 * cos w0)/a0 ; cy2 = (1 - alpha)/a0",
      "// per sample",
      "y = clamp(bOuter*x + bInner*x1 + bOuter*x2 - cy1*y1 - cy2*y2, -16, 16)",
      "x2 = x1 ; x1 = x ; y2 = y1 ; y1 = y        // the SATURATED y feeds back here",
      "out = y                                     // ...and is also the output",
    ].join("\n"),
    deviations: [
      "NO EXTRA qinv AND A [2, 1, 2] NUMERATOR — reproduced, not corrected. Measured: the corner gain rises more than 3x from reso 16 to reso 56, and the response at Nyquist is non-zero where a [1, 2, 1] lowpass nulls.",
      "SATURATION IS AT +/-16.0 (the full frac32 range, `__SSAT(accu, 28) << 4`) and the SATURATED value is what feeds back — the opposite split from `biquad_dsp`, which saturates only the output. Both are ported as written.",
      "The missing `filter_W0 >> 1` is NOT a tuning difference: this path calls `SINE2TINTERP`, which takes a full uint32 phase where `arm_sin_q31` takes q31. Two spellings of sin(2*PI*fc/fs). Its source's own warning about `filter_W0 > 0x50000000` is therefore about the same Nyquist region `mtof` already clamps.",
      "Semitone tuning, direct exponential, double coefficients, context sample rate — as AX_BIQUAD_SPEC.",
    ],
  },
};

// ── THE ONE-POLE ────────────────────────────────────────────────────────────

export const AX_ONEPOLE_SPEC = {
  type: "audio_ax_onepole", module: "axOnePole", title: "Axoloti One-Pole", family: "filter",
  icon: "mdi:filter-outline", readout: "pitch",
  help: "Axoloti's `filter/lp1` and `hp1` — the cheap 6 dB/octave tone control, no resonance. ⚠ ITS KNOB IS NOT WHERE ITS CORNER IS: the coefficient is `2*fc/fs`, so the -3 dB point lands at fc/PI, roughly a third of the frequency the knob names. That is their recurrence, not a rounding error, and it is reproduced rather than corrected — but the label says so, which theirs does not.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "pitch", type: "number", label: "pitch" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "pitch", label: "Freq", default: 24, ...AX_PITCH, help: "In semitones from E4 (24 = 1318.5 Hz). THE ACTUAL -3 dB CORNER IS THIS OVER PI — about 420 Hz at this default. At the clamp (half the sample rate) the coefficient reaches exactly 1.0, which is their instability point and is reproduced." },
    { key: "mode", label: "Mode", default: "lowpass", discrete: true, options: ["lowpass", "highpass"], help: "`lp1` outputs the running average; `hp1` outputs the input MINUS it. One recurrence, two taps — which is literally how the two objects differ." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/filter/{lp1, lp1 m, hp1, hp1 m}.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.krate (MTOF) + code.srate (`val = ___SMMLA((inlet_in - val) << 1, f, val)`)",
    recurrence: [
      "// once per control tick: f is mtof's PHASE INCREMENT, and <<1 over a /2^32 product",
      "// leaves 2*fc/fs — NOT 1 - exp(-2*PI*fc/fs)",
      "alpha = 2 * min(440 * 2**((pitch - 5)/12), fs/2) / fs",
      "// per sample",
      "val += (x - val) * alpha",
      "out = (mode == 'highpass') ? x - val : val",
    ].join("\n"),
    deviations: [
      "THE fc/PI CORNER IS REPRODUCED, THE LABEL IS FIXED. R7-11's `env/ad` ruling applied: port the sound, make the readout honest. Measured: gain at fc/PI is 0.7071 within 2%, and at the frequency the knob names the filter is already 7.5 dB down.",
      "Semitone tuning, direct exponential, context sample rate — as AX_BIQUAD_SPEC.",
    ],
  },
};

// ── THE STATE-VARIABLE FILTERS ──────────────────────────────────────────────

export const AX_SVF_SPEC = {
  type: "audio_ax_svf", module: "axSvf", title: "Axoloti SVF", family: "filter",
  icon: "mdi:tune-variant", readout: "pitch", w: 165,
  help: "Axoloti's `lp svf` / `bp svf` / `hp svf` as the one object that already exposes all three: `multimode svf m`. A Chamberlin state-variable filter — cheaper than the biquad, sweeps more musically, and self-oscillates. TWO THINGS TO KNOW: its tuning FOLDS above a quarter of the sample rate (its frequency coefficient is the oscillator's sine table, which peaks at fs/4 and comes back down), and its stability is UNGUARDED at high cutoff with high resonance — theirs folds through int32 there, and so does this.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "pitch", type: "number", label: "pitch" },
    { key: "reso", type: "number", label: "reso" },
  ],
  outputs: [
    { key: "hp", type: "audio", label: "hp" },
    { key: "bp", type: "audio", label: "bp" },
    { key: "lp", type: "audio", label: "lp" },
  ],
  knobs: [
    { key: "pitch", label: "Cutoff", default: 24, ...AX_PITCH, help: "In semitones from E4. This filter reads its pitch through `MTOFEXTENDED`, whose saturation is one bit wider than the biquad's, so the `pitch` input may push the total to ±128 st where the biquad stops at ±64." },
    { ...AX_RESO, help: `${AX_RESO.help} THIS FILTER SQUARES IT AND HALVES IT: its damping is qinv²/2, so its Q is 2/qinv² where the biquad's is 1/(2·qinv). The same dial is a much sharper control here — 48 is already Q = 8.` },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/filter/{lp svf, bp svf, hp svf, multimode svf m}.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.krate (damp + SINE2TINTERP of MTOFEXTENDED) + code.srate (the four-line Chamberlin recursion)",
    recurrence: [
      "// once per control tick",
      "damp = (1 - reso/64)**2 / 2      // ___SMMUL(d,d) with NO shift is a built-in halving",
      "f    = sin(2 * PI * min(440*2**((pitch-5)/12), fs/2) / fs)   // the OSCILLATOR sine table",
      "// per sample, IN THIS ORDER — high reads the just-updated low, band the just-computed high",
      "notch = x - damp * band",
      "low  += f * band",
      "high  = notch - low",
      "band += f * high",
      "// every one of those wraps at +/-16.0, which is what their unsaturated int32 does",
    ].join("\n"),
    deviations: [
      "STABILITY IS NOT GUARDED, DELIBERATELY. The original has no `__SSAT` in this recursion, so it WRAPS rather than exploding; `axWrapFrac32` reproduces the int32 fold exactly. A clamp would have been a different filter and a bare float would have poisoned the graph with Infinity — proven bounded over 20000 samples at the least stable corner the dials allow.",
      "THE TUNING FOLD IS REPRODUCED. The textbook Chamberlin coefficient is 2*sin(PI*fc/fs); theirs is sin(2*PI*fc/fs) because it reuses the oscillator's phase-increment table. They agree at low cutoff and diverge above it, and above fs/4 theirs tunes BACKWARDS. There is no separate tuning table anywhere in the firmware.",
      "ONE NODE FOR FOUR OBJECTS. `multimode svf m` already computes all three taps and discards two; the single-tap objects are that object with two outlets deleted. `notch` is computed but never exposed, here as there — it is not one of their outputs and inventing it would not be a port.",
      "Semitone tuning, direct exponential, context sample rate — as AX_BIQUAD_SPEC.",
    ],
  },
};

export const AX_ZDF_SVF_SPEC = {
  type: "audio_ax_zdf_svf", module: "axZdfSvf", title: "Axoloti ZDF SVF", family: "filter",
  icon: "mdi:sine-wave", readout: "pitch", w: 165,
  help: "Smashed Transistors' `ZDF SVF 1` — a zero-delay-feedback state-variable filter that stays in tune and stable where the plain Chamberlin above does not. It gets there by building a one-step matrix at a heavily oversampled rate and SQUARING IT SEVEN TIMES, and by interpolating its coefficients across the sixteen samples of each control tick instead of stepping them. Q reaches 80.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "pitch", type: "number", label: "pitch" },
    { key: "Q", type: "number", label: "Q" },
  ],
  outputs: [
    { key: "lp", type: "audio", label: "lp12" },
    { key: "hp", type: "audio", label: "hp12" },
    { key: "bp", type: "audio", label: "bp6" },
  ],
  knobs: [
    { key: "pitch", label: "Cutoff", default: 24, ...AX_PITCH, help: "In semitones from E4. Read through `MTOFEXTENDED`, as the Chamberlin SVF's is." },
    { key: "Q", label: "Q", default: 16, min: 0, max: AX_DIAL_FULL, step: 0.5, help: "0…64 on the dial, mapped by tiar's own quartic to Q = 0.25 … 80 — `0.25 + q(1 + q²(18.75 + 60q))`, which is nearly linear at the bottom and very steep at the top. NOT the same control as the other filters' Resonance: this one is a Q, not an inverse-Q." },
  ],
  derivation: {
    source: "axoloti/axoloti-contrib objects/tiar/filter/ZDF SVF 1.axo @ tag 1.0.12 (798166f0ce29f4b6a39099b3bde6ef2e7755a7c4)",
    block: "code.declaration -> update(); code.krate (Q map, MTOFEXTENDED, state clamp); code.srate (the three-line recursion)",
    recurrence: [
      "// once per control tick",
      "q = 0.25 + (Q/64)*(1 + (Q/64)**2 * (18.75 + 60*(Q/64)))      // tiar's own 0.25 -> 80 map",
      "D = 1 / (2*q)",
      "F = 205 * 2*PI * fc / fs**2          // his TRF_coef folded; see the deviation below",
      "a = F*F ; tmp = 1 - a - D*F ; b = F*tmp + F ; c = tmp*tmp - a",
      "repeat 7 times:  a' = b*b + a*(2 - a) ;  b' = b*(1 + c - a) ;  c' = c*c - b*b",
      "da, db, dc = (target - current) / 16                          // his srate interpolation",
      "clamp lp and bp to +/-3.9922                                  // ONCE PER TICK, not per sample",
      "// per sample",
      "a += da ; b += db ; c += dc",
      "xLp = x - lp",
      "lp += a*xLp + b*bp        // -> lp12",
      "hp  = x - D*bp - lp       // -> hp12   (NEW lp, OLD bp — the order is the filter)",
      "bp  = b*xLp + c*bp        // -> bp6",
    ].join("\n"),
    deviations: [
      "`TRF_coef` IS FOLDED INTO (fc, fs). His constant spells the sample rate in two places and multiplies a phase increment that spells it in a third; everything but 205*2*PI*fc/fs² cancels. Kept reduced because the literal form would silently mistune at 44.1 kHz.",
      "HIS `- 7` ON THE PITCH SUM IS NOT REPRODUCED. It is seven RAW frac32 units, i.e. 3.3e-6 of a semitone; our pitch is a float and there is no integer to nudge.",
      "THE ONE-BUFFER LATENESS IS REPRODUCED. `da = (na - a)/16` means a block STARTS at the previous block's coefficients and only arrives at the sixteenth sample — the same deliberate lag as `gain/vca`'s k-to-s ramp, asserted in tests/port_ax3_test.js rather than left as a claim.",
      "HIS STATE CLAMP IS PER CONTROL TICK, NOT PER SAMPLE, and is ported at that rate: a per-sample clamp is a softer and quite different nonlinearity.",
      "Already float in the original, so there is no fixed-point rescaling here at all — only the pitch domain and the sample rate.",
    ],
  },
};

// ── SMOOTHING, DIFFUSION AND COMBING ────────────────────────────────────────

export const AX_KFILTER_LOWPASS_SPEC = {
  type: "audio_ax_kfilter_lowpass", module: "axKFilterLowpass", title: "Axoloti K-Smoother", family: "filter",
  icon: "mdi:chart-line-variant", readout: "rise",
  help: "Axoloti's `kfilter/lowpass` with Smashed Transistors' `LPRiseDecay` folded in — the CONTROL-RATE one-pole you put in front of a modulation input so a stepped value glides instead of jumping. It runs once every sixteen samples and HOLDS between ticks, which is what a k-rate object does on that platform and is deliberately not smoothed away here. Setting Rise and Decay equal is `kfilter/lowpass`; splitting them lets a value climb fast and fall slowly, or the reverse.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "rise", type: "number", label: "rise" },
    { key: "decay", type: "number", label: "decay" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "rise", label: "Rise", default: -24, ...AX_PITCH, help: "How fast the output climbs toward a HIGHER input, as a pitch (semitones from E4) — the same `mtof` the audio filters use, just applied to a control signal. -24 st is 82 Hz, i.e. a time constant of a few milliseconds; go down to -64 for a slow drift." },
    { key: "decay", label: "Decay", default: -24, ...AX_PITCH, help: "The same, for a FALLING input. Equal to Rise, this object is exactly `kfilter/lowpass`." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/kfilter/lowpass.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa; axoloti/axoloti-contrib objects/tiar/kfilter/LPRiseDecay.axo @ tag 1.0.12",
    block: "code.krate on both — `MTOF(...)` then `y = ___SMMLA((inlet_in - y) << 1, f, y)`; LPRiseDecay's whole body is that with a ternary choosing the coefficient",
    recurrence: [
      "// ONCE PER CONTROL TICK (fs/16), and the result is HELD for the sixteen samples between",
      "pitch = (x > y) ? rise : decay",
      "y += (x - y) * 2 * min(440 * 2**((pitch - 5)/12), fs/2) / fs",
      "// the input is read at the tick boundary: frac32buffer -> frac32 takes sample 0, not an average",
    ].join("\n"),
    deviations: [
      "TWO OBJECTS, ONE NODE, because `kfilter/lowpass` is `LPRiseDecay` with rise == decay. Shipping both would be two implementations of one recurrence.",
      "THE STAIRCASE IS KEPT. Output is held across each tick, as a k-rate outlet is on the hardware. Smoothing it would make this node's whole purpose — being the thing that smooths — invisible.",
      "Their params are `frac32.s.map.lfopitch`, which differs from `.map.pitch` only in how the editor PRINTS the value; the raw number and the `MTOF` are identical.",
      "Semitone tuning, direct exponential, context sample rate — as AX_BIQUAD_SPEC.",
    ],
  },
};

export const AX_ALLPASS_SPEC = {
  type: "audio_ax_allpass", module: "axAllpass", title: "Axoloti Allpass", family: "filter",
  icon: "mdi:swap-horizontal", readout: "delay",
  help: "Axoloti's `filter/allpass` — the Schroeder allpass section every reverb, diffuser and FDN is built out of. It passes EVERY frequency at unity gain and only smears them in time, which is why a chain of them turns an echo into a wash without colouring it. Its delay is modulatable (Smashed Transistors' `allpass m` folded in), and a slowly wobbling allpass is a chorus.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "delay", type: "number", label: "delay" },
    { key: "g", type: "number", label: "g" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "delay", label: "Delay", default: 1000, min: AX_DELAY_MIN_SAMPLES, max: AX_DELAY_MAX_SAMPLES, step: 1, unit: " smp", help: "Length of the internal delay line, IN SAMPLES — 1000 is 20.8 ms at 48 kHz. Samples rather than milliseconds because that is the unit their spinner uses and because the classic Schroeder diffuser is a set of MUTUALLY PRIME sample counts, which is a choice you cannot make in milliseconds. Fractional values interpolate, so this can be swept." },
    { key: "g", label: "Gain", default: 0.5, min: -1, max: 1, step: 0.01, help: "The allpass coefficient. 0 is a plain delay; toward ±1 the smear grows long and the section rings. Negative inverts the feedback path, which changes the phase pattern without changing the (flat) magnitude." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/filter/allpass.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa; axoloti/axoloti-contrib objects/TSG/filter/allpass m.axo @ tag 1.0.12",
    block: "code.krate (`g2 = param_g << 4`) + code.srate (the three SMMLA/SMMLS lines over an int16 line)",
    recurrence: [
      "// their delay line stores a HALF-SCALED int16, which is why the source is full of",
      "// >>1 and <<1 that cancel. Recovered, with v = 2 * (what they store):",
      "vDelayed = line[n - M]",
      "v        = x + g * vDelayed ;  line[n] = v",
      "out      = vDelayed - g * v",
    ].join("\n"),
    deviations: [
      "THE LINE IS float32, NOT int16. Theirs writes `din >> 15`, throwing away 15 bits on every sample — about 5e-4 of full scale after the doubling, which is exactly the residual tests/port_ax3_test.js measures against the integer model. Inside a long reverb tail that quantisation is audible as a noise floor the port does not have.",
      "FRACTIONAL DELAY LANDS ON EXACTLY M. TSG's own 2-point path interpolates between `line[w - rint]` and `line[w - rint + 1]`, so at frac = 0 it reads a delay of rint - 1 — an off-by-one against the delay it just computed. Not reproduced; his 3-point path is not ported at all.",
      "THE STATE WRAPS AT +/-16.0, as their unsaturated int32 `din` does. At |g| = 1 the inner comb never decays, so this is reachable from the knob.",
      "TSG'S ADDRESSING IS REPLACED BY A SAMPLE COUNT. His `time` inlet is a Q27 FRACTION of a power-of-two buffer chosen from a combo; ours is the sample count `filter/allpass`'s spinner already uses, and the line is sized at his largest combo entry (16384) so both ranges fit. His 8-sample minimum read distance is kept.",
    ],
  },
};

export const AX_FDBKCOMB_SPEC = {
  type: "audio_ax_fdbkcomb", module: "axFdbkComb", title: "Axoloti Comb", family: "filter",
  icon: "mdi:barcode", readout: "delay",
  help: "Axoloti's `filter/fdbkcomb` — the feedback comb, the other half of a Schroeder reverb and, at short delays, a Karplus-Strong string. ⚠ ITS B KNOB IS APPLIED AT HALF ITS VALUE. Their own description says `y(n) = b*x(n) + a*y(n-D)`, but the code halves the input path and does not say so; the port keeps the sound and fixes the sentence.",
  inputs: [
    // ── WHY THE FEEDBACK COMB DOES **NOT** DECLARE `feedbackSafe` ─────────────
    // It did, for a day, on the reasoning "this node IS a feedback structure." That
    // conflates two different loops, and only one of them is a graph edge.
    //
    // 1. THE COMB'S OWN FEEDBACK IS INSIDE THE ENGINE MODULE. `y = 0.5*b*x +
    //    a*y[n-D]` runs against a Float32Array owned by `ax-fdbkcomb-processor`
    //    (synth/worklets/processors_ax3.js). No wire carries it, so there is no
    //    cycle for NF-CORE to refuse and nothing for an exemption to permit. What
    //    `feedbackSafe` actually licenses is an EXTERNAL patch — comb.out routed
    //    back to comb.in through other nodes — which is a different structure that
    //    this node needs no more than any other filter does.
    // 2. IT WOULD FAIL DELAY_SPEC'S BAR ANYWAY. That bar is "an actual delay of >=
    //    one render quantum in the audio path", and this knob's floor is ONE SAMPLE
    //    (`minValue: 1` on the processor's `delay` param, matching their spinner).
    //    An external loop closed at delay < 128 is precisely the "zero-delay module
    //    / real feedback explosion" DELAY_SPEC warns about — and Web Audio would
    //    mute the cycle itself, since it requires >= one quantum of delay in one.
    //
    // So the exemption stays a list of one. A rule policed at one site is cheaper
    // than a rule policed at thirty-five, and the honest place for this node's
    // recursion is where it already is: inside the processor.
    { key: "in", type: "audio", label: "in" },
    { key: "delay", type: "number", label: "delay" },
    { key: "a", type: "number", label: "a" },
    { key: "b", type: "number", label: "b" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "delay", label: "Delay", default: 1000, min: 1, max: AX_DELAY_MAX_SAMPLES, step: 1, unit: " smp", help: "Loop length in SAMPLES, and therefore the comb's fundamental: fs/delay. 1000 samples is 48 Hz at 48 kHz; drop to 200 and the comb becomes a pitch. Rounded to a whole sample — their read pointer is an integer index with no interpolation." },
    { key: "a", label: "Feedback", default: 0.5, min: -1, max: 1, step: 0.01, help: "How much of the output returns. |a| < 1 decays, |a| = 1 never does, and negative inverts every repeat — which halves the comb's fundamental. THE RANGE REACHES 1 BECAUSE THEIRS DOES; this is the one node here that can run away, and at |a| = 1 its accumulator really does climb to the ±16 fold." },
    { key: "b", label: "Input", default: 1, min: -1, max: 1, step: 0.01, help: "Level into the loop. APPLIED AT HALF: b = 1 gives y[0] = 0.5 for a unit impulse, because `___SMMUL(b2, in)` is a q31 times a frac32 with no `<<1`. Ported as written." },
  ],
  derivation: {
    source: "axoloti/axoloti-factory objects/filter/fdbkcomb.axo @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa",
    block: "code.krate (`a2 = param_a << 4; b2 = param_b << 4`) + code.srate",
    recurrence: [
      "// the input SMMUL is unshifted (a halving); the feedback term's halving is cancelled",
      "// by the delay line's >>15 / <<16 pair, so only the input path is affected:",
      "y = 0.5 * b * x + a * y[n - D]",
      "line[n] = y ; out = y",
    ].join("\n"),
    deviations: [
      "THE HALVED B IS REPRODUCED AND THE LABEL SAYS SO — R7-11's `env/ad` ruling applied to a gain instead of a time. Pinned numerically: a unit impulse at b = 1 emits exactly 0.5.",
      "THE LINE IS float32, NOT int16 — as the Allpass. Measured residual against the integer model: 1.5e-4.",
      "THE ACCUMULATOR WRAPS AT +/-16.0, as their unsaturated int32 does, and here it is genuinely reached: at a = 1 driven at the comb's own fundamental the state climbs to 15.999 and folds. Their int16 delay line additionally wraps at +/-8.0 (`din >> 15` overflowing an int16); that second fold is NOT reproduced, for the same reason its quantisation is not.",
      "Their spinner tops out at 10000 samples; the line here is 16384 so it can share the Allpass's size. Nothing about the recurrence changes.",
    ],
  },
};

export const AX_BUTTERWORTH10_SPEC = {
  type: "audio_ax_butterworth10", module: "axButterworth10", title: "Axoloti Butterworth 10", family: "filter",
  icon: "mdi:filter-check", readout: "fc",
  help: "Smashed Transistors' `Butt10` — a 10-pole (60 dB/octave) Butterworth lowpass, five cascaded biquads with tabulated coefficients. A brick wall, for anti-aliasing in front of a decimator or for cutting the top off a harsh oscillator. Ten fixed cutoffs and no resonance: he shipped the coefficients, not a design routine, so those ten are what exist.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "fc", label: "Cutoff", default: "9k", discrete: true, options: ["17.7k", "15.3k", "12.7k", "9k", "6.5k", "4.2k", "3.3k", "2.5k", "1.4k", "900"], help: "His own menu, in his own order (highest first). These are NOMINAL AT 48 kHz — the coefficients are tabulated numbers, not a design, so on a 44.1 kHz context every one of them lands proportionally lower (about 8% down). A discrete row rather than a number because there is nothing between the entries." },
  ],
  derivation: {
    source: "axoloti/axoloti-contrib objects/tiar/filter/Butt10.axo @ tag 1.0.12 (798166f0ce29f4b6a39099b3bde6ef2e7755a7c4)",
    block: "code.declaration -> class LPbiq::calc(); code.krate -> the ten #if attr_fc coefficient blocks",
    recurrence: [
      "// five stages in series; only (b0, a1) are tabulated, the rest he derives:",
      "b1 = 2 * b0",
      "a2 = 1 - 2*b1 - a1            // pins unity gain at DC — his own comment says so",
      "// per sample, per stage",
      "y = b0*(x + x2) + b1*x1 + a1*y1 + a2*y2",
      "x2 = x1 ; x1 = x ; y2 = y1 ; y1 = y",
    ].join("\n"),
    deviations: [
      "b1 AND a2 ARE DERIVED, NOT TABULATED — as in his `calc()`. Tabulating them would be a second source of truth for numbers the first one already fixes. Verified: DC gain is 1.0 to 1e-12 for all fifty stages, and every pole is inside the unit circle.",
      "THE CUTOFFS ARE FIXED AT 48 kHz and are not rescaled for another context, because rescaling needs the pole positions he did not ship. Named in the knob's help rather than silently wrong.",
      "No output saturation, as his has none. Already float in the original.",
    ],
  },
};

/**
 * THE AX-3 SPECS, in the order a filter chain is usually reached for: the two
 * biquads, the one-pole, the two state-variable filters, the smoother, then the
 * two delay-line sections and the brick wall.
 *
 * The lead splices this into core/audio_specs.AUDIO_SPECS; until then nothing
 * registers these, which is the intended failure mode (see AUDIO_SPECS' own note).
 */
export const BLOCK_SPECS = [
  AX_BIQUAD_SPEC, AX_VCF3_SPEC, AX_ONEPOLE_SPEC, AX_SVF_SPEC, AX_ZDF_SVF_SPEC,
  AX_KFILTER_LOWPASS_SPEC, AX_ALLPASS_SPEC, AX_FDBKCOMB_SPEC, AX_BUTTERWORTH10_SPEC,
];

/**
 * The extended pitch limit the two SVFs accept on their `pitch` INPUT, exported
 * because synth/modules_ax3.js declares the same number on its AudioParam and the
 * two must not drift. `MTOFEXTENDED`'s `__SSAT(., 29)`; the biquads' `MTOF` uses
 * `__SSAT(., 28)`, which is the ±64 the knob already declares.
 */
export const AX_PITCH_INPUT_LIMIT = AX_PITCH_EXTENDED_LIMIT;
