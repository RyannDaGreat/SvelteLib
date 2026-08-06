/**
 * STEP LEVELS — the `axStepsMulti` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). sel/sel 4l 16 8t s.axo @ 78cb74bd0b11,
 * <code.krate>.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_STEPS_MULTI_SPEC.
 *
 * Eight selectable rows of sixteen FOUR-LEVEL steps — off, and three degrees of on. This is the accent lane: a 303 patch reads gate from a Step Gates node and accent depth from this one, and switching the row switches the whole pattern in one move.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_STEPS_MULTI_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_STEPS_MULTI_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxStepsMultiPlugin = audioNodePlugin(AX_STEPS_MULTI_SPEC);
