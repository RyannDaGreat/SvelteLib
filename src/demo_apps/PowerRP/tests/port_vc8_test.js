/**
 * VC-8 — THE PORT PROOF. Bare node.
 * Run: node src/demo_apps/PowerRP/tests/port_vc8_test.js
 *
 * ── WHAT THIS FILE CAN AND CANNOT PROVE, AND THE DIFFERENCE MATTERS ─────────
 * `tests/port_ax2_test.js` and `tests/port_vc3b_test.js` carry a MODEL OF THE
 * ORIGINAL — Axoloti's `___SMMUL` in BigInt, Bogaudio's recurrences transcribed
 * line by line — and diff the kernels against it. **THAT IS IMPOSSIBLE HERE.**
 * NYSTHI ships no source at any ref (verified @ f895816: zero `.cpp`, zero
 * `.hpp`, master and all six tags), so there is nothing to transcribe and no
 * number to diff against. Pretending otherwise would be the worst thing this
 * suite could do: a green test that measures our own algebra against itself,
 * while claiming to measure fidelity.
 *
 * So the suite is split, and each half says which it is.
 *
 * **HALF ONE — FULLY CHECKABLE, AND THEREFORE EXHAUSTIVE.** The spec ↔ roster ↔
 * plugin sweep. Every declared knob is a real AudioParam, every declared port is
 * a real port, every restated constant matches the one it was restated from,
 * every spec has a plugin and every plugin has a spec. None of that depends on
 * having the source, so none of it is allowed to be partial.
 *
 * **HALF TWO — MEASUREMENTS AGAINST THE DOCUMENT.** Where a document states a
 * NUMBER or a LAW, that statement is turned into an assertion and the assertion
 * cites the document in a comment. The vactrol's 12 ms and 250 ms are the DAFx-13
 * paper's; Eq. 39's resistance fit is the paper's; the envelope's 0-10 V and its
 * 1 ms pulse are the changelog's; the panner's "LINEAR … becomes EQUAL POWER" is
 * the changelog's; SQUONK's A/B/C 0-2 V against D/E ±1 V is the changelog's.
 * These prove the implementation matches what was WRITTEN DOWN. They do not prove
 * it matches the binary, and nothing in this repository can.
 *
 * **HALF THREE — THE HONESTY GATE.** Every spec must carry a `derivation` record
 * marked `behaviour`, citing a document and a date, and stating separately what
 * fixed its PORT LAYOUT. A future node cannot quietly claim source fidelity in
 * this block, because there is no source to have.
 */

import assert from "node:assert/strict";

import {
  AttackDecayKernel, B208DualLpgKernel, B208EnvelopeKernel, CDELAY_CEILING_SECONDS,
  ClockableDelayKernel, LPG_MODES, LpgVoice, MIX4_CHANNELS, Mix4Kernel, NYSTHI_GATE_VOLTS,
  NYSTHI_PULSE_SECONDS, NysthiTrigger, PROGRAMMER_CHANNELS, PROGRAMMER_STAGES, ProgrammerKernel,
  PolyLpgKernel, QUAD_CORNERS, QuadPannerKernel, RACK_VOLTS_PER_UNIT, SQUONK_CHANNELS,
  SQUONK_MAX_REPEATS, SQUONK_STAGES, SURVEILLANCE_OUTPUTS, SoyModelSouKernel, SquonkKernel,
  SurveillanceKernel, TRIGGER_HIGH_VOLTS, envShape, lpgResistance, mix4PanGains, nysthiLcg,
  quadCornerGain, souSkew, souTwoDice,
} from "../synth/vc8_kernels.js";
import { VC8_PROCESSORS, indexKeys, numberedKeys, underscoredKeys, vc8OptionSetter } from "../synth/worklets/processors_vc8.js";
import { BLOCK_SPECS } from "../core/audio_specs_vc8.js";
import { BLOCK_MODULE_FACTORIES, BLOCK_WORKLET_MODULES, vc8ConstructOptions } from "../synth/modules_vc8.js";
import { BLOCK_PLUGINS } from "../plugins/audio_index_vc8.js";

const SAMPLE_RATE = 48000;

/** CHANGELOG.md:3762's hard limiter, restated so the assertion that checks it
 *  cites a number rather than a bare 20. */
const CDELAY_LIMIT_TEST_VOLTS = 20;

/** The delay time the HOLD measurement uses, in seconds, and the sample its test
 *  impulse lands on. Named because the assertion's expected echo count is derived
 *  from them and a bare 0.05 would make that count look arbitrary. */
const DELAY_WINDOW_SECONDS = 0.05;
const IMPULSE_AT = 100;

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

/** Report a measured value beside the bound it must satisfy, so no comparison can
 *  pass silently without its number reaching the log — port_ax2_test's rule, and
 *  it matters more here, where the number is the only evidence there is. */
const within = (label, measured, expected, tolerance) => {
  console.log(`  ${label.padEnd(56)} ${measured.toPrecision(6)} vs ${expected.toPrecision(6)} (±${tolerance})`);
  assert.ok(Math.abs(measured - expected) <= tolerance, `${label}: ${measured} is not within ${tolerance} of ${expected}`);
};

/**
 * Run one kernel for a while and hand every frame to a visitor.
 *
 * Command (it advances the kernel). One helper because eleven measurements below
 * all need the same loop and a copy per measurement is ten places for the frame
 * width to go stale.
 *
 * @param {object} kernel - anything with `sample(knobs, signals, wired, frame)`
 * @param {number} outputs - the frame width
 * @param {number} frames - how many samples
 * @param {function(number, object, object): void} drive - fills signals per sample
 * @param {object} knobs
 * @param {object} wired
 * @param {function(number, Float64Array): void} visit
 */
function run(kernel, outputs, frames, drive, knobs, wired, visit) {
  const frame = new Float64Array(outputs);
  const signals = {};
  for (let n = 0; n < frames; n++) {
    drive(n, signals, wired);
    kernel.sample(knobs, signals, wired, frame);
    visit(n, frame);
  }
}

/** Pure-ish helper: a knob bag with every roster param at its declared default,
 *  so a measurement changes only what it means to change. */
function defaultKnobs(module) {
  const row = VC8_PROCESSORS.find((r) => r.module === module);
  assert.ok(row, `no roster row for ${module}`);
  const knobs = {};
  for (const p of row.params) knobs[p.name] = p.defaultValue;
  return knobs;
}

/** Pure-ish helper: a `wired` map with every audio input of a module unwired. */
function noCables(module) {
  const row = VC8_PROCESSORS.find((r) => r.module === module);
  const wired = {};
  for (const name of row.audioInputs) wired[name] = false;
  return wired;
}

console.log("\n── HALF ONE: THE SPEC ↔ ROSTER ↔ PLUGIN SWEEP (fully checkable) ──");

check("every spec has a roster row and every roster row has a spec", () => {
  const specModules = BLOCK_SPECS.map((s) => s.module).sort();
  const rosterModules = VC8_PROCESSORS.map((r) => r.module).sort();
  assert.deepEqual(specModules, rosterModules);
  assert.equal(BLOCK_SPECS.length, 11, "eleven shipped nodes — Simpliciter and complexSimpler are deliberately absent");
});

check("every spec's PORTS are exactly its roster row's, in order", () => {
  for (const spec of BLOCK_SPECS) {
    const row = VC8_PROCESSORS.find((r) => r.module === spec.module);
    assert.deepEqual(spec.inputs.map((p) => p.key), row.audioInputs, `${spec.type} inputs`);
    assert.deepEqual(spec.outputs.map((p) => p.key), row.outputs, `${spec.type} outputs`);
  }
});

