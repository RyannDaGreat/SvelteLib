/**
 * THE PORT-BLOCK CONTRACT — one shape every ported node block presents, and the ONE
 * place the aggregate registries are assembled from.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * R7-17's port swarm ships ~336 nodes in 23 blocks (`.frenzy/round7/NODE_REGISTRY.md`).
 * The first three blocks each invented their own export names — `AX1_SPECS` vs
 * `AUDIO_SPECS_AX2` vs `AUDIO_SPECS_AX3`, `AX1_WORKLET_URL` vs `WORKLET_URL_AX3`, and
 * AX-3 with no plugin barrel at all. Three dialects for one concept, on block three of
 * twenty-three.
 *
 * The manifest's rule for exactly this moment: **a shared seam without a same-commit
 * sweep is not a convention, it is one more dialect.** So the contract is declared here
 * AND the three existing blocks were renamed to it in the commit that introduced it.
 *
 * ── THE CONTRACT: every `*_ax<N>.js` block module exports these five names ───
 *   BLOCK_SPECS            array   — spec records, the shape core/audio_specs.js uses
 *   BLOCK_MODULE_FACTORIES object  — engine factories, `{type: factory}`
 *   BLOCK_PLUGINS          array   — the two-line plugin wrappers
 *   BLOCK_WORKLET_URL      URL|null— the block's processor module, or null if it needs none
 *   BLOCK_WORKLET_MODULES  array   — the types whose factory builds an AudioWorkletNode
 *
 * A block that adds a name of its own instead is not "extending the contract", it is
 * re-forking it — add the field HERE and sweep every block, or do not add it.
 *
 * ── WHY THE WORKLET URL IS A LIST AND NOT THREE CALLS ───────────────────────
 * `engine.init()` used to `await context.audioWorklet.addModule(WORKLET_URL)` once. Three
 * blocks would have made that three hard-coded calls, which is the same drift shape as the
 * hard-coded five-file list that made `tests/synth_engine_test.js`'s ENGINE-LAW check
 * exempt every synth file added after it (found 2026-08-06, AX-1). So init() walks a
 * DERIVED list and a new block costs one entry in BLOCKS below.
 *
 * ZERO PowerRP-side logic lives here: this is assembly, not behaviour.
 */

import { BLOCK_SPECS as AX1_SPECS } from "./audio_specs_ax1.js";
import { BLOCK_SPECS as AX2_SPECS } from "./audio_specs_ax2.js";
import { BLOCK_SPECS as AX3_SPECS } from "./audio_specs_ax3.js";
import { BLOCK_SPECS as VC1_SPECS } from "./audio_specs_vc1.js";
import { BLOCK_SPECS as VC2_SPECS } from "./audio_specs_vc2.js";
import { BLOCK_SPECS as VC3A_SPECS } from "./audio_specs_vc3a.js";
import { BLOCK_SPECS as VC3B_SPECS } from "./audio_specs_vc3b.js";
import { BLOCK_SPECS as AX4_SPECS } from "./audio_specs_ax4.js";
import { BLOCK_SPECS as VC7A_SPECS } from "./audio_specs_vc7a.js";
import { BLOCK_SPECS as VC8_SPECS } from "./audio_specs_vc8.js";
import { BLOCK_SPECS as VC10_SPECS } from "./audio_specs_vc10.js";
import { BLOCK_SPECS as VC5_SPECS } from "./audio_specs_vc5.js";

/** Every ported block's specs, in registry order. ONE entry per block — see the contract. */
export const PORT_BLOCK_SPECS = [...AX1_SPECS, ...AX2_SPECS, ...AX3_SPECS, ...VC1_SPECS, ...VC2_SPECS, ...VC3A_SPECS, ...VC3B_SPECS, ...AX4_SPECS, ...VC7A_SPECS, ...VC8_SPECS, ...VC10_SPECS, ...VC5_SPECS];

/**
 * Pure function. Every spec `type` the ported blocks contribute — used by
 * tests/audio_nodes_test.js's coverage sweep so a block that ships a spec with no plugin
 * wrapper (or the reverse) turns something RED rather than being quietly absent.
 *
 * @example // portBlockTypes().includes("audio_ax_biquad") // true
 * @example portBlockTypes().length === PORT_BLOCK_SPECS.length // true
 */
export function portBlockTypes() {
  return PORT_BLOCK_SPECS.map((spec) => spec.type);
}
