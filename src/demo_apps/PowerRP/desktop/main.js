/**
 * PowerRP desktop shell — the ENTIRE app logic is: run the existing launcher
 * (run_server.sh) as a child PROCESS GROUP, open a BrowserWindow on the URL it
 * prints, and take the whole server tree down when the app quits. Zero changes
 * to the web codebase (the user ruling: "almost zero changes... the UI we have
 * on our website pops up inside... when you quit the app the server quits with
 * it"). The launcher's own start_server.sh traps reap its backend + Vite when
 * the GROUP gets SIGTERM — we kill the group exactly the way it expects.
 *
 * ── WHERE THE REPO IS (v1 vs shipped) ─────────────────────────────────────────
 * Unpackaged (`electron .` from desktop/): the repo root is two dirs up — the
 * dump in place, dev mode. PACKAGED v1 (.app built on THIS machine): the repo's
 * absolute path is baked into Resources/repo-path.txt at package time
 * (write_repo_path.js) — the .app is a launcher for THIS machine's dump, which
 * is exactly the "verify it works on this computer" milestone. A SHIPPABLE
 * bundle (repo + node/uv/ffmpeg vendored inside Resources) is v2, in CI; the
 * repo-path.txt indirection is the seam it will replace.
 *
 * Server data: server.py already honors POWERRP_PROJECTS_DIR (server.py:69),
 * so a shipped build can point projects at ~/Library/Application Support —
 * v1 passes the env through untouched and runs the dump's own projects/.
 *
 * LOUD FAILURE DISCIPLINE: a launcher that dies or never prints its URL, or a
 * URL that never starts answering, puts the real output in an error dialog and
 * exits nonzero — never a silent blank window.
 */

const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const http = require("node:http");
const path = require("node:path");

/** How long the app URL may take to start answering 200 before we give up.
 * Cold Vite + backend startup is ~5-15s; 120s covers a first-run dep optimize. */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 250;
/** Grace between SIGTERM to the group and escalating to SIGKILL on quit. */
const SHUTDOWN_GRACE_MS = 5_000;

/** The PowerRP app dir (holds run_server.sh). Packaged: read the baked path;
 * unpackaged: desktop/ lives inside it. Query (reads disk/env). */
function powerRpDir() {
  if (app.isPackaged) {
    const baked = path.join(process.resourcesPath, "repo-path.txt");
    if (!existsSync(baked))
      throw new Error(`packaged app is missing ${baked} — rebuild with \`npm run package\` (write_repo_path.js bakes the dump's location)`);
    const dir = readFileSync(baked, "utf8").trim();
    if (!existsSync(path.join(dir, "run_server.sh")))
      throw new Error(`repo-path.txt points at "${dir}" but run_server.sh is not there — the dump moved; rebuild the app`);
    return dir;
  }
  return path.resolve(__dirname, "..");
}

let serverChild = null;
let serverExited = false;
let shuttingDown = false;
let win = null;

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
  const appDir = powerRpDir();
  const outputRef = { text: "" };

  serverChild = spawn("bash", ["run_server.sh"], {
    cwd: appDir,
    detached: true, // its own process group — the unit we kill on quit
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }, // POWERRP_PROJECTS_DIR passes through if set
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
    const url = await Promise.race([
      urlPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`launcher never printed its Local: url.\n\n${outputRef.text.slice(-2000)}`)), READY_TIMEOUT_MS)),
    ]);
    await waitForReady(url, outputRef);
    win = new BrowserWindow({
      width: 1680,
      height: 1000,
      title: "PowerRP",
      webPreferences: { contextIsolation: true }, // plain web page; no preload, no node in the renderer
    });
    win.loadURL(url);
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
