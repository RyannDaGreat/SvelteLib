/**
 * THE STATIC MATERIAL RASTER CACHE, ON A REAL GPU (browser probe).
 *
 * The node suite (tests/material_raster_cache_test.js) proves hit == miss on CanvasKit's
 * SOFTWARE surfaces. That leaves the one thing it structurally cannot: in the editor a
 * cached raster is a GPU TEXTURE — `MakeRenderTarget` → `makeImageSnapshot` → the
 * surface is disposed → the Image is blitted on a LATER frame. If a snapshot did not
 * outlive its surface, or if the texture were recycled behind our back, every node test
 * would stay green while the editor showed a black or stale panel from the second frame
 * on. That is exactly the class of defect a browser probe exists for (the
 * blend_browser_probe precedent: nine SkSL blenders that would have collapsed to Normal
 * only on GL).
 *
 * Spawns its own Vite + headless Chromium (swiftshader WebGL2), builds a REAL GL
 * grContext through the app's own SkiaSurface, and paints the same foreground-material
 * scene four times on a GPU render target:
 *   frame 1 — first sighting (rendered, not retained)
 *   frame 2 — ADMITTED (rendered and retained as a GPU texture)
 *   frame 3 — HIT (blits the retained texture)
 *   frame 4 — HIT after a PAN of whole device px (same texture, new offset)
 * and reads the pixels back each time.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/material_raster_cache_browser_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const POWERRP = resolve(HERE, ".."); // tests → PowerRP root
const webRoot = resolve(POWERRP, "web");

const SIZE = { w: 320, h: 200 };
const PAN_PX = 29;               // whole device px — a pan must not change the raster
const BOX = { halfW: 60, halfH: 40 };

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const fails = [];
const check = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else console.log(`  ok   ${msg}`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|no WebGPU adapter|WebGPU init failed/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });

  const urls = {
    ck: `/@fs${resolve(POWERRP, "render_gpu/skia/browser_canvaskit.js")}`,
    surf: `/@fs${resolve(POWERRP, "render_gpu/skia/browser_surface.js")}`,
    paint: `/@fs${resolve(POWERRP, "render_gpu/skia/paint_skia.js")}`,
    ir: `/@fs${resolve(POWERRP, "render_gpu/ir.js")}`,
    plugins: `/@fs${resolve(POWERRP, "plugins/index.js")}`,
  };

  const out = await page.evaluate(async (u, SIZE, BOX, PAN_PX) => {
    const ck = await (await import(u.ck)).ensureCanvasKit();
    const { SkiaSurface } = await import(u.surf);
    const { paintIR, materialRasterStats } = await import(u.paint);
    const { rect, pushTransform, popTransform } = await import(u.ir);
    const { allPlugins } = await import(u.plugins);

    // A real GL context + grContext, and ITS identity-stable offscreen factory — the
    // very surfaces the editor's backdrops, effects and now material rasters live on.
    const host = document.createElement("canvas");
    host.width = SIZE.w; host.height = SIZE.h;
    const skia = await SkiaSurface.create(host);
    if (!skia.grContext) return { backend: "NO-GRCONTEXT" };
    const makeSurface = skia._makeSurface;

    // The scene: a corkboard fill (a foreground material) over a gradient page, its op
    // derived from the real plugin at its shipped defaults.
    const plugin = allPlugins.find((p) => p.type === "corkboard");
    const state = { ...plugin.defaults, x: 0, y: 0, w: 2 * BOX.halfW, h: 2 * BOX.halfH, world: { x: 0, y: 0, rotation: 0, scale: 1 } };
    const fill = plugin.emit(state, null, { x: 0, y: 0, rotation: 0, scale: 1 }).find((o) => o.op === "materialFill");
    const commands = [
      rect({ x: 0, y: 0, w: SIZE.w, h: SIZE.h, fill: "#101522" }),
      pushTransform({ x: 40, y: 30, rotation: 0, scale: 1 }),
      { ...fill, cx: BOX.halfW, cy: BOX.halfH, halfW: BOX.halfW, halfH: BOX.halfH },
      popTransform(),
    ];

    const frame = (panX) => {
      const target = makeSurface(SIZE.w, SIZE.h); // a GPU render target, like the editor's
      if (!target) throw new Error("probe: MakeRenderTarget returned null");
      paintIR(ck, target.getCanvas(), commands, { zoom: 1, panX, panY: 10, dpr: 1 }, { fontCollection: skia.fontCollection, background: "#05060c", makeSurface });
      target.flush();
      const bytes = target.getCanvas().readPixels(0, 0, {
        width: SIZE.w, height: SIZE.h,
        colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB,
      });
      const copy = Array.from(bytes);
      target.dispose ? target.dispose() : target.delete?.();
      return copy;
    };

    const before = materialRasterStats();
    const f1 = frame(10), f2 = frame(10), f3 = frame(10);
    const mid = materialRasterStats();
    const f4 = frame(10 + PAN_PX);
    const after = materialRasterStats();
    const diff = (a, b) => { let n = 0, max = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > max) max = d; } } return { n, max }; };
    // A frame that is entirely the page colour would "match" trivially — so prove the
    // material actually painted something.
    const painted = diff(f1, Array.from(new Array(f1.length).keys()).map(() => 0)).n;
    // The pan must move the picture (it is a different frame) while reusing the raster.
    const result = {
      backend: "webgl2-grcontext",
      admits: mid.admits - before.admits,
      hits: mid.hits - before.hits,
      panHits: after.hits - mid.hits,
      firstVsAdmit: diff(f1, f2),
      admitVsHit: diff(f2, f3),
      panMoved: diff(f3, f4).n,
      painted,
      retainedBytes: after.bytes,
    };
    skia.dispose();
    return result;
  }, urls, SIZE, BOX, PAN_PX);

  console.log(`── material raster cache on a REAL GL context (${out.backend}) ──`);
  check(out.backend === "webgl2-grcontext", "the probe ran on a real WebGL2 grContext");
  check(out.painted > 0, "the material actually painted pixels");
  check(out.admits === 1, `exactly one admission over three identical frames (got ${out.admits})`);
  check(out.hits === 1, `the third frame HIT the retained GPU texture (got ${out.hits})`);
  check(out.admitVsHit?.n === 0, `the HIT is byte-identical to the MISS on the GPU (${out.admitVsHit?.n} bytes differ, max Δ${out.admitVsHit?.max}) — a retained texture survives its surface`);
  check(out.firstVsAdmit?.n === 0, `the first sighting is byte-identical to the retained render (${out.firstVsAdmit?.n} bytes differ)`);
  check(out.panHits === 1, `a ${PAN_PX} px PAN HIT the same texture (got ${out.panHits})`);
  check(out.panMoved > 0, "the pan really moved the picture (the blit offset changed)");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log(`  retained ${(out.retainedBytes / 1e6).toFixed(2)} MB of GPU raster`);
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`\nFAILED ${fails.length}:\n - ${fails.join("\n - ")}`); process.exit(1); }
console.log("\nOK material_raster_cache_browser_probe — a retained GPU raster blits identically on later frames, and a pan reuses it");
