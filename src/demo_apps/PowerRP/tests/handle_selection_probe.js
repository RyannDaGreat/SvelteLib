/**
 * SELECTABLE-HANDLE probe — boot the PowerRP editor headless, add a polygon, and
 * drive REAL pointer gestures on its vertex handles via page.mouse (the technique
 * tests/modifier_probe.js establishes: page.mouse routes through real pointer
 * capture, which a synthetic dispatchEvent cannot, because CanvasView's drag
 * handlers call setPointerCapture).
 *
 * Proves, against the REAL app:
 *   - a click on a handle SELECTS it (the inner selection scope);
 *   - SHIFT-CLICK TOGGLES membership — adds an unselected handle, and REMOVES an
 *     already-selected one (the item-level shift-click semantics, verbatim);
 *   - dragging a MULTI-HANDLE selection moves EVERY selected handle by the same
 *     delta and leaves the unselected ones exactly where they were;
 *   - mid-drag the COMMITTED document is unchanged (the preview is pure);
 *   - the whole multi-handle drag commits EXACTLY ONE undo unit — measured by JSON
 *     COMPARE of the document before and after undo(), never by reference identity,
 *     because undo() restores an EQUAL document through a fresh reactive proxy;
 *   - ADD VERTEX (double-click on the outline) lands ON the chain: the polygon's
 *     INK RECT is unchanged, so the shape does not jump;
 *   - HIDE closes the outline over a vertex WITHOUT renumbering: the handle set and
 *     every handle's element index survive it, and PURGE renumbers (the reason the
 *     two are separate operations);
 *   - THE TWO SELECTION SCOPES under Escape: with handles selected, Escape clears
 *     the HANDLES and leaves the item selected; a second Escape then deselects the
 *     item. The HintBar shows exactly one Escape meaning at a time.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/handle_selection_probe.js
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import * as T from "../core/transform.js";

// Paths resolve off THIS file, never process.cwd() — the suite convention, so the
// probe runs identically from the repo root or from its own directory.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../web");
const demoJson = await readFile(resolve(here, "../examples/demo.powerrp.json"), "utf8");

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// The same stale-fixture boot-noise allowance modifier_probe.js documents: other
// agents' in-flight migrations on the shared demo fixture, plus this container's
// headless graphics reality (the fixture's video widgets probe for an adapter the
// software renderer does not expose). Named specifically — anything else still fails.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  const liveErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || isBootNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  /**
   * Adds a polygon at a known pose (optionally rotated) via the real addItem +
   * preview/commit API, selects it, and returns its itemId, node.world, and every
   * handle's LOCAL position. The probe computes WORLD positions itself through the
   * imported core/transform.js — the exact pure function nodeModifierPoints calls —
   * rather than hardcoding geometry (modifier_probe's rule), so it reads real app
   * state either way and only the matrix multiply happens in Node.
   */
  const setupPolygon = (rotation) => page.evaluate((rotation) => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get("polygon").defaults);
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], 300], [["items", id, "y"], 260],
      [["items", id, "w"], 300], [["items", id, "h"], 300],
      [["items", id, "rotation"], rotation],
      // A SQUARE, so every handle is far from every other one at this size and a
      // click can never land ambiguously between two.
      [["items", id, "points"], [[0, 0], [1, 0], [1, 1], [0, 1]]],
      [["items", id, "closed"], true],
    ]);
    app.commitPreview();
    const node = app.nodes().find((n) => n.itemId === id);
    return { id, world: node.world, locals: node.plugin.modifierPoints(node.state).map((m) => ({ id: m.id, x: m.x, y: m.y })) };
  }, rotation);

  /** World point → PAGE (absolute) screen coords, through the app's OWN
   *  canvasActions.worldToScreen plus the overlay's real bounding rect — so the
   *  probe never assumes a zoom/pan (modifier_probe's worldToPage). */
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  // EVERY array read out of the page goes through JSON: a Svelte $state proxy
  // array serializes over CDP as a plain OBJECT ({"0": …}), which silently loses
  // .length and Array.isArray (the concerns.md proxy gotcha). Stringifying in-page
  // and parsing here gives real arrays back.
  const handleSelection = () => page.evaluate(() => JSON.stringify([...window.__powerrp_app.handleSelection])).then(JSON.parse);
  const docPoints = (id) => page.evaluate((id) => JSON.stringify(window.__powerrp_app.state().items?.[id]?.points ?? null), id).then(JSON.parse);
  const committedPoints = (id) => page.evaluate((id) => {
    const a = window.__powerrp_app;
    // The COMMITTED value: folded from the document with NO preview delta merged.
    for (let i = a.slideIndex; i >= 0; i--) {
      const p = a.doc.slides[i].delta.items?.[id]?.points;
      if (p) return JSON.stringify(p);
    }
    return "null";
  }, id).then(JSON.parse);
  const docActive = (id) => page.evaluate((id) => JSON.stringify(window.__powerrp_app.state().items?.[id]?.pointsActive ?? null), id).then(JSON.parse);
  /** A stable JSON snapshot of the whole document — what "exactly one undo unit"
   *  is measured against. Reference identity is useless here: undo() restores an
   *  EQUAL document through a fresh reactive proxy. */
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const pageOf = (setup, handleId) => {
    const l = setup.locals.find((h) => h.id === handleId);
    const w = T.apply(setup.world, l.x, l.y);
    return worldToPage(w.x, w.y);
  };
  const clickHandle = async (setup, handleId, { shift = false } = {}) => {
    const p = await pageOf(setup, handleId);
    await page.mouse.move(p.x, p.y);
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
    await new Promise((r) => setTimeout(r, 60));
  };

  // ── Scenario 1: click selects; shift-click TOGGLES (both directions) ────────
  {
    const setup = await setupPolygon(0);
    ok(setup.locals.length === 4, `4 vertex handles (got ${setup.locals.length})`);
    ok((await handleSelection()).length === 0, "no handle is selected before any handle is clicked");
    await clickHandle(setup, "p0");
    ok(JSON.stringify(await handleSelection()) === '["p0"]', `click SELECTS the handle (got ${JSON.stringify(await handleSelection())})`);
    // The ITEM stays selected throughout — the two scopes are independent.
    ok(await page.evaluate((id) => window.__powerrp_app.selection === id, setup.id), "the item is still selected while a handle is");
    await clickHandle(setup, "p2", { shift: true });
    ok(JSON.stringify(await handleSelection()) === '["p0","p2"]', `shift-click ADDS (got ${JSON.stringify(await handleSelection())})`);
    // …and shift-clicking an ALREADY-SELECTED handle REMOVES it. This is the half
    // that distinguishes "toggle" from "add", and the manifest's item-level rule.
    await clickHandle(setup, "p0", { shift: true });
    ok(JSON.stringify(await handleSelection()) === '["p2"]', `shift-click on a SELECTED handle REMOVES it (got ${JSON.stringify(await handleSelection())})`);
    // A plain click on a third handle REPLACES the set (a plain item click's rule).
    await clickHandle(setup, "p1");
    ok(JSON.stringify(await handleSelection()) === '["p1"]', `plain click REPLACES the set (got ${JSON.stringify(await handleSelection())})`);
  }

  // ── Scenario 2: dragging a MULTI-handle selection moves ALL of them, once ───
  {
    const setup = await setupPolygon(0);
    await clickHandle(setup, "p0");
    await clickHandle(setup, "p1", { shift: true });
    ok(JSON.stringify(await handleSelection()) === '["p0","p1"]', "two handles selected for the drag");
    const before = await docPoints(setup.id);
    const docBefore = await docJson();
    // Drag p0 by a known WORLD delta; p1 must follow by the SAME delta and p2/p3
    // must not move at all.
    const l0 = setup.locals.find((h) => h.id === "p0");
    const w0 = T.apply(setup.world, l0.x, l0.y);
    const from = await worldToPage(w0.x, w0.y);
    const DX = 60, DY = 30; // world units
    const to = await worldToPage(w0.x + DX, w0.y + DY);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    const midPreview = await docPoints(setup.id);
    const midCommitted = await committedPoints(setup.id);
    ok(JSON.stringify(midCommitted) === JSON.stringify(before), "mid-drag: the COMMITTED document is UNCHANGED (the preview is pure)");
    // The normalized delta a DX/DY world move is, at w = h = 300.
    const nx = DX / 300, ny = DY / 300;
    const near = (a, b) => Math.abs(a - b) < 2e-2;
    ok(near(midPreview[0][0] - before[0][0], nx) && near(midPreview[0][1] - before[0][1], ny), `mid-drag: the GRABBED handle moved by the drag delta (${JSON.stringify(midPreview[0])})`);
    ok(near(midPreview[1][0] - before[1][0], nx) && near(midPreview[1][1] - before[1][1], ny), `mid-drag: the OTHER SELECTED handle moved by the SAME delta (${JSON.stringify(midPreview[1])})`);
    ok(JSON.stringify(midPreview[2]) === JSON.stringify(before[2]) && JSON.stringify(midPreview[3]) === JSON.stringify(before[3]), "mid-drag: the UNSELECTED handles did not move");
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 120));
    const after = await docPoints(setup.id);
    ok(JSON.stringify(after) === JSON.stringify(midPreview), "commit: the committed value IS what the last preview frame showed");
    ok(await page.evaluate(() => window.__powerrp_app.previewDelta === null || window.__powerrp_app.previewDelta === undefined), "commit: the preview is cleared");
    // EXACTLY ONE UNDO UNIT, by JSON COMPARE (never reference identity).
    const docAfter = await docJson();
    ok(docAfter !== docBefore, "the drag really changed the document (the undo check is not vacuous)");
    await page.evaluate(() => window.__powerrp_app.undo());
    await new Promise((r) => setTimeout(r, 60));
    ok(await docJson() === docBefore, "ONE undo unit: a single undo restores the document EXACTLY (JSON compare)");
    await page.evaluate(() => window.__powerrp_app.redo());
  }

  // ── Scenario 3: the multi-handle drag is correct at 45° too ─────────────────
  {
    const setup = await setupPolygon(Math.PI / 4);
    await clickHandle(setup, "p0");
    await clickHandle(setup, "p2", { shift: true });
    ok(JSON.stringify(await handleSelection()) === '["p0","p2"]', "45°: two opposite handles selected");
    const before = await docPoints(setup.id);
    const l0 = setup.locals.find((h) => h.id === "p0");
    const w0 = T.apply(setup.world, l0.x, l0.y);
    ok(Math.abs(w0.y - 260) > 1, `45°: the handle's world Y is OFF the unrotated axis (${w0.y}) — it really reads through node.world`);
    const from = await worldToPage(w0.x, w0.y);
    // Move along the ROTATED item's own local-x basis, so the expected LOCAL delta
    // is a clean (+45, 0) regardless of screen orientation.
    const LEN = 45;
    const dirX = Math.cos(setup.world.rotation), dirY = Math.sin(setup.world.rotation);
    const to = await worldToPage(w0.x + LEN * dirX, w0.y + LEN * dirY);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    const mid = await docPoints(setup.id);
    const near = (a, b) => Math.abs(a - b) < 2e-2;
    // LEN local units along local x, at w = 300 → +0.15 in x, 0 in y, for BOTH.
    ok(near(mid[0][0] - before[0][0], LEN / 300) && near(mid[0][1] - before[0][1], 0), `45°: the grabbed handle moved purely along LOCAL x (${JSON.stringify(mid[0])})`);
    ok(near(mid[2][0] - before[2][0], LEN / 300) && near(mid[2][1] - before[2][1], 0), `45°: the other selected handle moved by the SAME local delta (${JSON.stringify(mid[2])})`);
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 100));
  }

  // ── Scenario 4: ADD VERTEX (double-click) lands ON the chain ────────────────
  {
    const setup = await setupPolygon(0);
    const before = await docPoints(setup.id);
    const inkOf = (id) => page.evaluate((id) => {
      const app = window.__powerrp_app;
      const node = app.nodes().find((n) => n.itemId === id);
      return node.plugin.localBounds(node.state);
    }, setup.id);
    const inkBefore = await inkOf(setup.id);
    const docBefore = await docJson();
    // Double-click the MIDPOINT of the top edge (between p0 and p1) — on the chain.
    const l0 = setup.locals.find((h) => h.id === "p0"), l1 = setup.locals.find((h) => h.id === "p1");
    const wm = T.apply(setup.world, (l0.x + l1.x) / 2, (l0.y + l1.y) / 2);
    const p = await worldToPage(wm.x, wm.y);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y, { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 150));
    const after = await docPoints(setup.id);
    ok(after.length === before.length + 1, `double-click on the outline ADDS one vertex (${before.length} → ${after.length})`);
    ok(JSON.stringify(after[2]) === JSON.stringify(before[1]), "the displaced vertex is INTACT, one index later");
    const inkAfter = await inkOf(setup.id);
    for (const k of ["x", "y", "w", "h"])
      ok(Math.abs(inkBefore[k] - inkAfter[k]) < 1e-6, `THE SHAPE DID NOT JUMP: ink rect ${k} unchanged (${inkBefore[k]} vs ${inkAfter[k]})`);
    ok(await docActive(setup.id) === null, "no visibility companion is minted by an insert into a list that never hid anything");
    await page.evaluate(() => window.__powerrp_app.undo());
    await new Promise((r) => setTimeout(r, 60));
    ok(await docJson() === docBefore, "ONE undo unit: add-vertex undoes in a single step (JSON compare)");
    await page.evaluate(() => window.__powerrp_app.redo());
  }

  // ── Scenario 5: HIDE closes the outline WITHOUT renumbering; PURGE renumbers ─
  {
    const setup = await setupPolygon(0);
    const before = await docPoints(setup.id);
    await clickHandle(setup, "p1");
    const docBefore = await docJson();
    // Run the REAL command entry (app.commands.get(id).run(app) — what the palette,
    // the toolbar button and the Backspace binding all resolve to), so the probe
    // exercises the same path a user does, gate included.
    await page.evaluate(() => { const a = window.__powerrp_app; const c = a.commands.get("hide-points"); if (!c.when(a)) throw new Error("hide-points is gated off with handles selected"); c.run(a); });
    await new Promise((r) => setTimeout(r, 100));
    ok(JSON.stringify(await docPoints(setup.id)) === JSON.stringify(before), "HIDE: the vertex LIST is byte-identical — nothing was renumbered");
    const active = await docActive(setup.id);
    ok(Array.isArray(active) && active[1] === false, `HIDE: only the companion flag changed (${JSON.stringify(active)})`);
    // The drawn outline really closed over it (4 stored vertices, 3 drawn).
    const drawn = await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const node = app.nodes().find((n) => n.itemId === id);
      return { handles: node.plugin.modifierPoints(node.state).length, ops: JSON.stringify(node.plugin.emit(node.state)) };
    }, setup.id);
    ok(drawn.handles === 4, `HIDE: every STORED vertex still has a handle (${drawn.handles}) — a hidden vertex must be showable again`);
    ok((drawn.ops.match(/L/g) ?? []).length === 2, `HIDE: the emitted path has 3 vertices (M + 2 L), so the outline closed over the hidden one (${drawn.ops.slice(0, 120)})`);
    ok((await handleSelection()).length === 1, "HIDE keeps the handle selected (so the same button flips it back)");
    await page.evaluate(() => window.__powerrp_app.undo());
    await new Promise((r) => setTimeout(r, 60));
    ok(await docJson() === docBefore, "ONE undo unit: hide undoes in a single step (JSON compare)");
    await page.evaluate(() => window.__powerrp_app.redo());
    // PURGE, by contrast, SPLICES — and renumbers, which is exactly why it is a
    // different button with the consequence in its own title.
    await page.evaluate(() => { const a = window.__powerrp_app; const c = a.commands.get("purge-points"); if (!c.when(a)) throw new Error("purge-points is gated off with handles selected"); c.run(a); });
    await new Promise((r) => setTimeout(r, 100));
    const purged = await docPoints(setup.id);
    ok(purged.length === before.length - 1, `PURGE: the element is spliced out (${before.length} → ${purged.length})`);
    ok(JSON.stringify(purged[1]) === JSON.stringify(before[2]), "PURGE RENUMBERS: what was vertex 2 is now vertex 1");
    ok((await handleSelection()).length === 0, "PURGE clears the handle selection (the element no longer exists)");
  }

  // ── Scenario 6: THE TWO SELECTION SCOPES under Escape ───────────────────────
  {
    const setup = await setupPolygon(0);
    await clickHandle(setup, "p0");
    await clickHandle(setup, "p2", { shift: true });
    ok((await handleSelection()).length === 2, "two handles selected before Escape");
    // THE BAR THE USER ACTUALLY SEES must show exactly ONE Escape meaning, and it
    // must be the INNER scope's. Read off the RENDERED chips (lib/HintBar.svelte's
    // .hint > .keys/.label), not off a test-only hook — a hook could agree with the
    // registry while the bar disagreed with both. Matched on the KEY ICON, because
    // lib/KeyCombo.svelte draws Escape as an icon (keyicons.js "mdi:keyboard-esc")
    // and renders no text for it — a textContent match silently finds nothing.
    const escLabels = await page.evaluate(() => JSON.stringify(
      [...document.querySelectorAll(".hintbar .hint")]
        .filter((el) => el.querySelector('.keys iconify-icon[icon="mdi:keyboard-esc"]'))
        .map((el) => el.querySelector(".label")?.textContent ?? ""))).then(JSON.parse);
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 80));
    ok((await handleSelection()).length === 0, "Escape clears the HANDLE selection");
    ok(await page.evaluate((id) => window.__powerrp_app.selection === id, setup.id), "Escape did NOT deselect the item — the two scopes are separate");
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 80));
    ok(await page.evaluate(() => window.__powerrp_app.selection === null), "a SECOND Escape then deselects the item (the outer scope)");
    ok(escLabels.length === 1, `the HintBar shows EXACTLY ONE Escape chip with handles selected (${JSON.stringify(escLabels)})`);
    ok(escLabels[0] === "Deselect points", `and it is the INNER scope's meaning, not "Deselect" (${JSON.stringify(escLabels)})`);
  }

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  if (errors.length) { console.error("\nFAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} handle-selection checks passed`);
} finally {
  await browser.close();
  await server.close();
}
