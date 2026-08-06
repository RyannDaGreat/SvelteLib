/**
 * STEP GATES — the `axStepsBool` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). sel/sel b 16.axo @ 78cb74bd0b11,
 * <code.krate> (with <code.declaration>'s `in_prev` for the pulse variants).
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_STEPS_BOOL_SPEC.
 *
 * Four parallel 16-step gate patterns read by one step index — the drum-grid half of an Axoloti sequencer. Feed it a Counter; take the four gates into four Envelopes. In `pulse` mode a track fires only on the tick the index CHANGED, which is what makes a held index emit one hit per step rather than a continuous high.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_STEPS_BOOL_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_STEPS_BOOL_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxStepsBoolPlugin = audioNodePlugin(AX_STEPS_BOOL_SPEC);
