/**
 * THE BROWSER-RENDER PROBE HARNESS — the shared boot for every probe that has to
 * exercise the browser render/encode path on a REAL PLAIN-HTTP NON-LOOPBACK
 * ORIGIN.
 *
 * WHY A NON-LOOPBACK ORIGIN IS THE WHOLE POINT. `http://127.0.0.1` is a SECURE
 * CONTEXT by specification, so a probe served from loopback silently gets
 * `VideoEncoder`, `crypto.randomUUID`, OPFS, Web Locks and `SharedArrayBuffer`
 * — every single API that CORE TENET #70 (the app must work on plain
 * non-localhost HTTP) forbids depending on. A WebCodecs encoder passed exactly
 * that kind of test once and then did not exist on the machine it shipped to.
 * So this harness binds Vite to 0.0.0.0, navigates by the machine's own LAN
 * IPv4, and ASSERTS `isSecureContext === false` before a probe is allowed to
 * measure anything.
 *
 * It also starts a REAL project backend (server/server.py) against a THROWAWAY
 * projects directory, so a probe can submit real render jobs and upload real
 * bytes without touching the user's projects.
 *
 * `hmr: false, watch: null` is not a detail: several agents edit this tree
 * concurrently, and a stray save would otherwise reload the page in the middle
 * of an `evaluate` and abort the run.
 *
 * Every failure here throws LOUDLY — a probe that cannot get a plain-HTTP origin
 * must not fall back to loopback and report success.
 */

import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
import { networkInterfaces } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/demo_apps/PowerRP — every path below is derived from it (dump-portable). */
export const POWERRP = resolve(HERE, "..");
const WEB = join(POWERRP, "web");
const SERVER_PY = join(POWERRP, "server", "server.py");

/** How long the Python backend gets to answer its first request. */
const BACKEND_READY_TIMEOUT_MS = 60_000;
const BACKEND_POLL_MS = 250;
/**
 * How long the FIRST page load may take. This is a STARTUP deadline, not a cap on
 * any work the probe then does: the load is where Vite pre-bundles the four lazy
 * dependencies its config names (pdf, math typesetting, math input, diagrams), and
 * that "Forced re-optimization of dependencies" pass blows straight through
 * puppeteer's 30 s DEFAULT whenever the machine is contended — several agents run
 * probes in this tree at once, and a probe died on exactly that
 * ("Navigation timeout of 30000 ms exceeded" inside bootProbe) with nothing wrong
 * in the tree. cli/render_job.js allows 180 s for the same load for the same
 * reason; this matches it, so only a genuine hang trips it, and a trip is still a
 * LOUD failure.
 */
const PAGE_LOAD_TIMEOUT_MS = 180_000;
/** How many free-port attempts before giving up. server.py takes an explicit
 *  port, so the harness must find one itself; several agents run probes
 *  concurrently in this tree, so the found port can be claimed between the probe
 *  and the bind. Retrying is the honest handling of that race — it is a real,
 *  expected, transient condition, and exhausting the retries throws. */
const BACKEND_PORT_ATTEMPTS = 12;

/**
 * Pure function. The first non-loopback IPv4 address of `interfaces` (the shape
 * `os.networkInterfaces()` returns), or null when the machine has none.
 *
 * This address is what makes the origin insecure, so there is no fallback to
 * 127.0.0.1: a caller that gets null must fail rather than quietly measure a
 * secure context.
 *
 * @param {object} interfaces os.networkInterfaces()-shaped map
 * @returns {string|null}
 *
 * @example lanIPv4({eth0: [{family: "IPv4", address: "10.0.0.5", internal: false}]}) // "10.0.0.5"
 * @example lanIPv4({lo: [{family: "IPv4", address: "127.0.0.1", internal: true}]}) // null
 */
