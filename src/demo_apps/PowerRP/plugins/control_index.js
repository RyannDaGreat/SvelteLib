/**
 * THE CONTROL NODE ROSTER — every hand-played input widget, in one array.
 *
 * A BARREL, for the reason plugins/audio_index.js states: plugins/index.js is the
 * file every widget workstream edits, so a family that lands N nodes should cost
 * it ONE import line rather than N — N lines of conflict surface for whoever
 * lands next.
 *
 * A hand-written list rather than a glob, also for that file's reason: core/ and
 * the test sweeps run in BARE NODE where `import.meta.glob` does not exist, and a
 * literal list makes "registered" something you can read instead of execute.
 */

import { nodeKnobPlugin } from "./node_knob.js";
import { nodeSliderPlugin } from "./node_slider.js";
import { nodeButtonPlugin } from "./node_button.js";
import { nodeKeyboardPlugin } from "./node_keyboard.js";
import { nodePianoRollPlugin } from "./node_piano_roll.js";
import { nodeMidiClipPlugin } from "./node_midi_clip.js";
import { nodeAbcPlugin } from "./node_abc.js";

/** Every control-source node, in increasing order of what they express: one
 *  number, one number, one event, many notes, a whole phrase — and then the two
 *  MIDI sources, which express a phrase in TIME (starts, lengths, velocities) and
 *  put it on a `midi` cable rather than on the audio thread. The last two differ
 *  from each other only in how the phrase is AUTHORED (drawn vs typed); their
 *  output is the same stream, deliberately, so either can drive the same patch. */
export const controlPlugins = [nodeKnobPlugin, nodeSliderPlugin, nodeButtonPlugin, nodeKeyboardPlugin, nodePianoRollPlugin, nodeMidiClipPlugin, nodeAbcPlugin];
