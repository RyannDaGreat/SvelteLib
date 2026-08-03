/**
 * THE LINGER ROW + the generic NULLABLE-NUMBER affordance, in the real DOM.
 *
 * Two things bare node cannot prove, both about the seam between a declaration
 * and what the user actually gets:
 *
 *   1. THE AFFORDANCE RENDERS AND ROUND-TRIPS. `nullable: true` on a
 *      kind:"number" row is supposed to give the value cell a dim "(none)" plus
 *      a Set button when unset, and the scrubber plus a Clear × when set. Only a
 *      mounted Inspector can say whether the branch is reached at all — a row
 *      aspect nothing reads is invisible in a unit test and invisible on screen.
 *   2. THE WRITE LANDS ON THE SLIDE. `slideField: true` routes autoAdvance to
 *      slide.autoAdvance and leaves slide.transition untouched. The routing is
 *      in web/app.svelte.js, which is Svelte-runes and not bare-node importable,
 *      so the pin has to run here.
 *
 * DELIBERATELY NO SCREENSHOTS: the assertions are all structural, and this
 * host's Chrome has a capture path that can hang forever (see the app's
 * CLAUDE.md preflight note). A probe that needs no pixels should not risk them.
 *
 *   node src/demo_apps/PowerRP/tests/linger_nullable_probe.js
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
const fail = (m) => { throw new Error(m); };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  // WHAT THIS PROBE DELIBERATELY DOES NOT OWN. Each of these is a real message
  // that is nonetheless not evidence about a transition row, and naming them
  // individually is how the gate stays a gate rather than becoming a blanket:
  //   - the zero-sized-canvas paint race + SwiftShader's absent WebGPU adapter,
  //     the two standing headless artifacts every editor probe ignores;
  //   - a resource 500, which under the gate runner means the project backend is
  //     up but here (run standalone, no BACKEND_URL) means the asset list has
  //     nothing to talk to — an absent dependency, not a broken app;
  // NOT LISTED, DELIBERATELY: `PowerRP repair:`. This probe carried that
  // exclusion for a few hours, as a workaround for the night `gaussianBlur`
  // joined the universal effects bundle and made the fixture deck print one
  // repair line PER ITEM on every boot. The reasoning was that the repair was
  // "the design working" — but it was not: the blur shipped absent-is-legacy
  // semantics (identity 0, byte-identical render), so announcing it contradicted
  // its own design. core/document.js now fills a version-skew key QUIETLY and
  // stays loud only for a DELETED one, so the noise is gone at the source and
  // this line has nothing left to suppress. Restoring it would be strictly
  // worse than the flood it was written for: a permanent blanket over the one
  // channel that reports a document losing an authored value.
  const ignore = (t) =>
    /zero-sized canvas/.test(t) ||
    /VideoV7: WebGPU init failed/.test(t) ||
    /Failed to load resource/.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && !ignore(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));

  // Select the transition INTO slide 1 so the boundary panel mounts its rows.
  await page.evaluate(() => window.__powerrp_app.selectTransition(window.__powerrp_app.doc.slides[1].id));
  await new Promise((r) => setTimeout(r, 150));

  /** Query. The Linger row's rendered value cell, by its aria-labels — the same
   *  names a screen reader (and a user) navigates by. */
  const readRow = () => page.evaluate(() => {
    const labels = [...document.querySelectorAll(".inspector .label")];
    const label = labels.find((el) => el.textContent.trim() === "Linger");
    if (!label) return { present: false };
    // `.label` sits inside `.row-label-chrome` (the help-button wrapper), so the
    // value cell is a SIBLING of that span, not a child of the label's parent.
    // Walk to the `.row` — the element that actually spans label AND value.
    const cell = label.closest(".row");
    return {
      present: true,
      none: cell.querySelector(".numfield-none")?.textContent.trim() ?? null,
      hasScrubber: !!cell.querySelector(".dn"),
      setBtn: !!cell.querySelector('button[aria-label="Set Linger"]'),
      clearBtn: !!cell.querySelector('button[aria-label="Clear Linger"]'),
    };
  });

  // ── 1. UNSET: the demo deck has never set a linger ──────────────────────────
  const unset = await readRow();
  if (!unset.present) fail('no "Linger" row in the transition panel — the slideField row did not render');
  if (unset.none !== "(none)") fail(`unset Linger shows ${JSON.stringify(unset.none)}, expected "(none)"`);
  if (unset.hasScrubber) fail("unset Linger rendered a scrubber — a 0 that is not a 0 is exactly the confusion the aspect exists to prevent");
  if (!unset.setBtn) fail("unset Linger has no Set button — the value would be unreachable");

  // ── 2. SET: click Set, then confirm scrubber + Clear, and WHERE it landed ───
  await page.evaluate(() => {
    const label = [...document.querySelectorAll(".inspector .label")].find((el) => el.textContent.trim() === "Linger");
    label.closest(".row").querySelector('button[aria-label="Set Linger"]').click();
  });
  await new Promise((r) => setTimeout(r, 150));
  const set = await readRow();
  if (!set.hasScrubber) fail("after Set, the Linger row shows no scrubber");
  if (set.none !== null) fail("after Set, the Linger row still shows (none)");
  if (!set.clearBtn) fail("a set nullable row has no Clear button — it could never be taken back");

  // THE ROUTING PIN. The write must land on the SLIDE, and the transition
  // record must be byte-identical to what it was.
  const routed = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const slide = app.doc.slides[1];
    app.setSelectedTransitionsProp("autoAdvance", 2.5);
    const after = app.doc.slides[1];
    return {
      onSlide: after.autoAdvance,
      inRecord: "autoAdvance" in (after.transition ?? {}),
      transitionUnchanged: JSON.stringify(after.transition) === JSON.stringify(slide.transition),
      folded: app.transitionAt(after.id).autoAdvance,
    };
  });
  if (routed.onSlide !== 2.5) fail(`autoAdvance landed as ${routed.onSlide} on the slide, expected 2.5`);
  if (routed.inRecord) fail("autoAdvance leaked INTO slide.transition — the serialized transition shape must not change");
  if (!routed.transitionUnchanged) fail("writing the Linger mutated the transition record");
  if (routed.folded !== 2.5) fail(`transitionAt did not fold the slide field back for display (got ${routed.folded})`);

  // ── 3. CLEAR: the × writes literal null, NOT 0 ──────────────────────────────
  await page.evaluate(() => {
    const label = [...document.querySelectorAll(".inspector .label")].find((el) => el.textContent.trim() === "Linger");
    label.closest(".row").querySelector('button[aria-label="Clear Linger"]').click();
  });
  await new Promise((r) => setTimeout(r, 150));
  const cleared = await page.evaluate(() => ({
    stored: window.__powerrp_app.doc.slides[1].autoAdvance,
    isNull: window.__powerrp_app.doc.slides[1].autoAdvance === null,
  }));
  if (!cleared.isNull) fail(`Clear stored ${JSON.stringify(cleared.stored)} — it MUST be literal null; 0 means "advance immediately", which is the opposite instruction`);
  const back = await readRow();
  if (back.none !== "(none)") fail("after Clear, the row did not return to the unset display");

  // ── 4. BATCH: two selected transitions, ONE undo unit ───────────────────────
  const batch = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const ids = app.doc.slides.slice(1, 3).map((s) => s.id);
    app.selectTransition(ids[0]);
    app.selectTransitionAt(ids[1], { toggle: true }); // the shift-click gesture
    const selected = app.selectedTransitionIds().length;
    app.setSelectedTransitionsProp("autoAdvance", 4);
    const after = ids.map((id) => app.doc.slides.find((s) => s.id === id).autoAdvance);
    app.undo();
    const undone = ids.map((id) => app.doc.slides.find((s) => s.id === id).autoAdvance);
    return { selected, after, undone };
  });
  if (batch.selected !== 2) fail(`expected 2 selected transitions, got ${batch.selected}`);
  if (batch.after.some((v) => v !== 4)) fail(`the batch write did not reach every selected slide: ${JSON.stringify(batch.after)}`);
  if (batch.undone.some((v) => v === 4)) fail(`ONE undo did not take back the whole batch: ${JSON.stringify(batch.undone)} — N commits, not one`);

  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
  console.log("LINGER PROBE OK: nullable number renders (none)+Set unset, scrubber+Clear set;");
  console.log("  Clear writes literal null (not 0); the write lands on slide.autoAdvance with the");
  console.log(`  transition record untouched; a 2-transition batch is ONE undo unit. Zero console errors.`);
} finally {
  await browser.close();
  await server.close();
}
