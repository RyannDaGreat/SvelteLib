/**
 * Bogaudio LVCO — the ported `Bogaudio-LVCO` as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it makes a signal out of nothing.
 *
 * The 3 HP oscillator: one waveform at a time, and the SAME anti-aliased engine as the full-size VCO — the kernel is literally that one, wrapped.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_LVCO_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_LVCO_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvLvcoPlugin = audioNodePlugin(VCV_LVCO_SPEC);
