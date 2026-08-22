/**
 * PASTE PRECEDENCE PROBE — a SYSTEM-CLIPBOARD IMAGE vs. THE IN-APP ITEM CLIPBOARD.
 *
 * THE USER REPORT THIS EXISTS FOR (2026-08-21, verbatim): "why can't i copy and
 * paste images into birdseye anymore i have to drag + drop an external image. it
 * refuses to recognize when I have an image in my clipboard that's different from
 * the image copied from copying nodes."
 *
 * WHAT WAS ACTUALLY BROKEN. `app.#isForeignFilePaste` treated a bare `image/png`
 * on a paste event as AMBIGUOUS whenever the in-app clipboard held anything, and
 * resolved the ambiguity toward the element — on the stated theory that a user who
 * wants the screenshot "copies it AFTER the widget copy is stale, or pastes into a
 * slide where no internal copy exists". BOTH ESCAPE HATCHES ARE FICTIONAL: the
 * in-app clipboard is a localStorage mirror (`powerrp.clipboardMirror`) plus a
 * server session that are NEVER cleared and are not scoped to a slide. So the
 * FIRST widget copy a browser ever makes kills system-image paste permanently.
 *
 * THE AMBIGUITY IS NOT REAL ON A BROWSER THAT TAGS OUR COPIES. Every copy writes
 * POWERRP_CLIPBOARD_MIME beside the PNG in ONE ClipboardItem, and a screenshot
 * REPLACES the whole pasteboard — so an image arriving with no marker is proof the
 * clipboard is no longer the one we wrote. `web/clipboard.js osClipboardTagging`
 * is the capability check that says when that proof is available.
 *
 * THE THREE CASES, all against a LIVE app so the whole chain is in the picture:
 *   1. CONTROL — empty in-app clipboard, image pasted → an image widget. (This is
 *      what tests/paste_upload_probe.js already covers; repeated here so a red in
 *      case 2 cannot be blamed on the upload path.)
 *   2. THE BUG — copy a widget FIRST, then paste a DIFFERENT image with no marker
 *      → must insert the PASTED image, not a clone of the copied widget. The two
 *      outcomes are told apart by `src`, not by item count, because a clone and an
 *      upload both add exactly one widget.
 *   3. THE RULING THAT MUST NOT REGRESS (R3 #36 / d39e13f0) — copy a widget, then
 *      paste an image WITH the marker in `clipboardData.types` (what a real Ctrl+V
 *      of our own copy looks like) → the ELEMENT wins and nothing uploads.
 *
 * Isolation follows tests/paste_upload_probe.js exactly: an ephemeral project
 * server on a throwaway POWERRP_PROJECTS_DIR + an ephemeral Vite server + puppeteer.
 * No screenshots are taken, so a host whose Chrome capture path hangs still runs it.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/paste_screenshot_precedence_probe.js
 */

import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const UV = process.env.POWERRP_UV || "uv";

// How long the async upload+insert (or clone) is given to land, as polls x ms.
const SETTLE_POLLS = 60;
const SETTLE_MS = 200;

