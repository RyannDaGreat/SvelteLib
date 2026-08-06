/**
 * MANUAL — the `vcvManual` engine module as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * One button, eight identical gate outputs — the module that starts a patch. Its two subtleties are both about time: the output is held for at least 1 ms after the button goes low, so a single-frame press is still a usable trigger; and TRIGGER ON LOAD fires once 10 ms after the module starts, which is what makes a patch self-starting.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA,
 * and that data is VCV_MANUAL_SPEC in core/audio_specs_vc3a.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a Bogaudio module, so there is a third place: the
 * arithmetic is `synth/vc3a_kernels.js`, whose docblocks carry the derivation
 * record — the source commit, which C++ file and function, the recurrence, and
 * every deliberate divergence by name (including the block's one voltage-scaling
 * law). Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_MANUAL_SPEC } from "../core/audio_specs_vc3a.js";

export const audioVcvManualPlugin = audioNodePlugin(VCV_MANUAL_SPEC);
