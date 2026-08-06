/**
 * THE AX-3 FILTER MODULES — nine engine factories over synth/worklets/processors_ax3.js.
 *
 * Same uniform shape as synth/modules.js (read its header for the contract:
 * `(context, params, resources) -> {inputs, outputs, params, start, dispose, meta}`,
 * and why some knobs are AudioParams and some are setters). This file adds nothing
 * to that shape; it exists because five porting agents cannot all edit one 1800-line
 * module file, and because these nine belong together — they share a worklet file, a
 * derivation vocabulary and one unit convention.
 *
 * ── ALL NINE ARE WORKLETS, AND NOT FOR WANT OF TRYING NATIVE ────────────────
 * synth/modules.js's implementation law is NATIVE FIRST, and it applies here. What
 * rules the natives out is not the topology, it is the COEFFICIENTS:
 *  - `BiquadFilterNode` computes RBJ coefficients from `frequency` and `Q` in C++
 *    and exposes no way to substitute any. The whole point of these ports is the
 *    coefficients being different (the extra `qinv`, vcf3's [2,1,2] numerator), so
 *    a BiquadFilterNode would be the filter we are deliberately not shipping.
 *  - `IIRFilterNode` DOES take arbitrary coefficients — and freezes them at
 *    construction. Every one of these filters recomputes at 3000 Hz from a
 *    modulatable pitch; rebuilding an IIRFilterNode per control tick would be 3000
 *    allocations a second and would drop the filter state on each one.
 *  - The state-variable, allpass and comb topologies have no native node at all.
 * Butt10 is the one arguable case (its coefficients really are fixed), and it is a
 * worklet anyway: five chained IIRFilterNodes would be five nodes to rebuild when
 * the cutoff row changes, where the worklet swaps a table by message.
 *
 * ── THE PARAMS ARE a-rate, DELIBERATELY ─────────────────────────────────────
 * A k-rate AudioParam delivers ONE value per 128-frame quantum. Axoloti's control
 * rate is fs/16 — EIGHT ticks per quantum — so a k-rate param would silently run
 * every coefficient update 8x slow, which is the exact trap R7-11 flags. a-rate
 * gives the processors a value per frame and they sample it at the tick boundary.
 *
 * Zero PowerRP imports, as the ENGINE law requires.
 */

import { clampParam } from "./dsp.js";

/**
 * ── WHERE THIS BLOCK'S WORKLET URL IS, AND WHY IT IS NOT HERE ───────────────
 * `synth/worklet_urls.js`, with every other block's. It has to be: this
 * block's processor IMPORTS `../ax3_kernels.js`, which only survives the
 * production build through Vite's `?worker&url` pipeline — and that specifier
 * is Vite-only, so holding it here would make this module un-importable by
 * bare node and take the whole node gate down. That file carries the
 * measurement; do not re-derive it here.
 */

/**
 * Command. Set any of `names` that appear in `params` on the node's AudioParams.
 *
 * The same three lines as synth/modules.js `setWorkletParams`, and the duplication
 * is the module-boundary tax rather than a Tower of Babel: that one is not
 * exported, and exporting it would mean this file editing that one — the thing the
 * file split exists to avoid. It is four lines; the lead may fold the two together
 * when the barrels land, and that is the right time.
 *
 * @param {AudioWorkletNode} node
 * @param {object} params - initial values, any subset
 * @param {string[]} names - the AudioParam names to look for
 * @returns {void} (mutates the node's params)
 */
function setAxParams(node, params, names) {
  for (const name of names) {
    if (params[name] === undefined) continue;
    const param = node.parameters.get(name);
    if (!param) throw new Error(`Worklet has no parameter ${JSON.stringify(name)}`);
    param.value = clampParam(params[name], param.minValue, param.maxValue, name);
  }
}

/**
 * Command. Build the `{inputs, outputs, params}` an AudioParam-only worklet module
 * needs, so nine factories do not each spell the same three maps.
 *
 * Every one of these filters has ONE audio input called `in`, and every AudioParam
 * it has is BOTH a modulation input and a knob — which is R7-11's replacement for
 * Axoloti's ` m` suffix convention ("every param implicitly gets a same-named
 * inlet"), applied literally.
 *
 * @param {AudioWorkletNode} node
 * @param {string[]} names - the AudioParam names
 * @returns {{inputs: object, outputs: object, params: object}} minus the outputs,
 *          which the caller adds because multi-output modules differ
 */
function axPorts(node, names) {
  const ports = {};
  for (const name of names) {
    const param = node.parameters.get(name);
    if (!param) throw new Error(`Worklet has no parameter ${JSON.stringify(name)}`);
    ports[name] = param;
  }
  return { inputs: { in: node, ...ports }, params: { ...ports } };
}

/** Command. The `dispose` every one of these needs and nothing more. */
function axDispose(node) {
  return () => {
    node.port.onmessage = null;
    node.disconnect();
  };
}

