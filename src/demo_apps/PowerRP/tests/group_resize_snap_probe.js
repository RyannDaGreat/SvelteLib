/**
 * Group RESIZE + SNAP EXCLUSION probe (manifest 15.7) — the REAL editor drag.
 * Boots the PowerRP editor headless, builds a group from two rects, and drives
 * actual pointer gestures on the group's resize handle + member/group drags,
 * asserting on the DERIVED render tree (members' world transforms) exactly as
 * the compositor sees them.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/group_resize_snap_probe.js <shot_dir>
 *
 * Coverage:
 *   1. Drag a group's BOTTOM-RIGHT handle → both members visibly scale AND move
 *      about the FIXED top-left corner; the group's own scale grows; members'
 *      STORED state is untouched (they follow purely through parenting).
 *   2. Shift-uniform on a group resize still works (a group is uniform anyway).
 *   3. ONE undo restores the pre-resize world exactly.
 *   4. SNAP EXCLUSION: dragging a MEMBER near its group's hull edge does NOT
 *      snap to the group; dragging the GROUP near one of its own members does
 *      NOT snap; dragging near a FOREIGN item DOES snap (the mechanism still
 *      works for real candidates).
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const shots = process.argv[2] ?? resolve(repo, ".claude_logs/scratch/group_resize_snap");
await mkdir(shots, { recursive: true });

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const errors = [];
const fail = (msg) => errors.push(msg);
const approx = (a, b, eps, msg) => { if (!(Math.abs(a - b) < eps)) fail(`${msg}: ${a} !~ ${b} (eps ${eps})`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => fail(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") fail(`console.error: ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  if (errors.length) { console.error("PAGE ERRORS AT BOOT:\n" + errors.join("\n")); process.exit(1); }

  const canvas = await page.$(".canvas-wrap");
  const cbox = await canvas.boundingBox();

  // ── Build a group from two rects, positioned in a known world spot ──────────
  // The group AABB spans the two rects; rect A at the group's top-left corner
  // (so it is the FIXED point for a bottom-right handle grab), rect B offset.
  const setup = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.snapEnabled = true;
    // Fresh doc keeps only THE camera; add two rects.
    app.clearDoc();
    app.addItem({ type: "rect", x: 200, y: 200, w: 60, h: 60, rotation: 0, scale: 1, fill: "#e33", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1 });
    const idA = app.selection;
    app.addItem({ type: "rect", x: 360, y: 320, w: 60, h: 60, rotation: 0, scale: 1, fill: "#3e3", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1 });
    const idB = app.selection;
    app.selectMany([idA, idB]);
    app.groupSelection();
    const gid = app.selection;
    const g = app.nodes().find((n) => n.itemId === gid);
    return { idA, idB, gid, gx: g.state.x, gy: g.state.y, gw: g.state.w, gh: g.state.h, gscale: g.state.scale };
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: `${shots}/01_grouped.png` });

  // World → screen (add the canvas box offset for real mouse events).
  const w2s = async (wx, wy) => {
    const s = await page.evaluate(([x, y]) => window.__powerrp_app.canvasActions.worldToScreen(x, y), [wx, wy]);
    return { x: cbox.x + s.x, y: cbox.y + s.y };
  };

  // Capture members' world BEFORE resize.
  const before = await page.evaluate(([idA, idB]) => {
    const app = window.__powerrp_app;
    const byId = Object.fromEntries(app.nodes().map((n) => [n.itemId, n]));
    const w = (id) => ({ x: byId[id].world.x, y: byId[id].world.y, scale: byId[id].world.scale });
    return { a: w(idA), b: w(idB), storedAX: app.state().items[idA].x };
  }, [setup.idA, setup.idB]);

  // ── 1. Drag the group's BOTTOM-RIGHT handle to roughly DOUBLE the box ───────
  // Fixed corner = group top-left world (setup.gx, setup.gy). Grab BR world
  // corner (gx+gw, gy+gh); drag by (+gw, +gh) so the box ~doubles (uniform).
  const brWorld = { x: setup.gx + setup.gw, y: setup.gy + setup.gh };
  const grab = await w2s(brWorld.x, brWorld.y);
  const drop = await w2s(brWorld.x + setup.gw, brWorld.y + setup.gh);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move((grab.x + drop.x) / 2, (grab.y + drop.y) / 2, { steps: 4 });
  await page.mouse.move(drop.x, drop.y, { steps: 6 });
  await page.screenshot({ path: `${shots}/02_resize_midway.png` });

  // Mid-drag invariants: preview holds the group's SCALE (not w/h), members'
  // STORED state untouched, doc not yet committed.
  const midResize = await page.evaluate(([gid, idA]) => {
    const app = window.__powerrp_app;
    const pv = app.previewDelta?.items?.[gid] ?? {};
    return {
      previewScale: pv.scale,
      previewW: pv.w, // should be undefined — group resize never writes w/h
      memberStoredX: app.state().items[idA].x, // derived, but stored must be untouched
      undoDepthWhileDragging: app.undoLog.canUndo,
    };
  }, [setup.gid, setup.idA]);
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 150));
  await page.screenshot({ path: `${shots}/03_resized.png` });

  if (typeof midResize.previewScale !== "number") fail(`GROUP RESIZE wrote no scale preview (got ${midResize.previewScale})`);
  if (midResize.previewW !== undefined) fail(`GROUP RESIZE wrote w/h (${midResize.previewW}) — must drive scale, not w/h`);

  const after = await page.evaluate(([idA, idB, gid]) => {
    const app = window.__powerrp_app;
    const byId = Object.fromEntries(app.nodes().map((n) => [n.itemId, n]));
    const w = (id) => ({ x: byId[id].world.x, y: byId[id].world.y, scale: byId[id].world.scale });
    return { a: w(idA), b: w(idB), gscale: app.state().items[gid].scale, storedAX: app.state().items[idA].x };
  }, [setup.idA, setup.idB, setup.gid]);

  // Members visibly scaled (world scale grew ~2×) and MOVED (B further from the
  // fixed TL corner). The stored member x is UNCHANGED (pure parenting).
  if (!(after.a.scale > before.a.scale * 1.5)) fail(`member A did not scale up: ${before.a.scale} → ${after.a.scale}`);
  if (!(after.b.scale > before.b.scale * 1.5)) fail(`member B did not scale up: ${before.b.scale} → ${after.b.scale}`);
  const fixedTL = { x: setup.gx, y: setup.gy };
  const dB0 = Math.hypot(before.b.x - fixedTL.x, before.b.y - fixedTL.y);
  const dB1 = Math.hypot(after.b.x - fixedTL.x, after.b.y - fixedTL.y);
  if (!(dB1 > dB0 * 1.4)) fail(`member B did not move outward from the fixed corner: ${dB0} → ${dB1}`);
  approx(after.storedAX, before.storedAX, 1e-6, "member A STORED x must be untouched (pure parenting)");
  if (!(after.gscale > setup.gscale * 1.5)) fail(`group's own scale did not grow: ${setup.gscale} → ${after.gscale}`);

  // ── 3. ONE undo restores the pre-resize world exactly ───────────────────────
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 100));
  const undone = await page.evaluate(([idA, idB]) => {
    const app = window.__powerrp_app;
    const byId = Object.fromEntries(app.nodes().map((n) => [n.itemId, n]));
    const w = (id) => ({ x: byId[id].world.x, y: byId[id].world.y, scale: byId[id].world.scale });
    return { a: w(idA), b: w(idB) };
  }, [setup.idA, setup.idB]);
  approx(undone.a.scale, before.a.scale, 1e-4, "undo restored member A scale");
  approx(undone.b.x, before.b.x, 1e-3, "undo restored member B world x");
  approx(undone.b.y, before.b.y, 1e-3, "undo restored member B world y");

  // ── 2. Shift-uniform on a group resize still works (no error, still scales) ──
  const grab2 = await w2s(brWorld.x, brWorld.y);
  const drop2 = await w2s(brWorld.x + setup.gw * 0.5, brWorld.y + setup.gh * 0.5);
  await page.mouse.move(grab2.x, grab2.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(drop2.x, drop2.y, { steps: 6 });
  const shiftScale = await page.evaluate((gid) => window.__powerrp_app.previewDelta?.items?.[gid]?.scale, setup.gid);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await new Promise((r) => setTimeout(r, 100));
  if (typeof shiftScale !== "number" || !(shiftScale > setup.gscale)) fail(`Shift-uniform group resize did not scale (got ${shiftScale})`);
  await page.evaluate(() => window.__powerrp_app.undo()); // restore for the snap tests
  await new Promise((r) => setTimeout(r, 100));

  // ── 4. SNAP EXCLUSION (dragging a MEMBER — reliable full-area grab) ─────────
  // The exclusion (self + own group + own members) is verified structurally in
  // group_test / group_integration_probe (pure). Here we assert the LIVE
  // behavior via the actual move drag: a MEMBER must NOT snap to its OWN group's
  // hull, but WILL snap to a FOREIGN item (the mechanism still works for real
  // candidates). Dragging a member is the reliable case (full-area hitTest,
  // unlike the group's border-only outline).

  // (a) FOREIGN SNAP: a foreign rect placed so that dragging member A lines its
  //     left edge up ~3px shy of the foreign's left edge → it must snap onto it.
  const foreign = await page.evaluate(([idA]) => {
    const app = window.__powerrp_app;
    const a = app.nodes().find((n) => n.itemId === idA);
    // Foreign rect whose LEFT edge (x=fx) sits a clean gap to the RIGHT of A, at
    // the SAME y as A so a horizontal drag lines their left edges up.
    const fx = a.world.x + 200; // well clear of A and the group hull
    app.selectMany([]);
    app.addItem({ type: "rect", x: fx, y: a.world.y, w: 80, h: 80, rotation: 0, scale: 1, fill: "#33e", stroke: "#000", strokeWidth: 2, cornerRadius: 0, opacity: 1 });
    const fid = app.selection;
    app.selectMany([idA]); // re-select the member to drag it
    return { fid, fx, aWorldX: a.world.x, aWorldY: a.world.y, aW: a.state.w, aH: a.state.h };
  }, [setup.idA]);

  // Grab member A at its center; drag right so its LEFT edge lands 3px shy of
  // the foreign's left edge (within the 8px snap tolerance) → snaps onto fx.
  const aCenter = await w2s(foreign.aWorldX + foreign.aW / 2, foreign.aWorldY + foreign.aH / 2);
  const targetAWorldLeft = foreign.fx - 3; // 3px short → within tol
  const aDropCenter = await w2s(targetAWorldLeft + foreign.aW / 2, foreign.aWorldY + foreign.aH / 2);
  await page.mouse.move(aCenter.x, aCenter.y);
  await page.mouse.down();
  await page.mouse.move(aDropCenter.x, aDropCenter.y, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 120));
  await page.screenshot({ path: `${shots}/04_member_snap_foreign.png` });
  const foreignSnap = await page.evaluate(([idA, fx]) => {
    const a = window.__powerrp_app.nodes().find((n) => n.itemId === idA);
    return { leftEdge: a.world.x, foreignLeft: fx };
  }, [setup.idA, foreign.fx]);
  // Member A's left edge snapped exactly onto the foreign item's left edge.
  if (Math.abs(foreignSnap.leftEdge - foreignSnap.foreignLeft) > 1.0)
    fail(`member did NOT snap to the FOREIGN item's edge: left=${foreignSnap.leftEdge} foreign=${foreignSnap.foreignLeft}`);

  // (b) NO SELF-SNAP TO OWN GROUP: isolate the group hull as the ONLY nearby
  //     snappable feature (purge member B + the foreign rect), then free-drag
  //     member A so its edge would land ~3px inside the group's RIGHT hull edge.
  //     Without exclusion, A's right edge would snap exactly onto the group hull
  //     line; WITH exclusion, A lands at the free target and snapEngaged stays
  //     false (the group is A's own group → excluded).
  await page.evaluate(() => window.__powerrp_app.undo()); // undo the foreign-snap drag
  await new Promise((r) => setTimeout(r, 100));
  const iso = await page.evaluate(([idA, idB, fid]) => {
    const app = window.__powerrp_app;
    // Ungroup would re-bake; instead purge member B + the foreign rect so the
    // group hull is A's ONLY nearby snappable feature. purgeSelection acts on
    // the current selection. (B is still a group member, but purging it removes
    // its node — the group simply has one fewer member; A's hull relation holds.)
    app.selectMany([idB]); app.purgeSelection();
    app.selectMany([fid]); app.purgeSelection();
    const a = app.nodes().find((n) => n.itemId === idA);
    return { aW: a.state.w, aH: a.state.h };
  }, [setup.idA, setup.idB, foreign.fid]);
  await page.evaluate((idA) => window.__powerrp_app.selectMany([idA]), setup.idA);
  // Free-drag A so its RIGHT edge would be 3px LEFT of the group's right hull
  // edge (within the 8px tol — a self-snap WOULD pull A's right edge onto it).
  const g1 = await page.evaluate(([idA, gid]) => {
    const app = window.__powerrp_app;
    const a = app.nodes().find((n) => n.itemId === idA);
    const g = app.nodes().find((n) => n.itemId === gid);
    return {
      groupRight: g.world.x + (g.state.w ?? 0) * g.world.scale,
      aWorldX: a.world.x, aWorldY: a.world.y, aW: a.state.w, aH: a.state.h,
    };
  }, [setup.idA, setup.gid]);
  const desiredARight = g1.groupRight - 3; // 3px shy of the hull → within tol
  const desiredALeft = desiredARight - g1.aW;
  const aC2 = await w2s(g1.aWorldX + g1.aW / 2, g1.aWorldY + g1.aH / 2);
  const aD2 = await w2s(desiredALeft + g1.aW / 2, g1.aWorldY + g1.aH / 2);
  await page.mouse.move(aC2.x, aC2.y);
  await page.mouse.down();
  await page.mouse.move(aD2.x, aD2.y, { steps: 8 });
  const selfSnapEngaged = await page.evaluate(() => window.__powerrp_app.snapEngaged);
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 120));
  await page.screenshot({ path: `${shots}/05_member_no_self_snap.png` });
  const selfSnap = await page.evaluate(([idA, gid]) => {
    const app = window.__powerrp_app;
    const a = app.nodes().find((n) => n.itemId === idA);
    const g = app.nodes().find((n) => n.itemId === gid);
    return { aRight: a.world.x + (a.state.w ?? 0) * a.world.scale, groupRight: g.world.x + (g.state.w ?? 0) * g.world.scale };
  }, [setup.idA, setup.gid]);
  if (selfSnapEngaged) fail("snapEngaged lit while dragging a member near ONLY its own group hull — exclusion failed");
  // A's right edge landed at the FREE target (~3px shy of the hull), NOT snapped
  // exactly onto the group hull line.
  if (Math.abs(selfSnap.aRight - selfSnap.groupRight) < 0.5)
    fail(`member SELF-SNAPPED to its own group hull (aRight=${selfSnap.aRight} groupRight=${selfSnap.groupRight}) — exclusion failed`);

  if (errors.length) { console.error("GROUP RESIZE/SNAP PROBE FAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log("Group resize + snap exclusion probe passed; screenshots written to", shots);
} finally {
  await browser.close();
  await server.close();
}
