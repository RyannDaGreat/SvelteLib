/**
 * COUNTER — the `axCounter` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). logic/counter.axo @ 78cb74bd0b11,
 * <code.declaration> + <code.init> + <code.krate>.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_COUNTER_SPEC.
 *
 * A cyclic up-counter with an independent reset — the thing that turns a clock into a step index, which is what every step table in this block wants upstream of it. Its carry output fires on the tick it wraps, so counters chain into bars.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_COUNTER_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_COUNTER_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxCounterPlugin = audioNodePlugin(AX_COUNTER_SPEC);
