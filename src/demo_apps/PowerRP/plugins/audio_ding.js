/**
 * DING — the `ding` engine module as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing.
 *
 * The FM bell voice — the user's 'little metallic ding or dong ... or a pip or a pop or a clank'. It makes a sound when TRIGGERED, so it wants a clock or a sequencer upstream.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. Twenty-three
 * hand-written copies of it would be twenty-three chances to forget one of those
 * (NF-CORE measured what forgetting `inputs: {}` costs: copied patches stay wired to
 * the originals). What differs per module is DATA, and that data is
 * DING_SPEC in core/audio_specs.js — its ports, its knobs and their ranges,
 * its family and its readout.
 *
 * So: read core/audio_specs.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { DING_SPEC } from "../core/audio_specs.js";

export const audioDingPlugin = audioNodePlugin(DING_SPEC);
