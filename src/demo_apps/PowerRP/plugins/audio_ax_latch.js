/**
 * LATCH — the `axLatch` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). logic/latch.axo @ 78cb74bd0b11,
 * <code.declaration> + <code.krate>.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_LATCH_SPEC.
 *
 * Copies its input to its output on a rising edge and holds it otherwise. NOT the same node as PowerRP's Sample & Hold: this one arms on a bare `> 0` with no hysteresis, which samples at a different moment on a slow or noisy gate.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_LATCH_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_LATCH_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxLatchPlugin = audioNodePlugin(AX_LATCH_SPEC);