check("every spec's KNOBS are exactly its roster row's params, options and construct knobs", () => {
  for (const spec of BLOCK_SPECS) {
    const row = VC8_PROCESSORS.find((r) => r.module === spec.module);
    const declared = spec.knobs.map((k) => k.key).sort();
    const engine = [...row.params.map((p) => p.name), ...row.options, ...row.construct].sort();
    assert.deepEqual(declared, engine, `${spec.type} knobs`);
  }
});

check("every DISCRETE knob's options reach a kernel setter, and its default is one of them", () => {
  for (const spec of BLOCK_SPECS) {
    const row = VC8_PROCESSORS.find((r) => r.module === spec.module);
    const kernel = row.make(SAMPLE_RATE, {});
    for (const knob of spec.knobs.filter((k) => k.discrete)) {
      assert.ok(knob.options.includes(knob.default), `${spec.type}.${knob.key} defaults outside its options`);
      const setter = vc8OptionSetter(knob.key);
      assert.equal(typeof kernel[setter], "function", `${spec.type}.${knob.key} has no ${setter}`);
      // Every option must be ACCEPTED, and anything else must be REFUSED LOUDLY —
      // a setter that silently ignored a bad value is the silent-fallback failure.
      for (const option of knob.options) kernel[setter](option);
      assert.throws(() => kernel[setter]("__not_an_option__"), `${spec.type}.${setter} accepted nonsense`);
    }
  }
});

check("every NUMERIC knob's default sits inside its own range AND its AudioParam's", () => {
  for (const spec of BLOCK_SPECS) {
    const row = VC8_PROCESSORS.find((r) => r.module === spec.module);
    const params = new Map(row.params.map((p) => [p.name, p]));
    for (const knob of spec.knobs.filter((k) => !k.discrete)) {
      assert.ok(knob.default >= knob.min && knob.default <= knob.max,
        `${spec.type}.${knob.key} default ${knob.default} is outside ${knob.min}…${knob.max}`);
      const param = params.get(knob.key);
      if (!param) continue; // a construct knob has no AudioParam, by design
      assert.equal(param.defaultValue, knob.default, `${spec.type}.${knob.key} default disagrees with the engine's`);
      assert.equal(param.minValue, knob.min, `${spec.type}.${knob.key} min disagrees with the engine's`);
      assert.equal(param.maxValue, knob.max, `${spec.type}.${knob.key} max disagrees with the engine's`);
    }
  }
});

check("every spec carries its chrome, and its readout names one of its own knobs", () => {
  const types = new Set();
  for (const spec of BLOCK_SPECS) {
    assert.ok(!types.has(spec.type), `duplicate type ${spec.type}`);
    types.add(spec.type);
    assert.ok(spec.type.startsWith("audio_vcv_"), `${spec.type} must carry the VCV prefix`);
    assert.ok(spec.module && spec.title && spec.family && spec.icon, `${spec.type} is missing chrome`);
    assert.ok(spec.help.length > 40, `${spec.type} needs a help sentence worth reading`);
    assert.ok(spec.outputs.length >= 1, `${spec.type} produces nothing`);
    assert.ok(spec.knobs.some((k) => k.key === spec.readout), `${spec.type}'s readout names no knob`);
    for (const knob of spec.knobs) assert.ok(knob.help, `${spec.type}.${knob.key} has no help`);
    for (const port of [...spec.inputs, ...spec.outputs]) {
      assert.ok(port.label, `${spec.type}.${port.key} has no label`);
      assert.ok(["audio", "number", "trigger"].includes(port.type), `${spec.type}.${port.key} has type ${port.type}`);
    }
  }
});

check("BLOCK_PLUGINS covers BLOCK_SPECS exactly", () => {
  assert.deepEqual(BLOCK_PLUGINS.map((p) => p.type).sort(), BLOCK_SPECS.map((s) => s.type).sort());
});

check("BLOCK_MODULE_FACTORIES and BLOCK_WORKLET_MODULES cover the roster exactly", () => {
  assert.deepEqual(Object.keys(BLOCK_MODULE_FACTORIES).sort(), VC8_PROCESSORS.map((r) => r.module).sort());
  assert.ok(Array.isArray(BLOCK_WORKLET_MODULES), "the PORT-BLOCK CONTRACT says ARRAY, not Set (AX-3 shipped a Set and it was swept back)");
  assert.deepEqual([...BLOCK_WORKLET_MODULES].sort(), Object.keys(BLOCK_MODULE_FACTORIES).sort());
});

check("registerProcessor names are unique and carry the block prefix", () => {
  const names = VC8_PROCESSORS.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, "the AudioWorklet global scope is SHARED — a duplicate name would collide across blocks");
  for (const name of names) assert.ok(name.startsWith("vc8-"), `${name} must carry the vc8- prefix`);
});

check("every port is exactly one scale kind, and a gate port is never also a unit port", () => {
  for (const row of VC8_PROCESSORS) {
    const overlap = row.gatePorts.filter((p) => row.unitPorts.includes(p));
    assert.deepEqual(overlap, [], `${row.module} declares ${overlap} as both a gate and a unit port`);
    // A declared scale must name a port that exists, or it is silently doing
    // nothing — which is exactly how a units bug hides.
    const known = new Set([...row.audioInputs, ...row.outputs]);
    for (const port of [...row.gatePorts, ...row.unitPorts]) {
      assert.ok(known.has(port), `${row.module} scales ${port}, which is not one of its ports`);
    }
  }
});

check("NO ROSTER ROW DECLARES A PITCH PORT — R7-UNITS clause 3 has no site in this block", () => {
  // Not a tautology: it PINS the header's claim. VC-3b's roster has a
  // `pitchPorts` column because Bogaudio has V/oct jacks; VC-8 has none, and the
  // day one lands here this assertion must be replaced by a real column rather
  // than the port silently taking the ×5 level scale and coming out 60× wrong.
  for (const row of VC8_PROCESSORS) {
    assert.equal(row.pitchPorts, undefined, `${row.module} declares pitchPorts — the block's scale table has no such kind yet`);
  }
});

check("the restated helper output matches what the specs and roster actually use", () => {
  assert.deepEqual(underscoredKeys("in", 4), ["in_1", "in_2", "in_3", "in_4"]);
  assert.deepEqual(numberedKeys("in", 2), ["in1", "in2"]);
  assert.deepEqual(indexKeys("o", 3), ["o0", "o1", "o2"]);
  // The two spellings really are both live contracts — the point of having two
  // helpers rather than a boolean flag.
  const lpg = VC8_PROCESSORS.find((r) => r.module === "vcvB208DualLpg");
  const mix = VC8_PROCESSORS.find((r) => r.module === "vcvNysthiMix4");
  assert.ok(lpg.audioInputs.includes("in_1") && mix.audioInputs.includes("in1"));
});

