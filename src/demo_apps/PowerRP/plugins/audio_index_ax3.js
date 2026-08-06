/**
 * AX-3's plugin barrel — the nine Axoloti filter wrappers, presented under the
 * PORT-BLOCK CONTRACT (`core/audio_blocks.js`).
 *
 * AX-3 shipped nine wrapper files and no barrel, asking the lead to add nine imports to
 * `plugins/audio_index.js` by hand. That would have put a nine-line block per port block
 * into a shared file twenty-three times — a hand-maintained mirror of a directory, which
 * is the drift shape this round keeps finding. One barrel per block instead, exporting the
 * contract's `BLOCK_PLUGINS`, so the aggregate registry gains ONE entry per block.
 */
import { audioAx3AllpassPlugin } from "./audio_ax3_allpass.js";
import { audioAx3BiquadPlugin } from "./audio_ax3_biquad.js";
import { audioAx3Butterworth10Plugin } from "./audio_ax3_butterworth10.js";
import { audioAx3FdbkCombPlugin } from "./audio_ax3_fdbkcomb.js";
import { audioAx3KFilterLowpassPlugin } from "./audio_ax3_kfilter_lowpass.js";
import { audioAx3OnePolePlugin } from "./audio_ax3_onepole.js";
import { audioAx3SvfPlugin } from "./audio_ax3_svf.js";
import { audioAx3Vcf3Plugin } from "./audio_ax3_vcf3.js";
import { audioAx3ZdfSvfPlugin } from "./audio_ax3_zdf_svf.js";

/** The block's wrappers. See core/audio_blocks.js for the contract. */
export const BLOCK_PLUGINS = [
  audioAx3BiquadPlugin,
  audioAx3Vcf3Plugin,
  audioAx3OnePolePlugin,
  audioAx3SvfPlugin,
  audioAx3ZdfSvfPlugin,
  audioAx3KFilterLowpassPlugin,
  audioAx3AllpassPlugin,
  audioAx3FdbkCombPlugin,
  audioAx3Butterworth10Plugin,
];
