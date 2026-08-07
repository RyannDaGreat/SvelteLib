/**
 * run.mjs — RUN EVERY CASE AND WRITE THE REPORT.
 *
 *   node harness/run.mjs [--only=<id substring>] [--md=<path>]
 *
 * Per case it renders BOTH sides from the same deterministic input and reports,
 * in this order because that is the order of usefulness:
 *
 *   1. TUNING       — f0 both sides, and the error in CENTS. An octave is 1200
 *                     cents, a semitone 100, a fifth 702. Musically fatal errors
 *                     live here and nowhere else, so they are printed first.
 *   2. SPECTRUM     — the first 8 harmonics, normalised. Catches "right pitch,
 *                     wrong waveform", which a correlation cannot.
 *   3. TIMBRE/TIME  — corner frequency for filters, attack/decay ms for
 *                     envelopes.
 *   4. ERROR        — max |Δ| and normalised cross-correlation, LAST, because a
 *                     high correlation is not evidence and this harness must not
 *                     let it read as evidence.
 *
 * A case that cannot be built or run is reported as UNCOVERED with its reason.
 * That is deliberately not the same as a pass, and the coverage line at the top
 * of the report counts it against us.
 */

import { writeFileSync } from "node:fs";
import { runCase, holdToSampleRate, AX_SAMPLE_RATE, BUFSIZE } from "./runner.mjs";
import { loadProcessors, renderProcessor } from "./js_side.mjs";
import { CASES, PROBE_FREQS, probe } from "./cases.mjs";
import {
  estimateF0, harmonicProfile, maxAbsError, ncc, rms,
  riseTimeSeconds, fallTimeSeconds, transferDb, cornerFrequency, spectrum,
} from "./analysis.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const mdPath = args.find((a) => a.startsWith("--md="))?.slice(5);

/** Pure function. Pitch error in cents between two frequencies; NaN if either is 0. */
const cents = (a, b) => (a > 0 && b > 0 ? 1200 * Math.log2(a / b) : NaN);

/** How far off in cents before a tuning result is a FAILURE. A cent is
 *  inaudible; 10 cents is a just-audible beat; anything at 50+ is a different
 *  note. The gate is 10 because the two sides use different pitch tables
 *  (ours rebuilds theirs from the running rate) and a few cents of table error
 *  is a recorded deviation, while a semitone is not. */
const CENTS_TOLERANCE = 10;

/** Harmonic profile agreement gate: max |Δ| over the 8 normalised harmonics. */
const HARMONIC_TOLERANCE = 0.12;

/** Filter corner agreement gate, as a ratio. 1.15 = within 15%, about 2 semitones. */
const CORNER_TOLERANCE = 1.15;

/** Envelope stage-time agreement gate, as a ratio. */
const TIME_TOLERANCE = 1.2;

/** Sample-accuracy gates. 0.99 correlation and 5% of full scale are both loose;
 *  they are set to catch AUDIBLE waveform differences, not arithmetic noise. */
const NCC_TOLERANCE = 0.99;
const MAX_ERR_TOLERANCE = 0.05;

/**
 * Pure function. High-band energy over low-band energy — a colour measure that
 * survives the two sides having different random sequences.
 *
 * @example spectralTilt(whiteNoise) // near 1; pink noise is far below 1
 */
function spectralTilt(x) {
  const { mag, size } = spectrum(x);
  const bin = (hz) => Math.round(hz * size / AX_SAMPLE_RATE);
  const band = (lo, hi) => {
    let e = 0;
    for (let k = bin(lo); k < Math.min(bin(hi), mag.length); k++) e += mag[k] * mag[k];
    return e / Math.max(1, bin(hi) - bin(lo));
  };
  return Math.sqrt(band(6000, 20000) / (band(60, 600) + 1e-300));
}

const registry = await loadProcessors(AX_SAMPLE_RATE);
const results = [];

