/**
 * THE VC-1 MODULE FACTORIES — the AudibleInstruments nodes as engine modules.
 *
 * ── WHY THIS FILE IS SHORT ──────────────────────────────────────────────────
 * Every node in this block is the SAME graph: one AudioWorkletNode, one tap gain per
 * output port. What differs is a processor name, a param list, an audio-input list and an
 * output list — all four of which are already declared ONCE, in
 * `worklets/processors_vc1.js`'s `VC1_PROCESSORS`, because the worklet needs them too. So
 * this file DERIVES its factories from that array rather than restating any of it: rename
 * a param there and both halves move together. That is the rule the round's brief names as
 * the commonest local failure — a hand-maintained list mirroring another module's shape —
 * and the roster lives in the worklet file rather than here simply because the worklet
 * cannot import from the main thread's side while the reverse is fine.
 *
 * ── THE UNIFORM SHAPE, AS modules.js DEFINES IT ─────────────────────────────
 * `(context, params) -> {inputs, outputs, params, start, dispose, meta}`. The engine never
 * special-cases a module type, so nothing here is special either.
 *
 * ── ONE TAP GAIN PER OUTPUT, AND WHY ────────────────────────────────────────
 * `outputs` must map a port NAME to an AudioNode, but an AudioWorkletNode with several
 * outputs distinguishes them by INDEX. A one-gain tap per output turns an index into a
 * node, which is what lets Rings' `odd`/`even` and Blinds' five outputs be ports at all.
 * Uniform across every row rather than only the ones that need it: a shape that differs
 * per module is a shape that drifts.
 *
 * ── AUDIO INPUTS GO BACK AS `{node, index}`, WHICH IS NOT A NEW SEAM ────────
 * Several rows here take more than one audio port (Clouds' L and R, Blinds' four in/cv
 * pairs). `engine.resolvePort` already accepts `{node, index}` for an input — it was built
 * for sample&hold's trigger input — so a multi-input worklet needs no engine change and
 * this file adds no third shape.
 *
 * ── THE KNOB KINDS, AND WHICH ROUTE EACH TAKES ──────────────────────────────
 *   a-rate AudioParam  every wireable control. Appears in BOTH `inputs` and `params`,
 *                      which is what makes "a knob or an input, your choice" true with no
 *                      duplicated node.
 *   option setter      a discrete knob (playback, model, polyphony …). No AudioParam
 *                      exists for a string, so it is a plain function — engine.setParam
 *                      already calls those. Sent by `port.postMessage`.
 *   construct          `seed` and Clouds' `quality`, which SIZES THE RECORDING BUFFER.
 *                      Both are marked `construct: true` in the spec and the mirror
 *                      rebuilds the module.
 *
 * Zero PowerRP imports (the ENGINE law).
 */

import { VC1_PROCESSORS, vc1OptionMessage } from "./worklets/processors_vc1.js";
import { clampParam } from "./dsp.js";

/**
 * Pure function. The `processorOptions` for one module: its construct-time and discrete
 * knobs picked out of the caller's params, and nothing else.
 *
 * A missing one is LEFT OUT rather than defaulted here — the kernel's own constructor
 * states its default once, and a second default in this file would be a place for the two
 * to disagree.
 *
 * @param {string[]} names - the row's construct-time and option knob names
 * @param {object} params - the caller's initial params
 * @returns {object}
 *
 * @example vc1ConstructOptions(["seed", "quality"], {seed: 7, position: 0.5}) // {seed: 7}
 * @example vc1ConstructOptions(["seed"], {}) // {}
 */
export function vc1ConstructOptions(names, params) {
  const options = {};
  for (const name of names) {
    if (params[name] !== undefined) options[name] = params[name];
  }
  return options;
}

/**
 * Build one module factory from a roster row.
 *
 * Command-producing (the returned factory constructs AudioNodes). Untested as a unit — the
 * module SHAPE it produces is exercised by `tests/port_vc1_test.js` through the roster it
 * reads; the kernels underneath carry the numeric proof, and the graph is one node plus N
 * gains.
 *
 * @param {object} row - a VC1_PROCESSORS entry
 * @returns {function(BaseAudioContext, object): object} an engine module factory
 */
function vc1Module(row) {
  return function factory(context, params = {}) {
    const node = new AudioWorkletNode(context, row.name, {
      numberOfInputs: row.audioInputs.length,
      numberOfOutputs: row.outputs.length,
      outputChannelCount: row.outputs.map(() => 1),
      processorOptions: vc1ConstructOptions([...row.construct, ...row.options], params),
    });

    const inputs = {};
    const knobs = {};
    for (const descriptor of row.params) {
      const param = node.parameters.get(descriptor.name);
      if (!param) throw new Error(`${row.name} has no AudioParam ${JSON.stringify(descriptor.name)}`);
      if (params[descriptor.name] !== undefined) {
        param.value = clampParam(params[descriptor.name], param.minValue, param.maxValue,
          `${row.module}.${descriptor.name}`);
      }
      inputs[descriptor.name] = param;
      knobs[descriptor.name] = param;
    }

    // Audio ports become a specific INPUT INDEX on the worklet node. A param and an audio
    // port may not share a name — if they did, one would silently shadow the other here —
    // and `tests/port_vc1_test.js` asserts they never do.
    row.audioInputs.forEach((name, index) => {
      if (inputs[name]) {
        throw new Error(`${row.name}: ${JSON.stringify(name)} is both an AudioParam and an audio input`);
      }
      inputs[name] = { node, index };
    });

    // An option KNOWN AT BUILD went into `processorOptions` above, because a message
    // posted at construction can lose the race with the first `process()` — measured, see
    // processors_ax2.js. Only LIVE changes go by message.
    for (const option of row.options) {
      knobs[option] = (value) => node.port.postMessage(vc1OptionMessage(option, value));
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
 * THE VC-1 MODULE REGISTRY — module type name -> factory, derived from the roster so it
 * cannot list a module the worklet does not register.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   synth/modules.js        `MODULE_FACTORIES` must spread `BLOCK_MODULE_FACTORIES`
 *   synth/worklet_urls.js   one `?worker&url` line for `./worklets/processors_vc1.js`
 *   synth/engine.js         `WORKLET_MODULES` must gain `BLOCK_WORKLET_MODULES` — every
 *                           row here builds an AudioWorkletNode, so without that an
 *                           un-awaited `engine.init()` fails inside a constructor instead
 *                           of with the sentence that names the problem.
 */
export const BLOCK_MODULE_FACTORIES = Object.fromEntries(
  VC1_PROCESSORS.map((row) => [row.module, vc1Module(row)]),
);

/** Query. The VC-1 module type names — what `WORKLET_MODULES` must contain. */
export function vc1ModuleTypes() {
  return Object.keys(BLOCK_MODULE_FACTORIES);
}

/** The block's processor module. See core/audio_blocks.js for the PORT-BLOCK CONTRACT. */
// BLOCK_WORKLET_URL lives in synth/worklet_urls.js — see that file: a Vite `?worker&url`
// specifier here would make this module un-importable by bare node, and `synth/modules.js`
// imports it, which would take the whole bare-node test lane down.
/** The types whose factory builds an AudioWorkletNode — all of this block's. */
export const BLOCK_WORKLET_MODULES = vc1ModuleTypes();
