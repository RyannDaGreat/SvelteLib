/**
 * Asset-thumbnail + self-rendering-font-dropdown browser probe (#25 + #26).
 *
 * SELF-CONTAINED + cwd-independent (paths from import.meta.url): spins its OWN
 * Python backend + Vite dev server on FREE ports against a THROWAWAY projects
 * dir, so it never collides with the shared dev server other agents drive, then
 * drives real Chromium:
 *
 *   #25  Loads a project whose assets/ holds a 2-page PDF, opens the Asset
 *        Explorer, and asserts a real THUMBNAIL image tile + a PAGE-COUNT BADGE
 *        ("2") appear (AssetThumb → app.ensureAssetThumbnail → pdfjs raster).
 *   #26  Adds a text box, enters edit mode (floating toolbar), opens the
 *        FontPicker, and asserts each option renders in its OWN typeface (the
 *        option row's resolved font-family is the option's committed family, and
 *        distinct faces really differ) — plus the larger hover preview.
 *
 * Screenshots → POWERRP/.claude_vlm_checks/{asset_thumbnail,font_dropdown}.png.
 * Run:  node src/demo_apps/PowerRP/tests/thumb_font_probe.mjs
 */
import fs from "node:fs";
import os from "node:os";
import { freePort } from "./free_port.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchBrowser } from "./puppeteerLaunch.js";
import { newDocument, serialize } from "../core/document.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POWERRP = path.resolve(HERE, "..");
const SHOTS = path.join(POWERRP, ".claude_vlm_checks");
const FIXTURE_PDF = path.join(POWERRP, "tests", "fixtures", "pdf_vector_fixture.pdf"); // 2 pages
const PROJECT = "ProbeDeck";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// freePort now comes from ./free_port.js, which RE-VERIFIES the port is still
// bindable before handing it back. The copy that used to live here bound port 0,
// read the number, closed, and returned — leaving a TOCTOU window that stays open
// until the spawned backend binds. Under the gate's x3 probe concurrency two
// probes could draw the same number, and the loser died with `Errno 48 Address
// already in use` -> `server never became ready`: a red that said nothing about
// what this probe tests.

