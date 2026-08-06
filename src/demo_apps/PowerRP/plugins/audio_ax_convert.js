/**
 * CONVERT — the `axConvert` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). conv/bipolar2unipolar.axo @ 78cb74bd0b11,
 * <code.krate> for the two range maps.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_CONVERT_SPEC.
 *
 * The range-and-rate adaptors that sit between two Axoloti objects that disagree: bipolar to unipolar and back, and the k→s ramp that stops a stepped control from zipper-noising an audio path.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_CONVERT_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_CONVERT_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxConvertPlugin = audioNodePlugin(AX_CONVERT_SPEC);
