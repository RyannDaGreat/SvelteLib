# Axoloti A/B faithfulness — measured, not transcribed

**45 of 45 attempted cases ran on both sides, covering 28 distinct `audio_ax_*` nodes against 40 factory objects. 1 disagree; 2 diverge for a recorded reason.**

## Failures, first

| case | node | finding | diagnosis |
| --- | --- | --- | --- |
| `allpass` | audio_ax_allpass | WAVEFORM max|Δ| 0.4121, NCC 0.8729 | our delay line is one sample short; `delay: 1001` matches their `attr_delay: 1000` at NCC 1.000000 |

## Divergences that are EXPECTED, with the reason

| case | measured | why this is not a defect |
| --- | --- | --- |
| `noise_uniform` | WAVEFORM max|Δ| 1.9872, NCC -0.0025 | Their `rand_s32()` folds in `RNG->DR`, the STM32 hardware entropy source: NOT reproducible on real Axoloti either, so a sample match is not a thing that exists. Judged on spectral tilt and level instead, which agree. |
| `noise_pink` | WAVEFORM max|Δ| 1.1592, NCC 0.0240 | Same hardware RNG as `noise_uniform`. The pink filter bank on top is deterministic, and the tilt measurement is what tests it. |

## Tuning and spectrum — pitched sources

| case | object | f0 axo (Hz) | f0 ours (Hz) | Δ cents | harmonics 1-8 axo | harmonics 1-8 ours | max Δ harm | max abs err | NCC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `osc_sine_p0` | `osc/sine.axo` | 329.63 | 329.63 | 0.0 | 1.00 0.00 0.00 0.00 0.00 0.00 0.00 0.00 | 1.00 0.00 0.00 0.00 0.00 0.00 0.00 0.00 | 0.000 | 0.0000 | 1.0000 |
| `osc_sine_p12` | `osc/sine.axo` | 659.26 | 659.26 | 0.0 | 1.00 0.00 0.00 0.00 0.00 0.00 0.00 0.00 | 1.00 0.00 0.00 0.00 0.00 0.00 0.00 0.00 | 0.000 | 0.0000 | 1.0000 |
| `osc_sine_pm24` | `osc/sine.axo` | 82.43 | 82.43 | 0.0 | 1.00 0.00 0.00 0.00 0.00 0.00 0.00 0.00 | 1.00 0.00 0.00 0.00 0.00 0.00 0.00 0.00 | 0.000 | 0.0001 | 1.0000 |
| `osc_saw_p0` | `osc/saw.axo` | 329.63 | 329.63 | 0.0 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.12 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.12 | 0.000 | 0.0126 | 1.0000 |
| `osc_saw_p12` | `osc/saw.axo` | 659.26 | 659.26 | 0.0 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.12 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.12 | 0.000 | 0.0126 | 1.0000 |
| `osc_square_p0` | `osc/square.axo` | 329.63 | 329.63 | 0.0 | 1.00 0.00 0.33 0.00 0.20 0.00 0.14 0.00 | 1.00 0.00 0.33 0.00 0.20 0.00 0.14 0.00 | 0.000 | 0.0126 | 1.0000 |
| `osc_pwm_p0` | `osc/pwm.axo` | 329.63 | 329.63 | 0.0 | 1.00 0.00 0.33 0.00 0.20 0.00 0.14 0.00 | 1.00 0.00 0.33 0.00 0.20 0.00 0.14 0.00 | 0.000 | 0.0126 | 1.0000 |
| `osc_pwm_pw50` | `osc/pwm.axo` | 329.63 | 329.63 | 0.0 | 1.00 0.71 0.33 0.00 0.20 0.24 0.14 0.00 | 1.00 0.71 0.33 0.00 0.20 0.24 0.14 0.00 | 0.000 | 0.0126 | 1.0000 |
| `osc_sawmed_p0` | `osc/saw medium.axo` | 329.63 | 329.63 | 0.0 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.12 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.12 | 0.000 | 0.0003 | 1.0000 |
| `phasor_p0` | `osc/phasor.axo` | 329.63 | 329.63 | -0.0 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.12 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.12 | 0.000 | 0.0000 | 1.0000 |
| `lfo_sine_p0` | `lfo/sine.axo` | 5.15 | 5.15 | 0.0 | 1.00 0.02 0.00 0.00 0.00 0.00 0.00 0.00 | 1.00 0.02 0.00 0.00 0.00 0.00 0.00 0.00 | 0.000 | 0.0000 | 1.0000 |
| `lfo_sine_pm24` | `lfo/sine.axo` | 1.67 | 1.67 | 0.0 | 1.00 0.95 0.38 0.01 0.00 0.00 0.00 0.00 | 1.00 0.95 0.38 0.01 0.00 0.00 0.00 0.00 | 0.000 | 0.0000 | 1.0000 |
| `lfo_saw_p0` | `lfo/saw.axo` | 5.15 | 5.15 | -0.0 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.13 | 1.00 0.50 0.33 0.25 0.20 0.17 0.14 0.13 | 0.000 | 0.0000 | 1.0000 |
| `lfo_square_p0` | `lfo/square.axo` | 5.15 | 5.15 | 0.0 | 1.00 0.02 0.33 0.01 0.20 0.00 0.14 0.00 | 1.00 0.02 0.33 0.01 0.20 0.00 0.14 0.00 | 0.000 | 0.0000 | 1.0000 |
| `noise_uniform` | `noise/uniform.axo` | 9297.18 | 21288.42 | 1434.2 | 1.00 0.25 0.00 0.00 0.00 0.00 0.00 0.00 | 1.00 0.00 0.00 0.00 0.00 0.00 0.00 0.00 | 0.249 | 1.9872 | -0.0025 |
| `noise_pink` | `noise/pink.axo` | 103.29 | 129.63 | 393.2 | 1.00 0.31 0.27 0.14 0.32 0.19 0.14 0.09 | 1.00 0.37 0.28 0.27 0.29 0.32 0.30 0.35 | 0.263 | 1.1592 | 0.0240 |

