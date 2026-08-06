/**
 * MUX — the `axMux` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). mux/mux 2.axo @ 78cb74bd0b11,
 * <code.krate> (and the byte-identical <code.srate> of the frac32buffer overload).
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_MUX_SPEC.
 *
 * Eight inputs, one selector, one output — pick a signal with a number. Their mux 2 / 4 / 8 are the same switch at three widths, so this is the widest and an unused input is simply never chosen.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_MUX_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_MUX_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxMuxPlugin = audioNodePlugin(AX_MUX_SPEC);
