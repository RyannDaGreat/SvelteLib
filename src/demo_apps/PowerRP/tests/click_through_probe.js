/**
 * CLICK-THROUGH CYCLING + THE ITEM PICKER'S SELECTION PREVIEW (user, 2026-08-01).
 *
 * Two features, one probe, because both answer the same question — "which object
 * do you mean" — from the two ends the user named:
 *   · the CANVAS end: a repeated slow click at one point walks DOWN the stack, so
 *     an object buried under others is reachable by pointer at all;
 *   · the MENU end: hovering a row in the Inspector's item picker outlines that
 *     object on canvas, because the list is names and a name is not a location.
 *
 * DRIVEN WITH REAL page.mouse CLICKS, not synthetic events: CanvasView's handlers
 * call setPointerCapture and a dispatched event never reaches them (editor_smoke's
 * standing note). That matters more than usual here, because the whole mechanism
 * turns on `e.detail` — the browser's own multi-click counter — which only a real
 * input sequence produces.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
/** Slower than any OS double-click interval, so the browser reports detail === 1
 *  and the click reads as a fresh one rather than half of a pair. */
const SLOW_CLICK_MS = 700;

const checks = [];
const ok = (pass, label) => { checks.push([pass, label]); };

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));

  // THREE RECTS EXACTLY ON TOP OF ONE ANOTHER. Same box, so every hit-test at the
  // centre hits all three and the only thing separating them is z — which is
  // precisely the situation the user cannot otherwise click into.
  const ids = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const made = [];
    for (const fill of ["#ff0000", "#00ff00", "#0000ff"]) {
      app.addItem(app.registry.get("rect").defaults);
      const id = app.selection;
      app.setPreview([
        [["items", id, "x"], 400], [["items", id, "y"], 300],
        [["items", id, "w"], 200], [["items", id, "h"], 200],
        [["items", id, "fill"], fill],
      ]);
      app.commitPreview();
      made.push(id);
    }
    app.selection = null;
    return made;                                  // z-ascending: [bottom, mid, top]
  });
  ok(ids.length === 3, "setup: three stacked rects");

  const centre = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(500, 400);   // the shared box's centre
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  });
  const sel = () => page.evaluate(() => window.__powerrp_app.selection);
  const slowClick = async () => {
    await page.mouse.click(centre.x, centre.y);
    await new Promise((r) => setTimeout(r, SLOW_CLICK_MS));
  };

  // ── 1. THE CYCLE WALKS DOWN, THEN WRAPS ─────────────────────────────────────
  await slowClick();
  const first = await sel();
  ok(first === ids[2], `click 1 selects the TOPMOST (got ${first === ids[2] ? "top" : first})`);
  await slowClick();
  const second = await sel();
  ok(second === ids[1], `click 2 at the same point selects the one UNDERNEATH — the whole point (got ${second === ids[1] ? "mid" : second})`);
  await slowClick();
  const third = await sel();
  ok(third === ids[0], `click 3 reaches the BOTTOM of the stack (got ${third === ids[0] ? "bottom" : third})`);
  await slowClick();
  ok((await sel()) === ids[2], "click 4 WRAPS back to the top rather than sticking at the bottom");

  // ── 2. MOVING THE MOUSE RESETS IT ───────────────────────────────────────────
  // The user's own reset condition — "if I don't move the mouse" — so a click
  // somewhere else and back must start from the top again, not resume mid-stack.
  await slowClick();                                    // now on the middle one
  ok((await sel()) === ids[1], "…and the cycle continues from where it was");
  await page.mouse.click(centre.x + 300, centre.y + 200); // empty canvas, far away
  await new Promise((r) => setTimeout(r, SLOW_CLICK_MS));
  await slowClick();
  ok((await sel()) === ids[2], "after moving away and back, the cycle RESTARTS at the top");

  // ── 3. A FAST DOUBLE-CLICK DOES NOT CYCLE ───────────────────────────────────
  // It must leave the selection on the object the user aimed at, so the dblclick
  // that follows edits THAT one rather than whatever the cycle wandered to. This
  // is the assertion that `e.detail` is really doing the work: with a hand-rolled
  // timer instead, the second click of a fast pair would still advance.
  await page.mouse.click(centre.x + 300, centre.y + 200); // reset the cycle
  await new Promise((r) => setTimeout(r, SLOW_CLICK_MS));
  await page.mouse.click(centre.x, centre.y, { clickCount: 2, delay: 20 });
  await new Promise((r) => setTimeout(r, 200));
  const afterDouble = await sel();
  ok(afterDouble === ids[2], `a FAST double-click stays on the top item, no cycling (got ${afterDouble === ids[2] ? "top" : afterDouble})`);

  // ── 4. THE ITEM PICKER'S HOVER PREVIEW ──────────────────────────────────────
  // Asserted through the DOM the canvas actually draws, not through the field: a
  // computed preview that never reaches the markup is a defect this repo has
  // shipped before (R6-28's greyed affordance with no CSS rule behind it).
  const previewCount = async () => page.evaluate(() => document.querySelectorAll(".overlay .selection-preview").length);
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await new Promise((r) => setTimeout(r, 120));
  ok((await previewCount()) === 0, "nothing hovered → no preview outline (it is not ambient)");

  await page.evaluate((id) => { window.__powerrp_app.hoverItemId = id; }, ids[0]);
  await new Promise((r) => setTimeout(r, 200));
  ok((await previewCount()) === 1, "hovering an item outlines it on the canvas");

  const styled = await page.evaluate(() => {
    const el = document.querySelector(".overlay .selection-preview");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, stroke: cs.stroke, dash: cs.strokeDasharray };
  });
  ok(styled !== null && Number(styled.opacity) > 0 && Number(styled.opacity) < 1,
    `the preview is drawn at a partial opacity, so it reads as provisional (got ${styled?.opacity})`);
  ok(styled !== null && (styled.dash === "none" || styled.dash === ""),
    `the preview is UNDASHED, which is what distinguishes it from the committed selection (got ${JSON.stringify(styled?.dash)})`);

  await page.evaluate(() => { window.__powerrp_app.hoverItemId = null; });
  await new Promise((r) => setTimeout(r, 150));
  ok((await previewCount()) === 0, "clearing the hover removes the outline");

  // AN ALREADY-SELECTED ITEM PREVIEWS NOTHING — a second coincident polygon over
  // the real selection outline would just read as a rendering fault.
  await page.evaluate((id) => { const a = window.__powerrp_app; a.selection = id; a.hoverItemId = id; }, ids[0]);
  await new Promise((r) => setTimeout(r, 200));
  ok((await previewCount()) === 0, "hovering the item that is ALREADY selected draws no second outline");

  console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
  const failed = checks.filter(([p]) => !p);
  if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exit(1); }
  console.log(`\n${checks.length} click-through / selection-preview checks passed`);
} finally {
  await browser.close();
  await server.close();
}