## Filters — corner frequency and passband

| case | object | corner axo (Hz) | corner ours (Hz) | peak dB axo | peak dB ours | max abs err | NCC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `vcf3` | `filter/vcf3.axo` | 1523 | 1523 | 3.1 | 3.1 | 0.0000 | 1.0000 |
| `onepole_lp` | `filter/lp1.axo` | 433 | 433 | -0.0 | -0.0 | 0.0000 | 1.0000 |
| `onepole_hp` | `filter/hp1.axo` | — | — | -0.3 | -0.3 | 0.0000 | 1.0000 |
| `svf_lp` | `filter/lp svf.axo` | 1373 | 1373 | 18.0 | 18.0 | 0.0000 | 1.0000 |
| `biquad_lp` | `filter/lp.axo` | 1528 | 1528 | -4.8 | -4.8 | 0.0000 | 1.0000 |
| `kfilter_lowpass` | `kfilter/lowpass.axo` | 34 | 34 | -22.0 | -22.0 | 0.0000 | 1.0000 |
| `allpass` | `filter/allpass.axo` | — | — | 0.0 | 0.0 | 0.4121 | 0.8729 |
| `fdbkcomb` | `filter/fdbkcomb.axo` | 52 | 52 | -6.0 | -6.0 | 0.0002 | 1.0000 |
| `xfade` | `mix/xfade.axo` | 433 | 433 | 3.6 | 3.6 | 0.0000 | 1.0000 |
| `dist_soft` | `dist/soft.axo` | 222 | 222 | 24.6 | 24.6 | 0.0000 | 1.0000 |
| `mix4` | `mix/mix 4.axo` | 223 | 223 | 8.9 | 8.9 | 0.0000 | 1.0000 |
| `math_star` | `math/STAR.axo` | 433 | 433 | 3.6 | 3.6 | 0.0000 | 1.0000 |
| `math_plus` | `math/PLUS.axo` | 433 | 433 | 6.1 | 6.1 | 0.0000 | 1.0000 |
| `math_max` | `math/max.axo` | 433 | 433 | -2.5 | -2.5 | 0.0000 | 1.0000 |
| `math_abs` | `math/abs.axo` | 1054 | 1054 | -30.6 | -30.6 | 0.0000 | 1.0000 |
| `math_sat` | `math/sat.axo` | 433 | 433 | 11.2 | 11.2 | 0.0000 | 1.0000 |
| `smooth` | `math/smooth.axo` | 35 | 35 | -27.4 | -27.4 | 0.0000 | 1.0000 |
| `window` | `math/window.axo` | 228 | 33 | -88.9 | -141.6 | 0.0001 | 1.0000 |
| `latch` | `logic/latch.axo` | 35 | 35 | 4.5 | 4.5 | 0.0000 | 1.0000 |
| `convert_b2u` | `conv/bipolar2unipolar.axo` | 433 | 433 | 0.0 | 0.0 | 0.0000 | 1.0000 |
| `mux2` | `mux/mux 2.axo` | — | — | -3051.1 | -3051.1 | 0.0000 | 1.0000 |

