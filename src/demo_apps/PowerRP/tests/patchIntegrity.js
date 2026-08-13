/**
 * PATCH INTEGRITY, THE RULE ITSELF — derived from the live registries, no roster restated.
 *
 * A helper module rather than a test file, and the naming convention in `tests/` is the
 * reason: `puppeteerLaunch.js`, `cssComments.js` and `free_port.js` are all shared seams
 * that must NOT be collected by `run_all.mjs`. This one is imported by BOTH
 * `patch_integrity_test.js` (which owns the sweep) and `audio_patches_test.js` (whose
 * range check delegates here), so putting it in either of them would make one suite run
 * the other's checks as an import side effect.
 *
 * ── WHAT IT CHECKS AND WHY IT IS DERIVED ────────────────────────────────────
 * A demo patch is DATA naming things declared elsewhere: a node type in the plugin
 * registry, a knob key in that type's spec, a port key on both ends of every wire. None
 * of those names is checked by the compiler, and the build does not check them either.
 * So patches drift from specs whenever a spec is renamed without a same-commit sweep —
 * `8af87458` renamed the harvested knobs to real-unit names and left five patches behind,
 * and the first thing to notice was a USER, in production:
 *   Uncaught Error: demo patch "vcv-ambient-drone": node "vessek" (audio_vcv_vessek)
 *   has no knob "p1" — neither "p1" nor "audioP1" is one of its defaults
 * That error is CORRECT and must stay loud; what was missing is anything saying it first.
 *
 * Every constraint is read off the LIVE registries — `plugin.defaults` for the knob
 * spellings (the same two `buildPatchItems` accepts, so the two cannot disagree),
 * `plugin.audioSpec.knobs` for units and ranges, and `connectionRefusal` for wires (the
 * same refusal the drag gesture uses). Nothing here keeps its own copy of a roster: a
 * test that mirrors the thing it checks goes stale exactly when that thing changes.
 */

import { connectionRefusal } from "../core/nodeflow.js";

/**
 * THE ONE DECLARED EXCEPTION, AND IT IS A KNOWN DEFECT RATHER THAN A TOLERANCE.
 *
 * `axo-drseq`'s three step-index mixers carry `gain1: 16`, which is not a gain at all —
 * it is the ×16 that turns the clock's 0…1 saw into a 16-step index. The knob is 0…1
 * (`AX_AMOUNT`), so the value is out of range, and MEASURED 2026-08-13 the engine does
 * not merely dislike it: `synth/worklets/processors_ax4.js:79` declares mixer gains with
 * `{minValue: 0, maxValue: 1}`, so the AudioParam CLAMPS IT TO 1 silently and the
 * sequencer walks a sixteenth of its pattern. Writing 1 into the patch would erase the
 * evidence of what the node is owed; the real fix is an `audio_ax_math` ×16 node.
 *
 * It is listed HERE, by exact coordinate, rather than by loosening the range rule —
 * an exception with a name and a reason cannot quietly grow to cover the next one.
 * Delete this entry when the math node lands; the test then holds the fix in place.
 */
export const KNOWN_RANGE_DEFECTS = new Set([
  "axo-drseq.idxbd.gain1",
  "axo-drseq.idxhh.gain1",
  "axo-drseq.idxsn.gain1",
]);

/**
 * Pure function. Every way a patch blueprint can name something that does not exist,
 * as a flat list of sentences. Empty means the patch is sound.
 *
 * Kept pure and exported so `patch_integrity_test.js`'s bite check can run it over a
 * DELIBERATELY BROKEN patch: a checker nobody has ever seen fail is not evidence of anything.
 *
 * @param {object} patch - a blueprint from DEMO_PATCHES
 * @param {object} reg - the plugin registry
 * @returns {string[]} one sentence per violation, in patch order
 *
 * @example patchViolations({id: "p", nodes: [], wires: []}, registry) // []
 * @example // a knob no spec declares:
 * @example patchViolations({id: "p", nodes: [{id: "n", type: "audio_vcv_tangents", knobs: {p4: 0.6}}], wires: []}, registry).length // 1
 */
export function patchViolations(patch, reg) {
  const out = [];
  const nodes = new Map();
  for (const node of patch.nodes) {
    let plugin = null;
    try { plugin = reg.get(node.type); } catch {
      // The registry's own refusal IS the finding: an unregistered type is the second
      // axis of this drift class (a node living in a block file nobody wired into
      // PORT_BLOCK_SPECS). Recorded, then skipped — its knobs cannot be checked.
      out.push(`${patch.id}.${node.id}: type "${node.type}" is not a registered plugin`);
    }
    nodes.set(node.id, plugin);
    if (!plugin) continue;
    const spec = plugin.audioSpec;
    for (const [key, value] of Object.entries(node.knobs ?? {})) {
      // The SAME two spellings buildPatchItems accepts, read off the same defaults —
      // so this cannot disagree with the builder about what "has a knob" means.
      const prefixed = "audio" + key.charAt(0).toUpperCase() + key.slice(1);
      if (!(prefixed in plugin.defaults) && !(key in plugin.defaults)) {
        const has = (spec?.knobs ?? []).map((k) => k.key).join(", ");
        out.push(`${patch.id}.${node.id} (${node.type}): "${key}" is not a knob${has ? ` — it has ${has}` : ""}`);
        continue;
      }
      const knob = (spec?.knobs ?? []).find((k) => k.key === key);
      if (!knob) continue; // a plain control-node leaf (`value`, `label`); no spec to check against
      if (knob.discrete) {
        if (!knob.options?.includes(value))
          out.push(`${patch.id}.${node.id}.${key} = ${JSON.stringify(value)} is not one of ${JSON.stringify(knob.options)}`);
        continue;
      }
      if (typeof value !== "number") {
        out.push(`${patch.id}.${node.id}.${key} = ${JSON.stringify(value)} is not a number, but the knob is continuous`);
        continue;
      }
      // A VALUE OUTSIDE THE RANGE IS NOT COSMETIC: the engine clamps it, so the document
      // states one thing and the sound does another with nothing to see. See axo-drseq.
      if (Number.isFinite(knob.min) && Number.isFinite(knob.max) && (value < knob.min || value > knob.max)
          && !KNOWN_RANGE_DEFECTS.has(`${patch.id}.${node.id}.${key}`))
        out.push(`${patch.id}.${node.id}.${key} = ${value} is outside [${knob.min}, ${knob.max}]${knob.unit ?? ""} — the engine clamps it`);
    }
  }
  // Wires are checked against a graph built the way the app builds one, so the refusal
  // sentence a bad wire produces here is the one the editor would have shown.
  const states = {};
  for (const [id, plugin] of nodes) if (plugin) states[id] = { ...plugin.defaults, inputs: {} };
  for (const wire of patch.wires ?? []) {
    if (!nodes.has(wire.from)) { out.push(`${patch.id}: a wire leaves unknown node "${wire.from}"`); continue; }
    if (!nodes.has(wire.to)) { out.push(`${patch.id}: a wire arrives at unknown node "${wire.to}"`); continue; }
    if (!nodes.get(wire.from) || !nodes.get(wire.to)) continue; // unregistered type, already reported
    const refusal = connectionRefusal(states, reg, { item: wire.from, port: wire.fromPort }, { item: wire.to, port: wire.toPort });
    if (refusal) out.push(`${patch.id}: ${wire.from}.${wire.fromPort} → ${wire.to}.${wire.toPort} would be REFUSED — ${refusal}`);
  }
  return out;
}
