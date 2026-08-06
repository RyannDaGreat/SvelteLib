/**
 * THE VC-3a MODULE FACTORIES — nine Bogaudio modules as engine modules.
 *
 * ── WHY THIS FILE IS SHORT ──────────────────────────────────────────────────
 * modules.js's own factories each build a different graph of native AudioNodes,
 * so each is its own function. These nine are the SAME graph — one
 * AudioWorkletNode, one tap gain per output port — differing only in a processor
 * name, a param list and an output list. All three are already declared once, in
 * `worklets/processors_vc3a.js`'s `VC3A_PROCESSORS`, because the worklet needs
 * them too. So this file DERIVES its factories from that array rather than
 * restating any of it: rename a param there and both halves move together. That
 * is the rule the brief names as this project's commonest local failure — a
 * hand-maintained list mirroring another module's shape — and the roster lives in
 * the worklet file rather than here only because the worklet cannot import from
 * the main thread's side while the reverse is fine.
 *
 * ── THE UNIFORM SHAPE, AS modules.js DEFINES IT ─────────────────────────────
 * `(context, params) -> {inputs, outputs, params, start, dispose, meta}`. The
 * engine never special-cases a module type, so nothing here is special either.
 *
 * ── ONE TAP GAIN PER OUTPUT, AND WHY ────────────────────────────────────────
 * `outputs` must map a port NAME to an AudioNode, but an AudioWorkletNode with
 * several outputs distinguishes them by INDEX (`node.connect(dest, 1)`). A
 * one-gain tap per output turns an index into a node, which is what lets the LFO's
 * six phase-locked waveforms and Bool's four logic results be ports at all.
 * Uniform across all nine rather than only the ones that need it: a shape that
 * differs per module is a shape that drifts.
 *
 * ── THE KNOB KINDS, AND WHICH ROUTE EACH TAKES ──────────────────────────────
 *   a-rate AudioParam  every numeric control. A param a spec ALSO declares as an
 *                      input is wireable, and the wire SUMS onto the knob's value
 *                      — which is right for DADSRH's `trigger` (the C++ adds its
 *                      button to its input) and is why every Bogaudio CV that
 *                      SCALES a knob instead gets its own `_cv` param.
 *   option setter      a discrete knob (a waveform, a mute state, a range). No
 *                      AudioParam holds a string, so it is a plain function —
 *                      engine.setParam already calls those. Sent by
 *                      `port.postMessage`, applied on the audio thread.
 *   construct          the LFO's `seed` alone. It IS the stepped output's table,
 *                      so there is nothing to set later; the spec marks it
 *                      `construct: true` and the mirror rebuilds the module.
 *
 * Zero PowerRP imports (the ENGINE law).
 */

import { VC3A_PROCESSORS } from "./worklets/processors_vc3a.js";
import { clampParam } from "./dsp.js";

/**
 * Pure function. The message a discrete knob's setter posts. Named so the wire
 * format has one definition rather than an object literal at the call site.
 *
 * @param {string} option - the knob key, e.g. "oscillator"
 * @param {string|number} value - the new value
 * @returns {{option: string, value: string|number}}
 *
 * @example vc3aOptionMessage("oscillator", "clean") // {option: "oscillator", value: "clean"}
 */
export function vc3aOptionMessage(option, value) {
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
 * @param {string[]} names - the row's construct-time and discrete knob names
 * @param {object} params - the caller's initial params
 * @returns {object}
 *
 * @example vc3aConstructOptions(["seed"], {seed: 12, scale: 1}) // {seed: 12}
 * @example vc3aConstructOptions(["seed"], {}) // {}
 */
export function vc3aConstructOptions(names, params) {
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
 * unit — the module SHAPE it produces is exercised by tests/port_vc3a_test.js
 * only through the roster it reads; the kernels underneath carry the numeric
 * proof, and the graph is one node plus N gains.
 *
 * @param {object} row - a VC3A_PROCESSORS entry
 * @returns {function(BaseAudioContext, object): object} an engine module factory
 */
function vc3aModule(row) {
  return function factory(context, params = {}) {
    const node = new AudioWorkletNode(context, row.name, {
      numberOfInputs: 0,
      numberOfOutputs: row.outputs.length,
      outputChannelCount: row.outputs.map(() => 1),
      processorOptions: vc3aConstructOptions([...row.construct, ...row.options], params),
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
    // message, and the residual window plays the kernel's own default rather
    // than silence or a wrong value forever.
    for (const option of row.options) {
      knobs[option] = (value) => node.port.postMessage(vc3aOptionMessage(option, value));
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
 * THE VC-3a MODULE REGISTRY — module type name -> factory, derived from the
 * roster so it cannot list a module the worklet does not register.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   core/audio_blocks.js    `PORT_BLOCK_SPECS` must spread this block's BLOCK_SPECS
 *   synth/modules.js        `MODULE_FACTORIES` must spread `BLOCK_MODULE_FACTORIES`
 *   synth/worklet_urls.js   one `?worker&url` export for processors_vc3a.js
 *   synth/engine.js         `WORKLET_MODULES` must gain these nine keys — every
 *                           one builds an AudioWorkletNode, so without that an
 *                           un-awaited `engine.init()` fails inside a constructor
 *                           instead of with the sentence that names the problem
 *   plugins/audio_index.js  `audioPlugins` must spread `BLOCK_PLUGINS`
 */
export const BLOCK_MODULE_FACTORIES = Object.fromEntries(
  VC3A_PROCESSORS.map((row) => [row.module, vc3aModule(row)]),
);

/** Query. The VC-3a module type names — what `WORKLET_MODULES` must contain. */
export function vc3aModuleTypes() {
  return Object.keys(BLOCK_MODULE_FACTORIES);
}

// BLOCK_WORKLET_URL lives in synth/worklet_urls.js — see that file: a Vite
// `?worker&url` specifier here would make this module un-importable by bare node,
// which takes the whole node test lane down with it.

/** The types whose factory builds an AudioWorkletNode — all nine of this block's. */
export const BLOCK_WORKLET_MODULES = vc3aModuleTypes();
