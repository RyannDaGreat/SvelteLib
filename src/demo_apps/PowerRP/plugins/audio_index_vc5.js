/**
 * VC-5's plugin barrel — the nine ported VCV Rack wrappers, presented under the
 * PORT-BLOCK CONTRACT (`core/audio_blocks.js`).
 *
 * One barrel per block, so the aggregate registry in `plugins/audio_index.js`
 * gains ONE entry for this block rather than nine imports. AX-3 shipped nine
 * wrapper files and no barrel and asked the lead to add nine lines to a shared
 * file; twenty-three blocks doing that is a hand-maintained mirror of a directory,
 * which is the drift shape this round keeps finding.
 *
 * ORDER MATCHES core/audio_specs_vc5.BLOCK_SPECS — effects, filters, sources, then
 * modulation — so the palette reads the same way the roster does.
 * tests/port_vc5_test.js asserts the two agree, which is what stops this list from
 * quietly losing a row.
 */
import { audioVcvChronoblob2Plugin } from "./audio_vc5_chronoblob2.js";
import { audioVcvFelinePlugin } from "./audio_vc5_feline.js";
import { audioVcvJustaphaserPlugin } from "./audio_vc5_justaphaser.js";
import { audioVcvPlateauPlugin } from "./audio_vc5_plateau.js";
import { audioVcvReburstPlugin } from "./audio_vc5_reburst.js";
import { audioVcvRewinPlugin } from "./audio_vc5_rewin.js";
import { audioVcvSpfPlugin } from "./audio_vc5_spf.js";
import { audioVcvTerrorformPlugin } from "./audio_vc5_terrorform.js";
import { audioVcvXfxf35Plugin } from "./audio_vc5_xfxf35.js";

/** The block's wrappers. See core/audio_blocks.js for the contract. */
export const BLOCK_PLUGINS = [
  audioVcvPlateauPlugin,
  audioVcvChronoblob2Plugin,
  audioVcvJustaphaserPlugin,
  audioVcvFelinePlugin,
  audioVcvSpfPlugin,
  audioVcvXfxf35Plugin,
  audioVcvTerrorformPlugin,
  audioVcvRewinPlugin,
  audioVcvReburstPlugin,
];
