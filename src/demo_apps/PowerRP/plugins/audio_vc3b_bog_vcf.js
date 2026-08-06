/**
 * Bogaudio VCF — the ported `Bogaudio-VCF` as a PowerRP node widget.
 *
 * FILTER family (cool teal header): it shapes a spectrum that already exists.
 *
 * Bogaudio's multimode filter, and the only one here with a CONTINUOUS slope: twelve parallel Butterworth filters crossfaded by one knob.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_BOG_VCF_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_BOG_VCF_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvBogVcfPlugin = audioNodePlugin(VCV_BOG_VCF_SPEC);
