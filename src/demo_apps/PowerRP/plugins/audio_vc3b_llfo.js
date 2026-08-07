/**
 * Bogaudio LLFO — the ported `Bogaudio-LLFO` as a PowerRP node widget.
 *
 * MODULATION family: it shapes or routes a control signal rather than making one.
 *
 * The 3 HP LFO: seven waveforms including a seeded random SEQUENCE, plus output sampling and period-relative smoothing.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_LLFO_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_LLFO_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvLlfoPlugin = audioNodePlugin(VCV_LLFO_SPEC);
