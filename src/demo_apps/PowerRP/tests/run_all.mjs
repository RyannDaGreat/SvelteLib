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
 * ── AND A THIRD OUTCOME: SKIP ────────────────────────────────────────────────
 * A suite whose PREREQUISITE is absent (no internet, no fixture clip, no user-data
 * project) exits 0 and prints `SKIP — <reason>`. That contract predates this file;
 * what did not exist was any accounting for it, so a skipped suite was counted as
 * a PASS. Every one now lands in its own column and is NAMED in the summary. It
 * still does not redden the run — a missing prerequisite is not a defect — but it
 * can no longer inflate the number the whole file exists to make honest.
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
import { readdirSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve, relative, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { withFreePort } from "./free_port.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "../../..");

/** Per-test wall clock. A browser probe boots Vite + Chrome + CanvasKit, so it needs
 *  far longer than a pure-JS suite; the slowest legitimate probe observed is ~4 min.
 *
 *  NODE WAS 300_000 AND THAT WAS A PERMANENT FALSE RED (measured 2026-08-06).
 *  `sky_twinkle_trails_test.js` takes **305.47 s standalone and PASSES** with a wider
 *  window — it printed every check `ok` and then died on the cap, which reads in the
 *  summary exactly like an assertion failure and is not one. Under this file's own x8
 *  node concurrency it is slower still, so the suite failed on a clean tree, on both
 *  branches, every run. Two separate Round 7 sessions spent time attributing it to their
 *  own changes before measuring it.
 *
 *  Raised to match `browser` rather than special-cased per suite: a real HANG still
 *  fails, just later, and R6-30's ruling is that a gate which cries wolf teaches you to
 *  ignore it — that is the expensive failure, not a slow suite. If a node suite ever
 *  legitimately needs more than this, the suite is the thing to fix. */
const TIMEOUT_MS = { node: 600_000, browser: 600_000, python: 300_000, shell: 300_000 };

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

// freePort comes from ./free_port.js (imported at the top). The naive version
// that used to live here — bind 0, read the port, close, return — leaves a TOCTOU
// window between the close and the child's bind, and that window is LONG because
// the child is `uv run server.py` with an interpreter to boot. Probes run three
// at a time, each spawning its own backend, so two could be handed the same
// number and the loser died with `Errno 48 Address already in use`.
//
// RE-VERIFYING THE PORT IS NOT ENOUGH, and this file learned that the expensive
// way a SECOND time: `freePort()` alone re-checks the port at ALLOCATION time,
// which says nothing about who binds it during the interpreter boot that follows.
// A whole 26-probe batch was lost to exactly that — the gate's own backend died
// with `Errno 48` on a port freePort had just certified, and because the backend
// is started BEFORE the lanes, zero probes ran and the log showed no test names
// at all. free_port.js already shipped `withFreePort` for this case (its whole
// point is a caller whose CHILD does the binding); startBackend simply never
// used it. Now it does: the port is a parameter, and losing the race costs one
// retry on a fresh number instead of the entire run.

/**
 * Command. Starts the project backend on `port` and resolves {url, stop}. Throws
 * LOUDLY with the server's own output if it never answers — an unavailable
 * prerequisite must not masquerade as 93 failing probes. Rejects with the child's
 * own EADDRINUSE text when it loses the port race, which is what lets the
 * `withFreePort` wrapper in `startBackendWithRetry` tell that case apart from a
 * real failure and retry it.
 *
 * `uv run` IS A WRAPPER THAT EXECS A PYTHON GRANDCHILD, so killing the pid we hold
 * kills `uv` and leaves the server running, reparented to init, still holding its
 * port. A sibling agent proved this the expensive way: its harness leaked ONE
 * backend per probe run and had accumulated 13. So the child gets its own process
 * GROUP (`detached`) and teardown signals the NEGATIVE pid to take the grandchild
 * with it. Orphaned server fleets are exactly what this file's own header blames for
 * a ~50% flake elsewhere; the gate must not manufacture them.
 *
 * @param {number} port
 * @returns {Promise<{url: string, stop: () => void}>}
 */
async function startBackend(port) {
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

  /** Command. Kills the whole group, ONCE. Tolerates an already-dead group (ESRCH)
   *  and ONLY that — any other errno is a real problem and re-throws.
   *
   *  IT IS IDEMPOTENT BY A FLAG, NOT BY `exited`, AND THE DIFFERENCE CRASHED THE
   *  GATE. `stop()` runs twice by design: once from the `finally` and once from the
   *  `exit` hook below. The `exited !== null` guard cannot catch the second one,
   *  because `close` is delivered on the event loop and the `exit` hook runs when
   *  the loop is already done — so `exited` is still null and the second call
   *  re-signals a group whose leader is now a zombie. macOS answers that with
   *  EPERM, not ESRCH, which this rethrew: the gate printed its full verdict and
   *  then died on `Error: kill EPERM` with a stack, exiting non-zero. A green run
   *  that ends in a stack trace reads as a broken gate. Sending the signal once is
   *  the fix; widening the errno allow-list would have hidden a real permission
   *  failure on the FIRST call, which is the one that matters. */
  let signalled = false;
  const stop = () => {
    if (signalled || exited !== null) return;
    signalled = true;
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

/**
 * Command. `startBackend` on a free port, retrying only when the child LOSES THE
 * PORT RACE.
 *
 * Why this exists as its own function rather than inline: the gate starts its
 * backend BEFORE any lane runs, so a lost race here is not one flaky probe, it is
 * the entire run — every probe reports an absent dependency and the log contains
 * no test names at all. `withFreePort` re-runs only on the EADDRINUSE signature
 * (`defaultIsPortRace`); a backend that boots and then genuinely fails still
 * throws on the first attempt, so a real breakage is never retried into a
 * confusing loop.
 *
 * @returns {Promise<{url: string, stop: () => void}>}
 */
function startBackendWithRetry() {
  return withFreePort((port) => startBackend(port));
}

/**
 * THE SKIP CONTRACT. A suite whose PREREQUISITE is absent exits 0 and prints a
 * line-start `SKIP — <reason>`. github_live_probe.js set it (an offline machine
 * must not redden the gate), backend_precondition.js and video_perf_probe.js
 * adopted it verbatim, and fixture_precondition.js now uses it for user-data
 * fixtures.
 *
 * IT HAD TO BE COUNTED, because until it was, a skip WAS A PASS. Exit 0 is exit
 * 0: the totals said "N pass" and N included every suite that had quietly proved
 * nothing. That is the exact defect this file's own header blames for a session
 * of false confidence, one level down. A skip is not a failure and must not
 * redden the run — but it must be visible, named, and in its own column.
 *
 * Deliberately anchored to line start with the em dash: `video_v5_scrub_live_probe`
 * prints `── HEAVY CLIP: SKIPPED — …` for a PHASE it skipped while the rest of the
 * suite ran, and that is not a skipped suite.
 */
const SKIP_LINE = /^SKIP — .*/m;

/** How many trailing output lines a FAILING child contributes to the summary.
 *
 *  IT WAS 3, AND THREE LINES IS OFTEN THE STACK WITHOUT THE MESSAGE. Measured on
 *  a real red: `text_word_delete_probe` reported one `at file:///…:44:14` frame,
 *  a blank line and `Node.js v24.19.0` — no error text at all, so triage had to
 *  re-run the probe by hand just to learn WHAT failed. That cost is paid on every
 *  red, by every reader, forever; the saving was a handful of rows on runs that
 *  are green anyway. Twelve is enough for a node assertion's actual/expected
 *  block and for a probe's own failure list, and a run with enough failures to
 *  make twelve unreadable is already telling you to stop reading and start
 *  fixing. */
const FAILURE_TAIL_LINES = 12;

/** Command (spawns a child). Runs one test file; resolves {ok, skip, ms, tail}. Never
 *  throws — a crashed child is a FAILING TEST, not an error in the runner, and its
 *  output is kept so the report can show why rather than just that. */
/** The gate's own dep-cache root for this run, or "" when it could not be made.
 *  One directory per concurrent BROWSER slot lives under it; see viteCacheDir. */
const viteCacheRoot = (() => {
  try { return mkdtempSync(join(tmpdir(), "powerrp-gate-vite-")); }
  catch (e) {
    // Not fatal: without it the probes share node_modules/.vite exactly as they
    // always did. But SAY SO — the flakiness it prevents is the kind that reads
    // like a product defect, and a silent fallback here would send the next
    // operator hunting for a bug in the app.
    console.error(`run_all: could not create a private Vite cache root (${e.message}); browser probes will SHARE node_modules/.vite and may flake with "504 Outdated Optimize Dep".`);
    return "";
  }
})();

/**
 * Pure function. The dep-cache directory for one concurrent browser slot, or ""
 * for any other kind (and when the root could not be made).
 *
 * PER SLOT, NOT PER PROBE: probes in a slot run one after another, never at once,
 * so they can share a cache safely and the second one onward finds it warm. Two
 * DIFFERENT slots must never share, which is the whole point — see the long note
 * on `cacheDir` in web/vite.config.js for the failure this prevents.
 *
 * @param {string} kind test kind
 * @param {number} slot worker index within that kind
 * @returns {string} an absolute directory, or "" to leave Vite's default alone
 *
 * @example // viteCacheDir("browser", 0) // "/var/folders/…/powerrp-gate-vite-Xy12/slot-0"
 * @example // viteCacheDir("node", 0)    // ""  — a node suite boots no Vite server
 */
function viteCacheDir(kind, slot) {
  return kind === "browser" && viteCacheRoot ? join(viteCacheRoot, `slot-${slot}`) : "";
}

function runOne(kind, file, slot = 0) {
  // `uv run <file>` — NOT `uv run python <file>`. Only the former reads the file's
  // PEP 723 inline `# /// script` dependency block; adding an explicit `python`
  // interpreter argument makes uv run the script in the AMBIENT environment and
  // ignore the metadata entirely. Every python test here imports server/server.py,
  // which imports `fire` at module scope, so all four were failing at the import
  // with ModuleNotFoundError — a whole test KIND red for an environment reason,
  // reported identically to a real defect. Found while adding
  // self_contained_zip_test.py, whose own deps block had no effect either.
  const cmd = kind === "python" ? ["uv", ["run", file]]
    : kind === "shell" ? ["bash", [file]]
    : ["node", [file]];
  // Browser probes resolve fixtures off the SvelteLib repo root by convention; node
  // suites resolve off their own file. Honour both rather than forcing one.
  const cwd = kind === "browser" ? repoRoot : appRoot;
  // BACKEND_URL is the one seam: each probe boots its own Vite server, and
  // vite.config.js reads this to aim the /api + /asset + /render proxies. Setting it
  // here is what makes 93 probes reach a live backend without touching any of them.
  // POWERRP_VITE_CACHE_DIR is the second such seam, and it is what keeps three
  // concurrent probes from rewriting one another's pre-bundled deps mid-page.
  // web/vite.config.js reads it; unset, Vite's default applies. Same shape as
  // BACKEND_URL: set here, and 213 probes need no edit.
  const cacheDir = viteCacheDir(kind, slot);
  const env = {
    ...process.env,
    ...(backendUrl ? { BACKEND_URL: backendUrl } : {}),
    ...(cacheDir ? { POWERRP_VITE_CACHE_DIR: cacheDir } : {}),
  };
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
      const skip = code === 0 ? (buf.match(SKIP_LINE)?.[0] ?? null) : null;
      done({ ok: code === 0, skip, ms: Date.now() - started, tail: buf.trimEnd().split("\n").slice(-FAILURE_TAIL_LINES).join("\n") });
    });
    child.on("error", (e) => { clearTimeout(killer); done({ ok: false, skip: null, ms: Date.now() - started, tail: String(e) }); });
  });
}

