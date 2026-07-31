/**
 * MULTI-STEP CREATION FLOWS probe — the two new placement gestures, in a real
 * browser, driven by REAL pointer events.
 *
 * tests/creation_modes_test.js pins the step-sequencing LOGIC in bare node (session
 * mutations, finalize/abandon, the generated HintBar entries). This probe pins the
 * PLUMBING that only the live app has: CanvasView's pointer routing, the crosshair
 * that survives the first press, the overlay, the HintBar the user actually reads,
 * and the undo-unit accounting.
 *
 * page.mouse, not dispatchEvent: CanvasView's handlers call setPointerCapture, so a
 * synthetic event never routes through them (the crosshair_probe.js technique).
 *
 * WHAT IT PROVES
 *   POLYGON  — N clicks make ONE item and ONE undo unit; mid-flow the committed
 *              document is UNCHANGED; Shift axis-locks the live vertex (re-read from
 *              the event, so releasing it un-locks); the first vertex highlights
 *              BEFORE the closing click; a click on it finalizes CLOSED; Enter and
 *              DOUBLE-CLICK both finalize open; Escape leaves NOTHING (no item, no
 *              undo entry, no preview); one click abandons instead of ghosting.
 *   TELESCOPIC — two drags make the THREE-item rig as ONE undo unit, the first box
 *              stays drawn while the second is dragged, the source lands on box 1
 *              and the lens (at t=1) on box 2.
 *   HINTBAR  — the bar narrates each step: the polygon's click/axis-lock/Enter, and
 *              the rig's two different step labels. Screenshotted per step.
 *
 * "ONE undo unit" is measured by JSON COMPARE, never reference identity: undo()
 * restores an EQUAL document through a fresh reactive proxy.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/creation_flows_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shots = process.argv[2] ?? resolve(HERE, "../.claude_vlm_checks/creation_flows");
await mkdir(shots, { recursive: true });

const SETTLE_MS = 160; // one reactive paint + Skia frame
// The vertices of the test polygon, in WORLD units — a clean 100x100 square well
// inside the default camera, so every click maps to a distinct on-screen pixel.
const SQUARE = [{ x: 200, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 300 }, { x: 200, y: 300 }];
// The rig's two dragged boxes (world): a small source and a bigger lens up-right,
// with DIFFERENT aspect ratios so the per-axis lens equations are exercised.
const RIG_SOURCE = { x: 180, y: 420, w: 120, h: 60 };
const RIG_LENS = { x: 640, y: 120, w: 320, h: 240 };

// HMR + the file watcher are OFF: many agents edit this tree concurrently and a
// stray reload mid-probe drops window.__powerrp_app for unrelated reasons.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// Documented boot/runtime noise from OTHER lanes (the crosshair_probe.js treatment).
const IGNORE = [
  /PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/,
  /Failed to load resource/, /failed to load/,
];
const isNoise = (s) => IGNORE.some((re) => re.test(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  const liveErrors = [];
  const phase = { live: false };
  page.on("pageerror", (e) => (phase.live ? liveErrors : bootErrors).push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" || isNoise(m.text())) return;
    (phase.live ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });

  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(900);
  ok(bootErrors.length === 0, `no boot errors (${JSON.stringify(bootErrors)})`);
  phase.live = true;

  const worldToPage = (w) => page.evaluate((w) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(w.x, w.y);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, w);
  const moveTo = async (w, opts) => {
    const p = await worldToPage(w);
    await page.mouse.move(p.x, p.y, opts);
    await sleep(40);
  };
  const clickAt = async (w, mods = []) => {
    await moveTo(w);
    for (const k of mods) await page.keyboard.down(k);
    await page.mouse.down();
    await sleep(30);
    await page.mouse.up();
    for (const k of mods) await page.keyboard.up(k);
    await sleep(SETTLE_MS);
  };
  const itemIds =() => page.evaluate(() => Object.keys(window.__powerrp_app.rawState().items));
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  // DEEP-CLONED in the page: every app value here comes off a Svelte reactive
  // proxy, and puppeteer serializes a proxied nested array as {} — measured (a
  // polygon's `points` came back undefined while its numeric x/y/w/h did not).
  const state = (id) => page.evaluate((id) => JSON.parse(JSON.stringify(window.__powerrp_app.rawState().items[id])), id);
  const modeOf = () => page.evaluate(() => {
    const m = window.__powerrp_app.canvasMode;
    return m ? { handlerId: m.handlerId, itemId: m.itemId ?? null, step: m.step } : null;
  });
  const previewNull = () => page.evaluate(() => window.__powerrp_app.previewDelta === null);
  /** Query. The visible HintBar LABELS — the words the user actually reads off the
   *  bar. Labels, not key tokens: most tokens render as an mdi glyph with no text
   *  (lib/KeyCombo.svelte), and which keys carry which label is already pinned in
   *  bare node by tests/creation_modes_test.js. What only a browser can prove is
   *  that these labels reach the DOM at all, and at the right step. */
  const chips = () => page.evaluate(() =>
    [...document.querySelectorAll(".hintbar .hint .label")].map((l) => l.textContent.trim()));
  /** Query. The live creation overlay as counts + whether a vertex is HOT. */
  const overlayShape = () => page.evaluate(() => {
    const svg = document.querySelector(".overlay");
    return {
      chains: svg.querySelectorAll("polyline.place-rect").length,
      chainPoints: (svg.querySelector("polyline.place-rect")?.getAttribute("points") ?? "").trim().split(/\s+/).filter(Boolean).length,
      rects: svg.querySelectorAll("rect.place-rect").length,
      dots: svg.querySelectorAll("circle.place-dot").length,
      hot: svg.querySelectorAll("circle.place-dot-hot").length,
      crosshairs: svg.querySelectorAll("line.crosshair-place").length,
    };
  });
  /** Command. Wraps app.commit so undo units can be COUNTED, and zeroes the tally. */
  const armCommitCounter = () => page.evaluate(() => {
    const a = window.__powerrp_app;
    if (!a.__probeWrapped) {
      const real = a.commit.bind(a);
      a.commit = (d) => { window.__probeCommits += 1; return real(d); };
      a.__probeWrapped = true;
    }
    window.__probeCommits = 0;
  });
  const commits = () => page.evaluate(() => window.__probeCommits);
  /** Command. Removes every item the flows created and clears the selection, so each
   *  scenario starts from the same canvas (the activation_migration_probe rule). */
  const purgeAll = (ids) => page.evaluate((ids) => {
    const app = window.__powerrp_app;
    for (const id of ids) { app.selection = id; app.purgeSelection(); }
    app.deselectAll();
  }, ids);
  // Armed through the REAL command entry (app.commands.get(...).run(app) — what the
  // palette and the toolbar both do), so what this probe exercises is the shipped
  // entry point, not a hand-rolled arm.
  const armPolygon = async () => {
    await page.evaluate(() => {
      const app = window.__powerrp_app;
      app.commands.get("add-polygon").run(app);
    });
    await sleep(SETTLE_MS);
  };
  const armRig = async (shapeKind) => {
    await page.evaluate((k) => window.__powerrp_app.armCrosshairRig("telescopic_rig", { shapeKind: k }), shapeKind);
    await sleep(SETTLE_MS);
  };

  const baseIds = await itemIds();

  // ── THE ARMED BAR, before any press ────────────────────────────────────────
  await armPolygon();
  ok((await chips()).includes("Click or drag to place"),
    `armed (not yet in the mode) the bar shows the generic placement hint. Got ${JSON.stringify(await chips())}`);

  // ── POLYGON: 4 clicks + Enter = ONE item, ONE undo unit ───────────────────
  const before = await docJson();
  await armCommitCounter();
  await clickAt(SQUARE[0]);
  const afterFirstClick = { mode: await modeOf(), doc: await docJson(), ov: await overlayShape() };
  ok(afterFirstClick.mode?.handlerId === "polygon_chain", `the first press ENTERS the creation mode (got ${JSON.stringify(afterFirstClick.mode)})`);
  ok(afterFirstClick.mode?.itemId === null, "a creation mode belongs to no item (nothing exists yet)");
  ok(afterFirstClick.doc === before, "after one click the COMMITTED DOCUMENT IS UNCHANGED");
  ok(afterFirstClick.ov.dots === 1, `one landed vertex is drawn (got ${afterFirstClick.ov.dots})`);
  ok(afterFirstClick.ov.crosshairs > 0, "the placement CROSSHAIR survives the first press (a multi-step placement keeps its cursor)");
  const modeChips = await chips();
  ok(modeChips.includes("Click each corner"), `the bar narrates the step. Got ${JSON.stringify(modeChips)}`);
  ok(modeChips.includes("Axis lock"), `the bar names the Shift constraint. Got ${JSON.stringify(modeChips)}`);
  ok(modeChips.includes("Finish shape"), `the bar names Enter. Got ${JSON.stringify(modeChips)}`);
  ok(modeChips.includes("Exit draw polygon"), `the bar names Escape. Got ${JSON.stringify(modeChips)}`);
  ok(!modeChips.includes("Click or drag to place"), "and the generic placement hint has YIELDED to the mode's own steps");
  await page.screenshot({ path: `${shots}/1-polygon-step-hint.png` });

  await clickAt(SQUARE[1]);
  await clickAt(SQUARE[2]);
  const mid = { doc: await docJson(), ov: await overlayShape(), commits: await commits() };
  ok(mid.doc === before, "MID-FLOW, after three clicks, the committed document is STILL unchanged");
  ok(mid.commits === 0, `and NOTHING has been committed (got ${mid.commits} commits)`);
  ok(mid.ov.dots === 3 && mid.ov.chains === 1, `three vertices and one live chain (got ${JSON.stringify(mid.ov)})`);
  ok(mid.ov.chainPoints === 4, `the chain draws the 3 vertices PLUS the rubber band to the pointer (got ${mid.ov.chainPoints} points)`);
  await page.screenshot({ path: `${shots}/2-polygon-rubber-band.png` });

  // SHIFT is live and re-read every move: held, the 4th corner's rubber band
  // axis-locks off vertex 3; released, it follows the pointer again.
  const OFF_AXIS = { x: SQUARE[3].x - 40, y: SQUARE[3].y + 25 };
  await moveTo(OFF_AXIS);
  const freeChain = await page.evaluate(() => document.querySelector("polyline.place-rect").getAttribute("points"));
  await page.keyboard.down("Shift");
  await moveTo({ x: OFF_AXIS.x + 1, y: OFF_AXIS.y }); // one move so the handler re-reads the flags
  const lockedChain = await page.evaluate(() => document.querySelector("polyline.place-rect").getAttribute("points"));
  await page.keyboard.up("Shift");
  await moveTo(OFF_AXIS);
  const unlockedChain = await page.evaluate(() => document.querySelector("polyline.place-rect").getAttribute("points"));
  ok(lockedChain !== freeChain, "Shift CHANGES the live vertex (the constraint is live, not applied at commit)");
  ok(unlockedChain === freeChain, "releasing Shift restores the free vertex — the flags are re-read every move, never frozen");
  await page.screenshot({ path: `${shots}/3-polygon-shift-axis-lock.png` });

  // THE CLOSE-LOOP AFFORDANCE, before the click.
  await moveTo({ x: SQUARE[0].x + 2, y: SQUARE[0].y + 2 });
  const hover = await overlayShape();
  ok(hover.hot === 1, `hovering the FIRST vertex highlights it BEFORE the click (got ${hover.hot} hot dots)`);
  await page.screenshot({ path: `${shots}/4-polygon-close-loop-affordance.png` });
  await moveTo(SQUARE[3]);
  ok((await overlayShape()).hot === 0, "and the highlight clears when the pointer leaves it");

  await clickAt(SQUARE[3]);
  await page.keyboard.press("Enter");
  await sleep(SETTLE_MS);
  const madeIds = (await itemIds()).filter((id) => !baseIds.includes(id));
  ok(madeIds.length === 1, `4 clicks + Enter made EXACTLY ONE item (got ${madeIds.length})`);
  ok(await commits() === 1, `and EXACTLY ONE commit — one undo unit (got ${await commits()})`);
  ok(await modeOf() === null, "Enter leaves the mode");
  ok((await overlayShape()).dots === 0, "and the creation overlay is gone");
  const poly = madeIds.length === 1 ? await state(madeIds[0]) : null;
  ok(poly?.type === "polygon", `the item is a polygon (got ${poly?.type})`);
  ok(poly && Math.abs(poly.x - 200) < 1 && Math.abs(poly.y - 200) < 1 && Math.abs(poly.w - 100) < 1 && Math.abs(poly.h - 100) < 1,
    `its box is fitted to the clicked hull (got ${JSON.stringify(poly && { x: poly.x, y: poly.y, w: poly.w, h: poly.h })}, want 200,200,100,100)`);
  ok(poly?.points?.length === 4, `one vertex — and therefore one keyframable handle — per click (got ${poly?.points?.length})`);
  ok(poly?.closed === false, "Enter finalizes an OPEN chain (the loop was never closed)");
  await page.screenshot({ path: `${shots}/5-polygon-finalized.png` });

  // ONE UNDO reverts the WHOLE flow, measured by JSON COMPARE (undo restores an
  // EQUAL document through a fresh reactive proxy — never the same reference).
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  ok(await docJson() === before, "ONE undo reverts the entire 4-click placement — one undo unit, by JSON compare");

  // ── POLYGON: a closing click fills the shape ──────────────────────────────
  await armCommitCounter();
  await armPolygon();
  for (const v of [SQUARE[0], SQUARE[1], SQUARE[2]]) await clickAt(v);
  await clickAt({ x: SQUARE[0].x + 2, y: SQUARE[0].y + 1 }); // ON the first vertex
  const closedIds = (await itemIds()).filter((id) => !baseIds.includes(id));
  ok(closedIds.length === 1, `clicking the first vertex finalizes (got ${closedIds.length} items)`);
  const closedPoly = closedIds.length === 1 ? await state(closedIds[0]) : null;
  ok(closedPoly?.closed === true, "and it finalizes CLOSED, so the shape fills");
  ok(closedPoly?.points?.length === 3, `the closing click adds NO fourth vertex (got ${closedPoly?.points?.length})`);
  ok(await commits() === 1, `still ONE undo unit (got ${await commits()})`);
  await page.screenshot({ path: `${shots}/6-polygon-closed-filled.png` });
  await purgeAll(closedIds);

  // ── POLYGON: DOUBLE-CLICK finalizes, with no duplicate vertex ─────────────
  await armCommitCounter();
  await armPolygon();
  await clickAt(SQUARE[0]);
  await clickAt(SQUARE[1]);
  await moveTo(SQUARE[2]);
  const dbl = await worldToPage(SQUARE[2]);
  await page.mouse.click(dbl.x, dbl.y, { clickCount: 2 });
  await sleep(SETTLE_MS);
  const dblIds = (await itemIds()).filter((id) => !baseIds.includes(id));
  ok(dblIds.length === 1, `a double-click finalizes (got ${dblIds.length} items)`);
  const dblPoly = dblIds.length === 1 ? await state(dblIds[0]) : null;
  ok(dblPoly?.points?.length === 3, `and the second press of the double-click adds NO duplicate vertex (got ${dblPoly?.points?.length}, want 3)`);
  ok(await commits() === 1, `one undo unit (got ${await commits()})`);
  ok(await modeOf() === null, "the mode is left");
  await purgeAll(dblIds);

  // ── POLYGON: ESCAPE leaves NOTHING ───────────────────────────────────────
  const beforeEsc = await docJson();
  await armCommitCounter();
  await armPolygon();
  for (const v of [SQUARE[0], SQUARE[1], SQUARE[2]]) await clickAt(v);
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);
  ok((await itemIds()).filter((id) => !baseIds.includes(id)).length === 0, "Escape leaves NO item behind");
  ok(await docJson() === beforeEsc, "Escape leaves the document byte-identical");
  ok(await commits() === 0, `Escape adds NO undo entry (got ${await commits()} commits)`);
  ok(await previewNull(), "and no preview is left staged");
  ok(await modeOf() === null, "the mode is left");
  ok((await overlayShape()).dots === 0, "and the overlay is cleared");
  ok(await page.evaluate(() => window.__powerrp_app.crosshair) === null, "leaving the mode also disarms the placement crosshair");

  // ── POLYGON: fewer than two vertices ABANDONS ────────────────────────────
  await armCommitCounter();
  await armPolygon();
  await clickAt(SQUARE[0]);
  await page.keyboard.press("Enter");
  await sleep(SETTLE_MS);
  ok((await itemIds()).filter((id) => !baseIds.includes(id)).length === 0, "one vertex + Enter creates NOTHING (no ghost item)");
  ok(await commits() === 0, `and no undo entry (got ${await commits()} commits)`);
  ok(await modeOf() === null, "but it still leaves the mode");

  // ── TELESCOPIC: two drags = the three-item rig, ONE undo unit ─────────────
  const beforeRig = await docJson();
  await armCommitCounter();
  await armRig("circle");
  await moveTo({ x: RIG_SOURCE.x, y: RIG_SOURCE.y });
  await page.mouse.down();
  await moveTo({ x: RIG_SOURCE.x + RIG_SOURCE.w, y: RIG_SOURCE.y + RIG_SOURCE.h });
  const step0Chips = await chips();
  ok(step0Chips.includes("Drag the region to magnify"), `step 1's own wording is on the bar. Got ${JSON.stringify(step0Chips)}`);
  ok(step0Chips.includes("Uniform scale") && step0Chips.includes("Symmetric resize"),
    `a box step announces the modifiers it reads. Got ${JSON.stringify(step0Chips)}`);
  await page.screenshot({ path: `${shots}/7-rig-step1-hint.png` });
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const afterBox1 = { mode: await modeOf(), doc: await docJson(), ov: await overlayShape(), chips: await chips() };
  ok(afterBox1.mode?.step === 1, `the first release ADVANCES the step (got ${JSON.stringify(afterBox1.mode)})`);
  ok(afterBox1.doc === beforeRig, "and the committed document is still unchanged");
  ok(afterBox1.ov.rects === 1, `box 1 stays drawn as a reference (got ${afterBox1.ov.rects} rects)`);
  ok(afterBox1.chips.includes("Now drag where the magnified view goes"),
    `the bar RE-WORDS for step 2. Got ${JSON.stringify(afterBox1.chips)}`);
  ok(!afterBox1.chips.includes("Drag the region to magnify"), "and step 1's wording is gone — one key, one meaning");
  await page.screenshot({ path: `${shots}/8-rig-step2-hint.png` });

  await moveTo({ x: RIG_LENS.x, y: RIG_LENS.y });
  await page.mouse.down();
  await moveTo({ x: RIG_LENS.x + RIG_LENS.w, y: RIG_LENS.y + RIG_LENS.h });
  ok((await overlayShape()).rects === 2, "both boxes paint while the second is dragged");
  await page.screenshot({ path: `${shots}/9-rig-both-boxes.png` });
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const rigIds = (await itemIds()).filter((id) => !baseIds.includes(id));
  ok(rigIds.length === 3, `two drags built the THREE-item rig (got ${rigIds.length})`);
  ok(await commits() === 1, `as ONE undo unit (got ${await commits()} commits)`);
  ok(await modeOf() === null, "and the mode finalized itself — a fixed-length sequence needs no Enter");
  const rigStates = await Promise.all(rigIds.map((id) => state(id)));
  const src = rigStates.find((s) => s.type === "circle" || s.type === "rect");
  ok(src && Math.abs(src.x - RIG_SOURCE.x) < 1 && Math.abs(src.w - RIG_SOURCE.w) < 1 && Math.abs(src.h - RIG_SOURCE.h) < 1,
    `the source marker IS box 1 (got ${JSON.stringify(src && { x: src.x, y: src.y, w: src.w, h: src.h })}, want ${JSON.stringify(RIG_SOURCE)})`);
  ok(rigStates.some((s) => s.type === "demo_magnify") && rigStates.some((s) => s.type === "tangent_lines"),
    `the rig has its lens and its tangents (${rigStates.map((s) => s.type).join(", ")})`);
  // At t = 1 the LENS must land on box 2 — the whole point of dragging it there.
  // The tween var is driven through setPreview (no commit, so this measurement adds
  // no undo unit of its own) and read back off the DERIVED tree, which is what the
  // renderer and the CLI see.
  const lensAtOne = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.setPreview([[["vars", "t"], 1]]);
    const n = app.nodes().find((x) => x.state.type === "demo_magnify");
    return n ? { x: n.state.x, y: n.state.y, w: n.state.w, h: n.state.h } : null;
  });
  ok(lensAtOne && Math.abs(lensAtOne.x - RIG_LENS.x) < 1 && Math.abs(lensAtOne.y - RIG_LENS.y) < 1
    && Math.abs(lensAtOne.w - RIG_LENS.w) < 1 && Math.abs(lensAtOne.h - RIG_LENS.h) < 1,
    `at t=1 the lens IS box 2 (got ${JSON.stringify(lensAtOne)}, want ${JSON.stringify(RIG_LENS)})`);
  await sleep(500); // the lens is a sampler material — give Skia a frame at the new t
  await page.screenshot({ path: `${shots}/10-rig-finalized-t1.png` });
  await page.evaluate(() => window.__powerrp_app.cancelPreview());

  ok(liveErrors.length === 0, `no console errors during the whole run (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter(([pass]) => !pass);
for (const [pass, label] of checks) console.log(`${pass ? "PASS" : "FAIL"} — ${label}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${shots}`);
if (failed.length) {
  console.log(errors.join("\n"));
  process.exit(1);
}