/** Query. Poll a URL until it answers 200 (or throw after `tries`). */
async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }
  throw new Error(`server never became ready at ${url}`);
}

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_paste_precedence_"));
const backendPort = await freePort();
const server = spawn(UV, ["run", "server.py", "serve", `--port=${backendPort}`], {
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
  await page.setViewport({ width: 1280, height: 800 });

  // EXPECTED headless noise (paste_upload_probe.js's precedent, same two causes):
  // no WebGPU adapter for the per-widget video overlay, and a headless Chromium
  // that DENIES the OS-clipboard image write. The second one matters here: it is
  // why case 3 has to state the marker on the synthetic event by hand rather than
  // round-tripping a real copy through the OS pasteboard.
  const EXPECTED_NOISE = [/VideoV7: WebGPU init failed/, /OS-clipboard image write was denied or failed/];
  const isExpectedNoise = (t) => EXPECTED_NOISE.some((re) => re.test(t));
  page.on("pageerror", (e) => { if (!isExpectedNoise(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => {
    if (m.type() === "error" && !isExpectedNoise(m.text())) errors.push(`console.error: ${m.text()}`);
    if (m.type() === "warning") console.log(`[page.warn] ${m.text()}`);
  });

  let uploadCount = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/upload/")) uploadCount++;
  });

  await page.goto(pageUrl, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 60000 });
  if (errors.length) throw new Error("PAGE ERRORS AT BOOT:\n" + errors.join("\n"));

  await page.evaluate(() => { window.__powerrp_app.doc.meta.name = "paste_precedence_probe"; });

  // One PNG per case, distinguishable by FILENAME — `src` is what tells a pasted
  // image apart from a clone of an earlier one, and item count cannot.
  const RED_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";

  /** Command (in-page). Dispatch a native `paste` carrying one image File, and
   *  optionally the ownership marker in `clipboardData.types`. */
  const pasteImage = (name, withMarker) => page.evaluate(({ name, withMarker, b64 }) => {
    const MARKER = "web application/x-powerrp-item"; // POWERRP_CLIPBOARD_MIME
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: "image/png" }));
    if (withMarker) dt.setData(MARKER, "1"); // what a real Ctrl+V of OUR copy carries
    const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    const defaultPrevented = !window.dispatchEvent(evt);
    return { defaultPrevented, types: [...dt.types] };
  }, { name, withMarker, b64: RED_1PX });

  /** Query (in-page). Every item's {type, src} on slide 0, primitives only —
   *  Svelte 5 $state proxies do not survive puppeteer's structured clone. */
  const itemsNow = () => page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).map((id) => ({ type: items[id].type, src: items[id].src ?? null }));
  });

  /** Query. Wait until the item count grows past `from`, then report the items. */
  async function settled(from) {
    for (let i = 0; i < SETTLE_POLLS; i++) {
      const items = await itemsNow();
      if (items.length > from) return items;
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    }
    return await itemsNow();
  }

  const srcCount = (items, needle) => items.filter((it) => it.src?.includes(needle)).length;

  // ── CASE 1: CONTROL — nothing in the in-app clipboard, an image pastes ──────
  const before1 = (await itemsNow()).length;
  const r1 = await pasteImage("probe_control.png", false);
  if (!r1.defaultPrevented) errors.push("case 1: onPaste did not preventDefault() — the paste never reached the app");
  const after1 = await settled(before1);
  if (srcCount(after1, "probe_control") !== 1)
    errors.push(`case 1 (CONTROL, empty in-app clipboard): the pasted image did not become a widget — items now ${JSON.stringify(after1)}`);
  else console.log("case 1 ok: an image pastes as a widget when nothing has been copied in-app");

  // ── CASE 2: THE REPORTED BUG — copy a widget FIRST, then paste a DIFFERENT
  //    image with NO marker. A clone and an upload both add one item, so the
  //    assertion is on `src`.
  await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    app.selection = Object.keys(items).find((id) => items[id].type === "image");
    await app.copySelection(); // in-app clipboard + localStorage mirror now live
  });
  const uploadsBefore2 = uploadCount;
  const before2 = (await itemsNow()).length;
  const r2 = await pasteImage("probe_screenshot.png", false);
  if (!r2.defaultPrevented) errors.push("case 2: onPaste did not preventDefault()");
  const after2 = await settled(before2);
  if (srcCount(after2, "probe_screenshot") !== 1)
    errors.push(
      "case 2 (THE REPORTED BUG): with a widget on the in-app clipboard, a system-clipboard image " +
      "pasted with NO ownership marker did not become a widget — it was shadowed by the in-app copy. " +
      `uploads fired: ${uploadCount - uploadsBefore2}; items now ${JSON.stringify(after2)}\n` +
      "    THE FIX, if this red is what you are looking at: web/app.svelte.js #isForeignFilePaste must\n" +
      "    read the rule from web/clipboard.js — `return foreignImagePaste(files, types, osClipboardTagging())`,\n" +
      "    logging `untaggedCopyNotice(...)` first. That module was written with this probe; the call\n" +
      "    site was left to its owner. See concerns.md, 2026-08-21.");
  else console.log("case 2 ok: an untagged system image beats a stale in-app copy");

  // ── CASE 3: THE STANDING RULING (R3 #36 / d39e13f0) — the marker is present,
  //    so this IS our own copy coming back; the ELEMENT must win and nothing may
  //    upload, or a copied widget flattens into a bitmap again.
  await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    app.selection = Object.keys(items).find((id) => items[id].src?.includes("probe_control"));
    await app.copySelection();
  });
  const uploadsBefore3 = uploadCount;
  const before3 = (await itemsNow()).length;
  const r3 = await pasteImage("probe_should_be_ignored.png", true);
  if (!r3.types.includes("web application/x-powerrp-item"))
    errors.push(`case 3: the synthetic event lost the marker — types were ${JSON.stringify(r3.types)}`);
  const after3 = await settled(before3);
  if (srcCount(after3, "probe_should_be_ignored") > 0)
    errors.push("case 3 (R3 #36 REGRESSION): a paste carrying OUR OWN ownership marker uploaded the image instead of pasting the element");
  else if (after3.length !== before3 + 1)
    errors.push(`case 3: the marked paste did not clone the copied element (items ${before3} -> ${after3.length}) — ${JSON.stringify(after3)}`);
  else if (uploadCount > uploadsBefore3)
    errors.push(`case 3: a marked paste fired ${uploadCount - uploadsBefore3} upload(s) — the element path must not upload`);
  else console.log("case 3 ok: a paste carrying our marker still pastes the ELEMENT and uploads nothing");

  if (errors.length) throw new Error("PROBE FAILURES:\n" + errors.join("\n"));
  console.log("\nPASTE PRECEDENCE PROBE OK");
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
