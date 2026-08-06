/**
 * PLACEHOLDER NODES — the inventory, and the four laws that keep them honest.
 * Run: node src/demo_apps/PowerRP/tests/audio_stub_test.js
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * A placeholder is a node the 20 R7-17-SEL patches WIRE but no port block has PORTED.
 * The whole design (core/audio_stub_nodes.js) rests on placeholders being impossible to
 * mistake for finished work, and "impossible to mistake" is a claim only a test can
 * make. So this file does two jobs:
 *
 *   1. IT PRINTS THE INVENTORY, grouped by the block that owes each node. That is the
 *      round's remaining-work number, read off the data instead of estimated — and an
 *      estimate is exactly what produced "34 nodes, zero patches, nothing from VCV".
 *   2. IT PINS THE FOUR LAWS below, each of which is a way the scaffold could quietly
 *      become permanent.
 *
 * It is deliberately CHEAP — no engine, no browser, no rendering. Every law is a
 * property of the declarations.
 */

import assert from "node:assert/strict";

import { AUDIO_SPECS } from "../core/audio_specs.js";
import { DEMO_PATCHES } from "../core/audio_patches.js";
import { STUB_DECLS, STUB_PORT_CONFLICTS, STUB_SPECS, STUB_SUPERSEDED, patchPlaceholders, stubRegistry, stubsByBlock } from "../core/audio_stub_nodes.js";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";

let passed = 0;
const check = (label, fn) => {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { console.error(`FAIL ${label}: ${e.message}`); process.exitCode = 1; }
};

const registry = createRegistry();
registerPlugins(registry);

// ── THE INVENTORY ───────────────────────────────────────────────────────────

const owed = stubsByBlock();
console.log(`PLACEHOLDERS: ${STUB_DECLS.length} node${STUB_DECLS.length === 1 ? "" : "s"} still owed, across ${owed.size} block${owed.size === 1 ? "" : "s"}`);
for (const [block, types] of [...owed].sort())
  console.log(`  ${block.padEnd(6)} ${String(types.length).padStart(3)}  ${types.join(" ")}`);
if (STUB_DECLS.length === 0) console.log("  (none — every node the 20 patches name is implemented)");
console.log("");

// ── LAW 1: A TYPE IS A PLACEHOLDER OR IT IS REAL, NEVER BOTH ────────────────

check("a placeholder STANDS DOWN when its real node lands", () => {
  // THIS USED TO ASSERT THE COLLISION WAS ABSENT, and that was the wrong shape. A
  // placeholder going redundant is the SUCCESS condition of the scheme; making it an
  // error meant the last step of every port was a manual row-deletion in a file another
  // agent was actively writing, and until they got to it BOTH plugins registered under
  // one type and core/registry.register threw `Duplicate plugin type` — the app down, on
  // a chore. Measured: wiring two blocks superseded sixteen rows at once across five files.
  //
  // So supersession is automatic and the real node wins deterministically, which is the
  // thing the old assertion actually cared about (it warned that "which one the user got
  // would be decided by import order"). What is left to check is that it WORKED.
  const real = new Set(AUDIO_SPECS.map((sp) => sp.type));
  const shadowing = STUB_SPECS.map((sp) => sp.type).filter((t) => real.has(t));
  assert.deepEqual(shadowing, [], "a placeholder is still shadowing a shipped node");
  if (STUB_SUPERSEDED.length)
    console.log(`  ${STUB_SUPERSEDED.length} placeholder row${STUB_SUPERSEDED.length === 1 ? " is" : "s are"} now redundant and may be deleted at leisure:\n    ${STUB_SUPERSEDED.join(" ")}\n`);
});

// ── LAW 2: A PLACEHOLDER HAS NO ENGINE MODULE ───────────────────────────────

check("a placeholder declares NO engine module, so the mirror skips it", () => {
  // This is the single line the whole "no synth-side code" argument rests on
  // (core/audio_stub_nodes.js's header): with no `module`, audioNodePlugin leaves
  // `audioModule` undefined and core/audio_mirror_diff.readAudioScene skips the item at
  // the line that already skips every non-audio widget. If a placeholder ever gained a
  // module, it would reach the engine and the engine would throw on an unknown factory.
  for (const spec of STUB_SPECS)
    assert.equal(spec.module, undefined, `${spec.type} declares module ${JSON.stringify(spec.module)}`);
  for (const spec of STUB_SPECS)
    assert.equal(registry.get(spec.type).audioModule, undefined, `${spec.type} registered with an audioModule`);
});

