/**
 * Bogaudio PEQ6 — the ported `Bogaudio-PEQ6` as a PowerRP node widget.
 *
 * FILTER family (cool teal header): it shapes a spectrum that already exists.
 *
 * Their six-band parametric EQ as their panel draws it — and unlike the collapsed PEQ node, every band keeps its OWN frequency CV inlet and attenuverter, which is what makes one band sweepable while the rest sit still.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_PEQ6_SPEC in
 * core/audio_specs_vc3b.js, whose `help` sentences point at the DERIVATION RECORD
 * in synth/vc3b_kernels.js: the Bogaudio module, the C++ file and function, the
 * commit it was read at, the recurrence in float, and every deliberate deviation
 * by name. Read that record before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_PEQ6_SPEC } from "../core/audio_specs_vc3b.js";

export const audioVcvPeq6Plugin = audioNodePlugin(VCV_PEQ6_SPEC);
