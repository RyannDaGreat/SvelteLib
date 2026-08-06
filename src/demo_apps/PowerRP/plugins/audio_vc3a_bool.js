/**
 * BOOL — the `vcvBool` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * Boolean logic on gates: A and B give AND, OR and XOR at once, and a separate input gives NOT. Anything above 1 V (0.2 in our units) is true. THE COMPARISON HAS NO HYSTERESIS — that is Bogaudio's, and it is why this module is for gates and not for audio: a signal hovering at the threshold chatters. NOTE that an unwired NOT input reads as false, so NOT emits high; Rack outputs zero there, because it can tell nothing is patched.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is VCV_BOOL_SPEC in core/audio_specs_vc3a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a Bogaudio module, so there is a third place: the
 * arithmetic is `synth/vc3a_kernels.js`, whose docblocks carry the derivation
 * record — the source commit, which C++ file and function, the recurrence, and
 * every deliberate divergence by name (including the block's one voltage-scaling
 * law). Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_BOOL_SPEC } from "../core/audio_specs_vc3a.js";

export const audioVcvBoolPlugin = audioNodePlugin(VCV_BOOL_SPEC);
