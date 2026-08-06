/**
 * STEREO OUT — the `axStereoOut` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). sss/audio/StOutVol.axo @ 798166f0ce29,
 * <code.krate>.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_STEREO_OUT_SPEC.
 *
 * The stereo output nearly every contrib patch ends in, with its own volume. It differs from PowerRP's own Output in the way that matters for a port: this HARD CLIPS at ±1.0 the way the hardware codec does, where ours runs a limiter. A patch tuned to clip here sounds wrong through a limiter, and vice versa.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_STEREO_OUT_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_STEREO_OUT_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxStereoOutPlugin = audioNodePlugin(AX_STEREO_OUT_SPEC);
