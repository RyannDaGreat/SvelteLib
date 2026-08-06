/**
 * STEP VALUES — the `axStepsValue` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). sel/sel fb 16.axo @ 78cb74bd0b11,
 * <code.krate> — a 16-way `switch(inlet_in)` with the `def` inlet as its `default:` branch.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_STEPS_VALUE_SPEC.
 *
 * Sixteen stored values read by one step index — the pitch lane of an Axoloti sequencer. Feed it a Counter and take the output into an Oscillator's frequency, or into a Quantize node first so it cannot play a wrong note.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_STEPS_VALUE_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_STEPS_VALUE_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxStepsValuePlugin = audioNodePlugin(AX_STEPS_VALUE_SPEC);
