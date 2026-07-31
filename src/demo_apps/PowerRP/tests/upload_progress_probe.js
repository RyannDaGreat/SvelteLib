/**
 * Optimistic upload-progress probe (this feature): drives a REAL upload against
 * a REAL project backend and asserts the optimistic-tile flow end to end —
 *   (a) a pending tile appears IMMEDIATELY (an `uploading` entry + a .ae-upload
 *       tile in the DOM) with a live "%· bytes / bytes" caption,
 *   (b) the percent ADVANCES (xhr.upload.onprogress fires repeatedly — NOT
 *       faked: the browser's upload is throttled via CDP so progress is paced),
 *   (c) on completion the pending tile is REPLACED by the real asset tile
 *       (reconcileUploads drops the done entry once the re-list includes it).
 * It also screenshots the pane MID-upload to .claude_vlm_checks/upload_progress.png.
 *
 * Isolation mirrors paste_upload_probe.js: an EPHEMERAL backend (uv run
 * server.py, POWERRP_PROJECTS_DIR = a mkdtemp throwaway root, a free port —
 * never the real 3637) + an ephemeral Vite server (free port, BACKEND_URL
 * pointed at it) + puppeteer. The throwaway root is removed on exit.
 *
 * Run (exit-code gated), from the PowerRP dir:
 *   node tests/upload_progress_probe.js
 */

import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const SERVER_DIR = join(APP_DIR, "server");
const VLM_DIR = join(APP_DIR, ".claude_vlm_checks");

// Upload shaping so onprogress fires MANY times (real events, not synthesized):
// a few MB throttled to a modest rate spreads the upload over a few seconds.
const UPLOAD_BYTES = 4_000_000; // not a power of two → sizes show decimals (e.g. "3.8MB")
const UPLOAD_THROUGHPUT = 1_200_000; // bytes/sec (CDP) → ~3.3s upload, dozens of ticks
const POLL_MS = 80;
const MAX_POLLS = 200; // ~16s ceiling
const SCREENSHOT_PCT_LO = 12; // capture the VLM shot once the bar is clearly mid-flight
const SCREENSHOT_PCT_HI = 88;

/** Query. A free TCP port (bind :0, read the assigned port, release). */
// freePort now comes from ./free_port.js, which RE-VERIFIES the port is still
// bindable before handing it back. The copy that used to live here bound port 0,
// read the number, closed, and returned — leaving a TOCTOU window that stays open
// until the spawned backend binds. Under the gate's x3 probe concurrency two
// probes could draw the same number, and the loser died with `Errno 48 Address
// already in use` -> `server never became ready`: a red that said nothing about
// what this probe tests.

