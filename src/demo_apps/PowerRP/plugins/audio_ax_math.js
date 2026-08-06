/**
 * MATH — the `axMath` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). math/PLUS.axo @ 78cb74bd0b11,
 * <code.krate> of each.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_MATH_SPEC.
 *
 * Axoloti's whole arithmetic shelf as ONE node — twenty operations on two signals, from a plain sum to an antialiased ring modulator. Their library spends twenty-one object files and sixty-odd generated overloads on this; the operation is a knob here because the port types are already checked by the wire.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_MATH_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_MATH_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxMathPlugin = audioNodePlugin(AX_MATH_SPEC);
