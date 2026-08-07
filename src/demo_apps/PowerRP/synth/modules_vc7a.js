/**
 * THE VC-7a MODULE FACTORIES — twelve clocking and logic nodes as engine modules.
 *
 * ── WHY THIS FILE IS SHORT ──────────────────────────────────────────────────
 * modules.js's factories each build a different graph of native AudioNodes, so each
 * is its own function. These twelve are the SAME graph — one AudioWorkletNode, one tap
 * gain per output port — differing only in a processor name, a param list, an AUDIO
 * INPUT list and an output list. All four are already declared once, in
 * `worklets/processors_vc7a.js`'s `VC7A_PROCESSORS`, because the worklet needs them
 * too. So this file DERIVES its factories from that array rather than restating any of
 * it: rename a port there and both halves move together. That is AX-2's and VC-3b's
 * shape, and the roster lives in the worklet file rather than here only because the
 * worklet cannot import from the main thread's side while the reverse is fine.
 *
 * ── THE UNIFORM SHAPE, AS modules.js DEFINES IT ─────────────────────────────
 * `(context, params) -> {inputs, outputs, params, start, dispose, meta}`. The engine
 * never special-cases a module type, so nothing here is special either.
 *
 * ── THE INPUTS ARE `{node, index}`, AND A GAIN WOULD DESTROY THEM (D3) ──────
 * CountModula's laws branch on `isConnected()` — BooleanAND emits nothing without A,
 * GateSequencer8's run inlet is normalled to 10 V so unpatched means RUNNING — and a
 * worklet's only way to see that is `inputs[i].length === 0`. Route through a GainNode
 * (the shape `mixerModule` uses) and the gain is ALWAYS connected, so every inlet would
 * read as wired and every normal would vanish. `engine.resolvePort` already supports
 * `{node, index}`, so this costs nothing and buys the semantics.
 *
 * ── THE KNOB KINDS, AND WHY THERE ARE ONLY TWO ──────────────────────────────
 *   a-rate AudioParam  EVERY knob, including the panel switches — see the worklet
 *                      file's header for why this block has no discrete string knobs
 *                      and therefore no `port.postMessage` path at all.
 *   construct          `seed` alone, on the three kernels that draw random numbers.
 *                      It IS the generator's initial state, so there is nothing to set
 *                      later; the spec marks it `construct: true` and the mirror
 *                      rebuilds the module.
 *
 * A knob does NOT also appear in `inputs`, unlike AX-2's: these modules ship their own
 * CV inlet per control with their OWN law (an override, or an attenuverted add), so a
 * second same-named inlet would give one control two inlets that disagree. That is why
 * every colliding inlet carries the `_cv` suffix — see the spec file's RENAMES block.
 *
 * Zero PowerRP imports (the ENGINE law).
 */

import { VC7A_PROCESSORS } from "./worklets/processors_vc7a.js";
import { clampParam } from "./dsp.js";

/**
 * Pure function. The `processorOptions` for one module: its construct-time knobs
 * picked out of the caller's params, and nothing else.
 *
 * A missing one is LEFT OUT rather than defaulted here — the kernel's own constructor
 * states its default once, and a second default in this file would be a place for the
 * two to disagree.
 *
 * @param {string[]} names - the row's construct-time knob names
 * @param {object} params - the caller's initial params
 * @returns {object}
 *
 * @example vc7aConstructOptions(["seed"], {seed: 12, mode: 1}) // {seed: 12}
 * @example vc7aConstructOptions(["seed"], {}) // {}
 * @example vc7aConstructOptions([], {seed: 12}) // {}
 */
export function vc7aConstructOptions(names, params) {
  const options = {};
  for (const name of names) {
    if (params[name] !== undefined) options[name] = params[name];
  }
  return options;
}

/**
 * Build one module factory from a roster row.
 *
 * Command-producing (the returned factory constructs AudioNodes). Untested as a unit —
 * the module SHAPE it produces is exercised by tests/port_vc7a_test.js through the
 * roster it reads; the kernels underneath carry the numeric proof, and the graph is one
 * node plus N gains.
 *
 * @param {object} row - a VC7A_PROCESSORS entry
 * @returns {function(BaseAudioContext, object): object} an engine module factory
 */
function vc7aModule(row) {
  return function factory(context, params = {}) {
    const node = new AudioWorkletNode(context, row.name, {
      numberOfInputs: row.audioInputs.length,
      numberOfOutputs: row.outputs.length,
      outputChannelCount: row.outputs.map(() => 1),
      processorOptions: vc7aConstructOptions(row.construct, params),
    });

    // THE AUDIO INPUTS, BY INDEX. See the header: a GainNode here would make every
    // input read as connected and erase every normalled inlet in the block.
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
 * THE VC-7a MODULE REGISTRY — module type name -> factory, derived from the roster so
 * it cannot list a module the worklet does not register.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   synth/modules.js         `MODULE_FACTORIES` must spread `BLOCK_MODULE_FACTORIES`
 *   synth/worklet_urls.js    one `?worker&url` line for `./worklets/processors_vc7a.js`
 *   core/audio_blocks.js     spread `BLOCK_SPECS` from core/audio_specs_vc7a.js
 *   plugins/audio_index.js   spread `BLOCK_PLUGINS` from plugins/audio_index_vc7a.js
 * Without the worklet URL these twelve exist in the registry and fail inside an
 * AudioWorkletNode constructor instead of with a sentence naming the problem.
 */
export const BLOCK_MODULE_FACTORIES = Object.fromEntries(
  VC7A_PROCESSORS.map((row) => [row.module, vc7aModule(row)]),
);

/** Query. The VC-7a module type names — what `WORKLET_MODULES` must contain. */
export function vc7aModuleTypes() {
  return Object.keys(BLOCK_MODULE_FACTORIES);
}

/** The types whose factory builds an AudioWorkletNode — all twelve of this block's.
 *  An ARRAY, per the PORT-BLOCK CONTRACT in core/audio_blocks.js (AX-3 shipped a Set
 *  here and it was swept back). */
export const BLOCK_WORKLET_MODULES = vc7aModuleTypes();