/**
 * Command. A discrete (string) knob delivered by message, the same seam
 * synth/modules.js `quantizeModule` uses for its scale table.
 *
 * NOT a `construct: true` knob: the processor swaps a mode integer or a coefficient
 * table and keeps its state, so there is nothing to rebuild and a rebuild would
 * click. The processors THROW on an unknown value rather than falling back to a
 * default — a mode row that silently keeps the old filter would be the exact silent
 * failure this project forbids.
 *
 * THE MESSAGE IS ASYNCHRONOUS, and that is worth knowing rather than discovering:
 * the initial one posted at construction lands a render quantum or two later, so a
 * highpass runs as a lowpass for a couple of milliseconds before it becomes itself.
 * Inaudible live, and the same seam `quantizeModule` already accepts — but it means
 * an OFFLINE render started in the same tick measures the DEFAULT mode. That is
 * exactly how .frenzy/round7/w3ax3/worklet_render.mjs first reported the biquad's
 * lowpass and bandpass as byte-identical.
 */
function axDiscrete(node, key) {
  return (value) => node.port.postMessage({ [key]: value });
}

// ── THE BIQUAD FAMILY ───────────────────────────────────────────────────────

/** `filter/lp` / `bp` / `hp` — WORKLET (the coefficients are the port; see above). */
function axBiquadModule(context, params) {
  const node = new AudioWorkletNode(context, "ax-biquad-processor");
  setAxParams(node, params, ["pitch", "reso"]);
  node.port.postMessage({ mode: params.mode ?? "lowpass" });
  const { inputs, params: knobs } = axPorts(node, ["pitch", "reso"]);
  return {
    inputs,
    outputs: { out: node },
    params: { ...knobs, mode: axDiscrete(node, "mode") },
    start() {},
    dispose: axDispose(node),
    meta: { kind: "axBiquad", label: "Axoloti Biquad" },
  };
}

/** `filter/vcf3` — WORKLET. The older, un-normalised biquad; a different filter. */
function axVcf3Module(context, params) {
  const node = new AudioWorkletNode(context, "ax-vcf3-processor");
  setAxParams(node, params, ["pitch", "reso"]);
  const { inputs, params: knobs } = axPorts(node, ["pitch", "reso"]);
  return {
    inputs,
    outputs: { out: node },
    params: knobs,
    start() {},
    dispose: axDispose(node),
    meta: { kind: "axVcf3", label: "Axoloti VCF3" },
  };
}

/** `filter/lp1` / `hp1` — WORKLET. */
function axOnePoleModule(context, params) {
  const node = new AudioWorkletNode(context, "ax-onepole-processor");
  setAxParams(node, params, ["pitch"]);
  node.port.postMessage({ mode: params.mode ?? "lowpass" });
  const { inputs, params: knobs } = axPorts(node, ["pitch"]);
  return {
    inputs,
    outputs: { out: node },
    params: { ...knobs, mode: axDiscrete(node, "mode") },
    start() {},
    dispose: axDispose(node),
    meta: { kind: "axOnePole", label: "Axoloti One-Pole" },
  };
}

// ── THE STATE-VARIABLE FILTERS — the two multi-output modules ───────────────

/** How many outputs the two SVFs have. Both expose all three taps at once, which
 *  is what their `multimode` / `ZDF SVF 1` objects already do — a chain that wants
 *  two of them should not need two filters. */
const AX_SVF_OUTPUT_COUNT = 3;
const AX_SVF_OUTPUT_CHANNELS = [1, 1, 1];

/** `filter/{lp,bp,hp} svf` and `multimode svf m` — WORKLET, three taps.
 *  Output ORDER is the processor's: 0 = hp, 1 = bp, 2 = lp. */
function axSvfModule(context, params) {
  const node = new AudioWorkletNode(context, "ax-svf-processor", {
    numberOfOutputs: AX_SVF_OUTPUT_COUNT,
    outputChannelCount: AX_SVF_OUTPUT_CHANNELS,
  });
  setAxParams(node, params, ["pitch", "reso"]);
  const { inputs, params: knobs } = axPorts(node, ["pitch", "reso"]);
  return {
    inputs,
    outputs: { hp: { node, index: 0 }, bp: { node, index: 1 }, lp: { node, index: 2 } },
    params: knobs,
    start() {},
    dispose: axDispose(node),
    meta: { kind: "axSvf", label: "Axoloti SVF" },
  };
}

/** `tiar/filter/ZDF SVF 1` — WORKLET, three taps.
 *  Output ORDER is HIS: 0 = lp12, 1 = hp12, 2 = bp6. Deliberately not reordered to
 *  match the Chamberlin SVF above: the outlet order is part of what a reader of the
 *  original patch sees, and two nodes disagreeing is honest where a silent
 *  renumbering would make a rebuilt patch wrong in a way nothing reports. */
function axZdfSvfModule(context, params) {
  const node = new AudioWorkletNode(context, "ax-zdf-svf-processor", {
    numberOfOutputs: AX_SVF_OUTPUT_COUNT,
    outputChannelCount: AX_SVF_OUTPUT_CHANNELS,
  });
  setAxParams(node, params, ["pitch", "Q"]);
  const { inputs, params: knobs } = axPorts(node, ["pitch", "Q"]);
  return {
    inputs,
    outputs: { lp: { node, index: 0 }, hp: { node, index: 1 }, bp: { node, index: 2 } },
    params: knobs,
    start() {},
    dispose: axDispose(node),
    meta: { kind: "axZdfSvf", label: "Axoloti ZDF SVF" },
  };
}

