/**
 * Open Project preview-GRID probe. Verifies the upgraded "Open Project…" command
 * (App.svelte): the modal is a GRID of cards, one per saved server project, each
 * showing a first-slide thumbnail rendered CLIENT-side (gpuService), plus that
 * clicking a card loads THAT project (meta.name matches).
 *
 * Isolation mirrors paste_upload_probe.js: an EPHEMERAL project server
 * (POWERRP_PROJECTS_DIR = a mkdtemp throwaway root, a free port — never the real
 * backend) + an ephemeral Vite (free port, BACKEND_URL → the throwaway server) +
 * puppeteer. The throwaway root is removed on exit. Three distinct projects are
 * seeded via the save API (each a different camera background + rectangle so the
 * previews are visibly different). A screenshot of the grid lands in
 * .claude_vlm_checks/ for a VLM sanity read.
 *
 * ALSO GUARDS THE SHARED 90% DIALOG, here rather than in a probe of its own
 * because this is the dialog that CREATED that geometry (`size="large"` was added
 * for this very grid: a `repeat(auto-fill, minmax(…, 1fr))` grid shrink-wraps to
 * ONE column when its container's width is indefinite). The rule has since been
 * loosened once already — Modal's default moved from "large" to content-sized
 * "auto" — so "large" is now a claim only a measurement can keep honest:
 *   - this grid's panel measures 90% of the viewport in BOTH axes;
 *   - the RENDER CENTER's panel does too (it asks for the same shared size
 *     rather than restating 90% anywhere of its own), and
 *   - the clapperboard in that dialog's title is the SAME icon string its
 *     toolbar button draws, read from the one registry entry that owns it — the
 *     rendered half of the rule tests/toolbar_surfacing_test.js pins at source.
 * Both dialogs are measured in ONE browser boot; a second probe would pay for a
 * second Vite, a second backend and a second Skia warm-up to assert one number.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/open_project_grid_probe.js
 */

import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { newDocument } from "../core/document.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const VLM_DIR = join(APP_DIR, ".claude_vlm_checks");
const SETTLE_MS = 4000; // Skia wasm + fonts + first paint before we drive the app
const THUMB_TIMEOUT_MS = 30000; // budget for all previews to rasterize + stream in
// The shared "large" dialog geometry, expressed as a FRACTION of the viewport so
// the assertion never restates the viewport size the probe happens to set.
const LARGE_MODAL_FRACTION = 0.9;
// Slack for sub-pixel layout: the panel carries a 1px border, and a viewport
// whose 90% is not an integer rounds. One part in a thousand of a 1400px
// viewport is well under a pixel, so this still catches a wrong SIZE class.
const FRACTION_TOLERANCE = 0.002;

/** Query. A free TCP port (bind :0, read the assigned port, release). */
// freePort now comes from ./free_port.js, which RE-VERIFIES the port is still
// bindable before handing it back. The copy that used to live here bound port 0,
// read the number, closed, and returned — leaving a TOCTOU window that stays open
// until the spawned backend binds. Under the gate's x3 probe concurrency two
// probes could draw the same number, and the loser died with `Errno 48 Address
// already in use` -> `server never became ready`: a red that said nothing about
// what this probe tests.

