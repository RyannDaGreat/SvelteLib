/**
 * SYNTH ENGINE — bare-node tests for the pure parts.
 * Run: node src/demo_apps/PowerRP/tests/synth_engine_test.js
 *
 * ── WHAT THIS FILE CAN AND CANNOT PROVE ──────────────────────────────────────
 * Everything AudioContext-shaped (does a wire actually carry signal, is a
 * rewire actually inaudible) can only be proven in a browser, and is proven by
 * synth/dev.html manually plus a browser probe in wave 2. What is covered HERE
 * is the part where a silent mistake produces a WRONG SOUND rather than an
 * exception — impulse-response shape, scheduler arithmetic, param clamping,
 * FM ratios and the Schmitt state machine. Those are cheap to pin and expensive
 * to debug by ear.
 *
 * It also pins the two facts that are DOCUMENTED IN PROSE and would otherwise
 * silently drift: the native/worklet split, and the Schmitt constants that the
 * worklet file must restate because the AudioWorklet scope cannot import.
 *
 * Lives in tests/ (not synth/) because the gate collects tests/*_test.js.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  clampParam,
  midiToFreq,
  centsToRatio,
  hashRandom,
  generateImpulseResponse,
  impulseEnergy,
  REVERB_CHARACTERS,
  bellVoice,
  BELL_PRESETS,
  supersawDetunes,
  MAX_PAD_SPREAD_CENTS,
  stepDuration,
  stepsInWindow,
  schmittStep,
  SCHMITT_LOW,
  SCHMITT_HIGH,
  SCHEDULER_TICK_MS,
  SCHEDULER_LOOKAHEAD_SECONDS,
  rampSettleSeconds,
  REWIRE_RAMP_SECONDS,
} from "../synth/dsp.js";
import { MODULE_FACTORIES, IMPLEMENTATION, PORT_BLOCK_MODULES, moduleTypes } from "../synth/modules.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("synth: parameter clamping");

test("clampParam bounds without coercing", () => {
  assert.equal(clampParam(0.5, 0, 1, "gain"), 0.5);
  assert.equal(clampParam(20000, 20, 18000, "cutoff"), 18000);
  assert.equal(clampParam(-5, 0, 1, "gain"), 0);
});

test("clampParam REFUSES non-numbers loudly (no silent coercion)", () => {
  // A synth that accepts "440" and quietly makes it 440 is a synth that
  // accepts "fourfourty" and quietly makes it NaN, which poisons an AudioParam
  // and produces silence with no error to explain it.
  assert.throws(() => clampParam("440", 0, 1000, "freq"), /freq must be a finite number/);
  assert.throws(() => clampParam(NaN, 0, 1, "gain"), /must be a finite number/);
  assert.throws(() => clampParam(Infinity, 0, 1, "gain"), /must be a finite number/);
  assert.throws(() => clampParam(null, 0, 1, "gain"), /must be a finite number/);
  assert.throws(() => clampParam(undefined, 0, 1, "gain"), /must be a finite number/);
});

console.log("synth: musical math");

test("midiToFreq anchors at A440 and doubles per octave", () => {
  assert.equal(midiToFreq(69), 440);
  assert.equal(midiToFreq(81), 880);
  assert.equal(midiToFreq(57), 220);
});

test("centsToRatio: 1200 cents is exactly an octave", () => {
  assert.equal(centsToRatio(0), 1);
  assert.ok(Math.abs(centsToRatio(1200) - 2) < 1e-12);
  assert.ok(Math.abs(centsToRatio(-1200) - 0.5) < 1e-12);
});

console.log("synth: deterministic noise");

test("hashRandom is reproducible and in range", () => {
  // Reproducibility is the whole point: an IR built from Math.random differs
  // every load, so no test could ever pin the reverb.
  assert.equal(hashRandom(1), hashRandom(1));
  assert.notEqual(hashRandom(1), hashRandom(2));
  for (let seed = 0; seed < 500; seed++) {
    const value = hashRandom(seed);
    assert.ok(value >= 0 && value < 1, `hashRandom(${seed}) = ${value} out of range`);
  }
});

console.log("synth: impulse response generation");

test("every reverb character generates a buffer of the declared length", () => {
  const sampleRate = 8000; // Small rate keeps the test fast; the math is rate-independent.
  for (const [character, spec] of Object.entries(REVERB_CHARACTERS)) {
    const ir = generateImpulseResponse(character, sampleRate, 7);
    assert.equal(ir.left.length, Math.ceil(spec.seconds * sampleRate), `${character} length`);
    assert.equal(ir.right.length, ir.left.length, `${character} channels match`);
    assert.equal(ir.sampleRate, sampleRate);
  }
});

test("an unknown reverb character fails LOUDLY and names the valid ones", () => {
  assert.throws(() => generateImpulseResponse("cathedral", 8000, 1), /Unknown reverb character/);
  assert.throws(() => generateImpulseResponse("cathedral", 8000, 1), /hall/);
});

test("IRs actually DECAY — late energy is far below early energy", () => {
  // This is what "it is a reverb" MEANS. A generator bug that produced flat
  // noise would still have the right length and still sound like a burst of
  // static; only the energy profile catches it.
  for (const character of Object.keys(REVERB_CHARACTERS)) {
    const ir = generateImpulseResponse(character, 8000, 3);
    const third = Math.floor(ir.left.length / 3);
    const early = impulseEnergy(ir.left.subarray(0, third));
    const late = impulseEnergy(ir.left.subarray(third * 2));
    assert.ok(late < early * 0.5, `${character}: late energy ${late} not well below early ${early}`);
    assert.ok(early > 0, `${character}: no energy at all`);
  }
});

test("IR generation is deterministic given a seed, and varies with it", () => {
  const a = generateImpulseResponse("plate", 8000, 11);
  const b = generateImpulseResponse("plate", 8000, 11);
  const c = generateImpulseResponse("plate", 8000, 12);
  assert.deepEqual([...a.left], [...b.left], "same seed must give the same IR");
  assert.notDeepEqual([...a.left], [...c.left], "different seed must give a different IR");
});

test("deepSpace blooms: it starts quieter than it later becomes", () => {
  // The slow onset is what makes the tail swell AFTER a sound instead of
  // under it — the single thing that makes it read as "space" rather than
  // "big room". A bloom regression is inaudible in a length check.
  const ir = generateImpulseResponse("deepSpace", 8000, 5);
  const window = Math.floor(ir.left.length * 0.02);
  const onset = impulseEnergy(ir.left.subarray(0, window));
  const afterBloom = impulseEnergy(ir.left.subarray(window * 4, window * 5));
  assert.ok(onset < afterBloom, `deepSpace onset ${onset} should be quieter than post-bloom ${afterBloom}`);
});

test("hall and plate do NOT bloom — they start at full energy", () => {
  for (const character of ["hall", "plate"]) {
    const spec = REVERB_CHARACTERS[character];
    assert.equal(spec.bloom, 0, `${character} must not bloom`);
  }
});

test("stereo channels decorrelate past the pre-delay", () => {
  // Identical channels would be mono, and the width is a designed property.
  const ir = generateImpulseResponse("hall", 8000, 2);
  const midpoint = Math.floor(ir.left.length / 2);
  assert.notEqual(ir.left[midpoint], ir.right[midpoint]);
});

console.log("synth: FM bell (the metallic ding)");

test("every bell preset resolves to a usable voice", () => {
  for (const preset of Object.keys(BELL_PRESETS)) {
    const voice = bellVoice(preset, 440);
    assert.ok(voice.carrierHz > 0, `${preset} carrier`);
    assert.ok(voice.modulatorHz > 0, `${preset} modulator`);
    assert.ok(voice.modulationDepthHz > 0, `${preset} depth`);
    assert.ok(voice.ampDecaySeconds > 0, `${preset} decay`);
  }
});

test("bell ratios are INHARMONIC — that is what makes a bell a bell", () => {
  // An integer ratio produces a harmonic spectrum, which sounds like an organ
  // or a brass instrument, never like struck metal. Any preset that drifted to
  // a near-integer ratio would silently stop sounding like a bell.
  for (const [preset, spec] of Object.entries(BELL_PRESETS)) {
    const distanceToInteger = Math.abs(spec.ratio - Math.round(spec.ratio));
    assert.ok(
      distanceToInteger > 0.1,
      `${preset} ratio ${spec.ratio} is too close to the integer ${Math.round(spec.ratio)} — that is a harmonic spectrum, not a bell`,
    );
  }
});

test("the modulation index decays FASTER than the amplitude", () => {
  // THE detail that separates a bell from a buzzer: a real bell is bright at
  // the strike and pure as it rings out, so the spectrum must thin before the
  // sound fades. If these ever cross, every bell becomes a doorbell.
  for (const preset of Object.keys(BELL_PRESETS)) {
    const voice = bellVoice(preset, 440);
    assert.ok(
      voice.indexDecaySeconds < voice.ampDecaySeconds,
      `${preset}: index decay ${voice.indexDecaySeconds} must be shorter than amp decay ${voice.ampDecaySeconds}`,
    );
  }
});

test("bell modulator frequency tracks the carrier by the preset ratio", () => {
  const voice = bellVoice("ding", 440);
  assert.ok(Math.abs(voice.modulatorHz - 440 * BELL_PRESETS.ding.ratio) < 1e-9);
  const higher = bellVoice("ding", 880);
  assert.ok(Math.abs(higher.modulatorHz - 2 * voice.modulatorHz) < 1e-9, "ratio must be pitch-independent");
});

test("an unknown bell preset fails loudly", () => {
  assert.throws(() => bellVoice("bong", 440), /Unknown bell preset/);
});

console.log("synth: supersaw detune (the ambience pad)");

test("detunes are symmetric and centred", () => {
  assert.deepEqual(supersawDetunes(1, 12), [0]);
  assert.deepEqual(supersawDetunes(3, 12), [-12, 0, 12]);
  const seven = supersawDetunes(7, 16);
  assert.equal(seven.length, 7);
  assert.ok(Math.abs(seven[3]) < 1e-12, "odd voice counts must have a centre voice at 0");
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(seven[i] + seven[6 - i]) < 1e-12, "fan must be symmetric about the centre");
  }
});

test("detune spread is capped at the dissonance ceiling", () => {
  // Beyond ~25 cents the ensemble stops sounding lush and starts sounding
  // out of tune — the research's stated constraint, enforced not just advised.
  const wild = supersawDetunes(5, 500);
  for (const cents of wild) {
    assert.ok(Math.abs(cents) <= MAX_PAD_SPREAD_CENTS, `${cents} exceeds the ${MAX_PAD_SPREAD_CENTS}c ceiling`);
  }
});

test("supersaw voices are distinct — no two share a detune", () => {
  // Two voices at the same detune are one voice at double amplitude: no
  // beating, no width, and the pad silently loses its character.
  const detunes = supersawDetunes(7, 16);
  assert.equal(new Set(detunes).size, detunes.length);
});

console.log("synth: scheduler math (two clocks)");

test("the lookahead window is longer than the tick interval", () => {
  // THE invariant that makes the whole two-clock pattern work: if the window
  // were shorter than the tick, events would come due before the next wakeup
  // and the scheduler would miss them. 4x headroom rides out a ~75ms stall.
  const tickSeconds = SCHEDULER_TICK_MS / 1000;
  assert.ok(
    SCHEDULER_LOOKAHEAD_SECONDS > tickSeconds,
    `lookahead ${SCHEDULER_LOOKAHEAD_SECONDS}s must exceed tick ${tickSeconds}s`,
  );
  assert.ok(SCHEDULER_LOOKAHEAD_SECONDS >= tickSeconds * 3, "want real headroom, not a hair's breadth");
});

test("stepDuration converts BPM correctly", () => {
  assert.equal(stepDuration(120, 4), 0.125); // 16ths at 120 BPM
  assert.equal(stepDuration(60, 1), 1); // quarters at 60 BPM
  assert.equal(stepDuration(90, 4), 60 / 360);
});

test("stepDuration clamps absurd tempi rather than dividing by zero", () => {
  assert.ok(stepDuration(0, 4) > 0, "0 BPM must clamp, not produce Infinity");
  assert.ok(Number.isFinite(stepDuration(100000, 4)));
  assert.throws(() => stepDuration("fast", 4), /must be a finite number/);
});

test("stepsInWindow emits steps inside the lookahead and advances the cursor", () => {
  assert.deepEqual(stepsInWindow(0, 0, 0.125, 0.1), { times: [0], cursor: 0.125 });
  assert.deepEqual(stepsInWindow(0.2, 0.125, 0.125, 0.1), { times: [0.125, 0.25], cursor: 0.375 });
});

test("stepsInWindow NEVER re-emits an already-scheduled step", () => {
  // The edge-trigger rule. Level-triggered scheduling double-fires whenever
  // the timer jitters, which is a drum machine that stutters at random.
  const first = stepsInWindow(0, 0, 0.125, 0.1);
  const second = stepsInWindow(0, first.cursor, 0.125, 0.1);
  for (const time of second.times) {
    assert.ok(!first.times.includes(time), `step at ${time} was emitted twice`);
  }
  // Ticking repeatedly without time advancing must eventually emit nothing.
  let cursor = 0;
  for (let i = 0; i < 10; i++) cursor = stepsInWindow(0, cursor, 0.125, 0.1).cursor;
  assert.deepEqual(stepsInWindow(0, cursor, 0.125, 0.1).times, []);
});

test("stepsInWindow is bounded — a pathological tempo cannot allocate forever", () => {
  const result = stepsInWindow(0, 0, 1e-9, 10);
  assert.ok(result.times.length <= 256, `emitted ${result.times.length}, expected a hard cap`);
});

test("scheduled steps are evenly spaced", () => {
  const { times } = stepsInWindow(0, 0, 0.1, 1);
  for (let i = 1; i < times.length; i++) {
    assert.ok(Math.abs(times[i] - times[i - 1] - 0.1) < 1e-9, "uneven step spacing");
  }
});

console.log("synth: Schmitt trigger (the Axoloti ruling)");

test("hysteresis band is real — low threshold is below high", () => {
  assert.ok(SCHMITT_LOW < SCHMITT_HIGH, "without a gap there is no hysteresis, only a comparator");
});

test("a rising edge fires exactly once", () => {
  let state = false;
  const result = schmittStep(0.6, state);
  assert.equal(result.fired, true);
  state = result.armed;
  // Staying high must NOT re-fire — that is the difference between a trigger
  // and a machine gun.
  assert.equal(schmittStep(0.8, state).fired, false);
  assert.equal(schmittStep(1.0, state).fired, false);
});

test("the dead band rejects noise between the thresholds", () => {
  // A signal wobbling inside the band must produce NO events at all. This is
  // the entire reason hysteresis exists.
  let armed = true;
  const wobble = [0.45, 0.2, 0.4, 0.15, 0.3, 0.49];
  for (const value of wobble) {
    const result = schmittStep(value, armed);
    assert.equal(result.fired, false, `noise at ${value} must not fire`);
    assert.equal(result.armed, true, `noise at ${value} must not disarm`);
    armed = result.armed;
  }
});

test("the detector rearms only after falling below the low threshold", () => {
  let armed = schmittStep(0.9, false).armed;
  assert.equal(schmittStep(0.3, armed).armed, true, "0.3 is inside the band, still armed");
  armed = schmittStep(0.05, armed).armed;
  assert.equal(armed, false, "below SCHMITT_LOW must disarm");
  assert.equal(schmittStep(0.6, armed).fired, true, "and then it can fire again");
});

test("a slow noisy ramp fires ONCE, not dozens of times", () => {
  // The realistic failure: a control signal creeping upward with ripple on it.
  // A single-threshold comparator fires on every wiggle across the threshold.
  let armed = false;
  let fireCount = 0;
  for (let i = 0; i < 200; i++) {
    const ramp = i / 200;
    const ripple = Math.sin(i * 1.7) * 0.04;
    const result = schmittStep(ramp + ripple, armed);
    if (result.fired) fireCount++;
    armed = result.armed;
  }
  assert.equal(fireCount, 1, `noisy ramp fired ${fireCount} times, expected exactly 1`);
});

console.log("synth: rewire ramp timing");

test("the rewire ramp is short enough to be imperceptible, long enough to be smooth", () => {
  // Too long and rewiring audibly ducks the patch; too short and the ramp is
  // itself a fast edge, which is the click it exists to prevent.
  assert.ok(REWIRE_RAMP_SECONDS > 0.002, "shorter than ~2ms is effectively a step");
  assert.ok(REWIRE_RAMP_SECONDS < 0.02, "longer than ~20ms reads as a level move");
});

test("rampSettleSeconds leaves a negligible remainder", () => {
  const settle = rampSettleSeconds(REWIRE_RAMP_SECONDS);
  const timeConstants = settle / REWIRE_RAMP_SECONDS;
  const remaining = Math.exp(-timeConstants);
  assert.ok(remaining < 0.02, `${(remaining * 100).toFixed(1)}% of the signal remains — too much to switch under`);
});

console.log("synth: the module registry");

test("every registered module is a factory function", () => {
  for (const [type, factory] of Object.entries(MODULE_FACTORIES)) {
    assert.equal(typeof factory, "function", `${type} is not a factory`);
  }
});

test("the blueprint's MODULE SET v1 is all present", () => {
  // Named individually rather than counted, so a rename cannot pass by
  // accident and the failure says WHICH module went missing.
  const required = [
    "output", "oscillator", "supersaw", "noise", "filter", "adsr", "vca", "mixer",
    "lfo", "delay", "reverb", "bitcrush", "quantize", "eq3", "clock", "trigger",
    "sequencer", "sampler", "meter", "spectrum", "ding", "pad",
  ];
  for (const type of required) {
    assert.ok(MODULE_FACTORIES[type], `blueprint module ${JSON.stringify(type)} is missing`);
  }
  assert.equal(required.length, 22, "the blueprint enumerates 22 modules");
  // sampleHold is the 23rd: the blueprint's implementation law requires the
  // worklet, and a processor no patch can reach would be dead code.
  assert.ok(MODULE_FACTORIES.sampleHold, "sampleHold must be reachable as a module");
  // A FLOOR, NOT A CEILING (BV, 2026-08-03). This asserted `=== 23` and went red
  // when the poly pad landed — the same "exactly-pinned roster punishes the
  // deliverable" trap wave 3 recorded for the patch list. The blueprint's claim
  // is that every module it named EXISTS, which the loop above checks by name
  // (so a rename still fails, and says which one). That a later wave ADDED a
  // module is not a violation of the blueprint; it is the project working.
  assert.ok(moduleTypes().length >= required.length + 1,
    "every blueprint module plus sampleHold must be registered");
});

test("IMPLEMENTATION covers every module exactly", () => {
  // The native/worklet split is a documented claim; this is what stops it
  // rotting into a lie as modules are added.
  const types = moduleTypes().sort();
  assert.deepEqual(Object.keys(IMPLEMENTATION).sort(), types);
  for (const [type, kind] of Object.entries(IMPLEMENTATION)) {
    assert.ok(kind === "native" || kind === "worklet", `${type} has bogus implementation ${kind}`);
  }
});

test("NATIVE FIRST is actually honored — the hand-written worklet list is exactly the five", () => {
  // The implementation law. Worklets are the documented exception list, so a
  // sixth appearing silently would mean someone reached for JS DSP where a
  // native node exists.
  //
  // THE LAW IS ABOUT MODULES WE DESIGNED, so the R7-17 port blocks are excluded — and
  // by DERIVATION from PORT_BLOCK_MODULES, never by name. A ported node reproduces a
  // fixed-point Axoloti kernel sample by sample; "which native AudioNode would have
  // done?" has no answer for `filter/vcf3`, so reaching for JS DSP there is not the
  // choice this test polices. What still must hold for them is asserted right below:
  // every ported module IS a worklet, so the exclusion cannot become a place to park
  // an unclassified module.
  const ported = new Set(PORT_BLOCK_MODULES);
  for (const type of ported)
    assert.equal(IMPLEMENTATION[type], "worklet", `ported module ${type} must be classified worklet`);
  const worklets = moduleTypes().filter((type) => !ported.has(type) && IMPLEMENTATION[type] === "worklet").sort();
  // `surge` IS ON THIS LIST AND IS THE ONE ENTRY THE LAW ABOVE DOES NOT REACH.
  // The law asks "would a native AudioNode have done?" and answers it for modules WE
  // designed — the four beside it are small DSP we chose to write in JS. Surge is a
  // 5.4 MB compiled synthesizer: there is no native node that is Surge, so the
  // question has the same non-answer it has for a ported Axoloti kernel. It is not
  // excluded by `ported` because it is genuinely not one of the R7-17 port blocks
  // (see synth/modules_surge.js's BLOCK_WORKLET_MODULES note), so it is named here
  // instead — deliberately, so that adding it had to be a decision someone wrote
  // down rather than a list that quietly grew.
  assert.deepEqual(worklets, ["adsr", "bitcrush", "quantize", "sampleHold", "surge", "trigger"]);
  // THE LAW IS THE WORKLET LIST, which the deepEqual above pins EXACTLY: a sixth
  // worklet appearing is the violation worth catching, and it still fails here.
  // "Native" is that list's complement, so a hard native count adds nothing and
  // merely reds every wave that lands a new native module (it did, when the poly
  // pad landed). What is still worth asserting is that every module has an
  // opinion — no module falls outside the split.
  // (Stated as "nothing is unclassified" rather than "native + worklet = total": with
  // the ported blocks excluded from `worklets` above, a sum no longer reaches the
  // total, and rebuilding the total from three parts would just re-derive line 408.)
  const unclassified = moduleTypes().filter((type) => IMPLEMENTATION[type] !== "native" && IMPLEMENTATION[type] !== "worklet");
  assert.deepEqual(unclassified, [], "every module must be classified native or worklet");
});

console.log("synth: worklet / dsp constant agreement");

test("the worklet restates the Schmitt constants IDENTICALLY", () => {
  // The AudioWorklet global scope cannot import, so processors.js restates
  // SCHMITT_LOW/HIGH. That duplication is deliberate and documented — this is
  // the assertion that stops it drifting into two different trigger behaviors
  // between the tested state machine and the one that actually runs.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../synth/worklets/processors.js"), "utf8");

  const low = source.match(/const SCHMITT_LOW = ([\d.]+);/);
  const high = source.match(/const SCHMITT_HIGH = ([\d.]+);/);
  assert.ok(low, "processors.js must declare SCHMITT_LOW");
  assert.ok(high, "processors.js must declare SCHMITT_HIGH");
  assert.equal(Number(low[1]), SCHMITT_LOW, "worklet SCHMITT_LOW disagrees with dsp.js");
  assert.equal(Number(high[1]), SCHMITT_HIGH, "worklet SCHMITT_HIGH disagrees with dsp.js");
});

test("every worklet processor named by the engine is actually registered", () => {
  // A typo in a registerProcessor name is invisible until the module is
  // instantiated in a browser, where it throws from a constructor.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../synth/worklets/processors.js"), "utf8");
  for (const name of [
    "bitcrush-processor", "quantize-processor", "adsr-processor",
    "sample-hold-processor", "trigger-processor",
  ]) {
    assert.ok(
      source.includes(`registerProcessor("${name}"`),
      `processors.js does not register ${name}`,
    );
  }
});

console.log("synth: the ENGINE law (zero PowerRP imports)");

test("no synth file imports PowerRP", () => {
  // The blueprint's hard architectural boundary: PowerRP controls the synth,
  // the synth never reaches back. A single convenience import from core/ would
  // make the library non-portable and is exactly the kind of thing that gets
  // added without thinking.
  // ── THE ROSTER IS WALKED FROM DISK, NOT LISTED ───────────────────────────────
  // It WAS a hard-coded list of five filenames, and that made **every synth file
  // added after it exempt from this law by default** — found 2026-08-06 by the AX-1
  // port agent, which broke the law (`synth/modules_ax1.js` imported
  // `core/audio_specs_ax1.js`) and was not caught, while two more agents were
  // adding synth files under the same blind spot. A hand-maintained list mirroring
  // a directory's contents is the Tower-of-Babel shape this project keeps finding:
  // the mirror does not fail when it drifts, it just stops checking.
  //
  // So the roster is DERIVED — every `.js` under synth/, recursively. A new file is
  // covered the moment it exists, which is the only way an architectural law with a
  // growing surface stays true.
  const here = dirname(fileURLToPath(import.meta.url));
  const synthRoot = join(here, "../synth");
  const synthFiles = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".js")) synthFiles.push(`${prefix}${entry.name}`);
    }
  };
  walk(synthRoot, "");
  assert.ok(synthFiles.length >= 5, `expected to find synth files on disk, found ${synthFiles.length}`);
  for (const file of synthFiles) {
    const source = readFileSync(join(synthRoot, file), "utf8");
    const imports = [...source.matchAll(/^\s*import\s.*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith("./") || specifier.startsWith("node:"),
        `synth/${file} imports ${JSON.stringify(specifier)} — the synth must not reach outside itself`,
      );
      assert.ok(
        !specifier.includes(".."),
        `synth/${file} imports ${JSON.stringify(specifier)} — that escapes the synth directory`,
      );
    }
  }
});

test("synth/dsp.js is DOM-free (it must run in bare node)", () => {
  // It just did — this file imported it — but an explicit check names the rule
  // so a future window/document reference fails with an explanation.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../synth/dsp.js"), "utf8");
  for (const forbidden of ["window.", "document.", "navigator."]) {
    assert.ok(!source.includes(forbidden), `dsp.js references ${forbidden} — it must stay DOM-free`);
  }
});

console.log(`\n${passed} synth assertions passed.`);
