/**
 * THE VC-10 MODULE FACTORIES — fifteen VCV Rack nodes as engine modules.
 *
 * ── WHY THIS FILE IS SHORT ──────────────────────────────────────────────────
 * modules.js's factories each build a different graph of native AudioNodes, so
 * each is its own function. These fifteen are the SAME graph — one
 * AudioWorkletNode, one tap gain per output port — differing only in a processor
 * name, a param list, an AUDIO INPUT list and an output list. All four are
 * already declared once, in `worklets/processors_vc10.js`'s `VC10_PROCESSORS`,
 * because the worklet needs them too. So this file DERIVES its factories from
 * that array rather than restating any of it: rename a port there and both
 * halves move together. That is AX-2's shape and VC-3b's, and the reason the
 * roster lives in the worklet file rather than here is only that the worklet
 * cannot import from the main thread's side while the reverse is fine.
 *
 * ── THE UNIFORM SHAPE, AS modules.js DEFINES IT ─────────────────────────────
 * `(context, params) -> {inputs, outputs, params, start, dispose, meta}`. The
 * engine never special-cases a module type, so nothing here is special either.
 *
 * ── AUDIO INPUTS ARE `{node, index}`, NOT GAIN NODES (kernels' D3) ──────────
 * **THE INDEX IS THE WHOLE POINT AND A GAIN WOULD DESTROY IT.** Super's stereo
 * decision, Filt's routing modes, WVCO's four `…Connected_m` flags and saïch's
 * V/oct normalling all branch on `isConnected()`, and a worklet's only way to
 * see that is `inputs[i].length === 0`. Route through a GainNode — the shape
 * `mixerModule` uses — and the gain is ALWAYS connected, so every input reads as
 * wired: Filt would run permanently in stereo off one cable, and saïch's voices
 * 2…4 would never take voice 1's normal. `engine.resolvePort` already supports
 * `{node, index}` (modules.js's sample-and-hold trigger is the precedent), so
 * this costs nothing and buys the semantics.
 *
 * ── THE KNOB KINDS, AND WHICH ROUTE EACH TAKES ──────────────────────────────
 *   a-rate AudioParam  every KNOB. Appears in `params` and NOT in `inputs`:
 *                      these modules ship their own CV inlet per control, with
 *                      their own law, so a second same-named inlet would give
 *                      one control two inlets that disagree.
 *   option setter      a discrete knob (waveform, topology, mix profile). No
 *                      AudioParam exists for a string, so it is a plain
 *                      function — engine.setParam already calls those. Sent by
 *                      `port.postMessage`.
 *   construct          `seed` on Super and Caudal, and Super's `aliasMode`,
 *                      which SIZES its oversampling buffers. Both rebuild the
 *                      kernel, so the spec marks them and the mirror rebuilds
 *                      the module.
 *
 * Zero PowerRP imports (the ENGINE law).
 */

import { VC10_PROCESSORS } from "./worklets/processors_vc10.js";
import { clampParam } from "./dsp.js";

/**
 * Pure function. The message a discrete knob's setter posts. Named so the wire
 * format has one definition rather than an object literal at the call site.
 *
 * @param {string} option - the knob key, e.g. "waveform"
 * @param {string|number} value - the new value
 * @returns {{option: string, value: string|number}}
 *
 * @example vc10OptionMessage("waveform", "fold") // {option: "waveform", value: "fold"}
 */
export function vc10OptionMessage(option, value) {
  return { option, value };
}

/**
 * Pure function. The `processorOptions` for one module: its construct-time
 * knobs picked out of the caller's params, and nothing else.
 *
 * A missing one is LEFT OUT rather than defaulted here — the kernel's own
 * constructor states its default once, and a second default in this file would
 * be a place for the two to disagree.
 *
 * @param {string[]} names - the row's construct-time and option knob names
 * @param {object} params - the caller's initial params
 * @returns {object}
 *
 * @example vc10ConstructOptions(["seed"], {seed: 12, mix: 0.5}) // {seed: 12}
 * @example vc10ConstructOptions(["seed"], {}) // {}
 */
export function vc10ConstructOptions(names, params) {
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
 * unit — the module SHAPE it produces is exercised by tests/port_vc10_test.js
 * through the roster it reads; the kernels underneath carry the numeric proof,
 * and the graph is one node plus N gains.
 *
 * @param {object} row - a VC10_PROCESSORS entry
 * @returns {function(BaseAudioContext, object): object} an engine module factory
 */
function vc10Module(row) {
  return function factory(context, params = {}) {
    const node = new AudioWorkletNode(context, row.name, {
      numberOfInputs: row.audioInputs.length,
      numberOfOutputs: row.outputs.length,
      outputChannelCount: row.outputs.map(() => 1),
      processorOptions: vc10ConstructOptions([...row.construct, ...row.options], params),
    });

    // THE AUDIO INPUTS, BY INDEX. See the header: a GainNode here would make
    // every input read as connected and every `isConnected` branch take the
    // wrong side.
    const inputs = {};
    row.audioInputs.forEach((name, index) => { inputs[name] = { node, index }; });

    const knobs = {};
    for (const descriptor of row.params) {
      const param = node.parameters.get(descriptor.name);
      if (!param) throw new Error(`${row.name} has no AudioParam ${JSON.stringify(descriptor.name)}`);
      if (params[descriptor.name] !== undefined) {
        param.value = clampParam(params[descriptor.name], param.minValue, param.maxValue, `${row.module}.${descriptor.name}`);
      }
      knobs[descriptor.name] = param;
    }

    // An option KNOWN AT BUILD went into `processorOptions` above, because a
    // message posted at construction can lose the race with the first
    // `process()` (AX-2 measured it: an oscillator built as `saw` rendered SINE
    // for its opening frames). Only LIVE changes go by message.
    for (const option of row.options) {
      knobs[option] = (value) => node.port.postMessage(vc10OptionMessage(option, value));
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
 * THE VC-10 MODULE REGISTRY — module type name -> factory, derived from the
 * roster so it cannot list a module the worklet does not register.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   synth/modules.js         `MODULE_FACTORIES` must spread `BLOCK_MODULE_FACTORIES`
 *   synth/worklet_urls.js    one `?worker&url` line for
 *                            `./worklets/processors_vc10.js`
 *   core/audio_blocks.js     spread `BLOCK_SPECS` from core/audio_specs_vc10.js
 *   plugins/audio_index.js   spread `BLOCK_PLUGINS` from plugins/audio_index_vc10.js
 * Without the worklet URL these fifteen exist in the registry and fail inside an
 * AudioWorkletNode constructor instead of with a sentence naming the problem.
 */
export const BLOCK_MODULE_FACTORIES = Object.fromEntries(
  VC10_PROCESSORS.map((row) => [row.module, vc10Module(row)]),
);

/** Query. The VC-10 module type names — what `WORKLET_MODULES` must contain. */
export function vc10ModuleTypes() {
  return Object.keys(BLOCK_MODULE_FACTORIES);
}

/** The types whose factory builds an AudioWorkletNode — all fifteen of this
 *  block's. An ARRAY, per the PORT-BLOCK CONTRACT in core/audio_blocks.js
 *  (AX-3 shipped a Set here and it was swept back). */
export const BLOCK_WORKLET_MODULES = vc10ModuleTypes();
