/**
 * 8:1 — the `vcvEightone` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * The demultiplexer half of ADDR-SEQ: the addressed position picks which of eight INPUTS reaches the output instead of which of eight knobs. Same clock, reset, steps and select semantics — so driving an 8:1 and an ADDR-SEQ from one clock keeps them in step, which is how a patch sequences a signal and a control voltage together.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is VCV_EIGHTONE_SPEC in core/audio_specs_vc3a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a Bogaudio module, so there is a third place: the
 * arithmetic is `synth/vc3a_kernels.js`, whose docblocks carry the derivation
 * record — the source commit, which C++ file and function, the recurrence, and
 * every deliberate divergence by name (including the block's one voltage-scaling
 * law). Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_EIGHTONE_SPEC } from "../core/audio_specs_vc3a.js";

export const audioVcvEightonePlugin = audioNodePlugin(VCV_EIGHTONE_SPEC);
