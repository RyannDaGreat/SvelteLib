/**
 * IN-CANVAS MULTIPOINT EDITING probe — the island (web/MultipointIsland.svelte in
 * the handle bar), its commands and the canvas gestures, in the REAL editor with
 * real pointer/keyboard input (page.mouse / page.keyboard, which go through
 * CanvasView's pointer capture and App's keydown dispatch).
 *
 * Proves, each edit as EXACTLY ONE undo unit (whole-document JSON compare, undo then
 * redo):
 *   - the island is up for a selected Multipoint widget with NO handle selected, and
 *     the HintBar announces the double-click;
 *   - DOUBLE-CLICKING A POINT opens its colour picker, and a pick changes only that
 *     point's colour;
 *   - DOUBLE-CLICKING A LINE splits it exactly there (the new node is on the line,
 *     colours untouched) and selects the new node;
 *   - `C` opens the colour AT that new node, and the first pick inserts a stop there;
 *   - +Point arms click-to-place; a click puts the source where it was clicked and
 *     opens its colour;
 *   - a two-handle selection is recoloured at once;
 *   - Two sides, Split (armed) and Reverse from the island;
 *   - undoing every step restores the original document exactly.
 * Screenshots (read them): .scratchpad/multipoint_ui/canvas/*.png
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/multipoint_canvas_probe.js
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { freePort } from "./free_port.js";
import { featureNodeOffset } from "../core/multipoint_edit.js";
import { evalCubic } from "../core/morph_geometry.js";
import { nodeCubic } from "../core/multipoint.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const artifacts = resolve(repo, ".scratchpad/multipoint_ui/canvas");
await mkdir(artifacts, { recursive: true });
// Concurrent Vite servers corrupt a shared dep cache (CLAUDE.md); run_all.mjs sets a
// per-slot one, and a direct run gets its own.
process.env.POWERRP_VITE_CACHE_DIR ??= resolve(artifacts, `vite-cache-${process.pid}`);
const BOOT_TIMEOUT = 60_000;
/** Screen-pixel quantization of a click, in paint-box units, for an 800px box: a
 *  couple of device pixels, never a design tolerance. */
const CLICK_UNIT_SLACK = 4 / 800;
const BOX = { x: 200, y: 120, w: 800, h: 450 };
const FEATURES = [
  { nodes: [[0.2, 0.3, 0, 0, 0, 0]], stops: [{ offset: 0, color: "#ff8800", rightColor: "#ff8800" }], weight: 1, twoSided: false, closed: false },
  { nodes: [[0.15, 0.75, 0, 0, 0, 0], [0.85, 0.75, 0, 0, 0, 0]], stops: [{ offset: 0, color: "#2255ff", rightColor: "#2255ff" }, { offset: 1, color: "#22ddaa", rightColor: "#22ddaa" }], weight: 1, twoSided: false, closed: false },
  { nodes: [[0.5, 0.15, 0, 0, 0.15, 0], [0.8, 0.45, 0, -0.15, 0, 0]], stops: [{ offset: 0, color: "#cc33ff", rightColor: "#cc33ff" }], weight: 1, twoSided: false, closed: false },
];
// Boot noise that is not this feature's business (the pipeline probe's list), plus
// nothing else: every other console error fails the probe.
const EXPECTED = [/^PowerRP storage: LOCAL/, /^No available adapters\.$/, /VideoV7: WebGPU init failed/, /videoV8: WebGPU backend unavailable/, /GL Driver Message/, /PowerRP repair:/, /was missing font/];

let server, browser, page, id;
const errors = [];
let commits = 0;

/** Command. Two animation frames, so Svelte and the overlay settle. */
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Query. The whole document as JSON — what "one undo unit" is measured against. */
const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
/** Query. The stored fill (plain JSON, never a proxy). */
const fill = () => page.evaluate((id) => JSON.stringify(window.__powerrp_app.rawState().items[id].fill), id).then(JSON.parse);
/** Query. The handle selection as a plain array. */
const selectedIds = () => page.evaluate(() => JSON.stringify([...window.__powerrp_app.handleSelection])).then(JSON.parse);

