/**
 * STATIC-MODE CANVAS-SRC PROBE — the ref must reach THE RENDERER as a LOADABLE
 * URL, not merely be resolvable by the store if someone thinks to ask.
 *
 * WHY THIS EXISTS ALONGSIDE relative_ref_static_probe.js, WHICH ALREADY PASSED.
 * That probe asserts the STORE can resolve the ref (`assetStore().resolveUrl(...)`
 * → a blob: URL) and it was green throughout the failure it was written to catch.
 * The measured bug lived one step further downstream, in the gap between those two
 * facts: the Asset Explorer's tiles call resolveUrl and drew fine, while the CANVAS
 * never did — the derived node's `src` reached
 * render_gpu/gpu/video_registry.js as the dead "/asset/RobotSim/Video_….mp4" that
 * no server answers in static mode. The browser reported that as
 * "MediaError code 4: Format error", so a MISSING file masqueraded as a CORRUPT
 * one, which is the worst diagnostic available. A store-level assertion cannot see
 * any of that. THE THING THAT MUST BE TRUE IS ABOUT THE NODE, so this probe asserts
 * on the node.
 *
 * The permanent claims, one per media kind the registries consume:
 *   1. STATIC: a RELATIVE ref derives to a `blob:` URL — the canvas gets bytes.
 *   2. STATIC: an OWN-PROJECT ABSOLUTE ref does too. This is the half that was
 *      still broken after the first fix attempt: every document written before the
 *      relative grammar holds absolute refs, and the guard deciding whether a
 *      resolver may rewrite them keyed on the ARGUMENT SHAPE (`typeof project ===
 *      "function"`) while all six production callers pass a project NAME — so the
 *      resolver was never consulted and those decks stayed blank.
 *   3. STATIC: an ABSENT ref derives to the LOUD sentinel, never a dead /asset/
 *      path. A missing asset must look missing.
 *   4. STATIC: a non-ref src (https:, data:) is passed through byte-identically.
 *   5. HTTP-MODE REGRESSION: with no resolver installed, a relative ref still
 *      derives to the ABSOLUTE "/asset/<project>/…" form and NOTHING becomes a
 *      blob. The static fix must not touch the server deployment.
 *
 * Kinds are swept from the REGISTRY (every plugin with an asset-ref prop), not
 * from a hand-listed set, so a widget added later is covered the day it declares
 * a `kind: "asset"` row rather than the day someone remembers this file.
 *
 * Spawns its OWN isolated Vite + headless Chromium (house probe pattern),
 * FRONTEND-ONLY: ?static=1 must need no backend — that is the deployment under test.
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
const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const fails = [];
const errors = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The asset filename every case in this probe points at. */
const ASSET = "clip.mp4";
/** Recognizable bytes — the probe cares that they round-trip, not that they decode. */
const ASSET_BYTES = "CANVAS-SRC-PROBE-BYTES";
/** The sentinel web/assetStore.js mints for a ref it has never heard of. */
const MISSING = "data:,powerrp-missing-asset";

// The Vite dev root is web/, so a bare "/core/…" URL does not resolve — core/ and
// plugins/ sit ABOVE it. Vite serves files outside its root under the /@fs/
// prefix, which is how a probe reaches a module the app itself only imports
// relatively. Built here (node knows the paths) and passed into the page.
const fsUrl = (rel) => `/@fs${resolve(HERE, "..", rel)}`;
const PLUGINS_URL = fsUrl("plugins/index.js");
const ASSET_REF_URL = fsUrl("core/asset_ref.js");
// web/ IS the Vite root, so this one is addressable normally — and it must be,
// because /@fs/ would load a SECOND module instance whose installed resolver the
// app cannot see.
const STORAGE_MODE_URL = "/storageMode.js";

/**
 * Pure function. Archive bytes for a one-slide deck holding ONE video whose src is
 * `src`, in the real export layout (root folder = project name, doc.json at its
 * top, assets/ beneath).
 *
 * @param {string} project - the project/folder name
 * @param {string} src - the video item's stored src
 * @returns {Uint8Array}
 *
 * @example // buildZip("Deck", "clip.mp4") → bytes whose doc.json holds a relative ref
 */
