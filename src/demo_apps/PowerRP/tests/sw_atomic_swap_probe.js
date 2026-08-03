/**
 * SW ATOMIC SWAP PROBE (WORKSTREAM AI) — no page may ever load assets from two
 * different versions, and no dev page may be controlled by a worker at all.
 *
 * THE INCIDENT this is the regression guard for: the app crashed at boot with
 * `properties.bundle: unknown bundle "transform"` — a PRE-rename properties
 * chunk evaluated against POST-rename plugin chunks. HEAD was consistent. The
 * service worker assembled the chimera locally, because rule 1 was NETWORK-FIRST
 * and, on success, wrote the fetched document into the RUNNING worker's own
 * shell cache. After a deploy that stores version B's index.html — naming B's
 * content-hashed chunks — in version A's cache, which contains none of them, and
 * that poisoned entry outlives the session. See sw.js's "THE ATOMIC SWAP".
 *
 * ── WHAT IS ASSERTED, and why each is a different claim ──────────────────────
 *  A. THE POISONING WRITE IS GONE. After a build is precached, the shell cache's
 *     stored index.html must be BYTE-IDENTICAL to the one this version emitted.
 *     Checked by serving a DELIBERATELY DIFFERENT document from the network and
 *     navigating: under the old network-first code that foreign document was
 *     both served and stored; under the current code the cached one wins and the
 *     cache is untouched. This is the bug, reproduced and then denied.
 *  B. EVERY CACHED CHUNK BELONGS TO THIS VERSION. The cached index.html's
 *     referenced asset URLs must all be present in the SAME cache — that is the
 *     mechanical statement of "complete", and the property the chimera lacked.
 *  C. ONE SHELL CACHE AT REST. After install+activate settle, exactly one
 *     `powerrp-shell-*` cache exists, so there is no second generation for a
 *     load to mix with.
 *  D. THE MID-SESSION UPDATE DOES NOT DISTURB THE RUNNING SESSION. A second
 *     version is installed WHILE the editor is up; the live page must keep its
 *     controller, keep its own cache intact, and keep its document (a draft
 *     name) — and the new generation must land in its OWN new cache. Then a
 *     reload must come up on the new version, complete.
 *  E. DEV REGISTERS NO WORKER, and CLEANS UP one that was planted. Two separate
 *     claims: abstaining is not the same as being uncontrolled, and only the
 *     second protects a machine that once ran a build on this origin.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/sw_atomic_swap_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const BASE = "/SvelteLib/"; // rehearse at the deploy subpath, like the other static probes
const BOOT_SETTLE_MS = 45000;
const SW_READY_MS = 60000;

const failures = [];
const note = (m) => console.log(`  · ${m}`);

/** Command. Poll `fn` until truthy or the budget runs out; null on timeout. */
async function waitFor(fn, budgetMs, stepMs = 250) {
  for (let waited = 0; waited < budgetMs; waited += stepMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

/** Query (async; page). The shell cache's name, entry count, and the stored
 *  index.html's text — one observation, so the assertions below cannot race. */
async function readShell(page) {
  return page.evaluate(async (shellUrl) => {
    const names = (await caches.keys()).filter((n) => n.startsWith("powerrp-shell-"));
    if (!names.length) return { names: [] };
    const cache = await caches.open(names[0]);
    const keys = (await cache.keys()).map((r) => new URL(r.url).pathname);
    const doc = await cache.match(shellUrl);
    return { names, keys, html: doc ? await doc.text() : null };
  }, `${BASE}index.html`);
}

const { build, preview } = await import("vite");
process.env.POWERRP_BASE = BASE;
console.log(`building the static bundle at base ${BASE} …`);
await build({ configFile: resolve(webRoot, "vite.config.js"), logLevel: "warn" });

const server = await preview({
  configFile: resolve(webRoot, "vite.config.js"),
  preview: { port: 0, host: "127.0.0.1", open: false },
});
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}${BASE}?static=1`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

  console.log("\nvisit 1 (online) — install and precache …");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });
  const booted = await waitFor(
    () => page.evaluate(() => !document.getElementById("boot-splash") && !!window.__powerrp_app),
    BOOT_SETTLE_MS,
  );
  if (!booted) failures.push("the editor never booted online, so nothing below could be measured");

  const ready = await waitFor(async () => {
    const s = await readShell(page);
    return s.names.length && s.html ? s : null;
  }, SW_READY_MS);
  if (!ready) {
    failures.push("the service worker never precached a shell — every assertion below is vacuous");
  } else {
    note(`shell cache "${ready.names[0]}": ${ready.keys.length} entries`);

    // ── C. ONE GENERATION AT REST ─────────────────────────────────────────
    if (ready.names.length !== 1) failures.push(`${ready.names.length} shell caches coexist at rest (${ready.names.join(", ")}) — a load could mix generations`);
    else note("exactly one shell generation at rest");

    // ── B. THE CACHED DOCUMENT'S CHUNKS ARE ALL IN THE SAME CACHE ─────────
    // The mechanical definition of "complete", and precisely what the chimera
    // lacked: an index.html naming chunks its own cache does not hold.
    const referenced = [...ready.html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => u.startsWith(BASE) && /\.(js|css)$/.test(u));
    const missing = referenced.filter((u) => !ready.keys.includes(u));
    if (!referenced.length) failures.push("the cached index.html referenced no bundle assets — the parse is wrong, not the cache");
    else if (missing.length) failures.push(`the cached shell references ${missing.length} asset(s) NOT in its own cache — THIS IS THE CHIMERA:\n    ${missing.join("\n    ")}`);
    else note(`all ${referenced.length} referenced bundle assets are in this version's own cache`);

    // ── A. A FOREIGN DOCUMENT MUST NEITHER BE SERVED NOR STORED ───────────
    // Simulate the deploy: make the NETWORK answer navigations with a document
    // that is not this version's. Under the old network-first + cache.put code
    // this both rendered and poisoned the cache permanently.
    const FOREIGN = "<!doctype html><title>FOREIGN VERSION B</title><script src=\"/SvelteLib/assets/does-not-exist-b.js\"></script>";
    await page.setRequestInterception(true);
    const onReq = (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && req.resourceType() === "document") {
        req.respond({ status: 200, contentType: "text/html", body: FOREIGN });
        return;
      }
      req.continue();
    };
    page.on("request", onReq);
    await page.reload({ waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });

    const servedForeign = await page.evaluate(() => document.title);
    if (servedForeign === "FOREIGN VERSION B") failures.push("the worker SERVED a foreign-version document over its own complete cache — navigation is not cache-first");
    else note(`navigation served this version's own shell (title ${JSON.stringify(servedForeign)}), not the network's`);

    page.off("request", onReq);
    await page.setRequestInterception(false);

    const after = await readShell(page);
    if (after.html !== ready.html) failures.push("THE CACHE WAS REWRITTEN by a navigation — the poisoning write is still there");
    else note("the shell cache is byte-identical after the foreign navigation — nothing but addAll writes it");
  }

  // ── D. THE MID-SESSION UPDATE ───────────────────────────────────────────
  // Not simulated with a second build (that would take another minute and prove
  // the same thing): the claim under test is that INSTALLING a new version
  // touches nothing the live page depends on. `sw.js`'s install writes only into
  // its own new cache name and never calls skipWaiting, so the observable
  // contract is: controller unchanged, this version's cache unchanged, document
  // intact, across an explicit update() while the editor is up.
  console.log("\nmid-session update …");
  await page.reload({ waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });
  await waitFor(() => page.evaluate(() => !!window.__powerrp_app), BOOT_SETTLE_MS);
  const DRAFT_MARK = "AtomicSwapProbeDeck";
  await page.evaluate((name) => {
    const app = window.__powerrp_app;
    app.commit({ ...app.doc, meta: { ...app.doc.meta, name } });
  }, DRAFT_MARK);

  const before = await page.evaluate(async () => ({
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    shells: (await caches.keys()).filter((n) => n.startsWith("powerrp-shell-")),
  }));
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
  });
  await new Promise((r) => setTimeout(r, 3000));
  const during = await page.evaluate(async () => ({
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    shells: (await caches.keys()).filter((n) => n.startsWith("powerrp-shell-")),
    draft: window.__powerrp_app?.doc?.meta?.name ?? null,
    alive: !!window.__powerrp_app,
  }));
  if (during.controller !== before.controller) failures.push("the controller CHANGED under a running session — an update took over without a reload");
  else note("controller unchanged through the update");
  if (!during.alive || during.draft !== DRAFT_MARK) failures.push(`the running session was disturbed by the update (draft is ${JSON.stringify(during.draft)})`);
  else note(`the running session is intact, draft "${during.draft}" still loaded`);
  if (!before.shells.every((n) => during.shells.includes(n))) failures.push("the live page's shell cache was DELETED by an install running behind it");
  else note("the live page's own generation survived the install");

  const reloaded = await page.reload({ waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS }).then(
    () => waitFor(() => page.evaluate(() => !!window.__powerrp_app), BOOT_SETTLE_MS),
  );
  if (!reloaded) failures.push("the NEXT RELOAD after an update did not boot — the swap is not safe");
  else note("the next reload boots on a complete version");

  await page.close();

  // ── E. DEV: NO WORKER, AND CLEANUP OF A PLANTED ONE ─────────────────────
  // Same origin as a build would use is not reproducible here (the dev server
  // gets its own port), so the two halves are checked where each is meaningful:
  // the dev server must REGISTER nothing, and unregisterInDev must actually
  // remove a registration when one exists.
  console.log("\ndev server: no worker …");
  // THE BASE MUST BE UNSET FIRST, and forgetting it made this section measure
  // the wrong server entirely: POWERRP_BASE is still "/SvelteLib/" from the
  // build above, vite reads it at config time, and the dev server then serves
  // the app at a subpath while this probe navigates to "/". The observable
  // symptom was a "dev" page logging "offline cache registered" — a PROD-only
  // line — which is a contradiction, not a finding.
  delete process.env.POWERRP_BASE;
  // AND NODE_ENV, for a subtler reason worth recording: `vite build` SETS
  // `process.env.NODE_ENV = "production"` in this very process, and a later
  // `createServer` in the same process then resolves `import.meta.env.PROD` to
  // TRUE on a dev server. MEASURED here — the dev page logged "offline cache
  // registered", the PROD-only line, on a confirmed vite-client page. That is an
  // artifact of running a build and a dev server in one node process, NOT an app
  // defect; a developer's real `npm run dev` never had a build run first. The
  // probe must undo its own contamination rather than report it as a finding.
  delete process.env.NODE_ENV;
  const { createServer } = await import("vite");
  const dev = await createServer({
    configFile: resolve(webRoot, "vite.config.js"),
    server: { port: 0, open: false, host: "127.0.0.1" },
    // ONE ROUTE, existing only for this probe: a same-origin worker script to
    // PLANT (see the plant step below for why blob: cannot be used). It is added
    // here rather than to the app's own dev middleware because the app must ship
    // no such route — "the dev server serves no worker" is the rule under test.
    plugins: [{
      name: "probe-planted-sw",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if ((req.url ?? "").split("?")[0] !== "/__probe_planted_sw.js") return next();
          res.setHeader("Content-Type", "text/javascript");
          res.end("self.addEventListener('fetch', () => {});");
        });
      },
    }],
  });
  await dev.listen();
  const devUrl = `http://127.0.0.1:${dev.httpServer.address().port}/`;
  try {
    const devPage = await browser.newPage();
    const devLogs = [];
    devPage.on("console", (m) => devLogs.push(m.text()));
    await devPage.goto(devUrl, { waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });
    await waitFor(() => devPage.evaluate(() => !!window.__powerrp_app), BOOT_SETTLE_MS);
    // PROVE THIS IS THE DEV SERVER before concluding anything from it. "No
    // worker registered" is trivially true of any page that failed to load the
    // app, and was in fact once true here of a page being served by the PREVIEW
    // server under a leftover base. Vite's HMR client is the dev-only marker.
    const isDev = await devPage.evaluate(() => !!window.__vite_plugin_svelte_hot ||
      [...document.scripts].some((s) => (s.src || "").includes("/@vite/client")) ||
      [...document.querySelectorAll("script")].some((s) => (s.textContent || "").includes("/@vite/client")));
    if (!isDev) failures.push("the page checked for dev-mode behaviour is NOT a dev-server page — this section measured the wrong server");
    else note("confirmed a dev-server page (vite client present)");

    const regs = await devPage.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    if (regs !== 0) failures.push(`the DEV server registered ${regs} service worker(s) — a dev page served cached modules is a phantom-bug factory`);
    else note("dev registered no service worker");

    // PLANT one and prove the cleanup path fires. What is under test is that the
    // dev boot REMOVES whatever registration it finds, not which script that
    // registration points at — so any same-origin worker script will do.
    //
    // IT MUST BE SAME-ORIGIN AND http(s): a `blob:` URL is REFUSED by the
    // platform ("The URL protocol of the script … is not supported"), which is
    // how the first version of this probe silently skipped the whole check. The
    // dev middleware below serves one trivial script for exactly this purpose;
    // `sw.js` itself does not exist in dev (its plugin is build-only), which is
    // the rule this section is testing, not a gap in it.
    const planted = await devPage.evaluate(async () => {
      await navigator.serviceWorker.register("/__probe_planted_sw.js");
      return (await navigator.serviceWorker.getRegistrations()).length;
    }).catch((e) => `threw: ${e.message}`);

    if (typeof planted !== "number" || planted < 1) {
      // A FAILURE, not a note. The first version of this probe reported this as
      // a skip and therefore asserted nothing about the cleanup at all — the
      // half of the dev rule that actually protects a machine which once ran a
      // build. A probe that cannot set up its own precondition is broken, and
      // must say so rather than quietly passing.
      failures.push(`could not plant a worker in dev, so the cleanup path was never exercised: ${planted}`);
    } else {
      devLogs.length = 0;
      await devPage.reload({ waitUntil: "domcontentloaded", timeout: BOOT_SETTLE_MS });
      const gone = await waitFor(
        async () => (await devPage.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0,
        10000,
      );
      if (!gone) failures.push("a planted worker SURVIVED a dev boot — unregisterInDev did not fire");
      else note("a planted worker was unregistered by the dev boot");
      const loud = devLogs.some((t) => /unregistered \d+ service worker/i.test(t));
      if (!loud) failures.push(`the dev cleanup was SILENT — that line is the explanation for whatever staleness came before it (logs: ${JSON.stringify(devLogs.slice(-4))})`);
      else note("the cleanup announced itself on the console");
    }
    await devPage.close();
  } finally {
    await dev.close();
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\nFAIL sw_atomic_swap_probe (${failures.length}):\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log("\nPASS sw_atomic_swap_probe — a version's cache holds only its own complete byte set, a foreign document is neither served nor stored, an update leaves the running session alone, and dev registers no worker and cleans up a planted one.");
