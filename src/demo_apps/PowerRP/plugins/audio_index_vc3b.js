/**
 * THE VC-3b NODE ROSTER — the twelve ported Bogaudio plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import
 * and one spread there instead of twelve of each, in the file every widget
 * workstream edits. A SEPARATE barrel rather than twelve more lines in the first
 * because several agents land ported module sets concurrently (R7 Wave 3 Phase 3)
 * and that file would be twelve merge conflicts wide.
 *
 * FILENAMES CARRY THE BLOCK ID (`audio_vc3b_*`) WHILE TYPE STRINGS CARRY THE
 * SOURCE (`audio_vcv_peq`). The type says "a VCV Rack node", which is what a saved
 * document should record and what every VCV block shares; the FILE prefix exists
 * so that a `git` pathspec like `plugins/audio_vc3b_*` cannot reach a sibling
 * block's untracked work — not hypothetical, a glob commit swept six of another
 * agent's files earlier in this round.
 *
 * A literal list, not a glob: core/ and cli/ run in BARE NODE where
 * `import.meta.glob` does not exist. Forgetting a line here is LOUD rather than
 * quiet — tests/port_vc3b_test.js asserts this array covers `BLOCK_SPECS` exactly,
 * so a module registered in one and not the other reds the suite instead of
 * silently not appearing in the palette.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must
 * spread `BLOCK_PLUGINS`, or none of these twelve reach the palette.
 */

import { audioVcvBogVcoPlugin } from "./audio_vc3b_bog_vco.js";
import { audioVcvPeqPlugin } from "./audio_vc3b_peq.js";
import { audioVcvBogVcfPlugin } from "./audio_vc3b_bog_vcf.js";
import { audioVcvPressorPlugin } from "./audio_vc3b_pressor.js";
import { audioVcvSampleholdPlugin } from "./audio_vc3b_samplehold.js";
import { audioVcvWalkPlugin } from "./audio_vc3b_walk.js";
import { audioVcvBogVcaPlugin } from "./audio_vc3b_bog_vca.js";
import { audioVcvVcmPlugin } from "./audio_vc3b_vcm.js";
import { audioVcvXfadePlugin } from "./audio_vc3b_xfade.js";
import { audioVcvOffsetPlugin } from "./audio_vc3b_offset.js";
import { audioVcvSwitchPlugin } from "./audio_vc3b_switch.js";
import { audioVcvStackPlugin } from "./audio_vc3b_stack.js";

/** Every VC-3b plugin, in `core/audio_specs_vc3b.BLOCK_SPECS` order (source,
 *  filters, effect, then modulation and utility), which is also the order they
 *  appear in the palette. */
export const BLOCK_PLUGINS = [
  audioVcvBogVcoPlugin,
  audioVcvPeqPlugin,
  audioVcvBogVcfPlugin,
  audioVcvPressorPlugin,
  audioVcvSampleholdPlugin,
  audioVcvWalkPlugin,
  audioVcvBogVcaPlugin,
  audioVcvVcmPlugin,
  audioVcvXfadePlugin,
  audioVcvOffsetPlugin,
  audioVcvSwitchPlugin,
  audioVcvStackPlugin,
];
