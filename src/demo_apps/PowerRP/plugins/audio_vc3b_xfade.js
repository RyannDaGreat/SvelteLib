/**
 * Bogaudio XFade — the ported `Bogaudio-XFade` as a PowerRP node widget.
 *
 * MODULATION family (muted blue header): it drives other nodes rather than being heard.
 *
 * Bogaudio's crossfader with a CURVE control that decides whether the middle of the sweep is silence, a blend, or both sides at full level.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_XFADE_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_XFADE_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvXfadePlugin = audioNodePlugin(VCV_XFADE_SPEC);
