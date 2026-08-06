/**
 * THE VC-2 MODULE FACTORIES — sixteen VCV Rack nodes as engine modules.
 *
 * ── WHY THIS FILE IS SHORT ──────────────────────────────────────────────────
 * All sixteen are the SAME graph — one AudioWorkletNode, one tap gain per audio
 * input, one tap gain per output — differing only in a processor name, a param
 * list, an input list and an output list. All four are declared once, in
 * `worklets/processors_vc2.js`'s `VC2_PROCESSORS`, because the worklet needs them
 * too. So this file DERIVES its factories from that array rather than restating
 * any of it: rename a param there and both halves move together. That is the
 * "hand-maintained list mirroring another module's shape" failure the brief names
 * as this project's commonest, avoided the way `modules_ax2.js` avoids it.
 *
 * ── THE UNIFORM SHAPE, AS modules.js DEFINES IT ─────────────────────────────
 * `(context, params) -> {inputs, outputs, params, start, dispose, meta}`. The
 * engine never special-cases a module type, so nothing here is special either.
 *
 * ── TAP GAINS ON BOTH SIDES, AND WHY EACH IS NECESSARY ──────────────────────
 * OUTPUTS: `outputs` must map a port NAME to an AudioNode, but an
 * AudioWorkletNode with N outputs distinguishes them by INDEX
 * (`node.connect(dest, 1)`). One gain per output turns an index into a node,
 * which is what lets the VCF have `lpf` and `hpf` at all.
 *
 * INPUTS: the mirror image, and it is what `modules_ax2.js` never needed —
 * AX-2's ten nodes are all sources with `numberOfInputs: 0`. Half of VC-2's are
 * PROCESSORS, and the mixer has four signal inputs. `synth/engine.js`'s
 * `resolvePort` already supports an indexed input (`if (target.node && typeof
 * target.index === "number") return target`), so a port could in principle be
 * `{node, index}` with no gain at all. A GAIN IS USED ANYWAY, for one measured
 * reason: `disconnect(source, dest, outputIndex, inputIndex)` throws
 * `InvalidAccessError` if the exact quadruple was never connected, and the engine
 * disconnects by resolving the port fresh. Routing every input through its own
 * one-to-one gain makes each wire an ordinary node-to-node edge, which is the
 * only shape the ramp guard, the rewire path and `dispose` all already handle.
 * Uniform across all sixteen rather than only the multi-input ones: a shape that
 * differs per module is a shape that drifts.
 *
 * ── THE KNOB KINDS, AND WHICH ROUTE EACH TAKES ──────────────────────────────
 *   a-rate AudioParam  every knob (law L2) and every CV input (law L3, `in_*`).
 *                      A knob appears in `params`; a CV input appears in
 *                      `inputs` under its SPEC key. They are different params, so
 *                      the two maps never collide even where the names match —
 *                      `vcvOctave` has both a knob `octave` and an input
 *                      `octave`, which is exactly Rack's panel.
 *   option setter      a discrete knob (`response`, `source`). No AudioParam
 *                      exists for a string, so it is a plain function; the engine's
 *                      setParam already calls those. Sent by `port.postMessage`.
 *   construct          `seed` alone. It IS the generator's initial state, so
 *                      there is nothing to set later; the spec marks it
 *                      `construct: true` and the mirror rebuilds the module.
 *
 * Zero PowerRP imports (the ENGINE law).
 */

import { VC2_PROCESSORS } from "./worklets/processors_vc2.js";
import { clampParam } from "./dsp.js";

/**
 * Pure function. The message a discrete knob's setter posts. Named so the wire
 * format has one definition rather than an object literal at the call site.
 *
 * @param {string} option - the knob key, e.g. "response"
 * @param {string|number} value - the new value
 * @returns {{option: string, value: string|number}}
 *
 * @example vc2OptionMessage("response", "exp4") // {option: "response", value: "exp4"}
 */
export function vc2OptionMessage(option, value) {
  return { option, value };
}

/**
 * Pure function. The `processorOptions` for one module: its construct-time knobs
 * picked out of the caller's params, and nothing else.
 *
 * A missing one is LEFT OUT rather than defaulted here — the kernel's own
 * constructor states its default once, and a second default in this file would be
 * a place for the two to disagree.
 *
 * @param {string[]} construct - the row's construct-time knob names
 * @param {object} params - the caller's initial params
 * @returns {object}
 *
 * @example vc2ConstructOptions(["seed"], {seed: 12, level: 1}) // {seed: 12}
 * @example vc2ConstructOptions(["seed"], {}) // {}
 */
export function vc2ConstructOptions(construct, params) {
  const options = {};
  for (const name of construct) {
    if (params[name] !== undefined) options[name] = params[name];
  }
  return options;
}

/**
 * Pure function. The AudioParam name a spec INPUT port resolves to — law L3's
 * one spelling, stated once so the roster, the factory and the test cannot
 * disagree about it.
 *
 * @param {string} port - the spec's input key
 * @returns {string} the AudioParam name
 *
 * @example vc2InputParam("freq") // "in_freq"
 * @example // and the knob of the same key is simply "freq", never this
 */
export function vc2InputParam(port) {
  return `in_${port}`;
}