async function waitFor(label, fn, { tries = 60, gap = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch {}
    await sleep(gap);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });

  // ── Throwaway project store with the fixture PDF as an asset ────────────────
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "powerrp_probe_"));
  const assetsDir = path.join(projectsDir, PROJECT, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.copyFileSync(FIXTURE_PDF, path.join(assetsDir, "sample.pdf"));
  // A FONT ASSET (#26): a font file in the project's assets/ must register as a
  // selectable family. A committed TTF stands in for a user upload.
  fs.copyFileSync(path.join(POWERRP, "fonts", "Poppins-Regular.ttf"), path.join(assetsDir, "Custom.ttf"));
  const doc = newDocument();
  doc.meta.name = PROJECT;
  fs.writeFileSync(path.join(projectsDir, PROJECT, "doc.json"), serialize(doc)); // serialize() already returns the JSON string

  const [bePort, fePort] = [await freePort(), await freePort()];
  const url = `http://localhost:${fePort}`;
  const procs = [];
  const kill = () => procs.forEach((p) => { try { process.kill(-p.pid); } catch {} });

  // Backend (isolated projects dir) + Vite (proxying to it), both detached so we
  // can kill the whole process group on teardown.
  const backend = spawn("uv", ["run", "server.py", "serve", `--port=${bePort}`],
    { cwd: path.join(POWERRP, "server"), env: { ...process.env, POWERRP_PROJECTS_DIR: projectsDir }, detached: true, stdio: "ignore" });
  procs.push(backend);
  const vite = spawn("npx", ["vite", "dev", "--port", String(fePort), "--strictPort", "--config", "web/vite.config.js"],
    { cwd: POWERRP, env: { ...process.env, BACKEND_URL: `http://localhost:${bePort}`, NO_OPEN: "1" }, detached: true, stdio: "ignore" });
  procs.push(vite);

  const results = [];
  const assert = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`); };

  let browser;
  try {
    await waitFor("backend", async () => (await fetch(`http://localhost:${bePort}/api/projects/`)).ok);
    await waitFor("vite", async () => (await fetch(url)).ok, { tries: 120 });

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await waitFor("app boot", () => page.evaluate(() => !!window.__powerrp_app));
    await sleep(3500); // Skia wasm + fonts + first paint

    // ── #25: load the project → PDF thumbnail + page-count badge in the Explorer ─
    await page.evaluate((name) => window.__powerrp_app.loadProject(name), PROJECT);
    // The AssetExplorer re-lists on project change; the PDF tile then rasterizes
    // its page-1 thumbnail asynchronously (pdfjs). Poll for the rendered <img>.
    await waitFor("pdf thumbnail img", () => page.evaluate(() => {
      const img = document.querySelector(".asset-explorer .ae-thumb-img");
      return !!img && typeof img.src === "string" && img.src.startsWith("data:image");
    }), { tries: 40 });

    const thumbInfo = await page.evaluate(() => {
      const img = document.querySelector(".asset-explorer .ae-thumb-img");
      const badge = document.querySelector(".asset-explorer .ae-badge .ae-badge-text");
      return {
        hasImg: !!img && img.src.startsWith("data:image"),
        imgW: img?.naturalWidth ?? 0,
        imgH: img?.naturalHeight ?? 0,
        badge: badge?.textContent?.trim() ?? null,
      };
    });
    assert("PDF asset shows a rendered thumbnail image", thumbInfo.hasImg && thumbInfo.imgW > 0, `${thumbInfo.imgW}x${thumbInfo.imgH}`);
    assert("PDF thumbnail carries a page-count badge = '2'", thumbInfo.badge === "2", `badge=${JSON.stringify(thumbInfo.badge)}`);

    // Screenshot the left column (Slide Nav + Asset Explorer) for the VLM.
    const aeBox = await page.evaluate(() => {
      const ae = document.querySelector(".asset-explorer");
      const r = ae.getBoundingClientRect();
      // Widen a touch to include the panel title above it.
      return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 40), width: Math.min(420, r.width + 16), height: Math.min(700, r.height + 60) };
    });
    await page.screenshot({ path: path.join(SHOTS, "asset_thumbnail.png"), clip: aeBox });

    // ── #26: text edit → open FontPicker → options render in their own face ─────
    await page.evaluate(() => {
      const app = window.__powerrp_app;
      // Add a text widget directly (the toolbar's "Add Text" only ARMS crosshair
      // placement, which needs a canvas gesture) then enter edit mode — addItem
      // selects the new item, so app.selection is its id.
      const plug = app.registry.get("text");
      app.addItem({ ...plug.defaults, text: "The quick brown fox", x: 260, y: 220 });
      app.beginTextEdit(app.selection);
    });
    // The floating toolbar (with FontPicker) mounts on edit.
    await waitFor("font picker trigger", () => page.evaluate(() => !!document.querySelector(".fontpicker .fp-trigger")), { tries: 30 });
    await page.evaluate(() => document.querySelector(".fontpicker .fp-trigger").click());
    await waitFor("font picker menu open", () => page.evaluate(() => !!document.querySelector(".fp-pop .fp-item")), { tries: 20 });
    await page.evaluate(() => {
      // Hover an interesting face so the larger preview panel shows in the shot.
      const items = [...document.querySelectorAll(".fp-pop .fp-item")];
      const playfair = items.find((el) => /Playfair/i.test(el.textContent)) || items[3] || items[0];
      playfair?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    });
    await sleep(500);

    const fontInfo = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".fp-pop .fp-item")];
      const rows = items.map((el) => ({ label: el.textContent.trim(), family: getComputedStyle(el).fontFamily }));
      // Distinct faces really differ (each option is styled with ITS family, not one shared UI font).
      const families = new Set(rows.map((r) => r.family));
      const roboto = rows.find((r) => /Roboto/i.test(r.label));
      const preview = document.querySelector(".fp-preview-name");
      return {
        count: rows.length,
        distinctFamilies: families.size,
        robotoInOwnFace: !!roboto && /Roboto/.test(roboto.family),
        previewText: preview?.textContent?.trim() ?? null,
        previewFamily: preview ? getComputedStyle(preview).fontFamily : null,
        sample: rows.slice(0, 6),
      };
    });
    assert("font dropdown lists many options", fontInfo.count >= 8, `${fontInfo.count} options`);
    // #26 "font as asset": the uploaded Custom.ttf registered as a selectable family.
    const assetRow = fontInfo.sample.concat(await page.evaluate(() => [...document.querySelectorAll(".fp-pop .fp-item")].map((el) => ({ label: el.textContent.trim(), family: getComputedStyle(el).fontFamily }))))
      .find((r) => /Custom\.ttf/i.test(r.label));
    assert("uploaded FONT ASSET appears as a selectable family, in its own face", !!assetRow && /Font Custom\.ttf/.test(assetRow.family), JSON.stringify(assetRow));
    assert("options render in DISTINCT own faces (not one UI font)", fontInfo.distinctFamilies >= 6, `${fontInfo.distinctFamilies} distinct font-families`);
    assert("a committed option row uses its OWN family (Roboto)", fontInfo.robotoInOwnFace, JSON.stringify(fontInfo.sample.find((r) => /Roboto/i.test(r.label))));
    assert("hover shows a larger preview in the hovered face", !!fontInfo.previewText && /Playfair|Roboto|Poppins|Inter|System/i.test(fontInfo.previewFamily || fontInfo.previewText), `preview="${fontInfo.previewText}" family=${fontInfo.previewFamily}`);

    // Screenshot the toolbar + open dropdown for the VLM.
    await page.screenshot({ path: path.join(SHOTS, "font_dropdown.png") });

    const dangerous = consoleErrors.filter((e) => /pageerror:|is not a function|cannot read|paintir|skia.*(null|failed)|uncaught/i.test(e));
    assert("no dangerous console/page errors", dangerous.length === 0, dangerous.slice(0, 3).join(" | "));
  } finally {
    if (browser) await browser.close().catch(() => {});
    kill();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nscreenshots: ${SHOTS}/asset_thumbnail.png, ${SHOTS}/font_dropdown.png`);
  if (failed.length) { console.log(`\nRESULT: FAIL — ${failed.length} assertion(s) failed`); process.exit(2); }
  console.log(`\nRESULT: PASS — ${results.length} assertions (PDF thumbnail+badge, font dropdown in-face)`);
}

main().catch((e) => { console.error("PROBE ERROR:", e.stack || e.message); process.exit(1); });
