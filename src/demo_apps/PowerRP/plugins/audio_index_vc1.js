/**
 * THE VC-1 NODE ROSTER — the ported VCV Rack / Mutable Instruments plugins, in one array.
 *
 * A BARREL, for the reason `plugins/audio_index.js`'s docblock gives: one import and one
 * spread there instead of one of each per node, in the file every widget workstream edits.
 * A SEPARATE barrel rather than more lines in the first because several agents land ported
 * module sets concurrently and that file would be a merge conflict per row.
 *
 * FILENAMES CARRY THE BLOCK ID (`audio_vc1_*`) WHILE TYPE STRINGS DO NOT
 * (`audio_vcv_clouds`). The type says "a VCV Rack node", which is what a saved document
 * should record and what every VCV block shares — a node must not be named after whoever
 * built it. The FILE prefix exists so that a `git` pathspec like `plugins/audio_vc1_*`
 * cannot reach a sibling block's untracked work; that is not hypothetical, a glob commit
 * earlier in this round swept six of another agent's files.
 *
 * A LITERAL LIST, NOT A GLOB: `core/` and `cli/` run in BARE NODE where
 * `import.meta.glob` does not exist, and `tests/port_vc1_test.js` sweeps `BLOCK_SPECS`
 * there. Forgetting a line here is LOUD rather than quiet — that test asserts this array
 * covers `core/audio_specs_vc1.BLOCK_SPECS` exactly, in both directions, so a module
 * registered in one and not the other reds the suite instead of silently not appearing.
 *
 * THE BARREL LINE THIS NEEDS: `plugins/audio_index.js`'s `audioPlugins` must spread
 * `BLOCK_PLUGINS`, or none of these reach the palette.
 */

import { audioVcvCloudsPlugin } from "./audio_vc1_clouds.js";
import { audioVcvSupercellPlugin } from "./audio_vc1_supercell.js";
import { audioVcvRingsPlugin } from "./audio_vc1_rings.js";
import { audioVcvMarblesPlugin } from "./audio_vc1_marbles.js";
import { audioVcvRipplesPlugin } from "./audio_vc1_ripples.js";
import { audioVcvBranchesPlugin } from "./audio_vc1_branches.js";
import { audioVcvBlindsPlugin } from "./audio_vc1_blinds.js";
import { audioVcvShadesPlugin } from "./audio_vc1_shades.js";

/** Every VC-1 plugin, in `core/audio_specs_vc1.BLOCK_SPECS` order — the two granular
 *  processors, then the resonator, then the three utilities — which is also the order they
 *  appear in the palette. */
export const BLOCK_PLUGINS = [
  audioVcvCloudsPlugin,
  audioVcvSupercellPlugin,
  audioVcvRingsPlugin,
  audioVcvMarblesPlugin,
  audioVcvRipplesPlugin,
  audioVcvBranchesPlugin,
  audioVcvBlindsPlugin,
  audioVcvShadesPlugin,
];