## Envelopes — stage times

| case | object | attack-to-90% axo (ms) | ours (ms) | 1/e fall axo (ms) | ours (ms) | peak axo | peak ours | NCC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `env_adsr` | `env/adsr.axo` | 87.3 | 87.3 | 615.0 | 615.0 | 1.000 | 1.000 | 1.0000 |
| `env_d` | `env/d.axo` | 0.0 | 0.0 | 96.7 | 96.7 | 1.000 | 1.000 | 1.0000 |
| `env_d_lin` | `env/d lin m.axo` | 0.0 | 0.0 | 61.4 | 61.4 | 1.000 | 1.000 | 1.0000 |
| `env_ahd` | `env/ahd m.axo` | 65.0 | 65.0 | 28.0 | 28.0 | 1.000 | 1.000 | 1.0000 |

## Everything, raw

| case | node | object | kind | rms axo | rms ours | max abs err | NCC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `osc_sine_p0` | audio_ax_osc (sine) | `osc/sine.axo` | osc | 0.7071 | 0.7071 | 0.0000 | 1.0000 |
| `osc_sine_p12` | audio_ax_osc (sine) | `osc/sine.axo` | osc | 0.7071 | 0.7071 | 0.0000 | 1.0000 |
| `osc_sine_pm24` | audio_ax_osc (sine) | `osc/sine.axo` | osc | 0.7072 | 0.7072 | 0.0001 | 1.0000 |
| `osc_saw_p0` | audio_ax_osc (saw) | `osc/saw.axo` | osc | 0.2880 | 0.2880 | 0.0126 | 1.0000 |
| `osc_saw_p12` | audio_ax_osc (saw) | `osc/saw.axo` | osc | 0.2885 | 0.2885 | 0.0126 | 1.0000 |
| `osc_square_p0` | audio_ax_osc (square) | `osc/square.axo` | osc | 0.4985 | 0.4985 | 0.0126 | 1.0000 |
| `osc_pwm_p0` | audio_ax_osc (pwm) | `osc/pwm.axo` | osc | 0.4985 | 0.4985 | 0.0126 | 1.0000 |
| `osc_pwm_pw50` | audio_ax_osc (pwm) | `osc/pwm.axo` | osc | 0.4985 | 0.4985 | 0.0126 | 1.0000 |
| `osc_sawmed_p0` | audio_ax_osc (sawMedium) | `osc/saw medium.axo` | osc | 0.0717 | 0.0717 | 0.0003 | 1.0000 |
| `phasor_p0` | audio_ax_phasor | `osc/phasor.axo` | osc | 0.5773 | 0.5773 | 0.0000 | 1.0000 |
| `lfo_sine_p0` | audio_ax_lfo (sine) | `lfo/sine.axo` | lfo | 0.7055 | 0.7055 | 0.0000 | 1.0000 |
| `lfo_sine_pm24` | audio_ax_lfo (sine) | `lfo/sine.axo` | lfo | 0.7385 | 0.7385 | 0.0000 | 1.0000 |
| `lfo_saw_p0` | audio_ax_lfo (saw) | `lfo/saw.axo` | lfo | 0.5453 | 0.5453 | 0.0000 | 1.0000 |
| `lfo_square_p0` | audio_ax_lfo (square) | `lfo/square.axo` | lfo | 0.7542 | 0.7542 | 0.0000 | 1.0000 |
| `env_adsr` | audio_ax_env_adsr | `env/adsr.axo` | env | 0.4293 | 0.4293 | 0.0000 | 1.0000 |
| `env_d` | audio_ax_env_d | `env/d.axo` | env | 0.1887 | 0.1887 | 0.0000 | 1.0000 |
| `env_d_lin` | audio_ax_env_d_lin_m | `env/d lin m.axo` | env | 0.1543 | 0.1543 | 0.0000 | 1.0000 |
| `env_ahd` | audio_ax_env_ahd | `env/ahd m.axo` | env | 0.6923 | 0.6923 | 0.0000 | 1.0000 |
| `vcf3` | audio_ax_vcf3 | `filter/vcf3.axo` | filter | 0.2818 | 0.2818 | 0.0000 | 1.0000 |
| `onepole_lp` | audio_ax_onepole (lowpass) | `filter/lp1.axo` | filter | 0.1770 | 0.1770 | 0.0000 | 1.0000 |
| `onepole_hp` | audio_ax_onepole (highpass) | `filter/hp1.axo` | filter | 0.1928 | 0.1928 | 0.0000 | 1.0000 |
| `svf_lp` | audio_ax_svf (lowpass) | `filter/lp svf.axo` | filter | 0.4851 | 0.4851 | 0.0000 | 1.0000 |
| `biquad_lp` | audio_ax_biquad (lowpass) | `filter/lp.axo` | filter | 0.1129 | 0.1129 | 0.0000 | 1.0000 |
| `kfilter_lowpass` | audio_ax_kfilter_lowpass | `kfilter/lowpass.axo` | krate | 0.0053 | 0.0053 | 0.0000 | 1.0000 |
| `allpass` | audio_ax_allpass | `filter/allpass.axo` | comb | 0.2612 | 0.2612 | 0.4121 | 0.8729 |
| `fdbkcomb` | audio_ax_fdbkcomb | `filter/fdbkcomb.axo` | comb | 0.0791 | 0.0791 | 0.0002 | 1.0000 |
| `xfade` | audio_ax_xfade | `mix/xfade.axo` | krate | 0.2754 | 0.2754 | 0.0000 | 1.0000 |
| `dist_soft` | audio_ax_dist_soft | `dist/soft.axo` | krate | 0.8880 | 0.8880 | 0.0000 | 1.0000 |
| `dist_inf` | audio_ax_dist_inf | `dist/inf.axo` | sig | 0.4990 | 0.4990 | 0.0000 | 1.0000 |
| `mix4` | audio_ax_mix | `mix/mix 4.axo` | krate | 0.3871 | 0.3871 | 0.0000 | 1.0000 |
| `vca` | audio_ax_vca_stereo | `gain/vca.axo` | sig | 0.2121 | 0.2121 | 0.0000 | 1.0000 |
| `math_star` | audio_ax_math (multiply) | `math/STAR.axo` | krate | 0.2650 | 0.2650 | 0.0000 | 1.0000 |
| `math_plus` | audio_ax_math (add) | `math/PLUS.axo` | krate | 0.4061 | 0.4061 | 0.0000 | 1.0000 |
| `math_max` | audio_ax_math (maximum) | `math/max.axo` | krate | 0.2605 | 0.2605 | 0.0000 | 1.0000 |
| `math_abs` | audio_ax_math (absolute) | `math/abs.axo` | krate | 0.3534 | 0.3534 | 0.0000 | 1.0000 |
| `math_sat` | audio_ax_math (saturate) | `math/sat.axo` | krate | 0.6360 | 0.6360 | 0.0000 | 1.0000 |
| `smooth` | audio_ax_smooth | `math/smooth.axo` | krate | 0.6484 | 0.6484 | 0.0000 | 1.0000 |
| `window` | audio_ax_window | `math/window.axo` | krate | 0.6123 | 0.6124 | 0.0001 | 1.0000 |
| `latch` | audio_ax_latch | `logic/latch.axo` | krate | 0.3463 | 0.3463 | 0.0000 | 1.0000 |
| `counter` | audio_ax_counter | `logic/counter.axo` | int | 4.1988 | 4.1988 | 0.0000 | 1.0000 |
| `logic_and` | audio_ax_logic (and) | `logic/and 2.axo` | int | 0.5863 | 0.5863 | 0.0000 | 1.0000 |
| `convert_b2u` | audio_ax_convert (bipolar2unipolar) | `conv/bipolar2unipolar.axo` | krate | 0.5303 | 0.5303 | 0.0000 | 1.0000 |
| `mux2` | audio_ax_mux | `mux/mux 2.axo` | krate | 0.4000 | 0.4000 | 0.0000 | 1.0000 |
| `noise_uniform` | audio_ax_noise (uniform) | `noise/uniform.axo` | noise | 0.5798 | 0.5795 | 1.9872 | -0.0025 |
| `noise_pink` | audio_ax_noise (pink) | `noise/pink.axo` | noise | 0.2058 | 0.2076 | 1.1592 | 0.0240 |

