/**
 * THE definition of "passing". One command, every suite, one verdict.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * User ruling, 2026-07-28: "For now on passing must always include browser probes,
 * duh." The lead had been reporting "74 pass / 0 fail" for an entire session while
 * that number covered ONLY the bare-node `*_test.js` files — 82 of 181 test files.
 * Worse, five browser probes were FAILING at baseline on a stale console filter and
 * nobody noticed, because nothing ever ran them together. A number that silently
 * excludes most of the suite is worse than no number: it manufactures false
 * confidence, which is exactly what happened.
 *
 * So "passing" is no longer a claim anyone assembles by hand. It is this script's
 * exit code.
 *
 * ── THE FOUR KINDS, and why they cannot be one loop ──────────────────────────
 *   BARE NODE  tests/*_test.js, render_gpu/tests/*_test.js — DOM-free, fast, safe to
 *              run many at once.
 *   BROWSER    tests/*_probe.js — each boots a Vite server AND a headless Chrome.
 *              Slow, and they CONTEND: a ~50% flake in the clipboard probe was traced
 *              to ~23 concurrent Chrome processes fighting over one OS clipboard. So
 *              these run at low concurrency, deliberately.
 *   PYTHON     tests/*_test.py — the server's own tests, via `uv run` (never bare
 *              python; the dump's rule, so a wiped container still works).
 *   SHELL      tests/*_test.sh — server lifecycle.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node tests/run_all.mjs                 everything (the real gate)
 *   node tests/run_all.mjs --only=node     one kind, when iterating
 *   node tests/run_all.mjs --list          what would run, and nothing else
 * Run it from anywhere: paths resolve off this file, never process.cwd().
 */
import { readdirSync, existsSync } from "node:fs";
import { dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "../../..");

/** Per-test wall clock. A browser probe boots Vite + Chrome + CanvasKit, so it needs
 *  far longer than a pure-JS suite; the slowest legitimate probe observed is ~4 min. */
const TIMEOUT_MS = { node: 300_000, browser: 600_000, python: 300_000, shell: 300_000 };

/** How many of each kind run at once. BROWSER IS DELIBERATELY LOW: concurrent Chrome
 *  instances contend for the OS clipboard, which produced a ~50% flake in
 *  palette_probe's copy-png check (proven pre-existing, ~23 Chromes in flight). Node
 *  suites are pure computation, so the only limit is core count. */
const CONCURRENCY = { node: Math.max(2, Math.min(8, (navigator?.hardwareConcurrency ?? 8) - 2)), browser: 3, python: 2, shell: 1 };

/** Query. Files of one kind, as absolute paths, sorted for stable output. */
function collect(kind) {
  const globs = {
    node: [["tests", /_test\.js$/], ["render_gpu/tests", /_test\.js$/]],
    browser: [["tests", /_probe\.js$/]],
    python: [["tests", /_test\.py$/]],
    shell: [["tests", /_test\.sh$/]],
  }[kind];
  const out = [];
  for (const [dir, re] of globs) {
    const full = resolve(appRoot, dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full)) if (re.test(f)) out.push(resolve(full, f));
  }
  return out.sort();
}

/** Command (spawns a child). Runs one test file; resolves {ok, ms, tail}. Never throws
 *  — a crashed child is a FAILING TEST, not an error in the runner, and its output is
 *  kept so the report can show why rather than just that. */
function runOne(kind, file) {
  const cmd = kind === "python" ? ["uv", ["run", "python", file]]
    : kind === "shell" ? ["bash", [file]]
    : ["node", [file]];
  // Browser probes resolve fixtures off the SvelteLib repo root by convention; node
  // suites resolve off their own file. Honour both rather than forcing one.
  const cwd = kind === "browser" ? repoRoot : appRoot;
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(cmd[0], cmd[1], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const keep = (d) => { buf += d; if (buf.length > 20_000) buf = buf.slice(-20_000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const killer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS[kind]);
    child.on("close", (code) => {
      clearTimeout(killer);
      done({ ok: code === 0, ms: Date.now() - started, tail: buf.trimEnd().split("\n").slice(-3).join("\n") });
    });
    child.on("error", (e) => { clearTimeout(killer); done({ ok: false, ms: Date.now() - started, tail: String(e) }); });
  });
}

/** Command. Runs a kind at its own concurrency; returns {pass, fail, failures[]}. */
async function runKind(kind, files) {
  const queue = [...files];
  const failures = [];
  let pass = 0;
  const worker = async () => {
    for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
      const r = await runOne(kind, f);
      const name = basename(f);
      if (r.ok) { pass++; process.stdout.write("."); }
      else { failures.push({ name, path: relative(repoRoot, f), ms: r.ms, tail: r.tail }); process.stdout.write("F"); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY[kind], files.length) }, worker));
  return { pass, fail: failures.length, failures };
}

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const kinds = only ? [only] : ["node", "python", "shell", "browser"]; // browser last: slowest

if (args.includes("--list")) {
  for (const k of kinds) console.log(`${k.padEnd(8)} ${collect(k).length}\n  ${collect(k).map((f) => basename(f)).join("\n  ")}`);
  process.exit(0);
}

const totals = { pass: 0, fail: 0 };
const allFailures = [];
const started = Date.now();
for (const kind of kinds) {
  const files = collect(kind);
  if (!files.length) { console.log(`${kind}: no files`); continue; }
  process.stdout.write(`${kind} (${files.length}, x${Math.min(CONCURRENCY[kind], files.length)}) `);
  const r = await runKind(kind, files);
  console.log(`  ${r.pass} pass / ${r.fail} fail`);
  totals.pass += r.pass; totals.fail += r.fail;
  allFailures.push(...r.failures.map((x) => ({ ...x, kind })));
}

console.log(`\n${"=".repeat(64)}`);
console.log(`TOTAL: ${totals.pass} pass / ${totals.fail} fail   (${((Date.now() - started) / 1000).toFixed(0)}s)`);
if (allFailures.length) {
  console.log(`\nFAILING (${allFailures.length}):`);
  for (const f of allFailures) console.log(`\n  [${f.kind}] ${f.name}  (${(f.ms / 1000).toFixed(0)}s)\n    ${f.tail.replace(/\n/g, "\n    ")}`);
}
process.exit(totals.fail === 0 ? 0 : 1);