check("the specs' restated constants match the kernels' own", () => {
  const lpgModes = BLOCK_SPECS.find((s) => s.type === "audio_vcv_polylpg").knobs.find((k) => k.key === "mode").options;
  assert.deepEqual(lpgModes, LPG_MODES, "the spec restates LPG_MODES because core may not import synth/**");
  const squonk = BLOCK_SPECS.find((s) => s.type === "audio_vcv_squonk");
  assert.deepEqual(SQUONK_CHANNELS.map((c) => c), squonk.outputs.slice(0, SQUONK_CHANNELS.length).map((p) => p.key));
  assert.equal(squonk.knobs.filter((k) => k.key.startsWith("rep")).length, SQUONK_STAGES);
  assert.equal(squonk.knobs.find((k) => k.key === "rep1").max, SQUONK_MAX_REPEATS);
  const programmer = BLOCK_SPECS.find((s) => s.type === "audio_vcv_programmer");
  assert.equal(programmer.knobs.filter((k) => k.key.startsWith("active")).length, PROGRAMMER_STAGES);
  // EXACT keys, not a prefix test: `active1` also starts with "a", and matching
  // by prefix counted it — the assertion read 80 where 64 was meant.
  const channelKeys = new Set(PROGRAMMER_CHANNELS.flatMap((c) => Array.from({ length: PROGRAMMER_STAGES }, (_, n) => `${c}${n + 1}`)));
  assert.equal(programmer.knobs.filter((k) => channelKeys.has(k.key)).length, PROGRAMMER_STAGES * PROGRAMMER_CHANNELS.length);
  const surveillance = BLOCK_SPECS.find((s) => s.type === "audio_vcv_surveillance");
  assert.equal(surveillance.outputs.length, SURVEILLANCE_OUTPUTS);
  const delay = BLOCK_SPECS.find((s) => s.type === "audio_vcv_clockabledelay");
  assert.equal(delay.knobs.find((k) => k.key === "max_seconds").max, CDELAY_CEILING_SECONDS);
  const mix = BLOCK_SPECS.find((s) => s.type === "audio_vcv_nysthi_mix4");
  assert.equal(mix.knobs.filter((k) => k.key.startsWith("level")).length, MIX4_CHANNELS);
  const panner = BLOCK_SPECS.find((s) => s.type === "audio_vcv_quadpanner");
  assert.deepEqual(panner.outputs.slice(0, 4).map((p) => p.key), QUAD_CORNERS.map((c) => `out_${c}`));
});

check("a construct knob is marked construct and reaches processorOptions; a live one does not", () => {
  for (const spec of BLOCK_SPECS) {
    const row = VC8_PROCESSORS.find((r) => r.module === spec.module);
    for (const name of row.construct) {
      const knob = spec.knobs.find((k) => k.key === name);
      assert.ok(knob?.construct, `${spec.type}.${name} sizes or seeds the kernel and must be construct: true`);
    }
    for (const knob of spec.knobs.filter((k) => k.construct)) {
      assert.ok(row.construct.includes(knob.key), `${spec.type}.${knob.key} is construct but never reaches processorOptions`);
    }
  }
  assert.deepEqual(vc8ConstructOptions(["seed"], { seed: 7, rot: 2 }), { seed: 7 });
  assert.deepEqual(vc8ConstructOptions(["seed"], {}), {});
});

console.log("\n── HALF THREE: THE HONESTY GATE ──");

check("EVERY spec carries a behaviour-derived marker, a cited document and a date", () => {
  for (const spec of BLOCK_SPECS) {
    const d = spec.derivation;
    assert.ok(d, `${spec.type} has no derivation record — this block has NO SOURCE and a node may not imply otherwise`);
    assert.equal(d.kind, "behaviour", `${spec.type} claims kind ${JSON.stringify(d.kind)}; NYSTHI ships no source at any ref`);
    assert.ok(d.document && d.document.length > 30, `${spec.type}'s derivation cites no document`);
    assert.match(d.read, /^\d{4}-\d{2}-\d{2}$/, `${spec.type}'s derivation has no read date`);
    // THE LAYOUT IS A SEPARATE CLAIM FROM THE BEHAVIOUR and must be stated
    // separately: the changelog gives control NAMES and never jack ORDER, so a
    // node can be solid about one and guessing about the other.
    assert.ok(d.layout && d.layout.length > 20, `${spec.type} does not say what fixed its PORT LAYOUT`);
  }
});

check("every spec's help WARNS on its own card that it is an approximation", () => {
  // The derivation record is machine-readable; this is the half a human sees. An
  // author must not have to open a docblock to learn the node is not a port.
  for (const spec of BLOCK_SPECS) {
    assert.match(spec.help, /NOT PORTED/,
      `${spec.type}'s help must say in plain words that it is documentation-derived`);
  }
});

console.log("\n── HALF TWO: MEASUREMENTS AGAINST THE DOCUMENTS ──");

check("Eq. 39 — the vactrol's current-to-resistance fit, at the paper's own bounds", () => {
  // Parker & D'Angelo, DAFx-13, Eq. 39: Rf = A/If^1.4 + B, A = 3.464 Ω·A^1.4,
  // B = 1136.212 Ω. §3.1 gives If,max = 40 mA.
  within("Rf at If_max = 40 mA (fully open)", lpgResistance(0.04), 3.464 / 0.04 ** 1.4 + 1136.212, 1e-9);
  // …and the exponent really is 1.4: ten times less current multiplies the A term
  // by exactly 10^1.4. Written as a ratio of the A terms so the additive B floor
  // does not blur the check.
  const a1 = lpgResistance(0.04) - 1136.212;
  const a2 = lpgResistance(0.004) - 1136.212;
  within("the A term's decade ratio is 10^1.4", a2 / a1, 10 ** 1.4, 1e-6);
});

check("§3.2 — the vactrol tracks UP in ~12 ms and DOWN in ~250 ms", () => {
  // The paper: "approx 12ms in the positive-going direction and 250ms in the
  // negative-going direction". Measured as the time to cross 1 − 1/e of the way,
  // which is what a time constant IS. The measured rise is FASTER than 12 ms on
  // purpose — §3.2's own "modulated further by the current output value … so that
  // it responds quicker when at high values" — so the assertion is that the rise
  // is inside the speedup's band, and that the FALL/RISE ratio is the datasheet's
  // twenty-fold asymmetry, which is the number that makes an LPG sound plucked.
  const settle = (from, to) => {
    const voice = new LpgVoice(SAMPLE_RATE);
    let n = 0;
    // Park at `from` first, so the measurement starts from a settled state.
    for (; n < SAMPLE_RATE * 2; n++) voice.advanceVactrol(from, 1);
    const start = voice.current;
    const settled = to > from ? 0.04 : 0;
    const threshold = start + (settled - start) * (1 - 1 / Math.E);
    for (n = 1; n < SAMPLE_RATE * 5; n++) {
      voice.advanceVactrol(to, 1);
      if (to > from ? voice.current >= threshold : voice.current <= threshold) break;
    }
    return n / SAMPLE_RATE;
  };
  const rise = settle(0, NYSTHI_GATE_VOLTS);
  const fall = settle(NYSTHI_GATE_VOLTS, 0);
  console.log(`  ${"vactrol rise / fall (s)".padEnd(56)} ${rise.toPrecision(4)} / ${fall.toPrecision(4)}`);
  // THE BANDS ARE WIDE ON PURPOSE AND THE NUMBERS ARE PRINTED. The paper says
  // "approx 12ms" and "approx 250ms" for a FIXED time constant, and then adds the
  // speedup term — so a settle measured on the combined model brackets those
  // values rather than hitting them: the rise starts at exactly 12 ms and gets
  // faster as it brightens (measured ~12.4 ms to 1 − 1/e), the fall starts four
  // times faster than 250 ms and slows as it dims (measured ~179 ms). Asserting
  // equality would be asserting that the speedup does nothing, which is the one
  // thing §3.2 explicitly says it does.
  assert.ok(rise > 0.006 && rise <= 0.015, `rise ${rise}s must sit around the datasheet's 12 ms`);
  assert.ok(fall > 0.10 && fall <= 0.30, `fall ${fall}s must sit around the datasheet's 250 ms`);
  assert.ok(fall / rise > 10, `the fall must be an order of magnitude slower than the rise; measured ${(fall / rise).toPrecision(3)}×`);
});

