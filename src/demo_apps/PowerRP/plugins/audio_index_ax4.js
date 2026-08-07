/**
 * THE AX-4 NODE ROSTER — the eleven ported Axoloti envelope / gain / mix /
 * distortion plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import
 * and one spread there instead of eleven of each, in the file every widget
 * workstream edits. A FOURTH barrel rather than eleven more lines in the first
 * because six agents are landing ported module sets concurrently (R7 Wave 3
 * Phase 3) and that file would be eleven merge conflicts wide.
 *
 * FILENAMES CARRY THE BLOCK NUMBER (`audio_ax4_*`) WHILE TYPE STRINGS DO NOT
 * (`audio_ax_env_adsr`). The type says "an Axoloti node", which is what a saved
 * document should record and what every ported block shares; the FILE prefix
 * exists so that a `git` pathspec like `plugins/audio_ax4_*` cannot reach a
 * sibling block's untracked work. That is not hypothetical — a glob commit in an
 * earlier wave swept six of another agent's files, and AX-2 and AX-3 both
 * renamed for it.
 *
 * A literal list, not a glob: core/ and cli/ run in BARE NODE where
 * `import.meta.glob` does not exist, and tests/port_ax4_test.js sweeps
 * `core/audio_specs_ax4.BLOCK_SPECS` there. Forgetting a line here is LOUD
 * rather than quiet — that sweep asserts this array covers that one exactly, so
 * a module registered in one and not the other reds the suite instead of
 * silently not appearing in the palette.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must
 * spread `BLOCK_PLUGINS`, or none of these eleven reach the palette. The lead
 * applies it; this block may not.
 */

import { audioAxEnvAdsrPlugin } from "./audio_ax4_env_adsr.js";
import { audioAxEnvAhdPlugin } from "./audio_ax4_env_ahd.js";
import { audioAxEnvDecayPlugin } from "./audio_ax4_env_decay.js";
import { audioAxEnvDecayLinearPlugin } from "./audio_ax4_env_decay_linear.js";
import { audioAxVcaStereoPlugin } from "./audio_ax4_vca_stereo.js";
import { audioAxXfadePlugin } from "./audio_ax4_xfade.js";
import { audioAxMixPlugin } from "./audio_ax4_mix.js";
import { audioAxDistSoftPlugin } from "./audio_ax4_dist_soft.js";
import { audioAxDistInfPlugin } from "./audio_ax4_dist_inf.js";
import { audioAxDpSoftClipPlugin } from "./audio_ax4_dp_soft_clip.js";
import { audioAxDpHardClipPlugin } from "./audio_ax4_dp_hard_clip.js";

/** Every AX-4 plugin, in core/audio_specs_ax4.BLOCK_SPECS order (envelopes,
 *  then gain and mix, then distortion), which is also the order they appear in
 *  the palette. */
export const BLOCK_PLUGINS = [
  audioAxEnvAdsrPlugin,
  audioAxEnvAhdPlugin,
  audioAxEnvDecayPlugin,
  audioAxEnvDecayLinearPlugin,
  audioAxVcaStereoPlugin,
  audioAxXfadePlugin,
  audioAxMixPlugin,
  audioAxDistSoftPlugin,
  audioAxDistInfPlugin,
  audioAxDpSoftClipPlugin,
  audioAxDpHardClipPlugin,
];
