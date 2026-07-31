/**
 * FILMSTRIP live probe — the evidence tests/filmstrip_test.js cannot give, because the
 * questions are about PIXELS and about the real app's write path.
 *
 * The filmstrip was rebuilt on the V5 video SCRUB path: each cell is a `videoV5Frame` op
 * at that cell's own time, decoded in the browser, replacing stills fetched from a
 * server endpoint. So the things worth proving here are the ones only a running editor
 * can answer:
 *
 *   (1) FRAMES ARE SOURCED LIVE — with a video src and a span, real decoded video
 *       reaches every cell, with NO server running and NO frame-fetch console error.
 *   (2) THE CELLS SHOW DIFFERENT TIMES — the RGB-per-second fixture (red 0-1s, green
 *       1-2s, blue 2-3s) makes that readable: a 3-frame strip across the whole clip must
 *       show three DIFFERENT colours, which also proves the per-element equations
 *       resolved (they are what set the three times).
 *   (3) THE PICTURES MOVE WITH THE STRIP — the reported defect. The widget is dragged
 *       and the same sample points are re-read: the frames must have travelled with it,
 *       not stayed at the canvas origin.
 *   (4) THE FRAMES ANIMATE — re-timing the span re-decodes every cell, so a filmstrip
 *       is a scrubber array rather than a fixed contact sheet.
 *   (5) PER-FRAME ANCHORS ARE REAL IN THE APP — the derived render node exposes
 *       f{i}<suffix> anchors at world positions inside their own cells.
 *   (6) ONE UNDO UNIT — the Respace command's whole effect is a single undo step,
 *       measured by JSON COMPARE of the document (never reference identity).
 *   (7) PRESERVE ASPECT REALLY LETTERBOXES. The plugin cannot do the fit — emit() never
 *       learns the clip's intrinsic size — so it declares `preserveAspect` on the op and
 *       the PAINTER fits. The op's box is byte-identical either way, so pixels are the
 *       only possible evidence, and only a running browser has them.
 *   (8) PAINT COST — the perforation bands are drawn to real published pitch, which is
 *       a lot of triangles; the op count and paint time are REPORTED (not gated) so the
 *       cost of that fidelity is on the record.
 *
 * Frontend-only Vite (HMR + watch OFF — a sibling's edit must not reload the page
 * mid-probe) + headless Chromium, the video_v5_scrub_live_probe pattern. No project
 * server is started, deliberately: the widget must not need one any more.
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/filmstrip_live_probe.js
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
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

const W = 480, H = 360;              // camera (slide) size in world units
const STRIP_W = 400, STRIP_H = 90;   // the filmstrip's bbox
const STRIP_X = 40, STRIP_Y = 40;    // where it starts (top-left of the camera area)
const DRAG_BY = { x: 30, y: 190 };   // how far the drag-with-the-strip phase moves it
const BOOT_MS = 4000;                // Skia wasm + fonts + first paint
const DECODE_TIMEOUT_MS = 25000;     // all cells decoded (one seek per cell, serialized)
const POLL_MS = 200;
const SETTLE_MS = 1500;
const CLIP_SECONDS = 3;              // the fixture's length
const SATURATION_MIN = 40;           // channel spread separating the fixture's bands from any grey
const BACKDROP = "#222222";
const BACKDROP_RGB = [0x22, 0x22, 0x22];
const BACKDROP_TOLERANCE = 6;
const FRAME_COUNT = 3;               // one cell per fixture colour band
// How far inside a cell's LEFT edge the letterbox probe samples, in world units. It has
// to clear the cell's own grey outline (1 unit) and land inside the bar a 4:3 source
// leaves in these cells: the cells are ~127 x 67, so the fitted picture is ~90 wide and
// each bar is ~18 units. Six units is comfortably inside both bounds.
const LETTERBOX_PROBE_INSET = 6;

const mp4 = await readFile(resolve(HERE, "fixtures/scrub_video.mp4"));
const SRC = `data:video/mp4;base64,${mp4.toString("base64")}`;

/** Pure function. The probe document: THE camera + one filmstrip whose three frames
 *  default-equation their way across the whole clip.
 *  @example doc(0, 3).slides[0].delta.items.fs.type // "filmstrip" */
