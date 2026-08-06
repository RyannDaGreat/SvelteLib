/**
 * THE TRIGGER NODE ROSTER — every exec-flow widget, in one array.
 *
 * A BARREL, for the reason plugins/audio_index.js and plugins/control_index.js state:
 * plugins/index.js is the file every widget workstream edits, so a family that lands
 * N nodes should cost it ONE import line rather than N — N lines of conflict surface
 * for whoever lands next.
 *
 * A hand-written list rather than a glob, also for those files' reason: core/ and the
 * test sweeps run in BARE NODE where `import.meta.glob` does not exist, and a literal
 * list makes "registered" something you can read instead of execute.
 */

import { nodeOnRevealPlugin } from "./node_on_reveal.js";
import { nodeOnThresholdPlugin } from "./node_on_threshold.js";
import { nodeSetPropertyPlugin } from "./node_set_property.js";
import { nodeSequencePlugin } from "./node_sequence.js";
import { nodeGatePlugin } from "./node_gate.js";
import { nodeDelayPlugin } from "./node_delay.js";

/** Every trigger node, ordered as a chain reads: the two EVENTS that start one, the
 *  one EFFECT that does something, then the three that shape control flow. */
export const execPlugins = [
  nodeOnRevealPlugin,
  nodeOnThresholdPlugin,
  nodeSetPropertyPlugin,
  nodeSequencePlugin,
  nodeGatePlugin,
  nodeDelayPlugin,
];
