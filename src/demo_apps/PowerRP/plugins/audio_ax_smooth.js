/**
 * SMOOTH — the `axSmooth` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). math/smooth.axo @ 78cb74bd0b11,
 * <code.krate>: `val = ___SMMLA(val-inlet_in, (-1<<26)+(param_time>>1), val)`.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_SMOOTH_SPEC.
 *
 * Axoloti's one-pole smoother — the node that turns a stepped control into a glide, and the single most reused utility in their library. WARNING, and it is theirs: the knob is called Time but is BACKWARDS — higher means slower, and at 64 the value freezes completely.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_SMOOTH_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_SMOOTH_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxSmoothPlugin = audioNodePlugin(AX_SMOOTH_SPEC);
