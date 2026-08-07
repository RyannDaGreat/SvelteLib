/**
 * AX MIDI KEYBOARD — the `axMidiKeyb` engine module as a PowerRP node widget.
 *
 * A PORTED AXOLOTI NODE (AX-1). midi/in/keyb.axo (+ midi/in/keyb zone lru.axo) @ 78cb74bd0b11,
 * <code.krate> + <code.midihandler>.
 * The recurrence, its integer source and its measured error live in
 * synth/ax1_dsp.js; the full derivation record is on AX_MIDI_KEYB_SPEC.
 *
 * Axoloti's `midi/in/keyb`, and THE ADAPTOR THAT MAKES AN AXOLOTI PATCH PLAYABLE: PowerRP's
 * Keyboard widget emits HERTZ and every Axoloti pitch port reads SEMITONES FROM E4, so
 * wiring the two together directly transposes A4 to semitone 440 (manifest
 * § R7-AXO-TRAPS trap 1).
 *
 * ── WHY THIS FILE IS TWO LINES ──────────────────────────────────────────────
 * Every audio node has the SAME shape — a family card, a port list, knob rows on
 * flat equation-slot keys, `inputs: {}` so copies remap, a height sized from its own
 * ports — and that shape lives ONCE in core/audio_nodes.js. What differs per module
 * is DATA, and that data is AX_MIDI_KEYB_SPEC in core/audio_specs_ax1.js.
 *
 * So: read core/audio_specs_ax1.js to change what this module IS, and
 * core/audio_nodes.js to change what every audio module DOES.
 */

import { audioNodePlugin } from "../core/audio_nodes.js";
import { AX_MIDI_KEYB_SPEC } from "../core/audio_specs_ax1.js";

export const audioAxMidiKeybPlugin = audioNodePlugin(AX_MIDI_KEYB_SPEC);
