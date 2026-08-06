/**
 * Bogaudio PEQ — the ported `Bogaudio-PEQ` as a PowerRP node widget.
 *
 * FILTER family (cool teal header): it shapes a spectrum that already exists.
 *
 * Bogaudio's PEQ / PEQ6 / PEQ14 as one node — N Butterworth bands in PARALLEL, each with its own level, centre and output. The band count is a construct knob, not a fork.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_PEQ_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_PEQ_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvPeqPlugin = audioNodePlugin(VCV_PEQ_SPEC);
