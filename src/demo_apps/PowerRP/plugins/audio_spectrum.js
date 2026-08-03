/**
 * SPECTRUM — the `spectrum` engine module as a PowerRP node widget.
 *
 * ANALYSIS family (green header): it measures without changing, and carries a LIVE OVERLAY.
 *
 * A flowing spectrogram of whatever passes through it — the user's 'spectrogram analyzers that can visualize the audio coming out of some node'. Frequency runs bottom to top, time scrolls right to left.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. Twenty-three
 * hand-written copies of it would be twenty-three chances to forget one of those
 * (NF-CORE measured what forgetting `inputs: {}` costs: copied patches stay wired to
 * the originals). What differs per module is DATA, and that data is
 * SPECTRUM_SPEC in core/audio_specs.js — its ports, its knobs and their ranges,
 * its family and its readout.
 *
 * So: read core/audio_specs.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { SPECTRUM_SPEC } from "../core/audio_specs.js";

export const audioSpectrumPlugin = audioNodePlugin(SPECTRUM_SPEC);