check("Table 1 — VCA mode ATTENUATES where the other two FILTER", () => {
  // Paper §2: "In 'VCA' mode … variation of Rf now provides reasonably clean
  // attenuation of the input signal", because Rα drops to 5 kΩ and Rf/Rα becomes
  // a potential divider. So at a HALF-OPEN gate, VCA mode must be markedly
  // quieter at LOW frequency than 'Both' — a difference no filter alone produces.
  const measure = (mode, hz, cv) => {
    const voice = new LpgVoice(SAMPLE_RATE);
    let peak = 0;
    for (let n = 0; n < SAMPLE_RATE; n++) {
      const out = voice.process(Math.sin(2 * Math.PI * hz * n / SAMPLE_RATE) * RACK_VOLTS_PER_UNIT, cv, mode, 0, 0);
      if (n > SAMPLE_RATE / 2) peak = Math.max(peak, Math.abs(out));
    }
    return peak;
  };
  const halfOpen = NYSTHI_GATE_VOLTS / 2;
  const vca = measure(LPG_MODES.indexOf("vca"), 50, halfOpen);
  const both = measure(LPG_MODES.indexOf("vca_lp"), 50, halfOpen);
  console.log(`  ${"50 Hz through a half-open gate, VCA vs Both (V)".padEnd(56)} ${vca.toPrecision(4)} / ${both.toPrecision(4)}`);
  // AND THE FIGURE IS CHECKED AGAINST Eq. 12, not against a hand-picked ratio —
  // `H(0) = Rα / (Rα + 2·Rf)` is the paper's own DC gain, so a half-open gate's
  // Rf predicts the level exactly. That is a far stronger claim than "quieter",
  // and it is the only place in this block where a published equation can be
  // checked end to end through the whole audio path.
  const halfOpenRf = lpgResistance(0.02);
  const predicted = RACK_VOLTS_PER_UNIT * (5e3 / (5e3 + 2 * halfOpenRf));
  within("VCA mode's 50 Hz level vs the paper's Eq. 12", vca, predicted, 0.01);
  assert.ok(both > 4, `'Both' mode passes 50 Hz nearly untouched at half open; measured ${both}`);
  assert.ok(vca < both * 0.7, `and VCA mode is the one that divides it down; measured ${vca} against ${both}`);
});

check("a closed gate is silent and an open one passes — the LPG's whole job", () => {
  const measure = (cv) => {
    const kernel = new B208DualLpgKernel(SAMPLE_RATE);
    const knobs = defaultKnobs("vcvB208DualLpg");
    let peak = 0;
    run(kernel, 4, SAMPLE_RATE, (n, signals) => {
      const s = Math.sin(2 * Math.PI * 220 * n / SAMPLE_RATE) * RACK_VOLTS_PER_UNIT;
      for (let i = 1; i <= 4; i++) { signals[`in_${i}`] = s; signals[`cv_${i}`] = cv; }
    }, knobs, noCables("vcvB208DualLpg"), (n, frame) => {
      if (n > SAMPLE_RATE / 2) peak = Math.max(peak, Math.abs(frame[0]));
    });
    return peak;
  };
  const open = measure(NYSTHI_GATE_VOLTS);
  const closed = measure(0);
  console.log(`  ${"220 Hz, gate open vs closed (V)".padEnd(56)} ${open.toPrecision(4)} / ${closed.toExponential(3)}`);
  assert.ok(open > 4.5, `a fully open gate passes a 5 V sine; measured ${open}`);
  assert.ok(closed < open / 1000, `a closed gate must be 60 dB down; measured ${closed} against ${open}`);
});

check("PolyLPG and the dual LPG are ONE kernel, so one CV opens both identically", () => {
  // CHANGELOG.md:2330: "POLY LPG … it's just one of the b208 dual dual LPG
  // expanded". Approximating it twice would be two things to get differently
  // wrong, so the identity is asserted rather than assumed.
  const poly = new PolyLpgKernel(SAMPLE_RATE);
  const dual = new B208DualLpgKernel(SAMPLE_RATE);
  const polyKnobs = { level: 1, response: 1, offset: 0, reso: 0 };
  const dualKnobs = defaultKnobs("vcvB208DualLpg");
  const a = new Float64Array(1);
  const b = new Float64Array(4);
  let worst = 0;
  for (let n = 0; n < SAMPLE_RATE / 4; n++) {
    const s = Math.sin(2 * Math.PI * 330 * n / SAMPLE_RATE) * RACK_VOLTS_PER_UNIT;
    const cv = (n / SAMPLE_RATE) * NYSTHI_GATE_VOLTS * 4;
    poly.sample(polyKnobs, { in: s, cv }, {}, a);
    dual.sample(dualKnobs, { in_1: s, cv_1: cv, in_2: 0, in_3: 0, in_4: 0, cv_2: 0, cv_3: 0, cv_4: 0 }, {}, b);
    worst = Math.max(worst, Math.abs(a[0] - b[0]));
  }
  within("|PolyLPG − dual LPG channel 1|", worst, 0, 1e-12);
});

check("the 208 envelope peaks at exactly 10 V and its EOC pulse is 1 ms", () => {
  // CHANGELOG.md:2692 "ENV OUT … Value goes from 0v to 10v" and :2689 "a 1 msec
  // PULSE is coming out every time the cycle is closed".
  const kernel = new B208EnvelopeKernel(SAMPLE_RATE);
  const knobs = defaultKnobs("vcvB208Envelope");
  knobs.attack_1 = 0.01;
  knobs.duration_1 = 0.01;
  knobs.decay_1 = 0.02;
  knobs.curve_1 = 0;
  let peak = 0;
  let eocSamples = 0;
  run(kernel, 6, SAMPLE_RATE / 4, (n, signals) => {
    for (const key of indexKeys("i", 8)) signals[key] = 0;
    signals.i0 = n < 10 ? NYSTHI_GATE_VOLTS : 0;
  }, knobs, noCables("vcvB208Envelope"), (n, frame) => {
    peak = Math.max(peak, frame[2]);
    if (frame[1] > 0) eocSamples++;
  });
  within("208 envelope peak (V)", peak, 10, 0.02);
  within("EOC pulse width (s)", eocSamples / SAMPLE_RATE, NYSTHI_PULSE_SECONDS, 1 / SAMPLE_RATE);
});

check("the 208 envelope's SUSTAINED mode holds while the gate is high; TRANSIENT does not", () => {
  // CHANGELOG.md:2690-2693: the jack "is a GATE IN if in 'sustained' mode and a
  // TRIG IN if in 'transient' mode", and DURATION is "only working if in
  // transient mode". So a LONG gate must produce a long plateau in one mode and
  // the duration knob's plateau in the other — which is the whole difference.
  const plateau = (mode) => {
    const kernel = new B208EnvelopeKernel(SAMPLE_RATE);
    kernel.setMode1(mode);
    const knobs = defaultKnobs("vcvB208Envelope");
    knobs.attack_1 = 0.002;
    knobs.duration_1 = 0.01;
    knobs.decay_1 = 0.002;
    let held = 0;
    run(kernel, 6, SAMPLE_RATE / 2, (n, signals) => {
      for (const key of indexKeys("i", 8)) signals[key] = 0;
      signals.i0 = n < SAMPLE_RATE / 4 ? NYSTHI_GATE_VOLTS : 0;
    }, knobs, noCables("vcvB208Envelope"), (n, frame) => {
      if (frame[2] > 9.99) held++;
    });
    return held / SAMPLE_RATE;
  };
  const transient = plateau("transient");
  const sustained = plateau("sustained");
  console.log(`  ${"plateau, transient vs sustained (s)".padEnd(56)} ${transient.toPrecision(4)} / ${sustained.toPrecision(4)}`);
  within("transient plateau follows the DURATION knob", transient, 0.01, 0.002);
  assert.ok(sustained > 0.2, `sustained must hold for the whole 0.25 s gate; measured ${sustained}`);
});

