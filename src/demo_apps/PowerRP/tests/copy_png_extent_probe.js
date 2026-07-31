/**
 * 15.8 probe: the copied-selection OS-clipboard PNG must contain the
 * element's FULL pixel extent — no dpr quadrant crop (facet 1) — AND the
 * full effect-inclusive extent (shadow/bloom halo, facet 2; manifest "15.8
 * ADDITION").
 *
 * Drives the REAL editor (ephemeral python server + ephemeral Vite +
 * puppeteer, the clipboard_duplicate_probe.js isolation pattern: mkdtemp
 * POWERRP_PROJECTS_DIR, free ports, NEVER 3637/3638). Runs the SAME scene at
 * puppeteer deviceScaleFactor 1 and 2, since the bug is dpr-dependent.
 *
 * Interception, not readback: navigator.clipboard.write's image/png Blob is
 * captured in-page (via a monkeypatch installed before app.js runs) rather
 * than read back from the OS clipboard — clipboard_duplicate_probe.js notes
 * navigator.clipboard.read() of image data is unreliable in headless
 * Chromium; intercepting the write is exact and avoids that flake class.
 * Decoding is done IN-PAGE via createImageBitmap + canvas 2D getImageData —
 * the browser's own PNG decoder, no extra node dependency.
 *
 * Assertions per dpr:
 *  1. CROP: a wide+tall asymmetric rect (400x100, a small marker square
 *     pinned at its far bottom-right corner) copied whole — the PNG's pixel
 *     dimensions equal rect.w*dpr x rect.h*dpr (dpr-correct full extent, not
 *     a quadrant), and the marker pixel is PRESENT (non-blank), not just
 *     content confined to the top-left quadrant.
 *  2. HALO: a shadowed rect (offset+blur reaching outside its geometry bbox)
 *     copied whole — the PNG's dimensions equal the EFFECT-INCLUSIVE extent
 *     (core/view.js effectInclusiveAABB) times dpr, and a pixel in the halo
 *     band strictly outside the geometry bbox (where only the shadow paints)
 *     is NON-BLANK.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/copy_png_extent_probe.js
 */

import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
// The backend is launched through `uv run`, NEVER a hardcoded interpreter path:
// this file used to pin /opt/homebrew/opt/python@3.10/bin/python3.10, which made
// the probe die with ENOENT on any machine that is not the author's Mac — so it
// was permanently red in the gate on Linux. `uv run` is the dump's rule (a wiped
// container still works) and the idiom tests/browser_render_harness.js already uses.
const PY = "uv";
const PY_ARGS = ["run", "server.py"];

