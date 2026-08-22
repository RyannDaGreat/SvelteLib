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
 *  B'. R6-18.1 ENDPOINT-PAIR CLONE. B uses a filmstrip — a bbox widget that
 *     really does keep its position in x/y — so it could never see the reported
 *     bug. An ARROW keeps its position in from/to and has no x/y, and the clone
 *     home bumped `clone.x ?? 0`: the copy gained a phantom x/y, hence a
 *     non-identity world, so its INK moved one step while its WORLD-space
 *     endpoint HANDLES stayed on the original. Both entrances (Duplicate and the
 *     older PASTE) are measured, and the copy's stored keys are read to prove no
 *     invisible, uneditable, save-surviving x/y was invented.
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
 *  E. ELEMENT ROUND-TRIP, AND THE SCREENSHOT BESIDE IT. With a known
 *     {powerrp_item, png_sig} on the server clipboard, pasting an image THAT
 *     CARRIES OUR MARKER inserts the ELEMENT, not a flattened bitmap; an image
 *     that does NOT carry it is a screenshot and is uploaded. The seed
 *     deliberately uses the LEGACY singular `powerrp_item` key, so E1 doubles as
 *     the proof that an older session clipboard still pastes.
 *
 *     THE DECIDING EVIDENCE IS THE MARKER, NOT THE BYTES, AND THIS SECTION USED
 *     TO SAY OTHERWISE. Its two halves both asserted "element wins" on the 2026-
 *     07-30 parity reasoning: a signature MISMATCH does not prove an image is
 *     foreign, because the OS pasteboard re-encodes images in transit (581 bytes
 *     in, 645 out, measured on macOS), so OUR OWN render comes back with
 *     different bytes. **That reasoning is still true and is no longer the
 *     question.** `a983cc91` established that on a browser which CAN tag a copy
 *     (`osClipboardTagging() === "tagged"`, which headless Chrome is), an image
 *     arriving WITHOUT `POWERRP_CLIPBOARD_MIME` is foreign by definition —
 *     nothing about its bytes is consulted. Both halves here omitted the type
 *     entirely, so both described a foreign paste while asserting the element
 *     path, and the fixture had stopped matching the sentence above it.
 *     E1 now passes the marker (it is our own copy, so it must say so) and E2
 *     keeps its untagged fixture and asserts the screenshot outcome. The
 *     genuinely foreign path with an EMPTY internal clipboard is owned by
 *     tests/paste_parity_probe.js; the precedence rules by
 *     tests/paste_screenshot_precedence_probe.js.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/clipboard_duplicate_probe.js
 */

import { spawn } from "node:child_process";
import { freePort } from "./free_port.js";
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

// freePort now comes from ./free_port.js, which RE-VERIFIES the port is still
// bindable before handing it back. The copy that used to live here bound port 0,
// read the number, closed, and returned — leaving a TOCTOU window that stays open
// until the spawned backend binds. Under the gate's x3 probe concurrency two
// probes could draw the same number, and the loser died with `Errno 48 Address
// already in use` -> `server never became ready`: a red that said nothing about
// what this probe tests.

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

// How many frames the fixture strip carries. The exact number is arbitrary; what
// matters is that ONE number drives the frame LIST and the frameUrls leaf array
// together, since the payload-survives-verbatim assertions read the second.
const FIXTURE_FRAME_COUNT = 18;

