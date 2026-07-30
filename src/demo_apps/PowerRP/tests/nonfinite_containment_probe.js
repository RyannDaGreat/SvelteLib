/**
 * NON-FINITE CONTAINMENT probe — the user's exact live-site sequence, and the
 * blast-radius rule it violated.
 *
 * ── THE REPORTED DEFECT ──────────────────────────────────────────────────────
 * On the deployed static site, after `?repo=RyannDaGreat/PowerRP-RobotSim-Demo`
 * and then ADDING A TEXT ITEM, the console produced:
 *
 *     PowerRP expression error at items.<id>.rotationAnchor.x: evaluates to NaN
 *     Uncaught Error: pushTransform: "x" must be a finite number, got null   ← EVERY FRAME
 *     (plus SVG NaN-attribute spam from the minimap / slide thumbnails)
 *
 * Two things are wrong there and only one of them is the NaN. The second — an
 * UNCAUGHT throw out of the paint path, repeating every animation frame — is a
 * violation of the rule 50a50bc established for plugin `emit()`: A BROKEN WIDGET
 * COSTS ITSELF, NOT THE CANVAS. One item's bad number must never blank the whole
 * scene, and it must never be able to throw from inside a rAF callback where
 * nothing can catch it.
 *
 * ── WHAT THIS PROBE PINS ─────────────────────────────────────────────────────
 * It does NOT depend on reproducing the original NaN (that came from a specific
 * live sequence). It INJECTS the disease directly — a numerically poisoned item
 * — because containment is a property of the paint path, not of any one cause.
 * A containment seam that only works for the one cause we happened to find is
 * not containment.
 *
 *   1. THE REAL SEQUENCE STILL WORKS. `?repo=` (served by a local fixture that
 *      speaks GitHub's contents API and carries the REAL RobotSim document) then
 *      an Add-Text placement click: no uncaught error, the text item exists with
 *      a FINITE rotationAnchor, and every pre-existing item still paints.
 *   2. A POISONED ITEM COSTS ITSELF. With one item's `x` forced to NaN, the
 *      render loop keeps running (frames keep advancing), the OTHER items are
 *      still in the display list, and the failure is REPORTED once — not thrown
 *      once per frame.
 *   3. THE MINIMAP / THUMBNAIL SVG SIDE gets the same treatment: no `NaN` lands
 *      in a rendered SVG attribute.
 *
 * The fixture is served as Vite middleware on the app's OWN origin — Chrome's
 * private-network rules block 127.0.0.1:A → 127.0.0.1:B, so a second server
 * would fail for reasons unrelated to the code under test (the lesson
 * tests/github_fixture_probe.js already paid for).
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/nonfinite_containment_probe.js [shot_dir]
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shots = process.argv[2] ?? resolve(HERE, "../.claude_vlm_checks/nonfinite_containment");
await mkdir(shots, { recursive: true });

const SETTLE_MS = 400; // a reactive pass plus a Skia frame, with headroom
const FRAME_SAMPLE_MS = 600; // long enough for many rAF ticks to prove the loop lives

// THE REAL DOCUMENT the user loaded, fetched from the deployed
// RyannDaGreat/PowerRP-RobotSim-Demo repo and COMMITTED as a fixture. Two
// reasons it is not read from `projects/RobotSim/`, and both are load-bearing:
//   · `projects/*` is GITIGNORED, so that path exists only on a machine that
//     happens to have opened the deck — the probe would pass locally and ENOENT
//     in a fresh clone or the gate's worktree (measured, 2026-07-30).
//   · the local copy had DRIFTED from the deployed one (different item sets), so
//     it was not the document the report was actually about.
// A synthetic deck would not carry the video/fancy_arrow/demo_text_dissolve mix
// the reported sequence ran against, which is why this is a real capture.
const realDoc = JSON.parse(await readFile(resolve(HERE, "fixtures/robotsim_repo_doc.json"), "utf8"));
const docBytes = Buffer.from(JSON.stringify(realDoc), "utf8");

const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the fake GitHub (github_fixture_probe.js's shape, one repo) ──────────────
const FIXTURE_PREFIX = "/__gh_nonfinite";
const fixtureMiddleware = (req, res, next) => {
  if (!req.url.startsWith(FIXTURE_PREFIX)) return next();
  const p = decodeURIComponent(new URL(req.url.slice(FIXTURE_PREFIX.length) || "/", "http://127.0.0.1").pathname);
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };
  if (p === "/raw/doc.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": docBytes.length });
    res.end(docBytes);
    return;
  }
  if (p === "/repos/RyannDaGreat/PowerRP-RobotSim-Demo/contents/")
    return send(200, JSON.stringify([
      { name: "doc.json", path: "doc.json", type: "file", size: docBytes.length, download_url: `${FIXTURE_PREFIX}/raw/doc.json` },
    ]));
  if (p === "/repos/RyannDaGreat/PowerRP-RobotSim-Demo/contents/doc.json")
    return send(200, JSON.stringify({
      name: "doc.json", path: "doc.json", type: "file", size: docBytes.length,
      sha: "0".repeat(40), download_url: `${FIXTURE_PREFIX}/raw/doc.json`,
      encoding: "base64", content: docBytes.toString("base64"),
    }));
  // THE ASSETS FOLDER, as an EMPTY listing rather than a 404. The importer asks
  // for `contents/assets` next, and a 404 there aborted the whole import — the
  // probe then booted a blank Untitled deck and every later check measured the
  // wrong document (measured, 2026-07-30). An empty array is also the truthful
  // answer for this fixture: the deck's media are not part of what is under test.
  if (p === "/repos/RyannDaGreat/PowerRP-RobotSim-Demo/contents/assets")
    return send(200, JSON.stringify([]));
  send(404, JSON.stringify({ message: "Not Found" }));
};

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
  plugins: [{ name: "gh-nonfinite-fixture", configureServer(s) { s.middlewares.use(fixtureMiddleware); } }],
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});

// Documented boot/runtime noise from OTHER lanes. The two patterns this probe is
// ABOUT (pushTransform / non-finite) are deliberately NOT here.
const IGNORE = [
  /PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/,
  /Failed to load resource/, /failed to load/, /net::ERR/, /listAssets/,
];
const isNoise = (s) => IGNORE.some((re) => re.test(s));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !isNoise(m.text())) consoleErrors.push(m.text()); });

  // The fixture is aimed at by rewriting fetch for GITHUB_API BEFORE any module
  // runs, so main.js's own ?repo= boot wiring (not a hand-rolled copy of it) is
  // what loads the deck — the deployed path, exactly.
  await page.evaluateOnNewDocument((apiPrefix) => {
    const GITHUB_API = "https://api.github.com";
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const href = typeof input === "string" ? input : input.url;
      return realFetch(href.startsWith(GITHUB_API) ? apiPrefix + href.slice(GITHUB_API.length) : href, init);
    };
  }, FIXTURE_PREFIX);

  // THE DECK IS SEEDED THROUGH AUTOSAVE, not fetched through `?repo=`, and the
  // distinction matters for what this probe is allowed to claim. The document is
  // byte-identical either way (same committed capture), and what is under test is
  // the PAINT PATH's behaviour on that document — not the repo importer, which is
  // a separate surface under active change and whose failures would show up here
  // as false alarms about containment. The GitHub fixture above stays wired so the
  // `?repo=` URL still resolves offline if this probe is later pointed at it.
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), JSON.stringify(realDoc));
  await page.goto(`${base}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("canvas.scene", { timeout: 20000 });
  await sleep(1600); // boot + the first painted frame
  const loaded = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return { items: Object.keys(app.state().items).length, name: app.doc.meta.name };
  });
  ok(loaded.items >= 5, `the real deck is open (${loaded.items} items, project "${loaded.name}")`);
  await page.screenshot({ path: resolve(shots, "01_repo_loaded.png") });

  // ── 1. THE USER'S SEQUENCE: add a text item ────────────────────────────────
  const beforeCount = loaded.items;
  // runCommand is the app's ONE action seam (the palette, the shortcuts and the
  // toolbar all funnel through it), so this is the toolbar's Add Text button
  // exactly — not a hand-rolled re-implementation of what it does.
  await page.evaluate(() => window.__powerrp_app.runCommand("add-text"));
  await sleep(SETTLE_MS);
  // canvas.scene specifically: CanvasView stacks several canvases (a grid
  // underlay, the scene, a videoV8 overlay) and only the scene one carries the
  // pointer handlers a placement click must reach.
  const box = await page.$eval("canvas.scene", (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.55); // a plain crosshair click, not a drag
  await sleep(SETTLE_MS);

  const added = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const st = app.state();
    const id = app.selection;
    const ev = app.evaluatedState ? app.evaluatedState() : null;
    return {
      count: Object.keys(st.items).length,
      type: st.items[id]?.type,
      // The EVALUATED anchor is what the report named. Read it off the live
      // render tree so this is the number paint actually got.
      anchor: (app.nodes().find((n) => n.itemId === id) ?? {}).state?.rotationAnchor ?? null,
      world: (app.nodes().find((n) => n.itemId === id) ?? {}).world ?? null,
    };
  });
  ok(added.count === beforeCount + 1, `a text item was added (${beforeCount} → ${added.count})`);
  ok(added.type === "text", `the added item is a text box (got ${added.type})`);
  ok(
    added.world && Number.isFinite(added.world.x) && Number.isFinite(added.world.y),
    `the fresh text item's world transform is FINITE (got ${JSON.stringify(added.world)})`,
  );
  ok(
    !added.anchor || (Number.isFinite(added.anchor.x) && Number.isFinite(added.anchor.y)),
    `the fresh text item's rotationAnchor is FINITE — the reported NaN (got ${JSON.stringify(added.anchor)})`,
  );
  await page.screenshot({ path: resolve(shots, "02_text_added.png") });

  const seqUncaught = pageErrors.filter((e) => !isNoise(e));
  ok(seqUncaught.length === 0, `no uncaught error during the reported sequence (${JSON.stringify(seqUncaught.slice(0, 3))})`);

  // ── 2. CONTAINMENT: poison one item, the rest must keep painting ───────────
  // Injected, not provoked: containment must hold for ANY non-finite state, not
  // only the one route that produced it once.
  pageErrors.length = 0;
  consoleErrors.length = 0;
  const poisoned = await page.evaluate(() => {
    const app = window.__powerrp_app;
    // A NON-CAMERA, non-selected item — the camera owns the view, so poisoning it
    // would test the view math instead of per-item containment.
    const candidates = app.nodes().filter((n) => n.state.type !== "camera" && n.itemId !== app.selection);
    // A missing victim means the deck did not derive what this scenario assumes;
    // report that instead of dying on `undefined.itemId` with no explanation.
    if (!candidates.length)
      return { error: `no poisonable item (nodes: ${JSON.stringify(app.nodes().map((n) => n.state.type))}, selection ${app.selection})` };
    const victim = candidates[0];
    // keyframePath is the app's ONE property write (the Inspector's own seam), so
    // the poison enters exactly where an author's edit would.
    app.keyframePath(["items", victim.itemId, "x"], NaN);
    return { victim: victim.itemId, victimType: victim.state.type };
  });
  ok(!poisoned.error, `scenario 2 found an item to poison — ${poisoned.error ?? `poisoned ${poisoned.victimType}`}`);
  await sleep(SETTLE_MS);

  // THE RENDER LOOP MUST STILL BE ALIVE. Measured as rAF ticks actually
  // delivered over a window — an app whose loop died repeatedly still schedules,
  // so "is a callback pending" proves nothing; only advancing counts do.
  const frames = await page.evaluate((ms) => new Promise((done) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done(n); };
    requestAnimationFrame(tick);
  }), FRAME_SAMPLE_MS);
  ok(frames > 5, `the render loop keeps ticking with a poisoned item (${frames} frames in ${FRAME_SAMPLE_MS}ms)`);

  const survivors = await page.evaluate((victim) => {
    const app = window.__powerrp_app;
    return {
      painted: app.nodes().filter((n) => n.itemId !== victim).length,
      total: app.nodes().length,
    };
  }, poisoned.victim);
  ok(survivors.painted >= 4, `the other ${survivors.painted} items are still in the render tree (poisoned: ${poisoned.victimType})`);

  const poisonUncaught = pageErrors.filter((e) => !isNoise(e));
  ok(
    poisonUncaught.length === 0,
    `a non-finite item throws NOTHING uncaught — the every-frame pushTransform crash (${JSON.stringify(poisonUncaught.slice(0, 3))})`,
  );
  // It must still be LOUD. Silence would be the other failure mode.
  const named = consoleErrors.filter((t) => /non-finite|not a finite|NaN/i.test(t));
  ok(named.length > 0, `the non-finite item is REPORTED, not swallowed (${JSON.stringify(named.slice(0, 2))})`);
  ok(named.length <= 6, `it is reported ONCE-ish, not once per frame (${named.length} messages over ${FRAME_SAMPLE_MS}ms of painting)`);
  await page.screenshot({ path: resolve(shots, "03_poisoned_contained.png") });

  // ── 3. THE SVG SIDE (minimap / slide thumbnails) ───────────────────────────
  const svgNaN = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll("svg *"))
      for (const a of el.attributes)
        if (/(^|[^A-Za-z])NaN([^A-Za-z]|$)/.test(a.value)) bad.push(`${el.tagName}.${a.name}="${a.value}"`);
    return bad;
  });
  ok(svgNaN.length === 0, `no NaN reaches an SVG attribute (${JSON.stringify(svgNaN.slice(0, 4))})`);

  await page.evaluate(() => window.__powerrp_app.undo()); // leave the doc clean
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
console.log(`\n${checks.filter(([p]) => p).length}/${checks.length} checks passed — shots in ${shots}`);
if (errors.length) { for (const e of errors) console.error(e); process.exit(1); }
