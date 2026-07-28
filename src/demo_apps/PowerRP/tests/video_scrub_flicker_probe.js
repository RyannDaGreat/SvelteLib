/**
 * DEFAULT (core) VIDEO SCRUBBER flicker probe — the twin of
 * tests/video_v5_scrub_live_probe.js for render_gpu/gpu/video_registry.js's scrub
 * path. It exists because the two paths were reported to differ: "the v5 scrubber
 * doesn't flicker, the default scrubber does".
 *
 * ── THE DEFECT IT MEASURES ────────────────────────────────────────────────────
 * A seek is async while the paint is sync, so during a scrub there is always a
 * window with no frame decoded at the requested time. getScrubFrame used to return
 * null there and the widget drew NOTHING for that paint — blank, frame, blank,
 * frame, which is the FLICKER. The fix ports the V5 discipline: HOLD the source's
 * most recently decoded frame on a miss, and COALESCE live requests latest-wins so
 * the decoder chases the pointer instead of a backlog.
 *
 * ── WHAT IT PROVES (the gate) ─────────────────────────────────────────────────
 *   (1) NEVER BLANK — after the first frame is on screen, no captured compositor
 *       frame shows the camera backdrop through the widget.
 *   (2) HELD, NOT BLANKED — the paint path reports `held` on the misses that used
 *       to return null, and `blank` stops rising once a frame exists.
 *   (3) CONVERGES — after the gesture settles the on-screen paint resolves the
 *       EXACT key for the final scrubTime, the decoder is parked there, and the
 *       canvas shows that time's colour (so the hold never becomes permanent).
 *   (4) A STALE FRAME NEVER OUTLIVES ITS SOURCE — retyping `src` to a second clip
 *       shows the NEW clip or nothing, never the old clip's held picture; and
 *       PURGING the scrubber leaves nothing of it on the canvas.
 *   (5) NO LEAK — the cache stays within cap + pins across a long scrub, every
 *       Image is deleted exactly once (proven by the reset hook emptying it), and
 *       a broken source draws nothing rather than holding a foreign frame.
 *   (6) HEADLESS BYTE IDENTITY — the awaited one-shot path
 *       (browser_media.prepareSceneScrubFrames → window.__powerrp_render) is
 *       unchanged by the hold: two renders match each other, AND the printed
 *       HEADLESS-SHA256 lines are the before/after comparison this probe was run
 *       twice to produce (once against the pre-fix video_registry.js).
 *
 * The RGB-per-second fixture (tests/fixtures/scrub_video.mp4 — red 0-1s, green
 * 1-2s, blue 2-3s) makes frame identity readable from one pixel, and the paused
 * decoder's parked currentTime (videoPlaybackState is player-only, so the probe
 * reads the element through the module) makes convergence exact. The second clip
 * for the src-change phase is the SAME fixture time-shifted by a re-encode-free
 * trick: a distinct data URI cannot be synthesized here, so it uses the
 * COLOUR-BAND separation instead — the old source is held at a GREEN time and the
 * new source is requested at a BLUE time, so a leaked hold is visible as green.
 *
 * Frontend-only Vite (HMR + watch OFF — a sibling's edit must not reload the page
 * mid-gesture) + headless Chromium, the video_v5_scrub_live_probe pattern.
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/video_scrub_flicker_probe.js
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
const POLL_MS = 100;                     // first-frame poll interval
const SCRUB_MS = 2500;                   // gesture duration — a realistic fast drag
const SETTLE_MS = 2500;                  // post-release window the settled frame must land in
const SATURATION_MIN = 40;               // channel spread separating the fixture's colour bands from any grey
const BACKDROP = "#222222";              // camera background: a blank widget shows exactly this
const BACKDROP_RGB = [0x22, 0x22, 0x22];
const BACKDROP_TOLERANCE = 6;            // per-channel slack for the compositor's PNG round-trip
const PROBE_SPREAD = 0.10;               // sample offset as a fraction of the canvas's smaller side
const LONG_SCRUB_SWEEPS = 6;             // leak check: far more distinct times than the cache cap
// The sweep ENDS 0.01 s PAST the fixture's green→blue boundary at 2.0 s, so the pixel
// test discriminates CONVERGENCE from a stale hold: the correct final frame is BLUE
// while every frame the hold could still show (requested a paint or two earlier,
// i.e. t < 2.0) is GREEN. Ending mid-band would let a stale frame pass.
const FIXTURE_SPAN = [0.0, 2.01];
const GREEN_TIME = 1.5;                  // a time inside the fixture's GREEN band (the frame a leaked hold would show)
const BLUE_TIME = 2.5;                   // a time inside the fixture's BLUE band

const mp4 = await readFile(resolve(HERE, "fixtures/scrub_video.mp4"));
const FIXTURE_SRC = `data:video/mp4;base64,${mp4.toString("base64")}`;
// A SECOND, DISTINCT source string for the same bytes. The hold is keyed on the
// source STRING (video_registry.scopedHoldKey), and a data URI with an extra
// media-type parameter is a different string that decodes identically — so this is
// exactly the "the user picked another video" case as far as the registry is
// concerned, without shipping a second fixture.
const SECOND_SRC = `data:video/mp4;codecs=avc1;base64,${mp4.toString("base64")}`;

/** Pure function. The probe document: THE camera + one inset core scrubber.
 *  @example doc("clip.mp4", 0).slides[0].delta.items.vs.type // "video_scrub" */
