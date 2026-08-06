/**
 * Just A Phaser — the ported `justaphaser` as a PowerRP node widget.
 *
 * EFFECT family (cool violet header): it processes a signal that already exists.
 *
 * A 4/8/12-stage phaser, three of whose source bugs are what it sounds like.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_JUSTAPHASER_SPEC in
 * core/audio_specs_vc5.js, which also carries this node's DERIVATION RECORD: the
 * source (or, for the two closed-source modules, the DOCUMENTS), the commit it was
 * read at, which code block the recurrence came from, and every deliberate
 * deviation by name. The recurrence itself and the arithmetic are in
 * synth/vc5_kernels.js. Read both before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_JUSTAPHASER_SPEC } from "../core/audio_specs_vc5.js";

export const audioVcvJustaphaserPlugin = audioNodePlugin(VCV_JUSTAPHASER_SPEC);
