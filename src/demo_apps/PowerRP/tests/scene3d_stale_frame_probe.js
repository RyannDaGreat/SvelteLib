/**
 * A CHANGING PROPERTY MUST NOT PUNCH A TRANSPARENT HOLE IN A 3D VIEWPORT.
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/scene3d_stale_frame_probe.js [shot_dir]
 *
 * THE DEFECT THIS GATE EXISTS FOR (user report, todo #255): "it FLICKERS when
 * things change… this is INCOHERENT, I can't even use this" / "why does it go
 * TRANSPARENT when the variables are changing?". The cause is content-addressing
 * meeting an async renderer: a property change mints a raster ref that does not
 * exist yet, image_registry.getSkiaImage returns null for it, and the compositor
 * draws NOTHING until the render lands. One change is a blink; a DRAG changes a
 * property every frame, so the widget is transparent for the whole gesture.
 *
 * MEASURED AT HEAD BEFORE THE FIX, with the shipped 1,566-splat fixture — the
 * CHEAPEST scene in the app, so this is the best case and not the worst: a
 * continuous camYaw sweep left 59 of 60 animation frames naming a ref that was
 * not ready, i.e. 98% of frames drawing nothing.
 *
 * WHY THIS IS A PIXEL GATE AND NOT A FLAG GATE. Flicker cannot be shown in a
 * still, and a probe that asserts a state flag without real rendering is a gate
 * that cannot fail. So the sweep runs CONTINUOUSLY inside the page (a rAF loop
 * writing camYaw every frame — what a mouse-look drag is) while this process
 * takes a burst of screenshots of the widget's own box. Pre-fix, essentially
 * every clip is the transparent hole; post-fix, none may be.
 *
 * THE BLANK TEST IS BORROWED, NOT INVENTED: tests/scene3d_probe.js already
 * separates "a rendered scene" from "a flat affordance" by base64 PNG length at a
 * 2x margin, and this file reuses that exact comparison against a reference clip
 * of the SAME box with the widget switched off — the literal transparent hole,
 * captured rather than assumed.
 *
 * AND THE OTHER HALF, WHICH IS THE ONE THAT COULD SILENTLY ROT: the stale frame
 * is LIVE-PATH ONLY. A one-shot pixel consumer (thumbnail, PNG export, the CLI
 * hook) captures once, so a stale frame there would not be a brief artifact but
 * the shipped picture. Check 5 pins that emit() WITHOUT the live flag still
 * refuses to substitute — a gate that only proved the hold fires would happily
 * pass a version that had leaked it into the exporters.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const shots = process.argv[2] ?? "/tmp/scene3d_stale_frame_probe";
await mkdir(shots, { recursive: true });

/** The widget under test, parked where nothing in a fresh document sits. */
const BOX = { x: 200, y: 160, w: 320, h: 240 };
/** One reactive paint plus a Skia frame — tests/scene3d_probe.js's value. */
const SETTLE_MS = 220;
/** A splat decode plus the first sort, with room to spare; the polls below give
 *  up loudly rather than hanging. */
const RASTER_TIMEOUT_MS = 60000;
/** How many clips to take during the sweep. Each screenshot costs tens of ms, so
 *  this is a couple of seconds of continuous property change — long enough that a
 *  hole of ANY duration would land in at least one clip, given that pre-fix the
 *  widget is blank on 98% of frames. */
const BURST_CLIPS = 16;
/** Radians of yaw per swept frame. Small enough to look like a drag, large enough
 *  that every frame is a genuinely different picture and therefore a genuinely
 *  new raster ref — a sweep that reused refs would test the CACHE, not the hold. */
const SWEEP_STEP = 0.02;

const splatPath = fileURLToPath(new URL("../assets/builtin/splats/spz-test-scene.ply", import.meta.url));
const SPLAT_URL = `/@fs${splatPath}`;
/** The app's own modules, addressed the way Vite serves a file outside its root.
 *  Importing them in the page yields THE SAME module instances the app holds (a
 *  second instance could never observe a ref this app rasterized as "ready", which
 *  is what check 1 turns into an assertion rather than an assumption). */
const PORTS_URL = `/@fs${fileURLToPath(new URL("../render_gpu/ports.js", import.meta.url))}`;
const RASTER_URL = `/@fs${fileURLToPath(new URL("../render_gpu/gpu/scene3d_raster.js", import.meta.url))}`;