check("AttackDecay's SCALE inverts and its LOOP free-runs", () => {
  // CHANGELOG.md:5008 "SCALE can scale Envelope for -2x to 2x … is used to invert
  // the envelope" and :5011 "LOOP button to have a cyclable AD".
  const cycles = (loop, scale) => {
    const kernel = new AttackDecayKernel(SAMPLE_RATE);
    const knobs = defaultKnobs("vcvAttackDecay");
    knobs.attack = 0.01;
    knobs.decay = 0.01;
    knobs.loop = loop;
    knobs.scale = scale;
    let eocs = 0;
    let extreme = 0;
    let wasHigh = false;
    run(kernel, 2, SAMPLE_RATE, (n, signals) => {
      signals.attack_cv = 0;
      signals.decay_cv = 0;
      signals.retrig = 0;
      signals.trig = n < 10 ? NYSTHI_GATE_VOLTS : 0;
    }, knobs, noCables("vcvAttackDecay"), (n, frame) => {
      const high = frame[1] > 0;
      if (high && !wasHigh) eocs++;
      wasHigh = high;
      if (Math.abs(frame[0]) > Math.abs(extreme)) extreme = frame[0];
    });
    return { eocs, extreme };
  };
  const once = cycles(0, 1);
  assert.equal(once.eocs, 1, "one trigger, one cycle, one EOC");
  within("AttackDecay peak at scale 1 (V)", once.extreme, 10, 0.05);
  const inverted = cycles(0, -1);
  within("…and at scale −1 (V)", inverted.extreme, -10, 0.05);
  const looped = cycles(1, 1);
  // 20 ms per cycle in one second is about 50 cycles; the assertion is that it
  // KEEPS GOING rather than an exact count, because the loop restart costs a
  // sample and that is not a documented number.
  assert.ok(looped.eocs > 40, `LOOP must free-run; measured ${looped.eocs} cycles in one second`);
});

check("envShape is monotone and pinned at both ends in every curve setting", () => {
  for (const curve of [0, 0.5, 1]) {
    assert.equal(envShape(0, curve), 0);
    within(`envShape(1, ${curve})`, envShape(1, curve), 1, 1e-12);
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const value = envShape(i / 100, curve);
      assert.ok(value >= previous, `envShape must not fold back at curve ${curve}`);
      previous = value;
    }
  }
  assert.ok(envShape(0.5, 1) < envShape(0.5, 0), "the exponential setting must lag the line");
});

check("the QuadPanner's two documented pan laws — linear, and EQUAL POWER", () => {
  // CHANGELOG.md:4680 "the PANNING is LINEAR and becomes EQUAL POWER PANNING
  // activating the FLAG". Equal power means the SUM OF SQUARES is what stays
  // constant, so it must be flatter across the room than the linear law is.
  const spread = (equalPower) => {
    let lowest = Infinity;
    let highest = 0;
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const x = -1 + (2 * i) / 20;
        const y = -1 + (2 * j) / 20;
        let power = 0;
        for (let c = 0; c < QUAD_CORNERS.length; c++) power += quadCornerGain(x, y, c, equalPower) ** 2;
        lowest = Math.min(lowest, power);
        highest = Math.max(highest, power);
      }
    }
    return { lowest, highest };
  };
  const linear = spread(false);
  const equal = spread(true);
  console.log(`  ${"summed power across the room, linear low/high".padEnd(56)} ${linear.lowest.toPrecision(4)} / ${linear.highest.toPrecision(4)}`);
  console.log(`  ${"…and equal-power low/high".padEnd(56)} ${equal.lowest.toPrecision(4)} / ${equal.highest.toPrecision(4)}`);
  // THE NAME IS THE ASSERTION: equal power means the summed power is ONE at every
  // position in the field, not merely flatter than the linear law. (An earlier
  // version of this suite asserted "flatter" and the implementation it was
  // checking — sqrt(linear) — was 26% NOT flat, which is how the defect surfaced.)
  within("equal-power summed power, worst case", equal.lowest, 1, 1e-9);
  within("equal-power summed power, best case", equal.highest, 1, 1e-9);
  assert.ok(linear.highest / linear.lowest > 1.05,
    `…and the linear law is genuinely NOT constant power, or the flag would be meaningless; measured ${linear.highest / linear.lowest}`);
  assert.equal(quadCornerGain(-1, 1, 0, false), 1, "hard front-left is unity at FL");
  assert.equal(quadCornerGain(-1, 1, 3, false), 0, "and silent at the opposite corner");
});

check("the QuadPanner's documented PRECEDENCE: a patched X beats the swirl beats the azimuth", () => {
  // CHANGELOG.md:4682 "X & Y positioning takes precendece on SWIRL that takes
  // precendece on setting AZIMUTH (and MAGNITUDE)". This is the block's clearest
  // isConnected law (kernels' D12) and no AudioParam could express it.
  const corners = (wiredX, swirlRate) => {
    const kernel = new QuadPannerKernel(SAMPLE_RATE);
    const knobs = { azimuth: 0.25, magnitude: 1, swirl_rate: swirlRate, swirl_amount: 1 };
    const wired = noCables("vcvQuadPanner");
    wired.x = wiredX;
    wired.y = wiredX;
    const frame = new Float64Array(5);
    const signals = { in: RACK_VOLTS_PER_UNIT, x: -NYSTHI_GATE_VOLTS, y: -NYSTHI_GATE_VOLTS };
    for (const c of QUAD_CORNERS) signals[`chain_${c}`] = 0;
    kernel.sample(knobs, signals, wired, frame);
    return Array.from(frame.slice(0, 4));
  };
  // Azimuth 0.25 with nothing patched puts the source at front-LEFT (x = −1 in
  // our corner map is left, y = +1 is front), so FL must be loudest.
  const byAzimuth = corners(false, 0);
  assert.equal(byAzimuth.indexOf(Math.max(...byAzimuth)), 0, "azimuth 0.25 places the source front-left");
  // A patched X and Y at −10 V is REAR-LEFT, and it must win even though the
  // azimuth knob still says front-left.
  const byCv = corners(true, 0);
  assert.equal(byCv.indexOf(Math.max(...byCv)), 2, "a patched X/Y must override the azimuth knob");
  // …and it must still win when a swirl is also running.
  const bothPatched = corners(true, 4);
  assert.equal(bothPatched.indexOf(Math.max(...bothPatched)), 2, "a patched X/Y must also override the swirl");
});

check("the QuadPanner's chain inputs SUM, which is what cascading means", () => {
  const kernel = new QuadPannerKernel(SAMPLE_RATE);
  const knobs = { azimuth: 0, magnitude: 0, swirl_rate: 0, swirl_amount: 0 };
  const frame = new Float64Array(5);
  const signals = { in: 0, x: 0, y: 0, chain_fl: 1, chain_fr: 2, chain_rl: 3, chain_rr: 4 };
  kernel.sample(knobs, signals, noCables("vcvQuadPanner"), frame);
  assert.deepEqual(Array.from(frame.slice(0, 4)), [1, 2, 3, 4], "a silent panner passes its chain through untouched");
  assert.equal(frame[4], 0, "the touch gate is inert here and says so (kernels' D11)");
});

