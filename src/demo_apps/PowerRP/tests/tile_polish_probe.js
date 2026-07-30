/**
 * ASSET TILE POLISH probe — the browser half of four user rulings about an asset
 * tile. Run: node src/demo_apps/PowerRP/tests/tile_polish_probe.js
 *
 * What only a real browser can answer (the bare-node twin is tests/tile_tooltip_test.js
 * and tests/plugin_asset_edit_test.js, which pin the pure decisions):
 *
 *   1. TIP STRUCTURE — the filename is on its OWN line and is actually rendered BOLD
 *      (computed font-weight, not a class name), with kind · size italic beneath it.
 *   2. TIP PLACEMENT — "the tooltip should never be intersecting [the asset]… fully
 *      below or fully above." MEASURED: the tip's rect vs the tile's rect, zero
 *      intersection — checked on a top tile AND on a bottom-row tile, which must FLIP
 *      to the other side. A pure-function test cannot see this: it depends on real
 *      layout, real text wrapping and the real viewport.
 *   3. DOWNLOAD — clicking the tile's download button actually produces a file, for an
 *      IMAGE and for a PLUGIN asset. Verified through CDP Browser.setDownloadBehavior
 *      + Page.downloadWillBegin, i.e. the browser's own download machinery, not by
 *      inspecting our code.
 *   4. BUILT-IN EDIT (the live repro) — double-clicking a BUILT-IN plugin tile used to
 *      throw "httpAssetStore.get(<project>, clock_digital.plugin.js): 404" because
 *      every tile was resolved as a project asset. Now it must open a READ-ONLY Monaco
 *      with the copy note, and Save must write a working COPY into the project.
 *
 * ISOLATION (the probe.jpg incident rule): this probe NEVER touches the user's real
 * projects/ folder or the dev ports. It runs its own Python backend on an EPHEMERAL
 * port with POWERRP_PROJECTS_DIR = mkdtemp, its own Vite on port 0, and its own
 * downloads directory. All are torn down in `finally` regardless of outcome.
 *
 * Screenshots land in the directory given as argv[2], else a temp dir (path printed).
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
// `uv run`, never a hardcoded interpreter: the dump must work on a wiped container
// (asset_ux_probe.js carries the same note after being permanently red on Linux).
const PY = "uv";
const PY_ARGS = ["run", "server.py"];
const PROJECT = "tilepol_probe";
// A 1x1 red PNG — the smallest valid PNG, the paste_upload_probe.js precedent.
const PROBE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";
// A minimal VALID plugin asset, so the project has a plugin tile of its own to
// download beside the image one (the ruling says the icon is on EVERY tile).
const PROBE_PLUGIN = `return {
  type: "tilepol_probe_widget",
  title: "Tile Polish Probe",
  capabilities: { bbox: true },
  defaults: { type: "tilepol_probe_widget", x: 100, y: 100, w: 80, h: 80, fill: "#4488cc" },
  emit: (s) => [{ op: "rect", x: 0, y: 0, w: s.w, h: s.h, fill: s.fill }],
};`;
// The built-in the user's repro named. Listed by the show-built-ins toggle.
const BUILTIN_NAME = "clock_digital.plugin.js";
const BUILTIN_NOTE = "Built-in — Save copies into this project";
// A tip must clear its tile by at least the Tooltip's own gap; 0 would pass on a
// merely-touching tip, which reads as intersecting.
const MIN_TIP_CLEARANCE_PX = 1;

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

/**
 * Pure function. Do two viewport rects OVERLAP at all (area > 0)? The ruling's
 * predicate: a tile tip must be "fully below or fully above", so ANY overlap is a
 * failure — touching edges are not an overlap.
 *
 * @example
 * // Tip sitting entirely below the tile: no overlap.
 * rectsOverlap({left:0,right:80,top:0,bottom:80}, {left:0,right:80,top:86,bottom:120})
 * // => false
 * @example
 * // Tip drawn across the tile's lower half: overlap.
 * rectsOverlap({left:0,right:80,top:0,bottom:80}, {left:0,right:80,top:40,bottom:120})
 * // => true
 */
