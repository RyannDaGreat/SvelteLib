/**
 * DIVIDE / REMAINDER — the `axDivRem` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). math/divremc.axo @ 78cb74bd0b11,
 * <code.krate>.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_DIVREM_SPEC.
 *
 * Integer divide with the remainder alongside it — how an Axoloti sequencer turns one running counter into a bar number and a step within the bar. Wire a counter in and take both outputs.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_DIVREM_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_DIVREM_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxDivremPlugin = audioNodePlugin(AX_DIVREM_SPEC);
