/**
 * THE VC-7a NODE ROSTER — the twelve ported clocking and logic plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import and
 * one spread there instead of twelve of each, in the file every widget workstream
 * edits. A SEPARATE barrel rather than twelve more lines in the first because several
 * agents land ported module sets concurrently (R7 Wave 3 Phase 3) and that file would
 * be twelve merge conflicts wide.
 *
 * FILENAMES CARRY THE BLOCK ID (`audio_vc7a_*`) WHILE TYPE STRINGS CARRY THE SOURCE
 * (`audio_vcv_clkd`). The type says "a VCV Rack node", which is what a saved document
 * should record and what every VCV block shares; the FILE prefix exists so that a
 * `git` pathspec like `plugins/audio_vc7a_*` cannot reach a sibling block's untracked
 * work — not hypothetical, a glob commit swept six of another agent's files earlier in
 * this round.
 *
 * A literal list, not a glob: core/ and cli/ run in BARE NODE where `import.meta.glob`
 * does not exist. Forgetting a line here is LOUD rather than quiet —
 * tests/port_vc7a_test.js asserts this array covers `BLOCK_SPECS` exactly, so a module
 * registered in one and not the other reds the suite instead of silently not appearing
 * in the palette.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must spread
 * `BLOCK_PLUGINS`, or none of these twelve reach the palette.
 */

import { audioVcvClkdPlugin } from "./audio_vc7a_clkd.js";
import { audioVcvClockDividerPlugin } from "./audio_vc7a_clock_divider.js";
import { audioVcvVcFrequencyDividerMkIIPlugin } from "./audio_vc7a_vc_freq_div_mk2.js";
import { audioVcvGateSequencer8Plugin } from "./audio_vc7a_gate_sequencer8.js";
import { audioVcvBurstGeneratorPlugin } from "./audio_vc7a_burst_generator.js";
import { audioVcvEventTimerPlugin } from "./audio_vc7a_event_timer.js";
import { audioVcvSampleAndHoldPlugin } from "./audio_vc7a_sample_and_hold.js";
import { audioVcvSampleAndHold2Plugin } from "./audio_vc7a_sample_and_hold2.js";
import { audioVcvBooleanAndPlugin } from "./audio_vc7a_boolean_and.js";
import { audioVcvBooleanXorPlugin } from "./audio_vc7a_boolean_xor.js";
import { audioVcvBusRoute2Plugin } from "./audio_vc7a_bus_route2.js";
import { audioVcvFadePlugin } from "./audio_vc7a_fade.js";

/** Every VC-7a plugin, in `core/audio_specs_vc7a.BLOCK_SPECS` order (modulation then
 *  effect), which is also the order they appear in the palette. */
export const BLOCK_PLUGINS = [
  audioVcvClkdPlugin,
  audioVcvClockDividerPlugin,
  audioVcvVcFrequencyDividerMkIIPlugin,
  audioVcvGateSequencer8Plugin,
  audioVcvBurstGeneratorPlugin,
  audioVcvEventTimerPlugin,
  audioVcvSampleAndHoldPlugin,
  audioVcvSampleAndHold2Plugin,
  audioVcvBooleanAndPlugin,
  audioVcvBooleanXorPlugin,
  audioVcvBusRoute2Plugin,
  audioVcvFadePlugin,
];