/** Query. Poll a URL until it answers 200 (or throw after `tries`). */
async function waitFor(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became ready at ${url}`);
}

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_upload_progress_"));
mkdirSync(VLM_DIR, { recursive: true });

const backendPort = await freePort();
// Launch the backend the SAME way run_server.sh does: `uv run` (PEP 723 deps).
// bash -lc so uv resolves from the user PATH (~/.local/bin) on a fresh env.
const server = spawn("bash", ["-lc", `uv run server.py serve --port=${backendPort}`], {
  cwd: SERVER_DIR,
  env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
  stdio: ["ignore", "inherit", "inherit"],
});
server.on("error", (e) => { throw e; });

let viteServer, browser;
const errors = [];
try {
  const backendBase = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${backendBase}/api/projects/`);

  process.env.BACKEND_URL = backendBase;
  process.env.NO_OPEN = "1";
  const { createServer } = await import("vite");
  viteServer = await createServer({
    configFile: resolve(APP_DIR, "web/vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageUrl = `http://127.0.0.1:${viteServer.httpServer.address().port}/`;

  const { launchBrowser } = await import("./puppeteerLaunch.js");
  // swiftshader flags so the WebGPU compositor inits headless; --no-sandbox is
  // required to run as root (repo convention — see caret_accuracy_qa.js).
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // WebGPU absence is an ENVIRONMENT report, not an upload defect (see
    // webgpu_absence_noise.js). This probe is about byte counters and tiles.
    if (m.type() === "error" && !isWebGpuAbsenceNoise(m.text())) errors.push(`console.error: ${m.text()}`);
    if (m.type() === "warning") console.log(`[page.warn] ${m.text()}`);
  });

  await page.goto(pageUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));
  if (errors.length) throw new Error("PAGE ERRORS AT BOOT:\n" + errors.join("\n"));

  // Name the project so the upload targets a real throwaway-root folder.
  await page.evaluate(() => { window.__powerrp_app.doc.meta.name = "upload_probe"; });

  // Throttle the browser's UPLOAD so xhr.upload.onprogress is PACED and fires
  // repeatedly — the honest way to observe real progress headlessly.
  const client = await page.target().createCDPSession();
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: UPLOAD_THROUGHPUT,
  });

  // Kick off the upload through the CENTRAL path every entry point funnels
  // through (app.uploadAsset) with a real multi-MB File; don't await it here.
  await page.evaluate((bytes) => {
    const app = window.__powerrp_app;
    const file = new File([new Uint8Array(bytes)], "big_upload.bin", { type: "application/octet-stream" });
    window.__uploadDone = false;
    window.__uploadResult = null;
    window.__uploadErr = null;
    app.uploadAsset(file)
      .then((r) => { window.__uploadResult = r; window.__uploadDone = true; })
      .catch((e) => { window.__uploadErr = String(e?.message ?? e); window.__uploadDone = true; });
  }, UPLOAD_BYTES);

  // Poll: sample the reactive uploads model (primitives only — $state proxies
  // don't survive puppeteer serialization) AND the rendered DOM tile/caption.
  const loadedSamples = [];
  const captions = [];
  let sawUploadingEntry = false;
  let sawDeterminateTotal = false;
  let midShotTaken = false;

  for (let i = 0; i < MAX_POLLS; i++) {
    const snap = await page.evaluate(() => {
      const app = window.__powerrp_app;
      const ups = app.uploads.map((u) => ({ id: u.id, loaded: u.loaded, total: u.total, status: u.status, name: u.name }));
      const tileEl = document.querySelector(".asset-explorer .ae-upload");
      const capEl = document.querySelector(".asset-explorer .ae-upload .ae-upload-caption");
      const realNames = [...document.querySelectorAll(".asset-explorer .ae-grid:not(.ae-uploads-grid) .ae-name")].map((n) => n.textContent);
      return {
        ups,
        tilePresent: !!tileEl,
        caption: capEl ? capEl.textContent : null,
        realNames,
        done: window.__uploadDone,
        result: window.__uploadResult,
        err: window.__uploadErr,
      };
    });

    const u0 = snap.ups[0];
    if (u0 && u0.status === "uploading") {
      sawUploadingEntry = true;
      if (u0.total > 0) sawDeterminateTotal = true;
      loadedSamples.push(u0.loaded);
    }
    if (snap.caption) captions.push(snap.caption);

    // VLM screenshot mid-upload (once), when the bar is clearly in flight.
    if (!midShotTaken && u0 && u0.status === "uploading" && u0.total > 0) {
      const pct = Math.round((u0.loaded / u0.total) * 100);
      if (pct >= SCREENSHOT_PCT_LO && pct <= SCREENSHOT_PCT_HI) {
        const pane = await page.$(".asset-explorer");
        await (pane ?? page).screenshot({ path: join(VLM_DIR, "upload_progress.png") });
        midShotTaken = true;
        console.log(`VLM screenshot taken at ~${pct}% — caption: "${snap.caption}"`);
      }
    }

    if (snap.done) {
      // Let the assetsVersion re-list + reconcile settle (pending tile removed,
      // real tile present). Poll a bit more below.
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Settle: wait for reconcile (pending gone) and the real tile to appear.
  let final = null;
  for (let i = 0; i < 40; i++) {
    final = await page.evaluate(() => {
      const app = window.__powerrp_app;
      return {
        uploadsLen: app.uploads.length,
        uploadStatuses: app.uploads.map((u) => u.status),
        realNames: [...document.querySelectorAll(".asset-explorer .ae-grid:not(.ae-uploads-grid) .ae-name")].map((n) => n.textContent),
        result: window.__uploadResult,
        err: window.__uploadErr,
      };
    });
    const resolvedName = final.result?.name;
    if (final.uploadsLen === 0 && resolvedName && final.realNames.includes(resolvedName)) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  // ── Assertions ──────────────────────────────────────────────────────────
  if (final.err) errors.push(`Upload rejected: ${final.err}`);
  if (!sawUploadingEntry) errors.push("(a) No 'uploading' entry ever appeared in app.uploads — no optimistic tile");
  if (!sawDeterminateTotal) errors.push("(a) Pending entry never had a determinate total (file.size) — can't show %/bytes");
  const distinctLoaded = [...new Set(loadedSamples)];
  if (distinctLoaded.length < 2)
    errors.push(`(b) Percent did not advance — only ${distinctLoaded.length} distinct loaded value(s) observed: ${JSON.stringify(distinctLoaded)} (expected multiple real onprogress events)`);
  else if (Math.max(...loadedSamples) <= Math.min(...loadedSamples))
    errors.push("(b) loaded bytes never increased across samples");
  const goodCaption = captions.find((c) => /\d+%\s*·\s*[\d.]+\s*[KMGT]?B\s*\/\s*[\d.]+\s*[KMGT]?B/.test(c));
  if (!goodCaption)
    errors.push(`(a) No caption matched "N% · X / Y" with byte units. Captions seen: ${JSON.stringify([...new Set(captions)].slice(0, 6))}`);
  if (!midShotTaken) errors.push("VLM screenshot was never captured mid-upload (never observed a mid % — throttle/timing issue)");
  if (final.uploadsLen !== 0)
    errors.push(`(c) Pending tile not reconciled away after completion — app.uploads still has ${final.uploadsLen} entr(y/ies): ${JSON.stringify(final.uploadStatuses)}`);
  const resolvedName = final.result?.name;
  if (!resolvedName) errors.push("(c) Upload never resolved with a {name}");
  else if (!final.realNames.includes(resolvedName))
    errors.push(`(c) Real asset tile for "${resolvedName}" not found after completion. Real tile names: ${JSON.stringify(final.realNames)}`);

  // Belt-and-suspenders: the file really landed server-side in the throwaway root.
  const listing = await (await fetch(`${backendBase}/api/assets/upload_probe/`)).json();
  if (!listing.some((a) => a.name === resolvedName))
    errors.push(`Uploaded asset not found via /api/assets/: ${JSON.stringify(listing)}`);

  if (errors.length) throw new Error("PROBE FAILURES:\n" + errors.join("\n"));

  console.log(`\ndistinct loaded samples: ${distinctLoaded.length}; example caption: "${goodCaption}"`);
  console.log(`resolved asset: ${resolvedName}; real tiles: ${JSON.stringify(final.realNames)}`);
  console.log(`VLM screenshot: ${join(VLM_DIR, "upload_progress.png")}`);
  console.log("\nUPLOAD-PROGRESS PROBE OK");
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
