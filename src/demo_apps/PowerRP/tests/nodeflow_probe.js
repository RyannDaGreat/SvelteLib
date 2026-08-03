/**
 * NODE-FLOW browser probe: the wire gesture, driven through the REAL editor with
 * REAL pointer events (page.mouse — actual pointer capture, the technique
 * arrow_modifier_probe.js established).
 *
 * WHAT ONLY THIS CAN PROVE. tests/nodeflow_test.js already pins the types, the
 * coercion table, the refusal sentences and the evaluation, all in bare node. What
 * it cannot reach is the half of the feature that only exists once a pointer is
 * involved: that the bead layer is ACTUALLY hittable at the coordinates the painter
 * drew it at, that a drag between two of them commits through the app's real undo
 * path, and that dragging a wire's end off into empty space really deletes it. Those
 * are three places where a correct core and a wrong canvas look identical from node.
 *
 * THE SCENARIO IS THE BLUEPRINT'S OWN ACCEPTANCE, non-audio:
 *   build source(3) → math(×) ← source(2) → display, BY DRAGGING WIRES;
 *   assert the display shows 6;
 *   assert each connect was ONE undo step (Cmd+Z leaves the wire gone and the
 *     nodes still there — a wire is not a widget, so undoing one must not remove
 *     an item);
 *   drag a wire's end off into empty space, assert the wire is gone and the
 *     display falls back to its unconnected zero;
 *   assert that one deletion is also ONE undo step;
 *   and that a bead grab BEATS the body drag while a grab 20px away still MOVES
 *     the node — the precedence the whole "always-active bead" ruling rests on.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/nodeflow_probe.js
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const liveErrors = [];
  const bootErrors = [];
  const afterBoot = { on: false };
  page.on("pageerror", (e) => (afterBoot.on ? liveErrors : bootErrors).push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (isWebGpuAbsenceNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  // A 500 on /api/projects is the ABSENT PROJECT BACKEND, not a defect in anything
  // this probe tests: run_all.mjs starts one and passes BACKEND_URL, and run ALONE
  // there is nothing listening. Filtered BY NAME so any OTHER boot error still reds
  // this check — the gate's own stated lesson (a probe must not report an absent
  // dependency as if the app were broken, nor swallow the whole category to hide it).
  const realBootErrors = bootErrors.filter((e) => !/\/api\/projects|500 \(Internal Server Error\)/.test(e));
  ok(realBootErrors.length === 0, `no boot errors beyond the absent project backend (${JSON.stringify(realBootErrors)})`);
  afterBoot.on = true;

  /** World point → page (viewport) coordinates, through the app's own camera map —
   *  so the probe clicks where the APP thinks the bead is, not where the probe
   *  recomputed it. A probe that did its own projection could pass while the app's
   *  hit test and its painter disagreed, which is the exact class of bug here. */
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  /** Command. Adds one node widget at a world position and returns its itemId. */
  const addNode = (type, x, y, extra = {}) => page.evaluate((type, x, y, extra) => {
    const app = window.__powerrp_app;
    const plugin = app.registry.get(type);
    app.addItem({ ...plugin.defaults, x, y });
    const id = app.selection;
    const pairs = Object.entries(extra).map(([k, v]) => [["items", id, k], v]);
    if (pairs.length) { app.setPreview(pairs); app.commitPreview(); }
    return id;
  }, type, x, y, extra);

  /** Query. A port bead's WORLD position, straight out of the derivation the
   *  painter and the hit test share (core/derive.nodePortAnchors). */
  const beadWorld = (itemId, side, key) => page.evaluate((itemId, side, key) => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === itemId);
    const a = window.__powerrp_nodePortAnchors(node).find((p) => p.side === side && p.key === key);
    return a ? { x: a.x, y: a.y } : null;
  }, itemId, side, key);

  // `window.__powerrp_nodePortAnchors` is the app's OWN derivation, exposed as a
  // dev/test seam in web/main.js beside __powerrp_videoStatus and for the same
  // stated reason. The probe deliberately does NOT recompute bead positions: doing
  // so could pass while the app's hit test and its painter disagreed, which is the
  // one bug this file exists to catch.
  ok(await page.evaluate(() => typeof window.__powerrp_nodePortAnchors === "function"),
    "the nodePortAnchors test seam is present (web/main.js)");

  const displayText = (id) => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === id);
    return node.plugin.emit(node.state, null, node.world).filter((o) => o.op === "text").map((o) => o.text);
  }, id);

  const connectionOf = (id, port) => page.evaluate((id, port) => {
    const app = window.__powerrp_app;
    const items = app.rawState().items ?? {};
    const c = items[id]?.inputs?.[port];
    return c && typeof c === "object" ? { item: c.item, port: c.port } : null;
  }, id, port);

  const itemCount = () => page.evaluate(() => Object.keys(window.__powerrp_app.rawState().items ?? {}).length);
  const undo = () => page.evaluate(() => window.__powerrp_app.undo());

  /** Command. THE GESTURE: press on one bead, drag to another point, release. */
  async function dragBetween(from, to) {
    const a = await worldToPage(from.x, from.y);
    const b = await worldToPage(to.x, to.y);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 120));
  }

  // ── BUILD THE TRIO ─────────────────────────────────────────────────────────
  const srcA = await addNode("node_number", 200, 200, { value: 3 });
  const srcB = await addNode("node_number", 200, 400, { value: 2 });
  const math = await addNode("node_math", 500, 250, { op: "multiply" });
  const disp = await addNode("node_display", 800, 250);
  const baseItems = await itemCount();
  ok(baseItems >= 4, `four node widgets exist (${baseItems} items incl. the camera)`);

  const outA = await beadWorld(srcA, "output", "out");
  const outB = await beadWorld(srcB, "output", "out");
  const inA = await beadWorld(math, "input", "a");
  const inB = await beadWorld(math, "input", "b");
  const outM = await beadWorld(math, "output", "out");
  const inD = await beadWorld(disp, "input", "in");
  ok(outA && inA && outM && inD, "every port bead has a derived world position");

  // ── WIRE 1: source(3) → math.a, BY DRAGGING ────────────────────────────────
  await dragBetween(outA, inA);
  const c1 = await connectionOf(math, "a");
  ok(c1?.item === srcA && c1?.port === "out", `dragging bead→bead CONNECTED (got ${JSON.stringify(c1)})`);
  ok((await itemCount()) === baseItems, "connecting created NO new item — WIRES ARE NOT WIDGETS");

  // ── ONE UNDO UNIT, and undoing a wire must not remove a node ───────────────
  await undo();
  ok((await connectionOf(math, "a")) === null, "ONE Cmd+Z removed the wire");
  ok((await itemCount()) === baseItems, "and the two NODES are still there — undoing a wire is not undoing a widget");
  await page.evaluate(() => window.__powerrp_app.redo());
  ok((await connectionOf(math, "a"))?.item === srcA, "redo restored it");

  // ── THE REST OF THE PATCH ──────────────────────────────────────────────────
  await dragBetween(outB, inB);
  await dragBetween(outM, inD);
  ok((await connectionOf(math, "b"))?.item === srcB, "source(2) → math.b");
  ok((await connectionOf(disp, "in"))?.item === math, "math → display");

  // ── THE PROOF: 3 × 2 = 6, ON SCREEN ────────────────────────────────────────
  const shown = await displayText(disp);
  ok(shown.includes("6"), `the display's own picture shows 6 (got ${JSON.stringify(shown)})`);

  // ── DELETE BY DRAGGING THE END OFF INTO EMPTY SPACE ────────────────────────
  // The user's stated gesture, verbatim: "you take one of the nodes you click and
  // drag off into the outer space and the wire disappears."
  //
  // ── THIS WAS NF-CORE'S REPORTED GAP, AND THE DIAGNOSIS WAS WRONG ───────────
  // NF-CORE measured correctly that the press never reached finishWireDrag and
  // reported it honestly rather than asserting a pass. Its SUSPECT — "pointer-down
  // routing for a CONNECTED input bead, between onPointerDown and startWireDrag" —
  // was not the mechanism, and the difference matters for anyone reading this file.
  //
  // MEASURED (NF-BIND, 2026-08-02, by logging the real pointerdown's target in the
  // live page): the press landed on `rect.handle` and the drag announced
  // `dragKind: "resize"`. onPointerDown was NEVER CALLED. The resize handles are
  // their own SVG rects with their own pointerdown listener
  // (web/ResizeHandles.svelte -> startResize), so a press on one bypasses the whole
  // onPointerDown routing — including the always-active bead check at the top of it.
  //
  // Why it looked input-specific: handles exist only on the SELECTED node, and the
  // west-middle handle sits on the left edge, which is exactly where the INPUT beads
  // are. Connecting a wire SELECTS the target node, so the very next gesture — grab
  // that input bead to drag the wire off — grabs `ml` instead. Every CONNECT drag
  // above starts on an OUTPUT (right edge) of a node that is not the freshly
  // selected one, which is why all four worked. The bead's connectedness was a
  // correlation, not a cause.
  //
  // FIX: startResize runs the same startWireDrag check first (CanvasView.svelte),
  // because "the bead is drag-active even if it's not selected" cannot be true if a
  // selection-only affordance covers it.
  // Captured BEFORE any delete gesture: the resize-collision pin below proves the
  // wire drag ran INSTEAD of a resize, which needs the pre-gesture size.
  const dispSizeBefore = await page.evaluate((id) => {
    const s = window.__powerrp_app.rawState().items[id];
    return { w: s.w, h: s.h };
  }, disp);
  const inDNow = await beadWorld(disp, "input", "in");
  await dragBetween(inDNow, { x: inDNow.x + 90, y: inDNow.y + 170 });
  ok((await connectionOf(disp, "in")) === null,
    "DRAG-OFF-TO-DELETE: grabbing a connected input bead and dropping it on empty space REMOVED the wire");
  ok((await itemCount()) === baseItems, "the delete created or removed NO item — a wire is not a widget");
  ok((await displayText(disp)).includes("0"),
    "and the display fell back to its unconnected zero — the deletion reached the picture, not just the state");
  // ONE UNDO UNIT, the same standard the connect path is held to above.
  await undo();
  const restored = await connectionOf(disp, "in");
  ok(restored?.item === math, `ONE Cmd+Z restored the deleted wire (got ${JSON.stringify(restored)})`);
  ok((await itemCount()) === baseItems, "undoing a deletion did not resurrect or duplicate an item");

  // THE REGRESSION PIN FOR THE MECHANISM ITSELF, not just its symptom. The delete
  // drag above only exercises the handle collision when the display node happens to
  // be selected; asserting that explicitly means a future change to handle geometry,
  // z-order or hit area fails HERE with the reason, instead of quietly restoring the
  // gap for whichever bead a handle grows to cover next.
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, disp);
  await new Promise((r) => setTimeout(r, 60));
  const inDSel = await beadWorld(disp, "input", "in");
  await dragBetween(inDSel, { x: inDSel.x + 80, y: inDSel.y + 150 });
  ok((await connectionOf(disp, "in")) === null,
    "THE BEAD BEATS THE RESIZE HANDLE: the same gesture works with the node SELECTED, when a handle sits on the bead");
  const sizeAfter = await page.evaluate((id) => {
    const s = window.__powerrp_app.rawState().items[id];
    return { w: s.w, h: s.h };
  }, disp);
  ok(sizeAfter.w === dispSizeBefore.w && sizeAfter.h === dispSizeBefore.h,
    `and it did NOT resize the node instead (${JSON.stringify(dispSizeBefore)} → ${JSON.stringify(sizeAfter)})`);

  // ── PRECEDENCE: the bead beats the body, and ONLY inside its radius ────────
  // The ruling this whole layer rests on. Both halves are checked, because either
  // one alone is satisfiable by a broken implementation: a bead layer that always
  // won would make nodes unmovable, and one that never won would make them unwirable.
  const posBefore = await page.evaluate((id) => {
    const s = window.__powerrp_app.rawState().items[id];
    return { x: s.x, y: s.y };
  }, srcA);
  // (a) A press ON the output bead starts a WIRE, so the node must NOT move.
  await dragBetween(outA, { x: outA.x, y: outA.y + 260 });
  const posAfterBeadDrag = await page.evaluate((id) => {
    const s = window.__powerrp_app.rawState().items[id];
    return { x: s.x, y: s.y };
  }, srcA);
  ok(posAfterBeadDrag.x === posBefore.x && posAfterBeadDrag.y === posBefore.y,
    "a press ON a bead ran the WIRE gesture — the node did not move");
  // (b) A press on the node's BODY, well clear of any bead, still MOVES it.
  const body = { x: outA.x - 60, y: outA.y + 20 };
  await dragBetween(body, { x: body.x + 70, y: body.y + 30 });
  const posAfterBodyDrag = await page.evaluate((id) => {
    const s = window.__powerrp_app.rawState().items[id];
    return { x: s.x, y: s.y };
  }, srcA);
  ok(Math.abs(posAfterBodyDrag.x - posBefore.x) > 20,
    `a press on the BODY still moves the node (${posBefore.x} → ${posAfterBodyDrag.x})`);

  // ── REFUSAL: a self-connection is refused and writes nothing ───────────────
  const mathInA = await beadWorld(math, "input", "a");
  const mathOut = await beadWorld(math, "output", "out");
  const beforeSelf = await connectionOf(math, "a");
  await dragBetween(mathOut, mathInA);
  ok(JSON.stringify(await connectionOf(math, "a")) === JSON.stringify(beforeSelf),
    "dragging a node's own output onto its own input was REFUSED — the existing wire is untouched");

  // The self-connection above is a refusal THIS PROBE DELIBERATELY PROVOKES, and a
  // refused drop reports one line by design (web/CanvasView.finishWireDrag, the
  // reportAction precedent). Expected output is not noise — but it is filtered by
  // its exact sentence, so any OTHER console error still reds the check.
  const unexpected = liveErrors.filter((e) => !e.includes("cannot connect — that would make a loop"));
  ok(unexpected.length === 0, `no unexpected console errors during the session (${JSON.stringify(unexpected)})`);
  ok(liveErrors.some((e) => e.includes("cannot connect")), "and the refused self-connection DID state its reason (a silent refusal would be the worse bug)");
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
console.log(`\nnodeflow_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
if (errors.length) { for (const e of errors) console.error(e); process.exit(1); }
