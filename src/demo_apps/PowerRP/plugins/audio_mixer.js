/**
 * MIXER — the `mixer` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other modules rather than being heard.
 *
 * Four inputs summed, each with its own level. The honest way to combine voices — and note that an OUTPUT module already sums everything patched to it, so this is for controlling the balance, not for making summing possible.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. Twenty-three
 * hand-written copies of it would be twenty-three chances to forget one of those
 * (NF-CORE measured what forgetting `inputs: {}` costs: copied patches stay wired to
 * the originals). What differs per module is DATA, and that data is
 * MIXER_SPEC in core/audio_specs.js — its ports, its knobs and their ranges,
 * its family and its readout.
 *
 * So: read core/audio_specs.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { MIXER_SPEC } from "../core/audio_specs.js";

export const audioMixerPlugin = audioNodePlugin(MIXER_SPEC);
