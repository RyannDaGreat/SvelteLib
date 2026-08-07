/**
 * Bogaudio PolyCon8 — the ported `Bogaudio-PolyCon8` as a PowerRP node widget.
 *
 * MODULATION family: it shapes or routes a control signal rather than making one.
 *
 * Eight constant voltages. In Rack they are one polyphonic cable; here they are eight outputs, which is the same information with the bundling removed.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_POLYCON8_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_POLYCON8_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvPolycon8Plugin = audioNodePlugin(VCV_POLYCON8_SPEC);
