/**
 * THE VC-5 MODULE FACTORIES — nine ported VCV Rack modules as engine modules.
 *
 * ── WHY THIS FILE IS SHORT ──────────────────────────────────────────────────
 * modules.js's factories each build a different graph of native AudioNodes, so
 * each is its own function. These nine are the SAME graph — one AudioWorkletNode,
 * one tap gain per output port — differing only in a processor name, a param list,
 * an audio-input list and an output list. All four of those are declared ONCE, in
 * `worklets/processors_vc5.js`'s `VC5_PROCESSORS`, because the worklet needs them
 * too. So this file DERIVES its factories from that array rather than restating
 * any of it: rename a param there and both halves move together.
 *
 * That is the rule the brief names as this project's commonest failure — a
 * hand-maintained list mirroring another module's shape — and the roster lives in
 * the worklet file rather than here simply because the worklet cannot import from
 * the main thread's side while the reverse is fine.
 *
 * ── THE UNIFORM SHAPE, AS modules.js DEFINES IT ─────────────────────────────
 * `(context, params) -> {inputs, outputs, params, start, dispose, meta}`. The
 * engine never special-cases a module type, so nothing here is special either.
 *
 * ── AUDIO INPUTS BY INDEX, WHICH AX-1/2/3 DID NOT NEED ──────────────────────
 * AX-2's ten modules are all sources (`numberOfInputs: 0`) and AX-3's nine filters
 * have exactly one input, so both could write `inputs: {in: node}`. Seven of these
 * nine take TWO OR MORE audio inputs — Plateau's L/R, JustAPhaser's L/R plus two
 * feedback returns, SPF's three numerators — and an AudioWorkletNode distinguishes
 * its inputs by INDEX. The engine already supports `{node, index}` on an input
 * (synth/engine.js's target resolution, and `sampleHoldModule` is the precedent),
 * so an audio port maps to that pair and a param port maps to the AudioParam.
 *
 * ── ONE TAP GAIN PER OUTPUT, AND WHY ────────────────────────────────────────
 * `outputs` must map a port NAME to an AudioNode, but an AudioWorkletNode with
 * several outputs distinguishes them by index. A one-gain tap per output turns an
 * index into a node, which is what lets Terrorform's six taps and Feline's `sum`
 * be ports at all. Uniform across all nine rather than only the seven that need
 * it: a shape that differs per module is a shape that drifts.
 *
 * ── THE KNOB KINDS, AND WHICH ROUTE EACH TAKES ──────────────────────────────
 *   a-rate AudioParam  every wireable control. Appears in BOTH `inputs` and
 *                      `params`, which is what makes "a knob or an input, your
 *                      choice" true with no duplicated node.
 *   option setter      a discrete or list-valued knob (a filter mode, a wave
 *                      name, a clock division). No AudioParam exists for a string,
 *                      so it is a plain function — engine.setParam already calls
 *                      those. Sent by `port.postMessage`, applied on the audio
 *                      thread.
 *   construct          a seed, Terrorform's `bank` (128 KB of table generation)
 *                      and XFX F-35's `oversample` (two FIR buffers). The spec
 *                      marks these `construct: true` and the mirror rebuilds.
 *
 * Zero PowerRP imports (the ENGINE law).
 */

import { VC5_PROCESSORS } from "./worklets/processors_vc5.js";
import { clampParam } from "./dsp.js";

/**
 * Pure function. The message a discrete/list knob's setter posts. Named so the
 * wire format has one definition rather than an object literal at the call site.
 *
 * @param {string} option - the knob key, e.g. "mode"
 * @param {string|number} value - the new value
 * @returns {{option: string, value: string|number}}
 *
 * @example vc5OptionMessage("mode", "tape") // {option: "mode", value: "tape"}
 */
export function vc5OptionMessage(option, value) {
  return { option, value };
}

/**
 * Pure function. The `processorOptions` for one module: its construct-time and
 * option knobs picked out of the caller's params, and nothing else.
 *
 * A missing one is LEFT OUT rather than defaulted here — the kernel's own
 * constructor states its default once, and a second default in this file would be
 * a place for the two to disagree.
 *
 * @param {string[]} names - the row's construct + option knob names
 * @param {object} params - the caller's initial params
 * @returns {object}
 *
 * @example vc5ConstructOptions(["seed", "bank"], {seed: 12, wave: 0.5}) // {seed: 12}
 * @example vc5ConstructOptions(["seed"], {}) // {}
 */
export function vc5ConstructOptions(names, params) {
  const options = {};
  for (const name of names) {
    if (params[name] !== undefined) options[name] = params[name];
  }
  return options;
}

/**
 * Build one module factory from a roster row.
 *
 * Command-producing (the returned factory constructs AudioNodes). Untested as a
 * unit — the module SHAPE it produces is exercised by tests/port_vc5_test.js only
 * through the roster it reads; the kernels underneath carry the numeric proof, and
 * the graph is one node plus N gains.
 *
 * @param {object} row - a VC5_PROCESSORS entry
 * @returns {function(BaseAudioContext, object): object} an engine module factory
 */
function vc5Module(row) {
  return function factory(context, params = {}) {
    const node = new AudioWorkletNode(context, row.name, {
      // An AudioWorkletNode with zero inputs is legal and is what the three
      // sources here want; `Math.max(…, 1)` would give them a phantom input.
      numberOfInputs: row.audio.length,
      numberOfOutputs: row.outputs.length,
      outputChannelCount: row.outputs.map(() => 1),
      processorOptions: vc5ConstructOptions([...row.construct, ...row.options], params),
    });

    const inputs = {};
    const knobs = {};
    // AUDIO PORTS FIRST, so a port name collision between an audio input and a
    // param would be caught by the param loop's overwrite rather than hidden.
    // tests/port_vc5_test.js asserts no such collision exists.
    row.audio.forEach((name, index) => { inputs[name] = { node, index }; });

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
      knobs[option] = (value) => node.port.postMessage(vc5OptionMessage(option, value));
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
        node.port.onmessage = null;
        node.disconnect();
        for (const tap of taps) tap.disconnect();
      },
      meta: { kind: row.module, label: row.label },
    };
  };
}

/**
 * THE VC-5 MODULE REGISTRY — module type name -> factory, derived from the roster
 * so it cannot list a module the worklet does not register.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   synth/modules.js        `MODULE_FACTORIES` must spread `BLOCK_MODULE_FACTORIES`
 *   synth/worklet_urls.js   one `?worker&url` line for this block's processor
 *   core/audio_blocks.js    spread `BLOCK_SPECS` and register the URL + modules
 *   plugins/audio_index.js  spread `BLOCK_PLUGINS`
 */
export const BLOCK_MODULE_FACTORIES = Object.fromEntries(
  VC5_PROCESSORS.map((row) => [row.module, vc5Module(row)]),
);

/** Query. The VC-5 module type names — what the engine's `WORKLET_MODULES` gate
 *  must contain. Every one of these builds an AudioWorkletNode, so without that
 *  an un-awaited `engine.init()` fails inside a constructor instead of with the
 *  sentence that names the problem. */
export function vc5ModuleTypes() {
  return Object.keys(BLOCK_MODULE_FACTORIES);
}

/** The types whose factory builds an AudioWorkletNode — all nine of this block's.
 *  AN ARRAY, NOT A Set: the PORT-BLOCK CONTRACT (core/audio_blocks.js) declares
 *  this name `array`, AX-3 shipped a Set and it was swept back. */
export const BLOCK_WORKLET_MODULES = vc5ModuleTypes();
