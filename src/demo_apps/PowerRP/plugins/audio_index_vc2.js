/**
 * THE VC-2 NODE ROSTER — the sixteen ported VCV Rack Fundamental and Core
 * plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import
 * and one spread there instead of sixteen of each, in the file every widget
 * workstream edits. A SEPARATE barrel rather than sixteen more lines in the first
 * because several agents land ported module sets concurrently (R7 Wave 3 Phase 3)
 * and that file would be sixteen merge conflicts wide.
 *
 * FILENAMES CARRY THE BLOCK NUMBER (`audio_vc2_*`) WHILE TYPE STRINGS CARRY THE
 * LIBRARY (`audio_vcv_vcf`). The type says "a VCV Rack node", which is what a
 * saved document should record and what every VCV block shares; the FILE prefix
 * exists so that a `git` pathspec like `plugins/audio_vc2_*` cannot reach a
 * sibling block's untracked work. That is not hypothetical — a glob commit in an
 * earlier wave swept six of another agent's files, and AX-2/AX-3 renamed for the
 * same reason.
 *
 * A literal list, not a glob: core/ and cli/ run in BARE NODE where
 * `import.meta.glob` does not exist, and tests/port_vc2_test.js sweeps
 * `BLOCK_SPECS` there. Forgetting a line here is LOUD rather than quiet — that
 * test asserts this array covers `core/audio_specs_vc2.BLOCK_SPECS` exactly, so a
 * module registered in one and not the other reds the suite instead of silently
 * not appearing in the palette.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must
 * spread `BLOCK_PLUGINS`, or none of these sixteen reach the palette.
 */

import { audioVcvNoisePlugin } from "./audio_vc2_noise.js";
import { audioVcvVcfPlugin } from "./audio_vc2_vcf.js";
import { audioVcvQuantizerPlugin } from "./audio_vc2_quantizer.js";
import { audioVcvDelayPlugin } from "./audio_vc2_delay.js";
import { audioVcvSequentialSwitch2Plugin } from "./audio_vc2_switch2.js";
import { audioVcvRescalePlugin } from "./audio_vc2_rescale.js";
import { audioVcvVcaPlugin } from "./audio_vc2_vca.js";
import { audioVcvAdsrPlugin } from "./audio_vc2_adsr.js";
import { audioVcvLfoPlugin } from "./audio_vc2_lfo.js";
import { audioVcvOctavePlugin } from "./audio_vc2_octave.js";
import { audioVcvVcMixerPlugin } from "./audio_vc2_vcmixer.js";
import { audioVcvRandomPlugin } from "./audio_vc2_random.js";
import { audioVcvSeq3Plugin } from "./audio_vc2_seq3.js";
import { audioVcvComparePlugin } from "./audio_vc2_compare.js";
import { audioVcvSumPlugin } from "./audio_vc2_sum.js";
import { audioVcvAudioInterfacePlugin } from "./audio_vc2_audiointerface.js";

/** Every VC-2 plugin, in `core/audio_specs_vc2.BLOCK_SPECS` order (source,
 *  filters, effects, modulation, output), which is also the order they appear in
 *  the palette. */
export const BLOCK_PLUGINS = [
  audioVcvNoisePlugin,
  audioVcvVcfPlugin,
  audioVcvQuantizerPlugin,
  audioVcvDelayPlugin,
  audioVcvSequentialSwitch2Plugin,
  audioVcvRescalePlugin,
  audioVcvVcaPlugin,
  audioVcvAdsrPlugin,
  audioVcvLfoPlugin,
  audioVcvOctavePlugin,
  audioVcvVcMixerPlugin,
  audioVcvRandomPlugin,
  audioVcvSeq3Plugin,
  audioVcvComparePlugin,
  audioVcvSumPlugin,
  audioVcvAudioInterfacePlugin,
];