const doc = (x, y) => ({
  meta: { name: "filmstrip-live", slideW: W, slideH: H },
  slides: [{
    id: "s0", name: "A", transition: { type: "fade", seconds: 1 },
    delta: {
      items: {
        cam: { type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: BACKDROP },
        fs: {
          type: "filmstrip", name: "Strip", src: SRC,
          x, y, w: STRIP_W, h: STRIP_H, z: 1, rotation: 0, scale: 1, active: true,
          videoStart: 0, videoEnd: CLIP_SECONDS,
          // The DEFAULT equations, verbatim — this probe is partly about them resolving.
          frames: [
            ["self.video_start"],
            ["self.video_start + 1 / 3 * (self.video_end - self.video_start)"],
            ["self.video_start + 2 / 3 * (self.video_end - self.video_start)"],
          ],
          perfFamily: "BH", filmColor: "#101010", scrubWrap: "clamp",
        },
      },
      vars: {},
    },
  }],
});

/** Pure function. Is this pixel a decoded video frame (a saturated colour)?
 *  @example saturated([226, 56, 57]) // true
 *  @example saturated([34, 34, 34]) // false */
const saturated = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > SATURATION_MIN;

/** Pure function. The fixture's colour band for a pixel.
 *  @example band([226, 56, 57]) // "red"
 *  @example band([16, 16, 16]) // "none" */
const band = ([r, g, b]) => (!saturated([r, g, b]) ? "none" : r > g && r > b ? "red" : g > r && g > b ? "green" : "blue");

/** Pure function. Is this the camera backdrop (within the PNG round-trip's slack)?
 *  @example isBackdrop([34, 34, 34]) // true */
const isBackdrop = (rgb) => rgb.every((c, i) => Math.abs(c - BACKDROP_RGB[i]) <= BACKDROP_TOLERANCE);

