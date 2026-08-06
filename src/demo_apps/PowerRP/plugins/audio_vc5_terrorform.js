/**
 * Terrorform — the ported `terrorform` as a PowerRP node widget.
 *
 * SOURCE family (warm amber header): it generates signal from nothing.
 *
 * A wavetable oscillator whose real instrument is its twenty-seven phase shapers.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_TERRORFORM_SPEC in
 * core/audio_specs_vc5.js, which also carries this node's DERIVATION RECORD: the
 * source (or, for the two closed-source modules, the DOCUMENTS), the commit it was
 * read at, which code block the recurrence came from, and every deliberate
 * deviation by name. The recurrence itself and the arithmetic are in
 * synth/vc5_kernels.js. Read both before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_TERRORFORM_SPEC } from "../core/audio_specs_vc5.js";

export const audioVcvTerrorformPlugin = audioNodePlugin(VCV_TERRORFORM_SPEC);
