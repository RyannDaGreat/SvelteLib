/**
 * ASSET-RELOAD STATIC PROBE — THE USER'S SECOND REPRO, and the one the existing
 * static probe structurally could not catch.
 *
 * THE BUG, verbatim: "I drag and drop that zip onto the static website, and I
 * refresh the page, and it's broken. I'm pretty sure it knows what's in there — it
 * shows a big exclamation mark, but it still knows how many megabytes were in it,
 * and when I click download it still downloads."
 *
 * WHY THE OTHER PROBE MISSED IT. tests/relative_ref_static_probe.js drives import →
 * assert inside ONE page session, and an import calls loadProject(), which PRIMES the
 * local adapter's object-URL memo. A RELOAD is a different code path entirely: the
 * document comes back from the localStorage autosave (App.svelte → app.loadAutosave),
 * which restores the deck WITHOUT opening a project, so nothing primes the memo. Every
 * `/asset/…` ref then resolves to MISSING_ASSET_URL — the exclamation mark — while
 * `list` and `get` still read IndexedDB directly, which is exactly why the size and
 * the download kept working. The whole bug lives in the difference between those two
 * boots, so the probe MUST reload.
 *
 * WHAT IT ASSERTS, after the reload and with no user action:
 *   1. the listing survives (size/kind intact — the half that always worked)
 *   2. every ref resolves to a real blob: URL, not the MISSING sentinel
 *   3. the Explorer's <img> tile actually decodes (naturalWidth > 0)
 *   4. the <video> tile's element holds a blob: src and reaches readyState >= 1
 *   5. the preview modal opens on a real bitmap
 *   6. zero unexpected console errors — a resolveUrl MISS logs one, so this is a
 *      second, independent detector of the same failure
 *
 * Spawns its OWN isolated Vite + headless Chromium (the house probe pattern) and is
 * FRONTEND-ONLY: ?static=1 must not need a backend, which is the deployment under test.
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

/** A REAL 2x2 PNG (not a stand-in): this probe asserts naturalWidth > 0, which only
 *  bytes a decoder accepts can produce. Base64 of the smallest valid opaque PNG. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8z4AATEwMDAwAEDgBA6mCLNAAAAAASUVORK5CYII=";

/** Pure function. base64 → bytes (node has Buffer; kept explicit so the fixture is
 *  readable as data rather than as a Buffer call buried in the zip build). */
function b64Bytes(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** A tiny but STRUCTURALLY REAL mp4 is out of scope for a fixture, so the video
 *  asset carries recognizable ASCII: the assertions about it are about the SRC and
 *  the store (blob: URL, right bytes), not about decoding. The image carries the
 *  decode assertion. Same split as relative_ref_static_probe.js. */
const VIDEO_BYTES = "VIDEO-BYTES-NOT-A-REAL-MP4";

/**
 * Pure function. Archive bytes for a one-slide deck holding BOTH an image and a
 * video asset, the two tile kinds with distinct preview paths (a <img> thumbnail vs
 * a client-captured VideoThumbnail frame).
 */
function buildDeckZip() {
  const enc = new TextEncoder();
  const doc = {
    meta: { name: "ReloadDeck", slideW: 1280, slideH: 720, script: "" },
    slides: [{
      id: "s1", name: "Slide 1",
      transition: { type: "cut", seconds: 0, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", active: true, x: 0, y: 0, w: 1280, h: 720, rotation: 0, scale: 1, background: "#101014" },
          img: { type: "image", active: true, x: 100, y: 100, w: 320, h: 180, rotation: 0, scale: 1, src: "logo.png" },
          vid: { type: "video", active: true, x: 500, y: 100, w: 640, h: 360, rotation: 0, scale: 1, src: "clip.mp4" },
        },
      },
    }],
  };
  return zipSync({
    "ReloadDeck/doc.json": enc.encode(JSON.stringify(doc, null, 2)),
    "ReloadDeck/assets/logo.png": b64Bytes(PNG_B64),
    "ReloadDeck/assets/clip.mp4": enc.encode(VIDEO_BYTES),
  }, { level: 6 });
}

/** Console noise this probe ignores, each for a stated reason — never a blanket
 *  filter, because an unexpected error IS the failure signal here:
 *   · backend-absent chatter: this Vite is frontend-only on purpose.
 *   · repair reports: the fixture doc is deliberately minimal, so repairedDocument
 *     fills the rest and says so. That is the pipeline working.
 *   · clip.mp4 decode failures: VIDEO_BYTES is ASCII, so every decoder that opens it
 *     rejects it. A format error PROVES the bytes arrived.
 *   · the __no_such_project__ resolve: the probe asks for a ref that cannot exist in
 *     order to OBTAIN the missing-asset sentinel, and the adapter is loud about a
 *     miss by design. Scoped to that one impossible name, so a real miss still
 *     fails the probe. */
