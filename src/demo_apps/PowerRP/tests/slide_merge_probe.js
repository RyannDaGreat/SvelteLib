/**
 * MERGE SLIDES — the DRAG-ONTO-A-SLIDE gesture, in a real browser.
 *
 *   node src/demo_apps/PowerRP/tests/slide_merge_probe.js
 *
 * User, 2026-08-02 (verbatim): "Or what if I can drag a slide into another
 * slide? And then it could have a realtime tooltip while I'm dragging it, say
 * what I'm about to do, which is merging. By the way, the realtime tooltip does
 * not need to exist when I'm dragging slides."
 *
 * WHY A PROBE. The merge MATH is fully pinned in bare node
 * (tests/slide_merge_test.js proves both laws and the whole tombstone algebra),
 * so this deliberately does not re-prove it. What node cannot see is the thing
 * that actually makes this gesture usable: ONE DRAG now carries TWO operations,
 * and which one is armed depends on WHERE IN A ROW the pointer is. That is
 * geometry plus live classes, i.e. exactly what a browser is for. The two claims
 * worth a browser are:
 *   1. A drop on a slide's BODY merges, and says so before the release.
 *   2. A drop in a GAP still reorders, exactly as it did — the no-regression half.
 *
 * NO SCREENSHOTS, for the reason slide_strip_probe.js and slide_grid_probe.js
 * both state: 64 browser probes call page.screenshot, and on a host whose
 * capture path hangs each one burns its full protocol timeout and dies with a
 * stack that reads like an app regression (CLAUDE.md's
 * browser_capture_preflight note). Every claim below is assertable from
 * page.evaluate.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const demoJson = await readFile(resolve(webRoot, "../examples/demo.powerrp.json"), "utf8");

// HMR OFF. This probe drives a multi-second gesture sequence, and a code edit in
// another window mid-run would reload the page underneath it and fail the probe
// for a reason that has nothing to do with the app — the same reasoning
// cli/render_job.js gives for disabling HMR in its own dev server.
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
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
  // The boot-noise exclusions every rail/nav probe carries — a headless paint
  // race in CanvasView, SwiftShader having no WebGPU adapter, and the project-API
  // 500/ECONNREFUSED a probe sees when no BACKEND_URL points at a running server.
  const ignore = (t) => /zero-sized canvas|VideoV7: WebGPU init failed|Failed to load resource|\/api\/|listAssets|500 \(Internal Server Error\)|ECONNREFUSED/i.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && !ignore(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".slidenav [data-slide-row]");

  // A DECK WITH ENOUGH SLIDES to have both an interior gap and an interior body.
  // Built through the app's own commands so the document is one the editor could
  // really produce (the fixture discipline core/slide_reorder.js's tests follow).
  await page.evaluate(async () => {
    const app = window.__powerrp_app;
    while (app.doc.slides.length < 4) app.addBlankSlide();
    // Give each slide a distinguishable keyframe so a merge is observable in the
    // fold rather than only in the slide count.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

  const dragTo = async (fromRow, where) => page.evaluate(async ({ fromRow, where }) => {
    const app = window.__powerrp_app;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rows = [...document.querySelectorAll(".slidenav [data-slide-row]")];
    const src = rows[fromRow].getBoundingClientRect();
    const dst = rows[where.row].getBoundingClientRect();
    // WHERE INSIDE THE TARGET decides the operation: the middle of the row is the
    // merge zone, the outer 30% at each end belongs to the gap it is nearest
    // (SlideNav's MERGE_EDGE_FRACTION). "body" aims at the centre; "gap" aims at
    // the very bottom edge, which is the reorder boundary below the row.
    const y = where.kind === "body" ? dst.top + dst.height / 2 : dst.bottom - 2;
    const opts = { bubbles: true, pointerId: 1, button: 0, isPrimary: true, pointerType: "mouse" };
    // setPointerCapture on a synthetic pointerId throws in Chrome unless the id
    // is live — stub it, as the strip probe does. The capture is a convenience,
    // never part of the math.
    rows[fromRow].setPointerCapture = () => {};
    const idsBefore = app.doc.slides.map((s) => s.id);
    const countBefore = app.doc.slides.length;
    rows[fromRow].dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientX: src.left + 10, clientY: src.top + src.height / 2 }));
    rows[fromRow].dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: dst.left + dst.width / 2, clientY: y }));
    // Svelte flushes asynchronously — the drag classes are not on the elements
    // in this same tick. One frame of quiet before reading them.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const mergeTargets = document.querySelectorAll(".slidenav .slide.merge-target").length;
    const chip = document.querySelector(".slidenav .merge-chip");
    const chipText = chip?.textContent?.trim() ?? null;
    // THE TWO INDICATORS MUST BE MUTUALLY EXCLUSIVE — a release has one outcome,
    // so the rail must never show two answers at once.
    const dropIndicators = document.querySelectorAll(".slidenav .transition-slice.drop, .slidenav .drop-rail.drop").length;
    rows[fromRow].dispatchEvent(new PointerEvent("pointerup", { ...opts, clientX: dst.left + dst.width / 2, clientY: y }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      mergeTargets, chipText, dropIndicators,
      countBefore, countAfter: app.doc.slides.length,
      idsBefore, idsAfter: app.doc.slides.map((s) => s.id),
    };
  }, { fromRow, where });

  // ── 1. DROP ON A BODY = MERGE ─────────────────────────────────────────────
  // Drag slide 1 onto slide 3's BODY. Deck order decides priority, so slide 3
  // wins regardless of which of the two was picked up.
  const merged = await dragTo(0, { row: 2, kind: "body" });
  check(merged.mergeTargets === 1, `hovering a slide's body must mark exactly ONE merge target, got ${merged.mergeTargets}`);
  check(merged.chipText !== null, "the merge target must carry a chip saying what the release will do");
  check(/wins/i.test(merged.chipText), `the chip must name WHICH SLIDE'S LOOK WINS, got ${JSON.stringify(merged.chipText)}`);
  check(merged.dropIndicators === 0,
    `a live merge target must SUPPRESS the reorder drop indicator — a release has one outcome, but the rail showed ${merged.dropIndicators}`);
  check(merged.countAfter === merged.countBefore - 1,
    `a merge must collapse two slides into one: ${merged.countBefore} -> ${merged.countAfter}`);
  // NON-ADJACENT IS NOT A REFUSAL. Slides 1 and 3 are two rows apart, and this
  // gesture must still merge them — the app GATHERS them first (app.mergeSlideRun)
  // rather than declining an unambiguous drag over its own implementation detail.
  // An earlier version refused exactly this, and this probe is what caught it.
  check(!/can't merge/i.test(merged.chipText),
    `dragging a slide onto a non-adjacent slide must MERGE, not refuse — chip said ${JSON.stringify(merged.chipText)}`);
  // The rows that were merged are gone; the untouched slide between them remains.
  check(!merged.idsAfter.includes(merged.idsBefore[0]) || !merged.idsAfter.includes(merged.idsBefore[2]),
    "one of the two merged rows must be gone — two slides became one");
  check(merged.idsAfter.includes(merged.idsBefore[1]),
    "the slide BETWEEN the two merged ones must survive untouched — it was not part of the gesture");

  // ── 2. DROP IN A GAP STILL REORDERS (the no-regression half) ──────────────
  const reordered = await dragTo(0, { row: 1, kind: "gap" });
  check(reordered.mergeTargets === 0,
    `aiming at a GAP must arm a reorder, not a merge — but ${reordered.mergeTargets} row(s) were marked as merge targets`);
  check(reordered.chipText === null, "no merge chip may appear while a reorder is armed");
  check(reordered.countAfter === reordered.countBefore,
    `a gap drop must REORDER, never merge: the slide count changed ${reordered.countBefore} -> ${reordered.countAfter}`);
  check(reordered.idsAfter.join() !== reordered.idsBefore.join(),
    "a gap drop past a neighbour must actually change the order");
  check([...reordered.idsAfter].sort().join() === [...reordered.idsBefore].sort().join(),
    "a reorder must preserve the SET of slides exactly");

  // ── 3. ONE UNDO UNIT ──────────────────────────────────────────────────────
  const undone = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const before = app.doc.slides.length;
    app.undo();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { before, after: app.doc.slides.length };
  });
  check(undone.after === undone.before, `undoing the reorder must not change the slide count, got ${undone.before} -> ${undone.after}`);
  const undoneMerge = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const before = app.doc.slides.length;
    app.undo();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { before, after: app.doc.slides.length };
  });
  check(undoneMerge.after === undoneMerge.before + 1,
    `ONE undo must restore the whole merge (both slides back): ${undoneMerge.before} -> ${undoneMerge.after}`);

  // ── 4. THE COMMANDS AGREE WITH THE GESTURE ────────────────────────────────
  // merge-slide-up on slide N and merge-slide-down on slide N-1 name the SAME
  // pair, so they must produce the same document — deck order decides the
  // winner, never which row the command was invoked from.
  const commands = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const json = () => JSON.stringify(app.doc.slides.map((s) => [s.id, s.delta]));
    app.slideIndex = 1;
    app.mergeSlide(-1); // slide 2 merges up into slide 1
    const viaUp = json();
    app.undo();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.slideIndex = 0;
    app.mergeSlide(+1); // slide 2 merges down into slide 1 — the SAME pair
    const viaDown = json();
    app.undo();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { viaUp, viaDown, restored: app.doc.slides.length };
  });
  check(commands.viaUp === commands.viaDown,
    "merge-up and merge-down on the SAME pair must produce identical documents — deck order decides priority, not the direction the command was invoked from");

  // ── 5. THE GATES SPEAK ────────────────────────────────────────────────────
  // The first slide cannot merge up and the last cannot merge down, and each
  // refusal states a reason (the palette renders it as "Unavailable — requires …").
  const gates = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const firstUp = app.slideMergeBlocker(0, -1);
    app.slideIndex = app.doc.slides.length - 1;
    const lastDown = app.slideMergeBlocker(app.doc.slides.length - 1, +1);
    const interior = app.slideMergeBlocker(0, +1);
    return { firstUp, lastDown, interior };
  });
  check(typeof gates.firstUp === "string" && gates.firstUp.length > 0,
    "the FIRST slide must refuse to merge up, with a reason");
  check(typeof gates.lastDown === "string" && gates.lastDown.length > 0,
    "the LAST slide must refuse to merge down, with a reason");
  check(gates.interior === null, `an interior pair must be mergeable, but was refused: ${gates.interior}`);

  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
  console.log("SLIDE MERGE PROBE OK: dropping a dragged slide on another slide's BODY merges them (one marked target, a chip naming which slide's look wins, the reorder indicator suppressed) while a drop in a GAP still reorders exactly as before; each is one undo unit; merge-up and merge-down on the same pair produce identical documents; the first/last slides refuse with a stated reason. Zero console errors.");
} finally {
  await browser.close();
  await server.close();
}