// ── SMOOTHING, DIFFUSION AND COMBING ────────────────────────────────────────

/** `kfilter/lowpass` + `tiar/kfilter/LPRiseDecay` — WORKLET, control rate. */
function axKFilterLowpassModule(context, params) {
  const node = new AudioWorkletNode(context, "ax-kfilter-lowpass-processor");
  setAxParams(node, params, ["rise", "decay"]);
  const { inputs, params: knobs } = axPorts(node, ["rise", "decay"]);
  return {
    inputs,
    outputs: { out: node },
    params: knobs,
    start() {},
    dispose: axDispose(node),
    meta: { kind: "axKFilterLowpass", label: "Axoloti K-Smoother" },
  };
}

/** `filter/allpass` + `TSG/filter/allpass m` — WORKLET. */
function axAllpassModule(context, params) {
  const node = new AudioWorkletNode(context, "ax-allpass-processor");
  setAxParams(node, params, ["delay", "g"]);
  const { inputs, params: knobs } = axPorts(node, ["delay", "g"]);
  return {
    inputs,
    outputs: { out: node },
    params: knobs,
    start() {},
    dispose: axDispose(node),
    meta: { kind: "axAllpass", label: "Axoloti Allpass" },
  };
}

/** `filter/fdbkcomb` — WORKLET, and the block's recursion lives HERE rather than in
 *  the patch graph: the processor owns the delay line, so no port declares
 *  `feedbackSafe` and no graph cycle is involved. See the note on the spec's `in`. */
function axFdbkCombModule(context, params) {
  const node = new AudioWorkletNode(context, "ax-fdbkcomb-processor");
  setAxParams(node, params, ["delay", "a", "b"]);
  const { inputs, params: knobs } = axPorts(node, ["delay", "a", "b"]);
  return {
    inputs,
    outputs: { out: node },
    params: knobs,
    start() {},
    dispose: axDispose(node),
    meta: { kind: "axFdbkComb", label: "Axoloti Comb" },
  };
}

/** `tiar/filter/Butt10` — WORKLET. No AudioParams at all: its only control is the
 *  tabulated cutoff, which is a discrete message. */
function axButterworth10Module(context, params) {
  const node = new AudioWorkletNode(context, "ax-butterworth10-processor");
  node.port.postMessage({ fc: params.fc ?? "9k" });
  return {
    inputs: { in: node },
    outputs: { out: node },
    params: { fc: axDiscrete(node, "fc") },
    start() {},
    dispose: axDispose(node),
    meta: { kind: "axButterworth10", label: "Axoloti Butterworth 10" },
  };
}

/**
 * THE AX-3 MODULE REGISTRY — type name -> factory, in AUDIO_SPECS_AX3 order.
 *
 * The lead spreads this into synth/modules.MODULE_FACTORIES. Keys match each
 * spec's `module` field, which is the only thing that binds a widget to an engine
 * module; tests/port_ax3_test.js asserts the two agree.
 */
export const BLOCK_MODULE_FACTORIES = {
  axBiquad: axBiquadModule,
  axVcf3: axVcf3Module,
  axOnePole: axOnePoleModule,
  axSvf: axSvfModule,
  axZdfSvf: axZdfSvfModule,
  axKFilterLowpass: axKFilterLowpassModule,
  axAllpass: axAllpassModule,
  axFdbkComb: axFdbkCombModule,
  axButterworth10: axButterworth10Module,
};

/** Every one of these constructs an AudioWorkletNode, so every one belongs in the
 *  engine's `WORKLET_MODULES` gate — the set that turns "you forgot init()" into a
 *  sentence instead of a failure inside a constructor. Derived rather than listed:
 *  a tenth module added above joins it automatically. */
// AN ARRAY, NOT A Set: the PORT-BLOCK CONTRACT (core/audio_blocks.js) declares this name
// `array`, and AX-1 and AX-2 both ship one. `[...set]` happens to spread the same, which
// is exactly why the divergence survived — a contract that only bites when it breaks the
// build is not being checked. There is no third dialect: it is the contract or a sweep.
export const BLOCK_WORKLET_MODULES = Object.keys(BLOCK_MODULE_FACTORIES);

// A `BLOCK_IMPLEMENTATION` export lived here and is GONE. It was a sixth name no other
// block had and nothing outside this file's own test imported, and the assertion it
// carried was vacuous: both sides were `Object.keys(BLOCK_MODULE_FACTORIES)` mapped to
// the same literal, in the same file, so it could not fail. The real accounting is
// synth/modules.IMPLEMENTATION, which DERIVES "worklet" from PORT_BLOCK_MODULES for every
// ported module — that is the thing worth asserting, and port_ax3_test.js now asserts it.
