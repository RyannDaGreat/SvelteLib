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
 * ── THE GATE PROVIDES ITS OWN PREREQUISITES ──────────────────────────────────
 * First real sweep: 12 failures, and NINE were the same HTTP 500 — `listAssets:
 * 500 Internal Server Error` — because no project backend was listening. The
 * probes were not testing anything; they were reporting an absent dependency.
 *
 * A gate that assumes a prerequisite is a gate that measures the environment
 * instead of the product. So this script STARTS a backend, waits for it to
 * actually answer, hands it to the browser children, and tears it down. If it
 * cannot, the whole run fails saying so — it does NOT run the probes anyway and
 * let 93 of them report a fetch error as if the app were broken.
 *
 * ON A FREE PORT, NOT 3638. The default is fixed (vite.config.js), which is
 * right for a human running one editor. It is wrong for a gate: stale servers
 * and concurrent agents already hold fixed ports, so binding one makes the gate
 * flaky for a reason that has nothing to do with the code under test. The seam
 * is BACKEND_URL — the same env var vite.config.js reads to aim its /api proxy —
 * so every probe's own Vite server proxies to ours with NO probe-side change.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node tests/run_all.mjs                 everything (the real gate)
 *   node tests/run_all.mjs --only=node     one kind, when iterating
 *   node tests/run_all.mjs --list          what would run, and nothing else
 *   BACKEND_URL=… node tests/run_all.mjs   use a backend you already have
 * Run it from anywhere: paths resolve off this file, never process.cwd().
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";

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

/**
 * Query. Files of one kind, as absolute paths, sorted for stable output.
 *
 * BOTH TEST DIRECTORIES, BOTH EXTENSIONS. The first version of this collected
 * `_test.js` from tests/ AND render_gpu/tests/ but `_probe.js` from tests/ ONLY —
 * so three real browser probes in render_gpu/tests/ were silently outside the gate,
 * and so was one `.mjs` probe. That is the same failure this whole file exists to
 * prevent, committed by the file itself: a count that looks total and isn't. The
 * suffix decides the KIND and the directory decides nothing, which is the only rule
 * that cannot rot as directories are added.
 */
function collect(kind) {
  const dirs = ["tests", "render_gpu/tests"];
  // `.mjs` is admitted because a probe already used it. One suffix rule, no roster.
  const TEST_JS = /_test\.m?js$/;
  const PROBE_JS = /_probe\.m?js$/;
  const suffix = { node: TEST_JS, browser: PROBE_JS, python: /_test\.py$/, shell: /_test\.sh$/ }[kind];
  if (!suffix) throw new Error(`run_all: unknown kind ${JSON.stringify(kind)} — expected one of ${Object.keys(TIMEOUT_MS).join(", ")}`);
  // For python and shell the LANGUAGE cannot lie, so the suffix is final. For the two
  // JS kinds, gather both suffixes and let the file's CONTENT decide which kind it is.
  const jsKind = kind === "node" || kind === "browser";
  const out = [];
  for (const dir of dirs) {
    const full = resolve(appRoot, dir);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full)) {
      const abs = resolve(full, f);
      if (!jsKind) { if (suffix.test(f)) out.push(abs); continue; }
      if (!TEST_JS.test(f) && !PROBE_JS.test(f)) continue;
      if ((PROBE_JS.test(f) || drivesBrowser(abs)) === (kind === "browser")) out.push(abs);
    }
  }
  return out.sort();
}

/**
 * Query (reads the file). Does this test launch a headless browser? True when it
 * IMPORTS puppeteer — statically or dynamically. That is the one thing every
 * browser-driving test here has in common, and a file cannot do it by accident.
 *
 * THE QUOTES ARE THE WHOLE POINT, and I learned that by getting it wrong: a bare
 * `grep -l puppeteer` says FOUR `_test.js` files drive a browser. Three of them only
 * mention it in PROSE — `"no browser/Vite/puppeteer"`, `"in BARE NODE (… no
 * puppeteer)"`, `"exercised by the puppeteer visual check, not here"`. They are
 * genuinely DOM-free and correctly classified as bare-node. Requiring the quotes of
 * a module specifier distinguishes a real import from a docstring that talks about
 * one, so exactly ONE file reclassifies: video_scrub_determinism_test.js, which was
 * running at node's x8 concurrency under the short timeout and made `--only=node`
 * non-hermetic.
 *
 * @example drivesBrowser(".../video_scrub_determinism_test.js") // true — imports it
 * @example drivesBrowser(".../cli_render_test.js")              // false — only says "no puppeteer"
 * @example drivesBrowser(".../core_test.js")                    // false — never mentions it
 */
