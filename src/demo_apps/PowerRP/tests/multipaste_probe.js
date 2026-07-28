/**
 * MULTI-SELECT COPY/PASTE live probe — the app half of the subgraph clone.
 *
 * The user's ask: "when i select many objects and copy and paste, if they
 * reference each other in any properties of one another within that selection,
 * they should be rerouted to the new copies. and i should be able to copy paste
 * selections of objects which right now I can't".
 *
 * Drives the REAL editor (ephemeral uv-run python server + ephemeral Vite +
 * puppeteer, the clipboard_duplicate_probe.js isolation pattern: mkdtemp
 * POWERRP_PROJECTS_DIR, free ports, NEVER 3637/3638) and asserts:
 *
 *  A. A MULTI-SELECTION COPIES AT ALL. Band-select two wired circles + the arrow
 *     bound to them with a REAL page.mouse rubber-band drag (the
 *     bandselect_twopoint_probe.js gesture), copy, and read the server-side
 *     clipboard: the payload holds ALL THREE states keyed by their source ids.
 *     (Before this change copySelection shipped exactly one item — the primary
 *     selection — so the reroute question could never even arise.)
 *  B. INTERNAL REFERENCES REROUTE. The pasted arrow's endpoint bindings name the
 *     PASTED circles, not the originals, and the ORIGINAL arrow still names the
 *     original circles.
 *  C. EXTERNAL REFERENCES DO NOT. Copying the arrow ALONE and pasting it leaves
 *     both endpoints bound to the ORIGINAL circles — a copy that rerouted what it
 *     did not copy would break the arrow.
 *  D. ONE UNDO UNIT + THE PASTED SET IS SELECTED, measured by JSON COMPARE of the
 *     WHOLE document before/after (undo() restores an EQUAL document through a
 *     fresh reactive proxy, so reference identity proves nothing).
 *  E. RIGID TRANSLATION. Every pasted item moved by the same offset, so the
 *     selection's relative geometry survives.
 *  F. A GROUP travels with its members and the clone's `members` names the CLONES.
 *  G. THE SINGLE-ITEM PATH IS UNCHANGED: one selected rect copies, pastes offset
 *     by 16, one undo unit, clone selected.
 *  H. A LEGACY {powerrp_item: state} payload (no source id — what an older build
 *     left on the session clipboard) still pastes.
 *
 * EVALUATE GRANULARITY. Every page.evaluate here is SMALL, and an `await`ed one
 * returns nothing: one long async evaluate that both pasted and then read the
 * document back had its promise collected mid-flight (a destroyed execution
 * context takes the pending promise with it). Paste, settle, then READ in a
 * separate synchronous evaluate — the same shape clipboard_duplicate_probe.js
 * uses.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/multipaste_probe.js
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

// Paths resolve from THIS FILE, never process.cwd() (tests/probe_artifact_path_test.js).
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const SHOT_DIR = resolve(APP_DIR, ".claude_vlm_checks");
// The project server runs through uv (server.py carries PEP 723 inline deps) —
// the same portable launcher start_server.sh uses, so there is no hardcoded
// interpreter path. Override with POWERRP_UV if uv is not on PATH.
const UV = process.env.POWERRP_UV || "uv";

// The paste offset the clone home applies (app.svelte.js #cloneStatesIntoSlide).
const PASTE_OFFSET = 16;

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

const projectsRoot = mkdtempSync(join(tmpdir(), "powerrp_multipaste_"));
mkdirSync(SHOT_DIR, { recursive: true });
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
  // SwiftShader flags so the compositor inits headless (the editor renders through
  // it, and copySelection rasterizes its PNG through it); --no-sandbox is required
  // to launch as root. Same flag set the repo's other GPU probes use.
  browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // EXPECTED, correctly-reported headless noise — both are loud reports of
  // environment limitations (the no-silent-failure discipline WORKING), not
  // defects, and both are orthogonal to the clipboard path.
  const EXPECTED_NOISE = [
    /VideoV7: WebGPU init failed/,
    /OS-clipboard image write was denied or failed/,
  ];
  const isExpectedNoise = (t) => EXPECTED_NOISE.some((re) => re.test(t));
  const consoleErrors = [];
  const pageWarnings = [];
  page.on("pageerror", (e) => { if (!isExpectedNoise(e.message)) consoleErrors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => {
    if (m.type() === "error" && !isExpectedNoise(m.text())) consoleErrors.push(`console.error: ${m.text()}`);
    if (m.type() === "warning") pageWarnings.push(m.text());
  });

  await browser.defaultBrowserContext().overridePermissions(pageUrl, ["clipboard-read", "clipboard-write"]);
  await page.goto(pageUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));
  if (consoleErrors.length) throw new Error("PAGE ERRORS AT BOOT:\n" + consoleErrors.join("\n"));

  // ── Small helpers over the live app ────────────────────────────────────────
  /** Query. The current slide-0 delta's item ids. */
  const itemIds = () => page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items));
  /** Query. One item's stored delta subtree, JSON-cloned out of the reactive proxy. */
  const itemOf = (id) => page.evaluate((id) => JSON.parse(JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id] ?? null)), id);
  /** Query. The WHOLE document as JSON text — the only honest one-undo-unit measure
   *  (undo restores an EQUAL doc through a fresh proxy, never the same object). */
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  /** Command. Sets the selection to exactly `ids`. */
  const select = (ids) => page.evaluate((ids) => window.__powerrp_app.selectMany(ids), ids);
  /** Command (awaited, returns nothing — see EVALUATE GRANULARITY). */
  const copy = () => page.evaluate(async () => { await window.__powerrp_app.copySelection(); });
  const paste = () => page.evaluate(async () => { await window.__powerrp_app.pasteClipboard(); });
  const undo = () => page.evaluate(() => window.__powerrp_app.undo());
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  /** Query. The ids present now that were not in `before`. */
  const addedSince = async (before) => {
    const now = await itemIds();
    return now.filter((id) => !before.includes(id));
  };
  /** Pure function. The itemId a stored endpoint equation names ("@ab12_cm.x" → "ab12"). */
  const refIdOf = (equation) => (typeof equation === "string" ? equation.match(/^@([A-Za-z0-9-]+)_/)?.[1] ?? null : null);

  // ── The fixture: two circles and an arrow bound to BOTH of them ─────────────
  // The arrow's endpoints are the real binding shape (plugins/arrow.js: "equation
  // strings (@<itemId>_tm.x) written into from/to"), so the reroute under test is
  // the one the editor actually creates when you drag an endpoint onto a widget.
  const fixture = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.doc.meta.name = "multipaste_probe";
    app.addItem({ ...app.registry.get("circle").defaults, x: 200, y: 200, w: 60, h: 60 });
    const c1 = app.selection;
    app.addItem({ ...app.registry.get("circle").defaults, x: 400, y: 200, w: 60, h: 60 });
    const c2 = app.selection;
    app.addItem({
      ...app.registry.get("arrow").defaults,
      from: { x: `@${c1}_cm.x`, y: `@${c1}_cm.y` },
      to: { x: `@${c2}_cm.x`, y: `@${c2}_cm.y` },
    });
    return { c1, c2, ar: app.selection };
  });
  note(!!fixture.ar, `fixture built: circles ${fixture.c1}/${fixture.c2} + arrow ${fixture.ar} bound to both`);

  // ── A. A MULTI-SELECTION COPIES AT ALL (real rubber-band gesture) ───────────
  console.log("A. band-select the three wired items with the mouse, then copy");
  // World point → PAGE screen coords through the app's OWN worldToScreen + the
  // overlay's real rect, so the drag lands correctly at whatever zoom/pan the
  // live viewport has (bandselect_twopoint_probe.js's worldToPage).
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selectMany([]); // THE multi-select substrate — an empty set clears it
    app.armCrosshairBand("outer");
  });
  {
    // A band comfortably around the fixture (circles at 200/400, r=30; the arrow
    // runs between their centres) and nothing else.
    const a = await worldToPage(150, 150);
    const b = await worldToPage(500, 300);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await settle();
  }
  const banded = await page.evaluate(() => window.__powerrp_app.selectedIds());
  note(banded.length === 3 && [fixture.c1, fixture.c2, fixture.ar].every((id) => banded.includes(id)),
    `the real band drag selected exactly the three fixture items (got ${banded.length}: ${banded.join(", ")})`);

  await copy();
  const clip = await page.evaluate(async () => {
    const res = await fetch("/api/clipboard/", { credentials: "include" });
    const { payload } = await res.json();
    return payload;
  });
  let parsed = null;
  try { parsed = JSON.parse(clip); } catch { /* asserted below */ }
  const clipIds = Object.keys(parsed?.powerrp_items ?? {});
  note(clipIds.length === 3, `the clipboard payload holds ALL THREE selected states (got ${clipIds.length})`);
  note([fixture.c1, fixture.c2, fixture.ar].every((id) => clipIds.includes(id)),
    "the payload is KEYED BY SOURCE ID (what makes the reroute boundary knowable)");
  note(parsed?.powerrp_items?.[fixture.ar]?.from?.x === `@${fixture.c1}_cm.x`,
    "equations copy as equations (the arrow's binding, not its evaluated number)");

  // ── B/D/E. PASTE: reroute, one undo unit, rigid translation ────────────────
  console.log("B/D/E. paste the three: internal reroute, one undo unit, rigid offset");
  const origCircles = [await itemOf(fixture.c1), await itemOf(fixture.c2)];
  const docBeforePaste = await docJson();
  const idsBeforePaste = await itemIds();
  await paste();
  await settle();
  const newIds = await addedSince(idsBeforePaste);
  note(newIds.length === 3, `paste inserted all three items (got ${newIds.length})`);

  const newItems = [];
  for (const id of newIds) newItems.push({ id, ...(await itemOf(id)) });
  const newArrow = newItems.find((it) => it.type === "arrow");
  const newCircles = newItems.filter((it) => it.type === "circle");
  const newCircleIds = newCircles.map((c) => c.id);
  const fromId = refIdOf(newArrow?.from?.x);
  const toId = refIdOf(newArrow?.to?.x);
  note(newCircleIds.includes(fromId) && newCircleIds.includes(toId),
    `the PASTED arrow is bound to the PASTED circles (from @${fromId}, to @${toId}; pasted circles ${newCircleIds.join("/")})`);
  note(fromId !== fixture.c1 && toId !== fixture.c2, "the pasted arrow does NOT reference the originals");
  const origArrow = await itemOf(fixture.ar);
  note(origArrow?.from?.x === `@${fixture.c1}_cm.x` && origArrow?.to?.x === `@${fixture.c2}_cm.x`,
    "the ORIGINAL arrow still references the ORIGINAL circles (the source document is untouched)");

  // E. RIGID: every pasted item moved by the SAME offset ⇒ relative geometry kept.
  const sortedOrig = [...origCircles].sort((a, b) => a.x - b.x);
  const sortedNew = [...newCircles].sort((a, b) => a.x - b.x);
  const deltas = sortedNew.map((c, i) => ({ dx: c.x - sortedOrig[i].x, dy: c.y - sortedOrig[i].y }));
  note(deltas.every((d) => d.dx === PASTE_OFFSET && d.dy === PASTE_OFFSET),
    `every pasted item moved by the SAME (${PASTE_OFFSET}, ${PASTE_OFFSET}) — a rigid translation: ${JSON.stringify(deltas)}`);
  note(sortedNew[1].x - sortedNew[0].x === sortedOrig[1].x - sortedOrig[0].x,
    `the pasted pair keeps its spacing (${sortedOrig[1].x - sortedOrig[0].x} world units)`);

  // D. ONE undo unit + the pasted set is the selection.
  const selectedAfterPaste = await page.evaluate(() => window.__powerrp_app.selectedIds());
  note(selectedAfterPaste.length === 3 && selectedAfterPaste.every((id) => newIds.includes(id)),
    `the PASTED set is the new selection (${selectedAfterPaste.length} ids, all new)`);
  await undo();
  await settle();
  note((await docJson()) === docBeforePaste,
    "ONE undo restored a JSON-EQUAL document — the whole three-item paste is one undo unit");

  // ── C. EXTERNAL REFERENCES DO NOT REROUTE ──────────────────────────────────
  console.log("C. copy the arrow ALONE: its endpoints must still name the ORIGINAL circles");
  await select([fixture.ar]);
  await copy();
  const idsBeforeAlone = await itemIds();
  await paste();
  await settle();
  const [aloneId] = await addedSince(idsBeforeAlone);
  const aloneArrow = await itemOf(aloneId);
  note(aloneArrow?.from?.x === `@${fixture.c1}_cm.x` && aloneArrow?.to?.x === `@${fixture.c2}_cm.x`,
    "an arrow copied WITHOUT its circles pastes still bound to those circles (external edges survive)");

  // ── F. A GROUP travels with its members ────────────────────────────────────
  console.log("F. group the two circles, copy the group, paste");
  await select([fixture.c1, fixture.c2]);
  const groupId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.groupSelection();
    return app.selection;
  });
  const origMembers = (await itemOf(groupId))?.members ?? [];
  note(origMembers.length === 2, `the group controls both circles (${origMembers.length} members)`);
  await select([groupId]);
  await copy();
  const idsBeforeGroup = await itemIds();
  await paste();
  await settle();
  const groupNewIds = await addedSince(idsBeforeGroup);
  note(groupNewIds.length === 3, `copying the GROUP copied the group AND its two members (${groupNewIds.length} new items)`);
  let newGroup = null;
  for (const id of groupNewIds) {
    const it = await itemOf(id);
    if (it?.type === "group") newGroup = it;
  }
  const newMembers = newGroup?.members ?? [];
  note(newMembers.length === 2 && newMembers.every((id) => groupNewIds.includes(id)),
    `the pasted group's members name the PASTED members (${newMembers.join(", ")})`);
  note(newMembers.every((id) => !origMembers.includes(id)),
    "no pasted group steers an ORIGINAL item (the double-parenting hazard)");

  // ── G. THE SINGLE-ITEM PATH IS UNCHANGED ───────────────────────────────────
  console.log("G. the single-item copy/paste path is behaviourally unchanged");
  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("rect").defaults, x: 700, y: 300, w: 80, h: 60 });
    return app.selection;
  });
  const origRect = await itemOf(rectId);
  await select([rectId]);
  await copy();
  const docBeforeSingle = await docJson();
  const idsBeforeSingle = await itemIds();
  await paste();
  await settle();
  const singleNew = await addedSince(idsBeforeSingle);
  note(singleNew.length === 1, `a one-item copy pastes exactly one item (got ${singleNew.length})`);
  const singleClone = await itemOf(singleNew[0]);
  note(singleClone?.x === origRect.x + PASTE_OFFSET && singleClone?.y === origRect.y + PASTE_OFFSET,
    `the single clone is offset by ${PASTE_OFFSET} (${origRect.x}→${singleClone?.x}, ${origRect.y}→${singleClone?.y})`);
  const singleSelected = await page.evaluate(() => window.__powerrp_app.selectedIds());
  note(singleSelected.length === 1 && singleSelected[0] === singleNew[0], "the single clone is the selection");
  await undo();
  await settle();
  note((await docJson()) === docBeforeSingle, "one undo restores a JSON-EQUAL document");

  // ── H. A LEGACY {powerrp_item} payload still pastes ────────────────────────
  console.log("H. a LEGACY one-item payload (no source id) still pastes");
  const MARKER_W = 421;
  await page.evaluate(async (markerW) => {
    const app = window.__powerrp_app;
    const state = { ...app.registry.get("rect").defaults, active: true, z: 1, x: 900, y: 400, w: markerW, h: 50 };
    await fetch("/api/clipboard/", {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: JSON.stringify({ powerrp_item: state }) }),
    });
  }, MARKER_W);
  const idsBeforeLegacy = await itemIds();
  await paste();
  await settle();
  const legacyNew = await addedSince(idsBeforeLegacy);
  const legacyItem = legacyNew.length === 1 ? await itemOf(legacyNew[0]) : null;
  note(legacyNew.length === 1 && legacyItem?.w === MARKER_W,
    `a legacy {powerrp_item} clipboard payload pasted its one item (marker w=${legacyItem?.w})`);

  await page.screenshot({ path: join(SHOT_DIR, "multipaste_probe.png") });
  console.log(`  --  screenshot: ${join(SHOT_DIR, "multipaste_probe.png")}`);

  // The dangling-reference report is a WARNING, not an error. Nothing here should
  // trip it (every external edge in this fixture resolves in-document), so a hit
  // means the reroute boundary mis-classified something.
  const dangling = pageWarnings.filter((t) => /do not exist in this document/.test(t));
  note(dangling.length === 0, `no dangling-reference warnings fired — every external edge resolves in-document${dangling.length ? ": " + dangling.join(" | ") : ""}`);

  if (consoleErrors.length) throw new Error("PAGE ERRORS:\n" + consoleErrors.join("\n"));
} finally {
  if (browser) await browser.close();
  if (viteServer) await viteServer.close();
  server.kill("SIGTERM");
  rmSync(projectsRoot, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`\n${errors.length} multi-paste assertion(s) FAILED:`);
  for (const e of errors) console.error(`  FAIL  ${e}`);
  process.exit(1);
}
console.log("\nmulti-select copy/paste probe: all assertions passed");
