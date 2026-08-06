/**
 * Axoloti Butterworth 10 — the ported `tiar/filter/Butt10` as a PowerRP node widget.
 *
 * FILTER family (cool teal header): it shapes a spectrum that already exists.
 *
 * Ten poles, 60 dB/octave, ten tabulated cutoffs. A brick wall, no resonance.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here AX_BUTTERWORTH10_SPEC in
 * core/audio_specs_ax3.js, which also carries this node's DERIVATION RECORD: the
 * source object, the commit it was read at, which code block the recurrence came
 * from, the recurrence in float, and every deliberate deviation by name. Read that
 * record before changing anything about how this filter sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_BUTTERWORTH10_SPEC } from "../core/audio_specs_ax3.js";

export const audioAx3Butterworth10Plugin = audioNodePlugin(AX_BUTTERWORTH10_SPEC);