## Method

**The reference side is not a transcription.** `harness/gen.mjs` lifts `<code.declaration>`,
`<code.init>`, `<code.krate>` and `<code.srate>` out of the `.axo` XML as opaque text and drops
them into the same scaffolding Axoloti's own Java generator builds
(`AxoObjectInstanceCodegenView.generateSRateCodePlusPlus`, including its
`name -> name[buffer_index]` rewrite of `frac32buffer` ports). No DSP is retyped.
`api/axoloti_filters.h` and `firmware/axoloti_oscs.c` compile UNMODIFIED from the clone.

**Our side is not the kernels, it is the shipped `AudioWorkletProcessor`s**, evaluated in bare
node behind a spec-shaped shim (`harness/js_side.mjs`). `tests/port_ax*_test.js` already compare
the kernel functions against a hand-written integer model, and that model is the thing this
harness exists to stop trusting. Driving the registered processor also puts the 3000 Hz tick
scheduling, the a-rate parameter sampling and the option plumbing under test.

**Only the platform is transcribed**, once, in `harness/axo_shim.h`: the ARM intrinsics, the six
lookup tables, the parameter functions. Every assumed equivalence is written out there, and
`axo_shim_selftest()` checks them at the top of every generated program — including the tuning
anchor `mtof48k_q31(0) == 329.6276 Hz`, which exercises `pitcht`, `__SSAT`, `___SMMUL` and
`___SMMLA` together and refuses to run if it drifts.