/** Query. Poll a URL until it answers 200 (or throw after `tries`). */
async function waitFor(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became ready at ${url}`);
}

/**
 * Pure function. True when a measured fraction of the viewport is the shared
 * "large" dialog's 90%, within FRACTION_TOLERANCE.
 *
 * @param {number} f Measured extent ÷ viewport extent.
 * @returns {boolean}
 *
 * @example isLargeFraction(0.9)   // true
 * @example isLargeFraction(0.9007) // true  (a 1px border on a 1400px viewport)
 * @example isLargeFraction(0.42)  // false (a content-sized "auto" panel)
 */
function isLargeFraction(f) {
  return Math.abs(f - LARGE_MODAL_FRACTION) <= FRACTION_TOLERANCE;
}

/**
 * Query. The currently open `.modal-panel`'s size as a fraction of the layout
 * viewport, measured from the live DOM (getBoundingClientRect, so it reports what
 * was actually laid out rather than what the stylesheet asked for). THROWS when no
 * dialog is open — a silently absent panel would make every ratio check vacuous.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<{w:number,h:number,fw:number,fh:number,vw:number,vh:number}>}
 */
async function modalViewportFractions(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".modal-panel");
    if (!panel) throw new Error("no .modal-panel is open to measure");
    const r = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return { w: r.width, h: r.height, fw: r.width / vw, fh: r.height / vh, vw, vh };
  });
}

/** Query. A distinct seed doc: a colored camera background + a contrasting
 *  rectangle on slide 0, an optional trailing empty slide (to vary slideCount).
 *  Camera id is the sole item newDocument() creates. */
function seedDoc(name, background, rectFill, extraSlides = 0) {
  const doc = newDocument();
  doc.meta = { ...doc.meta, name };
  const slide0 = doc.slides[0];
  const items = { ...slide0.delta.items };
  const camId = Object.keys(items)[0];
  items[camId] = { ...items[camId], background };
  items[`rect_${name.replace(/\W/g, "")}`] = {
    type: "rect", x: 320, y: 170, w: 640, h: 380, z: 1, rotation: 0, scale: 1,
    active: true, fill: rectFill, stroke: "#101014", strokeWidth: 8, opacity: 1,
  };
  const slides = [{ ...slide0, delta: { ...slide0.delta, items } }];
  for (let i = 0; i < extraSlides; i++) {
    slides.push({ id: `s${i}_${name}`, name: `Slide ${i + 2}`, transition: slide0.transition, delta: {} });
  }
  return { ...doc, slides };
}

const SEEDS = [
  { name: "Sunrise Deck", background: "#f7768e", rectFill: "#ffd27a", extraSlides: 2 },
  { name: "Ocean Notes", background: "#1f6feb", rectFill: "#7dcfff", extraSlides: 0 },
  { name: "Forest Plan", background: "#2ea043", rectFill: "#d7ffb0", extraSlides: 1 },
];

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_open_grid_"));
const backendPort = await freePort();
const server = spawn("uv", ["run", "server.py", "serve", `--port=${backendPort}`], {
  cwd: join(APP_DIR, "server"),
  env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
  stdio: ["ignore", "inherit", "inherit"],
});
server.on("error", (e) => { throw e; });

let viteServer, browser;
const errors = [];
try {
  const backendBase = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${backendBase}/api/projects/`);

  // Seed the three projects through the save API (the SAME endpoint Save-to-Server hits).
  for (const s of SEEDS) {
    const res = await fetch(`${backendBase}/api/project/${encodeURIComponent(s.name)}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seedDoc(s.name, s.background, s.rectFill, s.extraSlides)),
    });
    if (!res.ok) throw new Error(`seed PUT ${s.name} → ${res.status}`);
  }
  const listed = await (await fetch(`${backendBase}/api/projects/`)).json();
  if (listed.length !== SEEDS.length) throw new Error(`expected ${SEEDS.length} projects, server lists ${listed.length}`);

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
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && /preview render failed/.test(m.text())) errors.push(`preview failure: ${m.text()}`);
  });

  await page.goto(pageUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  if (!(await page.evaluate(() => !!window.__powerrp_app))) throw new Error("app never initialized (__powerrp_app absent)");

  // Open the modal via the SAME command the palette/toolbar run.
  await page.evaluate(() => window.__powerrp_app.openProject());
  await page.waitForSelector(".open-project-grid .open-project-card", { timeout: 8000 });

  const cardCount = await page.$$eval(".open-project-card", (cards) => cards.length);
  if (cardCount !== SEEDS.length) throw new Error(`grid shows ${cardCount} cards, expected ${SEEDS.length}`);

  // The shared 90% dialog, measured on the grid that created it.
  const gridPanel = await modalViewportFractions(page);
  console.log(`Open Project panel: ${gridPanel.w}x${gridPanel.h} of ${gridPanel.vw}x${gridPanel.vh} viewport`
    + ` → ${(gridPanel.fw * 100).toFixed(2)}% x ${(gridPanel.fh * 100).toFixed(2)}%`);
  if (!isLargeFraction(gridPanel.fw) || !isLargeFraction(gridPanel.fh)) {
    throw new Error(`Open Project dialog is ${(gridPanel.fw * 100).toFixed(2)}% x ${(gridPanel.fh * 100).toFixed(2)}%`
      + ` of the viewport, expected ${LARGE_MODAL_FRACTION * 100}% in both axes (size="large")`);
  }

  // Poll until every card's thumbnail is a real (non-empty) data URL.
  const deadline = Date.now() + THUMB_TIMEOUT_MS;
  let states = [];
  while (Date.now() < deadline) {
    states = await page.$$eval(".open-project-card", (cards) =>
      cards.map((c) => {
        const img = c.querySelector("img");
        const src = img?.getAttribute("src") || "";
        return {
          name: c.querySelector(".open-project-card-name")?.textContent ?? "",
          meta: c.querySelector(".open-project-card-meta")?.textContent ?? "",
          isData: src.startsWith("data:image/"),
          bytes: src.length,
        };
      }));
    if (states.every((s) => s.isData && s.bytes > 1000)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const notReady = states.filter((s) => !(s.isData && s.bytes > 1000));
  if (notReady.length) throw new Error(`thumbnails never rendered: ${notReady.map((s) => s.name).join(", ")}`);
  console.log("Cards + thumbnails:", JSON.stringify(states, null, 2));

  // Screenshot the grid for a VLM read.
  mkdirSync(VLM_DIR, { recursive: true });
  const shotPath = join(VLM_DIR, "open_project_grid.png");
  const panel = await page.$(".modal-panel");
  await (panel ?? page).screenshot({ path: shotPath });
  console.log("Screenshot:", shotPath);

  // Click a specific card → it must load THAT project (meta.name matches) and close the modal.
  const target = "Ocean Notes";
  await page.evaluate((name) => {
    const card = [...document.querySelectorAll(".open-project-card")]
      .find((c) => c.querySelector(".open-project-card-name")?.textContent === name);
    card.click();
  }, target);
  await new Promise((r) => setTimeout(r, 1500));
  const loadedName = await page.evaluate(() => window.__powerrp_app.projectName());
  const modalGone = await page.evaluate(() => !document.querySelector(".open-project-grid"));
  if (loadedName !== target) throw new Error(`clicked "${target}" but loaded project is "${loadedName}"`);
  if (!modalGone) throw new Error("modal did not close after clicking a card");

  // ── The RENDER CENTER: same shared 90%, and one icon string in one place ────
  // Opened through the registry ENTRY (not a bespoke app method), because that
  // entry is also where the icon comes from — driving the real action layer is
  // what makes "the dialog and the button agree" a claim about the product.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.commands.get("render-center").run(app);
  });
  await page.waitForSelector(".modal-panel .modal-title-group", { timeout: 8000 });
  const rcPanel = await modalViewportFractions(page);
  console.log(`Render Center panel: ${rcPanel.w}x${rcPanel.h} of ${rcPanel.vw}x${rcPanel.vh} viewport`
    + ` → ${(rcPanel.fw * 100).toFixed(2)}% x ${(rcPanel.fh * 100).toFixed(2)}%`);
  if (!isLargeFraction(rcPanel.fw) || !isLargeFraction(rcPanel.fh)) {
    throw new Error(`Render Center dialog is ${(rcPanel.fw * 100).toFixed(2)}% x ${(rcPanel.fh * 100).toFixed(2)}%`
      + ` of the viewport, expected ${LARGE_MODAL_FRACTION * 100}% in both axes (size="large")`);
  }

  const chrome = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const cmd = app.commands.get("render-center");
    const button = [...document.querySelector(".toolbar").querySelectorAll("button")]
      .find((b) => b.getAttribute("aria-label") === cmd.title);
    return {
      registryIcon: cmd.icon,
      titleIcon: document.querySelector(".modal-panel .modal-title-icon")?.getAttribute("icon") ?? null,
      titleText: document.querySelector(".modal-panel .modal-title")?.textContent ?? null,
      buttonIcon: button ? button.querySelector("iconify-icon")?.getAttribute("icon") ?? null : null,
    };
  });
  console.log("Render Center chrome:", JSON.stringify(chrome));
  if (!chrome.titleIcon) throw new Error("the Render Center dialog title draws no icon at all");
  if (chrome.titleIcon !== chrome.registryIcon) {
    throw new Error(`dialog title icon "${chrome.titleIcon}" is not the registry entry's "${chrome.registryIcon}"`
      + " — the title must READ the icon, never restate it");
  }
  if (chrome.buttonIcon !== chrome.registryIcon) {
    throw new Error(`toolbar button icon "${chrome.buttonIcon}" is not the registry entry's "${chrome.registryIcon}"`);
  }
  const rcShot = join(VLM_DIR, "render_center_dialog.png");
  await (await page.$(".modal-panel")).screenshot({ path: rcShot });
  console.log("Screenshot:", rcShot);
  // Close it: the dialog runs a 1s poll, and leaving it mounted lets that fire
  // against a backend this probe is about to tear down.
  await page.evaluate(() => window.__powerrp_app.toggleRenderCenter());
  await new Promise((r) => setTimeout(r, 300));

  if (errors.length) throw new Error("captured errors:\n" + errors.join("\n"));
  console.log(`OPEN-GRID OK — ${cardCount} preview cards rendered, click loaded "${loadedName}", modal closed;`
    + ` both dialogs measure ${(gridPanel.fw * 100).toFixed(1)}% x ${(gridPanel.fh * 100).toFixed(1)}%`
    + ` / ${(rcPanel.fw * 100).toFixed(1)}% x ${(rcPanel.fh * 100).toFixed(1)}% of the viewport,`
    + ` and the Render Center title draws the registry's "${chrome.registryIcon}".`);
} catch (e) {
  console.error("OPEN-GRID FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (viteServer) await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
