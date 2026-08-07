/**
 * THE AX-4 MODULE FACTORIES — eleven Axoloti nodes as engine modules.
 *
 * ── WHY THIS FILE IS SHORT ──────────────────────────────────────────────────
 * modules.js's factories each build a different graph of native AudioNodes, so
 * each is its own function. These eleven are the SAME graph — one
 * AudioWorkletNode, one pass gain per audio INPUT, one tap gain per output —
 * differing only in a processor name, a param list and two port lists. All of
 * those are already declared once, in `worklets/processors_ax4.js`'s
 * `AX4_PROCESSORS`, because the worklet needs them too. So this file DERIVES its
 * factories from that array rather than restating any of it: rename a port there
 * and both halves move together.
 *
 * That is the one rule the brief names as the commonest local failure — a
 * hand-maintained list mirroring another module's shape — and the roster lives
 * in the worklet file rather than here simply because the worklet cannot import
 * from the main thread's side while the reverse is fine.
 *
 * ── THE UNIFORM SHAPE, AS modules.js DEFINES IT ─────────────────────────────
 * `(context, params) -> {inputs, outputs, params, start, dispose, meta}`. The
 * engine never special-cases a module type, so nothing here is special either.
 *
 * ── A GAIN ON EACH SIDE, AND WHY BOTH ───────────────────────────────────────
 * `inputs` and `outputs` must map a port NAME to an AudioNode, but an
 * AudioWorkletNode distinguishes its several inputs and outputs by INDEX
 * (`source.connect(node, 0, 2)`). A one-gain pass per audio input and one per
 * output turns an index into a node, which is what lets the mixer have seven
 * audio inlets and the stereo VCA two outlets at all. Uniform across all eleven
 * rather than only the rows that need it: a shape that differs per module is a
 * shape that drifts. AX-2 has the output half of this for exactly the same
 * reason; AX-4 is the first block to need the input half.
 *
 * ── THE KNOB KINDS, AND WHY THERE IS ONLY ONE HERE ──────────────────────────
 * AX-2 has three routes — a-rate AudioParam, option setter, construct-time
 * option. NOT ONE AX-4 CONTROL IS DISCRETE OR CONSTRUCT-TIME: every one is a
 * continuous number, so every one is an a-rate AudioParam, appearing in BOTH
 * `inputs` and `params`, which is what makes "a knob or an input, your choice"
 * true with no duplicated node. No `port.postMessage` seam exists in this block
 * because nothing would ever travel it.
 *
 * Zero PowerRP imports (the ENGINE law).
 */

import { AX4_PROCESSORS } from "./worklets/processors_ax4.js";
import { clampParam } from "./dsp.js";

/**
 * Build one module factory from a roster row.
 *
 * Command-producing (the returned factory constructs AudioNodes). Untested as a
 * unit — the module SHAPE it produces is exercised by tests/port_ax4_test.js
 * through the roster it reads; the kernels underneath carry the numeric proof,
 * and the graph is one node plus N+M gains.
 *
 * @param {object} row - an AX4_PROCESSORS entry
 * @returns {function(BaseAudioContext, object): object} an engine module factory
 */
function ax4Module(row) {
  return function factory(context, params = {}) {
    const node = new AudioWorkletNode(context, row.name, {
      numberOfInputs: row.audioInputs.length,
      numberOfOutputs: row.outputs.length,
      outputChannelCount: row.outputs.map(() => 1),
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

    const passes = row.audioInputs.map((name, index) => {
      const pass = context.createGain();
      pass.connect(node, 0, index);
      inputs[name] = pass;
      return pass;
    });

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
        for (const pass of passes) pass.disconnect();
        for (const tap of taps) tap.disconnect();
      },
      meta: { kind: row.module, label: row.label },
    };
  };
}

/**
 * THE AX-4 MODULE REGISTRY — module type name -> factory, derived from the
 * roster so it cannot list a module the worklet does not register.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   synth/modules.js       `MODULE_FACTORIES` must spread `BLOCK_MODULE_FACTORIES`
 *                          and `WORKLET_MODULES` must gain these eleven keys —
 *                          every one builds an AudioWorkletNode, so without that
 *                          an un-awaited `engine.init()` fails inside a
 *                          constructor instead of with the sentence that names
 *                          the problem.
 *   synth/worklet_urls.js  the AX4 processor URL, which THIS BLOCK MAY NOT ADD.
 */
export const BLOCK_MODULE_FACTORIES = Object.fromEntries(
  AX4_PROCESSORS.map((row) => [row.module, ax4Module(row)]),
);

/** Query. The AX-4 module type names — what `WORKLET_MODULES` must contain. */
export function ax4ModuleTypes() {
  return Object.keys(BLOCK_MODULE_FACTORIES);
}

// BLOCK_WORKLET_URL is deliberately absent — see synth/worklet_urls.js, which is
// the only file in the repo allowed to hold a Vite `?worker&url` specifier. One
// here would make this module un-importable by bare node and take the whole node
// test lane down with it.

/** The types whose factory builds an AudioWorkletNode — all eleven of this
 *  block's. An ARRAY, not a Set: that is the PORT-BLOCK CONTRACT's spelling
 *  (core/audio_blocks.js), and AX-3 shipping a Set is why the contract says so. */
export const BLOCK_WORKLET_MODULES = ax4ModuleTypes();