**The harness is proved able to fail.** `harness/selfcheck.mjs` breaks one side on purpose seven
ways — one semitone of detune, the C4-instead-of-E4 slip, saw substituted for square at the
correct pitch, a filter an octave low, a doubled envelope, an LFO running 8x slow, and a silent
node — and requires each to be caught. A control that stops firing is a build failure.

### Assumptions that could move a result

- `-fwrapv` and `-fno-strict-aliasing` are ON. The shipping firmware Makefile uses plain `-O2`.
  `osc/pwm`'s edge test subtracts `INT32_MIN` — undefined behaviour that gcc -O2 folded away,
  killing the falling edge and playing the reference AN OCTAVE DOWN. The ARM wraps; we say so.
  We compare against the machine semantics the author wrote for.
- `arm_sin_q31` completes a cycle in 2^31, NOT 2^32 (CMSIS v1.6: ten-bit index, 513-entry table).
  Shimming it as Axoloti's own `sin_q31` put `filter/lp` an octave below `filter/vcf3`.
- `sinet[]` is built from `sin()`; hardware fills it via CMSIS, so it differs by up to 1 LSB of
  an int16. `sine2t[]`, the table that matters, is exact.
- `rand_s32()` reads the STM32 hardware RNG and cannot be reproduced — on hardware either.

### Reproducing

```sh
bash harness/clone.sh                     # pinned read-only clones into /tmp
node harness/run.mjs --md=out/REPORT.md   # this report
node harness/selfcheck.mjs               # the negative controls; must stay green
```