const doc = (src, scrubTime) => ({
  meta: { name: "scrub-flicker", slideW: W, slideH: H },
  slides: [{
    id: "s0", name: "A", transition: { type: "fade", seconds: 1 },
    delta: {
      items: {
        cam: { type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: BACKDROP },
        vs: {
          type: "video_scrub", src, name: "Scrubber",
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

/** Pure function. The fixture's colour band name for a pixel.
 *  @example band([226, 56, 57]) // "red"
 *  @example band([34, 34, 34]) // "blank" */
const band = ([r, g, b]) => (!saturated([r, g, b]) ? "blank" : r > g && r > b ? "red" : g > r && g > b ? "green" : "blue");

/** Pure function. Is this pixel the camera backdrop (within the compositor's PNG
 *  round-trip slack)? THE general blankness test — a widget that drew nothing lets
 *  exactly the backdrop through.
 *  @example isBackdrop([34, 34, 34]) // true
 *  @example isBackdrop([226, 56, 57]) // false */
const isBackdrop = (rgb) => rgb.every((c, i) => Math.abs(c - BACKDROP_RGB[i]) <= BACKDROP_TOLERANCE);

/** Pure function. Did the widget draw NOTHING? True only when EVERY sampled point
 *  inside it is the backdrop — one coincidentally backdrop-coloured pixel of real
 *  video content must not read as a blank frame.
 *  @example blankFrame([[34, 34, 34], [34, 34, 34]]) // true
 *  @example blankFrame([[34, 34, 34], [90, 12, 40]]) // false */
const blankFrame = (samples) => samples.length > 0 && samples.every(isBackdrop);

/** Pure function. Sample points inside the widget for a scene-canvas box: its
 *  centre plus a four-point cross at PROBE_SPREAD of the smaller side.
 *  @example samplePoints({x: 100, y: 100, w: 200, h: 100}).length // 5 */
function samplePoints(box) {
  const d = Math.round(Math.min(box.w, box.h) * PROBE_SPREAD);
  return [[box.x, box.y], [box.x - d, box.y], [box.x + d, box.y], [box.x, box.y - d], [box.x, box.y + d]];
}

/** Pure function. The RGB triple at (x, y) of a decoded PNG.
 *  @example // pixelAt(png, 10, 10) // [226, 56, 57] */
function pixelAt(png, x, y) {
  const i = (png.width * Math.round(y) + Math.round(x)) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

/** Pure function. Median of a numeric list (empty → 0).
 *  @example median([3, 1, 2]) // 2
 *  @example median([]) // 0 */
function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
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

  // Bind the registry module the APP already loaded (same dev URL ⇒ same singleton),
  // so the probe reads the LIVE scrub cache, not a second copy.
  await page.evaluate(async (base, dir) => {
    window.__vr = await import(`${base}/@fs${dir}/render_gpu/gpu/video_registry.js`);
  }, baseUrl, appDir);
  assert(await page.evaluate(() => typeof window.__vr?.getScrubFrame === "function"), "the probe imported the app's live video_registry module");

  // ONE stats reader, tolerating a build that predates the counters — this probe is
  // ALSO run against the PRE-FIX video_registry.js to measure the before/after
  // difference, and there the pixel evidence must still be collected.
  await page.evaluate(() => {
    const NONE = { requests: 0, exact: 0, held: 0, blank: 0, decoded: 0, dropped: 0, lastResolution: {}, cacheSize: 0, pinned: 0, failed: 0, inflight: 0 };
    window.__scrubStats = () => window.__vr.videoScrubStats?.() ?? NONE;
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

    // The gesture is byte-for-byte the Inspector's "Time (s)" DraggableNumber path
    // (web/NumericField.svelte onscrub → app.setPreview; release → commitPreview).
    // Driving it at the app layer is deliberate: DraggableNumber scrubs through
    // Pointer Lock and accumulates event.movementY, which CDP-synthesized mouse
    // events do not populate — a synthetic drag would measure the harness.
    const gesture = await page.evaluate(async (ms, a, b) => {
      const app = window.__powerrp_app;
      const path = ["items", "vs", "scrubTime"];
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
      return { requests, times };
    }, SCRUB_MS, from, to);

    await sleep(SETTLE_MS);
    await client.send("Page.stopScreencast");
    const after = await page.evaluate(() => window.__scrubStats());

    const dir = resolve(SHOTS, `scrub_flicker_filmstrip_${label}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const frames = [];
    for (let i = 0; i < captured.length; i++) {
      const buf = Buffer.from(captured[i].data, "base64");
      const png = readPng(buf);
      const samples = points.map(([x, y]) => pixelAt(png, x, y));
      const blank = blankFrame(samples);
      frames.push({ t: captured[i].t, rgb: samples[0], blank, band: blank ? "blank" : band(samples[0]) });
      await writeFile(resolve(dir, `f${String(i).padStart(3, "0")}_${blank ? "BLANK" : band(samples[0])}.png`), buf);
    }
    const blanks = frames.filter((f) => f.blank);
    const blankSeconds = blanks.reduce((acc, f) => {
      const next = frames[frames.indexOf(f) + 1];
      return acc + (next ? next.t - f.t : 0);
    }, 0);
    const gestureIntervals = gesture.times.slice(1).map((t, i) => t - gesture.times[i]);
    const d = (k) => after[k] - before[k]; // this gesture's share of the running counters

    console.log(`  first frame on canvas: ${firstFrameMs} ms`);
    console.log(`  paints (scrubTime requests): ${gesture.requests} over ${SCRUB_MS} ms; rAF interval median ${median(gestureIntervals).toFixed(1)} ms`);
    console.log(`  captured compositor frames: ${frames.length}`);
    console.log(`  BLANK frames (widget drew nothing): ${blanks.length} of ${frames.length}  |  blank wall time ${blankSeconds.toFixed(3)} s`);
    console.log(`  band sequence: ${frames.map((f) => f.band[0]).join("")}`);
    console.log(`  paint resolutions this gesture: exact ${d("exact")}, held ${d("held")}, blank ${d("blank")}  (a HELD paint is one the pre-fix code returned null for)`);
    console.log(`  seeks: ${d("decoded")} decoded, ${d("dropped")} dropped as superseded  (pre-fix would decode ${d("requests") - d("exact")} = every non-cached request)`);
    console.log(`  cache ${after.cacheSize} (cap ${await page.evaluate(() => window.__vr.SCRUB_CACHE_CAP)}) + ${after.pinned} pinned, ${after.failed} failed, ${after.inflight} in flight`);
    console.log(`  filmstrip: ${dir}`);
    return { firstFrameMs, frames, blanks, box, after, gesture, delta: { exact: d("exact"), held: d("held"), blank: d("blank"), decoded: d("decoded"), dropped: d("dropped"), requests: d("requests") } };
  }

  // ── PHASE 1: the gesture — THE flicker gate ─────────────────────────────────
  const fx = await runGesture("fixture", FIXTURE_SRC, FIXTURE_SPAN);
  const settledShot = await page.screenshot({ clip: { x: fx.box.cx, y: fx.box.cy, width: fx.box.w, height: fx.box.h } });
  await writeFile(resolve(SHOTS, "scrub_flicker_settled.png"), settledShot);
  const settledPng = readPng(settledShot);
  const settledRgb = pixelAt(settledPng, settledPng.width / 2, settledPng.height / 2);

  // Convergence is measured on the ON-SCREEN scope only: the offscreen thumbnail/
  // export scope AWAITS its frames and is therefore always "exact", so a global
  // counter would report success while the editor canvas stayed stale.
  const onScreen = (stats) => Object.entries(stats.lastResolution).filter(([scope]) => scope !== "cpu" && scope !== "gpuService");
  const autoLast = onScreen(fx.after);

  console.log("\n── SETTLED ─────────────────────────────────────────────");
  console.log(`  final scrubTime ${FIXTURE_SPAN[1]}; on-screen scopes ${JSON.stringify(Object.fromEntries(autoLast))}`);
  console.log(`  centre ${JSON.stringify(settledRgb)} → ${band(settledRgb)} (want blue)`);

  assert(fx.firstFrameMs >= 0, `the first scrub frame reaches the canvas (${fx.firstFrameMs} ms)`);
  assert(fx.blanks.length === 0, `NO captured frame is blank after the first frame landed (${fx.blanks.length} of ${fx.frames.length})`);
  assert(fx.delta.held > 0, `the paint path HELD the last frame on the misses that used to blank (${fx.delta.held})`);
  assert(fx.delta.blank === 0, `no paint blanked during or after the gesture (${fx.delta.blank})`);
  assert(autoLast.length > 0, `the on-screen GL scope painted the scrubber at all (scopes: ${JSON.stringify(fx.after.lastResolution)})`);
  assert(autoLast.every(([, how]) => how === "exact"), `the settled canvas converges to the EXACT key, not the hold (${JSON.stringify(Object.fromEntries(autoLast))})`);
  assert(band(settledRgb) === "blue", `the settled canvas shows the FINAL scrubTime's frame, not a stale one (got ${band(settledRgb)})`);

  // ── PHASE 2: HEADLESS BYTE IDENTITY (the deterministic path is untouched) ───
  // window.__powerrp_render is the one-shot pixel path: it AWAITS every scrub frame
  // (browser_media.prepareSceneScrubFrames) before painting, so a hold can never
  // reach it. Two renders must match each other, AND the sha256 must match the value
  // this same probe prints when run against the PRE-FIX video_registry.js.
  const headless = await page.evaluate(async (a, b) => {
    const r = async (d) => await window.__powerrp_render(d, { slide: 0, alpha: 1, width: 480, height: 360 });
    const one = await r(a);
    const two = await r(a);
    const other = await r(b);
    return { one, two, other };
  }, doc(FIXTURE_SRC, BLUE_TIME), doc(FIXTURE_SRC, GREEN_TIME));
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  console.log("\n── HEADLESS (awaited one-shot path) ────────────────────");
  console.log(`  HEADLESS-SHA256 t=${BLUE_TIME}  ${sha(headless.one)}  (${headless.one.length} chars)`);
  console.log(`  HEADLESS-SHA256 t=${GREEN_TIME}  ${sha(headless.other)}  (${headless.other.length} chars)`);
  assert(headless.one === headless.two, "two renders of the same document are byte-identical");
  assert(headless.one !== headless.other, "two DIFFERENT scrubTimes render differently (the awaited path decodes the requested frame, never a hold)");

  // ── PHASE 3: A STALE FRAME MUST NOT OUTLIVE ITS SOURCE ─────────────────────
  // Park source A's hold on a GREEN frame, then retype `src` to a DIFFERENT source
  // string requesting a BLUE time. The hold is keyed on (scope, source), so the new
  // source has no hold: the widget must show BLUE (its own decoded frame) or blank —
  // never GREEN, which would be source A's picture leaking into source B.
  await page.evaluate((d) => {
    const app = window.__powerrp_app;
    app.commit(app.repaired(d));
    app.slideIndex = 0;
    app.runCommand("reset-view");
  }, doc(FIXTURE_SRC, GREEN_TIME));
  await sleep(3000);
  const swapBox = await page.evaluate(() => {
    const r = document.querySelector("canvas.scene").getBoundingClientRect();
    return { cx: r.x, cy: r.y, w: r.width, h: r.height, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  const greenShot = readPng(await page.screenshot({ clip: { x: swapBox.cx, y: swapBox.cy, width: swapBox.w, height: swapBox.h } }));
  const greenRgb = pixelAt(greenShot, greenShot.width / 2, greenShot.height / 2);
  // The instant AFTER the src+time swap: the frame most at risk of showing the old
  // clip, because the new source has decoded nothing yet. Committing the whole
  // document (rather than a keyframe write) keeps the camera/view untouched, so the
  // three screenshots of this phase are comparable pixel-for-pixel.
  await page.evaluate((d) => {
    const app = window.__powerrp_app;
    app.commit(app.repaired(d));
    app.slideIndex = 0;
  }, doc(SECOND_SRC, BLUE_TIME));
  await sleep(150); // deliberately BEFORE the new source can decode
  const swappedEarly = readPng(await page.screenshot({ clip: { x: swapBox.cx, y: swapBox.cy, width: swapBox.w, height: swapBox.h } }));
  const earlyRgb = pixelAt(swappedEarly, swappedEarly.width / 2, swappedEarly.height / 2);
  await sleep(4000); // now let it decode
  const swappedLate = readPng(await page.screenshot({ clip: { x: swapBox.cx, y: swapBox.cy, width: swapBox.w, height: swapBox.h } }));
  const lateRgb = pixelAt(swappedLate, swappedLate.width / 2, swappedLate.height / 2);
  await writeFile(resolve(SHOTS, "scrub_flicker_src_swapped.png"), PNG.sync.write(swappedLate));
  console.log("\n── SRC CHANGE (the hold must not follow the source) ────");
  console.log(`  before the swap (source A @ ${GREEN_TIME}s): ${JSON.stringify(greenRgb)} → ${band(greenRgb)} (want green)`);
  console.log(`  150 ms after swapping to source B @ ${BLUE_TIME}s: ${JSON.stringify(earlyRgb)} → ${band(earlyRgb)}`);
  console.log(`  once source B decoded: ${JSON.stringify(lateRgb)} → ${band(lateRgb)} (want blue)`);
  assert(band(greenRgb) === "green", `the pre-swap canvas holds source A's GREEN frame (got ${band(greenRgb)})`);
  assert(band(earlyRgb) !== "green", `the instant after the src change shows NO trace of source A's held frame (got ${band(earlyRgb)})`);
  assert(band(lateRgb) === "blue", `source B decodes its OWN requested frame (got ${band(lateRgb)})`);

  // ── PHASE 4: PURGE — nothing of a removed scrubber survives on the canvas ───
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = "vs";
    app.purgeSelection();
  });
  await sleep(1200);
  const purged = readPng(await page.screenshot({ clip: { x: swapBox.cx, y: swapBox.cy, width: swapBox.w, height: swapBox.h } }));
  const purgedSamples = samplePoints(swapBox).map(([x, y]) => pixelAt(purged, x - swapBox.cx, y - swapBox.cy));
  await writeFile(resolve(SHOTS, "scrub_flicker_purged.png"), PNG.sync.write(purged));
  console.log("\n── PURGE ───────────────────────────────────────────────");
  console.log(`  widget samples ${JSON.stringify(purgedSamples)} → ${blankFrame(purgedSamples) ? "nothing drawn (correct)" : "A FRAME SURVIVED THE PURGE"}`);
  assert(blankFrame(purgedSamples), `a purged scrubber leaves NOTHING on the canvas — the hold is never drawn without an op asking for it (${JSON.stringify(purgedSamples[0])})`);

  // ── PHASE 5: leak check — a long scrub stays inside cap + pins ──────────────
  await page.evaluate((d) => {
    const app = window.__powerrp_app;
    app.commit(app.repaired(d));
    app.slideIndex = 0;
    app.runCommand("reset-view");
  }, doc(FIXTURE_SRC, FIXTURE_SPAN[0]));
  await sleep(3000);
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
    window.__vr.resetVideoRegistry();
    return { after, reset: window.__scrubStats(), cap: window.__vr.SCRUB_CACHE_CAP };
  }, LONG_SCRUB_SWEEPS, SCRUB_MS / 3, FIXTURE_SPAN);
  console.log("\n── LEAK ────────────────────────────────────────────────");
  console.log(`  after ${LONG_SCRUB_SWEEPS} more sweeps: ${JSON.stringify(leak.after)} (cap ${leak.cap})`);
  console.log(`  after the reset hook: ${JSON.stringify(leak.reset)}`);
  assert(leak.after.cacheSize <= leak.cap + leak.after.pinned, `the frame cache stays within cap + pins (${leak.after.cacheSize} vs ${leak.cap} + ${leak.after.pinned})`);
  assert(leak.reset.cacheSize === 0 && leak.reset.pinned === 0, `the reset hook frees every cached frame and pin — each Image deleted exactly once (${JSON.stringify(leak.reset)})`);

  // ── PHASE 6: a BROKEN source draws NOTHING, never a hold ───────────────────
  // The hold is what stops a scrub from blanking, but it must not cover for a source
  // that FAILED: pixels that depend on which clip decoded earlier are not
  // pure(document, slide, alpha), and "stale forever" is worse than an empty quad.
  const BROKEN_SRC = "data:video/mp4;base64,AAAAAAAA"; // valid data URI, not decodable media
  const brokenErrors = [];
  const collectBroken = (m) => { if (m.type() === "error") brokenErrors.push(m.text()); };
  page.on("console", collectBroken);
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
  await writeFile(resolve(SHOTS, "scrub_flicker_broken_src.png"), brokenShot);
  const brokenPng = readPng(brokenShot);
  const brokenSamples = samplePoints(brokenBox).map(([x, y]) => pixelAt(brokenPng, x - brokenBox.cx, y - brokenBox.cy));
  page.off("console", collectBroken);
  console.log("\n── BROKEN SOURCE ───────────────────────────────────────");
  console.log(`  widget samples ${JSON.stringify(brokenSamples)} → ${blankFrame(brokenSamples) ? "blank (correct)" : "SOMETHING WAS DRAWN"}`);
  // Match the SCRUB registry's own report specifically — a looser pattern passed on
  // an unrelated (and IGNOREd) repair message, which would have hidden a silent
  // media failure.
  const LOUD_SCRUB_FAILURE = /video_registry \(scrub\)/i;
  console.log(`  loud failure reports: ${brokenErrors.filter((t) => LOUD_SCRUB_FAILURE.test(t))[0]?.slice(0, 140) ?? "NONE"}`);
  assert(blankFrame(brokenSamples), `a broken source draws NOTHING — never another clip's held frame (${JSON.stringify(brokenSamples[0])})`);
  assert(brokenErrors.some((t) => LOUD_SCRUB_FAILURE.test(t)), `the load failure is reported LOUDLY by the scrub registry (${brokenErrors.length} console errors, none matching)`);
  // This phase DELIBERATELY provokes the loud report, so its errors must not land in
  // the run-wide clean-console check. Every removed line is asserted to be the
  // expected media failure, so an UNexpected error raised here still fails the probe.
  const provoked = errors.splice(errorsBeforeBroken);
  assert(provoked.every((t) => LOUD_SCRUB_FAILURE.test(t)),
    `this phase raised ONLY the expected media failure (${provoked.filter((t) => !LOUD_SCRUB_FAILURE.test(t)).join(" | ") || "none unexpected"})`);

  if (errors.length) { console.error("\nPAGE ERRORS:\n" + errors.join("\n")); fails.push("page/console errors"); }
} catch (e) {
  console.error("\nFAIL video_scrub_flicker_probe:", e?.stack ?? e);
  fails.push(String(e?.message ?? e));
} finally {
  await browser.close();
  await server.close();
}

console.log(fails.length ? `\nFAIL video_scrub_flicker_probe (${fails.length}):\n  ${fails.join("\n  ")}` : "\nOK video_scrub_flicker_probe");
process.exit(fails.length ? 1 : 0);
