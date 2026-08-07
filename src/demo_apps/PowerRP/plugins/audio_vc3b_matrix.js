/**
 * Bogaudio Switch18, Switch88 and Matrix88 — THREE nodes in one file, which is
 * the exception to this block's one-file-per-node habit and is justified rather
 * than convenient.
 *
 * MODULATION family: they route and mix control and audio signals rather than
 * making one.
 *
 * ── WHY THREE PLUGINS SHARE A FILE ──────────────────────────────────────────
 * Bogaudio's own three modules are `configMatrixModule(ins, outs, …)` and a panel
 * — one `MatrixModule` engine at three sizes, with the Switch pair drawing a
 * three-position switch where Matrix88 draws a knob. `MatrixKernel` in
 * synth/vc3b_kernels.js is that one engine, and the three specs differ in `ins`,
 * `outs` and the crosspoint knob's STEP. Splitting them into three two-line files
 * would suggest three implementations where there is one, and the reader who opens
 * `audio_vc3b_switch88.js` looking for the difference would find nothing in it.
 *
 * The DERIVATION RECORD — the C++ files, the commit, the recurrence in float and
 * every named deviation (D15, the expanders that are not ported, most of all) — is
 * `MatrixKernel`'s docblock. Read it before changing anything about how these
 * sound.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_MATRIX88_SPEC, VCV_SWITCH18_SPEC, VCV_SWITCH88_SPEC } from "../core/audio_specs_vc3b.js";

/** ONE input to eight outputs, each route off / through / inverted. */
export const audioVcvSwitch18Plugin = audioNodePlugin(VCV_SWITCH18_SPEC);

/** An 8×8 routing matrix whose crosspoints snap to those same three positions. */
export const audioVcvSwitch88Plugin = audioNodePlugin(VCV_SWITCH88_SPEC);

/** The same 8×8 matrix with CONTINUOUS bipolar crosspoints — the one you automate. */
export const audioVcvMatrix88Plugin = audioNodePlugin(VCV_MATRIX88_SPEC);
