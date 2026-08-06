/**
 * VCV RINGS — the `vcvRings` engine module as a PowerRP node widget.
 *
 * FILTER family (violet header): it shapes a signal's spectrum.
 *
 * Mutable Instruments' resonator: a 60-mode modal bank, a Karplus-Strong string, or a struck string with seven more ringing in sympathy.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat equation-slot
 * keys, `inputs: {}` so copies remap, a height sized from its own ports — lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA, and that data is VCV_RINGS_SPEC in
 * core/audio_specs_vc1.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a VCV Rack module, so there is a third place: the arithmetic is
 * `synth/vc1_kernels.js`, whose docblocks carry the derivation record — which C++ file and
 * function, read at which commit, the recurrence in float, and every deliberate divergence
 * by number. Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_RINGS_SPEC } from "../core/audio_specs_vc1.js";

export const audioVcvRingsPlugin = audioNodePlugin(VCV_RINGS_SPEC);
