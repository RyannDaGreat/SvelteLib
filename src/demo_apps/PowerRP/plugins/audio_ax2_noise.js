/**
 * AX NOISE — the `axNoise` engine module as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing.
 *
 * Their three `noise/*` generators at audio rate. Unlike ours, `gaussian` is a real distribution rather than a filter colour: eight independent generators summed, which is what gives it a bell-shaped amplitude histogram and a softer, less spiky sound than uniform at the same level.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_NOISE_SPEC in core/audio_specs_ax2.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax2_kernels.js`, whose docblocks carry the derivation
 * record — source commit, which `.axo` file, which `code.krate`/`code.srate`
 * block, the recurrence in float, and every deliberate divergence by name.
 * Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_NOISE_SPEC } from "../core/audio_specs_ax2.js";

export const audioAxNoisePlugin = audioNodePlugin(AX_NOISE_SPEC);
