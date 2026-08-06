/**
 * VCV COMPARE — the `vcvCompare` engine module as a PowerRP node widget.
 *
 * MODULATION family: it derives control signals from a comparison.
 *
 * Two signals, eight answers — including the clipped-off remainder a wavefolder wants.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA, and
 * that data is VCV_COMPARE_SPEC in core/audio_specs_vc2.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a VCV Rack module, so there is a third place: the
 * arithmetic is `synth/vc2_kernels.js`, whose docblocks carry the derivation
 * record — the C++ file and function, the commit read, the recurrence in float,
 * and every deliberate divergence by name, including the block's four laws (the
 * wire is one Rack volt; a knob is Rack's param; a CV input is its own param; a
 * clock divider is part of the sound). Read that before changing what this module
 * SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_COMPARE_SPEC } from "../core/audio_specs_vc2.js";

export const audioVcvComparePlugin = audioNodePlugin(VCV_COMPARE_SPEC);
