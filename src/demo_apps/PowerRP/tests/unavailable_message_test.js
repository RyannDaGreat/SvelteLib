/**
 * ONE CONDITION, ONE SENTENCE — the refusal frame for a gated command.
 *
 * Modelled on tests/connectivity_seam_test.js §3, which pins `offlineMessage()`
 * so the app cannot grow two sentences for one condition. Same job here: four
 * panes had each hand-transcribed "Unavailable — requires {reason}", and four
 * copies of a sentence are four chances to disagree. This file is what makes the
 * single spelling enforceable rather than merely current.
 *
 * ALSO PINS THE GRAMMATICAL CONTRACT THAT MAKES THE FRAME WORK. Every `requires`
 * clause must be a lowercase noun phrase with no terminal period, because it is
 * dropped into the middle of a sentence. A clause that is itself a sentence
 * renders "Unavailable — requires Select an item first." — broken English. That
 * corpus was MEASURED clean at 61/61 when this landed; this test keeps it so.
 */
import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { registerPlugins } from "../plugins/index.js";
import { unavailableMessage, commandUnavailableReason } from "../core/commands.js";

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };

// ── (1) THE SENTENCE ─────────────────────────────────────────────────────────
assert.equal(unavailableMessage("a selection"), "Unavailable — requires a selection");
assert.equal(unavailableMessage("changes to save"), "Unavailable — requires changes to save");
checks += 2;

// An em dash, not a hyphen — the spelling all four panes used and app.css:5463
// describes. A hyphen here would be a silent second style.
ok(unavailableMessage("x").includes("—"), "the frame uses an em dash");
ok(!unavailableMessage("x").includes(" - "), "the frame is not hyphenated");

// ── (2) A HEADLESS SENTENCE IS REFUSED, not emitted ──────────────────────────
// `offlineMessage("")` throws for exactly this reason: "Unavailable — requires ."
// is worse than rendering nothing, and a caller with no reason must render
// nothing. The registry already treats a `when` without a `requires` as a defect.
for (const bad of ["", "   ", null, undefined]) {
  assert.throws(() => unavailableMessage(bad), /needs a reason clause/,
    `unavailableMessage(${JSON.stringify(bad)}) should throw, not emit a headless sentence`);
  checks++;
}

// ── (3) THE CLAUSE CORPUS STILL COMPLETES THE FRAME ──────────────────────────
// Walk every plugin-contributed command and check the shape of its `requires`.
// A function-valued `requires` is evaluated the way commandUnavailableReason
// does — never read raw, which renders the function's source text.
const reg = createRegistry();
await registerPlugins(reg);

const clauses = [];
for (const p of reg.all())
  for (const cmd of p.commands ?? []) {
    if (cmd.requires === undefined) continue;
    if (typeof cmd.requires === "function") continue; // needs a live app; palette_probe covers those
    clauses.push([`${p.type}/${cmd.id}`, cmd.requires]);
  }

for (const [where, clause] of clauses) {
  ok(typeof clause === "string" && clause.trim().length > 0, `${where}: requires is a non-empty string`);
  ok(!/[.!?]$/.test(clause.trim()),
    `${where}: requires ends with terminal punctuation (${JSON.stringify(clause)}) — it is a CLAUSE dropped mid-sentence, not a sentence`);
  const first = clause.trim()[0];
  ok(first === first.toLowerCase(),
    `${where}: requires starts capitalised (${JSON.stringify(clause)}) — "Unavailable — requires ${clause}" reads as two sentences fused`);
}

// The sweep must actually have swept something, or (3) is vacuous — the R6-24.4
// lesson: a check that cannot fail is worse than a missing one.
ok(clauses.length > 0, `the requires corpus is non-empty (found ${clauses.length} literal clauses)`);

// ── (4) commandUnavailableReason composes with the frame ─────────────────────
const gated = { id: "t", when: () => false, requires: "a selection" };
assert.equal(unavailableMessage(commandUnavailableReason(gated, {})),
  "Unavailable — requires a selection");
assert.equal(commandUnavailableReason({ id: "t", requires: "a selection" }, {}), null,
  "an ungated command has no reason, so a surfacing renders nothing");
checks += 2;

console.log(`unavailable_message_test: ${checks} checks passed (${clauses.length} literal requires clauses swept)`);
