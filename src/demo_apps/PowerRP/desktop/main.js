/**
 * PowerRP desktop shell — the ENTIRE app logic is: locate (or first-run
 * install) a PowerRP checkout, run its existing launcher (run_server.sh) as a
 * child PROCESS GROUP, open a BrowserWindow on the URL it prints, and take the
 * whole server tree down when the app quits. Zero changes to the web codebase
 * (the user ruling: "almost zero changes... the UI we have on our website pops
 * up inside... when you quit the app the server quits with it"). The
 * launcher's own start_server.sh traps reap its backend + Vite when the GROUP
 * gets SIGTERM — we kill the group exactly the way it expects.
 *
 * ── WHERE THE REPO IS (three modes, first match wins) ─────────────────────────
 * 1. UNPACKAGED (`electron .` from desktop/): the dump in place, dev mode —
 *    desktop/ lives inside the PowerRP app dir.
 * 2. PACKAGED with Resources/repo/ (the SHIPPED build): the repo is VENDORED
 *    in the bundle (electron-builder extraResources; projects/ excluded — the
 *    dev machine's local projects are 1.4 GB of video). First run copies it to
 *    ~/Library/Application Support/PowerRP/repo-<version>/ and runs `npm ci`
 *    there (Resources is read-only under signing/translocation, and deps are
 *    machine-local), showing a setup page meanwhile. User documents live in
 *    Application Support/PowerRP/projects — STABLE across app versions,
 *    seeded with the Imitations demo on the first ever run.
 * 3. PACKAGED with only Resources/repo-path.txt (a `npm run package` build on
 *    a dev machine): launch that checkout in place — the local-dev .app.
 *
 * ── VENDORED RUNTIMES (the user ruling: "could installing node and uv be
 *    done locally inside the bundle?" — yes) ──────────────────────────────────
 * Resources/bin/node/ (the official self-contained node dist: node + npm) and
 * Resources/bin/uv (a single static binary) ship IN the bundle
 * (fetch_runtimes.sh at package time), PREPENDED to every child's PATH — so a
 * shipped app needs NO preinstalled tooling. uv bootstraps Python itself on
 * first run; its caches are pointed into Application Support (writable),
 * which is also why first run wants network (npm ci + the Python download).
 * A dev machine's own node/uv still win in mode 1/3 (they come first on the
 * inherited PATH only in unpackaged mode; packaged mode puts the bundled ones
 * first for determinism).
 *
 * GUI-LAUNCH PATH GOTCHA: a double-clicked app inherits launchd's minimal
 * PATH (/usr/bin:/bin), missing /opt/homebrew/bin where dev-machine tools
 * live — the augmented PATH covers modes 1/3 too.
 *
 * LOUD FAILURE DISCIPLINE: a missing runtime, a failed npm ci, a launcher
 * that dies or never prints its URL — all put the real output in an error
 * dialog and exit nonzero. Never a silent blank window.
 */

const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, appendFileSync } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

/** Cold Vite + backend startup is ~5-15s; 120s covers a first-run dep optimize. */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 250;
/** First-run `npm ci` downloads the web deps (~550 MB installed) — allow long. */
const SETUP_TIMEOUT_MS = 15 * 60_000;
/** Grace between SIGTERM to the group and escalating to SIGKILL on quit. */
const SHUTDOWN_GRACE_MS = 5_000;

/** Child env: bundled runtimes FIRST when packaged (determinism), then the
 * inherited PATH, then the usual dev-machine runtime homes launchd strips. */
