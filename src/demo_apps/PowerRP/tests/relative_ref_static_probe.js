/**
 * RELATIVE-REF STATIC-MODE PROBE — THE USER'S REPRO, in a real browser.
 *
 * THE BUG, verbatim: they dragged a RobotSim zip onto the STATIC GitHub Pages
 * site. "Slides loaded, the asset imported into browser storage, but the video did
 * not render." The document said "/asset/Untitled/Video_….mp4" and no project
 * called "Untitled" existed in that browser — the name had been baked in by a
 * Save-As long before, and on the static site there is no server to serve another
 * project's assets and paper over the difference.
 *
 * WHY A BROWSER PROBE AND NOT A NODE TEST. Every link in this chain is already
 * unit-tested (tests/asset_ref_grammar_test.js), and unit tests could not have
 * caught this bug: it lives in the JOIN between the grammar, the IndexedDB storage
 * adapter (which resolves a ref to a `blob:` object URL and returns a LOUD sentinel
 * for one it has never heard of), and the import that de-collides project names.
 * Static mode is also the ONLY mode where the failure is visible at all — the HTTP
 * adapter hides it. So this drives the whole loop through the real app:
 *
 *   1. import a .zip built HERE whose doc uses a RELATIVE ref, under ?static=1
 *   2. assert it is open under the DRAFT KEY — a storage key the archive was
 *      never told, which no exported absolute ref can have baked in. (This step
 *      used to assert a DE-COLLIDED name; the working-copy model replaced the
 *      de-collision with the draft key, and the comment on step 2 says why the
 *      substitution keeps the probe's meaning intact.)
 *   3. assert the derived render node's src resolved to THAT key
 *   4. assert the storage adapter can actually resolve it — a real blob: URL, not
 *      the MISSING_ASSET_URL sentinel. THIS is "the video renders".
 *   5. assert the LEGACY absolute ref still works when it names the right project
 *      (no migration), and produces the LOUD sentinel when it names a project this
 *      browser does not have — i.e. the old failure is still detected, just no
 *      longer reachable by anything the app writes.
 *
 * Spawns its OWN isolated Vite + headless Chromium, the house probe pattern.
 * FRONTEND-ONLY on purpose: no backend is started, because ?static=1 must not need
 * one — that is the deployment under test.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { zipSync } = await import("fflate");
const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Recognizable stand-in for the user's Video_20260726_224007_045.mp4. The probe
 *  cares that the BYTES round-trip into storage and resolve, not that they decode. */
const VIDEO_BYTES = "VIDEO-BYTES-NOT-A-REAL-MP4";

/**
 * Pure function. The archive bytes for a one-slide deck whose video `src` is the
 * RELATIVE "clip.mp4" — the shape an export produces since the grammar landed, and
 * the input the whole probe turns on. Named "RobotSim" so the second import must
 * de-collide, which is the condition that used to break an absolute ref.
 */