check("the delay's HOLD makes the frozen window repeat forever", () => {
  // CHANGELOG.md:3830 "HOLD and HOLD TRIG IN will freeze current buffer a
  // repeated forever" and :3785 "the recorded data is preserved in memory".
  // THE MEASUREMENT IS A COUNT OF ECHOES, because that is what "repeated" means
  // and a level alone cannot distinguish one echo from twelve. Feedback is ZERO,
  // so without HOLD exactly one echo can ever come back — anything more is the
  // hold loop and nothing else.
  const echoes = (holdAt) => {
    const kernel = new ClockableDelayKernel(SAMPLE_RATE, { max_seconds: 1 });
    const knobs = defaultKnobs("vcvClockableDelay");
    knobs.time = DELAY_WINDOW_SECONDS;
    knobs.mult = 1;
    knobs.feedback = 0;
    knobs.feed_in = 1;
    knobs.dry_wet = 1;
    let count = 0;
    let wasHigh = false;
    run(kernel, 11, SAMPLE_RATE / 2, (n, signals) => {
      for (const key of VC8_PROCESSORS.find((r) => r.module === "vcvClockableDelay").audioInputs) signals[key] = 0;
      signals.in_l = n === IMPULSE_AT ? RACK_VOLTS_PER_UNIT : 0;
      signals.hold = holdAt !== null && n === holdAt ? NYSTHI_GATE_VOLTS : 0;
    }, knobs, noCables("vcvClockableDelay"), (n, frame) => {
      const high = Math.abs(frame[8]) > 1;
      if (high && !wasHigh) count++;
      wasHigh = high;
    });
    return count;
  };
  // HOLD engages while the impulse is still inside the last `time` seconds of
  // recording, which is the only window a freeze can capture.
  const free = echoes(null);
  const held = echoes(Math.round(DELAY_WINDOW_SECONDS * SAMPLE_RATE) / 2);
  console.log(`  ${"echoes in 0.5 s at zero feedback, free vs held".padEnd(56)} ${free} / ${held}`);
  assert.equal(free, 1, "at zero feedback an impulse comes back exactly once");
  assert.ok(held >= 9, `HOLD must loop the window forever — 0.5 s of ${DELAY_WINDOW_SECONDS} s loops is about ten; measured ${held}`);
});

check("the delay's ±20 V limiter catches a feedback above unity", () => {
  // CHANGELOG.md:3762 "add an hard limiter (max voltages -20 to +20 after
  // feedback)" — which is what makes a feedback of 1.1 a wash instead of a crash.
  const kernel = new ClockableDelayKernel(SAMPLE_RATE, { max_seconds: 1 });
  const knobs = defaultKnobs("vcvClockableDelay");
  knobs.time = 0.01;
  knobs.mult = 1;
  knobs.feedback = 1.1;
  knobs.feed_in = 2;
  knobs.dry_wet = 1;
  let sendPeak = 0;
  let loopPeak = 0;
  run(kernel, 11, SAMPLE_RATE * 3, (n, signals) => {
    for (const key of VC8_PROCESSORS.find((r) => r.module === "vcvClockableDelay").audioInputs) signals[key] = 0;
    signals.in_l = Math.sin(2 * Math.PI * 100 * n / SAMPLE_RATE) * RACK_VOLTS_PER_UNIT;
  }, knobs, noCables("vcvClockableDelay"), (n, frame) => {
    sendPeak = Math.max(sendPeak, Math.abs(frame[0]));
    loopPeak = Math.max(loopPeak, Math.abs(frame[8]));
  });
  console.log(`  ${"3 s at 110% feedback, buffer / send peak (V)".padEnd(56)} ${loopPeak.toPrecision(5)} / ${sendPeak.toPrecision(5)}`);
  // THE LIMITER IS ON WHAT IS WRITTEN, and that is the distinction that matters:
  // "max voltages -20 to +20 AFTER FEEDBACK" bounds the recirculating signal, so
  // the buffer cannot grow. The SEND tap is upstream of the write and legitimately
  // reaches in·feed_in + limit·feedback = 5·2 + 20·1.1 = 32 V, which is the module
  // exposing its hot pre-feedback signal rather than a failure to limit.
  assert.ok(loopPeak <= CDELAY_LIMIT_TEST_VOLTS + 1e-6,
    `the recirculating buffer must saturate at ±20 V; measured ${loopPeak}`);
  assert.ok(Number.isFinite(sendPeak) && sendPeak <= RACK_VOLTS_PER_UNIT * 2 + CDELAY_LIMIT_TEST_VOLTS * 1.1 + 1e-6,
    `the send tap is bounded by the limited loop it reads; measured ${sendPeak}`);
});

check("the mixer's CV MULTIPLIES, and only when patched", () => {
  // CHANGELOG.md:3715-3717: a channel has a VOLUME CV and a VOLUME CV VCA. R7's
  // `_cv` rule: a multiplying CV must not mute the module when nobody patches it.
  const level = (wiredCv, cvVolts) => {
    const kernel = new Mix4Kernel();
    const knobs = defaultKnobs("vcvNysthiMix4");
    const wired = noCables("vcvNysthiMix4");
    wired.cv1 = wiredCv;
    const frame = new Float64Array(2);
    const signals = {};
    for (const key of VC8_PROCESSORS.find((r) => r.module === "vcvNysthiMix4").audioInputs) signals[key] = 0;
    signals.in1 = RACK_VOLTS_PER_UNIT;
    signals.cv1 = cvVolts;
    kernel.sample(knobs, signals, wired, frame);
    return frame[0] + frame[1];
  };
  const unpatched = level(false, 0);
  const patchedZero = level(true, 0);
  const patchedFull = level(true, NYSTHI_GATE_VOLTS);
  console.log(`  ${"mixer ch1: unpatched / patched 0 V / patched 10 V".padEnd(56)} ${unpatched.toPrecision(4)} / ${patchedZero.toPrecision(4)} / ${patchedFull.toPrecision(4)}`);
  assert.ok(unpatched > 4, "NO CABLE MUST MEAN UNITY — a 0 default here would mute a fresh mixer");
  assert.equal(patchedZero, 0, "a patched cable at 0 V mutes the channel; that is the whole difference from an adding CV");
  within("a patched cable at 10 V restores unity", patchedFull, unpatched, 1e-9);
});

check("the mixer's pan is constant power at every position", () => {
  for (let i = 0; i <= 20; i++) {
    const pan = -1 + (2 * i) / 20;
    const { left, right } = mix4PanGains(pan);
    assert.ok(Math.abs(left ** 2 + right ** 2 - 1) < 1e-12, `pan ${pan} is not constant power`);
  }
  assert.ok(mix4PanGains(-1).left > 0.999 && mix4PanGains(-1).right < 1e-9, "hard left is hard left");
});

check("Surveillance is one pot times ten attenuverters, in the range the switch selects", () => {
  // CHANGELOG.md:5190-5191 "one control to send 10 different voltages / the main
  // pot goes from -5 to +5 / all the outs are controlled by attuenverters", and
  // :5202-5205 the two ranges.
  const kernel = new SurveillanceKernel();
  const knobs = defaultKnobs("vcvSurveillance");
  knobs.main = 1;
  knobs.v_1 = 1;
  knobs.v_2 = -1;
  knobs.v_3 = 0.5;
  const frame = new Float64Array(SURVEILLANCE_OUTPUTS);
  kernel.sample(knobs, {}, {}, frame);
  within("bipolar, main at full, attenuverter +1 (V)", frame[0], 5, 1e-9);
  within("…attenuverter −1 inverts (V)", frame[1], -5, 1e-9);
  within("…attenuverter +0.5 halves (V)", frame[2], 2.5, 1e-9);
  assert.equal(frame[3], 0, "an attenuverter at zero outputs zero, whatever the pot says");
  kernel.setRange("unipolar");
  kernel.sample(knobs, {}, {}, frame);
  within("unipolar, main at full, attenuverter +1 (V)", frame[0], 10, 1e-9);
});

