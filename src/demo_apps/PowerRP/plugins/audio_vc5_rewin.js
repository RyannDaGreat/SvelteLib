/**
 * rewin — the ported `rewin` as a PowerRP node widget.
 *
 * MODULATION family: it shapes other modules rather than making sound itself.
 *
 * Four V/oct quantisers sharing one twelve-note scale, held as a single twelve-bit mask.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_REWIN_SPEC in
 * core/audio_specs_vc5.js, which also carries this node's DERIVATION RECORD: the
 * source (or, for the two closed-source modules, the DOCUMENTS), the commit it was
 * read at, which code block the recurrence came from, and every deliberate
 * deviation by name. The recurrence itself and the arithmetic are in
 * synth/vc5_kernels.js. Read both before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_REWIN_SPEC } from "../core/audio_specs_vc5.js";

export const audioVcvRewinPlugin = audioNodePlugin(VCV_REWIN_SPEC);