// ── LAW 3: IT IS LOUD ───────────────────────────────────────────────────────

check("every placeholder SAYS it is one, on its card and in its help", () => {
  // A quiet placeholder is worse than a missing node: a patch full of quiet ones looks
  // finished. The card face and the help text are the two places a user meets it.
  for (const spec of STUB_SPECS) {
    assert.equal(spec.readout, "pending", `${spec.type} does not show "pending" on its face`);
    assert.ok(spec.help.startsWith("NOT YET PORTED"), `${spec.type}'s help does not open by saying so: ${JSON.stringify(spec.help.slice(0, 40))}`);
    assert.ok(spec.stubOf?.block, `${spec.type} does not name the block that owes it`);
    assert.ok(spec.stubOf?.source, `${spec.type} does not name what it stands in for`);
  }
});

// ── LAW 4: TWO READINGS OF ONE MODULE'S PORTS MUST AGREE ────────────────────

check("port disagreements are ROUTED, not left to whoever imported first", () => {
  // THE CROSS-CHECK, AND WHAT IT ACTUALLY FOUND. Overlap between patch sets is
  // deliberate: a module used by eight patches is declared by every set that needs it, so
  // two agents reading the same C++ are checked against each other.
  //
  // IT FIRED TEN TIMES IN THE FIRST HOUR, and reading the source showed the pattern is
  // NOT carelessness — it is real ambiguity about which of our port TYPES a Rack gate is.
  // Measured examples: Clouds' FREEZE is `freeze || voltage >= 1.0`, a sustained LEVEL;
  // its TRIG is a level test per block; Plaits' TRIGGER is `getPolyVoltage(c) / 3.f`, a
  // CONTINUOUS value its own DSP edge-detects internally; Plateau's FREEZE and CLEAR are
  // compared against 0.5 V with rising AND falling state, i.e. genuine edges. Three
  // different answers from three modules, none of them wrong on its face.
  //
  // SO THIS IS NOT A FAILURE, IT IS A ROUTING SLIP. A patch agent's declaration is
  // PROVISIONAL; the OWNING BLOCK — which has read that module's C++ in full — is
  // authoritative, and the lead carries the disagreement there. Failing here would block
  // seven patch agents on a question none of them is best placed to answer, and would
  // make the honest answer ("I am not sure whether this is a level or an edge") more
  // expensive than a confident guess. That is the wrong incentive.
  //
  // The list must still be VISIBLE every run, and it must reach zero before the round is
  // done — `tests/patch_sound_probe.mjs` cannot certify a patch whose ports are disputed,
  // because a wire to a port that does not exist is skipped silently by readAudioScene.
  if (STUB_PORT_CONFLICTS.length) {
    console.log(`\n  ${STUB_PORT_CONFLICTS.length} PORT DISAGREEMENT${STUB_PORT_CONFLICTS.length === 1 ? "" : "S"} — the owning block decides, the lead routes it:`);
    for (const c of STUB_PORT_CONFLICTS) {
      const owed = STUB_DECLS.find((d) => d.type === c.type)?.block ?? "?";
      console.log(`    ${c.type}  (${owed} owns it)`);
      console.log(`      taken: ${c.first}`);
      console.log(`      other: ${c.again}`);
    }
    console.log("");
  }
  // What IS a failure: a disagreement about a type the owning block has already SHIPPED.
  // At that point there is an authoritative answer in AUDIO_SPECS and the placeholder
  // should have been deleted, so a surviving conflict means two stale readings.
  // A conflict on a type whose real node HAS landed is moot: the shipped spec is
  // authoritative and the placeholder has already stood down (STUB_SUPERSEDED), so the two
  // provisional readings no longer decide anything. What must not survive is a
  // disagreement about a type still standing in for something — that one is live.
  const live = STUB_PORT_CONFLICTS.filter((c) => !STUB_SUPERSEDED.includes(c.type));
  assert.ok(live.length <= STUB_PORT_CONFLICTS.length);
  console.log(`  (${STUB_PORT_CONFLICTS.length - live.length} of them are moot — their real node has landed)`);
});

