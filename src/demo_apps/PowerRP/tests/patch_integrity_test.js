/**
 * PATCH INTEGRITY — every demo patch checked against the REAL registries, in one sweep.
 * Run: node src/demo_apps/PowerRP/tests/patch_integrity_test.js
 *
 * The RULE lives in `tests/patchIntegrity.js` (a helper module, so importing it does not
 * run another suite's checks); this file applies it to the whole roster and proves it
 * bites. Read that header for the defect class and for why every constraint is derived
 * from the live registries rather than mirrored.
 *
 * ── WHY THIS IS A SECOND FILE AND NOT A CHECK IN audio_patches_test.js ──────
 * That suite already covers this ground and WAS RED at baseline — it is how the
 * violations were enumerated. But every one of its checks asserts inside a loop, so it
 * dies at the FIRST bad patch and reports one line. At baseline that hid 40 of the 41
 * violations behind vcv-ambient-drone's first knob. A drift sweep has to report the WHOLE
 * list or it turns one commit's cleanup into forty rounds of fix-run-discover. So this
 * file collects violations and fails ONCE with all of them, which is the property that
 * makes it usable during a rename.
 */

import assert from "node:assert/strict";

import { DEMO_PATCHES } from "../core/audio_patches.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { KNOWN_RANGE_DEFECTS, patchViolations } from "./patchIntegrity.js";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

const registry = createRegistry();
registerPlugins(registry);

check("EVERY demo patch names only types, knobs and ports that really exist", () => {
  const all = [];
  for (const patch of DEMO_PATCHES) all.push(...patchViolations(patch, registry));
  // ONE failure carrying the WHOLE list — see the header for why that is the point.
  assert.equal(all.length, 0, `${all.length} patch/spec drift violation(s):\n  ${all.join("\n  ")}`);
});

check("the checker BITES — a planted violation of each kind is caught", () => {
  // A green integrity test proves nothing until it has been seen to fail. Each planted
  // patch below is one axis of the drift class, and the axes are checked SEPARATELY so
  // that a checker which caught only the loudest one cannot pass this.
  const bite = (label, patch, expect) => {
    const found = patchViolations(patch, registry);
    assert.ok(found.length >= 1, `planted ${label} was NOT caught`);
    assert.ok(found.some((f) => f.includes(expect)), `planted ${label} caught, but no message mentioned ${expect}: ${found.join(" | ")}`);
  };
  const node = (over) => ({ id: "n", type: "audio_vcv_tangents", col: 0, row: 0, ...over });

  bite("unregistered type", { id: "bite", nodes: [node({ type: "audio_not_a_real_module" })], wires: [] }, "not a registered plugin");
  bite("missing knob", { id: "bite", nodes: [node({ knobs: { p4: 0.6 } })], wires: [] }, "is not a knob");
  bite("out-of-range knob", { id: "bite", nodes: [node({ knobs: { resonance: 99 } })], wires: [] }, "outside");
  bite("bad discrete option", { id: "bite", nodes: [{ id: "n", type: "audio_vcv_vessek", col: 0, row: 0, knobs: { tuneMode: "sideways" } }], wires: [] }, "is not one of");
  bite("missing port", {
    id: "bite", nodes: [node(), { id: "m", type: "audio_meter", col: 1, row: 0 }],
    wires: [{ from: "n", fromPort: "out", to: "m", toPort: "i3" }],
  }, "REFUSED");
  bite("wire to an unknown node", {
    id: "bite", nodes: [node()], wires: [{ from: "n", fromPort: "out", to: "ghost", toPort: "in" }],
  }, "unknown node");

  // AND THE CONTROL: the shape those six are mutations OF must be clean, or "caught"
  // could just mean "everything fails".
  assert.deepEqual(patchViolations({
    id: "bite", nodes: [node({ knobs: { cutoff: 1047 } }), { id: "m", type: "audio_meter", col: 1, row: 0 }],
    wires: [{ from: "n", fromPort: "out", to: "m", toPort: "in" }],
  }, registry), []);
});

check("the KNOWN_RANGE_DEFECTS exceptions are real, and none of them is stale", () => {
  // An exception list outlives its reason silently: the day someone fixes axo-drseq, this
  // set would go on excusing a coordinate that no longer violates anything, and the next
  // regression there would be invisible. So each entry must STILL be a live violation
  // when the exception is lifted.
  const coords = new Set(KNOWN_RANGE_DEFECTS);
  for (const patch of DEMO_PATCHES)
    for (const n of patch.nodes)
      for (const [key, value] of Object.entries(n.knobs ?? {})) {
        const coord = `${patch.id}.${n.id}.${key}`;
        if (!coords.has(coord)) continue;
        const knob = (registry.get(n.type).audioSpec?.knobs ?? []).find((k) => k.key === key);
        assert.ok(knob, `${coord} is excused, but names no spec knob at all — the exception is hiding a worse bug`);
        assert.ok(value < knob.min || value > knob.max, `${coord} = ${value} is INSIDE [${knob.min}, ${knob.max}] — it is fixed, so delete its KNOWN_RANGE_DEFECTS entry`);
        coords.delete(coord);
      }
  assert.deepEqual([...coords], [], "KNOWN_RANGE_DEFECTS names coordinates that no patch contains any more");
});

console.log(`patch_integrity_test: ${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
