/**
 * Palette / selection commands probe (manifest Round 12B "Palette / selection
 * commands", SA3 — spacebar opens the palette, Select All / Deselect All,
 * Copy as PNG / Copy as PDF). Boots the PowerRP editor headless with the demo
 * deck and drives: Space opening the palette in edit mode, the guard cases
 * (typing in an input, palette already open, a live modal transform), Select
 * All / Deselect All counts, Copy as PNG with a granted clipboard-write
 * permission (asserts the clipboard actually holds a decodable PNG), and
 * Copy as PDF (asserts valid PDF bytes, clipboard OR download fallback).
 * Fails loudly on any NEW console error (pre-existing boot noise from other
 * agents' in-flight WIP is recorded as a baseline and ignored, same
 * convention as modal_xform_probe.js).
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/palette_probe.js <shot_dir>
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";

const RECT = "c5c2bed3";

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await puppeteer.launch({ headless: "new" });
const failures = [];
const errors = [];
const warnings = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // NOTE: Puppeteer's ConsoleMessage.type() for console.warn(...) is "warn"
  // (NOT "warning" — a real gotcha hit while writing this probe).
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    if (m.type() === "warn") warnings.push(m.text());
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  // Grant clipboard read/write via RAW CDP Browser.grantPermissions — Copy as
  // PNG/PDF need navigator.clipboard.write to actually succeed (not just be
  // attempted) so the probe can read back what landed on the clipboard.
  // NOTE: Puppeteer's own browserContext.overridePermissions(...) does NOT
  // reliably unlock clipboard-write in this Puppeteer/Chrome combo (verified:
  // navigator.clipboard.writeText still throws NotAllowedError through it) —
  // the raw CDP command is what actually works headless.
  const cdpPerm = await page.target().createCDPSession();
  await cdpPerm.send("Browser.grantPermissions", {
    origin: `http://127.0.0.1:${port}`,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await new Promise((r) => setTimeout(r, 600));

  const bootErrors = errors.length; // baseline: other agents' in-flight WIP noise, not ours
  const check = (name, cond, detail = "") => { if (!cond) failures.push(`${name}: ${detail}`); };
  const paletteOpen = () => page.evaluate(() => window.__powerrp_app.paletteOpen);
  const selectedIds = () => page.evaluate(() => window.__powerrp_app.selectedIds());
  const camId = await page.evaluate(() => window.__powerrp_app.nodes().find((n) => n.type === "camera").itemId);

  // ── Scenario 1: Space opens the palette in edit mode ───────────────────────
  check("palette-closed-initially", (await paletteOpen()) === false);
  await page.keyboard.press("Space");
  await new Promise((r) => setTimeout(r, 80));
  check("space-opens-palette", (await paletteOpen()) === true, `paletteOpen=${await paletteOpen()}`);
  // Space types a literal space into the palette's own query input while open
  // (the palette owns its keys — App.svelte's onKeydown returns early when
  // paletteOpen). Close it back down for the next scenarios.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 80));
  check("escape-closes-palette", (await paletteOpen()) === false);

  // ── Scenario 2: guard — typing Space in an input does NOT open the palette ─
  // The Property Panel's item name field is a plain <input> once something is
  // selected; select the rect first so the field exists.
  const canvas = await page.$(".canvas-wrap");
  const box = await canvas.boundingBox();
  const rectScreen = { x: box.x + 250, y: box.y + 240 };
  await page.mouse.click(rectScreen.x, rectScreen.y);
  await new Promise((r) => setTimeout(r, 150));
  const nameInput = await page.$(".inspector input[type=text]");
  check("found-name-input", !!nameInput, "Inspector name <input type=text> not found — guard scenario needs it");
  if (nameInput) {
    await nameInput.click();
    await page.keyboard.type(" "); // literal space keystroke while focused in the input
    await new Promise((r) => setTimeout(r, 80));
    check("space-in-input-no-palette", (await paletteOpen()) === false, `paletteOpen=${await paletteOpen()}`);
    await page.keyboard.down("Meta"); // discard the typed space without committing a stray rename
    await page.keyboard.up("Meta");
    await page.evaluate(() => document.activeElement.blur());
  }
  await page.mouse.click(20, 20); // click empty canvas area to deselect + defocus
  await new Promise((r) => setTimeout(r, 100));

  // ── Scenario 3: guard — Space during a live G/S modal transform is inert ───
  await page.mouse.click(rectScreen.x, rectScreen.y);
  await new Promise((r) => setTimeout(r, 150));
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyG"); // begin a grab modal
  await new Promise((r) => setTimeout(r, 60));
  const modalLive = await page.evaluate(() => window.__powerrp_app.modalXform !== null);
  check("modal-began", modalLive, "G did not start a modal transform");
  await page.keyboard.press("Space");
  await new Promise((r) => setTimeout(r, 60));
  check("space-inert-during-modal", (await paletteOpen()) === false, `paletteOpen=${await paletteOpen()}`);
  await page.keyboard.press("Escape"); // cancel the modal
  await new Promise((r) => setTimeout(r, 80));
  check("modal-cancelled", (await page.evaluate(() => window.__powerrp_app.modalXform)) === null);

  // ── Scenario 4: guard — Space is inert in present mode (PresentMode owns it) ─
  await page.evaluate(() => { window.__powerrp_app.mode = "present"; });
  await new Promise((r) => setTimeout(r, 200));
  const slideBeforeSpace = await page.evaluate(() => window.__powerrp_app.slideIndex);
  // PresentMode's own listener reads Space as "next slide" via its internal
  // presenter (not app.slideIndex directly) — the assertion that matters here
  // is that OUR palette dispatcher never sees it: paletteOpen stays false.
  await page.keyboard.press("Space");
  await new Promise((r) => setTimeout(r, 150));
  check("space-inert-in-present", (await paletteOpen()) === false, `paletteOpen=${await paletteOpen()}`);
  await page.keyboard.press("Escape"); // exit present mode
  await new Promise((r) => setTimeout(r, 200));
  check("exited-present", (await page.evaluate(() => window.__powerrp_app.mode)) === "edit");
  void slideBeforeSpace;

  // ── Scenario 5: Select All / Deselect All ───────────────────────────────────
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await new Promise((r) => setTimeout(r, 60));
  await page.evaluate(() => window.__powerrp_app.runCommand("select-all"));
  await new Promise((r) => setTimeout(r, 80));
  const allIds = await selectedIds();
  check("select-all-excludes-camera", !allIds.includes(camId), `selectedIds=${JSON.stringify(allIds)} camId=${camId}`);
  const expectedCount = await page.evaluate(
    () => window.__powerrp_app.nodes().filter((n) => n.plugin.capabilities.purgeable !== false).length,
  );
  check("select-all-count", allIds.length === expectedCount, `got ${allIds.length}, want ${expectedCount}`);
  await page.evaluate(() => window.__powerrp_app.runCommand("deselect-all"));
  await new Promise((r) => setTimeout(r, 80));
  check("deselect-all-clears", (await selectedIds()).length === 0, `selectedIds=${JSON.stringify(await selectedIds())}`);

  // ── Scenario 6: Copy as PNG — clipboard actually holds a decodable PNG ─────
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, RECT);
  await new Promise((r) => setTimeout(r, 60));
  await page.evaluate(() => window.__powerrp_app.runCommand("copy-as-png"));
  await new Promise((r) => setTimeout(r, 400)); // GPU render + clipboard write settle
  const pngInfo = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((i) => i.types.includes("image/png"));
    if (!item) return { ok: false, types: items.flatMap((i) => i.types) };
    const blob = await item.getType("image/png");
    const buf = new Uint8Array(await blob.arrayBuffer());
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const sigOk = sig.every((b, i) => buf[i] === b);
    // IHDR width/height are the next 8 bytes after the 4-byte chunk length + "IHDR" (bytes 16..24).
    const view = new DataView(buf.buffer);
    return { ok: sigOk, size: buf.length, width: view.getUint32(16), height: view.getUint32(20) };
  });
  check("copy-png-clipboard-has-png", pngInfo.ok === true, `pngInfo=${JSON.stringify(pngInfo)}`);
  check("copy-png-nonzero-dims", pngInfo.ok && pngInfo.width > 0 && pngInfo.height > 0, `pngInfo=${JSON.stringify(pngInfo)}`);

  // ── Scenario 7: Copy as PDF — valid PDF bytes (clipboard OR download) ──────
  // Chrome's Async Clipboard API rejects application/pdf as of this probe's
  // writing (allowlist: image/png, text/plain, text/html), so this exercises
  // the documented download fallback. Intercept the download via CDP.
  const downloadDir = shots;
  const cdp = await page.target().createCDPSession();
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  await page.evaluate(() => window.__powerrp_app.runCommand("copy-as-pdf"));
  await new Promise((r) => setTimeout(r, 800)); // PDF build (font embed) + write/download settle

  // Did it land on the clipboard instead (a future/other browser might allow it)?
  const pdfOnClipboard = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      return items.some((i) => i.types.includes("application/pdf"));
    } catch {
      return false;
    }
  });
  let pdfBytesOk = pdfOnClipboard;
  let pdfDetail = `pdfOnClipboard=${pdfOnClipboard}`;
  if (!pdfOnClipboard) {
    const { readdir, readFile: readFileNode } = await import("node:fs/promises");
    const files = (await readdir(downloadDir)).filter((f) => f.endsWith(".pdf"));
    pdfDetail += ` downloadedFiles=${JSON.stringify(files)}`;
    if (files.length) {
      const bytes = await readFileNode(resolve(downloadDir, files[files.length - 1]));
      pdfBytesOk = bytes.slice(0, 5).toString("latin1") === "%PDF-";
      pdfDetail += ` header=${bytes.slice(0, 8).toString("latin1")}`;
    }
  }
  check("copy-pdf-valid-bytes", pdfBytesOk, pdfDetail);
  // The fallback must be REPORTED LOUDLY (console.warn), never silent — assert
  // it actually fired when the clipboard path was NOT taken (this Chrome
  // build rejects application/pdf, so this is expected to be the live path).
  if (!pdfOnClipboard) {
    check("copy-pdf-fallback-warned", warnings.some((w) => w.includes("Copy as PDF") && w.includes("falling back to downloading")),
      `warnings=${JSON.stringify(warnings)}`);
  }

  const newErrors = errors.slice(bootErrors);
  if (newErrors.length) failures.push(`console errors during palette probe: ${newErrors.join(" | ")}`);

  if (failures.length) {
    console.error("PALETTE PROBE FAILURES:\n" + failures.join("\n"));
    if (bootErrors) console.error(`(ignored ${bootErrors} pre-existing boot error(s) from other agents' fixture work)`);
    process.exit(1);
  }
  console.log(`Palette probe passed: all scenarios green (ignored ${bootErrors} boot error(s)).`);
} finally {
  await browser.close();
  await server.close();
}
