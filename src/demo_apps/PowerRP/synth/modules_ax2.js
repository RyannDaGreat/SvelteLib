/**
 * THE AX-2 MODULE FACTORIES — ten Axoloti nodes as engine modules.
 *
 * ── WHY THIS FILE IS SHORT ──────────────────────────────────────────────────
 * modules.js's twenty-three factories each build a different graph of native
 * AudioNodes, so each is its own function. These ten are the SAME graph — one
 * AudioWorkletNode, one tap gain per output port — differing only in a processor
 * name, a param list and an output list. All three of those are already declared
 * once, in `worklets/processors_ax2.js`'s `AX2_PROCESSORS`, because the worklet
 * needs them too. So this file DERIVES its factories from that array rather than
 * restating any of it: rename a param there and both halves move together.
 *
 * That is the one rule the brief names as the commonest local failure — a
 * hand-maintained list mirroring another module's shape — and the reason the
 * roster lives in the worklet file rather than here is simply that the worklet
 * cannot import from the main thread's side while the reverse is fine.
 *
 * ── THE UNIFORM SHAPE, AS modules.js DEFINES IT ─────────────────────────────
 * `(context, params) -> {inputs, outputs, params, start, dispose, meta}`. The
 * engine never special-cases a module type, so nothing here is special either.
 *
 * ── ONE TAP GAIN PER OUTPUT, AND WHY ────────────────────────────────────────
 * `outputs` must map a port NAME to an AudioNode, but an AudioWorkletNode with
 * two outputs distinguishes them by INDEX (`node.connect(dest, 1)`). A one-gain
 * tap per output turns an index into a node, which is what lets `lfo`'s `sync`
 * and `phasor`'s `180°` be ports at all. Uniform across all ten rather than only
 * the two that need it: a shape that differs per module is a shape that drifts.
 *
 * ── THE KNOB KINDS, AND WHICH ROUTE EACH TAKES ──────────────────────────────
 *   a-rate AudioParam  every wireable control (pitch, trig, decay …). Appears in
 *                      BOTH `inputs` and `params`, which is what makes "a knob
 *                      or an input, your choice" true with no duplicated node.
 *   option setter      a discrete or list-valued knob (waveform, colour,
 *                      octaves). No AudioParam exists for a string, so it is a
 *                      plain function — engine.setParam already calls those.
 *                      Sent by `port.postMessage`, applied on the audio thread.
 *   construct          `seed` alone. It IS the generator's initial state, so
 *                      there is nothing to set later; the spec marks it
 *                      `construct: true` and the mirror rebuilds the module.
 *
 * Zero PowerRP imports (the ENGINE law).
 */

import { AX2_PROCESSORS } from "./worklets/processors_ax2.js";
import { clampParam } from "./dsp.js";

/**
 * Pure function. The message a discrete/list knob's setter posts. Named so the
 * wire format has one definition rather than an object literal at the call site.
 *
 * @param {string} option - the knob key, e.g. "waveform"
 * @param {string|number} value - the new value
 * @returns {{option: string, value: string|number}}
 *
 * @example ax2OptionMessage("waveform", "saw") // {option: "waveform", value: "saw"}
 */
export function ax2OptionMessage(option, value) {
  return { option, value };
}

/**
 * Pure function. The `processorOptions` for one module: its construct-time knobs
 * picked out of the caller's params, and nothing else.
 *
 * A missing one is LEFT OUT rather than defaulted here — the kernel's own
 * constructor states its default once, and a second default in this file would
 * be a place for the two to disagree.
 *
 * @param {string[]} construct - the row's construct-time knob names
 * @param {object} params - the caller's initial params
 * @returns {object}
 *
 * @example ax2ConstructOptions(["seed"], {seed: 12, colour: "pink"}) // {seed: 12}
 * @example ax2ConstructOptions(["seed"], {}) // {}
 */
export function ax2ConstructOptions(construct, params) {
  const options = {};
  for (const name of construct) {
    if (params[name] !== undefined) options[name] = params[name];
  }
  return options;
}

