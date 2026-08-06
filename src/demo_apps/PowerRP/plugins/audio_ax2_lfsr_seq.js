/**
 * AX LFSR SEQUENCER — the `axLfsrSeq` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * `seq/lfsrseq`: a gate pattern that looks random and repeats EXACTLY. With a maximal-length tap the period is 2^bits − 1 steps — 511 for the default — so it never lands where a 16-step loop would, which is the whole trick of generative sequencing with one object.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_LFSR_SEQ_SPEC in core/audio_specs_ax2.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax2_kernels.js`, whose docblocks carry the derivation
 * record — source commit, which `.axo` file, which `code.krate`/`code.srate`
 * block, the recurrence in float, and every deliberate divergence by name.
 * Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_LFSR_SEQ_SPEC } from "../core/audio_specs_ax2.js";

export const audioAxLfsrSeqPlugin = audioNodePlugin(AX_LFSR_SEQ_SPEC);
