/**
 * Bogaudio Sums — the ported `Bogaudio-Sums` as a PowerRP node widget.
 *
 * MODULATION family: it shapes or routes a control signal rather than making one.
 *
 * a+b, a-b, max, min and -c at once. Max and min are logic on analogue values, which is the half worth having.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_SUMS_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_SUMS_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvSumsPlugin = audioNodePlugin(VCV_SUMS_SPEC);
