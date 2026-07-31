/**
 * OFFLINE PWA PROBE — the acceptance test for the user's ruling that PowerRP
 * "should be able to work offline and online", and that a widget which needs the
 * network "should give you a notice ... It should know that".
 *
 * It proves the claim the README makes, in the only way that counts: build the
 * real static bundle, visit it ONCE with a network, then TAKE THE NETWORK AWAY
 * and reload. Everything after that point must come out of the service worker's
 * cache and the browser's own storage.
 *
 * WHAT IS ASSERTED, and why each one is not redundant:
 *   1. THE WORKER INSTALLS, with the ~7 MB canvaskit wasm in its precache. This
 *      is checked against the CACHE CONTENTS, not the manifest source: a list
 *      that names the wasm but failed to fetch it would pass a source check and
 *      strand the user at the boot splash forever, which is precisely the
 *      failure mode this feature exists to prevent.
 *   2. A DRAFT SURVIVES. Autosave is client-side in every mode, but "client-side"
 *      is a claim about code; this checks the document actually comes back after
 *      an offline reload, which is what the user asked for ("the site to be able
 *      to save itself regardless ... even the static site").
 *   3. THE EDITOR BOOTS OFFLINE — first real canvas frame, not merely an HTML
 *      response. The splash is removed at the first GPU paint, so its absence is
 *      the honest signal that the wasm loaded and Skia rendered from cache.
 *   4. ICONIFY SEARCH SAYS SO. Offline, the palette must show the offline
 *      sentence rather than an empty grid — the empty grid is what reads as "the
 *      search is broken" and is the specific complaint behind the ruling.
 *   5. IT RECOVERS. Back online, the same search must return results with NO
 *      reload and no retyping. A notice that outlives its outage is a new bug,
 *      not a fix, so recovery is asserted as tightly as the notice itself.
 *
 * WHY page.setOfflineMode AND NOT A KILLED SERVER: it cuts the RENDERER's
 * network exactly the way losing wifi does — the service worker still runs, the
 * cache still answers, and `navigator.onLine` flips, which is the state the
 * connectivity seam is built to read. Stopping the preview server instead would
 * test a 404, which is a different failure with a different correct behaviour.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/offline_pwa_probe.js
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

/** The Pages project-site subpath the workflow deploys under. The whole point of
 *  rehearsing at a SUBPATH is that a worker registered at "/" would control
 *  nothing here, and the precache URLs would all 404. */
const BASE = "/SvelteLib/";

/** How long a cold boot may take before we call it hung. Generous: the offline
 *  reload decodes a ~7 MB wasm from cache on a software GL stack. */
const BOOT_SETTLE_MS = 45000;

/** How long to wait for the service worker to finish precaching ~33 MB. */
const SW_READY_MS = 60000;

/** How long a search may take to produce its result or its notice. */
const SEARCH_MS = 15000;

const failures = [];
const note = (m) => console.log(`  · ${m}`);

/** Command. Poll `fn` until it returns truthy or the budget runs out. Returns
 *  the value or null — the caller decides whether null is a failure, because
 *  "did not appear" is the expected answer for some of these checks. */
