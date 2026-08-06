/**
 * Plateau — the ported `plateau` as a PowerRP node widget.
 *
 * EFFECT family (cool violet header): it processes a signal that already exists.
 *
 * Valley's Dattorro plate reverb — the module twenty-one of twenty-five surveyed VCV patches end in.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_PLATEAU_SPEC in
 * core/audio_specs_vc5.js, which also carries this node's DERIVATION RECORD: the
 * source (or, for the two closed-source modules, the DOCUMENTS), the commit it was
 * read at, which code block the recurrence came from, and every deliberate
 * deviation by name. The recurrence itself and the arithmetic are in
 * synth/vc5_kernels.js. Read both before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_PLATEAU_SPEC } from "../core/audio_specs_vc5.js";

export const audioVcvPlateauPlugin = audioNodePlugin(VCV_PLATEAU_SPEC);
