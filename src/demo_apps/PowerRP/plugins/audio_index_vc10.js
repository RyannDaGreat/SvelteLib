/**
 * THE VC-10 NODE ROSTER — the fifteen ported squinkylabs / Vult / Instruō
 * plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import
 * and one spread there instead of fifteen of each, in the file every widget
 * workstream edits. A SECOND barrel rather than fifteen more lines in the first
 * because several agents land ported module sets concurrently (R7 Wave 3
 * Phase 3) and that file would be fifteen merge conflicts wide.
 *
 * FILENAMES CARRY THE BLOCK NUMBER (`audio_vc10_*`) WHILE TYPE STRINGS DO NOT
 * (`audio_vcv_super`). The type says "a VCV Rack node", which is what a saved
 * document should record and what every ported block of this corpus shares; the
 * FILE prefix exists so that a `git` pathspec like `plugins/audio_vc10_*` cannot
 * reach a sibling block's untracked work. That is not hypothetical — a glob
 * commit in an earlier wave swept six of another agent's files.
 *
 * A literal list, not a glob: core/ and cli/ run in BARE NODE where
 * `import.meta.glob` does not exist. Forgetting a line here is LOUD rather than
 * quiet — tests/port_vc10_test.js asserts this array covers `BLOCK_SPECS`
 * exactly, so a module registered in one and not the other reds the suite
 * instead of silently not appearing in the palette.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must
 * spread `BLOCK_PLUGINS`, or none of these fifteen reach the palette.
 */

import { audioVcvSuperPlugin } from "./audio_vc10_super.js";
import { audioVcvWvcoPlugin } from "./audio_vc10_wvco.js";
import { audioVcvBleakPlugin } from "./audio_vc10_bleak.js";
import { audioVcvBasalPlugin } from "./audio_vc10_basal.js";
import { audioVcvVessekPlugin } from "./audio_vc10_vessek.js";
import { audioVcvSaichPlugin } from "./audio_vc10_saich.js";
import { audioVcvF2Plugin } from "./audio_vc10_f2.js";
import { audioVcvFiltPlugin } from "./audio_vc10_filt.js";
import { audioVcvTangentsPlugin } from "./audio_vc10_tangents.js";
import { audioVcvUnstabilePlugin } from "./audio_vc10_unstabile.js";
import { audioVcvLateralusPlugin } from "./audio_vc10_lateralus.js";
import { audioVcvFreqShifterPlugin } from "./audio_vc10_freqshifter.js";
import { audioVcvAthruPlugin } from "./audio_vc10_athru.js";
import { audioVcvOchdPlugin } from "./audio_vc10_ochd.js";
import { audioVcvCaudalPlugin } from "./audio_vc10_caudal.js";

/** Every VC-10 plugin, in core/audio_specs_vc10.BLOCK_SPECS order (sources,
 *  then filters, then effects and modulation), which is also the order they
 *  appear in the palette. */
export const BLOCK_PLUGINS = [
  audioVcvSuperPlugin,
  audioVcvWvcoPlugin,
  audioVcvBleakPlugin,
  audioVcvBasalPlugin,
  audioVcvVessekPlugin,
  audioVcvSaichPlugin,
  audioVcvF2Plugin,
  audioVcvFiltPlugin,
  audioVcvTangentsPlugin,
  audioVcvUnstabilePlugin,
  audioVcvLateralusPlugin,
  audioVcvFreqShifterPlugin,
  audioVcvAthruPlugin,
  audioVcvOchdPlugin,
  audioVcvCaudalPlugin,
];
