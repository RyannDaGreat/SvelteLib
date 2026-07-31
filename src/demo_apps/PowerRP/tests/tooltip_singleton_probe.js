/**
 * ONE-TOOLTIP INVARIANT PROBE — at most one .tt-tip may exist, ever.
 *
 * The failing mechanism this pins (user screenshot, 2026-07-30: two stacked
 * tips in the asset picker): NESTED Tooltip anchors both receive pointerenter —
 * entering the inner anchor never leaves the outer — so both tips open and
 * overlap. The fix is a module-global slot in src/lib/Tooltip.svelte: revealing
 * any tip closes the incumbent.
 *
 * Reproduced here by the MECHANISM, not a bespoke DOM: pointerenter is
 * dispatched on a second anchor while the first is still hovered (no
 * pointerleave between), exactly what nesting produces. Also checks the normal
 * path still works: leave + enter shows the new tip.
 *
 * Spawns its OWN isolated Vite + headless Chromium, same pattern as
 * text_undo_probe.js. Run from POWERRP or the SvelteLib root.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" }, logLevel: "silent" });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(2500);

  // Two REAL toolbar anchors: the SAVE BUTTON and the project title — both
  // Tooltip-wrapped in Toolbar.svelte, always present.
  //
  // THE FIRST ANCHOR USED TO BE `.save-indicator`, the standalone save dot. That
  // dot RETIRED into the Save button (user ruling: "the unsaved-changes dot is
  // kind of the same thing as the save button — the same state"), so the anchor
  // moved with it. Nothing about what this probe tests changed: it needs two
  // always-present Tooltip anchors in the toolbar to collide, and the Save button
  // is one — indeed it is the very element the dot's tip now hangs off.
  const tips = () => page.evaluate(() => [...document.querySelectorAll(".tt-tip")].map((t) => t.textContent.trim()));

  /** Command (in-page). pointerenter on the anchor WRAPPING `sel`, cursor-ish coords. */
  const enter = (sel) => page.evaluate((sel) => {
    const anchor = document.querySelector(sel)?.closest(".tt-anchor");
    if (!anchor) return false;
    const r = anchor.getBoundingClientRect();
    anchor.dispatchEvent(new PointerEvent("pointerenter", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: false }));
    return true;
  }, sel);
  const leave = (sel) => page.evaluate((sel) => {
    document.querySelector(sel)?.closest(".tt-anchor")?.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
  }, sel);

  const SAVE_BTN = 'button[aria-label="Save Project"]'; // the merged control (see the note above)
  assert(await enter(SAVE_BTN), "first anchor found (the Save button)");
  await sleep(120);
  const one = await tips();
  assert(one.length === 1, `one tip after first enter (got ${one.length}: ${JSON.stringify(one)})`);

  // THE NESTED CONDITION: second enter with NO leave in between.
  assert(await enter(".doc-name"), "second anchor found (project title)");
  await sleep(120);
  const two = await tips();
  assert(two.length === 1, `STILL one tip after overlapping enter (got ${two.length}: ${JSON.stringify(two)})`);
  assert(two[0]?.includes("rename"), `the SECOND (innermost-equivalent) tip won (got ${JSON.stringify(two)})`);

  // Normal path: leaving the winner closes it; a fresh hover opens cleanly.
  await leave(".doc-name");
  await sleep(80);
  assert((await tips()).length === 0, "leave closes the tip");
  await enter(SAVE_BTN);
  await sleep(120);
  assert((await tips()).length === 1, "fresh hover after the collision still works");
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`tooltip_singleton_probe: ${fails.length} FAILED`); process.exit(1); }
console.log("tooltip_singleton_probe: all checks passed");