export function lanIPv4(interfaces) {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

/** Command (async). Sleep `ms`. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Backends this process started that are still alive, pid → {proc, projectsDir}, so
 * the exit hooks below can reach them. A probe starts exactly one, but a registry
 * makes the teardown independent of how many.
 */
const liveBackends = new Map();

/**
 * Command (kills a process group; removes a directory). Tear one backend down for
 * good: signal its whole GROUP (see startBackendOn for why the pid alone is not
 * enough) and delete its throwaway projects directory. Idempotent — calling it
 * twice is a no-op, which is what lets both `stop()` and an exit hook call it.
 *
 * ESRCH is the one condition tolerated, because "the group is already gone" IS the
 * goal; any other signalling error is re-thrown.
 *
 * @param {number} pid The spawned backend's pid.
 */
function killBackend(pid) {
  const entry = liveBackends.get(pid);
  if (!entry) return;
  liveBackends.delete(pid);
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  rmSync(entry.projectsDir, { recursive: true, force: true });
}

// TEARDOWN ON EVERY EXIT PATH THAT CAN RUN CODE. A probe's own `finally { stop() }`
// covers the happy path, but the canonical runner (tests/run_all.mjs) enforces a
// per-test TIMEOUT, and a probe killed by that never reaches its finally — which is
// exactly how a fleet of orphaned backends accumulates, each still holding a port
// and a temp directory. SIGKILL of the probe itself cannot be intercepted; that is
// inherent, and is why killBackend tolerates an already-dead group.
let exitHooksInstalled = false;
function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const teardown = () => { for (const pid of [...liveBackends.keys()]) killBackend(pid); };
  process.on("exit", teardown);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { teardown(); process.exit(1); });
  }
}

// freePort comes from ./free_port.js. This harness ALREADY retried on a lost
// port (startBackend's BACKEND_PORT_ATTEMPTS loop), so the shared allocator adds
// the other half of the fix: the number is re-verified as still bindable before
// it is returned, so most collisions never reach the retry at all. It remains
// inherently advisory — the backend binds hundreds of milliseconds later, which
// is why the retry loop stays.

/**
 * Command (async; spawns a process, creates a temp dir). Start the project
 * backend on a throwaway projects store and wait until it answers. Retries on a
 * port collision (BACKEND_PORT_ATTEMPTS) and throws with the backend's own log
 * on any other failure.
 *
 * @returns {Promise<{port, projectsDir, proc, backendLog, stop}>}
 */
async function startBackend() {
  let last = null;
  for (let attempt = 0; attempt < BACKEND_PORT_ATTEMPTS; attempt++) {
    const port = await freePort();
    try {
      return await startBackendOn(port);
    } catch (e) {
      last = e;
      if (!/Address already in use/.test(String(e.message))) throw e;
    }
  }
  throw new Error(`probe harness: could not claim a free backend port in ${BACKEND_PORT_ATTEMPTS} attempts.\n${last?.message ?? ""}`);
}

/**
 * Command (async; spawns a process, creates a temp dir). startBackend's one
 * attempt, on an explicit `port`.
 *
 * @param {number} port TCP port to serve on.
 * @returns {Promise<{port, projectsDir, proc, backendLog, stop}>}
 */
