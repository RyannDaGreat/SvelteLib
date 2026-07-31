/**
 * STATIC RENDER PROBE — the in-browser render pipeline, whole, with no server.
 *
 * ── THE RULING UNDER TEST (user) ──────────────────────────────────────────────
 * Looking at the static site's Render Center showing "Encoded by: Upload frames", a
 * pink "Render jobs need the PowerRP project server… use in-page video export
 * instead", and a dead "Submit Render Job — needs a server" button:
 *
 *   "We spent a long time creating an in-browser rendering system. When we're on a
 *    static site, why not just hook up that file system and only have the Browser
 *    option? Why even have the upload-frames option and why force a renderings list
 *    if we could just do it all in the browser? The storage here should be capable
 *    of holding such videos, right?"
 *
 * ── WHY THIS PROBE MUST RUN A REAL RENDER, NOT A MOCK ─────────────────────────
 * Every piece of this already existed and each one INDIVIDUALLY had a test. What was
 * broken was the JOIN: the pipeline could not reach a job record without a server, so
 * a probe that stubbed the record store would assert the exact thing that was already
 * working. So this one goes all the way through — real frame walk, real Skia surface,
 * real wasm H.264 encoder, real IndexedDB write — and then asserts the movie is
 * BYTES ON DISK, not a promise that resolved.
 *
 * ── THE TINY-RENDER BUDGET, AND WHY IT IS THESE NUMBERS ───────────────────────
 * 160x120 at 6 fps over a 1-second timeline, transitions off = 6 frames. Chosen
 * against the encoder's own measurements (web/browserJobView.js: ~6 ms/frame at
 * 320x240), so the encode itself is milliseconds and essentially all of the probe's
 * wall time is boot — the fixed cost every browser probe pays. Six frames is also
 * enough to be a real movie: it crosses no segment boundary (segmentFrames(6) = 12),
 * which is deliberate — resume-across-a-segment is browser_render_resume_probe.js's
 * job, and duplicating it here would double this probe's cost to re-test a covered
 * path. The dimensions are EVEN because H.264 4:2:0 requires it (mp4Encoder throws
 * otherwise) — 160x120 is the smallest even pair that is not degenerate.
 *
 * ── WHAT IS ASSERTED, in the order a user meets it ────────────────────────────
 *   1. NO SERVER-NEEDING CONTROLS. The dead submit button is gone, the pink error is
 *      gone, "Upload frames" is not offered, and "Rendered by" states Browser rather
 *      than offering a choice of one.
 *   2. A REAL RENDER RUNS, through app.submitRender — the same entry point the button
 *      uses — and lands as a `done` job with a non-trivial byte count.
 *   3. THE MOVIE IS AN MP4. The blob's first bytes are checked for the ISO-BMFF
 *      `ftyp` box: a job record saying "done" over a zero-byte or HTML blob is
 *      exactly the silent failure this whole change is about.
 *   4. THE LIST SHOWS IT, with a working Download (an href that resolves to the same
 *      bytes) and a size.
 *   5. RELOAD KEEPS IT. The whole point of using IndexedDB rather than a variable.
 *   6. DELETE REMOVES IT — record AND movie.
 *   7. THE DRAFT KEYING. All of the above happens while the deck is an UNSAVED DRAFT
 *      (a fresh document is one — see save_gesture_static_probe.js), so this probe is
 *      by construction the "~draft/current case must work" assertion.
 *
 * Runs FRONTEND-ONLY under ?static=1 with its own Vite + headless Chromium (the house
 * probe pattern). No backend is started, deliberately: if one were, a regression that
 * reached for the server would still pass.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

// ── THE TINY RENDER (see the header for why these numbers) ──────────────────
const RENDER_WIDTH = 160;
const RENDER_HEIGHT = 120;
const RENDER_FPS = 6;
const RENDER_HOLD_SECONDS = 1; // one slide, one second → 6 frames
const EXPECTED_FRAMES = RENDER_FPS * RENDER_HOLD_SECONDS;
const RENDER_NAME = "Probe take";

/** How long the render may take before the probe calls it hung. Generous against
 *  a ~6 x 6 ms encode: the first frame also compiles shaders and loads the wasm
 *  encoder, and several agents run probes in this tree at once. */
