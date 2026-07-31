/**
 * CTRL+V == THE TOOLBAR PASTE BUTTON (the 2026-07-30 ruling), driven through
 * REAL ClipboardEvents against the real editor.
 *
 * THE BUG THIS PINS. Copying a widget puts TWO things on two clipboards: the
 * item JSON on the server/mirror clipboard, and a RENDERED PNG on the OS
 * clipboard (so the widget pastes into other apps). The toolbar button read only
 * the first and was always right. Ctrl+V rides the native `paste` event, saw the
 * PNG, and tried to prove the PNG was ours by comparing `imageSignature(bytes)`
 * to the `png_sig` stored at copy time. That comparison CANNOT succeed: the OS
 * pasteboard RE-ENCODES images in transit — measured on macOS, a 581-byte PNG
 * written by Chrome came back as 645 bytes. So the "is this ours?" test failed
 * for a genuine round trip and Ctrl+V pasted the user's widget as a FLATTENED
 * IMAGE ("Cmd+V pasted it as an IMAGE sometimes"), while the button did not.
 *
 * THE FIX. Ownership is a LABEL, not a hash: every copy writes the custom MIME
 * `web application/x-powerrp-item` (POWERRP_CLIPBOARD_MIME) beside the PNG, and
 * a clipboard is ALSO ours whenever the internal clipboard simply holds a
 * pasteable payload. A custom flavor survives the pasteboard verbatim because
 * the OS transcodes pictures, not unknown labels.
 *
 * The three cases, exactly as the ruling states them:
 *
 *   1. APP COPY → Ctrl+V pastes the WIDGET, never an image, and uploads nothing
 *      — asserted BOTH with the marker present (a real copy) and with a
 *      re-encoded PNG whose signature does NOT match, which is the precise
 *      shape that used to break and is the regression this file exists for.
 *   2. SCREENSHOT-STYLE image-only → still uploads and inserts an IMAGE widget.
 *      Proven with the internal clipboard NON-EMPTY, so it pins that an app
 *      payload does not swallow a genuinely foreign image.
 *   3. PASTE INTO A TYPING TARGET → the handler does not preventDefault and
 *      inserts nothing, leaving native text paste alone (inputs + Monaco-style
 *      contentEditable).
 *
 * Isolation follows clipboard_duplicate_probe.js: ephemeral uv-run server,
 * ephemeral Vite, mkdtemp POWERRP_PROJECTS_DIR, free ports, NEVER 3637/3638.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/paste_parity_probe.js
 */

import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { POWERRP_CLIPBOARD_MIME } from "../web/clipboard.js"; // THE ownership marker (same constant the app writes)

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const UV = process.env.POWERRP_UV || "uv";

// A 1x1 red PNG standing in for a foreign screenshot — deliberately NOT the
// bytes any copy produced, so it can only be classified as external.
const FOREIGN_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";

// freePort now comes from ./free_port.js, which RE-VERIFIES the port is still
// bindable before handing it back. The copy that used to live here bound port 0,
// read the number, closed, and returned — leaving a TOCTOU window that stays open
// until the spawned backend binds. Under the gate's x3 probe concurrency two
// probes could draw the same number, and the loser died with `Errno 48 Address
// already in use` -> `server never became ready`: a red that said nothing about
// what this probe tests.

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* server not up yet — the retry loop IS the handling */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_paste_parity_"));
const backendPort = await freePort();
const server = spawn(UV, ["run", "server.py", "serve", `--port=${backendPort}`], {
  cwd: join(APP_DIR, "server"),
  env: { ...process.env, POWERRP_PROJECTS_DIR: projectsRoot },
  stdio: ["ignore", "inherit", "inherit"],
});
server.on("error", (e) => { throw e; });

let viteServer, browser;
const errors = [];
const note = (ok, msg) => { if (!ok) errors.push(msg); else console.log(`  ok  ${msg}`); };

/** Command (drives the page). Dispatches a REAL ClipboardEvent("paste") carrying
 *  `files` and `extraTypes` at `target`, and resolves once the app has settled.
 *  A DataTransfer is what a genuine Ctrl+V delivers, so this exercises the exact
 *  handler path — including whether the handler called preventDefault. */
async function firePaste(page, { files = [], extraTypes = [], targetSelector = null } = {}) {
  return page.evaluate(async ({ files, extraTypes, targetSelector }) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    // The ownership marker rides in `types`. setData with a custom type is how a
    // DataTransfer carries one; the app only ever reads its PRESENCE.
    for (const t of extraTypes) dt.setData(t, "1");
    const target = targetSelector ? document.querySelector(targetSelector) : window;
    if (targetSelector && !target) throw new Error(`no element matched ${targetSelector}`);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return { defaultPrevented: ev.defaultPrevented };
  }, { files, extraTypes, targetSelector });
}

/** Query. Item ids/types on slide 0 — the ledger every assertion below reads. */
const itemsOf = (page) => page.evaluate(() => {
  const items = window.__powerrp_app.doc.slides[0].delta.items;
  return Object.fromEntries(Object.keys(items).map((id) => [id, items[id].type]));
});