function childEnv() {
  const bundledBins = app.isPackaged
    ? [path.join(process.resourcesPath, "bin/node/bin"), path.join(process.resourcesPath, "bin")]
    : [];
  const env = {
    ...process.env,
    PATH: [...bundledBins, process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")].filter(Boolean).join(":"),
  };
  if (app.isPackaged) {
    // uv's python + package caches must be writable (Resources is not).
    env.UV_CACHE_DIR = path.join(app.getPath("userData"), "uv-cache");
    env.UV_PYTHON_INSTALL_DIR = path.join(app.getPath("userData"), "uv-python");
  }
  return env;
}
const CHILD_ENV = { PATH: "" }; // filled in whenReady (app.isPackaged needs app)

let serverChild = null;
let serverExited = false;
let shuttingDown = false;
let win = null;

/** Pure. One-line styled HTML page for setup states. */
const setupPage = (msg) =>
  "data:text/html;charset=utf-8," + encodeURIComponent(
    `<body style="margin:0;display:grid;place-items:center;height:100vh;background:#16161e;color:#c0caf5;font:15px system-ui"><div style="text-align:center;max-width:44em"><h2 style="font-weight:600">PowerRP</h2><p>${msg}</p></div></body>`);

/** Command. Dies loudly with the message in a dialog. */
function fatal(title, message) {
  dialog.showErrorBox(title, message);
  app.exit(1);
}

/** Query. Asserts `bin` resolves on the child PATH (bundled or system). */
function requireBin(bin, hint) {
  const r = spawnSync("/usr/bin/which", [bin], { env: CHILD_ENV, encoding: "utf8" });
  if (!r.stdout.trim()) throw new Error(`"${bin}" was not found on PATH.\n${hint}`);
}

/**
 * Command (first run only): vendored repo → Application Support copy with
 * installed deps + a stable projects dir. Returns the PowerRP app dir inside
 * the ready copy. Progress goes to setup.log in Application Support.
 */
async function ensureSupportRepo(vendoredRepo) {
  const support = app.getPath("userData");
  const verDir = path.join(support, `repo-${app.getVersion()}`);
  const readyMarker = path.join(verDir, ".ready");
  const log = path.join(support, "setup.log");
  const projectsDir = path.join(support, "projects");

  if (!existsSync(readyMarker)) {
    requireBin("node", "The bundle should carry it (Resources/bin/node) — rebuild with `npm run package:dmg`, or `brew install node`.");
    requireBin("npm", "It ships beside the bundled node — rebuild with `npm run package:dmg`, or `brew install node`.");
    requireBin("uv", "The bundle should carry it (Resources/bin/uv) — rebuild with `npm run package:dmg`, or `brew install uv`.");

    win.loadURL(setupPage(`First-run setup: installing into<br><code>${verDir}</code><br><br>This downloads the web dependencies once (a few minutes, needs network).<br>Log: <code>${log}</code>`));
    mkdirSync(support, { recursive: true });
    appendFileSync(log, `\n=== setup ${new Date().toISOString()} → ${verDir}\n`);

    rmSync(verDir, { recursive: true, force: true }); // a half-copied previous attempt restarts cleanly
    const cp = spawnSync("cp", ["-R", vendoredRepo, verDir], { env: CHILD_ENV, encoding: "utf8" });
    if (cp.status !== 0) throw new Error(`copying the vendored repo failed: ${cp.stderr}`);

    await new Promise((resolve, reject) => {
      const npm = spawn("npm", ["ci", "--no-fund", "--no-audit"], { cwd: verDir, env: CHILD_ENV });
      const timer = setTimeout(() => { npm.kill("SIGKILL"); reject(new Error(`npm ci exceeded ${SETUP_TIMEOUT_MS / 60000} minutes — see ${log}`)); }, SETUP_TIMEOUT_MS);
      npm.stdout.on("data", (b) => appendFileSync(log, b));
      npm.stderr.on("data", (b) => appendFileSync(log, b));
      npm.on("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`npm ci exited ${code} — see ${log}`));
      });
    });
    writeFileSync(readyMarker, new Date().toISOString() + "\n");
  }

  // The STABLE user projects dir (survives app updates); seeded with the
  // Imitations demo deck the first time it is created.
  if (!existsSync(projectsDir)) {
    mkdirSync(projectsDir, { recursive: true });
    const demo = path.join(verDir, "src/demo_apps/PowerRP/projects/Imitations");
    if (existsSync(demo)) spawnSync("cp", ["-R", demo, path.join(projectsDir, "Imitations")], { env: CHILD_ENV });
  }
  CHILD_ENV.POWERRP_PROJECTS_DIR = projectsDir;

  return path.join(verDir, "src/demo_apps/PowerRP");
}

/** Query→Command. The PowerRP app dir per the three modes (may run setup). */
async function resolveAppDir() {
  if (!app.isPackaged) return path.resolve(__dirname, "..");
  const vendored = path.join(process.resourcesPath, "repo");
  if (existsSync(vendored)) return ensureSupportRepo(vendored);
  const baked = path.join(process.resourcesPath, "repo-path.txt");
  if (existsSync(baked)) {
    const dir = readFileSync(baked, "utf8").trim();
    if (!existsSync(path.join(dir, "run_server.sh")))
      throw new Error(`repo-path.txt points at "${dir}" but run_server.sh is not there — the dump moved; rebuild the app`);
    return dir;
  }
  throw new Error("packaged app has neither Resources/repo/ nor repo-path.txt — rebuild with `npm run package` (dev) or `npm run package:dmg` (shippable)");
}

