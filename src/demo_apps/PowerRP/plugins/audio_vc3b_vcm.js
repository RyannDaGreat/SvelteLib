/**
 * Bogaudio VCM — the ported `Bogaudio-VCM` as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * Bogaudio's four-channel voltage-controlled mixer. Its master level is SQUARED - their bug, reproduced deliberately; the spec's help says so.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_VCM_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_VCM_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvVcmPlugin = audioNodePlugin(VCV_VCM_SPEC);