/**
 * Build one module factory from a roster row.
 *
 * Command-producing (the returned factory constructs AudioNodes). Untested as a
 * unit — the module SHAPE it produces is exercised by tests/port_vc2_test.js
 * through the roster it reads, the kernels underneath carry the numeric proof,
 * and the graph is one node plus N + M gains.
 *
 * @param {object} row - a VC2_PROCESSORS entry
 * @returns {function(BaseAudioContext, object): object} an engine module factory
 */
function vc2Module(row) {
  return function factory(context, params = {}) {
    const node = new AudioWorkletNode(context, row.name, {
      numberOfInputs: Math.max(row.audioInputs.length, 1),
      numberOfOutputs: row.outputs.length,
      outputChannelCount: row.outputs.map(() => 1),
      processorOptions: vc2ConstructOptions([...row.construct, ...row.options], params),
    });

    // KNOBS FIRST, so a construct-time value that is ALSO a param (none today,
    // but the shape allows it) is applied before anything reads it.
    const knobs = {};
    const paramByName = new Map();
    for (const descriptor of row.params) {
      const param = node.parameters.get(descriptor.name);
      if (!param) throw new Error(`${row.name} has no AudioParam ${JSON.stringify(descriptor.name)}`);
      paramByName.set(descriptor.name, param);
      if (params[descriptor.name] !== undefined) {
        param.value = clampParam(
          params[descriptor.name], param.minValue, param.maxValue, `${row.module}.${descriptor.name}`,
        );
      }
    }
    for (const descriptor of row.params) {
      if (descriptor.name.startsWith(VC2_INPUT_PREFIX)) continue;
      knobs[descriptor.name] = paramByName.get(descriptor.name);
    }

    // An option KNOWN AT BUILD went into `processorOptions` above, because a
    // message posted at construction can lose the race with the first
    // `process()` (measured — see processors_vc2.js). Only LIVE changes go by
    // message.
    for (const option of row.options) {
      knobs[option] = (value) => node.port.postMessage(vc2OptionMessage(option, value));
    }

    const inputTaps = row.audioInputs.map((_, index) => {
      const tap = context.createGain();
      tap.connect(node, 0, index);
      return tap;
    });
    const inputs = {};
    row.inputs.forEach((port) => {
      const audioIndex = row.audioInputs.indexOf(port);
      if (audioIndex >= 0) {
        inputs[port] = inputTaps[audioIndex];
        return;
      }
      const param = paramByName.get(vc2InputParam(port));
      if (!param) {
        throw new Error(
          `${row.name} declares input ${JSON.stringify(port)} with no audio input and no ` +
            `${JSON.stringify(vc2InputParam(port))} AudioParam`,
        );
      }
      inputs[port] = param;
    });

    const outputTaps = row.outputs.map((_, index) => {
      const tap = context.createGain();
      node.connect(tap, index);
      return tap;
    });
    const outputs = {};
    row.outputs.forEach((name, index) => { outputs[name] = outputTaps[index]; });

    return {
      inputs,
      outputs,
      params: knobs,
      start() {},
      dispose() {
        node.port.onmessage = null;
        node.disconnect();
        for (const tap of inputTaps) tap.disconnect();
        for (const tap of outputTaps) tap.disconnect();
      },
      meta: { kind: row.module, label: row.label },
    };
  };
}

/** Law L3's prefix, as a constant because both the factory and the test filter
 *  on it: a param whose name starts with this is an INPUT, not a knob, and must
 *  not appear in `params` (it has no Inspector row — its row is the port). */
export const VC2_INPUT_PREFIX = "in_";

/**
 * THE VC-2 MODULE REGISTRY — module type name -> factory, derived from the roster
 * so it cannot list a module the worklet does not register.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   synth/modules.js       `MODULE_FACTORIES` must spread `BLOCK_MODULE_FACTORIES`,
 *                          and `PORT_BLOCK_MODULES` must spread
 *                          `BLOCK_WORKLET_MODULES` — every one of these sixteen
 *                          builds an AudioWorkletNode, so without that an
 *                          un-awaited `engine.init()` fails inside a constructor
 *                          instead of with the sentence that names the problem.
 *   synth/worklet_urls.js  `export { default as VC2_WORKLET_URL } from
 *                          "./worklets/processors_vc2.js?worker&url";`
 *   core/audio_blocks.js   spread this block's `BLOCK_SPECS`
 *   plugins/audio_index.js spread this block's `BLOCK_PLUGINS`
 */
export const BLOCK_MODULE_FACTORIES = Object.fromEntries(
  VC2_PROCESSORS.map((row) => [row.module, vc2Module(row)]),
);

/** Query. The VC-2 module type names — what `WORKLET_MODULES` must contain. */
export function vc2ModuleTypes() {
  return Object.keys(BLOCK_MODULE_FACTORIES);
}

/** The types whose factory builds an AudioWorkletNode — all sixteen of this
 *  block's. An ARRAY, per the PORT-BLOCK CONTRACT in core/audio_blocks.js (AX-3
 *  shipped a Set and it was swept back). */
export const BLOCK_WORKLET_MODULES = vc2ModuleTypes();
