/**
 * THUMBNAIL GESTURE-HOLD PROBE (browser) — asserts, against the REAL editor with
 * a REAL pointer drag, that:
 *
 *  1. ZERO offscreen pixel renders happen while a gesture is in flight. The
 *     offscreen pixel service (web/gpuService.js) ends every job by writing the
 *     read-back pixels into a 2D canvas, so a patched
 *     CanvasRenderingContext2D.putImageData is an exact, source-untouched counter
 *     of gpuService jobs — slide thumbnails AND the minimap. A drag of a comic
 *     halftone (the heaviest backdrop material) must produce none.
 *  2. A tile scrolled INTO VIEW mid-gesture still renders nothing — the hole the
 *     old dirty-key freeze alone left open (it stopped tiles being DIRTIED, not an
 *     already-queued or newly-visible tile from rastering).
 *  3. window.__powerrp_thumbs.flush() runs that held work anyway — the seam that
 *     makes idle-scheduled renders visible to a profiler (requestIdleCallback
 *     never fires while the thread is busy, so this cost is otherwise invisible to
 *     the one tool you would reach for).
 *  4. The tile is CORRECT once the gesture settles: the <img> the navigator shows
 *     is byte-identical to a fresh render of the SETTLED document at the same
 *     device size (thumbnails stay a pure function of (document, slide)).
 *  5. Scroll-in renders stay PROMPT when no gesture is in flight (a deliberate
 *     property of the schedule — see web/thumbSchedule.js).
 *
 * Spawns its OWN isolated Vite (HMR/watch off) + headless Chromium (swiftshader),
 * the glass_probe.js pattern. Frontend-only — backend-absent 404s are ignored.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/thumb_gesture_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const SLIDES = 24;             // more than the navigator can show → real scroll-in
const BOOT_MS = 4000;          // Skia wasm + fonts + first paint
const FIRST_PAINT_MS = 3000;   // the seeded deck's initial thumbnails
const DRAG_MS = 3000;          // long enough for many idle windows to pass by
const MOVE_GAP_MS = 16;        // ~60 Hz pointermove cadence
const SETTLE_MS = 2500;        // > THUMB_SETTLE_MS + idle drain of every visible tile
const SCROLL_BUDGET_MS = 2000; // a no-gesture scroll-in must render inside this
const POLL_MS = 50;

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
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|WebGPU/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(BOOT_MS);

  // Count every gpuService job, from the page, with no source edits.
  await page.evaluate(() => {
    window.__jobs = [];
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...a) {
      window.__jobs.push({ t: performance.now(), w: this.canvas.width, h: this.canvas.height });
      return put.apply(this, a);
    };
  });

  // A content-rich deck: circles under ONE comic halftone panel, then SLIDES-1
  // slides that each nudge the panel (so every tile has distinct pixels).
  await page.evaluate((slides) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const items = { cam: { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 600, z: 1000, active: true, background: "#12203a" } };
    const cols = ["#50dcc8", "#ff5a78", "#ffd246", "#78a0ff", "#b4ff78", "#c37bff"];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 20; i++) {
      const d = 50 + rnd() * 110;
      items["c" + i] = { ...def("circle"), name: "C" + i, x: rnd() * 940, y: rnd() * 540, w: d, h: d, z: 2, fill: cols[i % cols.length], active: true };
    }
    items.comic = { ...def("demo_comic"), name: "Comic", x: 240, y: 160, w: 460, h: 260, z: 50, active: true };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const deck = [{ id: "s0", name: "S1", transition: tr, delta: { items } }];
    for (let i = 1; i < slides; i++)
      deck.push({ id: "s" + i, name: "S" + (i + 1), transition: tr, delta: { items: { comic: { x: 240 + i * 8 } } } });
    app.commit(app.repaired({ meta: { name: "thumb-gesture", slideW: 1000, slideH: 600 }, slides: deck }));
    app.slideIndex = 0;
    app.selection = "comic";
  }, SLIDES);
  await sleep(FIRST_PAINT_MS);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  const seam = await page.evaluate(() => typeof window.__powerrp_thumbs?.flush === "function" && typeof window.__powerrp_thumbs?.pending === "function");
  assert(seam, "the window.__powerrp_thumbs profiling seam is installed (flush + pending)");

  const navScroll = ".slidenav .slides";
  const scrollable = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.scrollHeight - el.clientHeight : 0;
  }, navScroll);
  assert(scrollable > 0, `the navigator actually scrolls (${scrollable}px of overflow) so scroll-in is real`);

  const jobsNow = () => page.evaluate(() => window.__jobs.length);
  const dragCentre = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const s = app.rawState().items.comic;
    return app.canvasActions.worldToScreen(s.x + s.w / 2, s.y + s.h / 2);
  });

  // ── 1 + 2. A real drag renders NOTHING, even with a tile scrolled in ─────────
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, navScroll);
  await sleep(SCROLL_BUDGET_MS);
  const before = await jobsNow();
  await page.mouse.move(dragCentre.x, dragCentre.y);
  await page.mouse.down();
  const t0 = Date.now();
  let moves = 0;
  let scrolledMidDrag = false;
  while (Date.now() - t0 < DRAG_MS) {
    moves++;
    await page.mouse.move(dragCentre.x + Math.round(60 * Math.sin(moves / 12)), dragCentre.y + Math.round(40 * Math.cos(moves / 17)));
    // Halfway through, scroll fresh tiles into view: they are dirty on size alone
    // (no prior render), so they WOULD raster mid-drag without the queue hold.
    if (!scrolledMidDrag && Date.now() - t0 > DRAG_MS / 2) {
      await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollTop = el.scrollHeight; }, navScroll);
      scrolledMidDrag = true;
    }
    await sleep(MOVE_GAP_MS);
  }
  const draggingSeen = await page.evaluate(() => window.__powerrp_app.dragging);
  const duringDrag = (await jobsNow()) - before;
  assert(draggingSeen === true, "the scripted gesture really is an active canvas drag (app.dragging)");
  assert(scrolledMidDrag, "fresh tiles were scrolled into view mid-drag");
  assert(duringDrag === 0, `ZERO offscreen renders during a ${moves}-move drag (was ${duringDrag})`);

  // ── 3. The profiling seam runs the held work on demand, still mid-drag ───────
  const held = await page.evaluate(() => window.__powerrp_thumbs.pending());
  assert(held > 0, `the held queue has work waiting (${held} pending renders)`);
  const flushed = await page.evaluate(() => window.__powerrp_thumbs.flush());
  assert(flushed === held, `flush() ran all ${held} held renders synchronously (${flushed})`);
  await sleep(SCROLL_BUDGET_MS); // the renders are async; let them land
  const afterFlush = (await jobsNow()) - before;
  assert(afterFlush >= flushed, `the flushed renders really executed (${afterFlush} jobs after flush) — this cost IS profilable`);

  // ── 4. Correct after the gesture settles ────────────────────────────────────
  const beforeDrop = await jobsNow();
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const afterDrop = (await jobsNow()) - beforeDrop;
  assert(afterDrop > 0, `thumbnails caught up after the gesture ended (${afterDrop} renders)`);

  // Back to the top and let the now-visible tiles settle. Only VISIBLE tiles are
  // expected to be current — an off-screen dirty tile deliberately keeps showing
  // its last render until scrolled in (the "5 million slides" property), so
  // checking one of those would assert the opposite of the design.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, navScroll);
  await sleep(SETTLE_MS);

  const match = await page.evaluate(async (sel) => {
    const gsUrl = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.endsWith("/gpuService.js"));
    const { renderCameraFrame } = await import(gsUrl);
    const app = window.__powerrp_app;
    // The first FULLY VISIBLE tile in the navigator's scroll box, and its slide.
    const box = document.querySelector(sel).getBoundingClientRect();
    const rows = [...document.querySelectorAll(".slidenav .slide")];
    const idx = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= box.top && b.bottom <= box.bottom && r.querySelector("img")?.naturalWidth > 0;
    });
    if (idx === -1) return { ok: false, why: "no fully visible rendered tile found" };
    const img = rows[idx].querySelector("img");
    const fresh = await renderCameraFrame(app.doc, {
      slideIndex: idx, alpha: 1, registry: app.registry,
      width: img.naturalWidth, height: img.naturalHeight, quality: "proxy",
    });
    return { ok: img.src === fresh.toDataURL("image/png"), slideIndex: idx, w: img.naturalWidth, h: img.naturalHeight };
  }, navScroll);
  assert(match.ok, `the settled tile (slide ${match.slideIndex}, ${match.w}x${match.h}) is byte-identical to a fresh render of the settled document${match.why ? " — " + match.why : ""}`);

  // ── 5. Scroll-in stays PROMPT with no gesture in flight ─────────────────────
  const beforeScroll = await jobsNow();
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollTop = el.scrollHeight / 2; }, navScroll);
  let waited = 0;
  while (waited < SCROLL_BUDGET_MS && (await jobsNow()) === beforeScroll) { await sleep(POLL_MS); waited += POLL_MS; }
  const scrolledIn = (await jobsNow()) - beforeScroll;
  assert(scrolledIn > 0, `a no-gesture scroll-in rendered promptly (${scrolledIn} renders in ${waited}ms, budget ${SCROLL_BUDGET_MS}ms)`);

  if (errors.length) { fails.push("page errors"); console.log(`PAGE ERRORS:\n${errors.join("\n")}`); }
  console.log(fails.length ? `\n${fails.length} FAILURES` : "\nall checks passed");
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
