/**
 * THE VC-3a NODE ROSTER — the nine ported Bogaudio plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import
 * and one spread there instead of nine of each, in the file every widget
 * workstream edits. A SEPARATE barrel rather than nine more lines in the first
 * because several agents are landing ported module sets concurrently (R7 Wave 3
 * Phase 3) and that file would be nine merge conflicts wide.
 *
 * FILENAMES CARRY THE BLOCK ID (`audio_vc3a_*`) WHILE TYPE STRINGS DO NOT
 * (`audio_vcv_fmop`). The type says "a VCV Rack node", which is what a saved
 * document should record and what every VCV block shares; the FILE prefix exists
 * so that a `git` pathspec like `plugins/audio_vc3a_*` cannot reach a sibling
 * block's untracked work. That is not hypothetical — a glob commit in Wave 1 swept
 * six of another agent's files, and AX-2 and AX-3 are named the same way for the
 * same reason.
 *
 * TWO TYPES CARRY THEIR PLUGIN NAME AND THE OTHER SEVEN DO NOT.
 * `audio_vcv_bog_lfo` and `audio_vcv_bog_adsr` are `Bogaudio-LFO` and
 * `Bogaudio-ADSR`, whose bare slugs collide with Fundamental's LFO and ADSR —
 * being ported concurrently in another block. The lead's ruling: disambiguate
 * ONLY where a collision is real, because a blanket `bog_` prefix would be a
 * second dialect for the seven modules that do not need one.
 *
 * A literal list, not a glob: core/ and cli/ run in BARE NODE where
 * `import.meta.glob` does not exist, and tests/port_vc3a_test.js sweeps
 * `BLOCK_SPECS` there. Forgetting a line here is LOUD rather than quiet — that
 * test asserts this array covers the spec array exactly, so a module registered
 * in one and not the other reds the suite instead of silently not appearing.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must
 * spread `BLOCK_PLUGINS`, or none of these nine reach the palette.
 */

import { audioVcvFmopPlugin } from "./audio_vc3a_fmop.js";
import { audioVcvBogLfoPlugin } from "./audio_vc3a_bog_lfo.js";
import { audioVcvBogAdsrPlugin } from "./audio_vc3a_bog_adsr.js";
import { audioVcvDadsrhPlugin } from "./audio_vc3a_dadsrh.js";
import { audioVcvAddrseqPlugin } from "./audio_vc3a_addrseq.js";
import { audioVcvEightonePlugin } from "./audio_vc3a_eightone.js";
import { audioVcvBoolPlugin } from "./audio_vc3a_bool.js";
import { audioVcvMix4Plugin } from "./audio_vc3a_mix4.js";
import { audioVcvManualPlugin } from "./audio_vc3a_manual.js";

/** Every VC-3a plugin, in core/audio_specs_vc3a.BLOCK_SPECS order (the source
 *  first, then modulation), which is also the order they appear in the palette. */
export const BLOCK_PLUGINS = [
  audioVcvFmopPlugin,
  audioVcvBogLfoPlugin,
  audioVcvBogAdsrPlugin,
  audioVcvDadsrhPlugin,
  audioVcvAddrseqPlugin,
  audioVcvEightonePlugin,
  audioVcvBoolPlugin,
  audioVcvMix4Plugin,
  audioVcvManualPlugin,
];
