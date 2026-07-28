/**
 * VIDEO V5 SCRUBBER live-GESTURE probe — the evidence the V5 scrubber shipped
 * WITHOUT: it proves what the widget shows DURING a fast scrub, not just what a
 * one-shot render produces.
 *
 * The reported defect ("the frames disappear when I scrub … the scrubber is
 * janky") is a per-PAINT property of a live gesture, so this probe drives the
 * REAL editor gesture and samples REAL pixels throughout it:
 *
 *   GESTURE — a rAF-paced sweep of `scrubTime` through app.setPreview(...) +
 *     app.commitPreview() at release. That is byte-for-byte the code path the
 *     Inspector's "Time (s)" DraggableNumber runs per pointermove
 *     (web/NumericField.svelte onscrub → app.setPreview; commit → commitPreview).
 *     Driving it at the app layer instead of through synthetic mouse deltas is
 *     deliberate: DraggableNumber scrubs through the Pointer Lock API and
 *     accumulates event.movementY, which CDP-synthesized mouse events do not
 *     populate — a synthetic drag would measure the harness, not the widget.
 *
 *   PIXELS — a CDP screencast (Page.startScreencast) captures the compositor's
 *     real frames for the whole gesture. Every frame's widget-centre pixel is
 *     classified: SATURATED (a decoded video frame is on screen) vs the camera
 *     backdrop (#222222 — the widget drew NOTHING). Blank frames and the wall
 *     time spent blank are counted from those pixels, and every captured frame is
 *     written to .claude_vlm_checks/v5_scrub_filmstrip_<label>/ as a filmstrip.
 *
 * The RGB-per-second fixture (tests/fixtures/scrub_video.mp4 — red 0–1s, green
 * 1–2s, blue 2–3s) makes the frame identity readable from one pixel, and the
 * paused decoder's parked currentTime (videoV5ScrubState) makes it exact.
 *
 * ASSERTS (on the committed fixture — the gate)
 *   (1) NEVER BLANK — after the first frame is on screen, no captured frame shows
 *       the backdrop through the widget (the hold-last-frame contract).
 *   (2) CONVERGES — once the gesture settles, the paint resolves the EXACT key for
 *       the final scrubTime (not the held frame), the decoder is parked at that
 *       time, and the on-screen colour is the final time's colour.
 *   (3) BYTE-IDENTICAL — two renders of the settled document produce identical
 *       PNG bytes (pure(document, slide, alpha) survives the hold).
 *   (4) NO LEAK — the frame cache stays within its cap (+ its pins) across a long
 *       scrub and returns to empty after the documented reset hook.
 *
 * HEAVY PHASE (measurement, not a gate). The committed fixture is 96x72, which
 * decodes faster than one paint — so it cannot show what latest-wins coalescing is
 * for. If a realistic-resolution clip is available (argv[2], else the largest
 * projects/*​/assets/*.mp4 in this working copy) the same gesture runs against it
 * and reports requests vs decodes vs dropped, plus the BACKLOG DRAIN: how long
 * after release the decoder keeps working. That phase is SKIPPED LOUDLY when no
 * such clip exists, so the probe still runs on a clean checkout.
 *
 * Frontend-only Vite (HMR + watch OFF — sibling edits must not reload the page
 * mid-gesture) + headless Chromium, the paintfield/demo_widget probe pattern.
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/video_v5_scrub_live_probe.js [heavy-clip.mp4]
 */
import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { PNG } from "pngjs";
// puppeteer ≥23 returns screenshot bytes as a Uint8Array; pngjs demands a real
// Buffer (readUInt32BE). One adapter, used by every decode below.
const readPng = (bytes) => PNG.sync.read(Buffer.from(bytes));

const HERE = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(HERE, "..");
const webRoot = resolve(appDir, "web");
const SHOTS = resolve(appDir, ".claude_vlm_checks");

