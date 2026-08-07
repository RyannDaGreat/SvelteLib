/**
 * THE VC-8 NODE ROSTER — the eleven NYSTHI plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import
 * and one spread there instead of eleven of each, in the file every widget
 * workstream edits. A SECOND barrel rather than eleven more lines in the first
 * because several agents are landing ported module sets concurrently (R7 Wave 3
 * Phase 3) and that file would be eleven merge conflicts wide.
 *
 * FILENAMES CARRY THE BLOCK NUMBER (`audio_vc8_*`) WHILE TYPE STRINGS DO NOT
 * (`audio_vcv_squonk`). The type says "a VCV Rack node", which is what a saved
 * document should record and what every VCV block shares; the FILE prefix exists
 * so that a `git` pathspec like `plugins/audio_vc8_*` cannot reach a sibling
 * block's untracked work. That is not hypothetical — a glob commit in an earlier
 * wave swept six of another agent's files.
 *
 * A literal list, not a glob: core/ and cli/ run in BARE NODE where
 * `import.meta.glob` does not exist, and tests/port_vc8_test.js sweeps
 * `core/audio_specs_vc8.BLOCK_SPECS` there. Forgetting a line here is LOUD rather
 * than quiet — that sweep asserts this array covers that one exactly, so a module
 * registered in one and not the other reds the suite instead of silently not
 * appearing in the palette.
 *
 * ⚠ ELEVEN, NOT THIRTEEN. `NYSTHI/Simpliciter` and `NYSTHI/complexSimpler` are
 * absent on purpose: they are WAV-file samplers, NYSTHI ships no source at any
 * ref, no grain algorithm is published, and there is no sample file. A
 * "granulator" built on three guesses would make P4's five grain clouds sound
 * wrong with nothing to say why. See `core/audio_specs_vc8.js`'s closing note.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must
 * spread `BLOCK_PLUGINS`, or none of these eleven reach the palette.
 */

import { audioVcvB208DualLpgPlugin } from "./audio_vc8_b208_dual_lpg.js";
import { audioVcvPolyLpgPlugin } from "./audio_vc8_poly_lpg.js";
import { audioVcvAttackDecayPlugin } from "./audio_vc8_attack_decay.js";
import { audioVcvB208EnvelopePlugin } from "./audio_vc8_b208_envelope.js";
import { audioVcvQuadPannerPlugin } from "./audio_vc8_quad_panner.js";
import { audioVcvClockableDelayPlugin } from "./audio_vc8_clockable_delay.js";
import { audioVcvNysthiMix4Plugin } from "./audio_vc8_mix4.js";
import { audioVcvSurveillancePlugin } from "./audio_vc8_surveillance.js";
import { audioVcvSquonkPlugin } from "./audio_vc8_squonk.js";
import { audioVcvProgrammerPlugin } from "./audio_vc8_programmer.js";
import { audioVcvSoyModelSouPlugin } from "./audio_vc8_soy_model_sou.js";

/** Every VC-8 plugin, in `core/audio_specs_vc8.BLOCK_SPECS` order (filters, then
 *  envelopes, then effects, then the mixer, the voltage bank and the three stage
 *  sequencers), which is also the order they appear in the palette. */
export const BLOCK_PLUGINS = [
  audioVcvB208DualLpgPlugin,
  audioVcvPolyLpgPlugin,
  audioVcvAttackDecayPlugin,
  audioVcvB208EnvelopePlugin,
  audioVcvQuadPannerPlugin,
  audioVcvClockableDelayPlugin,
  audioVcvNysthiMix4Plugin,
  audioVcvSurveillancePlugin,
  audioVcvSquonkPlugin,
  audioVcvProgrammerPlugin,
  audioVcvSoyModelSouPlugin,
];