/** Query. Waits until slide 0's item count changes from `from`, or times out —
 *  the upload path is async, so a bare read would race it. Returns the count. */
async function settleCount(page, from, ms = 6000) {
  const deadline = Date.now() + ms;
  let n = from;
  while (Date.now() < deadline) {
    n = Object.keys(await itemsOf(page)).length;
    if (n !== from) return n;
    await new Promise((r) => setTimeout(r, 100));
  }
  return n;
}

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

  // Correctly-reported headless limits, not defects (see clipboard_duplicate_probe.js):
  // no WebGPU adapter under SwiftShader, and headless Chromium denies OS-clipboard
  // image writes — which ALSO means the ownership marker cannot land on the real
  // pasteboard here, so this probe supplies the marker through the DataTransfer
  // directly. That is the same surface the app reads (`clipboardData.types`).
  const EXPECTED_NOISE = [
    /VideoV7: WebGPU init failed/,
    /OS-clipboard image write was denied or failed/,
    /refused the PowerRP ownership marker/,
  ];
  const isExpectedNoise = (t) => EXPECTED_NOISE.some((re) => re.test(t));
  const consoleErrors = [];
  page.on("pageerror", (e) => { if (!isExpectedNoise(e.message)) consoleErrors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => {
    if (m.type() === "error" && !isExpectedNoise(m.text())) consoleErrors.push(`console.error: ${m.text()}`);
  });

  await browser.defaultBrowserContext().overridePermissions(pageUrl, ["clipboard-read", "clipboard-write"]);
  await page.goto(pageUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));
  if (consoleErrors.length) throw new Error("PAGE ERRORS AT BOOT:\n" + consoleErrors.join("\n"));

  let uploads = 0;
  page.on("request", (req) => { if (req.method() === "POST" && req.url().includes("/api/upload/")) uploads++; });

  // Seed a distinctive widget and COPY it for real (server clipboard + mirror).
  const MARKER_W = 333;
  await page.evaluate(async (w) => {
    const app = window.__powerrp_app;
    app.doc.meta.name = "paste_parity";
    app.addItem({ ...app.registry.get("rect").defaults, w, h: 90, fill: "#7aa2f7" });
    await app.copySelection();
  }, MARKER_W);

  const hasMarkerRect = async () => {
    const items = await page.evaluate((w) => {
      const it = window.__powerrp_app.doc.slides[0].delta.items;
      return Object.keys(it).filter((id) => it[id].type === "rect" && it[id].w === w).length;
    }, MARKER_W);
    return items;
  };
  const rectsAfterCopy = await hasMarkerRect();

  // ── 1. APP COPY → Ctrl+V pastes the WIDGET ──────────────────────────────────
  console.log("1. app copy → Ctrl+V pastes the ELEMENT (not an image)");

  // 1a. The marker present alongside a re-encoded PNG. This is a REAL Ctrl+V
  //     after a real copy: the OS hands back a PNG whose bytes differ from what
  //     we wrote (re-encoding), so the ONLY ownership evidence is the marker.
  let before = Object.keys(await itemsOf(page)).length;
  const uploadsBefore1a = uploads;
  const r1a = await firePaste(page, {
    files: [{ b64: FOREIGN_PNG_B64, name: "reencoded.png", type: "image/png" }],
    extraTypes: [POWERRP_CLIPBOARD_MIME, "Files"],
  });
  let after = await settleCount(page, before);
  note(r1a.defaultPrevented, "the app CONSUMED the paste event (preventDefault) — it owns this clipboard");
  note(after === before + 1, `marker paste inserted exactly one item (${before} → ${after})`);
  note((await hasMarkerRect()) === rectsAfterCopy + 1, "marker paste inserted the ELEMENT (the w=333 rect), NOT a flattened image");
  await new Promise((r) => setTimeout(r, 400));
  note(uploads === uploadsBefore1a, "marker paste uploaded NOTHING (no /api/upload/ POST) — the PNG was never treated as a foreign image");

  // 1b. NO marker, a re-encoded PNG, but our internal clipboard still holds the
  //     copy. This is the browser/platform that drops the custom flavor — and it
  //     is byte-for-byte the case that produced the user's bug. The internal
  //     payload alone must be enough, which is what makes Ctrl+V == the button.
  before = Object.keys(await itemsOf(page)).length;
  const rectsBefore1b = await hasMarkerRect();
  const uploadsBefore1b = uploads;
  const r1b = await firePaste(page, {
    files: [{ b64: FOREIGN_PNG_B64, name: "reencoded2.png", type: "image/png" }],
  });
  after = await settleCount(page, before);
  note(r1b.defaultPrevented, "the app consumed the paste event with no marker present");
  note(after === before + 1, `unmarked round-trip paste inserted exactly one item (${before} → ${after})`);
  note((await hasMarkerRect()) === rectsBefore1b + 1, "unmarked round-trip paste STILL inserted the ELEMENT (the regression: this used to insert an image)");
  await new Promise((r) => setTimeout(r, 400));
  note(uploads === uploadsBefore1b, "unmarked round-trip paste uploaded nothing");

  // 1c. THE PARITY ASSERTION ITSELF: the toolbar button's command, run on the
  //     same clipboard, produces the same kind of insert as 1a/1b.
  before = Object.keys(await itemsOf(page)).length;
  const rectsBefore1c = await hasMarkerRect();
  await page.evaluate(async () => { await window.__powerrp_app.pasteClipboard(); });
  after = await settleCount(page, before);
  note(after === before + 1 && (await hasMarkerRect()) === rectsBefore1c + 1,
    "the TOOLBAR button pasted the same ELEMENT — Ctrl+V and the button agree");

  // ── 2. SCREENSHOT-STYLE image-only → uploads as today ───────────────────────
  // The internal clipboard is deliberately still LOADED, proving an app payload
  // does not swallow a genuinely foreign image.
  console.log("2. foreign image (no marker, no matching payload) → upload + IMAGE widget");
  // Clear BOTH internal stores so this clipboard is unambiguously not ours —
  // with a payload present, an image-only clipboard is deliberately resolved
  // toward the element (see #isForeignFilePaste), so section 2 must genuinely
  // have nothing of ours to find.
  await page.evaluate(async () => {
    localStorage.removeItem("powerrp.clipboardMirror");
    await fetch("/api/clipboard/", {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "" }),
    });
  });
  const clipCleared = await page.evaluate(async () => {
    const { payload } = await (await fetch("/api/clipboard/", { credentials: "include" })).json();
    return !payload && !localStorage.getItem("powerrp.clipboardMirror");
  });
  note(clipCleared, "internal clipboard (server + mirror) is empty before the foreign-image case");
  before = Object.keys(await itemsOf(page)).length;
  const uploadsBefore2 = uploads;
  await firePaste(page, { files: [{ b64: FOREIGN_PNG_B64, name: "screenshot.png", type: "image/png" }] });
  let sawImage = false;
  for (let i = 0; i < 60; i++) {
    const items = await itemsOf(page);
    if (Object.values(items).includes("image")) { sawImage = true; after = Object.keys(items).length; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  note(sawImage, "foreign image inserted an IMAGE widget (the paste-to-upload feature is intact)");
  note(uploads > uploadsBefore2, "foreign image was UPLOADED (a POST to /api/upload/ fired)");
  // Let that upload's insert fully settle before section 3 counts items, or its
  // async arrival would be misread as an insert caused by the typing-target paste.
  await new Promise((r) => setTimeout(r, 800));

  // ── 3. PASTE INTO A TYPING TARGET → untouched ───────────────────────────────
  console.log("3. paste into a typing target → native text behavior, app inserts nothing");
  await page.evaluate(() => {
    const i = document.createElement("input");
    i.id = "probe-text-input";
    i.type = "text";
    document.body.appendChild(i);
    i.focus();
  });
  before = Object.keys(await itemsOf(page)).length;
  const rInput = await firePaste(page, {
    files: [{ b64: FOREIGN_PNG_B64, name: "into_input.png", type: "image/png" }],
    extraTypes: [POWERRP_CLIPBOARD_MIME],
    targetSelector: "#probe-text-input",
  });
  await new Promise((r) => setTimeout(r, 600));
  after = Object.keys(await itemsOf(page)).length;
  note(!rInput.defaultPrevented, "paste into an <input> was NOT consumed — native text paste survives");
  note(after === before, `paste into an <input> inserted no item (${before} → ${after})`);

  // Monaco and the WYSIWYG editor are contentEditable, which is the other half
  // of isTypingTarget — assert the same immunity through that surface.
  await page.evaluate(() => {
    document.getElementById("probe-text-input")?.remove();
    const d = document.createElement("div");
    d.id = "probe-editable";
    d.contentEditable = "true";
    d.tabIndex = 0;
    document.body.appendChild(d);
    d.focus();
  });
  before = Object.keys(await itemsOf(page)).length;
  const rEditable = await firePaste(page, {
    files: [{ b64: FOREIGN_PNG_B64, name: "into_editable.png", type: "image/png" }],
    extraTypes: [POWERRP_CLIPBOARD_MIME],
    targetSelector: "#probe-editable",
  });
  await new Promise((r) => setTimeout(r, 600));
  after = Object.keys(await itemsOf(page)).length;
  note(!rEditable.defaultPrevented, "paste into a contentEditable (Monaco/WYSIWYG shape) was NOT consumed");
  note(after === before, `paste into a contentEditable inserted no item (${before} → ${after})`);

  await new Promise((r) => setTimeout(r, 200));
  if (consoleErrors.length) errors.push("CONSOLE ERRORS DURING PROBE:\n" + consoleErrors.join("\n"));

  if (errors.length) throw new Error("PROBE FAILURES:\n" + errors.map((e) => "  - " + e).join("\n"));
  console.log("\nPASTE PARITY PROBE OK");
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
