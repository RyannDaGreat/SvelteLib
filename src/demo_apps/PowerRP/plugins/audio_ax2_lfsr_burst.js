/**
 * AX LFSR BURST — the `axLfsrBurst` engine module as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing.
 *
 * `pulse/lfsrburst 8`: a 255-sample burst of a maximal-length 8-bit shift register — 5.3 ms of deterministic noise. This is a percussion EXCITER, not a noise source: hit a filter or a comb with it and you get the transient, not a hiss.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_LFSR_BURST_SPEC in core/audio_specs_ax2.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax2_kernels.js`, whose docblocks carry the derivation
 * record — source commit, which `.axo` file, which `code.krate`/`code.srate`
 * block, the recurrence in float, and every deliberate divergence by name.
 * Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_LFSR_BURST_SPEC } from "../core/audio_specs_ax2.js";

export const audioAxLfsrBurstPlugin = audioNodePlugin(AX_LFSR_BURST_SPEC);
