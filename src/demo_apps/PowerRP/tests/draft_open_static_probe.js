/**
 * DRAFT-OPEN PROBE — the working-copy model, end to end, in a real browser.
 *
 * THE RULING UNDER TEST (user): "It shouldn't have to save until the user decides
 * to save — that goes for uploading zips too. Most editors let you edit things
 * UNTIL you decide to save, and the browser can persist it until later."
 *
 * WHAT USED TO HAPPEN: dropping a .zip WROTE it — into IndexedDB in static mode,
 * onto the server's disk in HTTP mode — as a new project, before the editor ever
 * showed it. So merely LOOKING at a deck someone sent you left "RobotSim",
 * "RobotSim 2", "RobotSim 3" behind in your library. This probe's first assertion
 * is the whole point: after a drop, THE LIBRARY IS STILL EMPTY.
 *
 * THE FIVE THINGS ASSERTED, in the order a user meets them:
 *   1. DROP → DRAFT. The deck opens, the title shows its HUMAN name, the save
 *      indicator reads "unsaved", and listProjects() is UNCHANGED.
 *   2. THE CANVAS RESOLVES. Draft assets are staged under the reserved key, so a
 *      ref must resolve to a real blob: URL — not the MISSING sentinel. This is
 *      the assertion that would fail if projectName() and the staging keyspace
 *      ever disagreed, which is the single most dangerous way this design can
 *      break (the canvas would go blank while everything else looked fine).
 *   3. RELOAD KEEPS THE DRAFT ("the browser can persist it until later"): the
 *      document returns from autosave, the draft marker is restored, the staged
 *      assets still resolve, and STILL nothing is in the library.
 *   4. SAVE COMMITS IT, ONCE. After saving, the project exists EXACTLY once, its
 *      assets came with it, the indicator reads "saved", and draft mode is over.
 *   5. A SECOND DROP IS A SECOND CLEAN DRAFT — it does not accumulate library
 *      entries, which is what made the predecessor's localStorage idempotency
 *      memo unnecessary.
 *
 * Spawns its OWN isolated Vite + headless Chromium (the house probe pattern) and
 * runs FRONTEND-ONLY under ?static=1: no backend, which is both the deployment
 * under test and the reason the library assertions are cheap to make.
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

/** A REAL 2x2 PNG: assertions about decoding need bytes a decoder accepts. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z4AATEwMDAwAEDgBA6mCLNAAAAAASUVORK5CYII=";
const b64Bytes = (b64) => new Uint8Array(Buffer.from(b64, "base64"));

/** The video asset carries recognizable ASCII rather than a real mp4: the
 *  assertions about it concern its SRC and its bytes, not decoding (same split as
 *  asset_reload_static_probe.js, whose fixtures this deliberately mirrors). */
const VIDEO_BYTES = "VIDEO-BYTES-NOT-A-REAL-MP4";

/**
 * Pure function. Archive bytes for a one-slide deck with an image and a video.
 *
 * THE DOC'S REFS ARE ABSOLUTE AND NAME A PROJECT THAT WILL NOT EXIST
 * ("/asset/Untitled/…") — deliberately, because that is what every
 * pre-localization export looks like (the user's real RobotSim zips). Opening it
 * as a draft must HEAL those through archive adoption (commit 7f52bae) so they
 * resolve against the draft keyspace. A fixture with relative refs would pass
 * even if adoption were broken.
 */
function buildDeckZip(name) {
  const enc = new TextEncoder();
  const doc = {
    meta: { name, slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s1", name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", active: true, x: 0, y: 0, w: 1280, h: 720, rotation: 0, scale: 1, background: "#101014" },
          img: { type: "image", active: true, x: 100, y: 100, w: 320, h: 180, rotation: 0, scale: 1, src: "/asset/Untitled/logo.png" },
          vid: { type: "video", active: true, x: 500, y: 100, w: 640, h: 360, rotation: 0, scale: 1, src: "/asset/Untitled/clip.mp4" },
        },
      },
    }],
  };
  return zipSync({
    [`${name}/doc.json`]: enc.encode(JSON.stringify(doc, null, 2)),
    [`${name}/assets/logo.png`]: b64Bytes(PNG_B64),
    [`${name}/assets/clip.mp4`]: enc.encode(VIDEO_BYTES),
  }, { level: 6 });
}