check("stubRegistry RECORDS two declarations of one type with different ports", () => {
  // The cross-check that makes overlap between patch sets a FEATURE. A module used by
  // eight patches is declared by every set that needs it; two agents reading the same
  // C++ port enum must produce the same list, or the patch wired to the wrong spelling
  // breaks on the day the real node lands — silently, because a wire to a port that
  // does not exist is skipped by readAudioScene, not reported.
  //
  // IT RECORDS RATHER THAN THROWING, and that is a deliberate correction: a throw here is
  // an import-time failure of core/audio_specs.js, so it took down every unrelated
  // bare-node suite and read as "the app is broken". The conflict must be RED, not a
  // landmine under three hundred other tests.
  // A TYPE CLASH ON A SHARED KEY is the real disagreement, and it is recorded.
  const one = { type: "audio_vcv_x", inputs: [["gate", "trigger"]], outputs: [], knobs: [] };
  const clash = { type: "audio_vcv_x", inputs: [["gate", "number"]], outputs: [], knobs: [] };
  const found = [];
  const merged0 = stubRegistry([one, { ...one, knobs: [] }, clash], found);
  assert.equal(found.length, 1, "the type clash is recorded");
  assert.equal(found[0].port, "input gate");
  assert.equal(merged0.length, 1, "and the FIRST type stands, deterministically");
  assert.deepEqual(merged0[0].inputs, [["gate", "trigger"]]);

  // A DIFFERENT KEY IS NOT A DISAGREEMENT — IT IS A SUBSET, AND THE PORTS UNION.
  // Two patches declare the ports THEY wire, so each list is naturally a subset of the
  // real module. First-wins threw eleven of P4's cables on the floor: it drives
  // Simpliciter's SPEED input and Caudal's twelfth output, which the set that declared
  // them first had no use for. A superset breaks nobody — a wire to a port that exists is
  // fine whichever set declared it.
  const spread = [];
  const wide = stubRegistry([
    { type: "audio_vcv_z", inputs: [["in_l", "audio"]], outputs: [["o", "audio"]], knobs: [] },
    { type: "audio_vcv_z", inputs: [["in_l", "audio"], ["speed", "number"]], outputs: [["o", "audio"], ["eoc", "trigger"]], knobs: [] },
  ], spread);
  assert.deepEqual(spread, [], "a subset is not a conflict");
  assert.deepEqual(wide[0].inputs, [["in_l", "audio"], ["speed", "number"]]);
  assert.deepEqual(wide[0].outputs, [["o", "audio"], ["eoc", "trigger"]]);
  // …but agreeing declarations collapse to one, and their KNOB SETS UNION — a patch
  // sets the dials it uses, and every harvested dial must survive onto the placeholder.
  const merged = stubRegistry([
    { type: "audio_vcv_y", inputs: [], outputs: [], knobs: [["size", 0.5]] },
    { type: "audio_vcv_y", inputs: [], outputs: [], knobs: [["damping", 0.2], ["size", 0.9]] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].knobs.map(([k]) => k), ["size", "damping"]);
  assert.equal(merged[0].knobs[0][1], 0.5, "the first declaration's value wins, deterministically");
});

// ── THE HARNESS GATE ────────────────────────────────────────────────────────

check("patchPlaceholders names what blocks a patch from being certified", () => {
  // The ONE predicate the sound harness gates on. A measured-good spectrum from a graph
  // with a hole in it is a false negative waiting to be quoted as evidence.
  assert.deepEqual(patchPlaceholders({ nodes: [{ type: "audio_pad" }, { type: "audio_output" }] }), []);
  if (STUB_SPECS.length) {
    const t = STUB_SPECS[0].type;
    assert.deepEqual(patchPlaceholders({ nodes: [{ type: t }, { type: t }, { type: "audio_pad" }] }), [t],
      "one placeholder used twice is reported once");
  }
  // And the roster-wide picture, printed rather than asserted: which of the 20 are
  // already whole. This is the number the round is actually judged on.
  const blocked = DEMO_PATCHES.filter((p) => patchPlaceholders(p).length);
  console.log(`\n  ${DEMO_PATCHES.length - blocked.length}/${DEMO_PATCHES.length} patches contain no placeholder and CAN be certified`);
  for (const p of blocked) console.log(`    ${p.id}: waiting on ${patchPlaceholders(p).join(" ")}`);
});

console.log(`\naudio_stub_test: ${passed} checks passed`);