// A PRIVATE DEP CACHE + no HMR + no watcher, for the reason tests/scene3d_probe.js
// records: a dozen agents edit this tree concurrently, and a peer's dev server
// re-optimizing rotates the `?v=` hash under this page's in-flight import("three").
const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  cacheDir: await mkdtemp(join(tmpdir(), "powerrp-stale3d-vite-")),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser({ protocolTimeout: 180000 });
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // WAIT ON THE APP, NOT ON THE NETWORK: `networkidle0` is a coin flip on this
  // host, and a cold dependency optimize outruns any fixed sleep.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 120000 });
  await sleep(SETTLE_MS * 4);

  const splatId = await page.evaluate((extra) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("scene3d_splat").defaults, ...extra });
    return app.selection;
  }, { ...BOX, src: SPLAT_URL });

  await page.evaluate(async (portsUrl, rasterUrl) => {
    window.__stale3d = {
      ports: await import(/* @vite-ignore */ portsUrl),
      raster: await import(/* @vite-ignore */ rasterUrl),
    };
  }, PORTS_URL, RASTER_URL);

  /** Query. The image ref the scene walk produces for this node, and its raster
   *  status — asked through render_gpu/ports.sceneIR rather than by calling
   *  emit() directly, because `live` is a property of the SURFACE and sceneIR is
   *  where a surface declares it. This is the same function web/CanvasView.svelte
   *  calls with the same flag. */
  const drawn = (id, live) => page.evaluate((id, live) => {
    const app = window.__powerrp_app;
    const { ports, raster } = window.__stale3d;
    const node = app.nodes().find((n) => n.itemId === id);
    if (!node) return null;
    const ref = ports.sceneIR([node], { live }).find((o) => o.op === "image")?.ref ?? null;
    return { ref, status: ref ? raster.scene3dStatus(ref) : "none" };
  }, id, live);

  const statsOf = () => page.evaluate(() => window.__stale3d.raster.scene3dRasterStats());

  // ── 1. THE FIXTURE RENDERS, AND THE MODULES ARE THE APP'S OWN ─────────────
  const deadline = Date.now() + RASTER_TIMEOUT_MS;
  let first = null;
  while (Date.now() < deadline) {
    first = await drawn(splatId, true);
    if (first?.status === "ready") break;
    await sleep(200);
  }
  ok(first?.status === "ready",
    `the shipped splat fixture rasterized, through the app's OWN modules (${JSON.stringify(first)})`);

  // ── 2. THE THREE REFERENCE CLIPS ──────────────────────────────────────────
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, wx, wy);
  const tl = await worldToPage(BOX.x, BOX.y);
  const br = await worldToPage(BOX.x + BOX.w, BOX.y + BOX.h);
  const clip = {
    x: Math.round(tl.x), y: Math.round(tl.y),
    width: Math.round(br.x - tl.x), height: Math.round(br.y - tl.y),
  };
  const shot = () => page.screenshot({ encoding: "base64", clip });

  await sleep(SETTLE_MS * 3);
  const settled = await shot();
  // THE HOLE, CAPTURED RATHER THAN ASSUMED. Switching the item off with the
  // universal `active` property leaves exactly the pixels a widget drawing
  // nothing leaves: the camera background, and no widget. That is what a
  // not-yet-ready raster looks like, so it is the right reference to compare
  // against — an "empty viewport" widget would not be, because its affordance
  // panel is itself something drawn.
  await page.evaluate((id) => window.__powerrp_app.setPreview([[["items", id, "active"], false]]), splatId);
  await sleep(SETTLE_MS * 2);
  const hole = await shot();
  await page.evaluate(() => window.__powerrp_app.setPreview([]));
  await sleep(SETTLE_MS * 3);
  writeFileSync(`${shots}/01-settled.png`, Buffer.from(settled, "base64"));
  writeFileSync(`${shots}/02-hole-reference.png`, Buffer.from(hole, "base64"));
  ok(settled.length > hole.length * 2,
    `the reference clips are separable: a rendered scene is ${settled.length} b64 chars, the transparent hole ${hole.length}`);

  // ── 3. THE PIXEL GATE: NO BLANK FRAME DURING A CONTINUOUS CHANGE ──────────
  // The sweep runs inside the page and keeps running while this process
  // screenshots, so every clip is taken MID-CHANGE — which is the only moment
  // the defect exists. Awaiting the sweep would measure the settled picture and
  // could never fail.
  await page.evaluate((id, step) => {
    const app = window.__powerrp_app;
    const yaw0 = app.storedItemValue(id, ["camYaw"]);
    window.__stale3d.sweeping = true;
    let i = 0;
    const tick = () => {
      if (!window.__stale3d.sweeping) return;
      app.setPreview([[["items", id, "camYaw"], yaw0 + ++i * step]]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, splatId, SWEEP_STEP);

  const burst = [];
  for (let i = 0; i < BURST_CLIPS; i++) burst.push(await shot());
  const sweptStats = await statsOf();
  await page.evaluate(() => {
    window.__stale3d.sweeping = false;
    window.__powerrp_app.setPreview([]);
  });

  const blanks = burst.filter((b) => b.length <= hole.length * 2);
  burst.forEach((b, i) => writeFileSync(`${shots}/03-sweep-${String(i).padStart(2, "0")}.png`, Buffer.from(b, "base64")));
  ok(blanks.length === 0,
    `NO frame of a continuous property change is blank: ${blanks.length}/${burst.length} clips collapsed to the transparent reference (${hole.length} chars). Clip sizes: ${burst.map((b) => b.length).join(" ")}`);

  // The counter is the corroborating half, not the assertion: it proves the
  // no-blank result above was earned by the HOLD firing rather than by the
  // renderer happening to outrun the camera on this host, which would make the
  // pixel check pass for the wrong reason and rot the day a heavier scene loads.
  ok(sweptStats.holds > 0,
    `the stale-frame hold ACTUALLY FIRED during the sweep (${sweptStats.holds} held draws, ${sweptStats.renders} renders) — the clips above are not merely a fast host`);

  // ── 4. IT STILL CONVERGES ON THE TRUE PICTURE ─────────────────────────────
  // A hold that never let go would be a worse bug than the one it fixes: the
  // widget would show a frozen picture that no longer matches the document.
  const settleDeadline = Date.now() + RASTER_TIMEOUT_MS;
  let after = null;
  while (Date.now() < settleDeadline) {
    after = await drawn(splatId, true);
    if (after?.status === "ready") break;
    await sleep(200);
  }
  ok(after?.status === "ready" && after.ref === first.ref,
    `clearing the preview converges back on the document's OWN raster (${JSON.stringify(after)} vs ${JSON.stringify(first)})`);
  await sleep(SETTLE_MS * 3);
  const restored = await shot();
  writeFileSync(`${shots}/04-restored.png`, Buffer.from(restored, "base64"));
  ok(restored === settled,
    "and the pixels return byte-identically to the pre-sweep frame — the hold left nothing behind");

  // ── 5. THE HOLD IS LIVE-PATH ONLY ─────────────────────────────────────────
  // The half a "does the flicker stop?" gate cannot see. A one-shot consumer
  // captures once, so a stale frame there is the SHIPPED picture and a plausible-
  // looking wrong one. Ask for a pose that has never been rendered and check the
  // two surfaces disagree in exactly the intended direction.
  const unseen = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const { ports, raster } = window.__stale3d;
    // A pose no render has ever visited, staged as a preview so the document is
    // untouched and this check leaves no residue.
    app.setPreview([[["items", id, "camYaw"], 1.2345], [["items", id, "camPitch"], -0.4321]]);
    const node = app.nodes().find((n) => n.itemId === id);
    const refFor = (live) => ports.sceneIR([node], { live }).find((o) => o.op === "image")?.ref ?? null;
    const oneShot = refFor(false);
    const liveRef = refFor(true);
    app.setPreview([]);
    return { oneShot, liveRef, oneShotStatus: raster.scene3dStatus(oneShot), liveStatus: raster.scene3dStatus(liveRef) };
  }, splatId);
  ok(unseen.oneShotStatus !== "ready" && unseen.liveStatus === "ready",
    `a never-rendered pose gives the LIVE canvas a drawable stale frame and a ONE-SHOT consumer the true (not-yet-ready) ref (${JSON.stringify(unseen)})`);
  ok(unseen.oneShot !== unseen.liveRef,
    "the two surfaces genuinely differ — an export is never handed the held frame");

  ok(pageErrors.length === 0, `no uncaught page errors (${JSON.stringify(pageErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
if (errors.length) {
  console.error(`\n${errors.length} check(s) failed:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\n${checks.length} stale-frame checks passed — shots in ${shots}`);
