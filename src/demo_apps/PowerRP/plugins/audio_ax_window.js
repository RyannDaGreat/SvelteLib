/**
 * HANN WINDOW — the `axWindow` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). math/window.axo @ 78cb74bd0b11,
 * <code.krate> / <code.srate>: `HANNING2TINTERP(inlet_phase<<5, r).
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_WINDOW_SPEC.
 *
 * A Hann window over a 0…1 phase — the envelope every granular voice is multiplied by, and the reason a grain fades in and out instead of clicking at both ends. Drive it from a phasor and multiply the result into the grain.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_WINDOW_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_WINDOW_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxWindowPlugin = audioNodePlugin(AX_WINDOW_SPEC);
