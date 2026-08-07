/**
 * js_side.mjs — RUN THE SHIPPED AUDIOWORKLET PROCESSORS IN BARE NODE.
 *
 * Not the kernels: THE PROCESSORS. `tests/port_ax*_test.js` already exercise the
 * kernel functions against a hand-written integer model, and that is precisely
 * the thing this harness exists to stop trusting. Driving the registered
 * processor instead means the k-rate tick scheduling, the a-rate parameter
 * sampling and the option plumbing are all under test too — those are where a
 * "correct kernel" still produces a wrong sound (an LFO running 8x slow because
 * the tick was hoisted to the 128-frame quantum is the canonical example, and it
 * is invisible to a kernel-level test).
 *
 * The AudioWorklet globals are the only things shimmed, and they are shimmed to
 * their spec behaviour, not to something convenient.
 *
 * Command (mutates the module registry the first time it is called).
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The app root, four levels up from `.frenzy/round7/faithfulness_axo/harness`. */
export const APP_ROOT = resolve(HERE, "../../../..");

/** WebAudio's fixed render quantum. Not Axoloti's 16 — see BUFSIZE in runner.mjs. */
export const QUANTUM = 128;

const REGISTRY = new Map();
let loaded = false;

/**
 * Command. Install the AudioWorklet globals and evaluate every processor file.
 * Idempotent.
 *
 * @param {number} [rate=48000] - the `sampleRate` the processors will see
 * @returns {Promise<Map<string, Function>>} registered name -> processor class
 */
export async function loadProcessors(rate = 48000) {
  if (loaded) return REGISTRY;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage() {}, onmessage: null };
    }
  };
  globalThis.registerProcessor = (name, cls) => {
    if (REGISTRY.has(name)) throw new Error(`duplicate registerProcessor(${name})`);
    REGISTRY.set(name, cls);
  };
  globalThis.sampleRate = rate;
  globalThis.currentTime = 0;
  globalThis.currentFrame = 0;
  const dir = join(APP_ROOT, "synth/worklets");
  for (const f of ["processors_ax1.js", "processors_ax2.js", "processors_ax3.js", "processors_ax4.js"]) {
    await import(join(dir, f));
  }
  loaded = true;
  return REGISTRY;
}

/**
 * Command. Render `frames` samples from one registered processor.
 *
 * @param {Object} spec
 *   `{name, processorOptions?, options?, params: {n: number|(i)=>number},
 *     inputs?: Array<Array<Float32Array>>|((quantum, i) => number),
 *     outputChannels?, outputPorts?}`
 * @param {number} frames - total samples to render (rounded up to a quantum)
 * @returns {Object<string, Float64Array>} one entry per output port index
 *
 * PARAMS ARE A-RATE HERE, ALWAYS: every descriptor in this codebase declares
 * `automationRate: "a-rate"`, so a k-rate stand-in would sample the wrong grid.
 * A constant is expanded to a full 128-length array rather than the 1-length
 * array WebAudio is allowed to pass, because several processors index
 * `param[i]` through `axParamAt`, and passing length 1 would hide a bug in that
 * helper rather than exercise it.
 */
export function renderProcessor(Cls, spec, frames) {
  const quanta = Math.ceil(frames / QUANTUM);
  const proc = new Cls({ processorOptions: spec.processorOptions ?? {} });
  // THE MESSAGE SHAPE IS NOT UNIFORM ACROSS THE FOUR WORKLET FILES and a message
  // a processor does not recognise is SILENTLY IGNORED — there is no handshake.
  // AX-2/AX-4 read `{option, value}`; AX-1's math and logic read `{operation}`;
  // AX-1's convert and AX-3's one-pole read `{mode}`. Sending only one shape left
  // `ax1-math` on its default `multiply` for every case, so `math/abs` compared
  // |x| against a passthrough and read as a total mismatch. Until the processors
  // agree on one shape, the harness sends every shape and names the option as its
  // own key too, so whichever key a processor looks for is present.
  for (const [option, value] of Object.entries(spec.options ?? {})) {
    if (!proc.port.onmessage) throw new Error(`${spec.name}: options given but the processor installed no onmessage`);
    proc.port.onmessage({ data: { option, value, [option]: value, mode: value, operation: value } });
  }
  const descriptors = Cls.parameterDescriptors ?? [];
  const paramArrays = {};
  for (const d of descriptors) paramArrays[d.name] = new Float32Array(QUANTUM);

  const nOutPorts = spec.outputPorts ?? 1;
  const nOutCh = spec.outputChannels ?? 1;
  const outputs = [];
  for (let p = 0; p < nOutPorts; p++) {
    const ch = [];
    for (let c = 0; c < nOutCh; c++) ch.push(new Float32Array(QUANTUM));
    outputs.push(ch);
  }
  // INPUTS ARE PORTS, NOT CHANNELS. The AX-4 wrapper reads `inputs[a][0][i]`
  // with `a` indexing its `audioInputs` list, so a mixer's six sources are six
  // INPUT PORTS. Modelling them as channels of one port would silently feed
  // every AX-4 node zero on every input but the first.
  const nInPorts = spec.inputPorts ?? 1;
  const inputs = [];
  for (let a = 0; a < nInPorts; a++) inputs.push([new Float32Array(QUANTUM)]);

  const collected = [];
  for (let p = 0; p < nOutPorts; p++) {
    const ch = [];
    for (let c = 0; c < nOutCh; c++) ch.push(new Float64Array(quanta * QUANTUM));
    collected.push(ch);
  }

  for (let q = 0; q < quanta; q++) {
    for (const d of descriptors) {
      const src = spec.params?.[d.name];
      const value = src === undefined ? d.defaultValue : src;
      for (let i = 0; i < QUANTUM; i++) {
        paramArrays[d.name][i] = typeof value === "function" ? value(q * QUANTUM + i) : value;
      }
    }
    if (spec.input) {
      for (let a = 0; a < nInPorts; a++) {
        for (let i = 0; i < QUANTUM; i++) inputs[a][0][i] = spec.input(q * QUANTUM + i, a);
      }
    }
    proc.process(inputs, outputs, paramArrays);
    for (let p = 0; p < nOutPorts; p++) {
      for (let c = 0; c < nOutCh; c++) collected[p][c].set(outputs[p][c], q * QUANTUM);
    }
  }
  const out = {};
  for (let p = 0; p < nOutPorts; p++) {
    for (let c = 0; c < nOutCh; c++) out[nOutCh === 1 ? `p${p}` : `p${p}c${c}`] = collected[p][c].subarray(0, frames);
  }
  return out;
}
