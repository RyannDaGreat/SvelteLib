/**
 * AMBIENCE PAD — the `pad` engine module as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing.
 *
 * A WHOLE SYNTH IN ONE MODULE (the user's 'You can have a module that's just an entire synth'): detuned voices, a sub octave, a slow filter sweep and its own reverb. Patch it straight to an output and the slide already sounds like space.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. Twenty-three
 * hand-written copies of it would be twenty-three chances to forget one of those
 * (NF-CORE measured what forgetting `inputs: {}` costs: copied patches stay wired to
 * the originals). What differs per module is DATA, and that data is
 * PAD_SPEC in core/audio_specs.js — its ports, its knobs and their ranges,
 * its family and its readout.
 *
 * So: read core/audio_specs.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { PAD_SPEC } from "../core/audio_specs.js";

export const audioPadPlugin = audioNodePlugin(PAD_SPEC);
