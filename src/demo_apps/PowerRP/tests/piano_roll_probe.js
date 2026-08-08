/**
 * THE FULLSCREEN PIANO ROLL, in a real browser.
 * Run: node src/demo_apps/PowerRP/tests/piano_roll_probe.js
 *
 * ── WHAT THIS ASKS THAT A UNIT TEST CANNOT ──────────────────────────────────
 * core/piano_roll.js's arithmetic and core/midi_clip.js's edits are already pinned
 * in bare node (tests/piano_roll_test.js, tests/midi_clip_test.js), deliberately —
 * see either file's header. So this probe does NOT re-derive the mapping. It asks
 * only the four questions that require a browser, each of which is a way the
 * feature could be completely dead while every unit test stayed green:
 *
 *   1. DOES DOUBLE-CLICK OPEN IT? The ACTIVATE registry, CanvasView's dispatch, the
 *      app signal and App.svelte's mount are four separate links and a unit test
 *      sees none of them. A widget whose double-click does nothing is exactly what
 *      web/widget_handlers.js's migration gate exists to prevent, and the gate can
 *      only prove the DECLARATION is present, not that the chain runs.
 *   2. IS IT STYLED? web app components carry no <style> block, so every rule lives
 *      in app.css and a missing one is invisible until it renders. A grid with zero
 *      height is a fully-functional editor nobody can use.
 *   3. DOES A REAL DRAG WRITE THE DOCUMENT? Pointer capture, the preview seam and
 *      the commit are browser machinery.
 *   4. IS ONE GESTURE ONE UNDO UNIT? Measured by UNDOING ONCE and checking the clip
 *      came all the way back — which is the property that actually matters, and is
 *      stronger than counting a stack.
 */

import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