function buildRelativeRefZip() {
  const enc = new TextEncoder();
  const doc = {
    meta: { name: "RobotSim", slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s1", name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", active: true, x: 0, y: 0, w: 1280, h: 720, rotation: 0, scale: 1, background: "#101014" },
          // THE RELATIVE REF — no project name anywhere in it.
          vid: { type: "video", active: true, x: 100, y: 100, w: 640, h: 360, rotation: 0, scale: 1, src: "clip.mp4" },
        },
      },
    }],
  };
  return zipSync({
    "RobotSim/doc.json": enc.encode(JSON.stringify(doc, null, 2)),
    "RobotSim/assets/clip.mp4": enc.encode(VIDEO_BYTES),
  }, { level: 6 });
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // THREE classes of expected console noise, each ignored for a stated reason —
  // never a blanket filter, because an unexpected error here is exactly what this
  // probe is for:
  //   · backend-absent chatter: this Vite is FRONTEND-ONLY on purpose (?static=1
  //     must not need a server), so /api/ calls and thumbnail persists 404.
  //   · REPAIR reports: the staged fixture doc is deliberately minimal (a handful of
  //     properties, not every plugin default), so repairedDocument fills the rest and
  //     says so — loudly, by design. That is the repair pipeline working.
  //   · DECODE failures on clip.mp4 — "MEDIA_ELEMENT_ERROR / Format error" from the
  //     video registry, and "DEMUXER_ERROR_COULD_NOT_OPEN" from the Asset Explorer's
  //     thumbnailer. VIDEO_BYTES is a recognizable ASCII stand-in, not a real MP4, so
  //     every decoder that opens it rejects it. These are in fact CONFIRMATION rather
  //     than noise: a decoder can only report a format error about bytes it actually
  //     RECEIVED, which means the ref resolved and the blob was fetched. Using real
  //     MP4 bytes would silence them and prove strictly less. The failure this probe
  //     watches for is the opposite — a resolveUrl MISS, asserted directly against
  //     MISSING_ASSET_URL above.
  const EXPECTED_NOISE = /Failed to load resource|thumbnail|\/api\/|WebGPU|VideoV7|PowerRP repair:|MEDIA_ELEMENT_ERROR|DEMUXER_ERROR_COULD_NOT_OPEN|localAssetStore\.resolveUrl: "\/asset\/Untitled\//;
  page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  // ?static=1 forces the LOCAL (IndexedDB) adapter — the GitHub Pages deployment.
  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // The adapter, asked directly — an assertion that can actually FAIL. Getting this
  // wrong would silently run the whole probe against the HTTP adapter, which is the
  // one mode where the bug is invisible.
  const mode = await page.evaluate(async () => (await import("/storageMode.js")).assetStore().mode);
  assert(mode === "local", `?static=1 selected the LOCAL (IndexedDB) adapter, got "${mode}"`);

  // ── Stage a .zip whose doc uses a RELATIVE ref ────────────────────────────
  // Built in NODE (fflate is a dev dependency there) and handed to the page as a
  // byte array, because the archive is INPUT to this probe, not the thing under
  // test — web/projectZip.js's writer has its own node coverage in
  // tests/asset_localize_test.js. The layout is the real one: a single root folder
  // naming the project, doc.json at its top, assets/ beneath.
  const zipBytes = await page.evaluate((bytes) => {
    window.__probe_zip = new Uint8Array(bytes);
    return window.__probe_zip.length;
  }, Array.from(buildRelativeRefZip()));
  assert(zipBytes > 0, `staged a .zip whose doc holds the RELATIVE ref "clip.mp4" (${zipBytes}B)`);

  /** Import the staged zip under `filename`; returns the app's result. */
  const importZip = (filename) => page.evaluate(async (name) => {
    const file = new File([window.__probe_zip], name, { type: "application/zip" });
    const res = await window.__powerrp_app.importProjectZip(file);
    return { name: res.name, requested: res.requested };
  }, filename);

  // ── 1. FIRST import — lands under its own name ─────────────────────────────
  const first = await importZip("RobotSim.zip");
  await sleep(600);
  assert(first.name === "RobotSim", `first import landed as "${first.name}"`);

  // ── 2. THE ARCHIVE IS OPEN UNDER A KEY IT WAS NEVER TOLD ──────────────────
  // REWRITTEN FOR THE WORKING-COPY MODEL (9f386e9). This step used to import a
  // second time and assert the name DE-COLLIDED ("RobotSim 2"), because that was
  // how the app could end up resolving an archive's refs against a name the
  // archive never knew. A drop no longer creates a library entry, so there is no
  // second name to collide with and that assertion is unsatisfiable.
  //
  // THE PROBE'S POINT IS UNCHANGED AND, IF ANYTHING, SHARPER. The hazard was
  // never de-collision as such — it was "the storage key differs from the name
  // baked into an absolute ref at export time". The draft model makes that the
  // ORDINARY case rather than a corner one: every imported deck now lives under
  // the draft key `~draft/current`, which no exported document can ever name.
  // So a relative ref must resolve against the draft key, and an absolute ref
  // minted at export time is stale by construction — which is exactly what
  // steps 3-5 below go on to check.
  const second = await importZip("RobotSim.zip");
  await sleep(900);
  assert(second.name === "RobotSim", `a second import opens another clean draft, still named "${second.name}" (no de-collision: nothing was in the library to collide with)`);
  const openKey = await page.evaluate(() => window.__powerrp_app.projectName());
  assert(openKey.startsWith("~draft/"),
    `the open storage key is the DRAFT key, not the archive's own name (got ${JSON.stringify(openKey)}) — a name no exported absolute ref can have baked in`);
  const libraryAfter = await page.evaluate(async () => (await window.__powerrp_app.listProjects()).map((p) => p.name));
  assert(libraryAfter.length === 0, `two imports later the library is still EMPTY (${JSON.stringify(libraryAfter)})`);

  // ── 3. THE STORED SRC WAS NOT REWRITTEN, and 4. IT RESOLVES ────────────────
  const resolved = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const { assetStore } = await import("/storageMode.js");
    const { MISSING_ASSET_URL } = await import("/assetStore.js");
    const items = app.doc.slides[0].delta.items;
    const vidId = Object.keys(items).find((id) => items[id].type === "video");
    const node = app.nodes().find((n) => n.itemId === vidId);
    const url = assetStore().resolveUrl(node.state.src);
    return {
      stored: items[vidId].src,          // what the DOCUMENT holds
      derived: node.state.src,           // what the SEAM resolved it to
      url,                               // what STORAGE resolved that to
      missing: url === MISSING_ASSET_URL,
      project: app.projectName(),
    };
  });

  assert(resolved.stored === "clip.mp4",
    `the document still holds the RELATIVE "clip.mp4" — import rewrote nothing (got ${JSON.stringify(resolved.stored)})`);
  assert(resolved.derived === `/asset/${encodeURIComponent(resolved.project)}/clip.mp4`,
    `the seam resolved it against the OPEN project: ${resolved.derived}`);
  assert(!resolved.missing, "storage RESOLVED the ref — not the MISSING_ASSET_URL sentinel (this is 'the video renders')");
  assert(/^blob:/.test(resolved.url), `storage returned a real object URL: ${String(resolved.url).slice(0, 24)}…`);

  // And the bytes behind that URL are the ones the archive carried.
  const served = await page.evaluate(async (url) => (await (await fetch(url)).text()), resolved.url);
  assert(served === VIDEO_BYTES, "the resolved URL serves the archive's ORIGINAL bytes");

  // ── 5. THE LEGACY ABSOLUTE FORM: still works, and still fails loudly ───────
  const legacy = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const { assetStore } = await import("/storageMode.js");
    const { MISSING_ASSET_URL } = await import("/assetStore.js");
    const project = app.projectName();
    const items = app.doc.slides[0].delta.items;
    const vidId = Object.keys(items).find((id) => items[id].type === "video");

    // (a) an absolute ref naming THIS project — a pre-grammar document. No
    //     migration: it must resolve exactly as it always did.
    const correct = `/asset/${encodeURIComponent(project)}/clip.mp4`;
    const correctUrl = assetStore().resolveUrl(correct);

    // (b) THE ORIGINAL BUG: an absolute ref naming a project this browser does not
    //     have. It must produce the LOUD sentinel, never a silent blank — the
    //     failure is still detected, it is simply no longer reachable by anything
    //     the app writes.
    const staleUrl = assetStore().resolveUrl("/asset/Untitled/clip.mp4");

    // And the seam leaves an absolute ref alone rather than re-pointing it.
    app.commit({ ...app.doc, slides: [{ ...app.doc.doc?.slides?.[0] ?? app.doc.slides[0],
      delta: { items: { ...items, [vidId]: { ...items[vidId], src: correct } } } }] });
    const derivedAbsolute = app.nodes().find((n) => n.itemId === vidId)?.state.src ?? null;

    return {
      correctResolves: correctUrl !== MISSING_ASSET_URL && /^blob:/.test(correctUrl),
      staleIsSentinel: staleUrl === MISSING_ASSET_URL,
      derivedAbsolute, correct,
    };
  });

  assert(legacy.correctResolves, "a LEGACY absolute ref naming this project still resolves (no migration needed)");
  assert(legacy.staleIsSentinel, "a STALE absolute ref returns the LOUD missing sentinel — never a silent blank");
  assert(legacy.derivedAbsolute === legacy.correct,
    `the seam leaves an absolute ref exactly as authored (got ${legacy.derivedAbsolute})`);

  if (errors.length) { console.error("\nPAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors"); }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nRELATIVE-REF STATIC PROBE FAILED (${fails.length}):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log("\nRELATIVE-REF STATIC PROBE PASSED — the user's zip renders its video under a de-collided name.");
