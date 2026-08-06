/**
 * AX SUPERSAW — the `axSupersaw` engine module as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing.
 *
 * `osc/supersaw`: seven of their cheap saws, six detuned around the seventh. The spread is SQUARE-LAW, so the bottom half of the Detune knob barely moves and the top half opens right up — that curve is theirs and is why the knob feels the way it does.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_SUPERSAW_SPEC in core/audio_specs_ax2.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax2_kernels.js`, whose docblocks carry the derivation
 * record — source commit, which `.axo` file, which `code.krate`/`code.srate`
 * block, the recurrence in float, and every deliberate divergence by name.
 * Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_SUPERSAW_SPEC } from "../core/audio_specs_ax2.js";

export const audioAxSupersawPlugin = audioNodePlugin(AX_SUPERSAW_SPEC);