// freePort now comes from ./free_port.js, which RE-VERIFIES the port is still
// bindable before handing it back. The copy that used to live here bound port 0,
// read the number, closed, and returned — leaving a TOCTOU window that stays open
// until the spawned backend binds. Under the gate's x3 probe concurrency two
// probes could draw the same number, and the loser died with `Errno 48 Address
// already in use` -> `server never became ready`: a red that said nothing about
// what this probe tests.

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became ready at ${url}`);
}

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_copy_extent_"));
const backendPort = await freePort();
const server = spawn(PY, [...PY_ARGS, "serve", `--port=${backendPort}`], {
  cwd: join(APP_DIR, "server"),
  env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
  stdio: ["ignore", "inherit", "inherit"],
});
server.on("error", (e) => { throw e; });

let viteServer, browser;
const errors = [];
const note = (ok, msg) => { if (!ok) errors.push(msg); else console.log(`  ok  ${msg}`); };

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
  browser = await launchBrowser();

  for (const dpr of [1, 2]) {
    console.log(`\n=== deviceScaleFactor ${dpr} ===`);
    // A FRESH incognito context per dpr — separate localStorage/autosave, so
    // dpr 1's items (never purged mid-probe) cannot leak into dpr 2's
    // selection via the app's localStorage autosave-on-commit (own origin,
    // shared across pages of the SAME context).
    const context = await browser.createBrowserContext();
    await context.overridePermissions(pageUrl, ["clipboard-read", "clipboard-write"]);
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });

    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
    // WebGPU absence is an ENVIRONMENT report, not a PNG-extent defect (see
    // webgpu_absence_noise.js). This probe is about capture rects and dpr.
    page.on("console", (m) => { if (m.type() === "error" && !isWebGpuAbsenceNoise(m.text())) consoleErrors.push(`console.error: ${m.text()}`); });

    // Intercept navigator.clipboard.write BEFORE the app module loads: this
    // probe cares about the RENDERED BYTES (rasterizeIrPng's output), not
    // whether headless Chromium's real clipboard grants the write (it can
    // deny even with overridePermissions — a headless-environment quirk, not
    // an app bug; clipboard_duplicate_probe.js's own "D" section only checks
    // the write ran with no render error, never a readback). So the mock
    // captures the Blob and resolves cleanly WITHOUT calling through to the
    // real API — isolates this probe from that flake class entirely.
    await page.evaluateOnNewDocument(() => {
      window.__capturedPngBytes = null;
      navigator.clipboard.write = async (items) => {
        for (const item of items) {
          const blob = await item.getType("image/png");
          window.__capturedPngBytes = new Uint8Array(await blob.arrayBuffer());
        }
      };
    });

    await page.goto(pageUrl, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 400));
    if (consoleErrors.length) throw new Error(`PAGE ERRORS AT BOOT (dpr ${dpr}):\n` + consoleErrors.join("\n"));

    // In-page helper: decode captured PNG bytes -> {width, height, isNonBlank(x,y)}
    // via the browser's own PNG decoder (createImageBitmap) + canvas 2D
    // getImageData. Returns plain data (no ImageData handle) for eval to return.
    const decodeCaptured = () => page.evaluate(async () => {
      const bytes = window.__capturedPngBytes;
      if (!bytes) return null;
      const blob = new Blob([bytes], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return { width: bitmap.width, height: bitmap.height, alpha: Array.from({ length: data.length / 4 }, (_, i) => data[i * 4 + 3]) };
    });

    const ALPHA_FLOOR = 10; // out of 255 — anti-aliased edge pixels can be faint but not zero
    const isNonBlank = (decoded, x, y) => {
      if (x < 0 || y < 0 || x >= decoded.width || y >= decoded.height) return false;
      return decoded.alpha[decoded.width * y + x] > ALPHA_FLOOR;
    };

    // ── 1. CROP: wide+tall asymmetric rect with a far-corner marker ──────────
    console.log("1. crop check: wide/tall asymmetric rect, full extent must survive");
    const RECT_W = 400, RECT_H = 100;
    const MARKER = 6; // px — small colored square at the far bottom-right corner
    const crop = await page.evaluate(async ({ RECT_W, RECT_H, MARKER }) => {
      const app = window.__powerrp_app;
      window.__capturedPngBytes = null;
      app.addItem({
        ...app.registry.get("rect").defaults,
        x: 50, y: 50, w: RECT_W, h: RECT_H,
        fill: "#204060", // distinctive base fill, opaque
      });
      // A second, smaller rect pinned at the far bottom-right corner of the
      // first — proves "far-right/far-bottom content present", not just
      // top-left content.
      app.addItem({
        ...app.registry.get("rect").defaults,
        x: 50 + RECT_W - MARKER, y: 50 + RECT_H - MARKER, w: MARKER, h: MARKER,
        fill: "#ff2020",
      });
      const ids = Object.keys(app.doc.slides[0].delta.items).filter((id) => app.doc.slides[0].delta.items[id].type === "rect");
      app.selectMany(ids);
      await app.copyAsPng(); // the 15.8 path: selectionWorldAABB -> fitRectView -> rasterizeIrPng
      return { dpr: app.dpr(), rectW: RECT_W, rectH: RECT_H, marker: MARKER };
    }, { RECT_W, RECT_H, MARKER });

    const cropPng = await decodeCaptured();
    note(!!cropPng, "copyAsPng captured a PNG on the (intercepted) OS clipboard");
    if (cropPng) {
      const expectW = Math.round(RECT_W * crop.dpr), expectH = Math.round(RECT_H * crop.dpr);
      note(cropPng.width === expectW && cropPng.height === expectH,
        `PNG dims are the full element extent x dpr (got ${cropPng.width}x${cropPng.height}, expected ${expectW}x${expectH})`);
      // Far-right/far-bottom marker center, mapped to device px.
      const markerCenterWorldX = 50 + RECT_W - MARKER / 2;
      const markerCenterWorldY = 50 + RECT_H - MARKER / 2;
      const devX = Math.round((markerCenterWorldX - 50) * crop.dpr);
      const devY = Math.round((markerCenterWorldY - 50) * crop.dpr);
      note(isNonBlank(cropPng, devX, devY), `far bottom-right marker pixel is present, not blank (sampled device px ${devX},${devY} of ${cropPng.width}x${cropPng.height})`);
      // A quadrant-crop bug would leave the bottom-right HALF of the canvas
      // entirely blank (alpha 0) — a coarser guard specifically against the
      // "top-left quadrant only" failure mode.
      const qx = Math.floor(cropPng.width * 3 / 4), qy = Math.floor(cropPng.height * 3 / 4);
      note(isNonBlank(cropPng, qx, qy), `bottom-right quadrant is not blank (no quadrant crop) at (${qx},${qy})`);
    }

    // ── 2. HALO: shadowed rect, must include the effect-inclusive extent ────
    console.log("2. halo check: shadowed rect, shadow reach must survive the crop");
    const halo = await page.evaluate(async () => {
      const app = window.__powerrp_app;
      window.__capturedPngBytes = null;
      // Purge everything from step 1 so this selection is exactly the new shadowed rect.
      for (const id of Object.keys(app.doc.slides[0].delta.items)) {
        if (app.doc.slides[0].delta.items[id].type === "rect") { app.selection = id; app.purgeSelection(); }
      }
      const W = 120, H = 80;
      const shadow = { dx: 15, dy: 20, blur: 6, color: "#000000", opacity: 1 };
      app.addItem({ ...app.registry.get("rect").defaults, x: 200, y: 200, w: W, h: H, fill: "#40a060", shadow });
      const rect = app.selectionWorldAABB(); // effect-inclusive per the 15.8 fix
      await app.copyAsPng();
      return { dpr: app.dpr(), rect, geomX: 200, geomY: 200, W, H, shadow };
    });
    const haloPng = await decodeCaptured();
    note(!!haloPng, "shadowed copyAsPng captured a PNG");
    if (haloPng) {
      const expectW = Math.round(halo.rect.w * halo.dpr), expectH = Math.round(halo.rect.h * halo.dpr);
      note(haloPng.width === expectW && haloPng.height === expectH,
        `PNG dims equal the effect-inclusive extent x dpr (got ${haloPng.width}x${haloPng.height}, expected ${expectW}x${expectH} from rect ${halo.rect.w}x${halo.rect.h})`);
      // A point strictly outside the geometry bbox, inside the shadow's own
      // offset silhouette. The shadow rect occupies
      // [geomX+dx, geomX+dx+W] x [geomY+dy, geomY+dy+H]; sampling near ITS
      // far corner (offset back from the edge by half the blur reach, so the
      // point is inside the blurred-but-still-opaque interior, not the
      // fading rim) lands outside the geometry box on BOTH axes whenever
      // dx,dy > 0, since that corner is (geomX+dx+W, geomY+dy+H) > (geomX+W,
      // geomY+H) exactly because dx,dy are positive.
      const inset = halo.shadow.blur / 2;
      const shadowPixelWorldX = halo.geomX + halo.shadow.dx + halo.W - inset;
      const shadowPixelWorldY = halo.geomY + halo.shadow.dy + halo.H - inset;
      const outsideGeomBBox = shadowPixelWorldX > halo.geomX + halo.W && shadowPixelWorldY > halo.geomY + halo.H;
      note(outsideGeomBBox, `sanity: the sampled shadow pixel (${shadowPixelWorldX},${shadowPixelWorldY}) is genuinely outside the geometry bbox (${halo.geomX},${halo.geomY} ${halo.W}x${halo.H})`);
      const devX = Math.round((shadowPixelWorldX - halo.rect.x) * halo.dpr);
      const devY = Math.round((shadowPixelWorldY - halo.rect.y) * halo.dpr);
      note(isNonBlank(haloPng, devX, devY), `shadow halo pixel OUTSIDE the geometry bbox is present, not blank (sampled device px ${devX},${devY} of ${haloPng.width}x${haloPng.height})`);
    }

    if (consoleErrors.length) errors.push(`CONSOLE ERRORS (dpr ${dpr}):\n` + consoleErrors.join("\n"));
    await context.close(); // closes page too; also drops this dpr's localStorage/autosave
  }

  if (errors.length) throw new Error("PROBE FAILURES:\n" + errors.map((e) => "  - " + e).join("\n"));
  console.log("\nCOPY-PNG EXTENT PROBE OK");
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
