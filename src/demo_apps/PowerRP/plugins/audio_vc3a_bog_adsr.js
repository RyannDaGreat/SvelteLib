/**
 * Bogaudio ADSR — the `vcvBogAdsr` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * Bogaudio's ADSR, whose envelope is SHAPED rather than linear or exponential: the attack is a square root (fast then easing) and the decay and release are squares. That asymmetry is why it sounds like an analogue envelope and not like a ramp generator — and why the Linear switch is a genuinely different envelope rather than a tidier one.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is VCV_BOG_ADSR_SPEC in core/audio_specs_vc3a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a Bogaudio module, so there is a third place: the
 * arithmetic is `synth/vc3a_kernels.js`, whose docblocks carry the derivation
 * record — the source commit, which C++ file and function, the recurrence, and
 * every deliberate divergence by name (including the block's one voltage-scaling
 * law). Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_BOG_ADSR_SPEC } from "../core/audio_specs_vc3a.js";

export const audioVcvBogAdsrPlugin = audioNodePlugin(VCV_BOG_ADSR_SPEC);
