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
import { nodeCounterPlugin } from "./node_counter.js";
import { nodeDelayPlugin } from "./node_delay.js";
// ── THE FRAME DOMAIN (core/exec_frame.js) ───────────────────────────────────
// The four below live on the PER-FRAME axis rather than the slide-boundary one, and
// the split is the only thing that distinguishes them from their neighbours above:
// a Schmitt trigger and an On Threshold ask the same question, one of a continuous
// sample stream and one of two slide boundaries. They are in this barrel rather than
// a second one because they are the same FAMILY — trigger nodes, one Inspector
// category, one palette group — and a reader looking for "the trigger roster" must
// find one list, not two.
import { nodeSchmittPlugin } from "./node_schmitt.js";
import { nodeIncrementPlugin } from "./node_increment.js";
import { nodeSetVarPlugin } from "./node_set_var.js";
import { nodeCustomPlugin } from "./node_custom.js";

/** Every trigger node, ordered as a chain reads: the EVENTS that start one, the ones
 *  that DO something, then the ones that shape control flow — slide-domain first,
 *  then the per-frame four. */
export const execPlugins = [
  nodeOnRevealPlugin,
  nodeOnThresholdPlugin,
  nodeSetPropertyPlugin,
  nodeCounterPlugin,
  nodeSequencePlugin,
  nodeGatePlugin,
  nodeDelayPlugin,
  nodeSchmittPlugin,
  nodeIncrementPlugin,
  nodeSetVarPlugin,
  nodeCustomPlugin,
];
