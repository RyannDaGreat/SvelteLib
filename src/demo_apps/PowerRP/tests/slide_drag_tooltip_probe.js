/**
 * SLIDE DRAG TOOLTIP probe — the hover tooltip must be gone for the DURATION of
 * a slide reorder drag, in BOTH the list and grid layouts.
 *
 *   node src/demo_apps/PowerRP/tests/slide_drag_tooltip_probe.js
 *
 * User, verbatim (2026-08-03): "When I'm dragging slides, the hovering tooltip
 * should not be visible, but it is right now, in grid mode. It's also visible
 * in list view, but it shouldn't be visible either when I'm dragging the
 * slides, because it blocks my view of the slides." Ruling: during a slide
 * drag (reorder gesture), the slide hover tooltip is SUPPRESSED — both grid
 * mode and list view; it returns when the drag ends. The fix keys off the DRAG
 * STATE (one source of truth the gesture already owns), not off pointer
 * heuristics.
 *
 * WHY REAL page.mouse EVENTS, NOT dispatchEvent(new PointerEvent(...)). This
 * probe went through a synthetic-dispatch version first and it was a FALSE
 * NEGATIVE — measured, not assumed. A synthetic (untrusted) pointerdown
 * dispatched straight at the row closed the row's own Tooltip immediately
 * (Tooltip.svelte's own "a click dismisses" pointerdown handler), so a probe
 * built that way reports zero tooltips mid-drag whether or not the
 * drag-suppression fix exists — it was measuring the click-dismiss path, not
 * the drag-suppression path, and passed identically with the fix reverted.
 * page.mouse (real, trusted, CDP-driven input) does not collapse the same way:
 * with the fix reverted, `page.mouse.down()` leaves the tip open and the
 * FOLLOWING mousemove keeps it open and tracking the cursor — which is
 * exactly the user's report — and only WITH the fix does that same sequence
 * close it. Measured both ways before writing the assertions below.
 *
 * WHAT THIS PINS, precisely:
 *   1. A tip already open BEFORE the drag starts (a plain hover) must CLOSE
 *      once the gesture crosses the drag threshold and becomes a real drag —
 *      not merely refuse to reopen. This is the reported bug exactly: hover
 *      reveals the tip immediately (Tooltip's default delay is 0), and it kept
 *      tracking the cursor for the rest of the gesture.
 *   2. No tooltip may reveal while the pointer passes OVER OTHER rows/pills
 *      during the drag (pointer capture on the dragged row already starves
 *      other rows of hover events, so this doubles as a capture regression
 *      guard).
 *   3. The tip works again after the drop — suppression is for the gesture's
 *      duration only.
 *   4. The drag's OWN affordances — the merge chip and the bold drop-boundary
 *      line — are NOT tooltips and must be UNAFFECTED (they still render
 *      during the very same drag that suppresses tooltips).
 *   5. Both LIST and GRID layouts.
 *
 * WHY A PROBE, not bare node. Tooltip visibility is a DOM/CSS fact (an element
 * mounted with role="tooltip", per src/lib/Tooltip.svelte) driven by real
 * pointer input — exactly what bare node cannot see. The reorder MATH itself
 * is already proven elsewhere (tests/slide_reorder_test.js); this probe does
 * not re-prove it.
 *
 * NO SCREENSHOTS, for the reason every sibling rail probe states
 * (CLAUDE.md's browser_capture_preflight note): every claim below is
 * assertable from page.evaluate.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const demoJson = await readFile(resolve(webRoot, "../examples/demo.powerrp.json"), "utf8");

// HMR OFF, same reasoning slide_merge_probe.js gives: this probe drives a
// multi-step gesture sequence with real waits, and a code edit in another
// window mid-run would reload the page underneath it and fail for a reason
// that has nothing to do with the app.
const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: { ignored: ["**/*"] } } });
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
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  // The boot-noise exclusions every rail/nav probe carries — a headless paint
  // race in CanvasView, SwiftShader having no WebGPU adapter, and the project-API
  // 500/ECONNREFUSED a probe sees when no BACKEND_URL points at a running server.
  const ignore = (t) => /zero-sized canvas|VideoV7: WebGPU init failed|Failed to load resource|\/api\/|listAssets|500 \(Internal Server Error\)|ECONNREFUSED/i.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && !ignore(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".slidenav [data-slide-row]");

  // A DECK WITH ENOUGH SLIDES for an interior gap and a real drag distance.
  await page.evaluate(async () => {
    const app = window.__powerrp_app;
    while (app.doc.slides.length < 4) app.addBlankSlide();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

  /**
   * Command. Hovers row 0 with a REAL mouse (opening its tip — Tooltip's
   * default delay is 0), presses down on it, drags past row 1's bottom edge (a
   * plain reorder — the x stays near the row's own left edge, so the pointer
   * never enters MERGE_EDGE_FRACTION's middle merge zone), sweeps over row 1,
   * then releases. Returns what was visible at each step.
   */
  async function runDrag() {
    const [src, dst] = await page.evaluate(() => {
      const toPlain = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
      const rows = [...document.querySelectorAll(".slidenav [data-slide-row]")];
      return [toPlain(rows[0].getBoundingClientRect()), toPlain(rows[1].getBoundingClientRect())];
    });

    await page.mouse.move(Math.round(src.left + 10), Math.round(src.top + src.height / 2));
    await new Promise((r) => setTimeout(r, 60));
    const openedBeforeDrag = await page.evaluate(() => document.querySelectorAll('[role="tooltip"]').length);

    await page.mouse.down();
    // PAST DRAG_THRESHOLD_PX and past row 1's bottom edge in one move — a
    // single big jump is fine; SlideNav's threshold check only cares about
    // total displacement from pointerdown, not step count.
    await page.mouse.move(Math.round(src.left + 10), Math.round(dst.bottom - 2));
    await new Promise((r) => setTimeout(r, 80));
    const midDrag = await page.evaluate(() => ({
      dragging: document.querySelector(".slidenav").classList.contains("dragging"),
      tooltips: document.querySelectorAll('[role="tooltip"]').length,
      dropIndicator: document.querySelectorAll(".slidenav .transition-slice.drop, .slidenav .drop-rail.drop, .slidenav .slide.seam-before, .slidenav .slide.seam-after").length,
    }));

    // STILL DRAGGING, sweep further — no tip may open for the row passed over.
    await page.mouse.move(Math.round(dst.left + 10), Math.round(dst.bottom - 2));
    await new Promise((r) => setTimeout(r, 80));
    const overOtherRow = { tooltips: await page.evaluate(() => document.querySelectorAll('[role="tooltip"]').length) };

    const idsBefore = await page.evaluate(() => window.__powerrp_app.doc.slides.map((s) => s.id));
    await page.mouse.up();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const idsAfter = await page.evaluate(() => window.__powerrp_app.doc.slides.map((s) => s.id));

    // THE TIP WORKS AGAIN AFTER THE DROP (not suppressed forever) — move away
    // first so the next hover is a genuine pointerenter, then hover row 0 again.
    await page.mouse.move(200, 5);
    await new Promise((r) => setTimeout(r, 40));
    const r0 = await page.evaluate(() => {
      const r = document.querySelectorAll(".slidenav [data-slide-row]")[0].getBoundingClientRect();
      return { left: r.left, top: r.top, height: r.height };
    });
    await page.mouse.move(Math.round(r0.left + 10), Math.round(r0.top + r0.height / 2));
    await new Promise((r) => setTimeout(r, 60));
    const afterDrop = { tooltips: await page.evaluate(() => document.querySelectorAll('[role="tooltip"]').length) };
    await page.mouse.move(200, 5); // clear the hover for the next call

    await page.evaluate(() => {
      window.__powerrp_app.undo();
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });

    return { openedBeforeDrag, midDrag, overOtherRow, afterDrop, idsBefore, idsAfter };
  }

  // ── LIST VIEW ──────────────────────────────────────────────────────────────
  const list = await runDrag();
  check(list.openedBeforeDrag >= 1, "the hover must actually open a tooltip before the drag starts — otherwise this probe proves nothing");
  check(list.midDrag.dragging, "LIST VIEW: SlideNav did not enter its .dragging state — the drag never actually started, so the suppression claim below is untested");
  check(list.midDrag.tooltips === 0,
    `LIST VIEW: a tooltip that was open before the drag must close the instant the gesture becomes a drag; ${list.midDrag.tooltips} still mounted`);
  check(list.midDrag.dropIndicator >= 1,
    "LIST VIEW: the drag's own drop indicator must still render while tooltips are suppressed — the fix must not touch it");
  check(list.overOtherRow.tooltips === 0,
    `LIST VIEW: no tooltip may appear for a row the drag passes OVER either; ${list.overOtherRow.tooltips} mounted`);
  check(list.idsAfter.join() !== list.idsBefore.join(), "LIST VIEW: the drag must have actually reordered — otherwise the drop-then-hover step below proves nothing about a settled rail");
  check(list.afterDrop.tooltips >= 1, "LIST VIEW: the tooltip must work again after the drop — suppression is for the gesture's duration only");

  // ── GRID VIEW ──────────────────────────────────────────────────────────────
  await page.evaluate(async () => {
    document.querySelector(".slidenav .nav-actions [data-nav-view]").click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const grid = await runDrag();
  check(grid.openedBeforeDrag >= 1, "GRID VIEW: the hover must actually open a tooltip (the spine pill's) before the drag starts");
  check(grid.midDrag.dragging, "GRID VIEW: SlideNav did not enter its .dragging state");
  check(grid.midDrag.tooltips === 0,
    `GRID VIEW: a tooltip open before the drag must close once the gesture becomes a drag; ${grid.midDrag.tooltips} still mounted`);
  check(grid.midDrag.dropIndicator >= 1,
    "GRID VIEW: the drag's own seam indicator must still render while tooltips are suppressed");
  check(grid.overOtherRow.tooltips === 0,
    `GRID VIEW: no tooltip may appear for a tile the drag passes OVER either; ${grid.overOtherRow.tooltips} mounted`);
  check(grid.afterDrop.tooltips >= 1, "GRID VIEW: the tooltip must work again after the drop");

  // ── THE MERGE CHIP IS UNAFFECTED (it is not a Tooltip and must keep showing
  // during the very drag that suppresses tooltips — the user's own prior ruling
  // on the merge gesture, "the realtime tooltip does not need to exist when I'm
  // dragging slides", is why it was built as an on-target chip in the first
  // place, not a casualty of this fix). ────────────────────────────────────────
  const merge = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll(".slidenav [data-slide-row]")];
    const src = rows[0].getBoundingClientRect();
    const dst = rows[2].getBoundingClientRect();
    return { src: { left: src.left, top: src.top, width: src.width, height: src.height }, dst: { left: dst.left, top: dst.top, width: dst.width, height: dst.height } };
  });
  await page.mouse.move(Math.round(merge.src.left + merge.src.width / 2), Math.round(merge.src.top + merge.src.height / 2));
  await page.mouse.down();
  // AIM AT THE MIDDLE of the target row/tile — the merge zone (MERGE_EDGE_FRACTION).
  await page.mouse.move(Math.round(merge.dst.left + merge.dst.width / 2), Math.round(merge.dst.top + merge.dst.height / 2));
  await new Promise((r) => setTimeout(r, 80));
  const mergeState = await page.evaluate(() => {
    const chip = document.querySelector(".slidenav .merge-chip");
    return { chipPresent: !!chip, chipText: chip?.textContent?.trim() ?? null, tooltips: document.querySelectorAll('[role="tooltip"]').length };
  });
  await page.mouse.up();
  await page.evaluate(() => {
    window.__powerrp_app.undo();
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  check(mergeState.chipPresent, "the merge chip must still render during a drag onto a slide's body — it is not a Tooltip and must be unaffected by the suppression fix");
  check(mergeState.tooltips === 0, `no Tooltip-component tip may appear during a merge drag either; ${mergeState.tooltips} mounted`);

  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
  console.log("SLIDE DRAG TOOLTIP PROBE OK: a hover tooltip open before a slide drag starts closes the instant the gesture becomes a drag, no tooltip opens for a row/tile passed over mid-drag, and the tip works again after the drop — true in BOTH list and grid view; the drag's own drop-indicator and merge-chip affordances (not Tooltips) render throughout, unaffected. Zero console errors.");
} finally {
  await browser.close();
  await server.close();
}