/** Pure function. The RGB triple at (x, y) of a decoded PNG. */
function pixelAt(png, x, y) {
  const i = (png.width * Math.round(y) + Math.round(x)) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // The project-server calls the app shell makes on boot (assets, thumbnails, autosave)
  // are IGNORED — no server is running here on purpose. A FRAMES-endpoint error is NOT
  // ignored: the whole point is that the widget no longer asks for one.
  const IGNORE = /Failed to load resource|thumbnail|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|WebGPU|repair:|clipboard|\/api\/(?!frames)/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(BOOT_MS);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Anchors are DERIVED from a node (core/derive.nodeAnchors world-transforms the
  // plugin's local set); they are not a field on it. Binding the app's OWN copy of that
  // function is what lets this probe read the widget's real geometry instead of
  // re-deriving the layout, which is the thing under test.
  await page.evaluate(async (base, dir) => {
    const derive = await import(`${base}/@fs${dir}/core/derive.js`);
    window.__nodeAnchors = derive.nodeAnchors;
  }, baseUrl, appDir);

  /** Command (async). Loads the doc with the strip at (x, y), fits the camera, and
   *  returns the scene-canvas box the samples are taken in. */
  async function load(x, y) {
    await page.evaluate((d) => {
      const app = window.__powerrp_app;
      app.commit(app.repaired(d));
      app.slideIndex = 0;
      app.runCommand("reset-view"); // zoom-to-fit THE camera, so world→canvas is known
    }, doc(x, y));
    await sleep(500);
    return await page.evaluate(() => {
      const r = document.querySelector("canvas.scene").getBoundingClientRect();
      return { cx: r.x, cy: r.y, w: r.width, h: r.height };
    });
  }

  /** Query (async). The world→canvas mapping the current view uses, read from the app
   *  so the probe never re-derives the camera math. */
  const viewOf = () => page.evaluate(() => {
    // `lastViewport` is the app-level mirror CanvasView keeps fresh through its
    // onviewport callback (it is what undo restores), so it is the app's OWN copy of
    // the world→canvas mapping rather than a second derivation.
    const v = window.__powerrp_app.lastViewport;
    if (!v) throw new Error("app.lastViewport is not set — the canvas has not reported a viewport yet");
    return { zoom: v.zoom, panX: v.panX, panY: v.panY };
  });

  /** Query (async). The centre pixel of each of the strip's cells, in canvas
   *  coordinates, derived from the app's OWN per-frame anchors (f{i}cm) — so this reads
   *  the same geometry the widget draws rather than a second copy of the layout math. */
  const cellCentres = () => page.evaluate(() => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === "fs");
    return window.__nodeAnchors(node)
      .filter((a) => /^f\d+cm$/.test(a.id))
      .map((a) => ({ id: a.id, wx: a.x, wy: a.y }));
  });

  /** Query (async). A screenshot of the scene canvas, decoded. */
  const shoot = async (box) => readPng(await page.screenshot({ clip: { x: box.cx, y: box.cy, width: box.w, height: box.h } }));

  /** Pure function. World point → canvas-local CSS pixel, in the app's OWN convention
   *  (core/view.js worldViewRect inverts exactly this: wx = (dx/dpr - panX) / zoom, so
   *  the forward map is wx*zoom + panX, in DEVICE pixels). The screenshot is taken in
   *  CSS pixels and the canvas is CSS-sized to its bounding rect, so `dpr` — which only
   *  scales the backing store — drops out here. */
  const toCanvas = (view, wx, wy) => ({
    x: wx * view.zoom + view.panX,
    y: wy * view.zoom + view.panY,
  });

  /** Query (async). Each cell's colour band, sampled at that cell's own anchor. */
  async function cellBands(box) {
    const view = await viewOf();
    const centres = await cellCentres();
    const png = await shoot(box);
    return centres.map((c) => {
      const p = toCanvas(view, c.wx, c.wy);
      return { id: c.id, rgb: pixelAt(png, p.x, p.y), at: p };
    }).map((c) => ({ ...c, band: band(c.rgb), blank: isBackdrop(c.rgb) }));
  }

  // ── PHASE 1: frames sourced LIVE, with no server ───────────────────────────
  console.log("\n══ live frames (no project server running) ══");
  let box = await load(STRIP_X, STRIP_Y);
  const anchors = await cellCentres();
  assert(anchors.length === FRAME_COUNT, `the widget exposes one f{i}cm anchor per frame (${anchors.length} of ${FRAME_COUNT}: ${anchors.map((a) => a.id).join(" ")})`);

  let decoded = null;
  for (let i = 0; i * POLL_MS < DECODE_TIMEOUT_MS; i++) {
    const cells = await cellBands(box);
    if (cells.every((c) => !c.blank && c.band !== "none")) { decoded = cells; break; }
    await sleep(POLL_MS);
  }
  const finalCells = decoded ?? await cellBands(box);
  await writeFile(resolve(SHOTS, "filmstrip_live.png"), PNG.sync.write(await shoot(box)));
  console.log(`  cells: ${finalCells.map((c) => `${c.id}=${c.band}(${c.rgb})`).join("  ")}`);
  assert(decoded !== null, `every cell shows decoded video (${finalCells.filter((c) => c.blank).length} still blank)`);

  // ── PHASE 2: the cells show DIFFERENT times (the equations resolved) ───────
  const bands = finalCells.map((c) => c.band);
  console.log(`  band sequence across the strip: ${bands.join(" → ")} (the fixture is red 0-1s, green 1-2s, blue 2-3s)`);
  assert(new Set(bands).size === FRAME_COUNT,
    `the three cells show three DIFFERENT frames — the per-element equations resolved to 0s / 1s / 2s (got ${bands.join(",")})`);
  assert(bands[0] === "red" && bands[FRAME_COUNT - 1] === "blue",
    `frame 0 sits AT videoStart and the last frame two thirds in, per the i/N indexing (got ${bands.join(",")})`);

  // ── PHASE 3: THE PICTURES MOVE WITH THE STRIP (the reported defect) ───────
  console.log("\n══ the pictures move with the strip ══");
  const beforeCentres = await cellCentres();
  const beforeView = await viewOf();
  const beforePng = await shoot(box);
  const beforeAt = toCanvas(beforeView, beforeCentres[0].wx, beforeCentres[0].wy);
  await page.evaluate((dx, dy) => {
    const app = window.__powerrp_app;
    // The DRAG path's own write seam (preview then commit), as a body-drag makes it.
    const s = app.state().items.fs;
    app.setPreview([[["items", "fs", "x"], s.x + dx], [["items", "fs", "y"], s.y + dy]]);
    app.commitPreview();
  }, DRAG_BY.x, DRAG_BY.y);
  await sleep(SETTLE_MS);
  const movedCentres = await cellCentres();
  const movedView = await viewOf();
  const movedPng = await shoot(box);
  await writeFile(resolve(SHOTS, "filmstrip_moved.png"), PNG.sync.write(movedPng));
  const movedAt = toCanvas(movedView, movedCentres[0].wx, movedCentres[0].wy);
  const atOldSpot = pixelAt(movedPng, beforeAt.x, beforeAt.y);
  const atNewSpot = pixelAt(movedPng, movedAt.x, movedAt.y);
  console.log(`  frame 0 world centre: (${beforeCentres[0].wx.toFixed(0)}, ${beforeCentres[0].wy.toFixed(0)}) → (${movedCentres[0].wx.toFixed(0)}, ${movedCentres[0].wy.toFixed(0)})`);
  console.log(`  pixel at the OLD spot after the move: ${atOldSpot} → ${band(atOldSpot)} ${isBackdrop(atOldSpot) ? "(backdrop — nothing left behind)" : ""}`);
  console.log(`  pixel at the NEW spot after the move: ${atNewSpot} → ${band(atNewSpot)}`);
  assert(band(atNewSpot) === bands[0], `the frame TRAVELLED with the strip — its picture is at the new place (got ${band(atNewSpot)}, want ${bands[0]})`);
  assert(isBackdrop(atOldSpot), `NOTHING was left behind at the old place — the pictures no longer stay pinned at the canvas origin while the strip moves (got ${atOldSpot})`);
  // Belt and braces on the same defect from the other side: the whole strip's pixels
  // changed, so the move really did repaint rather than the probe reading a stale shot.
  assert(!beforePng.data.equals(movedPng.data), "the canvas actually repainted after the move");

  // ── PHASE 4: THE FRAMES ANIMATE (re-timing re-decodes every cell) ─────────
  console.log("\n══ re-timing the span re-decodes the cells (the strip animates) ══");
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    // Sample only the clip's LAST third: every cell should land in the blue band.
    app.setPreview([[["items", "fs", "videoStart"], 2.0], [["items", "fs", "videoEnd"], 2.9]]);
    app.commitPreview();
  });
  let retimed = null;
  for (let i = 0; i * POLL_MS < DECODE_TIMEOUT_MS; i++) {
    const cells = await cellBands(box);
    if (cells.every((c) => c.band === "blue")) { retimed = cells; break; }
    await sleep(POLL_MS);
  }
  const retimedCells = retimed ?? await cellBands(box);
  await writeFile(resolve(SHOTS, "filmstrip_retimed.png"), PNG.sync.write(await shoot(box)));
  console.log(`  after re-timing to 2.0-2.9 s: ${retimedCells.map((c) => c.band).join(" → ")}`);
  assert(retimed !== null, `re-timing the span re-decoded every cell into the clip's last third (got ${retimedCells.map((c) => c.band).join(",")}) — the frames are live scrubs, not a fixed contact sheet`);

  // ── PHASE 5: per-frame anchors land INSIDE their own cells ────────────────
  console.log("\n══ per-frame anchors ══");
  const allAnchors = await page.evaluate(() => {
    const node = window.__powerrp_app.nodes().find((n) => n.itemId === "fs");
    return window.__nodeAnchors(node).map((a) => ({ id: a.id, x: a.x, y: a.y }));
  });
  const perFrame = allAnchors.filter((a) => /^f\d+/.test(a.id));
  console.log(`  ${allAnchors.length} anchors total, ${perFrame.length} per-frame (${FRAME_COUNT} frames x 9)`);
  assert(perFrame.length === FRAME_COUNT * 9, `every frame exposes the standard 9 (${perFrame.length})`);
  assert(perFrame.every((a) => !a.id.includes("_")), "no anchor id contains an underscore (the ref grammar splits on the last one)");
  // Each f{i}cm must sit inside its own cell, which the pixel test already relied on —
  // stated here as its own assertion so a geometry regression is named rather than
  // showing up as a mysterious colour mismatch.
  const centresNow = await cellCentres();
  const xs = centresNow.map((c) => c.wx);
  assert(xs.every((x, i) => i === 0 || x > xs[i - 1]), `the frame centres run left to right (${xs.map((x) => x.toFixed(0)).join(", ")})`);

  // ── PHASE 6: ONE UNDO UNIT (measured by JSON COMPARE) ────────────────────
  console.log("\n══ Respace Filmstrip Frames = ONE undo unit ══");
  const undoProof = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = "fs";
    // Make the list UNEVEN first, so respacing has real work to do: purge the middle
    // frame. The survivors keep their baked equations (which still name the OLD count of
    // 3), so after the purge the two remaining frames sit at 0 and 2/3 of the span
    // instead of 0 and 1/2 — exactly the state the Respace command exists for.
    const list = app.state().items.fs.frames;
    app.setPreview([[["items", "fs", "frames"], [list[0], list[2]]]]);
    app.commitPreview();
    const uneven = app.state().items.fs.frames.map((el) => el[0]);

    const before = JSON.stringify(app.doc);
    app.runCommand("filmstrip-respace-frames");
    const after = JSON.stringify(app.doc);
    const respaced = app.state().items.fs.frames.map((el) => el[0]);
    app.undo();
    const undone = JSON.stringify(app.doc);
    return {
      uneven, respaced,
      changed: before !== after,
      // ONE undo unit: a SINGLE undo restores the document byte for byte. Compared as
      // JSON, never by reference — a second undo unit would leave a different string.
      restored: undone === before,
      afterUndo: app.state().items.fs.frames.map((el) => el[0]),
    };
  });
  console.log(`  after purging the middle frame: ${JSON.stringify(undoProof.uneven)}`);
  console.log(`  after Respace:                  ${JSON.stringify(undoProof.respaced)}`);
  console.log(`  respace changed the document: ${undoProof.changed}; one undo restored it exactly: ${undoProof.restored}`);
  assert(undoProof.changed, `Respace really re-timed the list (${JSON.stringify(undoProof.uneven)} → ${JSON.stringify(undoProof.respaced)}) — a no-op would make the undo assertion below vacuous`);
  // app.state() is EVALUATED, so these are the times the strip will actually decode —
  // better evidence than the equation text. Span 2.0→2.9 s: two frames at i/2 land on
  // 2.0 and 2.45; the stale i/3 equations the purge left behind landed on 2.0 and 2.6.
  const wantRespaced = [2.0, 2.0 + (1 / 2) * 0.9];
  assert(undoProof.respaced.length === 2 && undoProof.respaced.every((t, i) => Math.abs(t - wantRespaced[i]) < 1e-6),
    `Respace re-timed the frames for the CURRENT count of 2 — i/2 across the span (want ${JSON.stringify(wantRespaced)}, got ${JSON.stringify(undoProof.respaced)})`);
  assert(Math.abs(undoProof.uneven[1] - (2.0 + (2 / 3) * 0.9)) < 1e-6,
    `before respacing, the survivor still sat at the STALE i/3 position the purge left it at (got ${undoProof.uneven[1]})`);
  assert(undoProof.restored, "ONE undo restores the pre-respace document exactly (JSON compare) — the command is a single undo unit");
  assert(JSON.stringify(undoProof.afterUndo) === JSON.stringify(undoProof.uneven), "and the widget's own state came back with it");

  // ── PHASE 7: PRESERVE ASPECT actually letterboxes, in PIXELS ─────────────
  // The plugin cannot letterbox: emit() never learns the clip's intrinsic size, so it
  // only DECLARES `preserveAspect` on the videoV5Frame op and the painter does the fit
  // (render_gpu/skia/paint_skia.js drawSampledQuad). That means the OP BOX is identical
  // either way and the ONLY evidence is pixels — which is why this lives here and not
  // in the node suite. The fixture is 96x72 (4:3) and the cells are far wider than
  // that, so ON must leave FILM BASE down each side of every cell and OFF must not.
  console.log("\n══ preserve aspect (default ON) letterboxes each frame ══");
  box = await load(STRIP_X, STRIP_Y); // a fresh 3-frame strip across the whole clip
  for (let i = 0; i * POLL_MS < DECODE_TIMEOUT_MS; i++) {
    if ((await cellBands(box)).every((c) => !c.blank && c.band !== "none")) break;
    await sleep(POLL_MS);
  }
  /** Query (async). The colour just inside a cell's LEFT edge and at its centre, for
   *  every cell — the two places a letterbox and a stretch must disagree. */
  const cellEdgeAndCentre = async () => {
    const view = await viewOf();
    const png = await shoot(box);
    const anchors = await page.evaluate(() => {
      const node = window.__powerrp_app.nodes().find((n) => n.itemId === "fs");
      return window.__nodeAnchors(node).filter((a) => /^f\d+(ml|cm)$/.test(a.id)).map((a) => ({ id: a.id, x: a.x, y: a.y }));
    });
    const at = (a, dx) => pixelAt(png, toCanvas(view, a.x + dx, a.y).x, toCanvas(view, a.x + dx, a.y).y);
    return anchors.filter((a) => a.id.endsWith("ml")).map((a) => {
      const centre = anchors.find((c) => c.id === a.id.replace("ml", "cm"));
      // EDGE_INSET clears the cell's own 1-unit grey outline while staying well inside
      // the ~18-unit letterbox bar a 4:3 source leaves in these cells.
      return { id: a.id, edge: at(a, LETTERBOX_PROBE_INSET), centre: at(centre, 0) };
    });
  };
  const withFit = await cellEdgeAndCentre();
  await writeFile(resolve(SHOTS, "filmstrip_preserve_aspect_on.png"), PNG.sync.write(await shoot(box)));
  console.log(`  ON : ${withFit.map((c) => `${c.id} edge=${band(c.edge)} centre=${band(c.centre)}`).join("  ")}`);
  assert(withFit.every((c) => band(c.centre) !== "none"), "with the fit ON the picture still fills the middle of every cell");
  assert(withFit.every((c) => band(c.edge) === "none"),
    `with the fit ON each cell shows FILM BASE beside the picture — a 4:3 clip cannot fill a much wider cell without distorting (got ${withFit.map((c) => band(c.edge)).join(",")})`);
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", "fs", "preserveAspect"], false]]);
    app.commitPreview();
  });
  await sleep(SETTLE_MS);
  const stretched = await cellEdgeAndCentre();
  await writeFile(resolve(SHOTS, "filmstrip_preserve_aspect_off.png"), PNG.sync.write(await shoot(box)));
  console.log(`  OFF: ${stretched.map((c) => `${c.id} edge=${band(c.edge)} centre=${band(c.centre)}`).join("  ")}`);
  assert(stretched.every((c) => band(c.edge) !== "none"),
    `with the fit OFF the picture is stretched to the cell's full width, so the same sample point is video (got ${stretched.map((c) => band(c.edge)).join(",")})`);
  assert(stretched.every((c, i) => band(c.edge) === band(withFit[i].centre)),
    "and it is the SAME frame stretched, not a different one");

  // ── PHASE 8: PAINT COST (reported, not gated) ────────────────────────────
  console.log("\n══ paint cost of the real perforation pitch ══");
  const cost = await page.evaluate(async (dir) => {
    const app = window.__powerrp_app;
    const { sceneIR } = await import(`${location.origin}/@fs${dir}/render_gpu/ports.js`);
    const nodes = app.nodes().filter((n) => n.itemId === "fs");
    const ops = sceneIR(nodes);
    const count = (list) => list.reduce((n, c) => n + 1 + (Array.isArray(c.content) ? count(c.content) : 0), 0);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) sceneIR(nodes);
    return { ops: count(ops), emitMs: (performance.now() - t0) / 20 };
  }, appDir);
  console.log(`  one filmstrip emits ${cost.ops} display-list ops (mostly perforation triangles — a 35 mm strip has a hole every 4.75 mm)`);
  console.log(`  emit() cost: ${cost.emitMs.toFixed(2)} ms per build`);
  console.log("  NOTE: this is the price of the published perforation pitch. If it ever matters, the band");
  console.log("        can be decomposed into rects + corner fillets instead of a full annular tessellation.");

  if (errors.length) { console.error("\nPAGE ERRORS:\n" + errors.join("\n")); fails.push("page/console errors"); }
  assert(!errors.some((e) => /api\/frames/i.test(e)), "NO frames-endpoint error — the widget needs no project server");
} catch (e) {
  console.error("\nFAIL filmstrip_live_probe:", e?.stack ?? e);
  fails.push(String(e?.message ?? e));
} finally {
  await browser.close();
  await server.close();
}

console.log(fails.length ? `\nFAIL filmstrip_live_probe (${fails.length}):\n  ${fails.join("\n  ")}` : "\nOK filmstrip_live_probe");
process.exit(fails.length ? 1 : 0);
