/**
 * SLIDE STRIP probe — the rail's three new gestures, end to end in a real
 * browser: the transition slice's INSERT ends, DRAG-TO-REORDER, and the
 * multi-select + slide clipboard commands.
 *
 *   node src/demo_apps/PowerRP/tests/slide_strip_probe.js
 *
 * WHY A PROBE AND NOT ANOTHER NODE TEST. The core math is already pinned in
 * bare node (tests/slide_reorder_test.js proves the appearance law for every
 * permutation, for paste and for the block move). What node cannot see is the
 * WIRING: that the `+` ends exist in the markup and reach
 * insertSlideAtBoundary, that a pointer drag on a row produces a boundary and
 * commits through moveSlidesToBoundary, and that the rail's click rule builds
 * the selection the clipboard commands then read. Those are the seams a
 * refactor silently breaks — and a MISSING NAMED IMPORT IS SILENT IN THIS BUILD
 * (CLAUDE.md, measured), so a green build proves nothing about them.
 *
 * NO SCREENSHOTS, deliberately. 64 of the browser probes call page.screenshot,
 * and on a host whose capture path hangs each one burns its full protocol
 * timeout and dies with a stack that reads like an app regression (CLAUDE.md's
 * browser_capture_preflight note). Everything here is assertable from
 * page.evaluate, so this probe has no reason to take that risk.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const demoJson = await readFile(resolve(webRoot, "../examples/demo.powerrp.json"), "utf8");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const errors = [];
/** Command (throws). The probe's one assertion helper. */
function check(ok, message) {
  if (!ok) throw new Error(message);
}
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  // The boot-noise exclusions every rail/nav probe carries: a headless
  // layout-timing paint race in CanvasView, SwiftShader having no WebGPU adapter
  // for the VideoV7 overlay, and the project-API 500/ECONNREFUSED a probe sees
  // whenever no BACKEND_URL is pointed at a running project server (the gate
  // supplies one; run by hand it does not — CLAUDE.md's note that ~9 of the first
  // sweep's 12 failures were exactly this absent dependency). None of the three
  // is on the slide rail's path; the boot_probe.js IGNORE list is the precedent.
  const ignore = (t) => /zero-sized canvas|VideoV7: WebGPU init failed|Failed to load resource|\/api\/|listAssets|500 \(Internal Server Error\)|ECONNREFUSED/i.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && !ignore(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".slidenav [data-slide-row]");

  // ── 1. THE SLICE HAS THREE ZONES, and the two ends insert ──────────────────
  const zones = await page.evaluate(() => {
    const slice = document.querySelector(".transition-slice");
    return {
      ends: slice.querySelectorAll(".tr-end").length,
      chips: slice.querySelectorAll(".tr-chip").length,
      // Idle the band is a flat line: every affordance in it is transparent.
      idleEndOpacity: getComputedStyle(slice.querySelector(".tr-end")).opacity,
      idleChipOpacity: getComputedStyle(slice.querySelector(".tr-chip")).opacity,
    };
  });
  check(zones.ends === 2, `expected 2 insert ends on a transition slice, got ${zones.ends}`);
  check(zones.chips === 1, `expected 1 transition chip on a slice, got ${zones.chips}`);
  check(zones.idleEndOpacity === "0", `an IDLE slice must show no + affordance (opacity ${zones.idleEndOpacity})`);
  check(zones.idleChipOpacity === "0", `an IDLE slice must show no chip (opacity ${zones.idleChipOpacity})`);

  // Hovering the band lights it — the whole band at once, not one zone.
  await page.hover(".transition-slice .tr-end");
  const hot = await page.evaluate(() => {
    const slice = document.querySelector(".transition-slice");
    return {
      end: getComputedStyle(slice.querySelector(".tr-end")).opacity,
      chip: getComputedStyle(slice.querySelector(".tr-chip")).opacity,
    };
  });
  check(hot.end === "1" && hot.chip === "1", `hovering a slice must reveal BOTH the ends and the chip (end ${hot.end}, chip ${hot.chip})`);

  // The left end inserts a slide at that boundary — one slide more, and it
  // becomes current (the deck's picture at every OTHER index is untouched, which
  // is what slide_reorder_test proves; here we prove the button is wired).
  const inserted = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const before = app.doc.slides.length;
    document.querySelectorAll(".transition-slice .tr-end")[0].click();
    return { before, after: app.doc.slides.length, current: app.slideIndex };
  });
  check(inserted.after === inserted.before + 1, `the slice's + end did not insert a slide (${inserted.before} → ${inserted.after})`);
  check(inserted.current === 1, `the inserted slide should be current; slideIndex is ${inserted.current}`);
  await page.evaluate(() => window.__powerrp_app.undo());

  // ── 2. MULTI-SELECT, and the clipboard commands that read it ───────────────
  const multi = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selectSlideAt(0);
    app.selectSlideAt(1, { shift: true }); // range
    const range = app.selectedSlideIndices();
    app.selectSlideAt(0, { toggle: true }); // drop one back out
    const toggled = app.selectedSlideIndices();
    return { range, toggled, rowsSelected: document.querySelectorAll(".slidenav .slide.selected").length };
  });
  check(multi.range.length === 2, `shift-click should select a RANGE of 2, got ${JSON.stringify(multi.range)}`);
  check(multi.toggled.length === 1, `cmd-click should toggle one out, leaving 1; got ${JSON.stringify(multi.toggled)}`);
  check(multi.rowsSelected >= 1, "no rail row rendered as .selected after a multi-select");

  const clipboard = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selectSlideAt(0);
    app.selectSlideAt(1, { shift: true });
    const before = app.doc.slides.length;
    app.runCommand("copy-slides");
    const copied = app.slideClipboardCount();
    app.runCommand("paste-slides");
    return { before, copied, after: app.doc.slides.length, pastedSelection: app.selectedSlideIndices().length };
  });
  check(clipboard.copied === 2, `copy-slides should hold 2 slides, holds ${clipboard.copied}`);
  check(clipboard.after === clipboard.before + 2, `paste-slides should add 2 slides (${clipboard.before} → ${clipboard.after})`);
  check(clipboard.pastedSelection === 2, `the pasted block should become the selection (got ${clipboard.pastedSelection})`);
  await page.evaluate(() => window.__powerrp_app.undo());

  // ── 3. DRAG-TO-REORDER, through real pointer events ────────────────────────
  // Drag row 0 past the middle of row 1: it must land at boundary 2 and the deck
  // must come back in the swapped order, in ONE undo unit.
  const drag = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    app.selectSlideAt(0);
    const rows = [...document.querySelectorAll(".slidenav [data-slide-row]")];
    const idsBefore = app.doc.slides.map((s) => s.id);
    const a = rows[0].getBoundingClientRect();
    const b = rows[1].getBoundingClientRect();
    const opts = { bubbles: true, pointerId: 1, button: 0, isPrimary: true, pointerType: "mouse" };
    // setPointerCapture on a synthetic pointerId throws in Chrome unless the id
    // is live, so stub it for the gesture — the capture is a convenience (it
    // keeps a release outside the rail working), never part of the math.
    rows[0].setPointerCapture = () => {};
    rows[0].dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientX: a.left + 10, clientY: a.top + a.height / 2 }));
    rows[0].dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: a.left + 10, clientY: b.bottom - 2 }));
    // Svelte flushes DOM updates asynchronously, so the drag CLASSES are not on
    // the elements yet in this same tick — wait one frame before reading them.
    // (The reorder itself is synchronous state, hence no wait around the drop.)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const railDragging = document.querySelector(".slidenav").classList.contains("dragging");
    const dropShown = document.querySelectorAll(".slidenav .drop, .slidenav .transition-slice.drop").length;
    rows[0].dispatchEvent(new PointerEvent("pointerup", { ...opts, clientX: a.left + 10, clientY: b.bottom - 2 }));
    const idsAfter = app.doc.slides.map((s) => s.id);
    app.undo();
    return { idsBefore, idsAfter, railDragging, dropShown, idsUndone: app.doc.slides.map((s) => s.id) };
  });
  check(drag.railDragging, "the rail did not enter its .dragging state during a row drag");
  check(drag.dropShown >= 1, "no drop indicator was drawn at the boundary under the cursor");
  check(drag.idsAfter[0] === drag.idsBefore[1] && drag.idsAfter[1] === drag.idsBefore[0],
    `the drop did not reorder: ${drag.idsBefore.slice(0, 2)} → ${drag.idsAfter.slice(0, 2)}`);
  check(drag.idsUndone.join() === drag.idsBefore.join(), "a drop is not ONE undo unit — one undo did not restore the order");

  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
  console.log("SLIDE STRIP PROBE OK: slice has 2 insert ends + 1 chip and is flat when idle; a + end inserts; shift/cmd build the rail selection; copy+paste round-trips 2 slides; a pointer drag reorders in one undo unit. Zero console errors.");
} finally {
  await browser.close();
  await server.close();
}
