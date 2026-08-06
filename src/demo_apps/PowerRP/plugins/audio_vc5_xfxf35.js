/**
 * XFX F-35 — the ported `xfxf35` as a PowerRP node widget.
 *
 * FILTER family (cool teal header): it shapes a spectrum that already exists.
 *
 * Twenty-six of Blamsoft's thirty-five ZDF filter modes, oversampled 4x. BEHAVIOUR-DERIVED: no source exists.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape and that shape lives ONCE in
 * core/audio_nodes.js. What differs per module is DATA — here VCV_XFXF35_SPEC in
 * core/audio_specs_vc5.js, which also carries this node's DERIVATION RECORD: the
 * source (or, for the two closed-source modules, the DOCUMENTS), the commit it was
 * read at, which code block the recurrence came from, and every deliberate
 * deviation by name. The recurrence itself and the arithmetic are in
 * synth/vc5_kernels.js. Read both before changing anything about how this sounds.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_XFXF35_SPEC } from "../core/audio_specs_vc5.js";

export const audioVcvXfxf35Plugin = audioNodePlugin(VCV_XFXF35_SPEC);
