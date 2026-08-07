/**
 * Bogaudio XCO — the ported `Bogaudio-XCO` as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it makes a signal out of nothing.
 *
 * The full-size oscillator: four waveforms off one phase accumulator, each with its own phase, modifier and mix level, plus a self-normalising mix bus. The sine can phase-modulate itself.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_XCO_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_XCO_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvXcoPlugin = audioNodePlugin(VCV_XCO_SPEC);
