/**
 * ONE LOG ELISION, AND A RATCHET THAT KEEPS IT THAT WAY.
 *
 * ── WHY A GATE AND NOT JUST A CLEANUP (ledger C-10) ──────────────────────────
 * "Shorten a long src for a log line" was written out NINE times across this
 * codebase, under three names (`truncate`, `truncateRef`, `truncateSrc`) and four
 * behaviours (48/24 with a length suffix; 40/40 with one; 32 with none). Six of the
 * nine were byte-identical, which is the tell: nobody was being creative, the shared
 * home simply was not discoverable from where each author was standing.
 *
 * A TENTH COPY APPEARED IN A NEW FILE WHILE THE OTHER NINE WERE BEING REMOVED.
 * That is the whole argument for this file. Deduplication without a gate is a
 * SNAPSHOT, not a fix — it resets a counter that starts climbing again the same
 * afternoon, because the pressure that produced the copies is still there. The
 * cleanup is only durable if the eleventh copy is caught by a machine.
 *
 * ── WHAT COUNTS AS A LOG ELISION, AND WHY UI TRUNCATION DOES NOT ─────────────
 * The naive detector — "slices a prefix and appends an ellipsis" — over-matches
 * badly: it flags `web/Inspector.svelte`'s `multiValueLabel` and `equationBadge` and
 * `core/retype.js`'s `coercionValueText`, which shorten a string TO FIT A UI FIELD.
 * That is a genuinely different concern with a different correct answer (the width
 * of a control, not the readability of a console line), and folding them together
 * would be the same mistake in the opposite direction. So a function qualifies only
 * if its RESULT is interpolated into a log or a thrown message somewhere in its own
 * file. Measured: that discriminator separates the two populations exactly.
 *
 * ── THE ALLOWLIST IS A RATCHET, AND IT ONLY FAILS LOUDLY ─────────────────────
 * An allowlist is itself a hand-maintained list, which this round is otherwise busy
 * deleting. It earns its place because it is the SAFE polarity: a stale entry makes
 * this suite fail and name the file, never pass and hide one. It can only ratchet
 * DOWN — every entry carries who owns the file and what has to be true to delete it,
 * and removing the last one should delete the list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { truncate } from "../core/report.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Directories with no first-party APP source.
 *
 * `tests/` is skipped on purpose and it is the only entry that needs defending. This
 * gate is about the sentences the APP prints at a user or an author; a probe's own
 * quoting helper (`tests/render_pipeline_probe.js oneLine`, which collapses text to
 * one line to embed in an assertion message) is a harness concern with a different
 * audience and a different correct answer. Test-harness duplication is real and is
 * being tracked separately. Skipping `tests/` also keeps this suite from matching the
 * doctest examples in its own docblock, which it otherwise does.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".frenzy", "projects", ".claude_vlm_checks", "dist", ".scratch", "fonts", "assets", "tests"]);

/**
 * THE HOME. Every log elision in the app must resolve to this one function.
 * Excluded from the sweep because it IS the answer, not a copy of it.
 */
const CANONICAL = "core/report.js";

/**
 * The copies that remain, each with its owner and its exit condition. ONLY SHRINKS.
 * A file listed here that no longer has a copy also fails this suite — a stale
 * exemption is as much a lie as a missing one.
 */
const ALLOWED = new Map([
  ["render_gpu/gpu/scene3d_raster.js",
    "W3-E owns this file (the 3D/splat family, written the same day as this sweep). Its copy IS the tenth — the one that appeared while the other nine were being removed. Delete when W3-E imports truncate from core/report.js."],
  ["web/videoV8Registry.js",
    "W3-C's territory (web/). Behaviourally identical to the canonical one and the ONLY site that ever named the constants — SRC_LOG_MAX / SRC_LOG_HEAD, the spelling core/report.js inherited from it. Delete when web/ is swept."],
]);

/**
 * Query (reads the source tree). Every first-party `.js`/`.mjs`/`.svelte` file,
 * as paths relative to the app root.
 *
 * @returns {string[]}
 *
 * @example // sourceFiles().includes("core/report.js") // true
 */
function sourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = resolve(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|svelte)$/.test(e.name)) out.push(relative(appRoot, p));
    }
  })(appRoot);
  return out.sort();
}

/**
 * Pure function. The log-elision functions declared in one file's source: those that
 * slice a prefix, append an ellipsis, gate on a length comparison, AND have their
 * result interpolated into a console call or a thrown message somewhere in the file.
 * The last clause is what excludes UI-field truncation, which is a different concern.
 *
 * @param {string} src - JavaScript/Svelte source text
 * @returns {{name: string, line: number}[]}
 *
 * @example // a real one:
 * elisionsIn('function t(s){return s.length>9?s.slice(0,4)+"…":s} console.error(t(x))')
 * // [{name: "t", line: 1}]
 * @example // a UI label — same shape, never logged, so not a match:
 * elisionsIn('function label(s){return s.length>9?s.slice(0,4)+"…":s}') // []
 */
export function elisionsIn(src) {
  const FN = /(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  const SINK = /console\.(error|warn|log)|reportOnce\(|warnOnce\(|reportAction\(|new Error\(|throw /;
  const lines = src.split("\n");
  const out = [];
  for (const m of src.matchAll(FN)) {
    const [, name, body] = m;
    if (!body.includes(".slice(0,") || !body.includes("…") || !/\.length\s*[><]/.test(body)) continue;
    if (!lines.some((l) => l.includes(`${name}(`) && SINK.test(l))) continue;
    out.push({ name, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

test("the canonical log elision still lives in core/report.js and still behaves", () => {
  assert.equal(truncate("clip.mp4"), "clip.mp4", "a short src passes through byte-for-byte");
  assert.equal(truncate(`data:image/png;base64,${"A".repeat(200)}`), "data:image/png;base64,AA…(222 chars)",
    "a long src keeps a readable head AND its true length — the length is the point, so a reader can tell a 200-char URI from a 2 MB one");
});

test("no file outside core/report.js declares its own log elision", () => {
  const offenders = [];
  for (const rel of sourceFiles()) {
    if (rel === CANONICAL) continue;
    const found = elisionsIn(readFileSync(resolve(appRoot, rel), "utf8"));
    if (found.length && !ALLOWED.has(rel))
      offenders.push(`${rel}:${found[0].line} declares ${found.map((f) => `${f.name}()`).join(", ")}`);
  }
  assert.deepEqual(offenders, [],
    `these files re-implement the shared log elision instead of importing { truncate } from core/report.js. Nine copies under three names and four behaviours is where this started, and a TENTH appeared while they were being removed — which is why this gate exists. Import it, or add the file to ALLOWED here with an owner and an exit condition:\n  ${offenders.join("\n  ")}`);
});

test("every ALLOWED exemption still has a copy — a stale exemption is a lie too", () => {
  const stale = [];
  for (const [rel, why] of ALLOWED) {
    let src;
    try {
      src = readFileSync(resolve(appRoot, rel), "utf8");
    } catch {
      stale.push(`${rel} no longer exists — drop its exemption`);
      continue;
    }
    if (elisionsIn(src).length === 0) stale.push(`${rel} no longer has a copy — DELETE its exemption (${why})`);
  }
  assert.deepEqual(stale, [],
    `the allowlist only ratchets DOWN, and these entries have already been earned back:\n  ${stale.join("\n  ")}`);
});
