/**
 * AX PHASOR — the `axPhasor` engine module as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing.
 *
 * `osc/phasor compl`: a raw 0…1 ramp and its opposite, half a cycle apart. Not meant to be heard — it is the READ POSITION for a table, a grain window or a wavefolder, and the two outputs are what lets a crossfade hide the wrap.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_PHASOR_SPEC in core/audio_specs_ax2.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax2_kernels.js`, whose docblocks carry the derivation
 * record — source commit, which `.axo` file, which `code.krate`/`code.srate`
 * block, the recurrence in float, and every deliberate divergence by name.
 * Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_PHASOR_SPEC } from "../core/audio_specs_ax2.js";

export const audioAxPhasorPlugin = audioNodePlugin(AX_PHASOR_SPEC);