const W = 480, H = 360;                  // camera (slide) size in world units
const WIDGET_INSET = 60;                 // widget margin inside the camera, so the backdrop frames it
const BOOT_MS = 4000;                    // Skia wasm + fonts + first paint
const FIRST_FRAME_TIMEOUT_MS = 20000;    // decoder load + warm-up seek + first real frame
const POLL_MS = 100;                     // first-frame / drain poll interval
const SCRUB_MS = 2500;                   // gesture duration — a realistic fast drag
const SETTLE_MS = 2500;                  // post-release window the settled frame must land in
const DRAIN_TIMEOUT_MS = 60000;          // give up waiting for the decode backlog to stop growing
const SATURATION_MIN = 40;               // max-min channel spread that separates the fixture's colour bands from any grey
const BACKDROP = "#222222";              // camera background: a blank widget shows exactly this
const BACKDROP_RGB = [0x22, 0x22, 0x22];
const BACKDROP_TOLERANCE = 6;            // per-channel slack for the compositor's PNG round-trip
const PROBE_SPREAD = 0.10;               // sample offset as a fraction of the canvas's smaller side (well inside the widget)
const LONG_SCRUB_SWEEPS = 6;             // leak check: repeated sweeps, far more distinct times than the cache cap
// The sweep ENDS 0.01 s PAST the fixture's green→blue boundary at 2.0 s. That makes
// the pixel test discriminate CONVERGENCE from a stale hold: the correct final frame
// is BLUE, while every frame the hold could still be showing (requested a paint or two
// earlier, i.e. t < 2.0) is GREEN. Ending mid-band would let a stale frame pass.
const FIXTURE_SPAN = [0.0, 2.01];

const mp4 = await readFile(resolve(HERE, "fixtures/scrub_video.mp4"));
const FIXTURE_SRC = `data:video/mp4;base64,${mp4.toString("base64")}`;

/** Query (reads the working copy). The heaviest local clip to stress the coalescer
 *  with: argv[2] if given, else the LARGEST projects/​*​/assets/*.mp4 (file size is a
 *  good proxy for decode cost), else null → the heavy phase is skipped loudly. */
async function findHeavyClip() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const projects = resolve(appDir, "projects");
  let best = null;
  const dirs = await readdir(projects, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const assets = join(projects, d.name, "assets");
    for (const f of await readdir(assets).catch(() => [])) {
      if (!f.toLowerCase().endsWith(".mp4")) continue;
      const p = join(assets, f);
      const size = (await stat(p)).size;
      if (!best || size > best.size) best = { path: p, size };
    }
  }
  return best?.path ?? null;
}

/** Pure function. The probe document: THE camera + one inset V5 scrubber on `src`.
 *  @example doc("clip.mp4", 0).slides[0].delta.items.vs.type // "video_v5_scrub" */
const doc = (src, scrubTime) => ({
  meta: { name: "v5-scrub-live", slideW: W, slideH: H },
  slides: [{
    id: "s0", name: "A", transition: { type: "fade", seconds: 1 },
    delta: {
      items: {
        cam: { type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: BACKDROP },
        vs: {
          type: "video_v5_scrub", src, name: "Scrubber",
          x: WIDGET_INSET, y: WIDGET_INSET, w: W - 2 * WIDGET_INSET, h: H - 2 * WIDGET_INSET,
          z: 1, rotation: 0, scale: 1, active: true, scrubTime, scrubWrap: "clamp",
        },
      },
      vars: {},
    },
  }],
});

/** Pure function. Is this pixel a decoded video frame (a saturated colour) rather
 *  than any grey backdrop?
 *  @example saturated([226, 56, 57]) // true
 *  @example saturated([34, 34, 34]) // false */
const saturated = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > SATURATION_MIN;

/** Pure function. The fixture's colour band name for a saturated pixel.
 *  @example band([226, 56, 57]) // "red"
 *  @example band([56, 104, 225]) // "blue"
 *  @example band([34, 34, 34]) // "blank" */
const band = ([r, g, b]) => (!saturated([r, g, b]) ? "blank" : r > g && r > b ? "red" : g > r && g > b ? "green" : "blue");

/** Pure function. Median of a numeric list (empty → 0).
 *  @example median([3, 1, 2]) // 2
 *  @example median([]) // 0 */
function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Pure function. The p-quantile of a numeric list (empty → 0).
 *  @example quantile([1, 2, 3, 4], 0.5) // 3
 *  @example quantile([], 0.95) // 0 */
