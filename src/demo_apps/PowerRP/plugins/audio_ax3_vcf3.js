/**
 * Axoloti VCF3 — the ported `filter/vcf3` as a PowerRP node widget.
 *
 * FILTER family (cool teal header): it shapes a spectrum that already exists.
 *
 * The OLDER biquad, and a genuinely different filter: no constant-peak normalisation, and a [2, 1, 2] numerator.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here AX_VCF3_SPEC in
 * core/audio_specs_ax3.js, which also carries this node's DERIVATION RECORD: the
 * source object, the commit it was read at, which code block the recurrence came
 * from, the recurrence in float, and every deliberate deviation by name. Read that
 * record before changing anything about how this filter sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_VCF3_SPEC } from "../core/audio_specs_ax3.js";

export const audioAx3Vcf3Plugin = audioNodePlugin(AX_VCF3_SPEC);
