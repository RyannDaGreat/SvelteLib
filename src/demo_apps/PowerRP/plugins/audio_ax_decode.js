/**
 * DECODE 8 — the `axDecode` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). logic/decode/int 8.axo @ 78cb74bd0b11,
 * <code.krate>.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_DECODE_SPEC.
 *
 * One-hot decode: an integer in, eight gates out, exactly one of them high. The `chain` output is the input minus 8, so two of these side by side decode sixteen values without either knowing the other exists.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_DECODE_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_DECODE_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxDecodePlugin = audioNodePlugin(AX_DECODE_SPEC);