async function startBackendOn(port) {
  const projectsDir = mkdtempSync(join(tmpdir(), "powerrp_probe_projects_"));
  // `detached: true` puts the backend in its OWN PROCESS GROUP, and that is not a
  // detail: `uv run server.py` is a WRAPPER that execs a python grandchild, so
  // killing the pid we are handed leaves the grandchild running — orphaned, still
  // holding its port and its temp projects directory. Signalling the negative pid
  // kills the whole group. See killBackend + the exit hooks below; detaching means
  // the process would otherwise survive this probe entirely, so the two go together.
  const proc = spawn("uv", ["run", SERVER_PY, "serve", `--port=${port}`], {
    cwd: dirname(SERVER_PY),
    env: { ...process.env, POWERRP_PROJECTS_DIR: projectsDir },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  liveBackends.set(proc.pid, { proc, projectsDir });
  installExitHooks();
  // A detached child keeps the event loop alive on its own; unref lets this process
  // exit normally, and the exit hook is what takes the backend with it.
  proc.unref();

  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  proc.on("exit", (code) => { if (code !== 0 && code !== null) log += `\n[backend exited ${code}]`; });

  const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/`);
      if (res.ok) break;
    } catch { /* not up yet — the deadline / exit check below are the only exits */ }
    if (proc.exitCode !== null) {
      killBackend(proc.pid);
      throw new Error(`probe harness: the project backend exited ${proc.exitCode} before serving.\n${log}`);
    }
    if (Date.now() > deadline) {
      killBackend(proc.pid);
      throw new Error(`probe harness: the project backend did not come up on port ${port} within ${BACKEND_READY_TIMEOUT_MS}ms.\n${log}`);
    }
    await sleep(BACKEND_POLL_MS);
  }
  return {
    port,
    projectsDir,
    proc,
    backendLog: () => log,
    stop() {
      killBackend(proc.pid);
    },
  };
}

/**
 * Command (async; starts a Vite server, a Python backend and a headless browser).
 * THE probe boot. Returns the live handles plus a `stop()` that tears all three
 * down.
 *
 * Asserts the page's origin is NOT a secure context; throws otherwise (see the
 * header — that assertion is the reason this harness exists).
 *
 * @param {object} [o]
 * @param {number} [o.viewportWidth]
 * @param {number} [o.viewportHeight]
 * @returns {Promise<{page, browser, baseUrl, backend, errors, stop}>}
 */
export async function bootProbe({ viewportWidth = 1000, viewportHeight = 700 } = {}) {
  const ip = lanIPv4(networkInterfaces());
  if (!ip)
    throw new Error("probe harness: this machine has no non-loopback IPv4 address, so a PLAIN-HTTP INSECURE origin cannot be produced. The probe would silently test a secure context instead — refusing.");

  const backend = await startBackend();

  const { createServer } = await import("vite");
  process.env.BACKEND_URL = `http://127.0.0.1:${backend.port}`;
  const vite = await createServer({
    configFile: join(WEB, "vite.config.js"),
    server: { port: 0, strictPort: false, open: false, host: "0.0.0.0", hmr: false, watch: null },
  });
  await vite.listen();
  const baseUrl = `http://${ip}:${vite.httpServer.address().port}`;

  const { launchBrowser } = await import("./puppeteerLaunch.js");
  const browser = await launchBrowser({ args: [
      "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", // Chrome treats some ranges as trustworthy; nothing here does that for a
      // LAN IP, and the assertion below is what actually proves it.
    ] });
  const page = await browser.newPage();
  await page.setViewport({ width: viewportWidth, height: viewportHeight });

  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|no WebGPU adapter|WebGPU init failed|favicon/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
  const secure = await page.evaluate(() => window.isSecureContext);
  if (secure !== false)
    throw new Error(`probe harness: ${baseUrl} reported isSecureContext=${secure}. This probe exists to test the INSECURE plain-HTTP case; a secure origin would hide the very capability gaps being tested — refusing.`);

  /**
   * Command (async; opens a tab). A FRESH page on the same origin and the same
   * browser profile — so it shares IndexedDB with every other page here, which is
   * exactly what a resume test needs: closing a page and opening another is how a
   * user closes and reopens a tab.
   */
  async function newPage() {
    const p = await browser.newPage();
    await p.setViewport({ width: viewportWidth, height: viewportHeight });
    p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });
    await p.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
    return p;
  }

  return {
    page, browser, baseUrl, backend, errors, newPage,
    /** Absolute /@fs URL for a module inside the PowerRP tree. */
    fsUrl: (relative) => `/@fs${join(POWERRP, relative)}`,
    async stop() {
      await browser.close().catch(() => {});
      await vite.close().catch(() => {});
      backend.stop();
    },
  };
}

/**
 * Pure function. A checker that records failures. `check(cond, label)` prints one
 * line per assertion and pushes failures into the returned array.
 *
 * @returns {{check: Function, fails: string[]}}
 *
 * @example
 * // const {check, fails} = checker(); check(1 === 1, "one is one"); fails.length // 0
 */
export function checker() {
  const fails = [];
  const check = (cond, label) => {
    console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
    if (!cond) fails.push(label);
  };
  return { check, fails };
}