check("SQUONK walks DOWN by default and UP when the switch is on, skipping JUMP stages", () => {
  // CHANGELOG.md:4806 "UP TRIG and BUTTON: if ON the sequence will go UP (normally
  // is DOWN)" and line 9, ":4800", "if black step is jumped".
  const walk = (up, jumped) => {
    const kernel = new SquonkKernel(SAMPLE_RATE, { seed: 1 });
    const knobs = defaultKnobs("vcvSquonk");
    knobs.up = up;
    for (const stage of jumped) knobs[`mode${stage}`] = 2;
    // Give every stage a distinct A value so the OUTPUT identifies the stage.
    for (let stage = 1; stage <= SQUONK_STAGES; stage++) knobs[`a${stage}`] = stage / SQUONK_STAGES;
    const seen = [];
    const period = 1000;
    run(kernel, 8, period * 6, (n, signals) => {
      for (const key of VC8_PROCESSORS.find((r) => r.module === "vcvSquonk").audioInputs) signals[key] = 0;
      signals.clock = n % period < 10 ? NYSTHI_GATE_VOLTS : 0;
    }, knobs, noCables("vcvSquonk"), (n, frame) => {
      if (n % period === 50) seen.push(Math.round(frame[0] / (2 / SQUONK_STAGES)));
    });
    return seen;
  };
  assert.deepEqual(walk(0, []), [12, 11, 10, 9, 8, 7], "DOWN is the module's own normal direction");
  assert.deepEqual(walk(1, []), [2, 3, 4, 5, 6, 7], "UP counts up");
  assert.deepEqual(walk(1, [3, 4]), [2, 5, 6, 7, 8, 9], "a JUMP stage is stepped over, not played");
});

check("SQUONK's A/B/C reach 2 V and D/E reach ±1 V, and 5X multiplies both", () => {
  // CHANGELOG.md:4795-4799: "A: CV channel from 0 to 2 volts" (and B, C) against
  // "D: CV channel from -1 to 1 volts" (and E). The ASYMMETRY is the vendor's and
  // is what makes D and E the modulation pair.
  const peaks = (multiply) => {
    const kernel = new SquonkKernel(SAMPLE_RATE, { seed: 1 });
    const knobs = defaultKnobs("vcvSquonk");
    knobs.multiply = multiply;
    for (const channel of SQUONK_CHANNELS) {
      for (let stage = 1; stage <= SQUONK_STAGES; stage++) knobs[`${channel}${stage}`] = 1;
    }
    const frame = new Float64Array(8);
    const signals = {};
    for (const key of VC8_PROCESSORS.find((r) => r.module === "vcvSquonk").audioInputs) signals[key] = 0;
    kernel.sample(knobs, signals, noCables("vcvSquonk"), frame);
    return Array.from(frame.slice(0, 5));
  };
  const plain = peaks(0);
  within("A at full (V)", plain[0], 2, 1e-9);
  within("D at full (V)", plain[3], 1, 1e-9);
  const boosted = peaks(1);
  within("A at full with 5X (V)", boosted[0], 10, 1e-9);
  within("D at full with 5X (V)", boosted[3], 5, 1e-9);
});

check("SQUONK's REP ratchets — one clock, N triggers", () => {
  // CHANGELOG.md:4801 "REP: if the sequencer is clocked will retrig the step from
  // 1 to 8 times (subdivisions) (ratcheting)".
  const triggers = (rep) => {
    const kernel = new SquonkKernel(SAMPLE_RATE, { seed: 1 });
    const knobs = defaultKnobs("vcvSquonk");
    knobs.up = 1;
    for (let stage = 1; stage <= SQUONK_STAGES; stage++) knobs[`rep${stage}`] = rep;
    let count = 0;
    let wasHigh = false;
    const period = 4800;
    run(kernel, 8, period * 4, (n, signals) => {
      for (const key of VC8_PROCESSORS.find((r) => r.module === "vcvSquonk").audioInputs) signals[key] = 0;
      signals.clock = n % period < 10 ? NYSTHI_GATE_VOLTS : 0;
    }, knobs, noCables("vcvSquonk"), (n, frame) => {
      const high = frame[5] > 0;
      if (high && !wasHigh && n >= period) count++;
      wasHigh = high;
    });
    return count;
  };
  const single = triggers(1);
  const quad = triggers(4);
  console.log(`  ${"triggers over 3 clocks, rep 1 vs rep 4".padEnd(56)} ${single} / ${quad}`);
  assert.equal(single, 3, "rep 1 is one trigger per clock");
  assert.equal(quad, 12, "rep 4 is four triggers per clock");
  assert.ok(SQUONK_MAX_REPEATS === 8, "the panel's documented ceiling");
});

check("SQUONK's randomness is SEEDED — same seed, same walk; different seed, different walk", () => {
  // The project's determinism law. NYSTHI's own RND draws from Rack's
  // clock-seeded generator and is not reproducible even on the same machine.
  const walk = (seed) => {
    const kernel = new SquonkKernel(SAMPLE_RATE, { seed });
    const knobs = defaultKnobs("vcvSquonk");
    knobs.rnd = 1;
    for (let stage = 1; stage <= SQUONK_STAGES; stage++) knobs[`a${stage}`] = stage / SQUONK_STAGES;
    const seen = [];
    const period = 500;
    run(kernel, 8, period * 12, (n, signals) => {
      for (const key of VC8_PROCESSORS.find((r) => r.module === "vcvSquonk").audioInputs) signals[key] = 0;
      signals.clock = n % period < 10 ? NYSTHI_GATE_VOLTS : 0;
    }, knobs, noCables("vcvSquonk"), (n, frame) => {
      if (n % period === 50) seen.push(frame[0]);
    });
    return seen;
  };
  assert.deepEqual(walk(7), walk(7), "same seed, byte-identical sequence — Δt = 0 ⟹ identical frame");
  assert.notDeepEqual(walk(7), walk(8), "and the seed must actually be used");
  assert.equal(nysthiLcg(0), 907633515, "the LCG is AX-2's, reused rather than a second generator invented");
});

check("the Programmer's per-stage select trigger jumps straight to that stage", () => {
  // CHANGELOG.md:1070 "SELECT STAGE IN TRIG" per stage — which is what makes P22's
  // `clock.reset → prog.i0` a reset, and what fixes i0..i15 as the per-stage bank.
  const kernel = new ProgrammerKernel(SAMPLE_RATE);
  const knobs = defaultKnobs("vcvProgrammer");
  for (let stage = 1; stage <= PROGRAMMER_STAGES; stage++) knobs[`a${stage}`] = stage / PROGRAMMER_STAGES;
  const frame = new Float64Array(22);
  const signals = {};
  for (const key of indexKeys("i", 19)) signals[key] = 0;
  const wired = noCables("vcvProgrammer");
  // Select stage 6 (index 5) and read channel A.
  signals.i5 = NYSTHI_GATE_VOLTS;
  kernel.sample(knobs, signals, wired, frame);
  within("channel A after selecting stage 6 (V)", frame[PROGRAMMER_STAGES], (6 / PROGRAMMER_STAGES) * 10, 1e-9);
  // Its own pulse output must have fired, and only its own.
  const fired = Array.from(frame.slice(0, PROGRAMMER_STAGES)).map((v) => v > 0);
  assert.deepEqual(fired.map((f, i) => (f ? i : -1)).filter((i) => i >= 0), [5], "only the selected stage pulses");
});

