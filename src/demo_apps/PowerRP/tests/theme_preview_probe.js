/**
 * COMMAND-PALETTE LIVE-PREVIEW PROBE — proves the general previewable-command
 * protocol (CommandPalette.svelte) through its first adopter, the theme
 * entries. Drives the REAL palette DOM (not app methods) so the mechanism under
 * test — the $effect that previews the HIGHLIGHTED entry (hover OR arrow),
 * reverts when focus moves off / the palette closes without selecting, and
 * commits on Enter/click — is exercised end to end.
 *
 * Asserts the APPLIED theme (documentElement[data-theme] + app.theme) changes
 * live on hover/arrow-focus, reverts to the previously-applied theme on move-
 * off / close, and commits (and PERSISTS to localStorage) on select — while a
 * mere preview never touches localStorage.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), same pattern
 * as text_undo_probe.js. Run from POWERRP or the SvelteLib root (cwd-independent).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Ignore backend-absent noise: this probe self-spins a FRONTEND-ONLY Vite (no
  // server.py), so best-effort thumbnail-persist POSTs 404. Orthogonal to themes.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  await page.waitForFunction(() => window.__powerrp_app != null, { timeout: 10000 });
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Reads of the APPLIED theme state and the PERSISTED preference.
  const applied = () => page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    field: window.__powerrp_app.theme,
    stored: localStorage.getItem("powerrp.theme"),
  }));

  // Deterministic start: commit graphite as the persisted preference.
  await page.evaluate(() => window.__powerrp_app.setTheme("graphite"));
  const ORIGINAL = "graphite";
  assert((await applied()).stored === ORIGINAL, `start committed to "${ORIGINAL}"`);

  // Palette input driver. Opening sets paletteOpen; the component's $effect
  // focuses the input once it renders — poll for it, then type.
  const openPalette = async () => {
    await page.evaluate(() => (window.__powerrp_app.paletteOpen = true));
    await page.waitForSelector(".palette input", { timeout: 4000 });
    await sleep(120);
  };
  const typeQuery = async (text) => { await page.type(".palette input", text); await sleep(140); };
  const clearQuery = async () => {
    // Select-all + delete inside the palette input, then let the effect settle.
    await page.evaluate(() => { const el = document.querySelector(".palette input"); el.focus(); el.select(); });
    await page.keyboard.press("Backspace");
    await sleep(140);
  };
  const pressKey = async (key) => { await page.keyboard.press(key); await sleep(140); };
  // Drill from the top level into the "Color Theme" submenu.
  const enterThemeSubmenu = async () => { await typeQuery("color theme"); await pressKey("Enter"); await sleep(140); };

  // ── 1. ARROW-FOCUS previews LIVE (typing filters to one row → row 0 is the
  //      arrow/keyboard-focused entry → the effect previews it). ──────────────
  await openPalette();
  await enterThemeSubmenu();
  await typeQuery("synthwave");
  let s = await applied();
  assert(s.attr === "synthwave" && s.field === "synthwave", `arrow-focus previews LIVE (attr=${s.attr}, field=${s.field})`);
  assert(s.stored === ORIGINAL, `preview does NOT persist (localStorage still "${s.stored}")`);

  // ── 2. Focus moves OFF (Escape backs out of the submenu to the top level,
  //      highlighting a non-previewable command) → revert to the original. ────
  await pressKey("Escape");
  s = await applied();
  assert(s.attr === ORIGINAL && s.field === ORIGINAL, `focus-off reverts to "${ORIGINAL}" (attr=${s.attr})`);

  // ── 3. Preview a theme, then CLOSE WITHOUT SELECTING (backdrop) → revert. ───
  await enterThemeSubmenu();
  await typeQuery("dracula");
  s = await applied();
  assert(s.attr === "dracula", `re-preview LIVE (attr=${s.attr})`);
  await page.evaluate(() => (window.__powerrp_app.paletteOpen = false)); // backdrop-equivalent close
  await sleep(160);
  s = await applied();
  assert(s.attr === ORIGINAL && s.stored === ORIGINAL, `close-without-select reverts to "${ORIGINAL}" (attr=${s.attr}, stored=${s.stored})`);

  // ── 4. HOVER (pointermove) previews, and moving to another row switches. ────
  await openPalette();
  await enterThemeSubmenu(); // empty query → every theme listed
  const rowIndex = async (title) => page.$$eval(".palette-item .title", (els, t) => els.findIndex((e) => e.textContent.trim() === t), title);
  const hoverRow = async (title) => {
    const i = await rowIndex(title);
    if (i < 0) throw new Error(`theme row "${title}" not found in submenu`);
    const rows = await page.$$(".palette-item");
    await rows[i].hover();
    await sleep(140);
  };
  await hoverRow("Monokai");
  s = await applied();
  assert(s.attr === "monokai", `HOVER previews LIVE (attr=${s.attr})`);
  await hoverRow("Tokyo Night");
  s = await applied();
  assert(s.attr === "tokyonight", `hovering another row switches preview (attr=${s.attr})`);
  assert(s.stored === ORIGINAL, `hover previews still do NOT persist (stored=${s.stored})`);

  // ── 5. SELECT commits: click the hovered row → change stays AND persists. ───
  const catppuccinRow = await (async () => { const i = await rowIndex("Catppuccin Mocha"); return (await page.$$(".palette-item"))[i]; })();
  await catppuccinRow.hover();
  await sleep(120);
  await catppuccinRow.click();
  await sleep(180);
  s = await applied();
  const closed = await page.evaluate(() => window.__powerrp_app.paletteOpen);
  assert(!closed, "palette closed after select");
  assert(s.attr === "catppuccin" && s.field === "catppuccin", `select COMMITS the applied theme (attr=${s.attr})`);
  assert(s.stored === "catppuccin", `commit PERSISTS to localStorage (stored=${s.stored})`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error(`\nTHEME PREVIEW PROBE FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log("\nTHEME PREVIEW PROBE PASSED — hover/arrow previews live, move-off & close revert, select commits + persists.");
} finally {
  await browser.close();
  await server.close();
}
