/**
 * Bogaudio LFO — the `vcvBogLfo` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * SIX PHASE-LOCKED OUTPUTS FROM ONE ACCUMULATOR — ramp up, ramp down, square, triangle, sine and stepped random, all read from the same phase, so they can never drift apart. That is the whole point of the module: patch two of them at different destinations and one LFO becomes a modulation section. Thirteen of the twenty demo patches use one.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is VCV_BOG_LFO_SPEC in core/audio_specs_vc3a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a Bogaudio module, so there is a third place: the
 * arithmetic is `synth/vc3a_kernels.js`, whose docblocks carry the derivation
 * record — the source commit, which C++ file and function, the recurrence, and
 * every deliberate divergence by name (including the block's one voltage-scaling
 * law). Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_BOG_LFO_SPEC } from "../core/audio_specs_vc3a.js";

export const audioVcvBogLfoPlugin = audioNodePlugin(VCV_BOG_LFO_SPEC);