/** Console noise this probe ignores, each for a stated reason — never a blanket
 *  filter, since an unexpected error IS a failure signal here:
 *   · backend-absent chatter: this Vite is frontend-only on purpose.
 *   · repair reports: the fixture doc is minimal, so repairedDocument fills the
 *     rest and says so. That is the pipeline working.
 *   · clip.mp4 / logo.png decode failures in the image and video REGISTRIES:
 *     VIDEO_BYTES is ASCII and the 2x2 PNG is too small for some paint paths, so
 *     a decoder rejecting them is the EXPECTED outcome for these fixtures — and a
 *     decode error PROVES the bytes were delivered, which is the opposite of the
 *     failure this probe hunts (a ref that resolved to nothing at all).
 *   · the missing-asset SENTINEL reaching the image registry: same window as the
 *     transient miss below — the registry is handed the sentinel for the frame
 *     before priming completes, and reports it rather than drawing a blank.
 *   · the __no_such_project__ resolve: the probe asks for a ref that cannot exist
 *     in order to OBTAIN the missing sentinel, and the adapter is loud about a
 *     miss by design.
 *   · a TRANSIENT resolveUrl miss while the store is switching keyspaces. This one
 *     is the subtle entry, so it is stated precisely: `resolveUrl` is SYNCHRONOUS
 *     by contract while `primeUrls` is async, so between "the document now points
 *     at keyspace X" and "X's object URLs exist" a paint can land and log a miss.
 *     It is PRE-EXISTING and NOT draft-specific — the same lines appear for the
 *     ordinary project "RobotSim" right after commitDraft, and asset_reload_static_probe.js
 *     lives with the same window. What this probe still catches is a PERSISTENT
 *     miss: every assertion above reads resolveUrl DIRECTLY after the awaited
 *     staging and demands a blob: URL, so a keyspace that never primed fails
 *     loudly there rather than being excused here. */
const EXPECTED_NOISE = /Failed to load resource|thumbnail|\/api\/|WebGPU|VideoV7|PowerRP repair:|MEDIA_ELEMENT_ERROR|DEMUXER_ERROR_COULD_NOT_OPEN|__no_such_project__|localAssetStore\.resolveUrl:|image_registry: failed to load|video_registry: resume of/;

/** Query (in-page). Drop a zip exactly as the user's drag-and-drop does. */
async function dropZip(page, name) {
  const res = await page.evaluate(async (bytes, zipName) => {
    const file = new File([new Uint8Array(bytes)], `${zipName}.zip`, { type: "application/zip" });
    return await window.__powerrp_app.importProjectZip(file);
  }, Array.from(buildDeckZip(name)), name);
  await sleep(1200);
  return res;
}

/** Query (in-page). The facts that define "is this a draft?" in one round trip. */
const draftState = (page) => page.evaluate(async () => ({
  projectName: window.__powerrp_app.projectName(),
  displayName: window.__powerrp_app.projectDisplayName(),
  // SPREAD, not the raw value: draftMode is a Svelte $state proxy, and puppeteer
  // serializes a proxy as {} — asserting on its fields needs a plain snapshot.
  draftMode: window.__powerrp_app.draftMode ? { ...window.__powerrp_app.draftMode } : null,
  saveState: window.__powerrp_app.saveState(),
  projects: (await window.__powerrp_app.listProjects()).map((p) => p.name),
  title: document.querySelector(".doc-name")?.textContent?.trim() ?? null,
}));

/** Query (in-page). Whether every asset ref of the open deck resolves to a real
 *  object URL. The sentinel is OBTAINED rather than hardcoded, so this stays
 *  correct if MISSING_ASSET_URL's spelling ever changes. */
