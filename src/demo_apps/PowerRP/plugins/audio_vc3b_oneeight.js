/**
 * Bogaudio OneEight — the ported `Bogaudio-OneEight` as a PowerRP node widget.
 *
 * MODULATION family: it shapes or routes a control signal rather than making one.
 *
 * An eight-way sequential switch, and an eight-step gate sequencer when nothing is patched to its input.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_ONEEIGHT_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_ONEEIGHT_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvOneeightPlugin = audioNodePlugin(VCV_ONEEIGHT_SPEC);