/** Command. Runs a kind at its own concurrency; returns {pass, fail, failures[]}.
 *
 *  A FAILURE NAMES ITSELF THE MOMENT IT HAPPENS, not only in the summary. The
 *  progress dots are anonymous by design (154 names would bury the shape of the
 *  run), but the summary used to be the ONLY place a failing probe's NAME was
 *  ever written down — so a run that stalled before printing it lost every bit
 *  of attribution, and the operator was left with "11 F" and no idea which. That
 *  is not hypothetical: the browser lane has stalled near the summary twice, and
 *  each time the triage had to be restarted from zero. The interleaved line
 *  costs one row per failure (only failures) and makes the log harvestable with
 *  `grep FAIL` while the run is still going. */
async function runKind(kind, files) {
  const queue = [...files];
  const failures = [];
  const skips = [];
  let pass = 0;
  const worker = async (slot) => {
    for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
      const r = await runOne(kind, f, slot);
      const name = basename(f);
      if (r.skip) { skips.push({ name, reason: r.skip }); process.stdout.write("s"); }
      else if (r.ok) { pass++; process.stdout.write("."); }
      else {
        failures.push({ name, path: relative(repoRoot, f), ms: r.ms, tail: r.tail });
        process.stdout.write(`\nFAIL [${kind}] ${name} (${(r.ms / 1000).toFixed(0)}s)\n`);
      }
    }
  };
  // `Array.from`'s map fn is called (element, index) — the slot is the SECOND
  // argument, so `worker` cannot be passed bare here: it would take the (empty)
  // element as its slot and every worker would share slot `undefined`, which is
  // one cache directory again and the whole fix undone, silently.
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY[kind], files.length) }, (_, slot) => worker(slot)));
  return { pass, fail: failures.length, failures, skips };
}

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const kinds = only ? [only] : ["node", "python", "shell", "browser"]; // browser last: slowest
/** Substring filter on the file's basename, for iterating on one failure without
 *  paying for the other 180. NOT a way to report a passing gate — the gate is the
 *  unfiltered run.
 *
 *  COMMA-SEPARATED = OR, because triage works in CLASSES, not single files. A
 *  sweep that finds nine probes red for one shared cause needs to re-run exactly
 *  those nine to prove the cause; without this it was one run per probe (nine
 *  backend spin-ups) or the full 154. Empty string keeps matching everything. */