const refsResolve = (page) => page.evaluate(async () => {
  const store = window.__powerrp_storage.assetStore();
  const sentinel = store.resolveUrl("/asset/__no_such_project__/__no_such_file__");
  const assets = await window.__powerrp_app.listProjectAssets();
  return assets.map((a) => { const url = store.resolveUrl(a.url); return { name: a.name, size: a.size, url, missing: url === sentinel }; });
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  const mode = await page.evaluate(() => window.__powerrp_storage.assetStore().mode);
  assert(mode === "local", `?static=1 selected the LOCAL (IndexedDB) adapter, got "${mode}"`);
  const before = await page.evaluate(async () => (await window.__powerrp_app.listProjects()).map((p) => p.name));
  assert(before.length === 0, `the library starts EMPTY (found: ${JSON.stringify(before)})`);

  // ── 1. DROP → DRAFT, and the library is untouched ──────────────────────────
  const dropped = await dropZip(page, "RobotSim");
  assert(dropped.draft === true, "importProjectZip reports it opened a DRAFT");
  assert(dropped.name === "RobotSim", `the draft carries the dropped file's name (got "${dropped.name}")`);

  const s1 = await draftState(page);
  assert(s1.projects.length === 0, `THE RULING: after dropping a .zip the project library is STILL EMPTY (found: ${JSON.stringify(s1.projects)})`);
  assert(s1.draftMode !== null, "the app is in draft mode");
  assert(s1.draftMode?.sourceUrl === "", "a DROPPED zip records no source URL — there is nothing to share, which is what gates Copy Share Link");
  assert(s1.displayName === "RobotSim", `the HUMAN name is the deck's own (got "${s1.displayName}")`);
  assert(s1.title === "RobotSim", `the toolbar title shows the human name, never the storage key (got "${s1.title}")`);
  assert(s1.projectName.startsWith("~draft/"), `THE INVARIANT: projectName() answers the DRAFT KEY while a draft is open (got "${s1.projectName}")`);
  assert(s1.saveState === "unsaved", `the save indicator reads UNSAVED (got "${s1.saveState}")`);

  // ── 2. THE CANVAS RESOLVES against the draft staging ───────────────────────
  const staged = await refsResolve(page);
  assert(staged.length === 2, `both assets are staged under the draft key (found ${staged.length})`);
  for (const a of staged) {
    assert(!a.missing, `draft asset "${a.name}" RESOLVES — not the MISSING sentinel`);
    assert(/^blob:/.test(a.url), `draft asset "${a.name}" is a real object URL (${String(a.url).slice(0, 16)}…)`);
    assert(a.size > 0, `draft asset "${a.name}" carries real bytes (${a.size}B)`);
  }
  // ARCHIVE ADOPTION: the fixture's refs named "/asset/Untitled/…", a project that
  // does not exist. If adoption were skipped they would resolve to nothing here.
  const canvasOk = await page.evaluate(() => {
    const store = window.__powerrp_storage.assetStore();
    const sentinel = store.resolveUrl("/asset/__no_such_project__/__no_such_file__");
    const nodes = window.__powerrp_app.nodes?.() ?? [];
    const srcs = JSON.stringify(window.__powerrp_app.doc).match(/"[^"]*\.(png|mp4)"/g) ?? [];
    return { nodeCount: nodes.length, srcs, sentinel };
  });
  assert(!JSON.stringify(canvasOk.srcs).includes("/asset/Untitled/"),
    `ARCHIVE ADOPTION healed the legacy absolute refs — the document no longer names a project that does not exist (${JSON.stringify(canvasOk.srcs)})`);

  // ── 3. RELOAD KEEPS THE DRAFT ──────────────────────────────────────────────
  errors.length = 0;
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(4000); // full boot: wasm, fonts, autosave restore, draft restore

  const s2 = await draftState(page);
  assert(s2.draftMode !== null, "after RELOAD the draft is still a draft (the marker survived)");
  assert(s2.displayName === "RobotSim", `after RELOAD the human name came back (got "${s2.displayName}")`);
  assert(s2.projectName.startsWith("~draft/"), `after RELOAD projectName() still answers the draft key (got "${s2.projectName}")`);
  assert(s2.saveState === "unsaved", "after RELOAD it still reads UNSAVED — a reload is not a save");
  assert(s2.projects.length === 0, `after RELOAD the library is STILL EMPTY (found: ${JSON.stringify(s2.projects)})`);

  const afterReload = await refsResolve(page);
  assert(afterReload.length === 2, `after RELOAD both staged assets are still listed (found ${afterReload.length})`);
  for (const a of afterReload) {
    assert(!a.missing, `after RELOAD draft asset "${a.name}" still RESOLVES — the boot primed the draft keyspace`);
    assert(/^blob:/.test(a.url), `after RELOAD "${a.name}" is a real object URL`);
  }

  // ── 4. SAVE COMMITS IT — exactly once ──────────────────────────────────────
  await page.evaluate(async () => { await window.__powerrp_app.commitDraft("RobotSim"); });
  await sleep(1500);

  const s3 = await draftState(page);
  assert(s3.draftMode === null, "after SAVE draft mode is over");
  assert(s3.projectName === "RobotSim", `after SAVE projectName() is the REAL project name again (got "${s3.projectName}")`);
  assert(s3.saveState === "saved", `after SAVE the indicator reads SAVED (got "${s3.saveState}")`);
  assert(s3.projects.length === 1 && s3.projects[0] === "RobotSim",
    `after SAVE the project exists EXACTLY ONCE (found: ${JSON.stringify(s3.projects)})`);

  const committed = await refsResolve(page);
  assert(committed.length === 2, `the saved project owns both assets — the staging was COPIED, not abandoned (found ${committed.length})`);
  for (const a of committed) {
    assert(!a.missing, `saved asset "${a.name}" resolves under the real project name`);
  }

  // ── 5. A SECOND DROP IS A SECOND CLEAN DRAFT ───────────────────────────────
  // This is what made the predecessor's localStorage idempotency memo obsolete: a
  // deck opened twice cannot pile up library entries, because opening one adds
  // nothing to the library at all.
  await dropZip(page, "RobotSim");
  const s4 = await draftState(page);
  assert(s4.draftMode !== null, "the second drop opened a new DRAFT");
  assert(s4.saveState === "unsaved", "the second draft reads UNSAVED");
  assert(s4.projects.length === 1 && s4.projects[0] === "RobotSim",
    `re-opening the same deck did NOT mint "RobotSim 2" — the library still holds exactly one (found: ${JSON.stringify(s4.projects)})`);

  const restaged = await refsResolve(page);
  assert(restaged.length === 2, `the new draft's staging REPLACED the old one rather than unioning with it (found ${restaged.length}, expected 2)`);

  if (errors.length) { console.error("UNEXPECTED CONSOLE/PAGE ERRORS:\n" + errors.join("\n")); fails.push(`${errors.length} unexpected error(s)`); }
  console.log(fails.length ? `\ndraft_open_static_probe: ${fails.length} FAILED` : "\ndraft_open_static_probe: all checks passed");
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
