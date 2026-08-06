/**
 * Axoloti Biquad — the ported `filter/lp` / `bp` / `hp` as a PowerRP node widget.
 *
 * FILTER family (cool teal header): it shapes a spectrum that already exists.
 *
 * Its resonance does not change its level: the numerator carries an extra 1/(2Q) the RBJ cookbook does not.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here AX_BIQUAD_SPEC in
 * core/audio_specs_ax3.js, which also carries this node's DERIVATION RECORD: the
 * source object, the commit it was read at, which code block the recurrence came
 * from, the recurrence in float, and every deliberate deviation by name. Read that
 * record before changing anything about how this filter sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_BIQUAD_SPEC } from "../core/audio_specs_ax3.js";

export const audioAx3BiquadPlugin = audioNodePlugin(AX_BIQUAD_SPEC);