/**
 * Build one module factory from a roster row.
 *
 * Command-producing (the returned factory constructs AudioNodes). Untested as a
 * unit — the module SHAPE it produces is exercised by tests/port_ax2_test.js
 * only through the roster it reads; the kernels underneath carry the numeric
 * proof, and the graph is one node plus N gains.
 *
 * @param {object} row - an AX2_PROCESSORS entry
 * @returns {function(BaseAudioContext, object): object} an engine module factory
 */
function ax2Module(row) {
  return function factory(context, params = {}) {
    const node = new AudioWorkletNode(context, row.name, {
      numberOfInputs: 0,
      numberOfOutputs: row.outputs.length,
      outputChannelCount: row.outputs.map(() => 1),
      processorOptions: ax2ConstructOptions([...row.construct, ...row.options], params),
    });

    const inputs = {};
    const knobs = {};
    for (const descriptor of row.params) {
      const param = node.parameters.get(descriptor.name);
      if (!param) throw new Error(`${row.name} has no AudioParam ${JSON.stringify(descriptor.name)}`);
      if (params[descriptor.name] !== undefined) {
        param.value = clampParam(params[descriptor.name], param.minValue, param.maxValue, `${row.module}.${descriptor.name}`);
      }
      inputs[descriptor.name] = param;
      knobs[descriptor.name] = param;
    }

    // An option KNOWN AT BUILD went into `processorOptions` above, because a
    // message posted at construction can lose the race with the first
    // `process()` — measured, see processors_ax2.js. Only LIVE changes go by
    // message. RESIDUAL, and it is the mirror's shape rather than this file's:
    // web/audioMirror.svelte.js passes only CONSTRUCT params to addModule and
    // pushes live knobs immediately after, so a discrete knob still arrives one
    // render quantum (~2.7 ms) after the node starts. That window plays the
    // kernel's own default, not silence and not a wrong value forever.
    for (const option of row.options) {
      knobs[option] = (value) => node.port.postMessage(ax2OptionMessage(option, value));
    }

    const taps = row.outputs.map((_, index) => {
      const tap = context.createGain();
      node.connect(tap, index);
      return tap;
    });
    const outputs = {};
    row.outputs.forEach((name, index) => { outputs[name] = taps[index]; });

    return {
      inputs,
      outputs,
      params: knobs,
      start() {},
      dispose() {
        node.disconnect();
        for (const tap of taps) tap.disconnect();
      },
      meta: { kind: row.module, label: row.label },
    };
  };
}

/**
 * THE AX-2 MODULE REGISTRY — module type name -> factory, derived from the
 * roster so it cannot list a module the worklet does not register.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   synth/modules.js   `MODULE_FACTORIES` must spread `BLOCK_MODULE_FACTORIES`
 *   synth/engine.js    a second `addModule(AX2_WORKLET_URL)` in `init()`, and
 *                      `WORKLET_MODULES` must gain these ten keys — every one of
 *                      them builds an AudioWorkletNode, so without that an
 *                      un-awaited `engine.init()` fails inside a constructor
 *                      instead of with the sentence that names the problem.
 */
export const BLOCK_MODULE_FACTORIES = Object.fromEntries(
  AX2_PROCESSORS.map((row) => [row.module, ax2Module(row)]),
);

/** Query. The AX-2 module type names — what `WORKLET_MODULES` must contain. */
export function ax2ModuleTypes() {
  return Object.keys(BLOCK_MODULE_FACTORIES);
}

/** The block's processor module. See core/audio_blocks.js for the PORT-BLOCK CONTRACT. */
// BLOCK_WORKLET_URL moved to synth/worklet_urls.js — see that file: a Vite
// `?worker&url` specifier here would make this module un-importable by bare node.
/** The types whose factory builds an AudioWorkletNode — all ten of this block's. */
export const BLOCK_WORKLET_MODULES = ax2ModuleTypes();
