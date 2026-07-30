/**
 * Canvas-clipboard + Duplicate (14.9) + Shadow-gate (14.8) live probe.
 *
 * Drives the REAL editor (ephemeral uv-run python server + ephemeral Vite +
 * puppeteer, the paste_upload_probe.js isolation pattern: mkdtemp
 * POWERRP_PROJECTS_DIR, free ports, NEVER 3637/3638) and asserts the clipboard
 * behaviors end to end:
 *
 *  A. SERVER-CLIPBOARD COPY→PASTE. Copy a FILMSTRIP item built from the manifest
 *     payload shape (18 frameUrls leaf array, nested shadow object, equation-
 *     valued rotationAnchor). copySelection() lands the item JSON on the
 *     server-side session clipboard (GET /api/clipboard/ returns it). A Cmd+V
 *     paste inserts a NEW item (new id, offset) whose frameUrls/shadow/
 *     rotationAnchor survived the round-trip verbatim.
 *
 *  A'. PERMISSION-DENIED PATH. Re-run the paste with OS-clipboard permission
 *     DENIED: the item paste STILL works, because paste reads the SERVER
 *     clipboard, not the OS clipboard.
 *
 *  B. 14.9 DUPLICATE. duplicateSelection() clones the selection: a NEW id,
 *     offset by one spacing step, ONE undo unit, clone selected. Multi-select
 *     duplicates all.
 *
 *  C. 14.8 SHADOW GATE. A fresh rect has shadow.opacity 0 and emits NO
 *     effectSubtree; opacity 1 + blur 0 makes it emit a hard-edged shadow.
 *
 *  D. COPY WRITES A PNG + STORES ITS SIGNATURE (behavior 2). Copying a normal
 *     widget (rect) renders its PNG cleanly, stores that PNG's imageSignature as
 *     `png_sig` ALONGSIDE the item on the server clipboard, and writes the PNG
 *     to the OS clipboard (verified by a best-effort clipboard.read() when
 *     headless allows it, else by the stored signature + clean render).
 *
 *  E. ELEMENT ROUND-TRIP. With a known {powerrp_item, png_sig} on the server
 *     clipboard, pasting an image inserts the ELEMENT, not a flattened bitmap —
 *     whether or not the image's signature matches. Both halves assert the same
 *     outcome since the 2026-07-30 parity ruling: a signature MISMATCH does not
 *     prove an image is foreign, because the OS pasteboard re-encodes images in
 *     transit, so our own render returns with different bytes. While our own
 *     copy is on the clipboard, Ctrl+V pastes the element. The genuinely foreign
 *     image (nothing of ours on the internal clipboard) is owned by
 *     tests/paste_parity_probe.js. The seed deliberately uses the LEGACY
 *     singular `powerrp_item` key, so this section doubles as the proof that an
 *     older session clipboard still pastes.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/clipboard_duplicate_probe.js
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { imageSignature } from "../web/clipboard.js"; // THE disambiguation signature (same pure fn the app uses)

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
// The project server runs through uv (server.py carries PEP 723 inline deps) —
// the same portable launcher start_server.sh uses, so there is no hardcoded
// interpreter path. Override with POWERRP_UV if uv is not on PATH.
const UV = process.env.POWERRP_UV || "uv";

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

async function waitFor(url, tries = 240) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server never became ready at ${url}`);
}

// Two DISTINCT valid 1x1 PNGs (data-URI base64). RED loads synchronously so the
// filmstrip fixture's OS-PNG render has real frame bytes; the pair also serves
// section E, where one image's signature matches the server png_sig and the
// other's does not. Their signatures are asserted distinct at runtime.
const RED_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";
const TRANSPARENT_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const RED_PX = `data:image/png;base64,${RED_B64}`;
const decodeB64 = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));

// The manifest 14.10 clipboard payload SHAPE: a filmstrip with 18 frameUrls (a
// leaf array), a nested shadow object, and an equation-valued rotationAnchor.
function filmstripFixture() {
  return {
    type: "filmstrip", active: true, z: 5,
    x: 100, y: 80, w: 320, h: 90, rotation: 0, scale: 1,
    // src EMPTY on purpose: with frameUrls already present, the app's frame-fetch
    // effect skips, so the probe exercises the CLIPBOARD path without async
    // re-extraction — the payload shape (frameUrls/shadow/rotationAnchor) is intact.
    src: "", frames: 18,
    frameUrls: Array.from({ length: 18 }, () => RED_PX),
    shadow: { dx: 4, dy: 4, blur: 6, color: "#000000", opacity: 0.5 },
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
  };
}

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_clipboard_dup_"));
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

  const { default: puppeteer } = await import("puppeteer");
  // SwiftShader flags so the WebGPU compositor inits headless (the editor renders
  // through it, and copySelection rasterizes its PNG through it); --no-sandbox is
  // required to launch as root. Same flag set the repo's other WebGPU probes use.
  browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // EXPECTED, correctly-reported headless noise to ignore in the zero-error
  // gate. BOTH are loud reports of environment limitations, not defects — the
  // no-silent-failure discipline WORKING:
  //   1. The per-widget VideoV7 overlay finds no WebGPU adapter under headless
  //      SwiftShader and reports its 2D-drawImage fallback (orthogonal to the
  //      clipboard path — the Skia scene + copySelection's PNG rasterize fine).
  //   2. The OS-clipboard image WRITE is denied by headless Chromium even with
  //      overridePermissions("clipboard-write") — a documented headless quirk
  //      (see copy_png_extent_probe.js). copySelection reports the denial loudly
  //      and keeps the item on the server clipboard; section D classifies this
  //      environment gate explicitly rather than treating it as a code error.
  // (The render itself does NOT fail headless — CanvasKit rasterizes the
  // selection PNG on the CPU surface, so no "Render selection PNG failed" is
  // expected; if one appears it is a REAL failure and must surface.)
  const EXPECTED_NOISE = [
    /VideoV7: WebGPU init failed/,
    /OS-clipboard image write was denied or failed/,
  ];
  const isExpectedNoise = (t) => EXPECTED_NOISE.some((re) => re.test(t));
  const consoleErrors = [];
  page.on("pageerror", (e) => { if (!isExpectedNoise(e.message)) consoleErrors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => {
    if (m.type() === "error" && !isExpectedNoise(m.text())) consoleErrors.push(`console.error: ${m.text()}`);
    if (m.type() === "warning") console.log(`[page.warn] ${m.text()}`);
  });

  // GRANT OS-clipboard permission so the copy's PNG write path (and the
  // best-effort readback in D) exercise fully.
  await browser.defaultBrowserContext().overridePermissions(pageUrl, ["clipboard-read", "clipboard-write"]);

  await page.goto(pageUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));
  if (consoleErrors.length) throw new Error("PAGE ERRORS AT BOOT:\n" + consoleErrors.join("\n"));

  // Seed a named project + a filmstrip item matching the manifest payload.
  await page.evaluate((fx) => {
    const app = window.__powerrp_app;
    app.doc.meta.name = "probe";
    app.addItem(fx); // creates a NEW item with these aspects (new UUID, selected)
  }, filmstripFixture());

  // ── A. COPY → server clipboard + OS PNG ────────────────────────────────────
  console.log("A. server-clipboard copy→paste (permission granted)");
  await page.evaluate(async () => { await window.__powerrp_app.copySelection(); });

  const serverClip = await page.evaluate(async () => {
    const res = await fetch("/api/clipboard/", { credentials: "include" });
    const { payload } = await res.json();
    return payload;
  });
  note(!!serverClip, "copy landed the item JSON on the server-side session clipboard");
  // The payload is {powerrp_items: {sourceId: state}} — the SELECTION is the copy
  // unit (source ids are what make a subgraph clone's reroute boundary knowable;
  // see tests/multipaste_probe.js). One selected item ⇒ exactly one entry.
  let clipItem = null;
  try { clipItem = Object.values(JSON.parse(serverClip).powerrp_items)[0]; } catch { /* handled below */ }
  note(clipItem?.type === "filmstrip", "server clipboard holds the filmstrip item");
  note(Array.isArray(clipItem?.frameUrls) && clipItem.frameUrls.length === 18, "18-frame frameUrls leaf array survived verbatim");
  note(clipItem?.shadow && clipItem.shadow.opacity === 0.5, "nested shadow object survived verbatim");
  note(clipItem?.rotationAnchor?.x === "self.anchors.center.x", "equation-valued rotationAnchor survived verbatim");

  // Ctrl+V is delivered by the native `paste` event (the keydown binding is
  // nativeEvent, so it does not also fire). We reproduce a real keystroke AND
  // the files-less `paste` event a keystroke produces; the files-less event
  // routes app.pasteFromClipboard([]) → pasteClipboard() → the server insert.
  const countBefore = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyV");
  await page.keyboard.up("Meta");
  await page.evaluate(() => window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })));
  let countAfter = countBefore;
  for (let i = 0; i < 40; i++) {
    countAfter = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
    if (countAfter > countBefore) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  note(countAfter === countBefore + 1, `paste inserted exactly one new item (${countBefore} → ${countAfter})`);

  const pasted = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    const ids = Object.keys(items).filter((id) => items[id].type === "filmstrip");
    const id = ids.sort((a, b) => (items[a].z ?? 0) - (items[b].z ?? 0)).at(-1);
    const it = items[id];
    return { id, x: it.x, y: it.y, frames: (it.frameUrls || []).length, anchorX: it.rotationAnchor?.x, selection: app.selection };
  });
  note(pasted.frames === 18, "pasted filmstrip kept its 18 frameUrls");
  note(pasted.x === 116 && pasted.y === 96, `pasted item is offset by 16 (x=${pasted.x}, y=${pasted.y})`);
  note(pasted.anchorX === "self.anchors.center.x", "pasted item kept its equation rotationAnchor");
  note(pasted.selection === pasted.id, "pasted item is selected");

  // ── A'. PASTE with OS-clipboard permission DENIED ───────────────────────────
  console.log("A'. paste still works with OS-clipboard permission DENIED");
  await browser.defaultBrowserContext().overridePermissions(pageUrl, []); // revoke all
  const countBeforeDenied = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyV");
  await page.keyboard.up("Meta");
  // The files-less native `paste` event drives the internal element paste — it
  // reads the SERVER clipboard, so no OS-clipboard permission is needed.
  await page.evaluate(() => window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })));
  let countAfterDenied = countBeforeDenied;
  for (let i = 0; i < 40; i++) {
    countAfterDenied = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
    if (countAfterDenied > countBeforeDenied) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  note(countAfterDenied === countBeforeDenied + 1, `paste inserted a new item WITHOUT OS-clipboard permission (${countBeforeDenied} → ${countAfterDenied}) — server clipboard is the source`);
  await browser.defaultBrowserContext().overridePermissions(pageUrl, ["clipboard-read", "clipboard-write"]); // restore

  // ── B. 14.9 DUPLICATE ──────────────────────────────────────────────────────
  console.log("B. 14.9 duplicate");
  const dup = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    const fids = Object.keys(items).filter((id) => items[id].type === "filmstrip");
    const origId = fids.sort((a, b) => (items[a].z ?? 0) - (items[b].z ?? 0))[0];
    app.selection = origId;
    const before = Object.keys(app.doc.slides[0].delta.items).length;
    const orig = { x: items[origId].x, y: items[origId].y };
    app.duplicateSelection();
    const after = Object.keys(app.doc.slides[0].delta.items).length;
    const items2 = app.doc.slides[0].delta.items;
    const newId = app.selection;
    const clone = items2[newId];
    app.undo();
    const afterUndo = Object.keys(app.doc.slides[0].delta.items).length;
    return {
      before, after, afterUndo, origId, newId,
      cloneX: clone?.x, cloneY: clone?.y, origX: orig.x, origY: orig.y,
      cloneFrames: (clone?.frameUrls || []).length,
    };
  });
  note(dup.after === dup.before + 1, `duplicate added one item (${dup.before} → ${dup.after})`);
  note(dup.newId !== dup.origId, "the duplicate has a NEW id");
  note(dup.cloneX === dup.origX + 16 && dup.cloneY === dup.origY + 16, `the duplicate is offset (x ${dup.origX}→${dup.cloneX}, y ${dup.origY}→${dup.cloneY})`);
  note(dup.cloneFrames === 18, "the duplicate kept the filmstrip's 18 frameUrls (same clone path)");
  note(dup.afterUndo === dup.before, `ONE undo removed the duplicate (${dup.after} → ${dup.afterUndo}) — one undo unit`);

  const multi = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    const nonCamera = Object.keys(items).filter((id) => items[id].type !== "camera");
    const two = nonCamera.slice(0, 2);
    app.selectMany(two);
    const before = Object.keys(app.doc.slides[0].delta.items).length;
    app.duplicateSelection();
    const after = Object.keys(app.doc.slides[0].delta.items).length;
    const selCount = app.selectedIds().length;
    app.undo();
    const afterUndo = Object.keys(app.doc.slides[0].delta.items).length;
    return { before, after, afterUndo, selCount, picked: two.length };
  });
  note(multi.picked === 2 && multi.after === multi.before + 2, `multi-select duplicated all ${multi.picked} (${multi.before} → ${multi.after})`);
  note(multi.selCount === 2, "both duplicates are selected");
  note(multi.afterUndo === multi.before, "one undo removed BOTH duplicates (one undo unit)");

  // ── C. 14.8 SHADOW GATE ─────────────────────────────────────────────────────
  console.log("C. 14.8 shadow default + gate");
  const shadow = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("rect").defaults, w: 100, h: 80 });
    const id = app.selection;
    const st = app.doc.slides[0].delta.items[id];
    const plugin = app.registry.get("rect");
    const world = { x: st.x, y: st.y, rotation: st.rotation ?? 0, scale: st.scale ?? 1 };
    const opsOff = plugin.emit({ ...st, x: 0, y: 0 }, null, world);
    const hasEffectOff = opsOff.some((o) => o.op === "effectSubtree");
    const opsOn = plugin.emit({ ...st, x: 0, y: 0, shadow: { dx: 5, dy: 5, blur: 0, color: "#000000", opacity: 1 } }, null, world);
    const effOn = opsOn.find((o) => o.op === "effectSubtree");
    return {
      defaultShadowOpacity: st.shadow?.opacity, defaultShadowDx: st.shadow?.dx, defaultShadowDy: st.shadow?.dy,
      hasEffectOff,
      hasEffectOn: !!effOn,
      onShadowBlur: effOn?.shadow?.blur, onShadowOpacity: effOn?.shadow?.opacity,
    };
  });
  note(shadow.defaultShadowOpacity === 0, `new rect default shadow.opacity is 0 (got ${shadow.defaultShadowOpacity})`);
  note(shadow.defaultShadowDx === 0 && shadow.defaultShadowDy === 0, `new rect default shadow dx/dy are 0 (got ${shadow.defaultShadowDx},${shadow.defaultShadowDy})`);
  note(!shadow.hasEffectOff, "default (opacity 0) rect emits NO shadow (no effectSubtree)");
  note(shadow.hasEffectOn, "opacity 1 + blur 0 emits an effectSubtree (shadow ON)");
  note(shadow.onShadowBlur === 0 && shadow.onShadowOpacity === 1, `the hard shadow carries blur 0, opacity 1 (got blur ${shadow.onShadowBlur}, opacity ${shadow.onShadowOpacity})`);

  // ── D. COPY WRITES A PNG + STORES ITS SIGNATURE (behavior 2) ─────────────────
  // Copying a RECT must (1) render a real PNG, (2) store that PNG's imageSignature
  // as png_sig ALONGSIDE the item on the server clipboard, and (3) attempt to
  // write the PNG to the OS clipboard so it pastes into other apps.
  console.log("D. copy renders a PNG, stores its signature, writes it to the OS clipboard");
  const errsBeforeRect = consoleErrors.length;
  await page.evaluate(async () => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("rect").defaults, w: 120, h: 90, fill: "#7aa2f7" });
    await app.copySelection(); // server clipboard (+png_sig) + rendered PNG to OS clipboard
  });
  // The ONLY expected report during a rect copy is the headless OS-clipboard
  // write-denial (filtered as noise). A render failure is NOT filtered, so a
  // growth in consoleErrors here would be a REAL render defect.
  note(consoleErrors.length === errsBeforeRect, "copying a rect rendered its PNG with no unexpected error (CanvasKit render path is clean)");

  const dPayload = await page.evaluate(async () => {
    const res = await fetch("/api/clipboard/", { credentials: "include" });
    const { payload } = await res.json();
    return payload;
  });
  let dParsed = null;
  try { dParsed = JSON.parse(dPayload); } catch { /* asserted below */ }
  note(Object.values(dParsed?.powerrp_items ?? {})[0]?.type === "rect", "server clipboard holds the copied rect item");
  const serverPngSig = dParsed?.png_sig;
  note(typeof serverPngSig === "string" && /^[0-9a-f]+\.[0-9a-f]+$/.test(serverPngSig), `a png_sig signature is stored alongside the item (${serverPngSig})`);
  // png_sig is `<hexByteLen>.<hexHash>`: decode the length prefix to PROVE the
  // copy hashed a real, substantial PNG (a rect render is hundreds of bytes),
  // not an empty/1x1 placeholder.
  const MIN_RENDERED_PNG_BYTES = 100;
  const sigByteLen = serverPngSig ? parseInt(serverPngSig.split(".")[0], 16) : 0;
  note(sigByteLen >= MIN_RENDERED_PNG_BYTES, `png_sig hashes a real rendered PNG (${sigByteLen} bytes >= ${MIN_RENDERED_PNG_BYTES})`);

  // Classify the OS-clipboard WRITE in THIS headless environment by attempting a
  // direct write, so the probe distinguishes "the environment gates writes"
  // (documented headless quirk) from "the copy's write path is broken".
  const osWrite = await page.evaluate(async () => {
    try {
      const blob = new Blob([Uint8Array.from([137, 80, 78, 71])], { type: "image/png" });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return { wrote: true };
    } catch (e) { return { wrote: false, reason: e.message }; }
  });
  if (osWrite.wrote) {
    // Writes work here → copySelection's write landed. Read it back and prove the
    // OS clipboard carries the SAME rendered PNG the copy hashed.
    const osImage = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes("image/png")) {
          const buf = new Uint8Array(await (await it.getType("image/png")).arrayBuffer());
          return { available: true, bytes: Array.from(buf) };
        }
      }
      return { available: false };
    });
    if (osImage.available) {
      // Re-copy so the OS clipboard holds the RECT render (the direct-write probe
      // above overwrote it with the 4-byte marker), then read + compare.
      await page.evaluate(async () => { await window.__powerrp_app.copySelection(); });
      const reread = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          if (it.types.includes("image/png")) {
            const buf = new Uint8Array(await (await it.getType("image/png")).arrayBuffer());
            return Array.from(buf);
          }
        }
        return null;
      });
      note(reread && imageSignature(Uint8Array.from(reread)) === serverPngSig, "OS clipboard carries the SAME rendered PNG the copy hashed (readback signature matches png_sig)");
    } else {
      note(false, "OS-clipboard writes are permitted here but no image/png read back — unexpected");
    }
  } else if (/permission denied/i.test(osWrite.reason)) {
    // Documented headless quirk (copy_png_extent_probe.js): headless Chromium
    // denies clipboard image writes even with overridePermissions. copySelection
    // exercises the Async Clipboard API write path and reports the denial loudly;
    // in a real browser (secure context, user gesture) the write lands. Behavior
    // 2's OS write is verified as far as this environment allows: real PNG
    // rendered + hashed + the write attempted through the correct API.
    console.log(`  --  OS-clipboard image write is environment-gated in headless (${osWrite.reason}); copySelection attempts the write via the Async Clipboard API and reports the denial loudly — the write PATH is exercised, only the landing is gated`);
  } else {
    note(false, `unexpected OS-clipboard write failure (not a permission gate): ${osWrite.reason}`);
  }

  // ── E. ELEMENT ROUND-TRIP + IMAGE DISAMBIGUATION (behaviors 3 + 4) ───────────
  // Seed a KNOWN {powerrp_item(rect w=333), png_sig=sig(RED)} on the server
  // clipboard. Pasting the RED image (sig matches) must insert the ELEMENT;
  // pasting the TRANSPARENT image (sig differs) must insert an IMAGE widget.
  console.log("E. element round-trip (sig match → element) + disambiguation (different image → image)");
  const matchBytes = decodeB64(RED_B64);
  const otherBytes = decodeB64(TRANSPARENT_B64);
  const matchSig = imageSignature(matchBytes);
  const otherSig = imageSignature(otherBytes);
  note(matchSig !== otherSig, `the two test images have distinct signatures (${matchSig} != ${otherSig})`);

  // Seed the server clipboard with the known payload (the shape copySelection
  // produces: item + png_sig), overriding whatever D left.
  const MARKER_W = 333;
  await page.evaluate(async ({ matchSig, markerW }) => {
    const app = window.__powerrp_app;
    const rectState = { ...app.registry.get("rect").defaults, active: true, z: 1, x: 200, y: 200, w: markerW, h: 80 };
    const payloadStr = JSON.stringify({ powerrp_item: rectState, png_sig: matchSig });
    await fetch("/api/clipboard/", {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: payloadStr }),
    });
  }, { matchSig, markerW: MARKER_W });

  // Count uploads across section E: a MATCH must NOT upload; a MISMATCH must.
  let uploadCountE = 0;
  page.removeAllListeners("request");
  page.on("request", (req) => { if (req.method() === "POST" && req.url().includes("/api/upload/")) uploadCountE++; });

  // E1. MATCH → element paste (behavior 3). Paste an image whose signature
  // equals the stored png_sig → the ELEMENT (rect w=333), not a bitmap.
  const e1 = await page.evaluate(async ({ b64, markerW }) => {
    const app = window.__powerrp_app;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "match.png", { type: "image/png" });
    const before = Object.keys(app.doc.slides[0].delta.items).length;
    await app.pasteFromClipboard([file]);
    const items = app.doc.slides[0].delta.items;
    const after = Object.keys(items).length;
    const rectId = Object.keys(items).find((id) => items[id].type === "rect" && items[id].w === markerW);
    return { before, after, pastedElement: !!rectId };
  }, { b64: RED_B64, markerW: MARKER_W });
  await new Promise((r) => setTimeout(r, 200)); // let any (unexpected) upload fire before we read the counter
  const uploadsAfterMatch = uploadCountE;
  note(e1.after === e1.before + 1, `MATCH paste inserted exactly one item (${e1.before} → ${e1.after})`);
  note(e1.pastedElement, "MATCH paste inserted the ELEMENT (rect marker w=333), not a flattened image");
  note(uploadsAfterMatch === 0, "MATCH paste did NOT upload anything (the element came from the server clipboard)");

  // E2. A DIFFERENT image, with our internal clipboard STILL LOADED.
  //
  // SUPERSEDED BY THE 2026-07-30 PARITY RULING, and deliberately reversed. This
  // used to expect an IMAGE widget, on the theory that a signature mismatch
  // proves the image is foreign. It proves nothing: the OS pasteboard
  // RE-ENCODES images, so OUR OWN render comes back with a different signature
  // too (581 bytes in, 645 out, measured on macOS). Treating "mismatch" as
  // "foreign" is precisely what pasted the user's copied widget as a flattened
  // bitmap. With an internal payload live, an image-only clipboard is now
  // resolved toward the ELEMENT — Ctrl+V and the toolbar button are one action.
  // The genuine foreign-image path (empty internal clipboard) is asserted in
  // tests/paste_parity_probe.js, which owns this behavior end to end.
  const mmBefore = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
  await page.evaluate(async ({ b64 }) => {
    const app = window.__powerrp_app;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "external_other.png", { type: "image/png" });
    await app.pasteFromClipboard([file]);
  }, { b64: TRANSPARENT_B64 });
  let mmImage = false, mmAfter = mmBefore;
  for (let i = 0; i < 20; i++) {
    const r = await page.evaluate(() => {
      const items = window.__powerrp_app.doc.slides[0].delta.items;
      return {
        count: Object.keys(items).length,
        hasImg: Object.keys(items).some((id) => items[id].type === "image" && (items[id].src || "").includes("external_other")),
      };
    });
    mmAfter = r.count;
    if (r.hasImg) { mmImage = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  note(!mmImage, "a re-encoded/mismatched image did NOT become an image widget while our own copy is on the clipboard");
  note(mmAfter === mmBefore + 1, `paste inserted exactly one item (${mmBefore} → ${mmAfter})`);
  note(uploadCountE === 0, "nothing was uploaded — the ELEMENT was pasted, not the bitmap (the parity ruling)");

  await new Promise((r) => setTimeout(r, 200));
  if (consoleErrors.length) errors.push("CONSOLE ERRORS DURING PROBE:\n" + consoleErrors.join("\n"));

  if (errors.length) throw new Error("PROBE FAILURES:\n" + errors.map((e) => "  - " + e).join("\n"));
  console.log("\nCLIPBOARD + DUPLICATE + SHADOW PROBE OK");
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}
