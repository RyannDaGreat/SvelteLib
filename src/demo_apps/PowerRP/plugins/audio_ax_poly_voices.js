/**
 * AX POLY VOICES — the `axPolyVoices` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). patch/patcher.axo @ 78cb74bd0b11 is an EMPTY SHELL with
 * no code at all; the allocator is GENERATED, at
 * axoloti/src/main/java/axoloti/codegen/patch/PatchViewCodegen.java:1042-1083
 * (`generatePolyCode`'s `sMidiCode`) @ 46f6e4b383ce.
 * The allocation, transcribed line by line, lives in synth/ax1_dsp.js
 * (`axPolyNoteOn` / `axPolyNoteOff`); the full derivation record is on
 * AX_POLY_VOICES_SPEC.
 *
 * The voice allocator of `patch/patcher poly=N`. IT ALLOCATES; IT DOES NOT REPLICATE —
 * the engine cannot instantiate the graph downstream of a node N times, so one of these
 * drives ONE voice graph. See the spec's deviations for what that costs.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_POLY_VOICES_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_POLY_VOICES_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxPolyVoicesPlugin = audioNodePlugin(AX_POLY_VOICES_SPEC);