/** Query. Page coordinates of a paint-box point (u, v) on the unrotated fixture. */
async function unitToPage(u, v) {
  return page.evaluate((id, u, v) => {
    const a = window.__powerrp_app, n = a.nodes().find((x) => x.itemId === id);
    if (n.world.rotation !== 0) throw new Error("fixture must be unrotated");
    const s = a.canvasActions.worldToScreen(n.world.x + u * n.state.w * n.world.scale, n.world.y + v * n.state.h * n.world.scale);
    const r = document.querySelector("svg.overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, id, u, v);
}

/** Query. Page coordinates of a handle, asserting a real DOM glyph is there. */
async function handleToPage(handleId) {
  return page.evaluate((handleId) => {
    const a = window.__powerrp_app, h = a.handles().find((x) => x.id === handleId);
    if (!h) throw new Error(`missing handle ${handleId}; have ${a.handles().map((x) => x.id)}`);
    const s = a.canvasActions.worldToScreen(h.x, h.y), r = document.querySelector("svg.overlay").getBoundingClientRect();
    const p = { x: r.left + s.x, y: r.top + s.y };
    const hit = document.elementFromPoint(p.x, p.y)?.closest("[data-handle-id]")?.dataset.handleId;
    if (hit !== handleId) throw new Error(`the glyph under ${handleId} is ${hit}`);
    return p;
  }, handleId);
}

/** Command. Asserts `action` commits exactly ONE undo unit (undo restores, redo
 *  re-applies). `justAfter` runs before the undo: UI state set AFTER a commit (the
 *  new selection) is not part of that commit's snapshot, so undo/redo restore the
 *  selection as it was when the edit was made — the app's snapshot rule. */
async function oneUndo(label, action, justAfter = async () => {}) {
  const before = await docJson();
  await action();
  await settle();
  await justAfter();
  const after = await docJson();
  assert.notEqual(after, before, `${label}: must commit an edit`);
  await page.evaluate(() => window.__powerrp_app.undo());
  assert.equal(await docJson(), before, `${label}: one undo restores the document`);
  await page.evaluate(() => window.__powerrp_app.redo());
  assert.equal(await docJson(), after, `${label}: one redo re-applies it`);
  await settle();
  commits++;
  console.log(`PASS ${label} (one undo unit)`);
}

/** Command. Drags across the n-th open picker's saturation square (a real gesture). */
async function pick(fieldIndex, fx, fy) {
  const squares = await page.$$(".handle-color-field .cp-square");
  assert.ok(squares[fieldIndex], `picker ${fieldIndex} is open`);
  const box = await squares[fieldIndex].boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 5 });
  await page.mouse.up();
}

/** Query. The visible HintBar chips as "keys|label" strings. */
const hints = () => page.$$eval(".hintbar .hint", (els) => els.map((el) => `${el.querySelector(".keys").textContent.trim()}|${el.querySelector(".label").textContent.trim()}`));

/** Command. Saves a screenshot of the canvas area for visual review. */
async function shot(name) {
  await page.screenshot({ path: resolve(artifacts, `${name}.png`) });
  console.log(`SHOT ${resolve(artifacts, `${name}.png`)}`);
}

try {
  server = await createServer({ configFile: resolve(here, "../web/vite.config.js"), server: { port: await freePort(), strictPort: true, host: "127.0.0.1", open: false, hmr: false, watch: null } });
  await server.listen();
  const url = new URL(`http://127.0.0.1:${server.httpServer.address().port}/`);
  url.searchParams.set("static", "1"); // browser-local storage: no project backend needed
  browser = await launchBrowser({ timeout: BOOT_TIMEOUT, protocolTimeout: BOOT_TIMEOUT });
  page = await browser.newPage();
  page.setDefaultTimeout(BOOT_TIMEOUT);
  await page.setViewport({ width: 1400, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (EXPECTED.some((re) => re.test(text))) return;
    if (/Failed to load resource: the server responded with a status of 404/.test(text) && /\/api\//.test(m.location().url ?? "")) return;
    errors.push(`console.error: ${text}`);
  });
  await page.goto(url.href, { waitUntil: "networkidle0", timeout: BOOT_TIMEOUT });
  await page.waitForFunction(() => window.__powerrp_app?.canvasActions && document.querySelector("svg.overlay") && !document.getElementById("boot-splash"), { timeout: BOOT_TIMEOUT });

  id = await page.evaluate((box, features) => {
    const a = window.__powerrp_app;
    a.clearDoc();
    a.addItem({ ...a.registry.get("rect").defaults, type: "rect", ...box, strokeWidth: 0, fill: { type: "multipointGradient", multipoint: { features } } });
    a.selection = a.selection; // keep it selected, handles visible
    return a.selection;
  }, BOX, FEATURES);
  await settle();
  const initialDoc = await docJson();

  // ── the island at rest ──────────────────────────────────────────────────────
  await page.waitForSelector(".multipoint-island", { visible: true });
  for (const title of ["Add Multipoint Point Source (click to place)", "Add Multipoint Line Source (click to place)", "Add Multipoint Curve Source (click to place)", "Split Multipoint Path (click the path)"])
    assert.ok(await page.$(`.multipoint-island [aria-label="${title}"]`), `island offers ${title}`);
  assert.equal(await page.$$eval(".multipoint-island [aria-disabled='true']", (els) => els.length), 0, "add/split are available on a Multipoint widget");
  assert.ok((await hints()).some((h) => h.endsWith("|Point colour / split path")), `HintBar announces the double-click: ${await hints()}`);
  assert.equal(await page.evaluate(() => window.__powerrp_app.commands.search("split multipoint")[0].id), "multipoint-split-path", "the palette finds the island's commands");
  await page.mouse.move(5, 5);
  await shot("01-island-resting");
  console.log("PASS island is up with no handle selected; HintBar + palette surface it");

  // ── double-click a point → its colour ──────────────────────────────────────
  let p = await handleToPage("fill-mp-0-node-0");
  await page.mouse.click(p.x, p.y, { clickCount: 2 });
  await settle();
  assert.deepEqual(await selectedIds(), ["fill-mp-0-node-0"]);
  assert.equal(await page.evaluate(() => window.__powerrp_app.handleColorOpen), true, "double-click opens the colour");
  await page.waitForSelector(".handle-color-field .cp-square", { visible: true });
  await shot("02-dblclick-point-colour");
  const beforePointColour = await fill();
  await oneUndo("double-clicked point: pick recolours it", () => pick(0, 0.85, 0.2));
  const afterPointColour = await fill();
  const expectedPoint = structuredClone(beforePointColour);
  expectedPoint.multipoint.features[0].stops[0].color = afterPointColour.multipoint.features[0].stops[0].color;
  assert.notEqual(expectedPoint.multipoint.features[0].stops[0].color, "#ff8800");
  assert.deepEqual(afterPointColour, expectedPoint, "only that point's colour changed");

  // ── double-click a line → split exactly there ──────────────────────────────
  const SPLIT_U = 0.4;
  p = await unitToPage(SPLIT_U, 0.75);
  const beforeSplit = await fill();
  await oneUndo("double-click on a line splits it", async () => { await page.mouse.click(p.x, p.y, { clickCount: 2 }); },
    async () => assert.deepEqual(await selectedIds(), ["fill-mp-1-node-1"], "the new node is selected"));
  // Put the post-split selection back (undo/redo restored the one the edit was made with).
  await page.evaluate(() => window.__powerrp_app.selectHandle("fill-mp-1-node-1"));
  const afterSplit = await fill();
  const line = afterSplit.multipoint.features[1];
  assert.equal(line.nodes.length, 3);
  assert.ok(Math.abs(line.nodes[1][0] - SPLIT_U) < CLICK_UNIT_SLACK && Math.abs(line.nodes[1][1] - 0.75) < 1e-9, `new node on the line where clicked: ${line.nodes[1]}`);
  assert.deepEqual([line.nodes[0], line.nodes[2]].map((n) => n.slice(0, 2)), [[0.15, 0.75], [0.85, 0.75]], "the ends did not move");
  assert.deepEqual(line.stops, beforeSplit.multipoint.features[1].stops, "colours untouched by a split");

  // ── C → the colour AT that node; the first pick inserts a stop there ────────
  await page.evaluate(() => { window.__powerrp_app.handleColorOpen = false; });
  await settle();
  assert.ok((await hints()).some((h) => /\|Colour$/.test(h)), `HintBar shows the C chip: ${await hints()}`);
  await page.keyboard.press("c");
  await settle();
  assert.equal(await page.evaluate(() => window.__powerrp_app.handleColorOpen), true, "C opens the colour");
  await page.waitForSelector(".handle-color-field .cp-square", { visible: true });
  await shot("03-node-colour-pending");
  await oneUndo("first pick at a stop-less node inserts one stop", () => pick(0, 0.2, 0.3));
  const afterNodeColour = (await fill()).multipoint.features[1];
  assert.equal(afterNodeColour.stops.length, 3);
  const nodeOffset = featureNodeOffset(afterNodeColour, 1);
  assert.ok(Math.abs(afterNodeColour.stops[1].offset - nodeOffset) < 1e-12, "the stop sits exactly on the node");
  assert.deepEqual([afterNodeColour.stops[0], afterNodeColour.stops[2]], line.stops, "neighbouring stops unchanged");
  const againTargets = await page.evaluate(() => document.querySelectorAll(".handle-color-field").length);
  assert.equal(againTargets, 1, "after the insert the node edits that stop (one field)");

  // ── +Point: click to place ─────────────────────────────────────────────────
  await page.click('.multipoint-island [aria-label="Add Multipoint Point Source (click to place)"]');
  await settle();
  assert.equal(await page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId), "multipoint_place_point");
  assert.equal(await page.$eval('.multipoint-island [aria-label="Add Multipoint Point Source (click to place)"]', (el) => el.getAttribute("aria-pressed")), "true", "armed button shows pressed");
  assert.ok((await hints()).some((h) => h.endsWith("|Click inside the widget to place the point")), `mode narrates itself: ${await hints()}`);
  const PLACE = { u: 0.62, v: 0.58 };
  p = await unitToPage(PLACE.u, PLACE.v);
  await page.mouse.move(p.x - 30, p.y - 20);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await settle();
  await shot("04-place-point-hover");
  await oneUndo("click places a point source", async () => { await page.mouse.click(p.x, p.y); }, async () => {
    assert.equal(await page.evaluate(() => window.__powerrp_app.canvasMode), null, "one-shot: the mode ended");
    assert.deepEqual(await selectedIds(), ["fill-mp-3-node-0"], "the new point is selected");
    assert.equal(await page.evaluate(() => window.__powerrp_app.handleColorOpen), true, "placing opens its colour");
    await page.waitForSelector(".handle-color-field .cp-square", { visible: true });
    await shot("04b-placed-point-colour");
  });
  const afterPlace = await fill();
  assert.equal(afterPlace.multipoint.features.length, 4);
  const placed = afterPlace.multipoint.features[3].nodes[0];
  assert.ok(Math.abs(placed[0] - PLACE.u) < CLICK_UNIT_SLACK && Math.abs(placed[1] - PLACE.v) < CLICK_UNIT_SLACK, `placed where clicked: ${placed}`);

  // ── recolour a two-handle selection at once ────────────────────────────────
  p = await handleToPage("fill-mp-0-node-0");
  await page.mouse.click(p.x, p.y);
  const q = await handleToPage("fill-mp-3-node-0");
  await page.keyboard.down("Shift");
  await page.mouse.click(q.x, q.y);
  await page.keyboard.up("Shift");
  await settle();
  assert.deepEqual((await selectedIds()).sort(), ["fill-mp-0-node-0", "fill-mp-3-node-0"]);
  await page.evaluate(() => { window.__powerrp_app.handleColorOpen = false; });
  await page.keyboard.press("c");
  await settle();
  assert.equal(await page.$eval(".handle-color-field .multipoint-island-label", (el) => el.textContent.trim()), "Colour (2)");
  await shot("05-multi-recolour");
  const beforeMulti = await fill();
  await oneUndo("one pick recolours both selected points", () => pick(0, 0.3, 0.7));
  const afterMulti = await fill();
  const picked = afterMulti.multipoint.features[0].stops[0].color;
  assert.equal(afterMulti.multipoint.features[3].stops[0].color, picked);
  const expectedMulti = structuredClone(beforeMulti);
  expectedMulti.multipoint.features[0].stops[0].color = picked;
  expectedMulti.multipoint.features[3].stops[0].color = picked;
  assert.deepEqual(afterMulti, expectedMulti, "nothing else changed");

  // ── Two sides from the island → two colour fields ──────────────────────────
  p = await handleToPage("fill-mp-1-node-0");
  await page.mouse.click(p.x, p.y);
  await settle();
  await oneUndo("Two sides toggles the selected line", () => page.click('.multipoint-island [aria-label="Toggle Two-Sided Colours on Multipoint Paths"]'));
  assert.equal((await fill()).multipoint.features[1].twoSided, true);
  assert.deepEqual(await page.$$eval(".handle-color-field .multipoint-island-label", (els) => els.map((el) => el.textContent.trim())), ["Left colour", "Right colour"]);
  assert.equal(await page.$eval('.multipoint-island [aria-label="Toggle Two-Sided Colours on Multipoint Paths"]', (el) => el.getAttribute("aria-pressed")), "true");
  await shot("06-two-sided-node");

  // ── Split armed from the island, on the curve ──────────────────────────────
  await page.click('.multipoint-island [aria-label="Split Multipoint Path (click the path)"]');
  await settle();
  assert.equal(await page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId), "multipoint_split");
  const curve = FEATURES[2];
  const [cx, cy] = evalCubic(nodeCubic(curve.nodes[0], curve.nodes[1]), 0.5);
  p = await unitToPage(cx, cy);
  await page.mouse.move(p.x + 3, p.y + 3);
  await page.mouse.move(p.x, p.y, { steps: 2 });
  await settle();
  await shot("07-split-hover");
  await oneUndo("armed Split + click splits the curve", async () => { await page.mouse.click(p.x, p.y); });
  const splitCurve = (await fill()).multipoint.features[2];
  assert.equal(splitCurve.nodes.length, 3);
  assert.ok(Math.hypot(splitCurve.nodes[1][0] - cx, splitCurve.nodes[1][1] - cy) < CLICK_UNIT_SLACK * 2, "split point on the curve");

  // ── Reverse keeps the selection on the same physical node ──────────────────
  const beforeReverse = await page.evaluate(() => { const a = window.__powerrp_app; const h = a.selectedHandles()[0]; return { id: h.id, x: h.x, y: h.y }; });
  await oneUndo("Reverse from the island", () => page.click('.multipoint-island [aria-label="Reverse Multipoint Paths"]'), async () => {
    const afterReverse = await page.evaluate(() => { const a = window.__powerrp_app; const h = a.selectedHandles()[0]; return { id: h.id, x: h.x, y: h.y }; });
    assert.notEqual(afterReverse.id, beforeReverse.id, "the node's address changed");
    assert.ok(Math.hypot(afterReverse.x - beforeReverse.x, afterReverse.y - beforeReverse.y) < 1e-6, "…but the selection follows the same physical node");
  });

  // ── undo everything ────────────────────────────────────────────────────────
  for (let i = 0; i < commits; i++) await page.evaluate(() => window.__powerrp_app.undo());
  assert.equal(await docJson(), initialDoc, `undoing all ${commits} steps restores the original document`);
  console.log(`PASS undoing ${commits} steps restores the original document`);

  assert.deepEqual(errors, [], "no browser errors");
  console.log("PASS multipoint canvas island: double-click colour, split, pending-stop colour, click-to-place, multi-recolour, two sides, armed split, reverse, undo.");
} finally {
  await browser?.close();
  await server?.close();
}
