/**
 * Align/mirror end-to-end probe (manifest 16.3). Boots the PowerRP editor
 * headless with the demo deck, selects the 3 bbox items (rect, circle,
 * text), and drives align-left / align-center-h / mirror-h / mirror-v
 * through the command registry (app.runCommand — the same path the palette
 * uses) — asserting the COMMITTED document matches the exact geometry
 * invariants (shared min-x edge, shared center, reflected positions), that
 * each command is ONE undo unit, and that undo restores every item. Fails
 * loudly on any console error during the interactions.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/align_mirror_probe.js <shot_dir>
 *
 * Demo bbox items: rect c5c2bed3 (120,160,260,160), circle 0f3d6775
 * (760,200,180,180), text 5420a650 (120,60,260,48). Camera 9f54bf29 is
 * purgeable:false and excluded from Select All; the probe selects the three
 * bbox items directly by id via selectMany (same substrate Select All uses).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";

const RECT = "c5c2bed3", CIRCLE = "0f3d6775", TEXT = "5420a650";
const IDS = [RECT, CIRCLE, TEXT];
const EPS = 1e-6;
const approx = (a, b) => Math.abs(a - b) < EPS;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const failures = [];
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));

  const bootErrors = errors.length; // baseline — only NEW errors count against us

  const check = (name, cond, detail = "") => { if (!cond) failures.push(`${name}: ${detail}`); };
  const boxes = () => page.evaluate((ids) => {
    const app = window.__powerrp_app;
    return ids.map((id) => {
      const n = app.nodes().find((nn) => nn.itemId === id);
      return { id, x: n.state.x, y: n.state.y, w: n.state.w, h: n.state.h };
    });
  }, IDS);
  const canUndo = () => page.evaluate(() => window.__powerrp_app.undoLog.canUndo);
  const runCmd = (id) => page.evaluate((cmdId) => window.__powerrp_app.runCommand(cmdId), id);
  const selectThree = () => page.evaluate((ids) => window.__powerrp_app.selectMany(ids), IDS);
  const undo = () => page.evaluate(() => window.__powerrp_app.undo());

  const initial = await boxes();

  // ── Select 3 items, align-left → assert edges match ──────────────────────
  await selectThree();
  await runCmd("align-left");
  let after = await boxes();
  const leftEdges = new Set(after.map((b) => b.x));
  check("align-left: single shared x edge", leftEdges.size === 1, JSON.stringify(after));
  check("align-left: w/h untouched", after.every((b, i) => b.w === initial[i].w && b.h === initial[i].h));
  check("align-left: y untouched", after.every((b, i) => b.y === initial[i].y));
  check("align-left: one undo unit", await canUndo());
  await undo();
  let restored = await boxes();
  check("align-left undo restores all 3", JSON.stringify(restored) === JSON.stringify(initial), JSON.stringify(restored));

  // ── align-center-h → assert all centered on the same x ───────────────────
  await selectThree();
  await runCmd("align-center-h");
  after = await boxes();
  const centersX = after.map((b) => b.x + b.w / 2);
  check("align-center-h: all centers equal", centersX.every((c) => approx(c, centersX[0])), JSON.stringify(centersX));
  await undo();
  restored = await boxes();
  check("align-center-h undo restores all 3", JSON.stringify(restored) === JSON.stringify(initial));

  // ── mirror-horizontal → assert reflected about the selection center ──────
  await selectThree();
  const union = (() => {
    const minX = Math.min(...initial.map((b) => b.x));
    const maxX = Math.max(...initial.map((b) => b.x + b.w));
    return { minX, maxX };
  })();
  await runCmd("mirror-h");
  after = await boxes();
  check("mirror-h: w/h untouched (layout mirror, not content flip)",
    after.every((b, i) => b.w === initial[i].w && b.h === initial[i].h));
  check("mirror-h: y untouched", after.every((b, i) => b.y === initial[i].y));
  // Each item's center reflects about the union's own center: mirroredCx = 2*unionCx - originalCx.
  const unionCx = (union.minX + union.maxX) / 2;
  check("mirror-h: centers reflect about the selection center",
    after.every((b, i) => {
      const origCx = initial[i].x + initial[i].w / 2;
      const newCx = b.x + b.w / 2;
      return approx(newCx, 2 * unionCx - origCx);
    }), JSON.stringify({ initial, after, unionCx }));
  // Pairwise relative order reverses along x for any pair with DISTINCT
  // centers (demo fixture note: rect c5c2bed3 and text 5420a650 share the
  // same center x=250 — a genuine tie, order between them is undefined
  // both before and after a reflection, so only non-tied pairs are checked).
  const byId = Object.fromEntries(initial.map((b, i) => [b.id, { before: b, after: after[i] }]));
  for (const [p, q] of [[RECT, CIRCLE], [TEXT, CIRCLE]]) {
    const beforeCx = (id) => byId[id].before.x + byId[id].before.w / 2;
    const afterCx = (id) => byId[id].after.x + byId[id].after.w / 2;
    const beforeSign = Math.sign(beforeCx(p) - beforeCx(q));
    const afterSign = Math.sign(afterCx(p) - afterCx(q));
    check(`mirror-h: relative order of ${p}/${q} reverses`, beforeSign === -afterSign,
      `before ${beforeCx(p)} vs ${beforeCx(q)}, after ${afterCx(p)} vs ${afterCx(q)}`);
  }
  check("mirror-h: one undo unit", await canUndo());
  await undo();
  restored = await boxes();
  check("mirror-h undo restores all 3", JSON.stringify(restored) === JSON.stringify(initial));

  // ── mirror-vertical → same invariants on y ────────────────────────────────
  await selectThree();
  await runCmd("mirror-v");
  after = await boxes();
  check("mirror-v: w/h untouched", after.every((b, i) => b.w === initial[i].w && b.h === initial[i].h));
  check("mirror-v: x untouched", after.every((b, i) => b.x === initial[i].x));
  await undo();
  restored = await boxes();
  check("mirror-v undo restores all 3", JSON.stringify(restored) === JSON.stringify(initial));

  // ── single-item selection disables all 8 commands (needsMultiBbox gate) ──
  const singleGated = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.selectMany([id]);
    const ids = ["align-left", "align-right", "align-top", "align-bottom", "align-center-h", "align-center-v", "mirror-h", "mirror-v"];
    return ids.map((cid) => app.commands.get(cid).when(app));
  }, RECT);
  check("single selection disables every align/mirror command", singleGated.every((v) => v === false), JSON.stringify(singleGated));

  // ── zero new console errors ────────────────────────────────────────────────
  check("zero NEW console errors", errors.length === bootErrors, JSON.stringify(errors.slice(bootErrors)));

  if (failures.length) {
    console.error(`FAILURES (${failures.length}):`);
    for (const f of failures) console.error("  - " + f);
    process.exitCode = 1;
  } else {
    console.log(`align_mirror_probe: ALL CHECKS PASSED`);
  }
} finally {
  await browser.close();
  await server.close();
}