function drivesBrowser(file) {
  if (!/\.m?js$/.test(file)) return false;
  return /["']puppeteer(-core)?["']/.test(readFileSync(file, "utf8"));
}

/** How long the backend gets to bind and answer before the gate gives up. `uv run`
 *  may resolve/install the script's deps on a cold cache, which dominates: a warm
 *  start answers in well under a second, a cold one can take tens. */
const BACKEND_READY_MS = 90_000;

/** Query. A free TCP port, from the OS, by binding 0 and reading it back. */
function freePort() {
  return new Promise((done, fail) => {
    const s = createNetServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
}

/**
 * Command. Starts the project backend and resolves {url, stop}. Throws LOUDLY with
 * the server's own output if it never answers — an unavailable prerequisite must not
 * masquerade as 93 failing probes.
 *
 * `uv run` IS A WRAPPER THAT EXECS A PYTHON GRANDCHILD, so killing the pid we hold
 * kills `uv` and leaves the server running, reparented to init, still holding its
 * port. A sibling agent proved this the expensive way: its harness leaked ONE
 * backend per probe run and had accumulated 13. So the child gets its own process
 * GROUP (`detached`) and teardown signals the NEGATIVE pid to take the grandchild
 * with it. Orphaned server fleets are exactly what this file's own header blames for
 * a ~50% flake elsewhere; the gate must not manufacture them.
 */
async function startBackend() {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const child = spawn("uv", ["run", "server.py", "serve", `--port=${port}`], {
    cwd: resolve(appRoot, "server"),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  const keep = (d) => { log += d; if (log.length > 4_000) log = log.slice(-4_000); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let exited = null;
  child.on("close", (code) => { exited = code; });

  /** Command. Kills the whole group. Tolerates an already-dead group (ESRCH) and
   *  ONLY that — any other errno is a real problem and re-throws. */
  const stop = () => {
    if (exited !== null) return;
    try { process.kill(-child.pid, "SIGTERM"); }
    catch (e) { if (e.code !== "ESRCH") throw e; }
  };
  // The gate itself can be interrupted, and a Ctrl-C that leaves a server behind is
  // the same leak by another route. (SIGKILL of this process is uninterceptable —
  // inherent, and the reason the group kill above matters more than these hooks.)
  for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, stop);

  const deadline = Date.now() + BACKEND_READY_MS;
  for (;;) {
    if (exited !== null) throw new Error(`backend exited ${exited} before answering:\n${log}`);
    // The real route the probes depend on, not a synthetic /health — if listing
    // projects is broken then the probes ARE going to 500 and we want to know now.
    const alive = await fetch(`${url}/api/projects/`).then((r) => r.ok).catch(() => false);
    if (alive) break;
    if (Date.now() > deadline) {
      stop();
      throw new Error(`backend did not answer ${url}/api/projects/ within ${BACKEND_READY_MS}ms:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url, stop };
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
  // BACKEND_URL is the one seam: each probe boots its own Vite server, and
  // vite.config.js reads this to aim the /api + /asset + /render proxies. Setting it
  // here is what makes 93 probes reach a live backend without touching any of them.
  const env = { ...process.env, ...(backendUrl ? { BACKEND_URL: backendUrl } : {}) };
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(cmd[0], cmd[1], { cwd, stdio: ["ignore", "pipe", "pipe"], env });
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
/** Substring filter on the file's basename, for iterating on one failure without
 *  paying for the other 180. NOT a way to report a passing gate — the gate is the
 *  unfiltered run. */
const filter = args.find((a) => a.startsWith("--filter="))?.slice("--filter=".length) ?? "";
const select = (kind) => collect(kind).filter((f) => basename(f).includes(filter));

if (args.includes("--list")) {
  for (const k of kinds) console.log(`${k.padEnd(8)} ${select(k).length}\n  ${select(k).map((f) => basename(f)).join("\n  ")}`);
  process.exit(0);
}

const totals = { pass: 0, fail: 0 };
const allFailures = [];
const started = Date.now();
/** Read by runOne for every child. Set once, only if the browser kind will run and
 *  the caller has not supplied a backend of their own. */
let backendUrl = process.env.BACKEND_URL || "";
let backend = null;
try {
  if (kinds.includes("browser") && !backendUrl && select("browser").length) {
    process.stdout.write("backend ");
    backend = await startBackend();
    backendUrl = backend.url;
    console.log(`up on ${backendUrl}`);
  } else if (backendUrl) {
    console.log(`backend supplied: ${backendUrl}`);
  }
  for (const kind of kinds) {
    const files = select(kind);
    if (!files.length) { console.log(`${kind}: no files`); continue; }
    process.stdout.write(`${kind} (${files.length}, x${Math.min(CONCURRENCY[kind], files.length)}) `);
    const r = await runKind(kind, files);
    console.log(`  ${r.pass} pass / ${r.fail} fail`);
    totals.pass += r.pass; totals.fail += r.fail;
    allFailures.push(...r.failures.map((x) => ({ ...x, kind })));
  }
} finally {
  backend?.stop();
}

console.log(`\n${"=".repeat(64)}`);
console.log(`TOTAL: ${totals.pass} pass / ${totals.fail} fail   (${((Date.now() - started) / 1000).toFixed(0)}s)`);
if (allFailures.length) {
  console.log(`\nFAILING (${allFailures.length}):`);
  for (const f of allFailures) console.log(`\n  [${f.kind}] ${f.name}  (${(f.ms / 1000).toFixed(0)}s)\n    ${f.tail.replace(/\n/g, "\n    ")}`);
}
process.exit(totals.fail === 0 ? 0 : 1);
