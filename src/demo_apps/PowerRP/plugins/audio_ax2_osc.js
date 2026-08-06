/**
 * AX OSCILLATOR — the `axOsc` engine module as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing.
 *
 * Axoloti's five `osc/*` oscillators in one node — including the BAND-LIMITED saw and square, which are 4- and 8-voice minBLEP over the firmware's own 2048-entry step table. That is the difference you hear: a naive saw folds its high harmonics back down as inharmonic whistling when you play it high, and these do not.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is AX_OSC_SPEC in core/audio_specs_ax2.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of an Axoloti object, so there is a third place: the
 * arithmetic is `synth/ax2_kernels.js`, whose docblocks carry the derivation
 * record — source commit, which `.axo` file, which `code.krate`/`code.srate`
 * block, the recurrence in float, and every deliberate divergence by name.
 * Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_OSC_SPEC } from "../core/audio_specs_ax2.js";

export const audioAxOscPlugin = audioNodePlugin(AX_OSC_SPEC);