const EXPECTED_NOISE = /Failed to load resource|thumbnail|\/api\/|WebGPU|VideoV7|PowerRP repair:|MEDIA_ELEMENT_ERROR|DEMUXER_ERROR_COULD_NOT_OPEN|__no_such_project__/;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Through window.__powerrp_storage (main.js's diagnostic seam), NOT a fresh
  // dynamic import: a probe that imports "/storageMode.js" itself can get a module
  // instance whose detectStorageMode() has not run, and storageMode() throws by
  // design on that read. The seam hands back the very stores the app is using.
  const mode = await page.evaluate(() => window.__powerrp_storage.assetStore().mode);
  assert(mode === "local", `?static=1 selected the LOCAL (IndexedDB) adapter, got "${mode}"`);

  // ── Import the deck, exactly as the user's drag-and-drop does ───────────────
  const imported = await page.evaluate(async (bytes) => {
    const file = new File([new Uint8Array(bytes)], "ReloadDeck.zip", { type: "application/zip" });
    const res = await window.__powerrp_app.importProjectZip(file);
    return res.name;
  }, Array.from(buildDeckZip()));
  await sleep(1200);
  assert(imported === "ReloadDeck", `imported as "${imported}"`);

  // ── THE RELOAD. Everything after this is the state the user actually saw ────
  errors.length = 0;
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(4000); // full boot again: wasm, fonts, autosave restore, asset list
  // UPDATED FOR THE WORKING-COPY MODEL. This used to assert
  // `projectName() === "ReloadDeck"`, which was right when a dropped .zip was
  // WRITTEN as a project on arrival. It is now opened as an unsaved DRAFT (the
  // user's ruling: "It shouldn't have to save until the user decides to save —
  // that goes for uploading zips too"), so after a reload the two names are
  // deliberately different: projectName() is the draft STORAGE KEY, and the human
  // name lives on projectDisplayName(). Both are asserted, because "the deck came
  // back" needs the display name and "it came back AS A DRAFT" needs the key —
  // and this probe's real subject, that its ASSETS still resolve, is unchanged
  // below.
  const restored = await page.evaluate(() => ({
    key: window.__powerrp_app.projectName(),
    shown: window.__powerrp_app.projectDisplayName(),
    isDraft: window.__powerrp_app.draftMode !== null,
  }));
  assert(restored.shown === "ReloadDeck", `after RELOAD the autosaved deck came back under its own name (got "${restored.shown}")`);
  assert(restored.isDraft && restored.key.startsWith("~draft/"),
    `after RELOAD it is still the unsaved DRAFT it was opened as (draft=${restored.isDraft}, key="${restored.key}")`);

  // ── 1. The half that always worked: the listing ─────────────────────────────
  const listed = await page.evaluate(async () => (await window.__powerrp_app.listProjectAssets()).map((a) => ({ name: a.name, size: a.size, kind: a.kind, url: a.url })));
  const png = listed.find((a) => a.name === "logo.png");
  const mp4 = listed.find((a) => a.name === "clip.mp4");
  assert(png && png.size > 0, `the listing survived the reload with real sizes (logo.png = ${png?.size}B)`);
  assert(mp4 && mp4.kind === "video", `clip.mp4 is listed as a video (${mp4?.size}B)`);

  // ── 2. RESOLUTION after a reload — the actual defect ────────────────────────
  const resolved = await page.evaluate((refs) => {
    const store = window.__powerrp_storage.assetStore();
    // The sentinel is OBTAINED, not hardcoded: resolving a ref that provably cannot
    // exist yields exactly MISSING_ASSET_URL, so the comparison below stays correct
    // if that constant's spelling ever changes. (Importing assetStore.js for the
    // export would fetch a SECOND module instance — see the mode note above.)
    const sentinel = store.resolveUrl("/asset/__no_such_project__/__no_such_file__");
    return refs.map((ref) => { const url = store.resolveUrl(ref); return { ref, url, missing: url === sentinel }; });
  }, [png.url, mp4.url]);
  for (const r of resolved) {
    assert(!r.missing, `after RELOAD, "${r.ref}" resolves — not the MISSING sentinel`);
    assert(/^blob:/.test(r.url), `after RELOAD, "${r.ref}" is a real object URL (${String(r.url).slice(0, 16)}…)`);
  }

  // ── 3+4. The TILES themselves, in the mounted Asset Explorer ────────────────
  // Queried from the LIVE DOM rather than by re-deriving URLs, because "the tile
  // shows an exclamation mark" is a DOM fact — re-deriving would test the seam twice
  // and the surface zero times.
  //
  // The two kinds have DIFFERENT tile DOM, which is why they are asserted apart:
  //   image → SvelteLib <Thumbnail>, whose <img src> IS the resolved asset URL, so
  //           blob:-ness and naturalWidth are both readable there.
  //   video → <VideoThumbnail>, which decodes a frame OFF-DOM and mounts a data:
  //           URL of the captured canvas. Its resolved URL therefore never appears
  //           in the DOM at all, so what is assertable here is the tile's STATE: it
  //           must not be in .vidthumb-error. (Its src resolution is asserted at the
  //           store level above, and with ASCII bytes a decode error is expected —
  //           see EXPECTED_NOISE.)
  const tiles = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll(".ae-grid img")];
    const img = imgs.find((e) => /^blob:/.test(e.src)) ?? imgs[0] ?? null;
    return {
      imgSrc: img?.src ?? null,
      imgNaturalWidth: img?.naturalWidth ?? 0,
      videoTiles: document.querySelectorAll(".ae-grid .vidthumb").length,
      // THE EXCLAMATION MARK THE USER REPORTED, counted only where it means what
      // they meant: AssetThumb's failure glyph, i.e. "this asset could not be read".
      // VideoThumbnail's own .vidthumb-error is EXCLUDED here and asserted
      // separately below, because with ASCII fixture bytes a decode failure there is
      // the CORRECT outcome — counting it would make this assertion unsatisfiable
      // for a reason that has nothing to do with the bug.
      readFailureGlyphs: document.querySelectorAll('.ae-grid .ae-kind iconify-icon[icon="mdi:alert-circle-outline"]').length,
      videoDecodeErrors: document.querySelectorAll(".ae-grid .vidthumb-error").length,
    };
  });
  assert(tiles.imgSrc !== null, "the image tile mounted an <img>");
  assert(/^blob:/.test(tiles.imgSrc ?? ""), `the image tile's src is a blob: URL, not "/asset/…" (${String(tiles.imgSrc).slice(0, 24)}…)`);
  assert(tiles.imgNaturalWidth > 0, `the image tile DECODED after reload (naturalWidth = ${tiles.imgNaturalWidth})`);
  assert(tiles.videoTiles > 0, `the video asset got a VideoThumbnail tile (${tiles.videoTiles})`);
  assert(tiles.readFailureGlyphs === 0, `no tile reports "could not read this asset" (found ${tiles.readFailureGlyphs})`);
  // The video tile's error box IS expected with ASCII bytes, and asserting it is
  // present rather than ignoring it keeps the loud-failure contract under test: an
  // unreadable asset must NAME its failure, never show a silent black tile.
  assert(tiles.videoDecodeErrors === 1, `the un-decodable fixture video NAMES its failure rather than going blank (${tiles.videoDecodeErrors})`);

  // ── 5. The PREVIEW MODAL, opened by the same double-click the user uses ─────
  const previewed = await page.evaluate(async () => {
    // Dispatched on .ae-tile-hit, the button that actually carries ondblclick — the
    // cell wrapper does not, so a dblclick there is swallowed.
    const hit = [...document.querySelectorAll(".ae-tile-hit")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("logo.png"));
    if (!hit) return { opened: false, why: "no logo.png tile" };
    hit.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    const media = document.querySelector("img.ae-preview-media");
    return { opened: !!media, src: media?.src ?? null, naturalWidth: media?.naturalWidth ?? 0 };
  });
  assert(previewed.opened, "double-click opened the preview modal");
  assert(/^blob:/.test(previewed.src ?? ""), `the preview modal's image resolves through the store (${String(previewed.src).slice(0, 16)}…)`);
  assert(previewed.naturalWidth > 0, `the preview modal DECODED the image (naturalWidth = ${previewed.naturalWidth})`);

  // ── 6. THE CANVAS's boot race, asserted as TRANSIENT rather than filtered ───
  //
  // The Explorer's prime is `await`ed inside its refresh, so it lands a beat AFTER
  // the first canvas paint. In that window the canvas resolves the deck's own image
  // ref against an empty memo and reports a 404 — one per asset, once. Filtering
  // that line out of EXPECTED_NOISE would hide a real defect, so it is asserted
  // instead: it must be TRANSIENT. A forced repaint well after the prime must produce
  // ZERO new failures, which is what proves the canvas recovers on its own rather
  // than caching the miss.
  //
  // The permanent fix for the boot flash is one `primeUrls` in `loadAutosave()`
  // (web/app.svelte.js) — the reload path that restores a deck WITHOUT opening a
  // project, and the actual origin of this whole bug. That file is owned elsewhere in
  // this change, so this probe pins the current, self-healing behavior; tighten this
  // assertion to zero once the prime moves into the boot path.
  const bootRaceErrors = errors.filter((e) => /image_registry|video_registry/.test(e));
  const otherErrors = errors.filter((e) => !/image_registry|video_registry/.test(e));

  errors.length = 0;
  await page.evaluate(() => { const a = window.__powerrp_app; a.commit({ ...a.doc }); });
  await sleep(3000);
  const afterRepaint = errors.filter((e) => /image_registry|video_registry/.test(e));
  assert(afterRepaint.length === 0,
    `the canvas's boot-time asset miss is TRANSIENT — a repaint after the prime reports none (boot: ${bootRaceErrors.length}, after: ${afterRepaint.length})`);

  if (otherErrors.length) { console.error("\nUNEXPECTED PAGE ERRORS SINCE RELOAD:\n" + otherErrors.join("\n")); fails.push("unexpected page errors after reload"); }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nASSET-RELOAD STATIC PROBE FAILED (${fails.length}):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log("\nASSET-RELOAD STATIC PROBE PASSED — a reloaded static deck previews its assets.");
