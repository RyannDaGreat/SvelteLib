/**
 * PRODUCTION BOOT PROBE (WORKSTREAM CF) — the PRODUCTION bundle reaches its
 * FIRST PAINTED FRAME, and the boot splash reports no crash getting there.
 *
 * ── THE INCIDENT (2026-08-03) ────────────────────────────────────────────────
 * The deployed site went down at first frame with Svelte 5's
 * `effect_update_depth_exceeded`: an `$effect` in web/CanvasView.svelte called
 * `app.bumpPressEpoch()`, whose `this.pressEpoch++` READ the state it wrote, so
 * the effect subscribed itself to its own write and re-ran until the guard fired.
 * The user found it by loading the site. That is the wrong discoverer.
 *
 * ── WHY THIS FILE EXISTS WHEN sw_atomic_swap_probe ALREADY BUILDS PROD ───────
 * It is NOT that the crash was unreachable — measured both ways at the culprit
 * commit, sw_atomic_swap_probe DOES go red on it. But it reports
 * "the editor never booted online, so nothing below could be measured", as the
 * PRECONDITION of a service-worker investigation. A reader triaging that line
 * looks at the service worker, which was innocent; the actual sentence
 * (`effect_update_depth_exceeded`) appeared only as an unasserted `[page error]`
 * in the log. So the gap this closes is DIAGNOSTIC, not coverage: a first-frame
 * crash should have one probe whose entire subject is the first frame, whose name
 * says so, and which quotes the splash's own words back.
 *
 * It is also the CHEAP half of that probe — one build, one navigation, no worker
 * lifecycle, no second version — so it can be the thing you run before a push.
 *
 * ── WHY PRODUCTION AND NOT DEV ───────────────────────────────────────────────
 * Two reasons, and the second is the one that bites. A prod build MINIFIES, so
 * the crash arrives with unreadable frames (`at Yqe (index-Qdvhc5xm.js:2:3288)`)
 * — that is what the user pasted, and it is why the splash's top-frame line
 * cannot be the whole diagnosis. And PowerRP's prod entry is its OWN config
 * (web/vite.config.js → dist-powerrp): a root `npx vite build` does not build
 * this app at all, so "it builds" from anywhere else proves nothing about what
 * ships. This probe boots exactly the artifact the deploy serves, at the deploy's
 * own `base`.
 *
 * ── WHAT PASSING MEANS ───────────────────────────────────────────────────────
 * `#boot-splash` is removed at the FIRST REAL CANVAS PAINT (web/index.html), and
 * `failed` is a one-way latch, so the splash surviving with crash text is a crash
 * even if a frame later arrives. Both are checked: the splash must go, AND no
 * page error may have been raised on the way.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/prod_boot_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const BASE = "/SvelteLib/"; // the deploy subpath, as the other static probes rehearse it
const BOOT_BUDGET_MS = 90000; // a cold prod boot compiles Skia and loads 26 fonts

const failures = [];
const note = (m) => console.log(`  · ${m}`);

const { build, preview } = await import("vite");
process.env.POWERRP_BASE = BASE;
console.log(`building the production bundle at base ${BASE} …`);
await build({ configFile: resolve(webRoot, "vite.config.js"), logLevel: "warn" });

const server = await preview({
  configFile: resolve(webRoot, "vite.config.js"),
  preview: { port: 0, host: "127.0.0.1", open: false },
});
const port = server.httpServer.address().port;
// `?static=1` matches the other static probes: no project backend is running here,
// and an absent backend must not be reported as a boot failure.
const url = `http://127.0.0.1:${port}${BASE}?static=1`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

try {
  const page = await browser.newPage();
  // EVERY page error is kept, not just the first: the reactive-loop guard throws
  // once but a boot can die several ways, and the report should name them all.
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.stack || e.message));

  console.log("\nbooting the production bundle …");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: BOOT_BUDGET_MS });

  // Resolve as soon as EITHER outcome is settled — the splash lifting (painted) or
  // the splash latching failed. Waiting for the splash to lift alone would burn the
  // whole budget on a crash that is already decided, which is exactly the slow,
  // uninformative shape this probe exists to replace.
  let outcome = null;
  try {
    outcome = await page.waitForFunction(
      () => {
        const s = document.getElementById("boot-splash");
        if (s === null) return { painted: true, text: "" };
        if (s.getAttribute("data-failed") === "1") return { painted: false, text: s.innerText || s.textContent || "" };
        return false;
      },
      { timeout: BOOT_BUDGET_MS, polling: 250 },
    ).then((h) => h.jsonValue());
  } catch {
    const text = await page.evaluate(() => {
      const s = document.getElementById("boot-splash");
      return s ? s.innerText || s.textContent || "" : "";
    });
    failures.push(`the first frame never painted within ${BOOT_BUDGET_MS} ms and the splash never reported a crash — splash text: ${JSON.stringify(text.slice(0, 400))}`);
  }

  if (outcome && outcome.painted) note("the boot splash lifted — the first frame painted");
  else if (outcome) failures.push(`the boot splash reported a crash instead of a first frame: ${JSON.stringify(outcome.text.slice(0, 600))}`);

  // THE PAGE ERROR IS ASSERTED, not merely logged. The culprit commit's crash
  // reached the log of an existing probe as an unasserted `[page error]` line and
  // was read past; a thrown error during boot is a failure here, with its text.
  if (pageErrors.length) {
    for (const e of pageErrors) failures.push(`an uncaught error was raised during boot: ${e.split("\n").slice(0, 2).join(" | ")}`);
  } else note("no uncaught error was raised during the boot");

  await page.close();
} finally {
  await browser.close();
  await server.httpServer.close();
}

if (failures.length) {
  console.log(`\nFAIL prod_boot_probe (${failures.length}):\n`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log("\nPASS prod_boot_probe — the production bundle reaches its first painted frame with no uncaught error and no crash reported in the splash.");
