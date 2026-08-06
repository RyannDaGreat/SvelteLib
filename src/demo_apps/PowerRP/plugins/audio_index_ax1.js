/**
 * THE AX-1 NODE ROSTER — the fifteen ported Axoloti arithmetic, logic and
 * step-table plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import and
 * one spread there instead of fifteen of each, in the file every widget workstream
 * edits. A SECOND barrel rather than fifteen more lines in the first because several
 * agents are landing ported module sets concurrently (R7 Wave 3 Phase 3) and that
 * file would be fifteen merge conflicts wide. `plugins/audio_index_ax2.js` is the
 * same arrangement for that block.
 *
 * A literal list, not a glob: core/ and cli/ run in BARE NODE where
 * `import.meta.glob` does not exist, and tests/port_ax1_test.js sweeps AX1_SPECS
 * there. Forgetting a line here is LOUD rather than quiet — that suite asserts this
 * array covers AX1_SPECS exactly, so a module registered in one and not the other
 * reds the suite instead of silently not appearing in the palette.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must spread
 * `BLOCK_PLUGINS`, or none of these fifteen reach the palette. Three more are
 * needed elsewhere and are reported with it — the specs into `AUDIO_SPECS`, the
 * factories into `MODULE_FACTORIES`, and `AX1_WORKLET_URL` into `engine.init()`.
 */

import { audioAxMathPlugin } from "./audio_ax_math.js";
import { audioAxSmoothPlugin } from "./audio_ax_smooth.js";
import { audioAxWindowPlugin } from "./audio_ax_window.js";
import { audioAxDivremPlugin } from "./audio_ax_divrem.js";
import { audioAxShaperPlugin } from "./audio_ax_shaper.js";
import { audioAxConvertPlugin } from "./audio_ax_convert.js";
import { audioAxLogicPlugin } from "./audio_ax_logic.js";
import { audioAxCounterPlugin } from "./audio_ax_counter.js";
import { audioAxLatchPlugin } from "./audio_ax_latch.js";
import { audioAxDecodePlugin } from "./audio_ax_decode.js";
import { audioAxMuxPlugin } from "./audio_ax_mux.js";
import { audioAxStepsBoolPlugin } from "./audio_ax_steps_bool.js";
import { audioAxStepsValuePlugin } from "./audio_ax_steps_value.js";
import { audioAxStepsMultiPlugin } from "./audio_ax_steps_multi.js";
import { audioAxStereoOutPlugin } from "./audio_ax_stereo_out.js";

/** Every AX-1 plugin, in core/audio_specs_ax1.AX1_SPECS order — arithmetic, then the
 *  things that decide, then the things that step, then the way out — which is also
 *  the order they appear in the palette. */
export const BLOCK_PLUGINS = [
  audioAxMathPlugin,
  audioAxSmoothPlugin,
  audioAxWindowPlugin,
  audioAxDivremPlugin,
  audioAxShaperPlugin,
  audioAxConvertPlugin,
  audioAxLogicPlugin,
  audioAxCounterPlugin,
  audioAxLatchPlugin,
  audioAxDecodePlugin,
  audioAxMuxPlugin,
  audioAxStepsBoolPlugin,
  audioAxStepsValuePlugin,
  audioAxStepsMultiPlugin,
  audioAxStereoOutPlugin,
];
