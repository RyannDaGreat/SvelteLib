/**
 * VCV MARBLES — the `vcvMarbles` engine module as a PowerRP node widget.
 *
 * MODULATION family (green header): it produces or shapes control.
 *
 * Mutable Instruments' random source: two coupled generators sharing one deja-vu register,
 * which is what lets a generative deck play itself forever without repeating.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat equation-slot
 * keys, `inputs: {}` so copies remap, a height sized from its own ports — lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA, and that data is VCV_MARBLES_SPEC in
 * core/audio_specs_vc1.js.
 *
 * ── AND WHERE THE SOUND IS ──────────────────────────────────────────────────
 * This node is a PORT of a VCV Rack module, so there is a third place: the arithmetic is
 * `synth/vc1_kernels.js`, whose docblocks carry the derivation record — which C++ file and
 * function, read at which commit, the recurrence in float, and every deliberate divergence
 * by number. Marbles' record also warns WHICH repository to read: AudibleInstruments pins a
 * VCVRack FORK of eurorack, not `pichenettes/eurorack`, and Marbles' files differ between
 * them. Read that before changing what this module does.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_MARBLES_SPEC } from "../core/audio_specs_vc1.js";

export const audioVcvMarblesPlugin = audioNodePlugin(VCV_MARBLES_SPEC);