async function waitFor(fn, budgetMs, stepMs = 250) {
  for (let waited = 0; waited < budgetMs; waited += stepMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

process.env.POWERRP_BASE = BASE;
const { build, preview } = await import("vite");
console.log(`building the static bundle at base ${BASE} …`);
await build({ configFile: resolve(webRoot, "vite.config.js"), logLevel: "warn" });

const server = await preview({
  configFile: resolve(webRoot, "vite.config.js"),
  preview: { port: 0, host: "127.0.0.1", open: false },
});
const port = server.httpServer.address().port;
// `?static=1` forces static storage. Without it the storage probe would ask this
// preview server for /api/projects/, get the SPA fallback, and the app could
// boot in the wrong mode — the documented reason that flag exists.
const url = `http://127.0.0.1:${port}${BASE}?static=1`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

  // ── VISIT 1: ONLINE. Boot, register the worker, precache, leave a draft. ────
  console.log("\nvisit 1 (online) …");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });

  const booted = await waitFor(
    () => page.evaluate(() => !document.getElementById("powerrp-boot") && !!window.__powerrp_app),
    BOOT_SETTLE_MS,
  );
  if (!booted) failures.push("visit 1: the editor never reached its first frame online");
  else note("editor booted online (boot splash lifted)");

  // The worker must not merely be registered — its cache must hold the wasm.
  const swState = await waitFor(async () => {
    const s = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg?.active) return null;
      const names = await caches.keys();
      const shell = names.find((n) => n.startsWith("powerrp-shell-"));
      if (!shell) return null;
      const keys = await (await caches.open(shell)).keys();
      const urls = keys.map((r) => r.url);
      return { shell, count: urls.length, wasm: urls.some((u) => u.endsWith(".wasm")) };
    });
    // Precaching is atomic but not instant; wait until the wasm has landed.
    return s?.wasm ? s : null;
  }, SW_READY_MS);

  if (!swState) failures.push("the service worker never finished precaching the canvaskit wasm");
  else note(`service worker active: cache "${swState.shell}", ${swState.count} entries, wasm cached`);

  // Leave a draft with a recognizable name, so visit 2 proves the DOCUMENT came
  // back rather than merely that some editor booted.
  const DRAFT_MARK = "OfflineProbeDeck";
  // Through `commit`, which is THE autosave write (app.svelte.js: commit ->
  // localStorage.setItem(AUTOSAVE_KEY, serialize(doc))). Mutating `doc.meta`
  // in place would change the name on screen but never reach storage, and the
  // probe would then be asserting nothing. `commit` also requires a NEW object
  // — it early-returns on identity — hence the structured copy.
  await page.evaluate((name) => {
    const app = window.__powerrp_app;
    app.commit({ ...app.doc, meta: { ...app.doc.meta, name } });
  }, DRAFT_MARK);
  await new Promise((r) => setTimeout(r, 500));
  const wrote = await page.evaluate(() => window.__powerrp_app?.doc?.meta?.name ?? null);
  if (wrote !== DRAFT_MARK) failures.push(`visit 1: could not set up the draft (name is ${JSON.stringify(wrote)})`);
  else note(`left a draft named "${DRAFT_MARK}"`);

  // ── GO OFFLINE ─────────────────────────────────────────────────────────────
  console.log("\ngoing offline …");
  await page.setOfflineMode(true);

  // ── VISIT 2: OFFLINE RELOAD. The headline claim. ───────────────────────────
  await page.reload({ waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });

  const bootedOffline = await waitFor(
    () => page.evaluate(() => !document.getElementById("powerrp-boot") && !!window.__powerrp_app),
    BOOT_SETTLE_MS,
  );
  if (!bootedOffline) failures.push("OFFLINE RELOAD DID NOT BOOT — the service worker cache did not serve the app");
  else note("editor booted OFFLINE from the service worker cache");

  // ── A PUPPETEER ARTIFACT THAT WOULD OTHERWISE READ AS AN APP BUG ───────────
  // MEASURED, not assumed: after `setOfflineMode(true)` followed by a reload,
  // the FRESH document reports `navigator.onLine === true` even though every
  // request fails. (Reproduced in isolation: offline-then-reload on a data: URL
  // gives onLine === true, while offline on an already-loaded page correctly
  // gives false and fires the `offline` event.) A real browser that lost its
  // network reports false on a fresh document, so this is CDP emulation leaking,
  // not something the app can or should compensate for — and "compensating"
  // would mean the seam second-guessing the platform, which is exactly the kind
  // of cleverness that makes an offline notice wrong in the field.
  //
  // Toggling the mode off and on again re-fires the event against the live
  // document, which is the state a user in an outage is actually in. That is
  // what the rest of this probe measures.
  await page.setOfflineMode(false);
  await page.setOfflineMode(true);
  await new Promise((r) => setTimeout(r, 500)); // let the `offline` event dispatch

  const draftName = await page.evaluate(() => window.__powerrp_app?.doc?.meta?.name ?? null);
  if (draftName !== DRAFT_MARK) failures.push(`the draft did not survive the offline reload (name is ${JSON.stringify(draftName)}, want ${JSON.stringify(DRAFT_MARK)})`);
  else note(`draft survived: "${draftName}"`);

  // The seam must KNOW, without being told by a failing request.
  const seesOffline = await waitFor(() => page.evaluate(() => window.__powerrp_app?.online === false), 5000);
  if (!seesOffline) failures.push("app.online did not go false offline — the connectivity seam is not wired");
  else note("the connectivity seam reports offline");

  // ── THE ICONIFY NOTICE (the ruling's named example) ────────────────────────
  // Driven through the provider rather than the DOM: the palette is opened by
  // double-clicking a widget, and this probe is about WHAT THE PROVIDER SAYS,
  // which is exactly the string CanvasToolbar renders into its status line.
  //
  // `window.__powerrp_searchIconify` is a dev/test hook (web/App.svelte, beside
  // the existing `__powerrp_app`): in a BUILT bundle every module name is a
  // content hash, so a probe has no importable path to the plugin and must be
  // handed the function by the app.
  const notice = await page.evaluate(async () => {
    try {
      await window.__powerrp_searchIconify("robot");
      return { threw: false, message: "" };
    } catch (e) {
      return { threw: true, message: e?.message ?? String(e) };
    }
  });
  if (!notice.threw) failures.push("iconify search did NOT report offline — it returned as if it had worked");
  else if (!/offline/i.test(notice.message)) failures.push(`iconify search failed without naming offline: ${JSON.stringify(notice.message)}`);
  else note(`iconify search says: "${notice.message}"`);

  // The command gate must state its reason through the registry, not silently.
  const gate = await page.evaluate(() => window.__powerrp_commandReason?.("open-project-url") ?? null);
  if (!gate) failures.push("open-project-url was still offered while offline (no unavailable reason)");
  else if (!/internet/i.test(gate)) failures.push(`open-project-url's offline reason does not mention the internet: ${JSON.stringify(gate)}`);
  else note(`open-project-url gated: "Unavailable — requires ${gate}"`);

  // ── BACK ONLINE: recovery, with no reload ──────────────────────────────────
  console.log("\nback online …");
  await page.setOfflineMode(false);
  // The `online` event is what the seam listens for; puppeteer's offline toggle
  // fires it, but give the listener a tick to run.
  const recovered = await waitFor(() => page.evaluate(() => window.__powerrp_app?.online === true), 10000);
  if (!recovered) failures.push("app.online did not return to true after the network came back");
  else note("the connectivity seam recovered");

  const back = await waitFor(async () => {
    const r = await page.evaluate(async () => {
      try {
        const cells = await window.__powerrp_searchIconify("robot");
        return { ok: true, n: cells.length };
      } catch (e) {
        return { ok: false, message: e?.message ?? String(e) };
      }
    });
    return r.ok && r.n > 0 ? r : null;
  }, SEARCH_MS);
  if (!back) failures.push("iconify search did not recover once back online");
  else note(`iconify search recovered: ${back.n} results`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\nFAIL offline_pwa_probe (${failures.length}):\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log("\nPASS offline_pwa_probe — static build boots OFFLINE from the SW cache with its draft intact; iconify says it is offline and recovers online.");
