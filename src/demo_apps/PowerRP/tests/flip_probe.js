/**
 * THE FLIP — end-to-end browser probe (user: "we need flip horizontal and flip
 * vert tools in our command palette....and thus the abilitty to have a negative
 * height or width").
 *
 * Boots the real editor with the demo deck and exercises BOTH halves of the
 * feature against the live app:
 *
 *   COMMANDS — flip-h / flip-v through the command registry (app.runCommand, the
 *     same path the palette uses): the two-leaf write, the footprint invariant, the
 *     double-flip identity, ONE undo unit, the equation refusal, and the fact that
 *     a SINGLE selection enables them (unlike align/mirror, which need two).
 *   DRAG — dragging a resize handle PAST the opposite edge with page.mouse, which
 *     is the affordance the removed inversion clamp unlocked (web/canvas/dragKinds.js
 *     resizedBox, "CORRECTING THE RECORD"). Real pointer events are required: the
 *     canvas calls setPointerCapture, which synthetic dispatch cannot satisfy.
 *
 * "ONE undo unit" is measured by JSON COMPARE, never reference identity — undo()
 * restores an EQUAL document through a fresh reactive proxy.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/flip_probe.js
 *
 * Demo bbox items: rect c5c2bed3 (120,160,260,160), circle 0f3d6775
 * (760,200,180,180), text 5420a650 (120,60,260,48).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

// Locate the tree from THIS FILE, never process.cwd() (tests/probe_artifact_path_test.js).
const powerrp = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(powerrp, "web");
const demoJson = await readFile(resolve(powerrp, "examples/demo.powerrp.json"), "utf8");

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
  // STORED boxes (a flip's whole point is a negative STORED extent; the derived
  // node normalizes it away, so reading nodes here would hide the feature).
  const stored = () => page.evaluate((ids) => {
    const app = window.__powerrp_app;
    const s = app.rawState();
    return ids.map((id) => ({ id, x: s.items[id].x, y: s.items[id].y, w: s.items[id].w, h: s.items[id].h }));
  }, IDS);
  // The DERIVED world AABB — what the widget actually covers on screen.
  const aabbs = () => page.evaluate((ids) => {
    const app = window.__powerrp_app;
    return ids.map((id) => {
      const n = app.nodes().find((nn) => nn.itemId === id);
      const { x, y, w, h } = n.state;
      const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([lx, ly]) => {
        const c = Math.cos(n.world.rotation), si = Math.sin(n.world.rotation), k = n.world.scale;
        return { x: n.world.x + k * (c * lx - si * ly), y: n.world.y + k * (si * lx + c * ly) };
      });
      const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
      return { id, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    });
  }, IDS);
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const canUndo = () => page.evaluate(() => window.__powerrp_app.undoLog.canUndo);
  const runCmd = (id) => page.evaluate((cmdId) => window.__powerrp_app.runCommand(cmdId), id);
  const select = (ids) => page.evaluate((a) => window.__powerrp_app.selectMany(a), ids);
  const undo = () => page.evaluate(() => window.__powerrp_app.undo());
  const gate = (id) => page.evaluate((cid) => window.__powerrp_app.commands.get(cid).when(window.__powerrp_app), id);

  const initialStored = await stored();
  const initialAabb = await aabbs();
  const initialDoc = await docJson();

  // ── flip-h on ONE item: the two-leaf write ────────────────────────────────
  await select([RECT]);
  check("flip-h is ENABLED on a single selection (unlike align/mirror)", await gate("flip-h") === true);
  check("flip-v is ENABLED on a single selection", await gate("flip-v") === true);
  await runCmd("flip-h");
  let after = await stored();
  const r0 = initialStored[0], r1 = after[0];
  check("flip-h: w NEGATES", approx(r1.w, -r0.w), JSON.stringify({ before: r0.w, after: r1.w }));
  check("flip-h: x advances by exactly scale*w", approx(r1.x, r0.x + r0.w), JSON.stringify({ before: r0.x, after: r1.x }));
  check("flip-h: y and h UNTOUCHED (minimal delta — an equation on the other axis survives)",
    r1.y === r0.y && r1.h === r0.h, JSON.stringify(r1));
  check("flip-h: the OTHER selected items are untouched",
    JSON.stringify(after.slice(1)) === JSON.stringify(initialStored.slice(1)));
  // THE PROPERTY THE USER ASKED FOR: same screen rect, mirrored content.
  let aabb = await aabbs();
  check("flip-h: the world AABB is UNCHANGED (same footprint, mirrored)",
    JSON.stringify(aabb) === JSON.stringify(initialAabb), JSON.stringify({ initialAabb, aabb }));
  check("flip-h: ONE undo unit", await canUndo());
  await undo();
  check("flip-h: undo restores the document (JSON compare, not identity)",
    await docJson() === initialDoc);

  // ── DOUBLE FLIP is the identity, live ─────────────────────────────────────
  await select([RECT]);
  await runCmd("flip-h");
  await runCmd("flip-h");
  check("flip-h twice returns the EXACT original geometry",
    JSON.stringify(await stored()) === JSON.stringify(initialStored), JSON.stringify(await stored()));
  await undo(); await undo();
  check("two flips are two undo units", await docJson() === initialDoc);

  // ── flip-v ────────────────────────────────────────────────────────────────
  await select([RECT]);
  await runCmd("flip-v");
  after = await stored();
  check("flip-v: h NEGATES and y advances by scale*h",
    approx(after[0].h, -r0.h) && approx(after[0].y, r0.y + r0.h), JSON.stringify(after[0]));
  check("flip-v: x and w UNTOUCHED", after[0].x === r0.x && after[0].w === r0.w);
  aabb = await aabbs();
  check("flip-v: the world AABB is UNCHANGED", JSON.stringify(aabb) === JSON.stringify(initialAabb));
  await undo();

  // ── MULTI-selection flips each item IN PLACE (PowerPoint reading) ──────────
  await select(IDS);
  await runCmd("flip-h");
  after = await stored();
  check("multi flip-h: every selected item's w negated",
    after.every((b, i) => approx(b.w, -initialStored[i].w)), JSON.stringify(after));
  check("multi flip-h: each stays in place (its own AABB unchanged)",
    JSON.stringify(await aabbs()) === JSON.stringify(initialAabb));
  check("multi flip-h: still ONE undo unit for the whole selection", await canUndo());
  await undo();
  check("multi flip-h undo restores everything", await docJson() === initialDoc);

  // ── THE EQUATION REFUSAL ──────────────────────────────────────────────────
  // A flip writes BOTH leaves of an axis, so a stored equation on either would be
  // silently replaced by a literal. It must refuse and change NOTHING.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.selectMany([id]);
    app.setPreview([[["items", id, "x"], "= camera.x + 20"]]);
    app.commitPreview();
  }, RECT);
  const boundDoc = await docJson();
  const errsBefore = errors.length;
  await select([RECT]);
  await runCmd("flip-h");
  check("flip-h REFUSES when x holds an equation — document UNCHANGED",
    await docJson() === boundDoc, "the bound x was overwritten");
  check("flip-h reports the refusal loudly (never a silent no-op)",
    errors.length > errsBefore, JSON.stringify(errors.slice(errsBefore)));
  // AND SO DOES THE SECOND CLICK. The refusal used to go through core/report.reportOnce,
  // whose dedup set is never cleared — so the first press answered and every press after
  // it refused in TOTAL SILENCE, which reads as a broken tool rather than a refused one.
  // A user cannot flood a console at frame rate by clicking, so there is nothing to
  // throttle here (core/report.js reportAction).
  const errsBeforeRepeat = errors.length;
  await runCmd("flip-h");
  check("flip-h answers the SECOND identical refusal too (a deduped report would be silent)",
    errors.length > errsBeforeRepeat, JSON.stringify(errors.slice(errsBeforeRepeat)));
  check("the repeated refusal still changed NOTHING", await docJson() === boundDoc);
  await undo(); // drop the equation write
  check("equation write undone", await docJson() === initialDoc);

  // ── A GROUP FLIPS AS ONE OBJECT (its members, not its armature) ───────────
  // A group is an ARMATURE: members inherit its {x,y,rotation,scale} similarity and
  // explicitly NOT its w/h, and a similarity has no handedness — so a group cannot
  // transmit a reflection. The flip therefore recurses to the MEMBERS (each flipped
  // in place) AND reflects their positions about the members' union center, which
  // together IS the reflection of the whole assembly. The group's own frame is left
  // alone: writing its x would translate every member through the influence.
  const groupIds = await page.evaluate((ids) => {
    const app = window.__powerrp_app;
    app.selectMany(ids);
    app.groupSelection();
    const g = app.selectedNodes().find((n) => n.type === "group");
    return { groupId: g?.itemId ?? null, members: g ? [...g.state.members] : [] };
  }, [RECT, CIRCLE]);
  check("a group was created for the group-flip check", groupIds.groupId !== null && groupIds.members.length === 2, JSON.stringify(groupIds));
  if (groupIds.groupId) {
    const groupDoc = await docJson();
    const readAll = () => page.evaluate((o) => {
      const s = window.__powerrp_app.rawState();
      const one = (id) => ({ id, x: s.items[id].x, y: s.items[id].y, w: s.items[id].w, h: s.items[id].h });
      return { group: one(o.groupId), members: o.members.map(one) };
    }, groupIds);
    const before = await readAll();
    // The reflection line: the center of the members' union (forward-normalized).
    const unionCx = (() => {
      const lo = Math.min(...before.members.map((b) => Math.min(b.x, b.x + b.w)));
      const hi = Math.max(...before.members.map((b) => Math.max(b.x, b.x + b.w)));
      return (lo + hi) / 2;
    })();
    await page.evaluate((gid) => window.__powerrp_app.selectMany([gid]), groupIds.groupId);
    check("flip-h is enabled on a GROUP selection (via its bbox members)", await gate("flip-h") === true);
    await runCmd("flip-h");
    const afterG = await readAll();
    check("group flip-h: the GROUP's own frame is UNTOUCHED (an armature carries no reflection)",
      JSON.stringify(afterG.group) === JSON.stringify(before.group), JSON.stringify({ before: before.group, after: afterG.group }));
    check("group flip-h: every MEMBER's w negated (each member's own content flipped)",
      afterG.members.every((b, i) => approx(b.w, -before.members[i].w)), JSON.stringify(afterG.members));
    check("group flip-h: every member's CENTER reflected about the group's union center",
      afterG.members.every((b, i) => {
        const cx0 = before.members[i].x + before.members[i].w / 2;
        const cx1 = b.x + b.w / 2;
        return approx(cx1, 2 * unionCx - cx0);
      }), JSON.stringify({ unionCx, before: before.members, after: afterG.members }));
    check("group flip-h: y/h untouched on every member", afterG.members.every((b, i) => b.y === before.members[i].y && b.h === before.members[i].h));
    check("group flip-h: ONE undo unit for the whole group", await canUndo());
    await runCmd("flip-h");
    check("group flip-h twice is the identity", JSON.stringify(await readAll()) === JSON.stringify(before), JSON.stringify(await readAll()));
    await undo(); await undo();
    check("group flips undone", await docJson() === groupDoc);
    await undo(); // drop the grouping itself (groupSelection was its own undo unit)
  }
  check("group check left the document as it found it", await docJson() === initialDoc, "group check leaked a change");

  // ── DRAG A HANDLE PAST THE OPPOSITE EDGE (the removed clamp) ──────────────
  // Real pointer events: CanvasView calls setPointerCapture, so page.mouse is the
  // only driver that works.
  await select([RECT]);
  await new Promise((r) => setTimeout(r, 150));
  const overlayBox = await page.evaluate(() => {
    const el = document.querySelector(".overlay");
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  // Find the MIDDLE-RIGHT handle: the rect.handle whose center is nearest the box's
  // right-middle in screen space (the handle id is not in the DOM).
  const handle = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const s = app.rawState().items[id];
    const target = app.canvasActions.worldToScreen(s.x + s.w, s.y + s.h / 2);
    let best = null;
    for (const el of document.querySelectorAll("rect.handle")) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = (cx - target.x - document.querySelector(".overlay").getBoundingClientRect().left) ** 2
        + (cy - target.y - document.querySelector(".overlay").getBoundingClientRect().top) ** 2;
      if (!best || d < best.d) best = { d, cx, cy };
    }
    return best;
  }, RECT);
  check("found a resize handle to drag", handle !== null && handle.d < 400, JSON.stringify(handle));
  if (handle) {
    // Drag the east handle to a WORLD point 120 units LEFT of the west edge, so the
    // box passes clean through zero. The target is computed with the app's own
    // world→screen mapping, so no zoom arithmetic is duplicated here. Stepped, so
    // the drag handler sees intermediate moves (and would have clamped at each one).
    const target = await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const s = app.rawState().items[id];
      const p = app.canvasActions.worldToScreen(s.x - 120, s.y + s.h / 2);
      const r = document.querySelector(".overlay").getBoundingClientRect();
      return { x: p.x + r.left, y: p.y + r.top };
    }, RECT);
    await page.mouse.move(handle.cx, handle.cy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(handle.cx + ((target.x - handle.cx) * i) / 8, handle.cy + ((target.y - handle.cy) * i) / 8);
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 150));
    const dragged = (await stored())[0];
    check("DRAG PAST THE EDGE stores a NEGATIVE width (the clamp is gone)",
      dragged.w < 0, JSON.stringify(dragged));
    check("drag-flip keeps the FIXED (west) edge fixed — no jump when it inverts",
      approx(dragged.x, r0.x), JSON.stringify({ expected: r0.x, got: dragged.x }));
    check("drag-flip: the widget DERIVES to a positive box (nothing downstream sees the sign)",
      await page.evaluate((id) => {
        const n = window.__powerrp_app.nodes().find((nn) => nn.itemId === id);
        return n.state.w > 0 && n.mirror?.x === true;
      }, RECT), "derived node did not normalize");
    check("drag-flip: ONE undo unit", await canUndo());
    await undo();
    check("drag-flip undo restores the document", await docJson() === initialDoc);
  }

  check("zero NEW console errors beyond the intentional refusal report",
    errors.length === bootErrors + (errors.length - errsBefore),
    JSON.stringify(errors.slice(bootErrors)));

  if (failures.length) {
    console.error(`FAILURES (${failures.length}):`);
    for (const f of failures) console.error("  - " + f);
    process.exitCode = 1;
  } else {
    console.log("flip_probe: ALL CHECKS PASSED");
  }
} finally {
  await browser.close();
  await server.close();
}
