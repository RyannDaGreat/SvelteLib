/**
 * Bogaudio Noise — the ported `Bogaudio-Noise` as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it makes a signal out of nothing.
 *
 * Five colours of noise from five INDEPENDENT generators — white, pink, red, blue and gaussian — plus a rectifier for whatever you patch into it.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_BOG_NOISE_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_BOG_NOISE_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvBogNoisePlugin = audioNodePlugin(VCV_BOG_NOISE_SPEC);
