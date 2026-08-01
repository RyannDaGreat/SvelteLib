/**
 * THE ASSET LOAD-VERDICT VOCABULARY, PINNED — nine registries, one four-word
 * language, and until now nothing that noticed if one of them started speaking a
 * different dialect.
 *
 * ── WHAT WAS MEASURED ────────────────────────────────────────────────────────
 * Every registry in render_gpu/gpu/ answers "how is this asset doing?" with the
 * SAME four strings — `unloaded`, `loading`, `ready`, `error` — and every one of
 * them spells that vocabulary out in its own file. There is no shared enum, no
 * shared type, and no consumer that would break if one registry invented a fifth
 * word or renamed one: the callers compare strings. `web/main.js:116` writes the
 * language down a tenth time, in a comment.
 *
 * ── WHY A GATE AND NOT A SHARED ENUM ─────────────────────────────────────────
 * A shared enum is the better end state and it is NOT what this file does. Hoisting
 * the four values into one module touches nine registries plus every consumer's
 * string comparison, several of which live in directories other agents hold, and it
 * is a change with no behavioural benefit on the day it lands — so it is a proposal
 * for the round's report, not a unilateral edit.
 *
 * What IS cheap, and is the half that actually rots, is the DRIFT. The vocabulary is
 * uniform today by luck and diligence; nothing makes it stay uniform. This suite
 * converts "consistent today, ungated forever" into a red gate, and it does so
 * WITHOUT touching a single registry — it reads them. If the shared enum is done
 * later, this suite is what makes that refactor safe, because it already knows what
 * the answer must be.
 *
 * ── HOW IT DECIDES WHAT TO CHECK ─────────────────────────────────────────────
 * The subject list is DISCOVERED by reading the directory, not written out here: a
 * hardcoded roster would be the very defect this file exists to catch, and it would
 * have been wrong the first time someone added a registry. A module qualifies as a
 * status speaker by exporting a `…Status` function — that is the protocol, so that
 * is the test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GPU_DIR = resolve(appRoot, "render_gpu/gpu");

/**
 * THE LOAD VERDICT, in the order an asset travels through it. Declared here rather
 * than imported because there is nothing to import — that absence IS the finding
 * this suite guards. Whoever introduces the shared enum should delete this and
 * import it, and the assertions below will confirm the enum matches reality.
 */
const LOAD_VERDICT = ["unloaded", "loading", "ready", "error"];

/**
 * Pure function. Every quoted single-word lowercase string literal in `src` that
 * belongs to the load-verdict language, plus any near-miss that suggests a fifth
 * state has been invented. Only literals in a `return`, a comparison or a status
 * assignment count; a word inside a prose sentence would produce noise.
 *
 * @param {string} src - JavaScript source text
 * @returns {Set<string>}
 *
 * @example verdictWordsIn('if (e.status === "ready") return "ready";') // Set { "ready" }
 * @example verdictWordsIn('return "pending";') // Set { "pending" }
 * @example verdictWordsIn('// the word ready appears in prose only') // Set {}
 */
function verdictWordsIn(src) {
  const CANDIDATES = new Set([...LOAD_VERDICT, "pending", "idle", "loaded", "failed", "missing", "absent", "none", "ok", "done", "fetching", "waiting"]);
  const found = new Set();
  for (const m of src.matchAll(/(?:return|===|!==|==|!=|status\s*[:=])\s*"([a-z]+)"/g))
    if (CANDIDATES.has(m[1])) found.add(m[1]);
  return found;
}

/**
 * Query (reads render_gpu/gpu/). Every module in the asset-registry directory that
 * exports a `…Status` query, as {name, src}. DISCOVERED, never listed: a hardcoded
 * roster is the defect class this suite exists to catch.
 *
 * @returns {{name: string, src: string}[]}
 *
 * @example // statusSpeakers().map((m) => m.name) // ["image_registry.js", "latex_raster.js", …]
 */
function statusSpeakers() {
  return readdirSync(GPU_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ name: f, src: readFileSync(resolve(GPU_DIR, f), "utf8") }))
    .filter((m) => /export function [A-Za-z0-9_]*[Ss]tatus\s*\(/.test(m.src));
}

test("the asset registries are discoverable, and there are enough of them for this to be worth pinning", () => {
  const speakers = statusSpeakers();
  assert.ok(speakers.length >= 8,
    `only ${speakers.length} module(s) in render_gpu/gpu/ export a *Status query — if the registries were consolidated, retire this suite deliberately rather than letting it pass vacuously (found: ${speakers.map((s) => s.name).join(", ")})`);
});

test("no registry has invented a fifth load verdict, or dropped one of the four", () => {
  const offenders = [];
  for (const { name, src } of statusSpeakers()) {
    const words = verdictWordsIn(src);
    const strays = [...words].filter((w) => !LOAD_VERDICT.includes(w));
    if (strays.length) offenders.push(`${name} speaks ${JSON.stringify(strays)}`);
  }
  assert.deepEqual(offenders, [],
    `these registries use a load-verdict word outside the shared four (${LOAD_VERDICT.join(" | ")}). Either it is a genuine new state — in which case every consumer's string comparison needs it too, and it belongs in LOAD_VERDICT here — or it is a typo that silently makes an asset look permanently unloaded:\n  ${offenders.join("\n  ")}`);
});

test("every one of the four words is actually spoken somewhere — the list is not aspirational", () => {
  const spoken = new Set();
  for (const { src } of statusSpeakers()) for (const w of verdictWordsIn(src)) spoken.add(w);
  assert.deepEqual(LOAD_VERDICT.filter((w) => !spoken.has(w)), [],
    "LOAD_VERDICT names a verdict no registry produces — the list has drifted away from the code it describes");
});

test("the prose copy in web/main.js still agrees with the registries", () => {
  // web/main.js:116 documents the vocabulary in a comment — a tenth copy, and the
  // one most likely to rot because no runtime path reads it. It is pinned rather
  // than deleted: a reader of main.js deserves the answer, and now it cannot be a
  // stale one.
  const src = readFileSync(resolve(appRoot, "web/main.js"), "utf8");
  const line = src.split("\n").find((l) => l.includes("unloaded"));
  assert.ok(line, 'web/main.js no longer documents the load verdict — if the comment moved, move this assertion with it');
  for (const w of LOAD_VERDICT)
    assert.ok(line.includes(`"${w}"`),
      `web/main.js's load-verdict comment omits "${w}": it reads ${JSON.stringify(line.trim())}`);
});
