/**
 * Bogaudio VCO — the ported `Bogaudio-VCO` as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing.
 *
 * Bogaudio's anti-aliased analogue-modelled oscillator: four phase-locked waveforms, minBLEP corrections AND 8x oversampling with a CIC decimator.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_BOG_VCO_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_BOG_VCO_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvBogVcoPlugin = audioNodePlugin(VCV_BOG_VCO_SPEC);
