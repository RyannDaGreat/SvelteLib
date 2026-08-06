/**
 * THE PATCH-SET CONTRACT — the ONE place ported demo patches are assembled from, and the
 * patch-side twin of `core/audio_blocks.js`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * R7-17-SEL fixes 20 headline patches (12 VCV Rack + 8 Axoloti), rebuilt from real
 * harvested patch files. Twenty hand-authored graphs, each 15-50 nodes, cannot live in
 * `core/audio_patches.js` beside the seven house patches: that file would be a merge
 * conflict from the first parallel wave, which is exactly why the NODE blocks were split
 * the same way (see `core/audio_blocks.js`'s header for the incident that taught it).
 *
 * ── THE CONTRACT: every `core/audio_patches_<set>.js` exports ONE name ───────
 *   BLOCK_PATCHES   array of blueprints — the shape core/audio_patches.js documents
 *
 * One name, not five, because a patch set is data and nothing else: it registers no
 * engine factory, no plugin and no worklet. A set that wants a second export is adding
 * behaviour to a data file — put the behaviour in `core/audio_patches.js` where the
 * blueprint helpers already live, and sweep every set in the same commit.
 *
 * ── WHAT A SET MAY NOT DO ───────────────────────────────────────────────────
 * A set MUST NOT import `core/audio_patches.js` — that is the cycle this seam exists to
 * break (audio_patches imports this file). Everything a blueprint needs is plain data:
 * `{id, title, help, nodes: [{id, type, col, row, knobs}], wires: [{from, fromPort, to,
 * toPort}]}`. The `Audio ` title prefix is applied ONCE, by `core/audio_patches.js`, over
 * the whole roster including these — a set that spells its own prefix gets one anyway
 * (`audioDisplayTitle` is idempotent), but it should not bother.
 *
 * ── PROVENANCE IS PART OF THE PATCH, NOT A COMMENT ──────────────────────────
 * R7-17: the derivation record exists **to debug the emulation**, and that applies to a
 * patch as much as to a node. Every ported blueprint carries `source` — the harvested
 * file, its author, its popularity figures and its distinct-module count — and
 * `deviations`, the named list of what we did NOT reproduce (a cosmetic module dropped, a
 * utility substituted for one of ours). `tests/audio_patches_test.js` pins both present
 * and non-empty-where-required, because an UNRECORDED substitution is the silent
 * divergence R7-17-SEL says the section exists to prevent.
 *
 * ZERO logic lives here: this is assembly, not behaviour.
 */

// ── THE SEVEN SETS ──────────────────────────────────────────────────────────
// Imported UNCONDITIONALLY, including the ones still empty. That is deliberate: the
// import list is written ONCE, here, so a patch agent filling its own file never has to
// edit a shared seam — and four agents each adding one line to one file is the incident
// that cost this round a day (see core/audio_blocks.js's header).
import { BLOCK_PATCHES as VCV_AMBIENT } from "./audio_patches_vcv_ambient.js";
import { BLOCK_PATCHES as VCV_GENERATIVE } from "./audio_patches_vcv_generative.js";
import { BLOCK_PATCHES as VCV_FX } from "./audio_patches_vcv_fx.js";
import { BLOCK_PATCHES as VCV_CLASSIC } from "./audio_patches_vcv_classic.js";
import { BLOCK_PATCHES as AXO_POLY } from "./audio_patches_axo_poly.js";
import { BLOCK_PATCHES as AXO_REVERB } from "./audio_patches_axo_reverb.js";
import { BLOCK_PATCHES as AXO_MACHINE } from "./audio_patches_axo_machine.js";

/**
 * Every ported patch set, in roster order. ONE entry per set file — see the contract.
 *
 * EMPTY IS A VALID STATE AND IS NOT A SILENT ONE: `tests/audio_patches_test.js` asserts
 * the ported patches against R7-17-SEL's list of 20 BY ID, so a set that fails to land
 * turns something red rather than shrinking the roster quietly.
 */
export const PORT_PATCH_SETS = [
  ...VCV_AMBIENT, ...VCV_GENERATIVE, ...VCV_FX, ...VCV_CLASSIC,
  ...AXO_POLY, ...AXO_REVERB, ...AXO_MACHINE,
];

/**
 * Pure function. Every ported patch's id — used by the R7-17-SEL completeness assertion
 * and by `tests/demo_insert_test.js`'s menu-reachability sweep.
 *
 * @returns {string[]}
 *
 * @example portPatchIds() // ["vcv-granular-ambient", "vcv-incanta", …]
 * @example portPatchIds().length === PORT_PATCH_SETS.length // true
 */
export function portPatchIds() {
  return PORT_PATCH_SETS.map((patch) => patch.id);
}