function buildZip(project, src) {
  const doc = {
    meta: { name: project, slideW: 1920, slideH: 1080 },
    slides: [{
      id: "s0", name: "One", transition: { type: "tween", seconds: 0.5 },
      delta: { items: {
        cam: { type: "camera", x: 0, y: 0, w: 1920, h: 1080, z: -1e6 },
        vid: { type: "video", src, x: 100, y: 100, w: 640, h: 360, z: 1 },
      } },
    }],
  };
  return zipSync({ [project]: {
    "doc.json": new TextEncoder().encode(JSON.stringify(doc)),
    assets: { [ASSET]: new TextEncoder().encode(ASSET_BYTES) },
  } });
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // EXPECTED-LOUDNESS ALLOWLIST. Three families here are the probe's own fixtures
  // working correctly, and silencing them would silence the feature:
  //   • "not in local storage" — case 3 asks for a ref that genuinely is absent.
  //   • "MediaError code 4" / DEMUXER — the fixture asset is the ASCII string
  //     ASSET_BYTES, not a real MP4, so the decoder rightly refuses it. Seeing
  //     this proves the blob URL was DELIVERED and opened; a resolution failure
  //     would instead show a dead /asset/ path, which the assertions above forbid.
  //   • "repair: item … filled with plugin defaults" — the hand-written minimal
  //     doc omits optional properties on purpose; repair filling them is correct.
  //   • "refusing to load the missing-asset sentinel" — THE PROBE ASKS FOR THIS.
  //     Case 3 deliberately points a widget at an absent ref, and the assertion
  //     directly above requires the resolver to return the missing sentinel
  //     rather than a dead /asset/ path. ensureImage/ensureVideo then refuse the
  //     sentinel and say so once — the loud-report-then-degrade contract working
  //     end to end. This list already whitelisted the OTHER consequences of the
  //     same case ("not in local storage"); the sentinel refusal is newer than
  //     the list (it arrived with the video_registry sentinel work), so the probe
  //     was failing itself for the log line its own fixture provokes.
  // Everything else still fails the probe.
  page.on("console", (m) => {
    const t = m.text();
    const expected = /not in local storage|refusing to load the missing-asset sentinel|MediaError code 4|DEMUXER_ERROR|MEDIA_ELEMENT_ERROR|VideoThumbnail: video failed to load|PowerRP repair: item|Failed to load resource|\/api\/|listAssets|no WebGPU adapter|VideoV7|ECONNREFUSED|404/i;
    if (m.type() === "error" && !expected.test(t)) errors.push(`console: ${t}`);
  });

  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 30000 });
  await sleep(1200);
  assert(await page.evaluate(() => window.__powerrp_storage.isStatic()), "static mode is active (no backend needed)");

  await page.evaluate((bytes) => { window.__probe_zip = new Uint8Array(bytes); }, Array.from(buildZip("CanvasSrc", ASSET)));
  const imported = await page.evaluate(async () => {
    const res = await window.__powerrp_app.importProjectZip(new File([window.__probe_zip], "CanvasSrc.zip", { type: "application/zip" }));
    return res.name;
  });
  await sleep(900);
  assert(!!imported, `imported the deck as "${imported}"`);

  /**
   * Set the video item's src to `src`, then report what the DERIVED node carries —
   * i.e. exactly the string the media registries would load. This is the whole
   * question the probe exists to ask.
   */
  const derivedFor = (src) => page.evaluate(async (value) => {
    const app = window.__powerrp_app;
    const slide = app.doc.slides[0];
    const items = slide.delta.items;
    const vidId = Object.keys(items).find((id) => items[id].type === "video");
    app.commit({ ...app.doc, slides: [{ ...slide, delta: { ...slide.delta, items: { ...items, [vidId]: { ...items[vidId], src: value } } } }] });
    const node = app.nodes().find((n) => n.itemId === vidId);
    return { derived: node ? String(node.state.src) : null, project: app.projectName() };
  }, src);

  // ── 1. RELATIVE → blob: ────────────────────────────────────────────────────
  const rel = await derivedFor(ASSET);
  assert(rel.derived?.startsWith("blob:"),
    `STATIC: a RELATIVE ref reaches the canvas as a blob: URL (got ${String(rel.derived).slice(0, 44)}…)`);

  // ── 2. OWN-PROJECT ABSOLUTE → blob: (the half that stayed broken) ──────────
  const abs = await derivedFor(`/asset/${encodeURIComponent(rel.project)}/${ASSET}`);
  assert(abs.derived?.startsWith("blob:"),
    `STATIC: an OWN-PROJECT ABSOLUTE ref does too — every pre-grammar document (got ${String(abs.derived).slice(0, 44)}…)`);
  assert(!abs.derived?.startsWith("/asset/"),
    "STATIC: an absolute ref is NEVER left as a dead /asset/ path (that is the MediaError-code-4 bug)");

  // The bytes behind the resolved URL are the archive's own.
  const served = await page.evaluate(async (u) => (await (await fetch(u)).text()), abs.derived);
  assert(served === ASSET_BYTES, "STATIC: the resolved URL serves the archive's ORIGINAL bytes");

  // ── 3. ABSENT → the LOUD sentinel, never a dead path ───────────────────────
  const gone = await derivedFor("no-such-file.mp4");
  assert(gone.derived === MISSING,
    `STATIC: an ABSENT ref yields the LOUD missing sentinel, not a dead /asset/ path (got ${gone.derived})`);

  // ── 4. NON-REFS pass through untouched ─────────────────────────────────────
  const remote = await derivedFor("https://example.com/a.mp4");
  assert(remote.derived === "https://example.com/a.mp4", "STATIC: a remote https: src passes through byte-identically");
  const inline = await derivedFor("data:video/mp4;base64,AAAA");
  assert(inline.derived === "data:video/mp4;base64,AAAA", "STATIC: a data: src passes through byte-identically");

  // ── 5. EVERY REF-BEARING WIDGET KIND, swept from the registry ──────────────
  // Not a hand-listed set: whatever declares an asset-ref prop is covered, so a
  // widget added later is pinned the day it declares the row. Asserted at the
  // RESOLUTION function (the seam every kind shares) with the SAME resolver the
  // app installed, which is what makes one sweep speak for image/svg/pdf/
  // filmstrip/scrubber alike.
  const sweep = await page.evaluate(async (asset, pluginsUrl, refUrl) => {
    const { allPlugins } = await import(pluginsUrl);
    const { pluginAssetRefProps, resolveStateAssetRefs } = await import(refUrl);
    const project = window.__powerrp_app.projectName();
    const out = [];
    for (const plugin of allPlugins) {
      for (const key of pluginAssetRefProps(plugin)) {
        const rel = resolveStateAssetRefs({ [key]: asset }, [key], project)[key];
        const abs = resolveStateAssetRefs({ [key]: `/asset/${encodeURIComponent(project)}/${asset}` }, [key], project)[key];
        out.push({ type: plugin.type, key, relOk: String(rel).startsWith("blob:"), absOk: String(abs).startsWith("blob:") });
      }
    }
    return out;
  }, ASSET, PLUGINS_URL, ASSET_REF_URL);
  assert(sweep.length >= 10, `swept ${sweep.length} asset-ref props across ${new Set(sweep.map((s) => s.type)).size} widget types`);
  const badRel = sweep.filter((s) => !s.relOk).map((s) => `${s.type}.${s.key}`);
  const badAbs = sweep.filter((s) => !s.absOk).map((s) => `${s.type}.${s.key}`);
  assert(badRel.length === 0, `STATIC: EVERY kind resolves a RELATIVE ref to a blob (bad: ${badRel.join(", ") || "none"})`);
  assert(badAbs.length === 0, `STATIC: EVERY kind resolves an ABSOLUTE ref to a blob (bad: ${badAbs.join(", ") || "none"})`);

  // ── 6. HTTP-MODE REGRESSION: the server deployment is untouched ────────────
  // Uninstall the resolver (what a non-static boot leaves) and re-ask. A relative
  // ref must become the ABSOLUTE served path, and nothing may become a blob.
  const http = await page.evaluate(async (asset, refUrl) => {
    const { setProjectNameResolver, resolveStateAssetRefs } = await import(refUrl);
    const project = window.__powerrp_app.projectName();
    setProjectNameResolver(null); // HTTP mode installs none
    const rel = resolveStateAssetRefs({ src: asset }, ["src"], project).src;
    const foreign = resolveStateAssetRefs({ src: "/asset/Shared/bg.png" }, ["src"], project).src;
    const remote = resolveStateAssetRefs({ src: "https://x.com/a.png" }, ["src"], project).src;
    return { rel, foreign, remote, expected: `/asset/${encodeURIComponent(project)}/${asset}` };
  }, ASSET, ASSET_REF_URL);
  // This case UNINSTALLED the resolver to impersonate an HTTP boot. Leave the page
  // as it was found: anything painting after this (a thumbnail, a repaint) would
  // otherwise resolve against the wrong mode and report a phantom failure.
  await page.evaluate(async (refUrl, factoryUrl) => {
    const { setProjectNameResolver } = await import(refUrl);
    const { staticRefResolverFactory } = await import(factoryUrl);
    setProjectNameResolver(staticRefResolverFactory());
  }, ASSET_REF_URL, STORAGE_MODE_URL);
  assert(http.rel === http.expected, `HTTP MODE: a relative ref still becomes the ABSOLUTE served path (${http.rel})`);
  assert(!http.rel.startsWith("blob:"), "HTTP MODE: nothing becomes a blob: URL — the server deployment is unchanged");
  assert(http.foreign === "/asset/Shared/bg.png", "HTTP MODE: a FOREIGN absolute ref still stands (cross-project borrowing)");
  assert(http.remote === "https://x.com/a.png", "HTTP MODE: a remote src still passes through");

  if (errors.length) { console.error("\nPAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors"); }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nSTATIC CANVAS-SRC PROBE FAILED (${fails.length}):\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log("\nSTATIC CANVAS-SRC PROBE PASSED — every media kind reaches the renderer as a loadable URL, in both modes.");