// hmr: false — a sibling agent's save mid-run would reload the page and destroy the
// execution context (tests/list_ui_probe.js's measured reason).
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const liveErrors = [];
  page.on("pageerror", (e) => liveErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // No project backend when this probe is run alone; WebGPU absence is noise.
    if (/\/api\/projects|500 \(Internal Server Error\)|no.*adapter|adapters/i.test(t)) return;
    liveErrors.push(`console.error: ${t}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  // THE SPLASH MUST LIFT BEFORE ANY SYNTHETIC CLICK: it is fixed, inset 0,
  // z-index 9999 until the first painted frame. 120 s for the reason
  // tests/present_reachable_probe.js records — with several agents' Vite servers on
  // one host the dep optimizer keeps the network busy past the app being usable.
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 120000 });
  const settle = (ms = 220) => sleep(ms);

  /** Query. ROUND-TRIPPED THROUGH JSON INSIDE THE PAGE. Load-bearing: the evaluated
   *  state is Svelte 5 `$state`, a deep PROXY, and CDP's serializer does not see a
   *  Proxy over an Array as an array — a clip would arrive as `{"0": {...}}` and
   *  every `.length` on it would fail, reading exactly like a broken feature
   *  (tests/note_latch_probe.js measured this and records it at length). */
  const clipOf = (id) => page.evaluate(
    (id) => JSON.parse(JSON.stringify(window.__powerrp_app.state().items[id]?.clip ?? null)), id);

  // ── A CLIP NODE ON THE CANVAS ─────────────────────────────────────────────
  const id = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("node_midi_clip").defaults, x: 200, y: 200 });
    return app.selection;
  });
  await settle(400);
  ok(!!id, "a MIDI Clip node can be inserted");
  ok(JSON.stringify(await clipOf(id)) === "[]", "a fresh clip node holds the empty stream");

  // ── 1. DOUBLE-CLICK OPENS IT (the whole ACTIVATE chain, end to end) ───────
  const onWidget = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    const s = app.canvasActions.worldToScreen(n.state.x + 40, n.state.y + 20);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, id);
  await page.mouse.click(onWidget.x, onWidget.y, { clickCount: 2 });
  await settle(500);
  const opened = await page.evaluate(() => !!document.querySelector(".pr-root"));
  ok(opened, "DOUBLE-CLICKING the widget opens the fullscreen piano roll");
  ok(await page.evaluate(() => !!window.__powerrp_pianoRoll), "the editor publishes its test seam");
  // The dialog must carry role="dialog", which is what stands the canvas shortcuts
  // down — otherwise Delete inside the roll would also delete the WIDGET.
  ok(await page.evaluate(() => !!document.querySelector('.modal-panel[role="dialog"] .pr-root')),
    "it is a real dialog, so the canvas shortcuts stand down while it is open");

  // ── 2. IT IS ACTUALLY STYLED (no <style> blocks in web/ — app.css or nothing) ──
  const layout = await page.evaluate(() => {
    const grid = document.querySelector(".pr-grid");
    const keys = document.querySelector(".pr-keys");
    const g = grid?.getBoundingClientRect();
    const k = keys?.getBoundingClientRect();
    const lane = document.querySelector(".pr-lane");
    return {
      gridW: g?.width ?? 0, gridH: g?.height ?? 0, keysW: k?.width ?? 0,
      laneFill: lane ? getComputedStyle(lane).fill : null,
      noteCount: document.querySelectorAll(".pr-note").length,
      keyCount: document.querySelectorAll(".pr-key").length,
      toolbar: !!document.querySelector(".pr-toolbar"),
      footer: !!document.querySelector(".pr-footer"),
    };
  });
  ok(layout.gridW > 400 && layout.gridH > 200, `the grid has real size (${Math.round(layout.gridW)}x${Math.round(layout.gridH)})`);
  ok(layout.keysW > 20, `the key column has real width (${Math.round(layout.keysW)})`);
  ok(layout.keyCount > 10, `pitch rows are drawn (${layout.keyCount})`);
  ok(layout.laneFill && layout.laneFill !== "none" && layout.laneFill !== "rgb(0, 0, 0)",
    `the lanes are painted from app.css (fill: ${layout.laneFill})`);
  ok(layout.toolbar && layout.footer, "the toolbar and footer are present");
  ok(layout.noteCount === 0, "an empty clip draws no notes");

  /** Query. A page point over a given beat and pitch, from the editor's OWN view —
   *  so the probe aims where the editor actually drew, rather than at a guess. */
  const at = (beat, pitch) => page.evaluate((beat, pitch) => {
    const pr = window.__powerrp_pianoRoll;
    const v = pr.view();
    const r = pr.gridRect();
    return {
      x: r.x + (beat - v.originBeat) * v.beatWidth,
      y: r.y + (v.topPitch - pitch) * v.rowHeight + v.rowHeight / 2,
    };
  }, beat, pitch);

  // Snap to a quarter note so the arithmetic below is exact.
  await page.evaluate(() => window.__powerrp_pianoRoll.setSnap(1));
  await settle(120);

  // ── 3. A REAL CLICK ON EMPTY GRID ADDS A NOTE ────────────────────────────
  const addPoint = await at(2, 72);
  await page.mouse.click(addPoint.x + 4, addPoint.y);
  await settle(300);
  let clip = await clipOf(id);
  ok(Array.isArray(clip) && clip.length === 1, `clicking empty grid adds one note (got ${JSON.stringify(clip)})`);
  ok(clip?.[0]?.[0] === 2, `…at the beat that was clicked (start ${clip?.[0]?.[0]})`);
  ok(clip?.[0]?.[2] === 72, `…and the pitch of the row (pitch ${clip?.[0]?.[2]})`);
  ok(clip?.[0]?.[1] === 1, `…one grid cell long (duration ${clip?.[0]?.[1]})`);
  ok(await page.evaluate(() => document.querySelectorAll(".pr-note").length) === 1, "and it is DRAWN");

  // ── 4. ONE GESTURE IS ONE UNDO UNIT ──────────────────────────────────────
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle(250);
  ok(JSON.stringify(await clipOf(id)) === "[]", "ONE undo removes the whole add — one gesture, one undo unit");
  await page.evaluate(() => window.__powerrp_app.redo());
  await settle(250);
  ok((await clipOf(id))?.length === 1, "…and redo brings it back");

  // ── A REAL DRAG MOVES THE NOTE ───────────────────────────────────────────
  const from = await at(2.5, 72);           // mid-note, so it is the BODY not an edge
  const to = await at(4.5, 69);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await settle(320);
  clip = await clipOf(id);
  ok(clip?.[0]?.[0] === 4, `dragging the body moves the note in TIME (start ${clip?.[0]?.[0]})`);
  ok(clip?.[0]?.[2] === 69, `…and in PITCH (pitch ${clip?.[0]?.[2]})`);
  ok(clip?.[0]?.[1] === 1, `…without changing its length (duration ${clip?.[0]?.[1]})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle(250);
  clip = await clipOf(id);
  ok(clip?.[0]?.[0] === 2 && clip?.[0]?.[2] === 72, "ONE undo reverts the whole drag");
  await page.evaluate(() => window.__powerrp_app.redo());
  await settle(250);

  // ── AN EDGE DRAG RESIZES IT ──────────────────────────────────────────────
  const noteEnd = await page.evaluate(() => {
    const pr = window.__powerrp_pianoRoll;
    const v = pr.view();
    const r = pr.gridRect();
    const n = pr.rows()[0];
    return {
      x: r.x + (n.start + n.duration - v.originBeat) * v.beatWidth - 2,
      y: r.y + (v.topPitch - n.pitch) * v.rowHeight + v.rowHeight / 2,
    };
  });
  const stretchTo = await at(8, 69);
  await page.mouse.move(noteEnd.x, noteEnd.y);
  await page.mouse.down();
  await page.mouse.move(stretchTo.x, stretchTo.y, { steps: 8 });
  await page.mouse.up();
  await settle(320);
  clip = await clipOf(id);
  ok(clip?.[0]?.[0] === 4, `an END-edge drag leaves the start alone (start ${clip?.[0]?.[0]})`);
  ok(clip?.[0]?.[1] === 4, `…and moves the end (duration ${clip?.[0]?.[1]})`);

  // ── VELOCITY ─────────────────────────────────────────────────────────────
  await page.evaluate(() => window.__powerrp_pianoRoll.setVelocity(40));
  await settle(250);
  clip = await clipOf(id);
  ok(clip?.[0]?.[3] === 40, `the velocity control writes the selected note (velocity ${clip?.[0]?.[3]})`);

  // ── RIGHT-CLICK ERASES ───────────────────────────────────────────────────
  const onNote = await at(5, 69);
  await page.mouse.click(onNote.x, onNote.y, { button: "right" });
  await settle(300);
  ok(JSON.stringify(await clipOf(id)) === "[]", "right-click erases the note under the pointer");
  ok(await page.evaluate(() => document.querySelectorAll(".pr-note").length) === 0, "…and it stops being drawn");

  // ── A HIDDEN / BOUND NOTE IS COUNTED, NOT SILENTLY ABSENT ────────────────
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([
      [["items", id, "clip"], [[0, 1, 60, 100], [1, 1, 64, 100]]],
      [["items", id, "clipActive"], [true, false]],
    ]);
    app.commitPreview();
  }, id);
  await settle(320);
  const shown = await page.evaluate(() => ({
    drawn: document.querySelectorAll(".pr-note").length,
    skipped: window.__powerrp_pianoRoll.skipped(),
    status: document.querySelector(".pr-status")?.textContent?.trim(),
  }));
  ok(shown.drawn === 1, `a HIDDEN note is not drawn (drawn ${shown.drawn})`);
  ok(shown.skipped === 1, `…and IS counted (skipped ${shown.skipped})`);
  ok(/not shown/.test(shown.status ?? ""), `…and the footer SAYS SO (${JSON.stringify(shown.status)})`);

  // ── CLOSING ──────────────────────────────────────────────────────────────
  await page.evaluate(() => document.querySelector(".pr-footer .pr-primary").click());
  await settle(300);
  ok(await page.evaluate(() => !document.querySelector(".pr-root")), "Done closes the editor");
  ok(await page.evaluate(() => !window.__powerrp_pianoRoll), "…and retires its test seam");
  ok((await clipOf(id))?.length === 2, "the committed clip survives the close");

  // ── THE ABC NODE'S DOUBLE-CLICK OPENS THE CODE MODAL ─────────────────────
  const abcId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("node_abc").defaults, x: 700, y: 200 });
    return app.selection;
  });
  await settle(400);
  const onAbc = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    const s = app.canvasActions.worldToScreen(n.state.x + 40, n.state.y + 20);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, abcId);
  await page.mouse.click(onAbc.x, onAbc.y, { clickCount: 2 });
  await settle(900);
  ok(await page.evaluate(() => !!window.__powerrp_codeModal), "double-clicking the ABC node opens the code modal");
  const abcText = await page.evaluate(() => window.__powerrp_codeModal?.getValue() ?? "");
  ok(/K:/.test(abcText), `…seeded with the tune's source (${JSON.stringify(abcText.slice(0, 24))})`);
  await page.evaluate(() => window.__powerrp_codeModal.cancel());
  await settle(250);

  ok(liveErrors.length === 0, `no page errors (${liveErrors.slice(0, 3).join(" | ")})`);
} catch (e) {
  // A THROW MUST NOT SWALLOW THE CHECKS ALREADY MADE (tests/note_latch_probe.js's
  // rule): report what passed, then the failure.
  errors.push(`THREW: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "  ok  " : "  FAIL"} ${label}`);
if (errors.length) {
  console.log(`\nFAILURES (${errors.length}):`);
  for (const e of errors) console.log(`  ${e}`);
}
console.log(`\npiano_roll_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
process.exit(errors.length ? 1 : 0);