const RENDER_TIMEOUT_MS = 120_000;
const POLL_MS = 250;
/** Skia wasm + fonts + first paint, matching the sibling static probes. */
const BOOT_SETTLE_MS = 3500;

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // hmr/watch off: sibling agents edit this tree, and a stray save mid-render would
  // reload the page and kill the job under test.
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => {
  if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In static mode there is no backend, so every /api/ failure is EXPECTED and is
 *  not what this probe is looking for. A genuine app error still fails the run. */
const EXPECTED_NOISE = /Failed to load resource|listAssets|\/api\/|thumbnail|clipboard|favicon|no WebGPU adapter|WebGPU init failed/i;

/** Command (async). A fresh page on the same origin and profile — so it shares
 *  IndexedDB, which is what makes the reload assertion meaningful. */
async function openPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? "(no stack)"}`));
  page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.goto(`${baseUrl}/?static=1`, { waitUntil: "networkidle0" });
  await sleep(BOOT_SETTLE_MS);
  return page;
}

/** Query (async). What the Render Center's DOM says — read from the rendered
 *  dialog, not from module state, because the ruling is about what the user sees. */
const readDialog = (page) => page.evaluate(() => {
  const text = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent.trim());
  const root = document.querySelector(".render-center");
  return {
    present: Boolean(root),
    bodyText: root ? root.textContent : "",
    buttons: [...(root?.querySelectorAll("button") ?? [])].map((b) => ({
      label: b.textContent.trim(),
      disabled: b.disabled,
    })),
    errors: text(".render-center .render-center-error"),
    // A "stated, not chosen" setting renders as .render-center-fixed; a real
    // picker renders a Dropdown trigger inside .render-center-control.
    fixed: text(".render-center .render-center-fixed"),
    dropdownTriggers: [...(root?.querySelectorAll(".render-center-control .dd") ?? [])].length,
    rows: [...(root?.querySelectorAll(".render-center-job") ?? [])].map((j) => ({
      name: j.querySelector(".render-center-job-name")?.textContent.trim() ?? "",
      status: j.querySelector(".render-center-job-status")?.textContent.trim() ?? "",
      downloadHref: j.querySelector(".render-center-job-actions a")?.getAttribute("href") ?? null,
      downloadName: j.querySelector(".render-center-job-actions a")?.getAttribute("download") ?? null,
      meta: [...j.querySelectorAll(".render-center-meta span")].map((s) => s.textContent.trim()),
    })),
  };
});

/** Command (async). Open the Render Center via the SAME command the toolbar and
 *  palette run — not by setting a flag, so the command wiring is under test too. */
const openRenderCenter = async (page) => {
  await page.evaluate(() => window.__powerrp_app.runCommand("render-center"));
  await sleep(600);
};

/** Query (async). Every rendering stored under the OPEN deck's project key,
 *  straight from the module — the storage-level truth behind the rows. */
const storedRenderings = (page) => page.evaluate(async () => {
  const { listRenderJobs } = await import("/@fs" + window.__powerrp_probeRoot + "/web/localRenderStore.js");
  return listRenderJobs(window.__powerrp_app.projectName());
});

let page = null;
try {
  page = await openPage();
  // The probe needs absolute /@fs imports of the app's own modules; the page must
  // be told where the tree is.
  await page.evaluate((root) => { window.__powerrp_probeRoot = root; }, resolve(HERE, ".."));
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  const mode = await page.evaluate(() => window.__powerrp_storage.storageMode());
  assert(mode === "local", `?static=1 boots into LOCAL storage (got ${mode}) — everything below is about that mode`);

  // ── 0. THE KEYING, stated as the invariant it actually is ─────────────────
  // THE RULE: a rendering is keyed by whatever `app.projectName()` answers — the
  // SAME string the asset store keys blobs under. That is one sentence with no
  // special cases, and it is what makes "a draft's renders live with the draft"
  // true for free rather than by a second mechanism.
  //
  // TWO KINDS OF DRAFT, and the difference matters here. A FRESH document is an
  // unsaved draft whose projectName() is its display name ("Untitled"); an
  // IMPORTED one (a .zip or a share link) additionally has `draftMode` set, and
  // projectName() then answers the reserved DRAFT_KEY. The probe asserts the rule
  // against BOTH, because a keying that only followed one of them would strand the
  // other's renders silently.
  const isDraft = await page.evaluate(() => window.__powerrp_app.isDraft());
  assert(isDraft === true, "a fresh deck is an UNSAVED DRAFT — nothing below has been through the library");
  const keys = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const fresh = app.projectName();
    const { DRAFT_KEY } = await import("/@fs" + window.__powerrp_probeRoot + "/web/projectDraft.js");
    return { fresh, DRAFT_KEY, draftMode: app.draftMode };
  });
  assert(
    keys.draftMode === null && keys.fresh === "Untitled",
    `a FRESH draft keys under its display name (draftMode=${JSON.stringify(keys.draftMode)}, key=${JSON.stringify(keys.fresh)})`,
  );
  assert(
    keys.DRAFT_KEY.startsWith("~draft/"),
    `an IMPORTED draft would key under the reserved draft key (${JSON.stringify(keys.DRAFT_KEY)}) — the same projectName() seam, no second rule`,
  );

  // ── 1. NO SERVER-NEEDING CONTROLS ─────────────────────────────────────────
  await openRenderCenter(page);
  const d0 = await readDialog(page);
  assert(d0.present, "the Render Center opens in static mode");
  assert(!/needs a server/i.test(d0.bodyText), "THE DEAD BUTTON IS GONE: nothing in the dialog says 'needs a server'");
  assert(
    !d0.errors.some((e) => /Render jobs need the PowerRP project server/i.test(e)),
    "THE PINK ERROR IS GONE: the renderings list no longer asks a server it does not have",
  );
  assert(!/Upload frames/i.test(d0.bodyText), "'Upload frames' is NOT OFFERED — it is a transport to a server, not a slower option");
  assert(
    d0.fixed.some((t) => /^Browser$/.test(t)),
    `'Rendered by' is STATED as Browser, not offered as a one-item picker (fixed values seen: ${JSON.stringify(d0.fixed)})`,
  );
  assert(
    d0.fixed.some((t) => /Encode in page/i.test(t)),
    `'Encoded by' states the in-page encoder (fixed values seen: ${JSON.stringify(d0.fixed)})`,
  );
  const renderBtn = d0.buttons.find((b) => /^Render$/.test(b.label));
  assert(Boolean(renderBtn), `there is a button labelled exactly "Render" (buttons: ${JSON.stringify(d0.buttons.map((b) => b.label))})`);
  assert(renderBtn && !renderBtn.disabled, "…and it is LIVE — this is the whole defect, in one assertion");

  // ── 2. A REAL RENDER, through the real entry point ────────────────────────
  // app.submitRender is what the button calls. Driving it directly (rather than
  // clicking) lets the probe pin the tiny geometry without typing into the form —
  // the form's own wiring is asserted in step 1 and by the settings node test.
  const submitted = await page.evaluate(async (o) => {
    const job = await window.__powerrp_app.submitRender({
      name: o.name,
      backend: "client",
      encoder: "wasm",
      params: {
        width: o.width, height: o.height, fps: o.fps, crf: 30, samples: 1,
        startIndex: 0, endIndex: 0, includeTransitions: false,
        holdSeconds: o.hold, background: "#000000",
      },
    });
    return { id: job.id, state: job.state, framesTotal: job.framesTotal, storage: job.storage };
  }, { name: RENDER_NAME, width: RENDER_WIDTH, height: RENDER_HEIGHT, fps: RENDER_FPS, hold: RENDER_HOLD_SECONDS });

  assert(Boolean(submitted.id), "submitRender returns a job with an id — a RECORD exists, with no server involved");
  assert(submitted.storage === "browser", `…and it is marked as living in browser storage (got ${JSON.stringify(submitted.storage)})`);
  assert(
    submitted.framesTotal === EXPECTED_FRAMES,
    `the tiny render is ${EXPECTED_FRAMES} frames (${RENDER_FPS} fps x ${RENDER_HOLD_SECONDS}s), got ${submitted.framesTotal}`,
  );

  // Wait for the frame walk + encode + IndexedDB write.
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let finished = null;
  for (;;) {
    const [job] = (await storedRenderings(page)).filter((j) => j.id === submitted.id);
    if (job && job.state !== "rendering") { finished = job; break; }
    if (Date.now() > deadline) {
      finished = job ?? null;
      break;
    }
    await sleep(POLL_MS);
  }
  assert(Boolean(finished), "the rendering record is still there when the render ends");
  assert(
    finished?.state === "done",
    `the render FINISHES (state=${finished?.state}${finished?.error ? `, error=${finished.error}` : ""})`,
  );
  assert(finished?.framesDone === EXPECTED_FRAMES, `all ${EXPECTED_FRAMES} frames were encoded (got ${finished?.framesDone})`);
  assert(finished?.bytes > 0, `the stored movie has BYTES (got ${finished?.bytes}) — a 'done' record over an empty blob is the silent failure this exists to catch`);

  // ── 3. IT IS AN MP4, not just "a blob that exists" ────────────────────────
  const sniff = await page.evaluate(async (jobId) => {
    const { renderingBlob } = await import("/@fs" + window.__powerrp_probeRoot + "/web/localRenderStore.js");
    const blob = await renderingBlob(window.__powerrp_app.projectName(), jobId);
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    return { size: blob.size, type: blob.type, head: [...head] };
  }, submitted.id);
  // ISO base media file format: bytes 4..7 of the first box are the ASCII "ftyp".
  const ftyp = String.fromCharCode(...sniff.head.slice(4, 8));
  assert(ftyp === "ftyp", `the stored bytes are an ISO-BMFF/MP4 file (box type at offset 4 is ${JSON.stringify(ftyp)}, expected "ftyp")`);
  assert(sniff.type === "video/mp4", `…stored with the right MIME type (got ${JSON.stringify(sniff.type)})`);
  assert(sniff.size === finished?.bytes, "…and the record's byte count matches the blob it describes");

  // ── 4. THE LIST SHOWS IT, with a working Download ─────────────────────────
  await sleep(1500); // one poll cycle, so the row appears and its URL is minted
  const d1 = await readDialog(page);
  const row = d1.rows.find((r) => r.name === RENDER_NAME);
  assert(Boolean(row), `the renderings list shows the finished render (rows: ${JSON.stringify(d1.rows.map((r) => r.name))})`);
  assert(/Finished/i.test(row?.status ?? ""), `…as finished (status: ${JSON.stringify(row?.status)})`);
  assert(
    (row?.downloadHref ?? "").startsWith("blob:"),
    `…with a Download whose href is a blob: URL minted from browser storage (got ${JSON.stringify(row?.downloadHref)})`,
  );
  assert(row?.downloadName === `${RENDER_NAME}.mp4`, `…and a filename the user's player will open (got ${JSON.stringify(row?.downloadName)})`);
  assert(
    (row?.meta ?? []).some((m) => /\d/.test(m) && /B$/.test(m)),
    `…and a human-readable size from fileSize.js (meta: ${JSON.stringify(row?.meta)})`,
  );
  // The Download href must resolve to the SAME bytes — a blob: URL that has been
  // revoked, or points at a different blob, is a button that silently does nothing.
  const fetched = await page.evaluate(async (href) => {
    const res = await fetch(href);
    return { ok: res.ok, size: (await res.blob()).size };
  }, row.downloadHref);
  assert(fetched.ok && fetched.size === finished.bytes, `the Download href really serves the movie (${fetched.size} of ${finished.bytes} bytes)`);

  // ── 5. RELOAD KEEPS IT ────────────────────────────────────────────────────
  // The entire reason this is IndexedDB and not a variable. A new page on the same
  // profile is exactly what closing and reopening a tab does.
  await page.close();
  page = await openPage();
  await page.evaluate((root) => { window.__powerrp_probeRoot = root; }, resolve(HERE, ".."));
  const afterReload = await storedRenderings(page);
  const survivor = afterReload.find((j) => j.id === submitted.id);
  assert(Boolean(survivor), "AFTER A RELOAD the rendering is still in browser storage — it lives with the draft, like the draft's assets");
  assert(survivor?.bytes === finished.bytes, "…with its movie intact, byte count unchanged");
  await openRenderCenter(page);
  await sleep(1500);
  const d2 = await readDialog(page);
  assert(d2.rows.some((r) => r.name === RENDER_NAME), "…and the reopened Render Center lists it");
  assert(
    !d2.errors.some((e) => /needs the PowerRP project server/i.test(e)),
    "…with no server error on the second visit either",
  );

  // ── 6. DELETE REMOVES IT ──────────────────────────────────────────────────
  const deleted = await page.evaluate(async (jobId) => {
    const { deleteRenderJob, listRenderJobs } = await import("/@fs" + window.__powerrp_probeRoot + "/web/localRenderStore.js");
    const key = window.__powerrp_app.projectName();
    await deleteRenderJob(key, jobId);
    return (await listRenderJobs(key)).map((j) => j.id);
  }, submitted.id);
  assert(!deleted.includes(submitted.id), "DELETE removes the rendering and its movie from browser storage");

  const blobGone = await page.evaluate(async (jobId) => {
    const { renderingBlob } = await import("/@fs" + window.__powerrp_probeRoot + "/web/localRenderStore.js");
    try {
      await renderingBlob(window.__powerrp_app.projectName(), jobId);
      return "still there";
    } catch (e) {
      return String(e.message);
    }
  }, submitted.id);
  assert(/no rendering/i.test(blobGone), `…and asking for its bytes now fails LOUDLY (got: ${blobGone})`);

  // ── 7. THE ~draft/current CASE, EXPLICITLY ────────────────────────────────
  // The screenshot in the ruling was of a deck open as an IMPORTED draft, whose
  // projectName() is the reserved key rather than a display name. Everything above
  // ran against a FRESH draft, so this repeats the load-bearing half — render,
  // store, list — with the app in that state. It is a separate step and not the
  // whole probe again because what differs is exactly one string: the key.
  const draftRender = await page.evaluate(async (o) => {
    const app = window.__powerrp_app;
    const { DRAFT_KEY } = await import("/@fs" + window.__powerrp_probeRoot + "/web/projectDraft.js");
    const { listRenderJobs } = await import("/@fs" + window.__powerrp_probeRoot + "/web/localRenderStore.js");
    // Put the app into imported-draft mode the way openDraftFromZipBytes leaves it.
    app.draftMode = { name: "Shared deck", sourceUrl: "https://example.invalid/deck.zip" };
    const key = app.projectName();
    const job = await app.submitRender({
      name: o.name, backend: "client", encoder: "wasm",
      params: {
        width: o.width, height: o.height, fps: o.fps, crf: 30, samples: 1,
        startIndex: 0, endIndex: 0, includeTransitions: false,
        holdSeconds: o.hold, background: "#000000",
      },
    });
    return { key, DRAFT_KEY, id: job.id, listedNow: (await listRenderJobs(key)).map((j) => j.id) };
  }, { name: "Draft take", width: RENDER_WIDTH, height: RENDER_HEIGHT, fps: RENDER_FPS, hold: RENDER_HOLD_SECONDS });

  assert(draftRender.key === draftRender.DRAFT_KEY, `an imported draft renders under the reserved key (got ${JSON.stringify(draftRender.key)})`);
  assert(
    draftRender.listedNow.includes(draftRender.id),
    "…and its rendering is listed under that key immediately — the ~draft/current case in the ruling's screenshot",
  );

  // Let it finish so the movie really lands under the draft key, not just the record.
  const draftDeadline = Date.now() + RENDER_TIMEOUT_MS;
  let draftJob = null;
  for (;;) {
    const [j] = (await page.evaluate(async (id) => {
      const { listRenderJobs } = await import("/@fs" + window.__powerrp_probeRoot + "/web/localRenderStore.js");
      return (await listRenderJobs(window.__powerrp_app.projectName())).filter((x) => x.id === id);
    }, draftRender.id));
    if (j && j.state !== "rendering") { draftJob = j; break; }
    if (Date.now() > draftDeadline) { draftJob = j ?? null; break; }
    await sleep(POLL_MS);
  }
  assert(draftJob?.state === "done", `…and it renders to completion under the draft key (state=${draftJob?.state}${draftJob?.error ? `, ${draftJob.error}` : ""})`);
  assert(draftJob?.bytes > 0, `…producing a real movie (${draftJob?.bytes} bytes)`);

  if (errors.length) {
    fails.push(`page errors: ${errors.join(" | ")}`);
    console.log(`  FAIL page errors:\n    ${errors.join("\n    ")}`);
  }
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

console.log(fails.length === 0 ? "\nstatic_render_probe: all passed" : `\nstatic_render_probe: ${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
