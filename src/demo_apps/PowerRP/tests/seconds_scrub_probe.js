/**
 * SECONDS-SLIDER SENSITIVITY PROBE (verification, ephemeral — OpusJ / Round 14.6).
 *
 * Proves the fix end-to-end in the REAL editor: selecting a slide TRANSITION and
 * dragging its "Seconds" scrubber 100px moves the value by ~1 second (the tuned
 * low sensitivity), NOT ~100 seconds (the old 1 unit/px feel that made the value
 * "jump by so much" and snap to 0). It drives the ACTUAL rendered
 * Inspector.svelte transition row → its DraggableNumber, with a real trusted
 * puppeteer mouse drag — so it exercises the exact coefficient threading
 * (Inspector `coefficient={row.scrub}` ← registry SECONDS_SCRUB) that the
 * Round-12 fix missed (it only threaded scrub through the ITEM NumericField path,
 * never the plain transition-config DraggableNumber).
 *
 * Spawns its OWN vite (never :3637). Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/seconds_scrub_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

// Minimal two-slide deck; slide 2 carries a transition whose Seconds we scrub.
const doc = {
  meta: { name: "seconds-scrub-probe", slideW: 200, slideH: 200 },
  slides: [
    {
      id: "s0",
      name: "Slide 1",
      transition: { type: "tween", seconds: 0.5, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", name: "Camera", x: 0, y: 0, w: 200, h: 200, z: 1000, rotation: 0, scale: 1, active: true, background: "#000000" },
        },
      },
    },
    {
      id: "s1",
      name: "Slide 2",
      transition: { type: "fade", seconds: 0.5, curve: "smooth", sound: null },
      delta: {},
    },
  ],
};

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new" });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const ignore = (t) => /zero-sized canvas/.test(t) || /PowerRP repair: item .* was missing/.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !ignore(m.text())) errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), JSON.stringify(doc));
  await page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));

  // ── Layer 1: the registry carries the single-sourced low seconds scrub ───────
  const reg = await page.evaluate(() => {
    const a = window.__powerrp_app;
    // read the transition row the Inspector actually renders for slide 2's boundary
    const rec = a.transitionAt(a.doc.slides[1].id);
    return { type: rec.type, seconds: rec.seconds };
  });

  // ── Layer 2: select the transition, drag its Seconds scrubber 100px in the UI ─
  // Select slide 2's transition so the Inspector shows the transition rows.
  await page.evaluate(() => window.__powerrp_app.selectTransition(window.__powerrp_app.doc.slides[1].id));
  await new Promise((r) => setTimeout(r, 250));

  // Find the Seconds row's DraggableNumber (.dn) by its aria-label ("Seconds").
  const dnBox = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".dn")].find((d) => (d.getAttribute("aria-label") || "").toLowerCase().includes("second"));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!dnBox) throw new Error("SECONDS SCRUB PROBE FAIL: could not find the transition Seconds scrubber (.dn aria-label ~ 'Seconds') in the Inspector");

  const secondsBefore = await page.evaluate(() => window.__powerrp_app.transitionAt(window.__powerrp_app.doc.slides[1].id).seconds);

  // Real trusted mouse drag: press at the control center, move 100px UP (up
  // increases the value), release. Pointer lock may engage; movementY drives it.
  const DRAG_PX = 100;
  await page.mouse.move(dnBox.x, dnBox.y);
  await page.mouse.down();
  // step the move so the gesture crosses the click-slop and accumulates movementY
  for (let i = 1; i <= 10; i++) await page.mouse.move(dnBox.x, dnBox.y - (DRAG_PX * i) / 10);
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 200));

  const secondsAfter = await page.evaluate(() => window.__powerrp_app.transitionAt(window.__powerrp_app.doc.slides[1].id).seconds);
  const delta = secondsAfter - secondsBefore;

  const assert = (cond, msg) => { if (!cond) throw new Error(`SECONDS SCRUB PROBE FAIL: ${msg}\n  reg=${JSON.stringify(reg)} before=${secondsBefore} after=${secondsAfter} delta=${delta}`); };

  assert(reg.type === "fade", "slide 2 transition should be the fade we authored");
  // The drag moved the value UP by ~1s (SECONDS_SCRUB 0.01 × 100px), decisively
  // NOT ~100s. Tolerance covers eased/discrete rounding + pointer-lock quirks in
  // headless (movementY may under-report, so we assert the value stayed in a
  // low-sensitivity band, well under the old 1/px behavior).
  assert(delta > 0.2 && delta < 4, `100px drag on Seconds should move ~1s, not ~100s (moved +${delta}s) — the 14.6 fix`);
  // The decisive check: it is NOWHERE NEAR the old 1 unit/px (which would be
  // ~+100s, or clamp to a huge number). Anything under 10s proves the low scrub.
  assert(delta < 10, `Seconds scrub is still oversensitive (moved +${delta}s for 100px — old 1/px behavior would be ~+100s)`);

  if (errors.length) throw new Error(`Console errors during seconds scrub:\n${errors.join("\n")}`);
  console.log(`SECONDS SCRUB PROBE OK: transition Seconds scrubber moved +${delta.toFixed(3)}s for a 100px drag (≈1s, low sensitivity).`);
  console.log(`  Old 1 unit/px would have moved ~+100s. Zero console errors.`);
} finally {
  await browser.close();
  await server.close();
}
