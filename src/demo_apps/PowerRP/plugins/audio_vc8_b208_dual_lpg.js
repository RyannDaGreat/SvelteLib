/**
 * VCV b208 Dual LPG — the `vcvB208DualLpg` engine module as a PowerRP node widget.
 *
 * FILTER family (cool blue header): it shapes signal it is given.
 *
 * Four Buchla low-pass gates. The one node in this block whose ALGORITHM is published — Parker and D'Angelo's DAFx-13 model, which the vendor's own changelog names as its source.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * The SHAPE of every audio node — family card, port list, knob rows on flat
 * equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — lives ONCE in core/audio_nodes.js. What differs per module is DATA, and
 * that data is VCV_B208_DUAL_LPG_SPEC in core/audio_specs_vc8.js.
 *
 * ── AND WHERE THE SOUND IS, AND WHAT IT IS NOT ──────────────────────────────
 * **NYSTHI SHIPS NO SOURCE AT ANY REF**, so this node is not a port — it is an
 * approximation built from the plugin's own CHANGELOG, one published DSP paper
 * and the demo patches' cables. `synth/vc8_kernels.js` carries the full
 * derivation record: which document, read on which date, what fixed the PORT
 * LAYOUT separately from the behaviour, the recurrence in float, and every
 * deviation and GUESS by number. Read that before changing what this SOUNDS like,
 * and do not describe it as a port.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { VCV_B208_DUAL_LPG_SPEC } from "../core/audio_specs_vc8.js";

export const audioVcvB208DualLpgPlugin = audioNodePlugin(VCV_B208_DUAL_LPG_SPEC);