/** Command. SIGTERM the launcher's process GROUP (it traps + reaps its own
 * children), escalate to SIGKILL after the grace period. Idempotent. */
function stopServer() {
  if (!serverChild || serverExited) return Promise.resolve();
  return new Promise((resolve) => {
    const pgid = -serverChild.pid; // detached ⇒ the child leads its own group
    try { process.kill(pgid, "SIGTERM"); } catch { /* group already gone */ }
    const killTimer = setTimeout(() => {
      try { process.kill(pgid, "SIGKILL"); } catch { /* already gone */ }
    }, SHUTDOWN_GRACE_MS);
    serverChild.once("exit", () => { clearTimeout(killTimer); resolve(); });
    if (serverExited) { clearTimeout(killTimer); resolve(); }
  });
}

/** Command (async). Polls `url` until it answers HTTP 200 or the deadline
 * passes; rejects with the collected server output on timeout/early-death. */
function waitForReady(url, outputRef) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (serverExited)
        return reject(new Error(`the server exited before becoming ready.\n\n${outputRef.text.slice(-2000)}`));
      if (Date.now() > deadline)
        return reject(new Error(`server did not answer at ${url} within ${READY_TIMEOUT_MS / 1000}s.\n\n${outputRef.text.slice(-2000)}`));
      http.get(url, (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : setTimeout(poll, READY_POLL_MS);
      }).on("error", () => setTimeout(poll, READY_POLL_MS));
    };
    poll();
  });
}

app.whenReady().then(async () => {
  Object.assign(CHILD_ENV, childEnv());
  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    title: "PowerRP",
    webPreferences: { contextIsolation: true }, // plain web page; no preload, no node in the renderer
  });
  win.loadURL(setupPage("Starting…"));

  let appDir;
  try {
    appDir = await resolveAppDir();
  } catch (e) {
    return fatal("PowerRP setup failed", e.message);
  }

  const outputRef = { text: "" };
  serverChild = spawn("bash", ["run_server.sh"], {
    cwd: appDir,
    detached: true, // its own process group — the unit we kill on quit
    stdio: ["ignore", "pipe", "pipe"],
    env: CHILD_ENV,
  });
  serverChild.on("exit", () => {
    serverExited = true;
    // A server that dies while the window is up is a loud failure, not a hang.
    if (!shuttingDown && win && !win.isDestroyed()) {
      dialog.showErrorBox("PowerRP server exited", outputRef.text.slice(-2000) || "(no output)");
      app.exit(1);
    }
  });

  // The launcher banner prints the ONE url to open ("Local: http://localhost:N").
  const urlPromise = new Promise((resolve) => {
    const onData = (buf) => {
      outputRef.text += buf.toString();
      const m = outputRef.text.match(/Local:\s+(http:\/\/localhost:\d+)/);
      if (m) resolve(m[1]);
    };
    serverChild.stdout.on("data", onData);
    serverChild.stderr.on("data", onData);
  });

  try {
    win.loadURL(setupPage("Starting the PowerRP server…"));
    const url = await Promise.race([
      urlPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`launcher never printed its Local: url.\n\n${outputRef.text.slice(-2000)}`)), READY_TIMEOUT_MS)),
    ]);
    await waitForReady(url, outputRef);
    // window.open/_blank from the page means "open OUTSIDE the shell": route
    // it to the system browser (the web UI's globe button rides this seam —
    // it window.open()s the current URL to hop from the app to a browser).
    win.webContents.setWindowOpenHandler(({ url: external }) => {
      shell.openExternal(external);
      return { action: "deny" };
    });
    if (!win.isDestroyed()) win.loadURL(url);
  } catch (e) {
    dialog.showErrorBox("PowerRP failed to start", e.message);
    await stopServer();
    app.exit(1);
  }
});

// Quit = window closed (single-window app), and quitting always reaps the group.
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (shuttingDown || !serverChild || serverExited) return;
  shuttingDown = true;
  event.preventDefault(); // finish the group teardown, THEN quit for real
  stopServer().then(() => app.quit());
});
