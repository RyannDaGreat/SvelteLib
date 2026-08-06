/**
 * VCV SUPERCELL — the `vcvSupercell` engine module as a PowerRP node widget.
 *
 * EFFECT family (cool blue header): it transforms a signal that arrives.
 *
 * Grayscale's 'big Clouds' -- the same grain engine with a full control surface. Its source is PROPRIETARY and was not read; see the spec's help and the kernel's deviations S1/S2 for exactly what that costs.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat equation-slot
 * keys, `inputs: {}` so copies remap, a height sized from its own ports — lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA, and that data is VCV_SUPERCELL_SPEC in
 * core/audio_specs_vc1.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a VCV Rack module, so there is a third place: the arithmetic is
 * `synth/vc1_kernels.js`, whose docblocks carry the derivation record — which C++ file and
 * function, read at which commit, the recurrence in float, and every deliberate divergence
 * by number. Read that before changing what this module SOUNDS like.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_SUPERCELL_SPEC } from "../core/audio_specs_vc1.js";

export const audioVcvSupercellPlugin = audioNodePlugin(VCV_SUPERCELL_SPEC);
