/**
 * BOOT TIMELINE MEASUREMENT (WORKSTREAM AH, step 1) — not a probe, a ruler.
 *
 * Builds the real static bundle (the deployed shape, service worker and all),
 * previews it, and times a COLD boot and a WARM boot, recording:
 *   · every window.__powerrp_boot stage push, with a t relative to navigation
 *   · every network response over a size floor, with its transfer size
 *   · the service worker's install/activate wall-clock
 *   · the first real canvas paint (splash removal)
 *
 * Usage: node <this> [--throttle] [--label NAME]
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const BASE = "/SvelteLib/";
const BOOT_SETTLE_MS = 300000; // a Fast-3G cold load moves ~24 MB; 120s was not enough and reported a false hang
const SW_SETTLE_MS = 120000;

const args = process.argv.slice(2);
const THROTTLE = args.includes("--throttle");
const LABEL = (args.find((a) => a.startsWith("--label=")) || "--label=run").slice(8);

process.env.POWERRP_BASE = BASE;
const { build, preview } = await import("vite");
console.log(`[${LABEL}] building static bundle at base ${BASE} …`);
const t0build = Date.now();
await build({ configFile: resolve(webRoot, "vite.config.js"), logLevel: "warn" });
console.log(`[${LABEL}] built in ${((Date.now() - t0build) / 1000).toFixed(1)}s`);

const server = await preview({ configFile: resolve(webRoot, "vite.config.js"), preview: { port: 0, host: "127.0.0.1", open: false } });
const addr = server.httpServer.address();
const origin = `http://127.0.0.1:${addr.port}`;
const url = `${origin}${BASE}`;
console.log(`[${LABEL}] preview at ${url}`);

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser({ protocolTimeout: 300000 });

/** Command. Runs one boot in a fresh page and returns its measured record. */
async function measure(page, { cold, throttle }) {
  const responses = [];
  page.on("response", async (res) => {
    const r = res.request();
    responses.push({ url: res.url().replace(origin, ""), status: res.status(), type: res.headers()["content-type"] || "", fromSW: res.fromServiceWorker(), t: Date.now() });
  });
  if (throttle) {
    const cdp = await page.target().createCDPSession();
    await cdp.send("Network.enable");
    // "Fast 3G"-ish: 1.6 Mbps down, 750 Kbps up, 150ms RTT. Makes phases legible.
    await cdp.send("Network.emulateNetworkConditions", { offline: false, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 });
  }
  await page.evaluateOnNewDocument(() => {
    window.__t0 = performance.now();
    window.__swEvents = [];
    // Snapshot the boot history even after the splash element is removed.
    document.addEventListener("DOMContentLoaded", () => {
      window.__hist = window.__powerrp_boot ? window.__powerrp_boot.history : null;
    });
    if (navigator.serviceWorker) {
      navigator.serviceWorker.ready.then(() => window.__swEvents.push({ e: "ready", t: performance.now() }));
      navigator.serviceWorker.addEventListener("controllerchange", () => window.__swEvents.push({ e: "controllerchange", t: performance.now() }));
    }
  });

  const tNav = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });
  let splashGoneAt = null;
  await page
    .waitForFunction(() => !document.getElementById("boot-splash"), { timeout: BOOT_SETTLE_MS, polling: 50 })
    .then(() => { splashGoneAt = Date.now(); })
    .catch(() => console.log("  !! splash never lifted"));

  const res = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    return {
      hist: (window.__hist || []).map((h) => ({ ...h })),
      swEvents: window.__swEvents,
      frames: window.__powerrp_app ? window.__powerrp_app.renderFrameCount : 0,
      timing: { domContentLoaded: nav.domContentLoadedEventEnd, loadEvent: nav.loadEventEnd, responseEnd: nav.responseEnd },
      resources: performance.getEntriesByType("resource").map((r) => ({ name: r.name, start: r.startTime, end: r.responseEnd, size: r.transferSize, decoded: r.decodedBodySize, initiator: r.initiatorType })),
      swState: navigator.serviceWorker && navigator.serviceWorker.controller ? "controlled" : "uncontrolled",
    };
  });
  // Wait for the SW to finish precaching so the warm run is genuinely warm.
  const swDone = await page
    .waitForFunction(async () => {
      const names = await caches.keys();
      const shell = names.find((n) => n.startsWith("powerrp-shell-"));
      if (!shell) return false;
      const c = await caches.open(shell);
      return (await c.keys()).length > 0;
    }, { timeout: SW_SETTLE_MS, polling: 500 })
    .then(() => Date.now())
    .catch(() => null);

  const cacheCount = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = names.find((n) => n.startsWith("powerrp-shell-"));
    if (!shell) return { entries: 0, name: null };
    const c = await caches.open(shell);
    const keys = await c.keys();
    let bytes = 0;
    for (const k of keys) { const r = await c.match(k); if (r) { const b = await r.clone().blob(); bytes += b.size; } }
    return { entries: keys.length, name: shell, bytes };
  });

  return {
    cold, throttle, tNav,
    splashLiftMs: splashGoneAt ? splashGoneAt - tNav : null,
    swPrecacheDoneMs: swDone ? swDone - tNav : null,
    ...res,
    cache: cacheCount,
    responses,
  };
}

const out = {};
{
  // A GENUINELY COLD BOOT NEEDS ITS OWN STORAGE PARTITION, not merely
  // setCacheEnabled(false). That flag disables the HTTP cache and NOTHING ELSE,
  // so a profile that had already installed the service worker navigated
  // SW-CONTROLLED and was handed the ~32 MB of Noto/CJK faces out of Cache
  // Storage at wire=0. Two rounds of measurement were invalidated by this: one
  // build "measured" 65 s that way and ~244 s with the worker actually gone —
  // a 4x difference that was entirely the service worker and not the app.
  // Unregistering by hand inside a throwaway navigation is not enough either,
  // because the page that does the unregistering re-registers the worker as it
  // loads. An incognito-style BrowserContext has no worker and no caches by
  // construction, which is the only version of this that cannot silently rot.
  const coldCtx = await browser.createBrowserContext();
  const page = await coldCtx.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setCacheEnabled(false);
  console.log(`[${LABEL}] COLD boot …`);
  out.cold = await measure(page, { cold: true, throttle: THROTTLE });
  console.log(`[${LABEL}]   splash lifted at ${out.cold.splashLiftMs}ms; precache ${out.cold.cache.entries} entries / ${(out.cold.cache.bytes / 1048576).toFixed(1)}MB at ${out.cold.swPrecacheDoneMs}ms`);
  // WARM: same browser context (HTTP cache + SW retained), cache enabled.
  await page.setCacheEnabled(true);
  console.log(`[${LABEL}] WARM boot …`);
  out.warm = await measure(page, { cold: false, throttle: THROTTLE });
  console.log(`[${LABEL}]   splash lifted at ${out.warm.splashLiftMs}ms`);
  await page.close();
}

const outPath = resolve(HERE, `timeline_${LABEL}${THROTTLE ? "_throttled" : ""}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`[${LABEL}] wrote ${outPath}`);

await browser.close();
await server.httpServer.close();
process.exit(0);