function quantile(xs, p) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Pure function. The RGB triple at (x, y) of a decoded PNG.
 *  @example // pixelAt(png, 10, 10) // [226, 56, 57] */
function pixelAt(png, x, y) {
  const i = (png.width * Math.round(y) + Math.round(x)) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

/** Pure function. Is this pixel the camera backdrop (within the compositor's PNG
 *  round-trip slack)? THE general blankness test: a widget that drew nothing lets
 *  exactly the backdrop through, whatever the clip's own colours are — unlike
 *  `saturated`, which only works for the flat-colour fixture.
 *  @example isBackdrop([34, 34, 34]) // true
 *  @example isBackdrop([226, 56, 57]) // false */
const isBackdrop = (rgb) => rgb.every((c, i) => Math.abs(c - BACKDROP_RGB[i]) <= BACKDROP_TOLERANCE);

/** Pure function. Did the widget draw NOTHING? True only when EVERY sampled point
 *  inside it is the backdrop — one coincidentally backdrop-coloured pixel of real
 *  video content must not read as a blank frame.
 *  @example blankFrame([[34, 34, 34], [34, 34, 34]]) // true
 *  @example blankFrame([[34, 34, 34], [90, 12, 40]]) // false */
const blankFrame = (samples) => samples.length > 0 && samples.every(isBackdrop);

/** Pure function. The sample points inside the widget for a scene-canvas box: its
 *  centre plus a four-point cross at PROBE_SPREAD of the smaller side. The camera is
 *  zoom-to-fitted and the widget covers its central 75%, so every point lands inside
 *  the widget.
 *  @example samplePoints({x: 100, y: 100, w: 200, h: 100}).length // 5 */
function samplePoints(box) {
  const d = Math.round(Math.min(box.w, box.h) * PROBE_SPREAD);
  return [[box.x, box.y], [box.x - d, box.y], [box.x + d, box.y], [box.x, box.y - d], [box.x, box.y + d]];
}

const heavyClip = await findHeavyClip();

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // HMR + watch OFF: a sibling's edit must never reload the page mid-gesture.
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|WebGPU|repair:/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(BOOT_MS);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Bind the V5 module the APP already loaded (same dev URL ⇒ same singleton
  // registry), so the probe reads the live scrub cache/decoder, not a second copy.
  await page.evaluate(async (base, dir) => {
    window.__v5 = await import(`${base}/@fs${dir}/render_gpu/skia/video_v5.js`);
  }, baseUrl, appDir);
  assert(await page.evaluate(() => typeof window.__v5?.getVideoV5ScrubFrame === "function"), "the probe imported the app's live video_v5 module");

  // ONE stats reader, tolerating a build that predates the counters — this probe is
  // also run against the COMMITTED video_v5.js to measure the before/after difference,
  // and there the pixel evidence must still be collected.
  await page.evaluate(() => {
    const NONE = { requests: 0, exact: 0, held: 0, blank: 0, decoded: 0, dropped: 0, lastResolution: {}, decodedByScope: {}, cacheSize: 0, pinned: 0, failed: 0, inflight: 0 };
    window.__scrubStats = () => window.__v5.videoV5ScrubStats?.() ?? NONE;
  });

  // A DECODER-REPOSITION COUNTER THAT DOES NOT TRUST THE MODULE. Hooking element
  // creation counts `seeked` events from OUTSIDE the code under test, so the same
  // measurement works against any version of video_v5.js — which is what makes a
  // before/after comparison meaningful. Player elements never seek, so every event
  // here is a scrub. Installed before the doc loads, since the elements are created
  // lazily on first paint.
  //
  // WHAT IT DOES AND DOES NOT COUNT: a REPOSITION, not a request. seekV5 resolves
  // immediately when assigning currentTime leaves `el.seeking` false — i.e. when the
  // requested time falls on the frame the decoder is already parked at — and such a
  // request fires no `seeked` event while still costing a createImageBitmap and a
  // texture upload. So this number is a floor on decoder work, not the request count;
  // the request→decode ratio comes from the module's own counters.
  await page.evaluate(() => {
    window.__seeks = [];
    const create = document.createElement.bind(document);
    document.createElement = (tag, ...rest) => {
      const el = create(tag, ...rest);
      if (String(tag).toLowerCase() === "video") el.addEventListener("seeked", () => window.__seeks.push(performance.now()));
      return el;
    };
  });

  /** Command (async). Loads `src` into the probe doc, waits for the FIRST decoded
   *  frame to reach the canvas, then runs the gesture under a CDP screencast and
   *  returns the per-frame pixel classification + counters. */
  async function runGesture(label, src, [from, to]) {
    console.log(`\n══ ${label} ══`);
    await page.evaluate((d) => {
      const app = window.__powerrp_app;
      app.commit(app.repaired(d));
      app.slideIndex = 0;
      app.runCommand("reset-view"); // zoom-to-fit THE camera so the widget occupies a known box
    }, doc(src, from));
    await sleep(500);

    const box = await page.evaluate(() => {
      const r = document.querySelector("canvas.scene").getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), cx: r.x, cy: r.y, w: r.width, h: r.height };
    });
    const points = samplePoints(box);
    /** Query (async). The widget's sample points from a fresh screenshot of the scene canvas. */
    const sampleNow = async () => {
      const shot = await page.screenshot({ clip: { x: box.cx, y: box.cy, width: box.w, height: box.h } });
      const png = readPng(shot);
      return points.map(([x, y]) => pixelAt(png, x - box.cx, y - box.cy));
    };

    // Before ANY frame has decoded there is nothing to hold, so drawing nothing is
    // the honest async contract; the never-blank claim starts from here.
    let firstFrameMs = -1;
    const t0 = Date.now();
    for (let i = 0; i * POLL_MS < FIRST_FRAME_TIMEOUT_MS; i++) {
      if (!blankFrame(await sampleNow())) { firstFrameMs = Date.now() - t0; break; }
      await sleep(POLL_MS);
    }

    const before = await page.evaluate(() => window.__scrubStats());
    const client = await page.createCDPSession();
    const captured = [];
    client.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
      captured.push({ data, t: metadata.timestamp });
      await client.send("Page.screencastFrameAck", { sessionId }).catch((e) => console.warn("screencastFrameAck:", e.message));
    });
    await client.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 1280, maxHeight: 800 });

    const gesture = await page.evaluate(async (ms, a, b) => {
      const app = window.__powerrp_app;
      const path = ["items", "vs", "scrubTime"];
      window.__seeks.length = 0; // count only THIS gesture's seeks
      const start = performance.now();
      const times = [];
      let requests = 0;
      await new Promise((done) => {
        const step = () => {
          const k = Math.min(1, (performance.now() - start) / ms);
          app.setPreview([[path, a + (b - a) * k]]);
          requests += 1;
          times.push(performance.now());
          if (k >= 1) { app.commitPreview(); done(); return; }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      return { requests, times, releasedAt: performance.now() };
    }, SCRUB_MS, from, to);

    // BACKLOG DRAIN: how long after release the EDITOR's decoder keeps decoding. A
    // path that seeks every requested time drains for as long as its queue is deep; a
    // latest-wins path finishes the one outstanding frame and stops. Counted for the
    // on-screen GL scope only — the offscreen thumbnail/export scope decodes on its own
    // schedule and would otherwise keep this counter moving forever.
    const drain = await page.evaluate(async (pollMs, timeoutMs) => {
      const glDecodes = () => {
        const by = window.__scrubStats().decodedByScope;
        return Object.entries(by).filter(([s]) => s !== "cpu" && s !== "gpuService").reduce((a, [, n]) => a + n, 0);
      };
      const t = performance.now();
      let last = glDecodes();
      let stableSince = performance.now();
      while (performance.now() - t < timeoutMs) {
        await new Promise((r) => setTimeout(r, pollMs));
        const now = glDecodes();
        if (now !== last) { last = now; stableSince = performance.now(); }
        else if (performance.now() - stableSince > 3 * pollMs) break;
      }
      return { ms: Math.max(0, stableSince - t), decodedAtEnd: last };
    }, POLL_MS, DRAIN_TIMEOUT_MS);
    // The same two numbers from the module-independent `seeked` log: how many real
    // seeks this gesture cost, and how long after release the last one landed.
    const seeks = await page.evaluate((releasedAt) => ({
      total: window.__seeks.length,
      duringGesture: window.__seeks.filter((t) => t <= releasedAt).length,
      afterRelease: window.__seeks.filter((t) => t > releasedAt).length,
      lastAfterReleaseMs: window.__seeks.length && window.__seeks[window.__seeks.length - 1] > releasedAt
        ? window.__seeks[window.__seeks.length - 1] - releasedAt : 0,
    }), gesture.releasedAt);

    await sleep(SETTLE_MS);
    await client.send("Page.stopScreencast");
    const after = await page.evaluate(() => window.__scrubStats());

    const dir = resolve(SHOTS, `v5_scrub_filmstrip_${label}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const frames = [];
    for (let i = 0; i < captured.length; i++) {
      const buf = Buffer.from(captured[i].data, "base64");
      const png = readPng(buf);
      const samples = points.map(([x, y]) => pixelAt(png, x, y));
      const blank = blankFrame(samples);
      // `band` labels the FIXTURE's flat colour bands (meaningless for real footage,
      // where it just tags the dominant channel) — the blank verdict is `blank`.
      frames.push({ t: captured[i].t, rgb: samples[0], blank, band: blank ? "blank" : band(samples[0]) });
      await writeFile(resolve(dir, `f${String(i).padStart(3, "0")}_${blank ? "BLANK" : band(samples[0])}.png`), buf);
    }
    const blanks = frames.filter((f) => f.blank);
    const blankSeconds = blanks.reduce((acc, f) => {
      const next = frames[frames.indexOf(f) + 1];
      return acc + (next ? next.t - f.t : 0);
    }, 0);
    const intervals = frames.slice(1).map((f, i) => (f.t - frames[i].t) * 1000);
    const gestureIntervals = gesture.times.slice(1).map((t, i) => t - gesture.times[i]);
    const d = (k) => after[k] - before[k]; // this gesture's share of the running counters

    console.log(`  first frame on canvas: ${firstFrameMs} ms`);
    console.log(`  paints (scrubTime requests): ${gesture.requests} over ${SCRUB_MS} ms; rAF interval median ${median(gestureIntervals).toFixed(1)} ms, p95 ${quantile(gestureIntervals, 0.95).toFixed(1)} ms`);
    console.log(`  captured compositor frames: ${frames.length}; interval median ${median(intervals).toFixed(1)} ms, p95 ${quantile(intervals, 0.95).toFixed(1)} ms`);
    console.log(`  BLANK frames (widget drew nothing): ${blanks.length}  |  blank wall time ${blankSeconds.toFixed(3)} s of ${(frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0).toFixed(3)} s`);
    console.log(`  band sequence: ${frames.map((f) => f.band[0]).join("")}`);
    console.log(`  paint resolutions this gesture: exact ${d("exact")}, held ${d("held")}, blank ${d("blank")}  (a HELD paint is one the pre-fix code returned null for)`);
    console.log(`  seeks: ${d("decoded")} decoded, ${d("dropped")} dropped as superseded  (pre-fix would decode ${d("requests") - d("exact")} = every non-cached request)`);
    console.log(`  decoder REPOSITIONS (element "seeked" events — module-independent, a FLOOR on decoder work, not the request count): ${seeks.total} total — ${seeks.duringGesture} during the ${SCRUB_MS} ms gesture, ${seeks.afterRelease} after release, last one +${seeks.lastAfterReleaseMs.toFixed(0)} ms past release`);
    console.log(`  backlog drain after release: ${drain.ms.toFixed(0)} ms (on-screen scope decode counter)`);
    console.log(`  cache ${after.cacheSize} (cap ${await page.evaluate(() => window.__v5.V5_SCRUB_CACHE_CAP)}) + ${after.pinned} pinned, ${after.failed} failed, ${after.inflight} in flight`);
    console.log(`  filmstrip: ${dir}`);
    return { firstFrameMs, frames, blanks, box, after, gesture, drain, seeks, delta: { exact: d("exact"), held: d("held"), blank: d("blank"), decoded: d("decoded"), dropped: d("dropped"), requests: d("requests") } };
  }

  // ── PHASE 1: the committed fixture — the GATE ──────────────────────────────
  const fx = await runGesture("fixture", FIXTURE_SRC, FIXTURE_SPAN);
  const settledShot = await page.screenshot({ clip: { x: fx.box.cx, y: fx.box.cy, width: fx.box.w, height: fx.box.h } });
  await writeFile(resolve(SHOTS, "v5_scrub_settled.png"), settledShot);
  const settledPng = readPng(settledShot);
  const settledRgb = pixelAt(settledPng, settledPng.width / 2, settledPng.height / 2);
  const parked = await page.evaluate((src) => window.__v5.videoV5ScrubState(src)?.currentTime ?? -1, FIXTURE_SRC);

  // ── CONVERGENCE, in two separately reported halves ──────────────────────────
  // Measured on the ON-SCREEN scope only: the offscreen thumbnail/export scope awaits
  // its frames and is therefore always "exact", so a global counter would happily
  // report success while the editor canvas stayed stale.
  //   AUTOMATIC — what the user gets after letting go of the drag: the final decode
  //     must land AND wake a repaint on its own.
  //   AFTER A REPAINT — whether the frame REGISTRY converged, isolated from whatever
  //     wakes the canvas: any subsequent repaint (here a harmless anchors-overlay
  //     toggle, which is a dep of the paint effect and changes no document state)
  //     must resolve the exact key and show the final frame's colour.
  const onScreen = (stats) => Object.entries(stats.lastResolution).filter(([scope]) => scope !== "cpu" && scope !== "gpuService");
  const autoLast = onScreen(fx.after);
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.anchorsVisible = !app.anchorsVisible;
    app.anchorsVisible = !app.anchorsVisible;
  });
  await sleep(500);
  const forced = await page.evaluate(() => window.__scrubStats());
  const forcedLast = onScreen(forced);
  const forcedShot = await page.screenshot({ clip: { x: fx.box.cx, y: fx.box.cy, width: fx.box.w, height: fx.box.h } });
  await writeFile(resolve(SHOTS, "v5_scrub_settled_after_repaint.png"), forcedShot);
  const forcedPng = readPng(forcedShot);
  const forcedRgb = pixelAt(forcedPng, forcedPng.width / 2, forcedPng.height / 2);
  const identical = await page.evaluate(async (d) => {
    const a = await window.__powerrp_render(d, { slide: 0, alpha: 1, width: 480, height: 360 });
    const b = await window.__powerrp_render(d, { slide: 0, alpha: 1, width: 480, height: 360 });
    return { same: a === b, len: a.length };
  }, doc(FIXTURE_SRC, FIXTURE_SPAN[1]));

  console.log("\n── SETTLED (fixture) ───────────────────────────────────");
  console.log(`  final scrubTime ${FIXTURE_SPAN[1]} → decoder parked at ${parked}`);
  console.log(`  AUTOMATIC (right after release): on-screen scopes ${JSON.stringify(Object.fromEntries(autoLast))}, centre ${JSON.stringify(settledRgb)} → ${band(settledRgb)} (want blue)`);
  console.log(`  AFTER A REPAINT: on-screen scopes ${JSON.stringify(Object.fromEntries(forcedLast))}, centre ${JSON.stringify(forcedRgb)} → ${band(forcedRgb)} (want blue)`);
  console.log(`  all uploader scopes: ${JSON.stringify(forced.lastResolution)}  decodes ${JSON.stringify(forced.decodedByScope)}`);
  console.log(`  two renders byte-identical: ${identical.same} (${identical.len} chars)`);

  assert(fx.firstFrameMs >= 0, `the first V5 scrub frame reaches the canvas (${fx.firstFrameMs} ms)`);
  assert(fx.blanks.length === 0, `NO captured frame is blank after the first frame landed (${fx.blanks.length} of ${fx.frames.length})`);
  assert(fx.delta.held > 0, `the paint path HELD the last frame on the misses that used to blank (${fx.delta.held})`);
  assert(fx.delta.blank === 0, `no paint blanked during or after the gesture (${fx.delta.blank})`);
  assert(Math.abs(parked - FIXTURE_SPAN[1]) < 0.2, `the decoder is parked at the final scrubTime (${parked} vs ${FIXTURE_SPAN[1]})`);
  assert(autoLast.length > 0, `the on-screen GL scope painted the scrubber at all (scopes: ${JSON.stringify(fx.after.lastResolution)})`);
  // The frame REGISTRY's own convergence — the half this file owns.
  assert(forcedLast.every(([, how]) => how === "exact"), `after a repaint the ON-SCREEN paint resolves the EXACT key, not the hold (${JSON.stringify(Object.fromEntries(forcedLast))})`);
  assert(band(forcedRgb) === "blue", `after a repaint the canvas shows the FINAL scrubTime's frame, not a stale one (got ${band(forcedRgb)})`);
  // The WAKE half. This fails while web/CanvasView.svelte's repaint wake-set omits
  // "video_v5_scrub": the decode notify()s, the gate drops it, and the canvas keeps
  // the held frame until something else repaints. See the probe's failure message.
  assert(autoLast.every(([, how]) => how === "exact") && band(settledRgb) === "blue",
    `the settled canvas converges WITHOUT an external repaint — needs "video_v5_scrub" in web/CanvasView.svelte's videoSourcesOf(...) repaint wake set (got ${JSON.stringify(Object.fromEntries(autoLast))}, centre ${band(settledRgb)})`);
  assert(identical.same, "two renders of the settled document are byte-identical");

  // ── PHASE 2: leak check — a long scrub must stay inside the cap ─────────────
  const leak = await page.evaluate(async (sweeps, ms, [a, b]) => {
    const app = window.__powerrp_app;
    const path = ["items", "vs", "scrubTime"];
    for (let s = 0; s < sweeps; s++) {
      const start = performance.now();
      await new Promise((done) => {
        const step = () => {
          const k = Math.min(1, (performance.now() - start) / ms);
          app.setPreview([[path, s % 2 === 0 ? a + (b - a) * k : b - (b - a) * k]]);
          if (k >= 1) { done(); return; }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }
    app.commitPreview();
    await new Promise((r) => setTimeout(r, 1500));
    const after = window.__scrubStats();
    window.__v5.resetVideoV5ScrubRegistry();
    return { after, reset: window.__scrubStats(), cap: window.__v5.V5_SCRUB_CACHE_CAP };
  }, LONG_SCRUB_SWEEPS, SCRUB_MS / 3, FIXTURE_SPAN);
  console.log("\n── LEAK ────────────────────────────────────────────────");
  console.log(`  after ${LONG_SCRUB_SWEEPS} more sweeps: ${JSON.stringify(leak.after)} (cap ${leak.cap})`);
  console.log(`  after the reset hook: ${JSON.stringify(leak.reset)}`);
  assert(leak.after.cacheSize <= leak.cap + leak.after.pinned, `the frame cache stays within cap + pins (${leak.after.cacheSize} vs ${leak.cap} + ${leak.after.pinned})`);
  assert(leak.reset.cacheSize === 0 && leak.reset.pinned === 0, `the reset hook frees every cached frame and pin (${JSON.stringify(leak.reset)})`);

  // ── PHASE 3: a BROKEN source must draw NOTHING, never a hold ───────────────
  // The hold is what stops a scrub from blanking, but it must not cover for a source
  // that FAILED: pixels that depend on which clip decoded earlier are not
  // pure(document, slide, alpha), and "stale forever" is worse than an empty quad.
  // A non-decodable src fails at LOAD, which is the guard this exercises. Its
  // console.error is the REQUIRED loud report, so it is expected, not a probe failure.
  const BROKEN_SRC = "data:video/mp4;base64,AAAAAAAA"; // valid data URI, not decodable media
  const brokenErrors = [];
  const collectBroken = (m) => { if (m.type() === "error") brokenErrors.push(m.text()); };
  page.on("console", collectBroken);
  // This phase DELIBERATELY provokes the loud report, so its errors must not land in
  // the run-wide clean-console check. The global list is trimmed back afterwards, and
  // every removed line is asserted to be the expected media-load failure — so an
  // UNexpected error raised during this phase still fails the probe.
  const errorsBeforeBroken = errors.length;
  await page.evaluate((d) => {
    const app = window.__powerrp_app;
    app.commit(app.repaired(d));
    app.slideIndex = 0;
    app.runCommand("reset-view");
  }, doc(BROKEN_SRC, 1.0));
  await sleep(3000);
  const brokenBox = await page.evaluate(() => {
    const r = document.querySelector("canvas.scene").getBoundingClientRect();
    return { cx: r.x, cy: r.y, w: r.width, h: r.height, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  const brokenShot = await page.screenshot({ clip: { x: brokenBox.cx, y: brokenBox.cy, width: brokenBox.w, height: brokenBox.h } });
  await writeFile(resolve(SHOTS, "v5_scrub_broken_src.png"), brokenShot);
  const brokenPng = readPng(brokenShot);
  const brokenSamples = samplePoints(brokenBox).map(([x, y]) => pixelAt(brokenPng, x - brokenBox.cx, y - brokenBox.cy));
  const brokenStats = await page.evaluate(() => window.__scrubStats());
  page.off("console", collectBroken);
  console.log("\n── BROKEN SOURCE ───────────────────────────────────────");
  console.log(`  on-screen scopes ${JSON.stringify(brokenStats.lastResolution)}`);
  console.log(`  widget samples ${JSON.stringify(brokenSamples)} → ${blankFrame(brokenSamples) ? "blank (correct)" : "SOMETHING WAS DRAWN"}`);
  console.log(`  loud failure reports: ${brokenErrors.length ? brokenErrors[0].slice(0, 120) : "NONE"}`);
  assert(blankFrame(brokenSamples), `a broken source draws NOTHING — never another clip's held frame (${JSON.stringify(brokenSamples[0])})`);
  assert(brokenErrors.some((t) => /video_v5.*scrub/i.test(t)), `the load failure is reported LOUDLY (${brokenErrors.length} console errors)`);
  const provoked = errors.splice(errorsBeforeBroken);
  assert(provoked.every((t) => /video_v5.*scrub.*failed to load/i.test(t)),
    `this phase raised ONLY the expected media-load failure (${provoked.filter((t) => !/failed to load/i.test(t)).join(" | ") || "none unexpected"})`);

  // ── PHASE 4: the heavy clip — measurement only ─────────────────────────────
  if (!heavyClip) {
    console.log("\n── HEAVY CLIP: SKIPPED — no projects/*/assets/*.mp4 in this working copy and no path given (argv[2]). Coalescing is unmeasured on a realistic decode cost.");
  } else {
    console.log(`\n── HEAVY CLIP: ${heavyClip} (${((await stat(heavyClip)).size / 1e6).toFixed(1)} MB)`);
    // Served by Vite (fs.allow covers the repo) rather than inlined as a data URI,
    // so a ten-megabyte clip does not go through base64.
    const heavySrc = `${baseUrl}/@fs${encodeURI(heavyClip)}`;
    const hv = await runGesture("heavy", heavySrc, FIXTURE_SPAN);
    assert(hv.firstFrameMs >= 0, `heavy clip: the first frame reaches the canvas (${hv.firstFrameMs} ms)`);
    assert(hv.blanks.length === 0, `heavy clip: NO captured frame is blank (${hv.blanks.length} of ${hv.frames.length})`);
    await writeFile(resolve(SHOTS, "v5_scrub_settled_heavy.png"),
      await page.screenshot({ clip: { x: hv.box.cx, y: hv.box.cy, width: hv.box.w, height: hv.box.h } }));
  }

  if (errors.length) { console.error("\nPAGE ERRORS:\n" + errors.join("\n")); fails.push("page/console errors"); }
} catch (e) {
  console.error("\nFAIL video_v5_scrub_live_probe:", e?.stack ?? e);
  fails.push(String(e?.message ?? e));
} finally {
  await browser.close();
  await server.close();
}

console.log(fails.length ? `\nFAIL video_v5_scrub_live_probe (${fails.length}):\n  ${fails.join("\n  ")}` : "\nOK video_v5_scrub_live_probe");
process.exit(fails.length ? 1 : 0);
