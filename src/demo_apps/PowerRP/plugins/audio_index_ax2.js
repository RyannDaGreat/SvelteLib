/**
 * THE AX-2 NODE ROSTER — the ten ported Axoloti oscillator / LFO / noise
 * plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import
 * and one spread there instead of ten of each, in the file every widget
 * workstream edits. A SECOND barrel rather than ten more lines in the first
 * because five agents are landing ported module sets concurrently (R7 Wave 3
 * Phase 3) and that file would be ten merge conflicts wide.
 *
 * FILENAMES CARRY THE BLOCK NUMBER (`audio_ax2_*`) WHILE TYPE STRINGS DO NOT
 * (`audio_ax_osc`). The type says "an Axoloti node", which is what a saved
 * document should record and what every ported block shares; the FILE prefix
 * exists so that a `git` pathspec like `plugins/audio_ax2_*` cannot reach a
 * sibling block's untracked work. That is not hypothetical — a glob commit
 * earlier today swept six of another agent's files, and AX-3 renamed for the
 * same reason.
 *
 * A literal list, not a glob: core/ and cli/ run in BARE NODE where
 * `import.meta.glob` does not exist, and tests/port_ax2_test.js sweeps
 * AUDIO_SPECS_AX2 there. Forgetting a line here is LOUD rather than quiet — the
 * spec sweep asserts this array covers that one exactly, so a module registered
 * in one and not the other reds the suite instead of silently not appearing.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must
 * spread `BLOCK_PLUGINS`, or none of these ten reach the palette.
 */

import { audioAxOscPlugin } from "./audio_ax2_osc.js";
import { audioAxSupersawPlugin } from "./audio_ax2_supersaw.js";
import { audioAxNoisePlugin } from "./audio_ax2_noise.js";
import { audioAxPhasorPlugin } from "./audio_ax2_phasor.js";
import { audioAxLfsrBurstPlugin } from "./audio_ax2_lfsr_burst.js";
import { audioAxLfoPlugin } from "./audio_ax2_lfo.js";
import { audioAxRandPlugin } from "./audio_ax2_rand.js";
import { audioAxRandPinkPlugin } from "./audio_ax2_rand_pink.js";
import { audioAxPulseDecayPlugin } from "./audio_ax2_pulse_decay.js";
import { audioAxLfsrSeqPlugin } from "./audio_ax2_lfsr_seq.js";

/** Every AX-2 plugin, in core/audio_specs_ax2.AUDIO_SPECS_AX2 order (sources
 *  then modulation), which is also the order they appear in the palette. */
export const BLOCK_PLUGINS = [
  audioAxOscPlugin,
  audioAxSupersawPlugin,
  audioAxNoisePlugin,
  audioAxPhasorPlugin,
  audioAxLfsrBurstPlugin,
  audioAxLfoPlugin,
  audioAxRandPlugin,
  audioAxRandPinkPlugin,
  audioAxPulseDecayPlugin,
  audioAxLfsrSeqPlugin,
];
