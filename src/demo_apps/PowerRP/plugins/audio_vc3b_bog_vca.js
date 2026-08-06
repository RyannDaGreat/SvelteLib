/**
 * Bogaudio VCA — the ported `Bogaudio-VCA` as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * Bogaudio's dual VCA. The decibel/linear taper switch is the module: half-way up is -30 dB in one mode and -6 dB in the other.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_BOG_VCA_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_BOG_VCA_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvBogVcaPlugin = audioNodePlugin(VCV_BOG_VCA_SPEC);