check("the Programmer's forward clock walks and its SKIP mode is stepped over", () => {
  // CHANGELOG.md:1078-1085, the per-stage RUN / STOP / SKIP triple.
  const kernel = new ProgrammerKernel(SAMPLE_RATE);
  const knobs = defaultKnobs("vcvProgrammer");
  for (let stage = 1; stage <= PROGRAMMER_STAGES; stage++) knobs[`a${stage}`] = stage / PROGRAMMER_STAGES;
  knobs.mode3 = 2; // stage 3 SKIPs
  const seen = [];
  const period = 500;
  run(kernel, 22, period * 5, (n, signals) => {
    for (const key of indexKeys("i", 19)) signals[key] = 0;
    signals.i16 = n % period < 10 ? NYSTHI_GATE_VOLTS : 0;
  }, knobs, noCables("vcvProgrammer"), (n, frame) => {
    if (n % period === 50) seen.push(Math.round((frame[PROGRAMMER_STAGES] / 10) * PROGRAMMER_STAGES));
  });
  assert.deepEqual(seen, [2, 4, 5, 6, 7], "the forward clock walks +1 and steps over the SKIP stage");
});

check("the Programmer's ACTIVE switch silences a stage's pulses without skipping it", () => {
  // CHANGELOG.md:1068 "active ON/OFF (if OFF stage will not emit the pulse(s))".
  // The distinction from SKIP is the whole point: an inactive stage is still
  // WALKED and still sets the CV, so a rhythm gains a hole without changing length.
  const kernel = new ProgrammerKernel(SAMPLE_RATE);
  const knobs = defaultKnobs("vcvProgrammer");
  for (let stage = 1; stage <= PROGRAMMER_STAGES; stage++) knobs[`a${stage}`] = stage / PROGRAMMER_STAGES;
  knobs.active3 = 0;
  const cvs = [];
  let trigs = 0;
  let wasHigh = false;
  const period = 500;
  run(kernel, 22, period * 4, (n, signals) => {
    for (const key of indexKeys("i", 19)) signals[key] = 0;
    signals.i16 = n % period < 10 ? NYSTHI_GATE_VOLTS : 0;
  }, knobs, noCables("vcvProgrammer"), (n, frame) => {
    if (n % period === 50) cvs.push(Math.round((frame[PROGRAMMER_STAGES] / 10) * PROGRAMMER_STAGES));
    const high = frame[20] > 0;
    if (high && !wasHigh) trigs++;
    wasHigh = high;
  });
  assert.deepEqual(cvs, [2, 3, 4, 5], "the inactive stage is still walked and still sets the CV");
  assert.equal(trigs, 3, "…but it emits no trigger, so four clocks produce three");
});

check("the Source of Uncertainty's quantized sections land on their documented grids", () => {
  // CHANGELOG.md:4816-4817: "n+1 are in 1V jumps / 2^n are in 1/12V jumps", and
  // :4814 the n+1 distribution is triangular, "like throwing 2 dice".
  const kernel = new SoyModelSouKernel(SAMPLE_RATE, { seed: 3 });
  const knobs = defaultKnobs("vcvSoyModelSou");
  knobs.n_power = 4;
  knobs.n_plus = 3;
  const powers = new Set();
  const pluses = new Set();
  const period = 200;
  run(kernel, 14, period * 400, (n, signals) => {
    signals.i0 = n % period < 5 ? NYSTHI_GATE_VOLTS : 0;
  }, knobs, noCables("vcvSoyModelSou"), (n, frame) => {
    if (n % period === 50) { powers.add(Math.round(frame[6] * 12)); pluses.add(frame[7]); }
  });
  for (const step of powers) assert.ok(Number.isInteger(step), "2^n must land on the 1/12 V grid");
  assert.ok(Math.max(...powers) < 2 ** 4, `2^n with N=4 must stay under sixteen semitones; saw ${Math.max(...powers)}`);
  for (const value of pluses) assert.ok(Number.isInteger(value), "n+1 must land on whole volts");
  assert.ok(Math.max(...pluses) <= 6, `n+1 with N=3 tops out at 2N = 6; saw ${Math.max(...pluses)}`);
  console.log(`  ${"SOU grids: 2^n semitones seen / n+1 volts seen".padEnd(56)} ${powers.size} / ${pluses.size}`);
});

check("the n+1 section's distribution really is triangular", () => {
  // Two dice: the middle must come up far more often than either end. Asserted
  // rather than assumed, because a uniform draw would pass every other check here
  // and would sound completely different.
  const counts = new Map();
  let state = 11;
  const draw = () => { state = nysthiLcg(state); return state / 4294967296; };
  for (let i = 0; i < 60000; i++) {
    const value = souTwoDice(draw(), draw(), 6);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const middle = counts.get(6);
  const edge = counts.get(0);
  console.log(`  ${"two dice with N=6: centre vs extreme count".padEnd(56)} ${middle} / ${edge}`);
  assert.ok(middle > edge * 4, `a triangular distribution peaks hard in the middle; measured ${middle} against ${edge}`);
  assert.equal(souTwoDice(0, 0, 6), 0);
  assert.equal(souTwoDice(0.999, 0.999, 6), 12);
});

check("the stored section's SKEW crowds the range it says it crowds", () => {
  // CHANGELOG.md:4840 "Random with SKEWING function … to have more events in LOW
  // MID or HIGH ranges". The LAW is ours (G22); the DIRECTION is the document's.
  const mean = (skew) => {
    let state = 5;
    let total = 0;
    const draws = 20000;
    for (let i = 0; i < draws; i++) {
      state = nysthiLcg(state);
      total += souSkew(state / 4294967296, skew);
    }
    return total / draws;
  };
  const low = mean(-1);
  const flat = mean(0);
  const high = mean(1);
  console.log(`  ${"skew −1 / 0 / +1, mean of the draw".padEnd(56)} ${low.toPrecision(4)} / ${flat.toPrecision(4)} / ${high.toPrecision(4)}`);
  within("skew 0 is uniform", flat, 0.5, 0.02);
  assert.ok(low < flat - 0.05, "negative skew must crowd the LOW end");
  assert.ok(high > flat + 0.05, "positive skew must crowd the HIGH end");
});

check("the SOU is seeded, so a document renders the same way every time", () => {
  const render = (seed) => {
    const kernel = new SoyModelSouKernel(SAMPLE_RATE, { seed });
    const knobs = defaultKnobs("vcvSoyModelSou");
    const seen = [];
    run(kernel, 14, 20000, (n, signals) => { signals.i0 = n % 500 < 5 ? NYSTHI_GATE_VOLTS : 0; },
      knobs, noCables("vcvSoyModelSou"), (n, frame) => { if (n % 500 === 100) seen.push(frame[0], frame[6], frame[8]); });
    return seen;
  };
  assert.deepEqual(render(4), render(4), "Δt = 0 ⟹ byte-identical");
  assert.notDeepEqual(render(4), render(5), "and the seed must actually be used");
});

check("a Schmitt trigger fires once per edge, with the hysteresis that stops double-clocking", () => {
  const trigger = new NysthiTrigger();
  assert.equal(trigger.process(0), false);
  assert.equal(trigger.process(TRIGGER_HIGH_VOLTS), true, "rises at the documented 1 V");
  assert.equal(trigger.process(NYSTHI_GATE_VOLTS), false, "…and only once while it stays high");
  assert.equal(trigger.process(0.5), false, "0.5 V is inside the hysteresis band, so it does not re-arm");
  assert.equal(trigger.process(NYSTHI_GATE_VOLTS), false, "…and therefore does not fire again");
  assert.equal(trigger.process(0), false);
  assert.equal(trigger.process(NYSTHI_GATE_VOLTS), true, "a full fall re-arms it");
});

console.log(`\n${passed} VC-8 checks passed.`);
if (process.exitCode) console.error("VC-8: FAILURES ABOVE.");
