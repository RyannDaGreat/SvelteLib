/**
 * 4-SEGMENT SHAPER — the `axShaper` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). tiar/kfunc/u4u.axo @ 798166f0ce29,
 * <code.krate>.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_SHAPER_SPEC.
 *
 * Smashed Transistors' `u4u`: a control-rate transfer function drawn with five breakpoints over four equal segments. Put it after a saw LFO and the LFO becomes any shape you like; put it after an envelope and the envelope's curve becomes yours.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_SHAPER_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_SHAPER_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxShaperPlugin = audioNodePlugin(AX_SHAPER_SPEC);