const filterTerms = (args.find((a) => a.startsWith("--filter="))?.slice("--filter=".length) ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const select = (kind) => collect(kind).filter((f) =>
  filterTerms.length === 0 || filterTerms.some((t) => basename(f).includes(t)));

if (args.includes("--list")) {
  for (const k of kinds) console.log(`${k.padEnd(8)} ${select(k).length}\n  ${select(k).map((f) => basename(f)).join("\n  ")}`);
  process.exit(0);
}

const totals = { pass: 0, fail: 0, skip: 0 };
const allFailures = [];
const allSkips = [];
const started = Date.now();
/** Read by runOne for every child. Set once, only if the browser kind will run and
 *  the caller has not supplied a backend of their own. */
let backendUrl = process.env.BACKEND_URL || "";
let backend = null;
try {
  if (kinds.includes("browser") && !backendUrl && select("browser").length) {
    process.stdout.write("backend ");
    backend = await startBackendWithRetry();
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
    console.log(`  ${r.pass} pass / ${r.fail} fail${r.skips.length ? ` / ${r.skips.length} skip` : ""}`);
    totals.pass += r.pass; totals.fail += r.fail; totals.skip += r.skips.length;
    allFailures.push(...r.failures.map((x) => ({ ...x, kind })));
    allSkips.push(...r.skips.map((x) => ({ ...x, kind })));
  }
} finally {
  backend?.stop();
  // The per-slot dep caches are scratch: a few hundred MB of pre-bundled chunks
  // that mean nothing after the run. Removing them is best-effort BUT REPORTED —
  // a tmpdir quietly filling up over many gate runs is exactly the kind of thing
  // that surfaces months later as an unrelated mystery.
  if (viteCacheRoot) {
    try { rmSync(viteCacheRoot, { recursive: true, force: true }); }
    catch (e) { console.error(`run_all: could not remove the Vite cache root ${viteCacheRoot} (${e.message}) — delete it by hand.`); }
  }
}

console.log(`\n${"=".repeat(64)}`);
console.log(`TOTAL: ${totals.pass} pass / ${totals.fail} fail / ${totals.skip} skip   (${((Date.now() - started) / 1000).toFixed(0)}s)`);
if (allSkips.length) {
  // NAMED, always. A skip is a suite that proved nothing; folding it into the
  // pass column is how a gate stops meaning what it says.
  console.log(`\nSKIPPED (${allSkips.length}) — prerequisite absent, not a failure:`);
  for (const s of allSkips) console.log(`  [${s.kind}] ${s.name}\n    ${s.reason}`);
}
if (allFailures.length) {
  console.log(`\nFAILING (${allFailures.length}):`);
  for (const f of allFailures) console.log(`\n  [${f.kind}] ${f.name}  (${(f.ms / 1000).toFixed(0)}s)\n    ${f.tail.replace(/\n/g, "\n    ")}`);
}
process.exit(totals.fail === 0 ? 0 : 1);
