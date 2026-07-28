/**
 * BENTO CELL BINDING probe (plugins/bento.js + web/bentoBind.js) — the feature in
 * the REAL editor, driven with REAL pointer gestures (page.mouse, not
 * dispatchEvent: CanvasView's handlers call setPointerCapture, so a synthetic
 * event would not route through them — the crosshair_probe.js technique).
 *
 * THE ONE ASSERTION THE FEATURE IS: double-click the bento, click a cell, click a
 * widget — then MOVE THE BENTO and the widget FOLLOWED. Everything else here is
 * the boundary around it:
 *
 *   - the HintBar ANNOUNCES the double-click before you make it (the bento had no
 *     activation at all, so its chip did not exist), and then swaps to the mode's
 *     own two-step narration, one step at a time;
 *   - the CURSOR changes on entering the mode, DIFFERS between the two steps, and
 *     reverts on Escape (asserted through getComputedStyle, because a cursor is not
 *     captured in a screenshot);
 *   - HOVERING a cell highlights it while the document stays BYTE-IDENTICAL, moving
 *     between cells moves the highlight, and the hover highlight is DISTINGUISHABLE
 *     from the committed aim (asserted, not eyeballed);
 *   - the LIST appears once a cell is aimed, a row's hover highlights that widget on
 *     canvas, picking from it writes the SAME binding a canvas click does, and a
 *     group member is present but GREYED with its reason;
 *   - the aim writes NOTHING to the document (the bento is never edited);
 *   - the bind is exactly ONE undo unit, and ONE undo puts the widget back;
 *   - the widget's own CENTRE lands on the cell's centre, not its corner;
 *   - the existing "Unbind Position & Size" command is the way out and enables
 *     itself on a cell-bound widget;
 *   - Escape leaves the mode and normal editing resumes.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/bento_bind_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const shots = process.argv[2] ?? "/tmp/bento_bind_probe";
await mkdir(shots, { recursive: true });

// A 300x200 2x3 bento with no gaps and no padding, so every cell centre is a round
// number written out below rather than recomputed by the code under test.
const BENTO = { x: 200, y: 160, w: 300, h: 200, rows: 2, cols: 3, rowGap: 0, colGap: 0, padding: 0 };
const CELL_W = BENTO.w / BENTO.cols;
const CELL_H = BENTO.h / BENTO.rows;
const TARGET = { r: 1, c: 2 }; // the cell to aim at
const TARGET_CENTRE = { x: BENTO.x + (TARGET.c + 0.5) * CELL_W, y: BENTO.y + (TARGET.r + 0.5) * CELL_H };
const BOX = { w: 60, h: 40 }; // the widget being bound — smaller than a cell, so
// corner-vs-centre placement is visibly different
const BOX_NAME = "Bindable Card"; // so a list row can be matched by NAME, not by uuid
const BOX_START = { x: 760, y: 620 }; // parked far from the grid, so "it moved" is unambiguous
const MEMBER_NAME = "Grouped Card"; // the greyed row's subject
const BENTO_SHIFT = { x: 140, y: 90 }; // how far the bento is moved for the follow test
const SETTLE_MS = 220; // one reactive paint + Skia frame
const EPS = 0.5; // world-unit tolerance (the gestures go through screen px)

// HMR + the file watcher are OFF: a dozen agents edit this tree concurrently and a
// stray full reload mid-probe drops window.__powerrp_app for unrelated reasons.
const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// Documented boot/runtime noise from OTHER lanes (activation_probe.js's list).
const IGNORE = [/PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/, /preserveAspect/];
const isNoise = (s) => IGNORE.some((re) => re.test(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => Math.abs(a - b) <= EPS;

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

  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);
  const clickAt = async (wx, wy, opts = {}) => {
    const p = await worldToPage(wx, wy);
    await page.mouse.click(p.x, p.y, opts);
    await sleep(SETTLE_MS);
  };
  const hintLabels = () => page.evaluate(() => [...document.querySelectorAll(".hintbar .hint .label")].map((n) => n.textContent.trim()));
  const modeId = () => page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId ?? null);
  const modeStep = () => page.evaluate(() => window.__powerrp_app.canvasMode?.step ?? null);
  const stored = (id, key) => page.evaluate((id, key) => window.__powerrp_app.storedItemValue(id, [key]), id, key);
  // UNDO UNITS ARE COUNTED AT app.commit — the activation_probe technique. There is
  // no public undo-depth accessor, and reading one off the log's internals would
  // assert on a private shape; every undo unit goes through commit(), so counting
  // calls is the honest measure of "how many steps did that gesture cost".
  const countCommits = () => page.evaluate(() => {
    if (window.__probeCommits !== undefined) return;
    window.__probeCommits = 0;
    const app = window.__powerrp_app;
    const real = app.commit.bind(app);
    app.commit = (d) => { window.__probeCommits += 1; return real(d); };
  });
  const commits = () => page.evaluate(() => window.__probeCommits);
  /** Query. A widget's WORLD box centre, read off the live derived tree. */
  const centreOf = (id) => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    if (!n) return null;
    const c = Math.cos(n.world.rotation), s = Math.sin(n.world.rotation);
    const lx = (n.state.w ?? 0) / 2, ly = (n.state.h ?? 0) / 2;
    return { x: n.world.x + n.world.scale * (c * lx - s * ly), y: n.world.y + n.world.scale * (s * lx + c * ly) };
  }, id);
  const spawn = (type, extra) => page.evaluate((type, extra) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get(type).defaults, ...extra });
    return app.selection;
  }, type, extra);
  const overlayRings = () => page.evaluate(() => document.querySelectorAll("polyline.place-rect").length);
  // The aim's VISIBLE affordance: the ring's stroke is the same ghost tone as the
  // bento's own cell guides, so the hot corner dots are what actually reads.
  const overlayHotDots = () => page.evaluate(() => document.querySelectorAll("circle.place-dot-hot").length);
  // A GHOST dot is a hover candidate; a HOT one is the committed aim. Two states, two
  // readings — counted separately so "they are distinguishable" is an assertion.
  const overlayGhostDots = () => page.evaluate(() => document.querySelectorAll("circle.place-dot:not(.place-dot-hot)").length);
  const overlayChains = () => page.evaluate(() => document.querySelectorAll("polyline.place-rect").length);
  // The CURSOR the canvas actually resolves. Not screenshot-able, so read the computed
  // style — which is also what proves the class reached a real app.css rule rather
  // than just landing in the DOM.
  const canvasCursor = () => page.evaluate(() => getComputedStyle(document.querySelector(".overlay")).cursor);
  const moveTo = async (wx, wy) => {
    const p = await worldToPage(wx, wy);
    await page.mouse.move(p.x, p.y);
    await sleep(SETTLE_MS);
  };
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const listRows = () => page.evaluate(() => [...document.querySelectorAll(".canvas-toolbar-list .palette-item")].map((b) => ({
    itemId: b.dataset.itemId,
    name: b.querySelector(".title")?.textContent ?? "",
    disabled: b.getAttribute("aria-disabled") === "true",
    reason: b.querySelector(".tool-tip-requires")?.textContent ?? null,
    highlighted: b.classList.contains("highlighted"),
  })));

  // ── Set the scene ─────────────────────────────────────────────────────────
  const bentoId = await spawn("bento", BENTO);
  const boxId = await spawn("rect", { ...BOX_START, ...BOX, name: BOX_NAME });
  // A GROUPED rect, so the list has a real refusal to grey: a member's x/y are read
  // in its group's frame while a cell anchor evaluates in world.
  const memberId = await spawn("rect", { x: 60, y: 620, w: 30, h: 20, name: MEMBER_NAME });
  const groupId = await page.evaluate((m) => {
    const app = window.__powerrp_app;
    app.selection = m;
    const id = app.addItem({ ...app.registry.get("group").defaults, x: 40, y: 600, w: 80, h: 60, members: [m] });
    return id ?? app.selection;
  }, memberId);
  await sleep(SETTLE_MS);
  ok(bentoId && boxId && memberId && groupId, `bento ${bentoId} + rect ${boxId} + grouped rect ${memberId} created`);

  // ── DISCOVERABILITY: selecting the bento announces the double-click ────────
  await clickAt(BENTO.x + 4, BENTO.y + 4); // a press anywhere in its box selects it
  const selBento = await page.evaluate(() => window.__powerrp_app.selection);
  ok(selBento === bentoId, `clicking the bento selects it (got ${selBento})`);
  const beforeLabels = await hintLabels();
  ok(beforeLabels.includes("Bind widgets to grid cells"),
    `the HintBar ANNOUNCES the double-click before you make it (got ${JSON.stringify(beforeLabels)})`);

  // ── ENTER: double-click the bento ─────────────────────────────────────────
  await clickAt(BENTO.x + 4, BENTO.y + 4, { clickCount: 2 });
  ok(await modeId() === "bento_bind_cell", `double-click enters the mode (got ${await modeId()})`);
  ok(await modeStep() === 0, `…at the AIM step (got ${await modeStep()})`);
  const aimLabels = await hintLabels();
  ok(aimLabels.includes("Click a cell to aim at it"), `the bar narrates the AIM step (got ${JSON.stringify(aimLabels)})`);
  ok(!aimLabels.some((l) => l.startsWith("Click the widget")), "…and NOT the bind step's wording yet");
  ok(aimLabels.some((l) => l.startsWith("Exit bind widgets")), "…plus the generated Escape entry");
  ok(await overlayRings() === 0, "nothing is aimed yet, so no cell outline is drawn");
  // THE CURSOR SAYS WHICH QUESTION IS BEING ASKED. `cell` is CSS's own "select a
  // cell of a grid" — read off the computed style, so this proves the class reached a
  // real app.css rule and not merely the DOM.
  ok(await canvasCursor() === "cell", `entering the mode sets the AIM cursor (got ${await canvasCursor()})`);
  ok(await listRows() !== null && (await listRows()).length === 0, "…and NO list yet: with no cell aimed there is nothing to bind into");
  await page.screenshot({ path: `${shots}/1_mode_entered.png` });

  // ── HOVER previews the cell BEFORE the press ───────────────────────────────
  const preHoverDoc = await docJson();
  await moveTo(TARGET_CENTRE.x, TARGET_CENTRE.y);
  ok(await overlayGhostDots() === 5, `hovering a cell HIGHLIGHTS it before any click (got ${await overlayGhostDots()} ghost dots)`);
  ok(await overlayHotDots() === 0, "…and nothing is hot yet, because nothing is committed");
  ok(await docJson() === preHoverDoc, "HOVERING WRITES NOTHING — the document is byte-identical");
  ok(await modeStep() === 0, "…and it does not advance the step either");
  const hoverRing = await page.evaluate(() => document.querySelector("polyline.place-rect")?.getAttribute("points") ?? null);
  // MOVING TO ANOTHER CELL MOVES THE HIGHLIGHT.
  await moveTo(BENTO.x + CELL_W / 2, BENTO.y + CELL_H / 2);
  const otherRing = await page.evaluate(() => document.querySelector("polyline.place-rect")?.getAttribute("points") ?? null);
  ok(hoverRing && otherRing && hoverRing !== otherRing, `moving between cells MOVES the highlight (${hoverRing} → ${otherRing})`);
  await page.screenshot({ path: `${shots}/1b_cell_hovered.png` });

  // ── AIM: click inside the target cell ─────────────────────────────────────
  await countCommits();
  await sleep(900); // let any unrelated async widget commit land before the baseline
  const commitBase = await commits();
  const docBefore = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  await clickAt(TARGET_CENTRE.x, TARGET_CENTRE.y);
  ok(await commits() - commitBase === 0, `aiming costs NO undo unit (got ${await commits() - commitBase})`);
  ok(await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc)) === docBefore,
    "AIMING WRITES NOTHING — the bento is a passive coordinate source, never edited");
  ok(await modeStep() === 1, `the aim advances the bar to the BIND step (got ${await modeStep()})`);
  const bindLabels = await hintLabels();
  ok(bindLabels.some((l) => l.startsWith("Click the widget that should sit in that cell")),
    `the bar narrates the BIND step (got ${JSON.stringify(bindLabels)})`);
  ok(!bindLabels.includes("Click a cell to aim at it"), "…and step 0's wording is gone");
  // TWO rings, and that is the correct answer: the press left the pointer resting on
  // the cell it just aimed, so the committed aim draws one ring and the live hover
  // candidate draws the same cell again. They are told apart by their DOTS, asserted
  // immediately below — which is the whole point of the two readings.
  ok(await overlayRings() === 2, `the aimed cell is OUTLINED, and so is the hover candidate under the pointer (got ${await overlayRings()} rings)`);
  ok(await overlayHotDots() === 5, `…and its CENTRE (the anchor being bound) plus its 4 corners carry the HOT guide accent, so the aim is READABLE on a grid whose own guides share the ring's tone (got ${await overlayHotDots()})`);
  // THE CURSOR FLIPS WITH THE STEP: `alias` is CSS's own "the action creates a link",
  // and a binding is a live link. Two questions, two cursors.
  ok(await canvasCursor() === "alias", `the BIND step takes its own cursor (got ${await canvasCursor()})`);

  // ── HOVER vs AIM ARE DISTINGUISHABLE (asserted, not eyeballed) ─────────────
  // The pointer is resting on the aimed cell, so its hover candidate is that same
  // cell: the SAME geometry drawn twice, once hot and once ghost. If the two shared a
  // reading this count could not tell them apart — which is the defect the aim ring
  // already had once.
  ok(await overlayGhostDots() === 5 && await overlayHotDots() === 5,
    `the committed aim (hot) and the hover candidate (ghost) coexist and are counted apart (${await overlayHotDots()} hot / ${await overlayGhostDots()} ghost)`);
  // Hovering the WIDGET instead previews the BIND: a leader from its centre to the cell.
  await moveTo(BOX_START.x + BOX.w / 2, BOX_START.y + BOX.h / 2);
  const leader = await page.evaluate(() => [...document.querySelectorAll("polyline.place-rect")]
    .map((n) => n.getAttribute("points").trim().split(/\s+/).length).filter((n) => n === 2).length);
  ok(leader === 1, `hovering the widget previews the bind as a 2-point leader to the aimed cell (got ${leader})`);
  await page.screenshot({ path: `${shots}/2b_widget_hovered.png` });

  // ── THE LIST — step 1's second input path ─────────────────────────────────
  const rows = await listRows();
  ok(rows.length >= 3, `the list appears once a cell is aimed, holding the slide's widgets (got ${rows.length} rows)`);
  ok(!rows.some((r) => r.itemId === bentoId), "the GRID ITSELF is not offered — binding it to its own cell is a cycle");
  // THE CAMERA is present but greyed (never hidden), and the reason states the
  // position — FLAGGED for ratification, reversible by deleting one clause.
  const cameraRow = rows.find((r) => r.name.startsWith("Camera"));
  ok(cameraRow && cameraRow.disabled && /is the view, not content/.test(cameraRow.reason ?? ""),
    `the camera is PRESENT and GREYED with its reason (got ${JSON.stringify(cameraRow)})`);
  ok(rows.filter((r) => !r.disabled).length >= 1, "…and at least one row is actually pickable");
  const bindableRow = rows.find((r) => r.name === BOX_NAME);
  ok(bindableRow && !bindableRow.disabled, `the target is listed by NAME, not a uuid (got ${JSON.stringify(bindableRow)})`);
  const greyRow = rows.find((r) => r.name === MEMBER_NAME);
  ok(greyRow && greyRow.disabled && /group member/.test(greyRow.reason ?? ""),
    `a group member is PRESENT and GREYED with its reason, never hidden (got ${JSON.stringify(greyRow)})`);
  ok(await page.evaluate(() => document.querySelector(".canvas-toolbar-list .palette-item")?.hasAttribute("disabled") === false),
    "rows use aria-disabled, not the native attribute — a disabled button fires no pointer events and could not explain itself");
  // A ROW'S HOVER IS *TARGET* FEEDBACK: it highlights that WIDGET on the canvas.
  const listDoc = await docJson();
  const rowHover = async (name) => {
    const box = await page.evaluate((n) => {
      const el = [...document.querySelectorAll(".canvas-toolbar-list .palette-item")].find((b) => b.querySelector(".title").textContent === n);
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, name);
    await page.mouse.move(box.x, box.y);
    await sleep(SETTLE_MS);
  };
  await rowHover(BOX_NAME);
  const rowLeader = await page.evaluate(() => [...document.querySelectorAll("polyline.place-rect")]
    .map((n) => n.getAttribute("points").trim().split(/\s+/).length).filter((n) => n === 2).length);
  ok(rowLeader === 1, `hovering a ROW highlights that widget on the CANVAS — the same leader a canvas hover draws (got ${rowLeader})`);
  ok(await docJson() === listDoc, "…and a row hover writes NOTHING");
  // A GREYED row previews nothing: it cannot be picked, so highlighting its widget
  // would promise an action that will not happen.
  await rowHover(MEMBER_NAME);
  const greyLeader = await page.evaluate(() => [...document.querySelectorAll("polyline.place-rect")]
    .map((n) => n.getAttribute("points").trim().split(/\s+/).length).filter((n) => n === 2).length);
  ok(greyLeader === 0, `a GREYED row previews nothing (got ${greyLeader} leaders)`);
  await page.screenshot({ path: `${shots}/2c_list.png` });
  await page.screenshot({ path: `${shots}/2_cell_aimed.png` });

  // ── BIND: click the widget ────────────────────────────────────────────────
  await clickAt(BOX_START.x + BOX.w / 2, BOX_START.y + BOX.h / 2);
  const xExpr = await stored(boxId, "x");
  const yExpr = await stored(boxId, "y");
  ok(typeof xExpr === "string" && xExpr.includes(`@${bentoId}_c1x2cm.x`),
    `x became an equation reading the cell CENTRE anchor by ITEM ID (got ${JSON.stringify(xExpr)})`);
  ok(typeof yExpr === "string" && yExpr.includes(`@${bentoId}_c1x2cm.y`), `…and y too (got ${JSON.stringify(yExpr)})`);
  const bound = await centreOf(boxId);
  ok(near(bound.x, TARGET_CENTRE.x) && near(bound.y, TARGET_CENTRE.y),
    `the widget's own CENTRE landed on the cell centre ${JSON.stringify(TARGET_CENTRE)} (got ${JSON.stringify(bound)})`);
  const bindCommits = await commits() - commitBase;
  ok(bindCommits === 1, `the whole binding (BOTH equations) is ONE undo unit (got ${bindCommits} commits)`);
  ok(await modeStep() === 0, `…and the mode returns to AIM, ready for the next cell (got ${await modeStep()})`);
  ok(await overlayRings() === 0 && await overlayHotDots() === 0, "…with the aim outline cleared");
  // The aim is SPENT, so the surface that acts on it goes: "it appears exactly when it
  // can act", which is also what stops a stale list from binding into a cell nobody aimed.
  ok((await listRows()).length === 0, "…and the list unmounts with the spent aim");
  await page.screenshot({ path: `${shots}/3_bound.png` });

  // ONE undo must take BOTH coordinates back, not leave the widget half-bound.
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  const undoneX = await stored(boxId, "x");
  const undoneY = await stored(boxId, "y");
  ok(typeof undoneX === "number" && typeof undoneY === "number",
    `ONE undo reverts the WHOLE binding — no half-bound widget (got x=${JSON.stringify(undoneX)}, y=${JSON.stringify(undoneY)})`);
  ok(await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc)) === docBefore,
    "…and the document is JSON-equal to the pre-bind one (no stray leaf left behind)");
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(SETTLE_MS);
  ok(typeof await stored(boxId, "x") === "string", "redo puts the binding back");

  // ── THE FEATURE: MOVE THE BENTO, and the widget must FOLLOW ───────────────
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);
  ok(await modeId() === null, "Escape leaves the mode");
  // THE CURSOR REVERTS, and structurally: the class is DERIVED from app.canvasMode, so
  // there is no imperative cursor state that could get stuck.
  ok(await canvasCursor() !== "cell" && await canvasCursor() !== "alias",
    `Escape reverts the cursor (got ${await canvasCursor()})`);
  ok((await listRows()).length === 0, "…and the list goes with the mode");
  await page.evaluate((id, dx, dy) => {
    const app = window.__powerrp_app;
    app.selection = id;
    app.setPreview([[["items", id, "x"], app.state().items[id].x + dx], [["items", id, "y"], app.state().items[id].y + dy]]);
    app.commitPreview();
  }, bentoId, BENTO_SHIFT.x, BENTO_SHIFT.y);
  await sleep(SETTLE_MS);
  const followed = await centreOf(boxId);
  const want = { x: TARGET_CENTRE.x + BENTO_SHIFT.x, y: TARGET_CENTRE.y + BENTO_SHIFT.y };
  ok(near(followed.x, want.x) && near(followed.y, want.y),
    `THE FEATURE: the bento moved by ${JSON.stringify(BENTO_SHIFT)} and the widget FOLLOWED to ${JSON.stringify(want)} (got ${JSON.stringify(followed)})`);
  await page.screenshot({ path: `${shots}/4_bento_moved_widget_followed.png` });

  // …and when the GRID SHAPE changes: cell (1,2) of a 3-row grid is a different
  // point, and a bound widget re-flows to it with no re-run of any tool.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.selection = id;
    app.setPreview([[["items", id, "rows"], 4]]);
    app.commitPreview();
  }, bentoId);
  await sleep(SETTLE_MS);
  const reflowed = await centreOf(boxId);
  const wantReflow = { x: want.x, y: BENTO.y + BENTO_SHIFT.y + (BENTO.h / 4) * 1.5 };
  ok(near(reflowed.x, wantReflow.x) && near(reflowed.y, wantReflow.y),
    `editing ROWS re-flows the bound widget to ${JSON.stringify(wantReflow)} (got ${JSON.stringify(reflowed)})`);

  // ── THE LIST PATH WRITES THE SAME BINDING AS THE CANVAS PATH ──────────────
  // Both must reach the mode's ONE write, so re-run the whole gesture picking from the
  // list this time and compare the stored equations leaf for leaf.
  const canvasEquations = { x: await stored(boxId, "x"), y: await stored(boxId, "y") };
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.selection = id;
    app.commands.all().find((c) => c.id === "unbind-from-camera").run(app); // back to numbers
  }, boxId);
  await sleep(SETTLE_MS);
  // Restore the ROW COUNT first: the re-flow check above set it to 4, so the same
  // world point would now be a DIFFERENT cell and the two paths would be compared on
  // different bindings. The comparison is about the PATH, so hold everything else equal.
  await page.evaluate((id, rows) => {
    const app = window.__powerrp_app;
    app.selection = id;
    app.setPreview([[["items", id, "rows"], rows]]);
    app.commitPreview();
  }, bentoId, BENTO.rows);
  await sleep(SETTLE_MS);
  await clickAt(BENTO.x + BENTO_SHIFT.x + 4, BENTO.y + BENTO_SHIFT.y + 4, { clickCount: 2 }); // re-enter
  ok(await modeId() === "bento_bind_cell", "re-entered the mode for the list path");
  await clickAt(TARGET_CENTRE.x + BENTO_SHIFT.x, TARGET_CENTRE.y + BENTO_SHIFT.y); // aim the SAME cell
  const listCommitBase = await commits();
  await rowHover(BOX_NAME);
  await page.evaluate((n) => {
    [...document.querySelectorAll(".canvas-toolbar-list .palette-item")].find((b) => b.querySelector(".title").textContent === n).click();
  }, BOX_NAME);
  await sleep(SETTLE_MS);
  const listEquations = { x: await stored(boxId, "x"), y: await stored(boxId, "y") };
  ok(listEquations.x === canvasEquations.x && listEquations.y === canvasEquations.y,
    `picking from the LIST writes the IDENTICAL binding a canvas click did (${JSON.stringify(listEquations)} vs ${JSON.stringify(canvasEquations)})`);
  ok(await commits() - listCommitBase === 1, `…in ONE undo unit (got ${await commits() - listCommitBase})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  ok(typeof await stored(boxId, "x") === "number", "…and ONE undo reverts the list-path binding too");
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(SETTLE_MS);
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);

  // ── THE WAY OUT: the existing Unbind command enables itself here ──────────
  // Read the centre HERE, not from an earlier assertion's value: the list-path run
  // above re-bound the widget, so freezing must be compared against where it is NOW.
  const beforeUnbind = await centreOf(boxId);
  const unbind = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.selection = id;
    const cmd = app.commands.all().find((c) => c.id === "unbind-from-camera");
    return { title: cmd?.title ?? null, enabled: cmd ? cmd.when?.(app) !== false : null };
  }, boxId);
  ok(unbind.enabled === true, `"${unbind.title}" is ENABLED on a cell-bound widget (got ${JSON.stringify(unbind)})`);
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.commands.all().find((c) => c.id === "unbind-from-camera").run(app);
  });
  await sleep(SETTLE_MS);
  const frozenX = await stored(boxId, "x");
  ok(typeof frozenX === "number", `…and it FREEZES the binding to a number (got ${JSON.stringify(frozenX)})`);
  const frozen = await centreOf(boxId);
  ok(near(frozen.x, beforeUnbind.x) && near(frozen.y, beforeUnbind.y),
    `…without moving the widget (${JSON.stringify(beforeUnbind)} → ${JSON.stringify(frozen)})`);

  ok(liveErrors.length === 0, `no runtime errors during the whole session (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "  ok " : "FAIL"}  ${label}`);
if (errors.length) {
  console.error(`\n${errors.length} check(s) failed:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\n${checks.length}/${checks.length} bento cell-binding checks passed. Shots in ${shots}`);
