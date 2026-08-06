/**
 * AX RANDOM — the `axRand` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * Their three `rand/uniform*` objects as one node: a random value at control rate, either free-running or held between triggers, either continuous or quantised to whole steps. Free + continuous is stepped noise; triggered + 8 steps is a random note chooser.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_RAND_SPEC in core/audio_specs_ax2.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax2_kernels.js`, whose docblocks carry the derivation
 * record — source commit, which `.axo` file, which `code.krate`/`code.srate`
 * block, the recurrence in float, and every deliberate divergence by name.
 * Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_RAND_SPEC } from "../core/audio_specs_ax2.js";

export const audioAxRandPlugin = audioNodePlugin(AX_RAND_SPEC);