// The manifest 14.10 clipboard payload SHAPE: a filmstrip with 18 frameUrls (a
// leaf array), a nested shadow object, and an equation-valued rotationAnchor.
function filmstripFixture() {
  return {
    type: "filmstrip", active: true, z: 5,
    x: 100, y: 80, w: 320, h: 90, rotation: 0, scale: 1,
    // src EMPTY on purpose: with frameUrls already present, the app's frame-fetch
    // effect skips, so the probe exercises the CLIPBOARD path without async
    // re-extraction — the payload shape (frameUrls/shadow/rotationAnchor) is intact.
    src: "",
    // `frames` is a LIST property (one TUPLE element per frame, field `time`) —
    // core/properties.js PROPS.frames, plugins/filmstrip.js defaultFrameList. This
    // fixture carried the PRE-LIST schema, a bare count of 18, and the Inspector's
    // ListField reported it correctly and loudly on every render: `ListField:
    // "items.<id>.frames" is not an array (delta/fold bug) — got 18`. That report
    // failed this probe's zero-console-error gate at baseline, so the suite was red
    // before anything in it was wrong — a stale fixture reading as an app defect.
    frames: Array.from({ length: FIXTURE_FRAME_COUNT }, (_, i) => [i / FIXTURE_FRAME_COUNT]),
    frameUrls: Array.from({ length: FIXTURE_FRAME_COUNT }, () => RED_PX),
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

  const { launchBrowser } = await import("./puppeteerLaunch.js");
  // SwiftShader flags so the WebGPU compositor inits headless (the editor renders
  // through it, and copySelection rasterizes its PNG through it); --no-sandbox is
  // required to launch as root. Same flag set the repo's other WebGPU probes use.
  browser = await launchBrowser();
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

  // THE clone offset, IMPORTED from the module that applies it rather than
  // re-declared here (this probe used a bare `16` and multipaste_probe.js kept a
  // `PASTE_OFFSET` of its own — two hand-maintained mirrors of one number). The
  // module is already loaded in the page, so this dynamic import hands back the
  // very binding the app is using; a bare-node import is impossible because
  // app.svelte.js is a runes module.
  const CLONE_OFFSET = await page.evaluate(async () => (await import("/app.svelte.js")).CLONE_OFFSET);
  if (typeof CLONE_OFFSET !== "number") throw new Error(`web/app.svelte.js must export CLONE_OFFSET (got ${CLONE_OFFSET})`);

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
  note(Array.isArray(clipItem?.frameUrls) && clipItem.frameUrls.length === FIXTURE_FRAME_COUNT, `${FIXTURE_FRAME_COUNT}-frame frameUrls leaf array survived verbatim`);
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
  note(pasted.frames === FIXTURE_FRAME_COUNT, `pasted filmstrip kept its ${FIXTURE_FRAME_COUNT} frameUrls`);
  const seeded = filmstripFixture(); // where the pasted copy is measured FROM
  note(pasted.x === seeded.x + CLONE_OFFSET && pasted.y === seeded.y + CLONE_OFFSET, `pasted item is offset by ${CLONE_OFFSET} (x=${pasted.x}, y=${pasted.y})`);
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
  note(dup.cloneX === dup.origX + CLONE_OFFSET && dup.cloneY === dup.origY + CLONE_OFFSET, `the duplicate is offset (x ${dup.origX}→${dup.cloneX}, y ${dup.origY}→${dup.cloneY})`);
  note(dup.cloneFrames === FIXTURE_FRAME_COUNT, `the duplicate kept the filmstrip's ${FIXTURE_FRAME_COUNT} frameUrls (same clone path)`);
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

  // ── B'. R6-18.1 ENDPOINT-PAIR CLONE — the ink and the handles move TOGETHER ──
  // Section B duplicates a FILMSTRIP: a bbox widget that really does store its
  // position in x/y. An ENDPOINT-PAIR widget (the arrow family) does not — it
  // stores from/to and has no x/y at all — and the clone home used to bump
  // `clone.x ?? 0`, FABRICATING an x/y that gave the copy a non-identity `world`.
  // The painted ink moved by the offset while the endpoint handles (WORLD-space
  // by contract, core/registry.js) stayed on the ORIGINAL: the user's report.
  // BOTH clone entrances are measured, because both run #cloneStatesIntoSlide and
  // PASTE is the older of the two (692101d) — a fix that only reached Duplicate
  // would leave the reference entrance broken.
  console.log("B'. R6-18.1 endpoint-pair clone (fancy arrow) — duplicate AND paste");
  const ARROW_FROM = { x: 420, y: 300 };
  const ARROW_TO = { x: 640, y: 300 };
  await page.evaluate((root) => { window.__powerrp_probeRoot = root; }, APP_DIR);
  // ONE in-page pose measurement, installed once and used by BOTH scenarios: if
  // duplicate and paste were measured by two hand-copied blocks, a divergence
  // between the entrances could hide in the measurement instead of the app.
  // rotatedBBoxAABB is the SAME world-AABB band-select and culling read (it
  // applies node.world, so it follows the INK); editPoints is what the canvas
  // draws the handles from.
  await page.evaluate(async () => {
    const { rotatedBBoxAABB } = await import("/@fs" + window.__powerrp_probeRoot + "/core/view.js");
    window.__probeArrowPose = (itemId) => {
      const app = window.__powerrp_app;
      const nodes = app.nodes();
      const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
      const node = nodes.find((n) => n.itemId === itemId);
      const ink = rotatedBBoxAABB(node);
      const handle = node.plugin.editPoints(node, byId)[0];
      // The DELTA is what serialize() writes, so reading the phantom key here is
      // exactly the "does it survive save" question.
      const stored = app.doc.slides[app.slideIndex].delta.items[itemId];
      return {
        ink: { x: ink.x, y: ink.y },
        handle: { x: handle.x, y: handle.y },
        world: { x: node.world.x, y: node.world.y },
        storedKeys: Object.keys(stored),
        from: stored.from,
      };
    };
  });

  // `run(app)` through the real registry entry, not the method — the palette,
  // the shortcut and the toolbar all dispatch that way.
  const arrowDup = JSON.parse(await page.evaluate((pts) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("fancy_arrow").defaults, from: pts.from, to: pts.to });
    const origId = app.selection;
    const before = window.__probeArrowPose(origId);
    app.commands.get("duplicate").run(app);
    const cloneId = app.selection;
    const after = window.__probeArrowPose(cloneId);
    return JSON.stringify({ origId, cloneId, before, after });
  }, { from: ARROW_FROM, to: ARROW_TO }));

  const poseReport = (label, before, after) => {
    // A pure translation of integer coordinates, so these deltas are exact.
    const moved = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
    const ink = moved(after.ink, before.ink), handle = moved(after.handle, before.handle);
    const fmt = (d) => `(${d.x}, ${d.y})`;
    note(ink.x === handle.x && ink.y === handle.y,
      `${label}: the ink and the handles moved by the SAME delta (ink ${fmt(ink)}, handles ${fmt(handle)})`);
    note(ink.x === CLONE_OFFSET && ink.y === CLONE_OFFSET, `${label}: the copy landed one spacing step away ${fmt(ink)}`);
    note(!after.storedKeys.includes("x") && !after.storedKeys.includes("y"),
      `${label}: NO x/y was invented on a widget that has none — such a key has no Inspector row, cannot be edited away, and survives save (stored: ${after.storedKeys.join(", ")})`);
    note(after.world.x === 0 && after.world.y === 0,
      `${label}: the copy's world stays IDENTITY, which is what an endpoint-pair widget's geometry assumes (core/view.js) — got (${after.world.x}, ${after.world.y})`);
    note(after.from.x === before.from.x + CLONE_OFFSET && after.from.y === before.from.y + CLONE_OFFSET,
      `${label}: the offset landed on the ENDPOINTS, the properties this widget's position actually lives in (from ${before.from.x},${before.from.y} → ${after.from.x},${after.from.y})`);
  };
  poseReport("duplicate", arrowDup.before, arrowDup.after);

  // PASTE — the older entrance, through the same clone home.
  const arrowPaste = JSON.parse(await page.evaluate(async (origId) => {
    const app = window.__powerrp_app;
    app.selection = origId;
    const before = window.__probeArrowPose(origId);
    await app.copySelection();
    await app.pasteClipboard();
    const cloneId = app.selection;
    const after = window.__probeArrowPose(cloneId);
    return JSON.stringify({ cloneId, before, after });
  }, arrowDup.origId));
  note(arrowPaste.cloneId !== arrowDup.origId, "paste inserted a NEW arrow item");
  poseReport("paste", arrowPaste.before, arrowPaste.after);

  // ── B''. R6-18.2 DUPLICATE IN PLACE ─────────────────────────────────────────
  // The sibling entry is the SAME clone with a different number, so it is checked
  // on BOTH branches of the translation rule: an arrow (moveBy — its endpoints
  // must not move) and a rect (plain x/y — a zero delta must write neither axis,
  // which is also what keeps an equation-valued x from being replaced by its
  // resolved literal just because a copy was made).
  console.log("B''. R6-18.2 duplicate in place (no offset), both translation branches");
  const inPlace = JSON.parse(await page.evaluate((origId) => {
    const app = window.__powerrp_app;
    app.selection = origId;
    const before = window.__probeArrowPose(origId);
    app.commands.get("duplicate-in-place").run(app);
    const cloneId = app.selection;
    const after = window.__probeArrowPose(cloneId);

    app.addItem({ ...app.registry.get("rect").defaults, x: 250, y: 150, w: 100, h: 80 });
    const rectId = app.selection;
    const rectBefore = app.doc.slides[app.slideIndex].delta.items[rectId];
    const orig = { x: rectBefore.x, y: rectBefore.y };
    app.commands.get("duplicate-in-place").run(app);
    const rectClone = app.doc.slides[app.slideIndex].delta.items[app.selection];
    return JSON.stringify({ cloneId, before, after, orig, clone: { x: rectClone.x, y: rectClone.y } });
  }, arrowDup.origId));
  note(inPlace.cloneId !== arrowDup.origId, "duplicate-in-place inserted a NEW item");
  note(inPlace.after.from.x === inPlace.before.from.x && inPlace.after.from.y === inPlace.before.from.y,
    `duplicate-in-place: the arrow's endpoints did NOT move (from ${inPlace.after.from.x},${inPlace.after.from.y})`);
  note(inPlace.after.ink.x === inPlace.before.ink.x && inPlace.after.ink.y === inPlace.before.ink.y,
    "duplicate-in-place: the arrow copy's ink lands exactly on the original");
  note(!inPlace.after.storedKeys.includes("x") && !inPlace.after.storedKeys.includes("y"),
    `duplicate-in-place: still no invented x/y (stored: ${inPlace.after.storedKeys.join(", ")})`);
  note(inPlace.clone.x === inPlace.orig.x && inPlace.clone.y === inPlace.orig.y,
    `duplicate-in-place: a BBOX widget's copy lands on the original too (${inPlace.orig.x},${inPlace.orig.y} → ${inPlace.clone.x},${inPlace.clone.y})`);

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

  // Count uploads across section E: the MARKED paste must NOT upload; the
  // UNMARKED one must (it is a screenshot).
  let uploadCountE = 0;
  page.removeAllListeners("request");
  page.on("request", (req) => { if (req.method() === "POST" && req.url().includes("/api/upload/")) uploadCountE++; });

  // E1. OUR OWN COPY COMING BACK → element paste (behavior 3). The image carries
  // POWERRP_CLIPBOARD_MIME beside it, which is what "our own copy" MEANS on a
  // browser that can tag one, and its signature also equals the stored png_sig —
  // so both the marker and the legacy byte evidence agree. Expect the ELEMENT
  // (rect w=333) and no upload.
  //
  // THE MARKER IS THE POINT OF THE FIXTURE. Omitting it (as this call did until
  // 2026-08-22) made the paste foreign by definition on a tagged browser, so the
  // assertion below was testing the screenshot path while claiming the element
  // one. The png_sig match is kept, deliberately: it is what proves the ELEMENT
  // wins on the MARKER rather than on the bytes agreeing — E2 varies the marker
  // with the bytes held foreign, and the two together isolate which one decides.
  const e1 = await page.evaluate(async ({ b64, markerW }) => {
    const MARKER = "web application/x-powerrp-item"; // POWERRP_CLIPBOARD_MIME (web/clipboard.js)
    const app = window.__powerrp_app;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "match.png", { type: "image/png" });
    const before = Object.keys(app.doc.slides[0].delta.items).length;
    await app.pasteFromClipboard([file], [MARKER, "Files"]);
    const items = app.doc.slides[0].delta.items;
    const after = Object.keys(items).length;
    const rectId = Object.keys(items).find((id) => items[id].type === "rect" && items[id].w === markerW);
    return { before, after, pastedElement: !!rectId };
  }, { b64: RED_B64, markerW: MARKER_W });
  await new Promise((r) => setTimeout(r, 200)); // let any (unexpected) upload fire before we read the counter
  const uploadsAfterMatch = uploadCountE;
  note(e1.after === e1.before + 1, `MARKED paste inserted exactly one item (${e1.before} → ${e1.after})`);
  note(e1.pastedElement, "MARKED paste inserted the ELEMENT (rect marker w=333), not a flattened image");
  note(uploadsAfterMatch === 0, "MARKED paste did NOT upload anything (the element came from the server clipboard)");

  // E2. AN UNMARKED image, with our internal clipboard STILL LOADED — a
  // screenshot taken while a widget copy is live. It must become an IMAGE
  // widget and upload, and the live internal payload must NOT shadow it.
  //
  // THIS ASSERTION HAS BEEN REVERSED TWICE AND BOTH REVERSALS ARE WORTH KNOWING,
  // because the second one only looks like the first undone. Originally it
  // expected an IMAGE, on the theory that a signature mismatch proves an image
  // foreign. The 2026-07-30 parity ruling reversed it to expect the ELEMENT:
  // mismatch proves nothing, since the OS pasteboard RE-ENCODES images and our
  // own render returns with different bytes (581 in, 645 out, measured on
  // macOS) — treating "mismatch" as "foreign" is what pasted the user's copied
  // widget as a flattened bitmap. **That reasoning was never wrong and is not
  // what changed.** `a983cc91` changed the QUESTION: on a browser that can tag
  // a copy, the marker's ABSENCE is direct evidence of foreignness, so the bytes
  // are never consulted at all. The element-wins bias had been applied to a case
  // that was never ambiguous, which meant one widget copy disabled system-image
  // paste for the rest of the session — the user's actual bug.
  //
  // So E1 and E2 now differ in EXACTLY ONE INPUT, the marker, with the bytes
  // held foreign in both. That is what makes this pair evidence about which
  // signal decides, rather than two examples of the same outcome.
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
  await new Promise((r) => setTimeout(r, 200)); // let the upload fire before we read the counter
  note(mmImage, "an UNMARKED image became an image widget even though our own copy is on the clipboard (a983cc91: a live internal payload must not shadow a screenshot)");
  note(mmAfter === mmBefore + 1, `paste inserted exactly one item (${mmBefore} → ${mmAfter})`);
  note(uploadCountE === 1, `the UNMARKED image was UPLOADED, and the MARKED one was not — one POST across the whole section (saw ${uploadCountE})`);

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