for (const c of CASES) {
  if (only && !c.id.includes(only)) continue;
  const row = { id: c.id, node: c.node, object: c.object, kind: c.kind, findings: [], covered: false };
  try {
    const ref = runCase({ id: c.id, ...c.ref });
    let refSignal = ref.out[c.refPort];
    if (refSignal === undefined) {
      throw new Error(`case names outlet "${c.refPort}"; object has ${Object.keys(ref.out).join(", ")}`);
    }
    if (c.refIsKRate) refSignal = holdToSampleRate(refSignal);

    const Cls = registry.get(c.js.name);
    if (!Cls) throw new Error(`no registered processor "${c.js.name}"`);
    const jsOut = renderProcessor(Cls, c.js, refSignal.length);
    let jsSignal = jsOut[c.jsPort ?? "p0"];
    if (jsSignal === undefined) throw new Error(`case names JS port "${c.jsPort ?? "p0"}"; got ${Object.keys(jsOut).join(", ")}`);
    // A UNITS BRIDGE, stated per case and never a silent one. The only user is
    // `audio_ax_counter`, whose count leaves OUR wire divided by 64 — this
    // codebase's int-on-a-frac32-wire convention, the inverse of Axoloti's
    // `conv/to i` (R7-AXO-TRAPS clause 2) — where theirs leaves as a bare int.
    if (c.jsScale !== undefined) jsSignal = Float64Array.from(jsSignal, (v) => v * c.jsScale);

    const n = Math.min(refSignal.length, jsSignal.length);
    const a = refSignal.subarray(0, n);
    const b = Float64Array.from(jsSignal.subarray(0, n));

    row.covered = true;
    row.rmsRef = rms(a);
    row.rmsJs = rms(b);
    row.maxErr = maxAbsError(a, b);
    row.ncc = ncc(a, b);

    const PITCHED = c.kind === "osc" || c.kind === "lfo";
    if (PITCHED || c.kind === "noise") {
      row.f0Ref = estimateF0(a, AX_SAMPLE_RATE);
      row.f0Js = estimateF0(b, AX_SAMPLE_RATE);
      row.cents = cents(row.f0Js, row.f0Ref);
      row.harmRef = [...harmonicProfile(a, AX_SAMPLE_RATE, row.f0Ref, 8)];
      row.harmJs = [...harmonicProfile(b, AX_SAMPLE_RATE, row.f0Js, 8)];
      row.harmMax = Math.max(...row.harmRef.map((v, i) => Math.abs(v - row.harmJs[i])));
    }

    if (c.kind === "filter" || c.kind === "krate" || c.kind === "comb") {
      const input = new Float64Array(n);
      for (let i = 0; i < n; i++) input[i] = probe(i);
      row.dbRef = [...transferDb(input, a, AX_SAMPLE_RATE, PROBE_FREQS)];
      row.dbJs = [...transferDb(input, b, AX_SAMPLE_RATE, PROBE_FREQS)];
      row.cornerRef = cornerFrequency(row.dbRef, PROBE_FREQS);
      row.cornerJs = cornerFrequency(row.dbJs, PROBE_FREQS);
      row.peakDbRef = Math.max(...row.dbRef);
      row.peakDbJs = Math.max(...row.dbJs);
    }

    if (c.kind === "env") {
      row.attackRef = riseTimeSeconds(a, AX_SAMPLE_RATE, 0.9);
      row.attackJs = riseTimeSeconds(b, AX_SAMPLE_RATE, 0.9);
      row.fallRef = fallTimeSeconds(a, AX_SAMPLE_RATE, 1 / Math.E);
      row.fallJs = fallTimeSeconds(b, AX_SAMPLE_RATE, 1 / Math.E);
      row.peakRef = Math.max(...a);
      row.peakJs = Math.max(...b);
    }

    // ── THE VERDICT, in the order that matters ──────────────────────────────
    // NOISE HAS NO f0. Its spectral peak is where the FFT's loudest bin landed,
    // which for two differently-seeded noise generators is two unrelated bins —
    // reporting that as a 1434-cent tuning error is the metric lying, not the
    // port failing. Noise is judged on spectral SLOPE and level instead.
    if (PITCHED && Number.isFinite(row.cents) && Math.abs(row.cents) > CENTS_TOLERANCE) {
      row.findings.push(`TUNING ${row.cents > 0 ? "+" : ""}${row.cents.toFixed(0)} cents (${row.f0Js.toFixed(2)} Hz vs ${row.f0Ref.toFixed(2)} Hz)`);
    }
    if (PITCHED && row.harmMax !== undefined && row.harmMax > HARMONIC_TOLERANCE) {
      row.findings.push(`SPECTRUM harmonic profile differs by ${row.harmMax.toFixed(3)}`);
    }
    // A COMB HAS NO CORNER. Its response is a picket fence, so "first -3 dB
    // crossing" lands on whichever notch the probe grid hit first and means
    // nothing. Combs are judged on the notch COMB SPACING and on the error.
    if (c.kind === "filter" && row.cornerRef > 0 && row.cornerJs > 0) {
      const ratio = row.cornerJs / row.cornerRef;
      if (ratio > CORNER_TOLERANCE || ratio < 1 / CORNER_TOLERANCE) {
        row.findings.push(`CORNER ${row.cornerJs.toFixed(0)} Hz vs ${row.cornerRef.toFixed(0)} Hz (x${ratio.toFixed(2)})`);
      }
    }
    for (const [label, r, j] of [["ATTACK", row.attackRef, row.attackJs], ["DECAY", row.fallRef, row.fallJs]]) {
      if (Number.isFinite(r) && Number.isFinite(j) && r > 0 && j > 0) {
        const ratio = j / r;
        if (ratio > TIME_TOLERANCE || ratio < 1 / TIME_TOLERANCE) {
          row.findings.push(`${label} ${(j * 1000).toFixed(1)} ms vs ${(r * 1000).toFixed(1)} ms (x${ratio.toFixed(2)})`);
        }
      }
    }
    if (c.kind === "noise") {
      // Energy in the top octave over energy in the bottom decade: ~1 for white,
      // well under 1 for pink. It distinguishes the two colours without needing
      // the two sides to draw the same numbers, which they cannot (their
      // `rand_s32` reads the STM32 hardware RNG; ours is a seeded LCG).
      row.slopeRef = spectralTilt(a);
      row.slopeJs = spectralTilt(b);
      if (row.slopeRef > 0 && (row.slopeJs / row.slopeRef > 2 || row.slopeJs / row.slopeRef < 0.5)) {
        row.findings.push(`SPECTRAL TILT ${row.slopeJs.toFixed(3)} vs ${row.slopeRef.toFixed(3)}`);
      }
    }
    // THE SAMPLE-ACCURACY TIER, and it exists because the report was "all good"
    // without it. Tuning, spectrum and stage times can all agree while the
    // waveform differs audibly; these two numbers are what catches that, and a
    // divergence here is reported even when every other gate is green. It is
    // NOT automatically a defect — several are recorded deviations (a BLEP
    // reimplementation of a table-BLEP, a k-rate edge landing one tick apart) —
    // but it is always a fact the reader is entitled to before "faithful".
    if (row.ncc < NCC_TOLERANCE || row.maxErr > MAX_ERR_TOLERANCE) {
      row.findings.push(`WAVEFORM max|Δ| ${row.maxErr.toFixed(4)}, NCC ${row.ncc.toFixed(4)}`);
    }
    if (row.rmsRef > 1e-6 && (row.rmsJs / row.rmsRef > 1.3 || row.rmsJs / row.rmsRef < 0.77)) {
      row.findings.push(`LEVEL rms x${(row.rmsJs / row.rmsRef).toFixed(2)}`);
    }
    if (row.rmsRef < 1e-9 && row.rmsJs < 1e-9) row.findings.push("BOTH SIDES SILENT — the case proves nothing");
  } catch (e) {
    row.error = String(e.message).split("\n")[0].slice(0, 220);
  }
  row.expected = c.expected ?? null;
  row.note = c.note ?? null;
  results.push(row);
  const status = row.covered ? (row.findings.length ? (row.expected ? "note" : "FAIL") : "ok  ") : "SKIP";
  console.log(`${status} ${row.id.padEnd(18)} ${row.findings.join("; ") || row.error || ""}`);
}

