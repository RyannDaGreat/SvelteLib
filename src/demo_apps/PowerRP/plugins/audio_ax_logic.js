/**
 * LOGIC — the `axLogic` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). logic/and 2.axo @ 78cb74bd0b11,
 * <code.krate> of each.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_LOGIC_SPEC.
 *
 * Axoloti's boolean shelf: AND, NOT, and the two edge detectors their sequencers are built out of. A true here is FULL SCALE (+1.0), not 1/64 — bool32 coerces to frac32 as +1.0, which is the coercion that makes a comparator audible.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_LOGIC_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_LOGIC_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxLogicPlugin = audioNodePlugin(AX_LOGIC_SPEC);