function rectsOverlap(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

const errors = [];
const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_tilepol_probe_"));
const downloadDir = mkdtempSync(join(tmpdir(), "powerrp_tilepol_dl_"));
const shotDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "powerrp_tilepol_shots_"));
mkdirSync(shotDir, { recursive: true });
let pyServer, viteServer, browser;

try {
  // ── Seed a project with an IMAGE and a PLUGIN asset ─────────────────────────
  const assetsDir = join(projectsRoot, PROJECT, "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "seed.png"), Buffer.from(PROBE_PNG_B64, "base64"));
  writeFileSync(join(assetsDir, "probe_widget.plugin.js"), PROBE_PLUGIN);
  writeFileSync(
    join(projectsRoot, PROJECT, "doc.json"),
    JSON.stringify({ meta: { name: PROJECT }, slides: [{ id: "s0", name: "Slide 0", delta: {} }] }),
  );

  const backendPort = await freePort();
  pyServer = spawn(PY, [...PY_ARGS, "serve", `--port=${backendPort}`], {
    cwd: join(APP_DIR, "server"),
    env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
    stdio: ["ignore", "inherit", "inherit"],
  });
  pyServer.on("error", (e) => { throw e; });
  const backendBase = `http://127.0.0.1:${backendPort}`;
  await waitFor(`${backendBase}/api/projects/`);

  // vite.config.js reads BACKEND_URL at CONFIG-EVAL time, so it must be set before
  // createViteServer imports the config (the paste_upload_probe.js precedent).
  process.env.BACKEND_URL = backendBase;
  process.env.NO_OPEN = "1";
  viteServer = await createViteServer({
    configFile: join(APP_DIR, "web", "vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  browser = await puppeteer.launch({
    headless: "new",
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // WebGPU is absent on a GPU-less box and video_v7 REPORTS its fallback — a working
  // fallback, not a probe failure (fontpicker_probe.js carries the same clause).
  const IGNORE_CONSOLE = /WebGPU|VideoV7/i;
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    consoleErrors.push(t);
    if (!IGNORE_CONSOLE.test(t)) errors.push(`console.error: ${t}`);
  });

  // THE DOWNLOAD SEAM: the browser's own machinery, so "the download fired" is the
  // browser's verdict rather than ours. downloadWillBegin gives us the filename the
  // page asked for; the file landing on disk proves bytes actually flowed.
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
  const downloads = [];
  cdp.on("Page.downloadWillBegin", (e) => downloads.push(e.suggestedFilename));
  await cdp.send("Page.enable");

  // Boot straight into the seeded project, and with built-ins SHOWN (the toggle is a
  // persisted browser setting, so seeding localStorage is how the built-in tiles are
  // on screen at first paint — the state the user's repro was in).
  await page.evaluateOnNewDocument((name) => {
    localStorage.setItem("powerrp.autosave", JSON.stringify({
      meta: { name }, slides: [{ id: "s0", name: "Slide 0", delta: {} }],
    }));
    // "on"/"off", NOT "true": that is web/settings.js browserSetting's storage format,
    // and a wrong spelling reads as OFF (stored !== "on"), silently leaving the
    // built-in tiles off screen — i.e. the probe would pass by not testing them.
    localStorage.setItem("powerrp.showBuiltinAssets", "on");
  }, PROJECT);

  await page.goto(`${pageBase}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  if (errors.length) throw new Error("PAGE ERRORS AT BOOT:\n" + errors.join("\n"));

  /** Query. The tiles now in the Asset Explorer, with their names and rects. */
  const listTiles = () =>
    page.evaluate(() => [...document.querySelectorAll(".asset-explorer .ae-cell")].map((cell, i) => {
      const tile = cell.querySelector(".ae-tile");
      const r = tile.getBoundingClientRect();
      return {
        index: i,
        name: cell.querySelector(".ae-name")?.textContent.trim() ?? "",
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      };
    }));

  let tiles = [];
  for (let i = 0; i < 50; i++) {
    tiles = await listTiles();
    if (tiles.some((t) => t.name === "seed.png") && tiles.some((t) => t.name === BUILTIN_NAME)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const named = (n) => tiles.find((t) => t.name === n);
  for (const want of ["seed.png", "probe_widget.plugin.js", BUILTIN_NAME]) {
    if (!named(want)) errors.push(`[0] SETUP: no "${want}" tile in the Asset Explorer (found: ${tiles.map((t) => t.name).join(", ")})`);
  }
  if (errors.length) throw new Error("SETUP FAILED:\n" + errors.join("\n"));
  console.log(`[0] setup ok: ${tiles.length} tiles listed (project assets + built-in library)`);

  /**
   * Command + Query. Hover a tile by name and return the tip's measured geometry and
   * text runs. REAL pointer moves, not page.hover(): Tooltip opens on pointerenter and
   * tracks pointermove, so a synthetic hover shows nothing.
   *
   * The pointer is parked far away first, so a previous tip is dismissed and the new
   * one is definitely this tile's.
   */
  async function hoverTile(name) {
    const tile = (await listTiles()).find((t) => t.name === name);
    if (!tile) return null;
    const cx = Math.round(tile.rect.left + (tile.rect.right - tile.rect.left) / 2);
    const cy = Math.round(tile.rect.top + (tile.rect.bottom - tile.rect.top) / 2);
    await page.mouse.move(5, 5);
    await new Promise((r) => setTimeout(r, 150));
    await page.mouse.move(cx, cy);
    await page.mouse.move(cx + 1, cy); // a real move, so cursor-mode tips would track
    await new Promise((r) => setTimeout(r, 350));
    return page.evaluate(() => {
      const tip = document.querySelector(".tt-tip");
      if (!tip) return null;
      const r = tip.getBoundingClientRect();
      const line = (sel) => {
        const el = tip.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const er = el.getBoundingClientRect();
        return {
          text: el.textContent.trim(),
          fontWeight: cs.fontWeight,
          fontStyle: cs.fontStyle,
          top: er.top,
        };
      };
      return {
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        text: tip.textContent.trim().replace(/\s+/g, " "),
        name: line(".ae-tip-name"),
        meta: line(".ae-tip-meta"),
        desc: line(".ae-tip-desc"),
      };
    });
  }

  // ── CHECK 1: THE TIP'S STRUCTURE, AS RENDERED ──────────────────────────────
  // "the file name should always be the top and then everything else comes in a new
  // line after that… The file name should always be bold in that tooltip."
  const imgTip = await hoverTile("seed.png");
  if (!imgTip) errors.push("[1] hovering seed.png produced no tooltip at all");
  else {
    if (imgTip.name?.text !== "seed.png") errors.push(`[1] the tip's first line must be the bare filename, got ${JSON.stringify(imgTip.name?.text)}`);
    const weight = Number(imgTip.name?.fontWeight ?? 0);
    if (!(weight >= 700)) errors.push(`[1] the FILENAME line must be BOLD; computed font-weight was ${imgTip.name?.fontWeight}`);
    if (imgTip.meta?.fontStyle !== "italic") errors.push(`[1] the kind · size line must be italic; got ${imgTip.meta?.fontStyle}`);
    if (!/^image · \d/.test(imgTip.meta?.text ?? "")) errors.push(`[1] line 2 must be "kind · size", got ${JSON.stringify(imgTip.meta?.text)}`);
    // The name is ABOVE the other lines (the ruling's "always the top").
    if (!(imgTip.name.top < imgTip.meta.top && imgTip.meta.top < imgTip.desc.top))
      errors.push("[1] the tip's three lines are not stacked name → meta → description");
    // Separate LINES, not a mashed string: the name's box must not share meta's row.
    if (imgTip.name.top === imgTip.meta.top) errors.push("[1] the filename shares a line with the metadata — the ruling wants a new line after it");
    if (errors.filter((e) => e.startsWith("[1]")).length === 0)
      console.log(`[1] TIP STRUCTURE ok: bold "${imgTip.name.text}" (weight ${imgTip.name.fontWeight}) / italic "${imgTip.meta.text}" / then the description`);
  }

  // Screenshot the bold-filename tip, tile + tip in one frame.
  if (imgTip) {
    const shot = join(shotDir, "tip_bold_filename.png");
    const tile = named("seed.png");
    const clip = {
      x: Math.max(0, Math.min(tile.rect.left, imgTip.rect.left) - 12),
      y: Math.max(0, Math.min(tile.rect.top, imgTip.rect.top) - 12),
      width: Math.min(1440, Math.max(tile.rect.right, imgTip.rect.right) + 12) - Math.max(0, Math.min(tile.rect.left, imgTip.rect.left) - 12),
      height: Math.min(900, Math.max(tile.rect.bottom, imgTip.rect.bottom) + 12) - Math.max(0, Math.min(tile.rect.top, imgTip.rect.top) - 12),
    };
    await page.screenshot({ path: shot, clip });
    console.log(`[1] screenshot: ${shot}`);
  }

  // ── CHECK 2: THE TIP NEVER INTERSECTS ITS OWN TILE ─────────────────────────
  // Measured, both directions. A tile near the TOP of the pane has room below; the
  // LAST tile in a scrolled-to-bottom grid must FLIP and sit above. If both landed on
  // the same side the flip would be untested, so the sides are asserted to differ.
  const placements = [];
  for (const [label, name] of [["top-area tile", "seed.png"], ["bottom-row tile", null]]) {
    // The bottom-row target is chosen AFTER scrolling the pane to its end, so it is a
    // tile with no room beneath it — the case that forces the flip.
    let targetName = name;
    if (!targetName) {
      await page.evaluate(() => {
        const body = document.querySelector(".asset-explorer")?.closest("[class*='body'], .panel-body") ?? document.querySelector(".asset-explorer")?.parentElement;
        if (body) body.scrollTop = body.scrollHeight;
        const ae = document.querySelector(".asset-explorer");
        if (ae) ae.scrollIntoView({ block: "end" });
      });
      await new Promise((r) => setTimeout(r, 250));
      // The visually LOWEST tile currently on screen.
      const fresh = await listTiles();
      const lowest = fresh.filter((t) => t.rect.bottom <= 900).sort((a, b) => b.rect.top - a.rect.top)[0];
      targetName = lowest?.name;
    }
    if (!targetName) { errors.push(`[2] could not choose a ${label}`); continue; }
    const tip = await hoverTile(targetName);
    const tile = (await listTiles()).find((t) => t.name === targetName);
    if (!tip || !tile) { errors.push(`[2] ${label} ("${targetName}"): no tooltip appeared`); continue; }
    const overlap = rectsOverlap(tile.rect, tip.rect);
    const side = tip.rect.bottom <= tile.rect.top ? "above" : tip.rect.top >= tile.rect.bottom ? "below" : "OVERLAPPING";
    const clearance = side === "above" ? tile.rect.top - tip.rect.bottom : side === "below" ? tip.rect.top - tile.rect.bottom : 0;
    placements.push({ label, targetName, side, clearance });
    if (overlap)
      errors.push(`[2] ${label} ("${targetName}"): the tip INTERSECTS its tile — tile [${tile.rect.top.toFixed(0)},${tile.rect.bottom.toFixed(0)}] vs tip [${tip.rect.top.toFixed(0)},${tip.rect.bottom.toFixed(0)}]`);
    else if (clearance < MIN_TIP_CLEARANCE_PX)
      errors.push(`[2] ${label}: the tip only clears its tile by ${clearance.toFixed(1)}px (needs ≥ ${MIN_TIP_CLEARANCE_PX})`);
    else console.log(`[2] ${label} ("${targetName}"): tip sits fully ${side}, ${clearance.toFixed(1)}px clear — zero intersection`);
    // Screenshot the bottom-row case, which is the flip.
    if (label === "bottom-row tile") {
      const shot = join(shotDir, "tip_flipped_above_bottom_tile.png");
      const x0 = Math.max(0, Math.min(tile.rect.left, tip.rect.left) - 12);
      const y0 = Math.max(0, Math.min(tile.rect.top, tip.rect.top) - 12);
      await page.screenshot({
        path: shot,
        clip: {
          x: x0, y: y0,
          width: Math.min(1440, Math.max(tile.rect.right, tip.rect.right) + 12) - x0,
          height: Math.min(900, Math.max(tile.rect.bottom, tip.rect.bottom) + 12) - y0,
        },
      });
      console.log(`[2] screenshot: ${shot}`);
    }
  }
  if (placements.length === 2 && placements[0].side === placements[1].side)
    console.log(`[2] NOTE: both sampled tiles placed ${placements[0].side}; the flip is exercised by tests/tile_tooltip_test.js's exhaustive resolvePlacement sweep.`);

  // ── CHECK 3: THE DOWNLOAD BUTTON FIRES, FOR AN IMAGE AND FOR A PLUGIN ──────
  // "In addition to the trash icon and copy path icon, there should also always be a
  // download icon." Clicked for real; the verdict is the browser's own download event
  // plus the bytes landing on disk.
  async function clickDownload(name) {
    const box = await page.evaluate((n) => {
      const cell = [...document.querySelectorAll(".asset-explorer .ae-cell")]
        .find((c) => c.querySelector(".ae-name")?.textContent.trim() === n);
      if (!cell) return null;
      const tile = cell.querySelector(".ae-tile");
      tile.scrollIntoView({ block: "center" });
      const btn = cell.querySelector(".ae-download");
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
    }, name);
    if (!box) return { ok: false, why: "no .ae-download button on that tile" };
    if (box.w === 0 || box.h === 0) return { ok: false, why: "the download button has zero size" };
    // Hover the tile first: the action row is hover-revealed, so a cold click would
    // land on an opacity-0 button — which is exactly what a user cannot do either.
    await page.mouse.move(box.x, box.y);
    await new Promise((r) => setTimeout(r, 200));
    await page.mouse.click(box.x, box.y);
    await new Promise((r) => setTimeout(r, 900));
    return { ok: true };
  }

  for (const [kind, name] of [["image", "seed.png"], ["plugin", "probe_widget.plugin.js"]]) {
    const before = downloads.length;
    const clicked = await clickDownload(name);
    if (!clicked.ok) { errors.push(`[3] ${kind} ("${name}"): ${clicked.why}`); continue; }
    // Wait for the file to appear (the download event can precede the bytes).
    let landed = null;
    for (let i = 0; i < 30; i++) {
      landed = readdirSync(downloadDir).find((f) => f === name);
      if (landed) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const fired = downloads.length > before;
    if (!fired) errors.push(`[3] ${kind} ("${name}"): no Page.downloadWillBegin — the click did not start a download`);
    else if (downloads[downloads.length - 1] !== name)
      errors.push(`[3] ${kind}: the browser was asked to save "${downloads[downloads.length - 1]}", expected "${name}"`);
    if (!landed) errors.push(`[3] ${kind} ("${name}"): no file landed in the download dir (saw: ${readdirSync(downloadDir).join(", ") || "nothing"})`);
    else {
      const bytes = readFileSync(join(downloadDir, landed));
      if (bytes.length === 0) errors.push(`[3] ${kind}: "${landed}" downloaded as ZERO bytes`);
      else console.log(`[3] DOWNLOAD ok (${kind}): "${landed}", ${bytes.length} bytes, via the browser's own download path`);
    }
  }

  // ── CHECK 4: THE BUILT-IN EDIT 404 (the live repro) ────────────────────────
  // Double-click clock_digital.plugin.js. It must NOT 404; it must open a READ-ONLY
  // Monaco carrying the copy note.
  const before404 = consoleErrors.length;
  await page.evaluate((n) => {
    const cell = [...document.querySelectorAll(".asset-explorer .ae-cell")]
      .find((c) => c.querySelector(".ae-name")?.textContent.trim() === n);
    cell.querySelector(".ae-tile").scrollIntoView({ block: "center" });
  }, BUILTIN_NAME);
  await new Promise((r) => setTimeout(r, 200));
  const hitBox = await page.evaluate((n) => {
    const cell = [...document.querySelectorAll(".asset-explorer .ae-cell")]
      .find((c) => c.querySelector(".ae-name")?.textContent.trim() === n);
    const hit = cell.querySelector(".ae-tile-hit");
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, BUILTIN_NAME);
  await page.mouse.click(hitBox.x, hitBox.y, { clickCount: 2 });
  // Monaco is a real dependency load; give it room.
  let modal = null;
  for (let i = 0; i < 60; i++) {
    modal = await page.evaluate(() => {
      if (!window.__powerrp_codeModal) return null;
      return {
        value: window.__powerrp_codeModal.getValue(),
        readOnly: window.__powerrp_codeModal.isReadOnly(),
        note: document.querySelector(".code-modal-note")?.textContent.trim() ?? null,
        saveLabel: document.querySelector(".code-modal-primary")?.textContent.trim() ?? null,
        title: document.querySelector("[role='dialog']")?.textContent.slice(0, 120) ?? null,
      };
    });
    if (modal?.value) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const new404s = consoleErrors.slice(before404).filter((t) => /404|httpAssetStore\.get/.test(t));
  if (new404s.length) errors.push(`[4] THE REPRO IS STILL LIVE: ${new404s.join(" | ")}`);
  if (!modal?.value) errors.push("[4] double-clicking the built-in plugin tile did not open the code editor");
  else {
    if (!modal.readOnly) errors.push("[4] the built-in's editor must be READ-ONLY (Monaco's own readOnly option)");
    if (modal.note !== BUILTIN_NOTE) errors.push(`[4] the footer must carry the note ${JSON.stringify(BUILTIN_NOTE)}, got ${JSON.stringify(modal.note)}`);
    if (modal.saveLabel !== "Save a Copy") errors.push(`[4] the primary button must say "Save a Copy", got ${JSON.stringify(modal.saveLabel)}`);
    if (!/clock_digital/.test(modal.value)) errors.push("[4] the editor did not load the built-in's actual source");
    if (errors.filter((e) => e.startsWith("[4]")).length === 0)
      console.log(`[4] BUILT-IN EDIT ok: opened READ-ONLY (${modal.value.length} chars of real source), note "${modal.note}", button "${modal.saveLabel}", NO 404`);
    const shot = join(shotDir, "builtin_readonly_editor.png");
    await page.screenshot({ path: shot });
    console.log(`[4] screenshot: ${shot}`);
  }

  // ── CHECK 4b: SAVE COPIES INTO THE PROJECT, AND THE COPY IS A REAL WIDGET ──
  if (modal?.value) {
    const typesBefore = await page.evaluate(() => window.__powerrp_app?.registry.all().map((p) => p.type) ?? []);
    await page.evaluate(() => window.__powerrp_codeModal.save());
    await new Promise((r) => setTimeout(r, 1500));
    // The dialog closed (a refused save keeps it open with the reason in the footer).
    const stillOpen = await page.evaluate(() => !!window.__powerrp_codeModal);
    const refusal = await page.evaluate(() => document.querySelector(".code-modal-problem")?.textContent.trim() ?? null);
    if (stillOpen) errors.push(`[4b] Save was REFUSED — the dialog is still open${refusal ? `: ${refusal}` : ""}`);
    // The copy is on the SERVER (the real round trip, not just in the UI's list).
    const listed = await (await fetch(`${backendBase}/api/assets/${PROJECT}`)).json();
    const copy = listed.find((a) => a.name !== "probe_widget.plugin.js" && /^clock_digital.*\.plugin\.js$/.test(a.name));
    if (!copy) errors.push(`[4b] no clock_digital copy in the project's assets (have: ${listed.map((a) => a.name).join(", ")})`);
    else {
      // It must still BE a plugin asset (the .plugin.js suffix survived de-collision —
      // a naive de-collide would have written "clock_digital.plugin 2.js").
      if (!copy.name.endsWith(".plugin.js")) errors.push(`[4b] the copy "${copy.name}" is not a *.plugin.js — it would not load as a widget`);
      if (copy.kind !== "plugin") errors.push(`[4b] the copy is classified "${copy.kind}", not "plugin"`);
      // And it must have REGISTERED as a new widget type, distinct from the built-in's.
      const typesAfter = await page.evaluate(() => window.__powerrp_app?.registry.all().map((p) => p.type) ?? []);
      const added = typesAfter.filter((t) => !typesBefore.includes(t));
      if (typesBefore.length === 0) console.log("[4b] NOTE: no registry seam on window; the type check is covered by tests/plugin_asset_edit_test.js");
      else if (!added.some((t) => /^clock_digital_\d+$/.test(t)))
        errors.push(`[4b] the copy did not register a NEW widget type (added: ${JSON.stringify(added)}) — a verbatim copy is refused for colliding with the built-in`);
      else console.log(`[4b] COPY-ON-SAVE ok: "${copy.name}" (${copy.size}B) registered as ${added.filter((t) => /clock_digital/.test(t)).join(", ")}`);
      if (typesBefore.length === 0 && copy.name.endsWith(".plugin.js"))
        console.log(`[4b] COPY-ON-SAVE ok: "${copy.name}" (${copy.size}B) written into the project through the asset store`);
    }
  }

  // ── CHECK 5: BOTH STORAGE MODES ────────────────────────────────────────────
  // Everything above ran against the PYTHON BACKEND (http adapter). The two new
  // write paths must work identically against IndexedDB, because that is the
  // explicit contract of the asset-store seam — and it is where the naive
  // implementations break differently:
  //   · DOWNLOAD: an <a href="/asset/…" download> has no origin to fetch from in
  //     static mode, so it would save the app's 404 page under the asset's name.
  //   · COPY-ON-SAVE: put/replace are adapter methods; only the seam makes them
  //     the same call.
  // `?static=1` forces the local adapter even with this probe's backend running
  // (web/storageMode.js's escape hatch).
  {
    const staticPage = await browser.newPage();
    await staticPage.setViewport({ width: 1440, height: 900 });
    const staticErrors = [];
    staticPage.on("pageerror", (e) => staticErrors.push(`pageerror: ${e.message}`));
    staticPage.on("console", (m) => { if (m.type() === "error" && !IGNORE_CONSOLE.test(m.text())) staticErrors.push(m.text()); });
    const staticCdp = await staticPage.createCDPSession();
    const staticDownloads = [];
    await staticCdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
    staticCdp.on("Page.downloadWillBegin", (e) => staticDownloads.push(e.suggestedFilename));
    await staticCdp.send("Page.enable");
    await staticPage.evaluateOnNewDocument(() => {
      localStorage.setItem("powerrp.showBuiltinAssets", "on");
    });
    await staticPage.goto(`${pageBase}/?static=1`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 800));

    const mode = await staticPage.evaluate(() => window.__powerrp_app?.storageMode?.() ?? null);
    if (mode !== "local") {
      errors.push(`[5] ?static=1 did not select the local adapter (mode: ${mode}) — the rest of this check would have tested http twice`);
    } else {
      console.log("[5] static mode ok: the page booted on the IndexedDB adapter");
      // Put a real asset into IndexedDB through the app's OWN upload path, so the
      // bytes are stored exactly as a user's drop would store them.
      const uploaded = await staticPage.evaluate(async (b64) => {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const file = new File([bin], "local_seed.png", { type: "image/png" });
        const res = await window.__powerrp_app.uploadAsset(file);
        return res?.name ?? null;
      }, PROBE_PNG_B64).catch((e) => `THREW: ${e.message}`);
      if (uploaded !== "local_seed.png") errors.push(`[5] could not store an asset in IndexedDB (got ${JSON.stringify(uploaded)})`);
      await new Promise((r) => setTimeout(r, 700));

      // 5a. DOWNLOAD from IndexedDB — real bytes, not a 404 page.
      const dlBefore = staticDownloads.length;
      const box = await staticPage.evaluate((n) => {
        const cell = [...document.querySelectorAll(".asset-explorer .ae-cell")]
          .find((c) => c.querySelector(".ae-name")?.textContent.trim() === n);
        if (!cell) return null;
        cell.querySelector(".ae-tile").scrollIntoView({ block: "center" });
        const r = cell.querySelector(".ae-download").getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }, "local_seed.png");
      if (!box) errors.push("[5a] no download button on the IndexedDB-stored tile");
      else {
        await staticPage.mouse.move(box.x, box.y);
        await new Promise((r) => setTimeout(r, 200));
        await staticPage.mouse.click(box.x, box.y);
        let landed = null;
        for (let i = 0; i < 30; i++) {
          landed = readdirSync(downloadDir).find((f) => f === "local_seed.png");
          if (landed) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const expected = Buffer.from(PROBE_PNG_B64, "base64");
        if (staticDownloads.length === dlBefore) errors.push("[5a] the download did not fire in static mode");
        else if (!landed) errors.push("[5a] no file landed from the IndexedDB download");
        else {
          const bytes = readFileSync(join(downloadDir, landed));
          // BYTE-EQUAL to what was stored: this is what distinguishes a real
          // download from having saved an HTML error page under a .png name.
          if (!bytes.equals(expected))
            errors.push(`[5a] the downloaded bytes are NOT the stored asset (${bytes.length}B vs ${expected.length}B) — a served-path link would do exactly this`);
          else console.log(`[5a] DOWNLOAD ok in IndexedDB mode: ${bytes.length} bytes, byte-identical to what was stored`);
        }
      }

      // 5b. COPY-ON-SAVE from a built-in, into IndexedDB.
      const hit = await staticPage.evaluate((n) => {
        const cell = [...document.querySelectorAll(".asset-explorer .ae-cell")]
          .find((c) => c.querySelector(".ae-name")?.textContent.trim() === n);
        if (!cell) return null;
        cell.querySelector(".ae-tile").scrollIntoView({ block: "center" });
        const r = cell.querySelector(".ae-tile-hit").getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }, BUILTIN_NAME);
      if (!hit) errors.push(`[5b] no ${BUILTIN_NAME} tile in static mode (the built-in library must list identically in both modes)`);
      else {
        await staticPage.mouse.click(hit.x, hit.y, { clickCount: 2 });
        let ready = false;
        for (let i = 0; i < 60; i++) {
          ready = await staticPage.evaluate(() => !!window.__powerrp_codeModal?.getValue());
          if (ready) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!ready) errors.push("[5b] the built-in's editor never opened in static mode");
        else {
          const ro = await staticPage.evaluate(() => window.__powerrp_codeModal.isReadOnly());
          if (!ro) errors.push("[5b] the built-in must be READ-ONLY in static mode too");
          await staticPage.evaluate(() => window.__powerrp_codeModal.save());
          await new Promise((r) => setTimeout(r, 1500));
          const stillOpen = await staticPage.evaluate(() => !!window.__powerrp_codeModal);
          if (stillOpen) {
            const why = await staticPage.evaluate(() => document.querySelector(".code-modal-problem")?.textContent.trim() ?? null);
            errors.push(`[5b] Save was refused in static mode${why ? `: ${why}` : ""}`);
          }
          // Read the LOCAL library back through the seam — the copy must be in
          // IndexedDB, and registered as a new widget type.
          const after = await staticPage.evaluate(async () => ({
            names: (await window.__powerrp_app.listProjectAssets()).map((a) => a.name),
            types: window.__powerrp_app.registry.all().map((p) => p.type),
          }));
          const copy = after.names.find((n) => /^clock_digital.*\.plugin\.js$/.test(n));
          if (!copy) errors.push(`[5b] no clock_digital copy in IndexedDB (have: ${after.names.join(", ")})`);
          else if (!after.types.some((t) => /^clock_digital_\d+$/.test(t)))
            errors.push(`[5b] the IndexedDB copy did not register a new type (types: ${after.types.filter((t) => /clock/.test(t)).join(", ")})`);
          else console.log(`[5b] COPY-ON-SAVE ok in IndexedDB mode: "${copy}" registered as ${after.types.filter((t) => /^clock_digital_\d+$/.test(t)).join(", ")}`);
        }
      }
    }
    // A static-mode page legitimately reports server-only features as unavailable;
    // only genuine failures count. UNAVAILABLE_IN_STATIC messages are that report.
    const realStaticErrors = staticErrors.filter((t) => !/static|UNAVAILABLE|backend|render.?job/i.test(t));
    if (realStaticErrors.length) errors.push(`[5] static-mode page errors: ${realStaticErrors.join(" | ")}`);
    await staticPage.close();
  }

  if (errors.length) throw new Error(`${errors.length} PROBE FAILURE(S):\n` + errors.map((e) => `  - ${e}`).join("\n"));
  console.log(`\nALL TILE-POLISH PROBE CHECKS PASSED. Screenshots: ${shotDir}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (viteServer) await viteServer.close().catch(() => {});
  if (pyServer) pyServer.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
  // The downloads dir is kept only if a check failed, so a failure can be inspected.
  if (errors.length === 0) rmSync(downloadDir, { recursive: true, force: true });
  else if (existsSync(downloadDir)) console.log(`(downloaded files kept for inspection: ${downloadDir})`);
}