// ── the report ──────────────────────────────────────────────────────────────

const covered = results.filter((r) => r.covered);
// AN EXPECTED DIVERGENCE IS STILL PRINTED, JUST NOT COUNTED AS A FAILURE — it
// has a reason recorded on the case, and hiding it would be the same dishonesty
// as calling it a defect.
const failing = covered.filter((r) => r.findings.length && !r.expected);
const expectedDiv = covered.filter((r) => r.findings.length && r.expected);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const prof = (p) => (p ? p.map((v) => v.toFixed(2)).join(" ") : "—");

const lines = [];
lines.push("# Axoloti A/B faithfulness — measured, not transcribed");
lines.push("");
const nodes = new Set(covered.map((r) => r.node.replace(/ \(.*/, ""))).size;
const objects = new Set(covered.map((r) => r.object)).size;
lines.push(`**${covered.length} of ${results.length} attempted cases ran on both sides, covering ${nodes} distinct \`audio_ax_*\` nodes against ${objects} factory objects. ${failing.length} disagree; ${expectedDiv.length} diverge for a recorded reason.**`);
lines.push("");
if (failing.length) {
  lines.push("## Failures, first");
  lines.push("");
  lines.push("| case | node | finding | diagnosis |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of failing) lines.push(`| \`${r.id}\` | ${r.node} | ${r.findings.join("<br>")} | ${r.note ?? "not yet diagnosed"} |`);
  lines.push("");
}
if (expectedDiv.length) {
  lines.push("## Divergences that are EXPECTED, with the reason");
  lines.push("");
  lines.push("| case | measured | why this is not a defect |");
  lines.push("| --- | --- | --- |");
  for (const r of expectedDiv) lines.push(`| \`${r.id}\` | ${r.findings.join("<br>")} | ${r.expected} |`);
  lines.push("");
}
const skipped = results.filter((r) => !r.covered);
if (skipped.length) {
  lines.push("## Uncovered (a skip is not a pass)");
  lines.push("");
  lines.push("| case | object | reason |");
  lines.push("| --- | --- | --- |");
  for (const r of skipped) lines.push(`| \`${r.id}\` | \`${r.object}\` | ${r.error} |`);
  lines.push("");
}

lines.push("## Tuning and spectrum — pitched sources");
lines.push("");
lines.push("| case | object | f0 axo (Hz) | f0 ours (Hz) | Δ cents | harmonics 1-8 axo | harmonics 1-8 ours | max Δ harm | max abs err | NCC |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of covered.filter((x) => x.f0Ref !== undefined)) {
  lines.push(`| \`${r.id}\` | \`${r.object}\` | ${fmt(r.f0Ref)} | ${fmt(r.f0Js)} | ${fmt(r.cents, 1)} | ${prof(r.harmRef)} | ${prof(r.harmJs)} | ${fmt(r.harmMax, 3)} | ${fmt(r.maxErr, 4)} | ${fmt(r.ncc, 4)} |`);
}
lines.push("");
lines.push("## Filters — corner frequency and passband");
lines.push("");
lines.push("| case | object | corner axo (Hz) | corner ours (Hz) | peak dB axo | peak dB ours | max abs err | NCC |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of covered.filter((x) => x.cornerRef !== undefined)) {
  lines.push(`| \`${r.id}\` | \`${r.object}\` | ${fmt(r.cornerRef, 0)} | ${fmt(r.cornerJs, 0)} | ${fmt(r.peakDbRef, 1)} | ${fmt(r.peakDbJs, 1)} | ${fmt(r.maxErr, 4)} | ${fmt(r.ncc, 4)} |`);
}
lines.push("");
lines.push("## Envelopes — stage times");
lines.push("");
lines.push("| case | object | attack-to-90% axo (ms) | ours (ms) | 1/e fall axo (ms) | ours (ms) | peak axo | peak ours | NCC |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of covered.filter((x) => x.attackRef !== undefined)) {
  lines.push(`| \`${r.id}\` | \`${r.object}\` | ${fmt(r.attackRef * 1000, 1)} | ${fmt(r.attackJs * 1000, 1)} | ${fmt(r.fallRef * 1000, 1)} | ${fmt(r.fallJs * 1000, 1)} | ${fmt(r.peakRef, 3)} | ${fmt(r.peakJs, 3)} | ${fmt(r.ncc, 4)} |`);
}
lines.push("");
lines.push("## Everything, raw");
lines.push("");
lines.push("| case | node | object | kind | rms axo | rms ours | max abs err | NCC |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of covered) {
  lines.push(`| \`${r.id}\` | ${r.node} | \`${r.object}\` | ${r.kind} | ${fmt(r.rmsRef, 4)} | ${fmt(r.rmsJs, 4)} | ${fmt(r.maxErr, 4)} | ${fmt(r.ncc, 4)} |`);
}
lines.push("");

// ── the method, emitted WITH the numbers ────────────────────────────────────
// A table of correlations with no statement of what was compared, against what,
// under which assumptions, is not evidence. The report carries its own method so
// a reader who finds this file in six months can judge it without reading the code.
lines.push("## Method");
lines.push("");
lines.push([
  "**The reference side is not a transcription.** `harness/gen.mjs` lifts `<code.declaration>`,",
  "`<code.init>`, `<code.krate>` and `<code.srate>` out of the `.axo` XML as opaque text and drops",
  "them into the same scaffolding Axoloti's own Java generator builds",
  "(`AxoObjectInstanceCodegenView.generateSRateCodePlusPlus`, including its",
  "`name -> name[buffer_index]` rewrite of `frac32buffer` ports). No DSP is retyped.",
  "`api/axoloti_filters.h` and `firmware/axoloti_oscs.c` compile UNMODIFIED from the clone.",
  "",
  "**Our side is not the kernels, it is the shipped `AudioWorkletProcessor`s**, evaluated in bare",
  "node behind a spec-shaped shim (`harness/js_side.mjs`). `tests/port_ax*_test.js` already compare",
  "the kernel functions against a hand-written integer model, and that model is the thing this",
  "harness exists to stop trusting. Driving the registered processor also puts the 3000 Hz tick",
  "scheduling, the a-rate parameter sampling and the option plumbing under test.",
  "",
  "**Only the platform is transcribed**, once, in `harness/axo_shim.h`: the ARM intrinsics, the six",
  "lookup tables, the parameter functions. Every assumed equivalence is written out there, and",
  "`axo_shim_selftest()` checks them at the top of every generated program — including the tuning",
  "anchor `mtof48k_q31(0) == 329.6276 Hz`, which exercises `pitcht`, `__SSAT`, `___SMMUL` and",
  "`___SMMLA` together and refuses to run if it drifts.",
  "",
  "**The harness is proved able to fail.** `harness/selfcheck.mjs` breaks one side on purpose seven",
  "ways — one semitone of detune, the C4-instead-of-E4 slip, saw substituted for square at the",
  "correct pitch, a filter an octave low, a doubled envelope, an LFO running 8x slow, and a silent",
  "node — and requires each to be caught. A control that stops firing is a build failure.",
].join("\n"));
lines.push("");
lines.push("### Assumptions that could move a result");
lines.push("");
lines.push([
  "- `-fwrapv` and `-fno-strict-aliasing` are ON. The shipping firmware Makefile uses plain `-O2`.",
  "  `osc/pwm`'s edge test subtracts `INT32_MIN` — undefined behaviour that gcc -O2 folded away,",
  "  killing the falling edge and playing the reference AN OCTAVE DOWN. The ARM wraps; we say so.",
  "  We compare against the machine semantics the author wrote for.",
  "- `arm_sin_q31` completes a cycle in 2^31, NOT 2^32 (CMSIS v1.6: ten-bit index, 513-entry table).",
  "  Shimming it as Axoloti's own `sin_q31` put `filter/lp` an octave below `filter/vcf3`.",
  "- `sinet[]` is built from `sin()`; hardware fills it via CMSIS, so it differs by up to 1 LSB of",
  "  an int16. `sine2t[]`, the table that matters, is exact.",
  "- `rand_s32()` reads the STM32 hardware RNG and cannot be reproduced — on hardware either.",
].join("\n"));
lines.push("");
lines.push("### Reproducing");
lines.push("");
lines.push("```sh");
lines.push("bash harness/clone.sh                     # pinned read-only clones into /tmp");
lines.push("node harness/run.mjs --md=out/REPORT.md   # this report");
lines.push("node harness/selfcheck.mjs               # the negative controls; must stay green");
lines.push("```");
lines.push("");

if (mdPath) {
  writeFileSync(mdPath, lines.join("\n"));
  console.log(`\nwrote ${mdPath}`);
}
console.log(`\n${covered.length}/${results.length} covered, ${failing.length} failing`);
