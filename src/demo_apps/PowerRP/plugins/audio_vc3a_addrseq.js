/**
 * ADDR-SEQ — the `vcvAddrseq` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * A voltage-ADDRESSABLE 8-step sequencer: a clock walks a position while the Select CV picks which part of the sequence is being walked. Nine of these are the modulation farm of the Incanta patch — with Select on a slow drift no two of them land on the same pattern, which is how one module type produces a whole generative texture.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is VCV_ADDRSEQ_SPEC in core/audio_specs_vc3a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a Bogaudio module, so there is a third place: the
 * arithmetic is `synth/vc3a_kernels.js`, whose docblocks carry the derivation
 * record — the source commit, which C++ file and function, the recurrence, and
 * every deliberate divergence by name (including the block's one voltage-scaling
 * law). Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_ADDRSEQ_SPEC } from "../core/audio_specs_vc3a.js";

export const audioVcvAddrseqPlugin = audioNodePlugin(VCV_ADDRSEQ_SPEC);
