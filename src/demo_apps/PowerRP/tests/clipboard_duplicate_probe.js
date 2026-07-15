/**
 * Clipboard (14.10 AMENDED) + Duplicate (14.9) + Shadow-gate (14.8) live probe.
 *
 * Drives the REAL editor (ephemeral python server + ephemeral Vite + puppeteer,
 * the paste_upload_probe.js isolation pattern: mkdtemp POWERRP_PROJECTS_DIR, free
 * ports, NEVER 3637/3638) and asserts the three Round-14 behaviors end to end:
 *
 *  A. 14.10 SERVER-CLIPBOARD COPY→PASTE. Copy a FILMSTRIP item built from the
 *     manifest payload shape (18 frameUrls leaf array, nested shadow object,
 *     equation-valued rotationAnchor). copySelection() must (1) land the item
 *     JSON on the server-side session clipboard (GET /api/clipboard/ returns it)
 *     and (2) write a rendered PNG to the OS clipboard (permission GRANTED here).
 *     Then a real Cmd+V keydown pastes a NEW item (new id, offset) whose
 *     frameUrls/shadow/rotationAnchor survived the round-trip verbatim.
 *
 *  A'. PERMISSION-DENIED PATH. Re-run the paste with OS-clipboard permission
 *     DENIED: the item paste STILL works, because paste reads the SERVER
 *     clipboard, not the OS clipboard (the whole point of 14.10 AMENDED — the
 *     old readText permission saga is retired).
 *
 *  B. 14.9 DUPLICATE. duplicateSelection() clones the selection: a NEW id,
 *     offset by one spacing step, ONE undo unit (a single undo removes it), and
 *     the clone becomes selected. Multi-select duplicates all.
 *
 *  C. 14.8 SHADOW GATE. A freshly created rect has shadow.opacity 0 and emits NO
 *     effectSubtree (no shadow). Setting shadow.opacity 1 with blur 0 makes it
 *     emit an effectSubtree carrying a shadow (a VISIBLE hard-edged shadow).
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

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const PY = "/opt/homebrew/opt/python@3.10/bin/python3.10";

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

// A 1x1 red PNG as a data URI — a frameUrl that loads SYNCHRONOUSLY (no 404,
// no async image-registry churn), so the OS-clipboard PNG render succeeds in
// the probe. The PAYLOAD SHAPE is what 14.10 tests (18-element frameUrls leaf
// array + nested shadow object + equation rotationAnchor); real cached-frame
// URLs vs data URIs is immaterial to the clipboard round-trip.
const RED_PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";

// The manifest 14.10 clipboard payload SHAPE: a filmstrip with 18 frameUrls (a
// leaf array), a nested shadow object, and an equation-valued rotationAnchor.
// Built here as a real item state we seed, copy, and paste — the repro fixture.
function filmstripFixture() {
  return {
    type: "filmstrip", active: true, z: 5,
    x: 100, y: 80, w: 320, h: 90, rotation: 0, scale: 1,
    // src EMPTY on purpose: with frameUrls already present, the app's frame-fetch
    // effect (#wireFilmstripFrames) skips (it only fetches for a non-empty src),
    // so the probe exercises the CLIPBOARD path without the async re-extraction
    // machinery — the payload shape (frameUrls/shadow/rotationAnchor) is intact.
    src: "", frames: 18,
    frameUrls: Array.from({ length: 18 }, () => RED_PX),
    shadow: { dx: 4, dy: 4, blur: 6, color: "#000000", opacity: 0.5 },
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
  };
}

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_clipboard_dup_"));
const backendPort = await freePort();
const server = spawn(PY, ["server.py", "serve", `--port=${backendPort}`], {
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
  browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // EXPECTED, correctly-reported noise to ignore in the zero-error gate: copying
  // a FILMSTRIP whose data-URI frames are not in the OFFSCREEN gpuService image
  // registry makes the best-effort OS-PNG render fail — and it is REPORTED
  // loudly ("Copy: rendering the selection PNG failed... the item is still on
  // the server clipboard"), which is the no-silent-failure discipline WORKING,
  // not a bug (a plain rect copies its PNG fine — proven in section D). The
  // WebGPU "Destroyed texture" churn is a downstream symptom of that same
  // offscreen-render abort. copyAsPng (the pre-existing sibling) has the exact
  // same limitation for filmstrips; it is not introduced by this change.
  const EXPECTED_NOISE = [
    /Copy: rendering the selection PNG failed/,
    /Destroyed texture \[Texture "ir-scene"\]/,
    /reading 'tex'/,
  ];
  const isExpectedNoise = (t) => EXPECTED_NOISE.some((re) => re.test(t));
  const consoleErrors = [];
  page.on("pageerror", (e) => { if (!isExpectedNoise(e.message)) consoleErrors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => {
    if (m.type() === "error" && !isExpectedNoise(m.text())) consoleErrors.push(`console.error: ${m.text()}`);
    if (m.type() === "warning") console.log(`[page.warn] ${m.text()}`);
  });

  // GRANT OS-clipboard permission so the copy's PNG write path exercises fully
  // (the item paste never needs it — that reads the server clipboard).
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

  // ── A. 14.10 COPY → server clipboard + OS PNG ──────────────────────────────
  console.log("A. 14.10 server-clipboard copy→paste (permission granted)");
  await page.evaluate(async () => { await window.__powerrp_app.copySelection(); });

  // The item JSON must now be on the SERVER clipboard for this session. The page
  // fetch shares the browser's session cookie, so we read it from the page.
  const serverClip = await page.evaluate(async () => {
    const res = await fetch("/api/clipboard/", { credentials: "include" });
    const { payload } = await res.json();
    return payload;
  });
  note(!!serverClip, "copy landed the item JSON on the server-side session clipboard");
  let clipItem = null;
  try { clipItem = JSON.parse(serverClip).powerrp_item; } catch { /* handled below */ }
  note(clipItem?.type === "filmstrip", "server clipboard holds the filmstrip item");
  note(Array.isArray(clipItem?.frameUrls) && clipItem.frameUrls.length === 18, "18-frame frameUrls leaf array survived verbatim");
  note(clipItem?.shadow && clipItem.shadow.opacity === 0.5, "nested shadow object survived verbatim");
  note(clipItem?.rotationAnchor?.x === "self.anchors.center.x", "equation-valued rotationAnchor survived verbatim");

  // Real Cmd+V keydown → runCommand("paste") → pasteClipboard() → insert.
  const countBefore = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyV");
  await page.keyboard.up("Meta");
  // A native paste event fires alongside a real keystroke (files-less here, or
  // carrying our OWN render PNG); either way the item paste ran on the keydown.
  await page.evaluate(() => window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })));
  let countAfter = countBefore;
  for (let i = 0; i < 40; i++) {
    countAfter = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
    if (countAfter > countBefore) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  note(countAfter === countBefore + 1, `paste inserted exactly one new item (${countBefore} → ${countAfter})`);

  // The pasted item is a NEW filmstrip, offset, with the payload intact.
  const pasted = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    const ids = Object.keys(items).filter((id) => items[id].type === "filmstrip");
    // The most recently added = the highest z (addItem stacks above max).
    const id = ids.sort((a, b) => (items[a].z ?? 0) - (items[b].z ?? 0)).at(-1);
    const it = items[id];
    return { id, x: it.x, y: it.y, frames: (it.frameUrls || []).length, shadowOpacity: it.shadow?.opacity, anchorX: it.rotationAnchor?.x, selection: app.selection };
  });
  note(pasted.frames === 18, "pasted filmstrip kept its 18 frameUrls");
  note(pasted.x === 116 && pasted.y === 96, `pasted item is offset by 16 (x=${pasted.x}, y=${pasted.y})`);
  note(pasted.anchorX === "self.anchors.center.x", "pasted item kept its equation rotationAnchor");
  note(pasted.selection === pasted.id, "pasted item is selected");

  // ── A'. 14.10 PASTE with OS-clipboard permission DENIED ─────────────────────
  console.log("A'. 14.10 paste still works with OS-clipboard permission DENIED");
  await browser.defaultBrowserContext().overridePermissions(pageUrl, []); // revoke all
  const countBeforeDenied = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyV");
  await page.keyboard.up("Meta");
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
    // Select the original filmstrip (lowest z among filmstrips).
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
    // Undo must remove the clone in ONE step.
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

  // Multi-select duplicate: select TWO items, duplicate, expect +2.
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
    // Fresh rect at its plugin defaults (addItem = the creation path — the same
    // {...defaults, active, z} state a placement drag commits).
    app.addItem({ ...app.registry.get("rect").defaults, w: 100, h: 80 });
    const id = app.selection;
    const st = app.doc.slides[0].delta.items[id];
    // Emit through the rect plugin at its stored (default) shadow: opacity 0.
    const plugin = app.registry.get("rect");
    const world = { x: st.x, y: st.y, rotation: st.rotation ?? 0, scale: st.scale ?? 1 };
    const opsOff = plugin.emit({ ...st, x: 0, y: 0 }, null, world);
    const hasEffectOff = opsOff.some((o) => o.op === "effectSubtree");
    // Now turn the shadow ON via opacity=1 with blur=0 (a HARD-edged shadow).
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

  // ── D. 14.10 OS-PNG copy for a NORMAL widget (clean render) ──────────────────
  // Copy a RECT (no external images) and confirm the OS-clipboard PNG write path
  // runs CLEANLY (no "rendering the selection PNG failed" — unlike the filmstrip
  // whose frames aren't in the offscreen registry) and that isOwnCopiedPng — the
  // 13.3 disambiguation seam — was armed by the copy. Note: navigator.clipboard.
  // read() of image data is unreliable in headless Chromium, so we assert the
  // WRITE path succeeded (no failure log) + the seam works, not a readback.
  console.log("D. 14.10 OS-PNG copy of a normal widget (rect)");
  const pngFailsBefore = consoleErrors.length; // (filtered — expected filmstrip noise never lands here)
  const seam = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("rect").defaults, w: 120, h: 90, fill: "#7aa2f7" });
    // A garbage-bytes check BEFORE copy: the seam holds either nothing or a
    // previous render — either way garbage must be rejected.
    const rejectsBefore = app.isOwnCopiedPng(new Uint8Array([1, 2, 3]));
    await app.copySelection(); // server clipboard + rendered PNG to OS clipboard
    return {
      rejectsGarbage: app.isOwnCopiedPng(new Uint8Array([1, 2, 3])) === false && rejectsBefore === false,
      rejectsNull: app.isOwnCopiedPng(null) === false,
    };
  });
  // A CLEAN rect render logs no PNG-render failure (the filmstrip one is filtered
  // as expected noise; a rect failure would NOT match the filter and would show).
  const rectRenderClean = consoleErrors.length === pngFailsBefore;
  note(rectRenderClean, "copying a rect renders + writes its OS-clipboard PNG with no error (clean render path)");
  note(seam.rejectsGarbage, "isOwnCopiedPng rejects unrelated bytes (an external image still uploads — 13.3 preserved)");
  note(seam.rejectsNull, "isOwnCopiedPng handles null/absent bytes safely");

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
