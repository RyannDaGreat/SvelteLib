/**
 * AX MIDI BEND — the `axMidiBend` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). midi/in/bend.axo @ 78cb74bd0b11,
 * <code.krate> + <code.midihandler>.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_MIDI_BEND_SPEC.
 *
 * Axoloti's `midi/in/bend`. Its output is a PITCH in semitones and its full swing is ±64
 * of them, because a frac32 pitch of 1.0 IS 64 semitones — which is why every patch that
 * uses it divides.
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_MIDI_BEND_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_MIDI_BEND_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxMidiBendPlugin = audioNodePlugin(AX_MIDI_BEND_SPEC);
