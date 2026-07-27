/**
 * ASSET UX ROUND 2 end-to-end probe (manifest 13.7). Proves the three
 * "does this actually work in the real app" claims the spec calls out:
 *
 *   1. ASSETS LOAD ON BOOT — no manual Refresh needed. A project already
 *      SAVED on the server (an image asset in its assets/ folder) is loaded
 *      automatically the moment the editor boots into it (the Asset Explorer
 *      $effect fires on mount, not just on project-switch/Refresh).
 *   2. DELETE END-TO-END — the Asset Explorer's trash-can flow round-trips
 *      through the REAL server DELETE endpoint (not just a unit test of
 *      server.py in isolation): click trash -> asset gone from the pane AND
 *      from a fresh GET /api/assets/ listing.
 *   3. ASSETFIELD ACCEPTS A DROPPED ASSET — dragging a native OS File onto
 *      an image widget's Source row (the AssetField in the Inspector)
 *      uploads it and writes the resulting URL into the item's `src`, the
 *      exact gesture the manifest complains "doesn't even work" today.
 *
 * ISOLATION (manifest 13.7 rule, the probe.jpg incident): this probe NEVER
 * touches the user's real projects/ folder or port 3637. It runs its own
 * throwaway Python server (POWERRP_PROJECTS_DIR = mkdtemp) on an EPHEMERAL
 * port, and its own Vite instance (port 0 -> OS-assigned), proxied to that
 * throwaway backend via BACKEND_URL. Both are torn down (and the tmp root
 * removed) in `finally` regardless of pass/fail.
 *
 * Run (exit-code gated, from the SvelteLib repo root):
 *   node src/demo_apps/PowerRP/tests/asset_ux_probe.js
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(HERE, "../../../..");
const PY = "/opt/homebrew/opt/python@3.10/bin/python3.10";
const PROJECT = "assetux_probe";

// A 1x1 red PNG (smallest valid PNG — the paste_upload_probe.js precedent,
// verified to decode cleanly through gpu/image_registry.js). Used for BOTH
// the SEEDED asset already on the server before boot (proves auto-load) and
// the file dropped later onto the AssetField (proves the upload+commit
// path) — the two are distinguished by FILENAME (seed.png vs dropped.png),
// not pixel content, so identical bytes are fine.
const PROBE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became ready at ${url}`);
}

const errors = [];
const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_asset_ux_probe_"));
let pyServer, viteServer, browser;
try {
  // ── Seed a REAL project with one saved image asset (proves boot-load) ──────
  const assetsDir = join(projectsRoot, PROJECT, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const seedBytes = Buffer.from(PROBE_PNG_B64, "base64");
  writeFileSync(join(assetsDir, "seed.png"), seedBytes);
  writeFileSync(
    join(projectsRoot, PROJECT, "doc.json"),
    JSON.stringify({ meta: { name: PROJECT }, slides: [{ id: "s0", name: "Slide 0", delta: {} }] }),
  );

  // ── Ephemeral Python project server ────────────────────────────────────────
  const backendPort = await freePort();
  pyServer = spawn(PY, ["server.py", "serve", `--port=${backendPort}`], {
    cwd: join(APP_DIR, "server"),
    env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
    stdio: ["ignore", "inherit", "inherit"],
  });
  pyServer.on("error", (e) => { throw e; });
  const backendBase = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${backendBase}/api/projects/`);

  // ── Ephemeral Vite instance, proxied to the throwaway backend ──────────────
  // vite.config.js reads process.env.BACKEND_URL at CONFIG-EVAL time (a
  // top-level const), so it must be set BEFORE createServer imports the
  // config — the paste_upload_probe.js precedent. This makes the proxy
  // target our throwaway backend, never the live :3638/:3637 dev setup.
  process.env.BACKEND_URL = backendBase;
  process.env.NO_OPEN = "1";
  viteServer = await createViteServer({
    configFile: join(APP_DIR, "web", "vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const uploadRequests = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  page.on("request", (req) => { if (req.url().includes("/api/upload/")) uploadRequests.push(req.url()); });

  // Boot straight into the seeded project: an autosave doc whose meta.name
  // matches it. This is the manifest's real complaint scenario — a project
  // that already has assets on disk, opened fresh (page reload / new tab).
  await page.evaluateOnNewDocument((name) => {
    localStorage.setItem("powerrp.autosave", JSON.stringify({
      meta: { name }, slides: [{ id: "s0", name: "Slide 0", delta: {} }],
    }));
  }, PROJECT);

  await page.goto(`${pageBase}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));
  if (errors.length) throw new Error("PAGE ERRORS AT BOOT:\n" + errors.join("\n"));

  // ── CHECK 1: assets load on boot, no manual Refresh ────────────────────────
  let aeTileCount = 0;
  for (let i = 0; i < 40; i++) {
    aeTileCount = await page.evaluate(() => document.querySelectorAll(".asset-explorer .ae-tile").length);
    if (aeTileCount > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const aeNotice = await page.evaluate(() => document.querySelector(".asset-explorer .ae-error")?.textContent ?? null);
  if (aeNotice) errors.push(`[1] Asset Explorer shows an error notice on boot: ${aeNotice}`);
  if (aeTileCount !== 1) errors.push(`[1] BOOT-LOAD FAILED: expected 1 asset tile auto-loaded, found ${aeTileCount}`);
  else console.log("[1] BOOT-LOAD ok: the seeded project's asset appeared with zero manual Refresh clicks");

  // ── CHECK 2: DELETE end-to-end via the real Asset Explorer trash-can flow ──
  await page.hover(".asset-explorer .ae-tile");
  await page.click(".asset-explorer .ae-trash");
  let aeTileCountAfterDelete = aeTileCount;
  for (let i = 0; i < 40; i++) {
    aeTileCountAfterDelete = await page.evaluate(() => document.querySelectorAll(".asset-explorer .ae-tile").length);
    if (aeTileCountAfterDelete === 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (aeTileCountAfterDelete !== 0) errors.push(`[2] DELETE FAILED: tile still present in the pane after trash-can click (count=${aeTileCountAfterDelete})`);
  const serverListing = await (await fetch(`${backendBase}/api/assets/${PROJECT}/`)).json();
  if (serverListing.some((a) => a.name === "seed.png")) errors.push(`[2] DELETE FAILED server-side: seed.png still listed by GET /api/assets/`);
  if (aeTileCountAfterDelete === 0 && !serverListing.some((a) => a.name === "seed.png"))
    console.log("[2] DELETE ok end-to-end: trash-can click removed the asset from the pane AND the server listing (no 501)");

  // ── CHECK 3: AssetField accepts a dropped OS file ──────────────────────────
  // Add + select an image widget so the Inspector renders its Source row.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ type: "image", x: 100, y: 100, w: 50, h: 50, z: 0, rotation: 0, scale: 1, src: "", opacity: 1 });
    const id = Object.keys(app.doc.slides[0].delta.items).find((k) => app.doc.slides[0].delta.items[k].type === "image");
    app.selection = id;
  });
  await new Promise((r) => setTimeout(r, 200));

  const fieldHandle = await page.evaluateHandle(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const srcRow = rows.find((r) => r.querySelector(".label")?.textContent?.trim() === "Source");
    return srcRow?.querySelector(".assetfield-row") ?? null;
  });
  const hasField = await page.evaluate((el) => !!el, fieldHandle);
  if (!hasField) {
    errors.push("[3] Could not find the AssetField (.assetfield-row) under the Source row — is AssetField wired into the asset row kind?");
  } else {
    // Synthesize a native DragEvent carrying a File in dataTransfer.files —
    // the same construction paste_upload_probe.js uses for ClipboardEvent
    // (DataTransfer is constructible in Chromium; a DragEvent accepts it).
    const dropResult = await page.evaluate(
      async (el, b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const file = new File([bytes], "dropped.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        const fire = (type) => el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
        fire("dragover");
        fire("drop");
        return true;
      },
      fieldHandle,
      PROBE_PNG_B64,
    );
    if (!dropResult) errors.push("[3] Drop event dispatch failed");

    let srcAfterDrop = null;
    for (let i = 0; i < 40; i++) {
      srcAfterDrop = await page.evaluate(() => {
        const app = window.__powerrp_app;
        const id = app.selection;
        return app.doc.slides[0].delta.items[id]?.src ?? null;
      });
      if (srcAfterDrop && srcAfterDrop.includes("dropped")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!srcAfterDrop || !srcAfterDrop.includes("dropped"))
      errors.push(`[3] ASSETFIELD DROP FAILED: item.src after drop = ${JSON.stringify(srcAfterDrop)} (expected it to reference "dropped.png")`);
    else console.log(`[3] ASSETFIELD DROP ok: dropping a Finder file onto the Source row uploaded it and wrote src=${srcAfterDrop}`);

    if (uploadRequests.length === 0) errors.push("[3] No POST to /api/upload/ observed during the drop — AssetField may not be uploading");
  }

  if (errors.length) {
    console.error("\nASSET UX PROBE FAILURES:\n" + errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("\nALL ASSET UX CHECKS PASSED");
  }
} finally {
  browser && (await browser.close());
  viteServer && (await viteServer.close());
  pyServer && pyServer.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
