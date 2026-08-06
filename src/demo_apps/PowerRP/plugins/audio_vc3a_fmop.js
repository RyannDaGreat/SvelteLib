/**
 * FM-OP — the `vcvFmop` engine module as a PowerRP node widget.
 *
 * SOURCE family (green header): it makes sound rather than shaping it.
 *
 * Bogaudio's FM-OP: ONE FM operator — a sine oscillator whose phase is bent by its own last output and by an external signal, with a built-in envelope that can drive its level, its feedback and its FM depth independently. A stack of these IS an FM synth; eight of them are the metallic layer of the Incanta patch and the FM Pad patch is nothing but two, one modulating the other.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is VCV_FMOP_SPEC in core/audio_specs_vc3a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a Bogaudio module, so there is a third place: the
 * arithmetic is `synth/vc3a_kernels.js`, whose docblocks carry the derivation
 * record — the source commit, which C++ file and function, the recurrence, and
 * every deliberate divergence by name (including the block's one voltage-scaling
 * law). Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_FMOP_SPEC } from "../core/audio_specs_vc3a.js";

export const audioVcvFmopPlugin = audioNodePlugin(VCV_FMOP_SPEC);
