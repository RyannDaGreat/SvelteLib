/**
 * LIQUID GLASS ON A REAL GL CONTEXT (browser probe).
 *
 * The node suites compile the glass SkSL for CanvasKit's SOFTWARE backend. That
 * leaves the one thing they structurally cannot cover: in the editor the same SkSL
 * is lowered to GLSL and run on a GPU render target, and the two backends do not
 * accept identical programs. A construct the raster pipeline swallows can fail GL
 * codegen — a vector-valued ternary, a `&&` inside a select, a division guarded by a
 * comparison — and every node test would stay green while the editor drew nothing
 * (the blend_browser_probe precedent: nine SkSL blenders that would have silently
 * collapsed to Normal only on GL).
 *
 * The surface-tension work added exactly those shapes to the shader (a guarded
 * ref/rr pre-scale, an `s.x == 1.0 && s.y == 1.0` select, a nested component-wise
 * ternary for the gauge gradient), so this probe exists to run them on GL:
 *   1. the effect COMPILES and paints a non-trivial panel;
 *   2. tension 0 / 0.5 / 1 give three DIFFERENT pictures (the new uniform reaches
 *      the GL program, and nothing collapses it);
 *   3. the coverage contour sits on the JS outline generator's curve here too, so
 *      the stroke and the shader agree on the GPU and not only in node.
 *
 * Spawns its own Vite + headless Chromium (swiftshader WebGL2) and builds a REAL GL
 * grContext through the app's own SkiaSurface.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/glass_gl_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const POWERRP = resolve(HERE, ".."); // tests → PowerRP root
const webRoot = resolve(POWERRP, "web");

const SIZE = { w: 420, h: 260 };
const PANEL = { w: 300, h: 130 };
const TENSIONS = [0, 0.5, 1];
// Coverage on the outline must be smoothstep's midpoint. The GL backend runs the
// same maths at a possibly different precision, so this allows a whole half pixel
// (the node suite holds the same shader to 0.09 px) — enough slack for mediump-class
// arithmetic, far too little for a shape that has actually changed.
const EDGE_COVERAGE_TOLERANCE = 0.4;

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

const fails = [];
const check = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else console.log(`  ok   ${msg}`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // The app's own unrelated environment noise (no backend server, no WebGPU adapter
  // for the video experiments) is not what this probe is about.
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|no WebGPU adapter|WebGPU init failed/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });

  const urls = {
    ck: `/@fs${resolve(POWERRP, "render_gpu/skia/browser_canvaskit.js")}`,
    surf: `/@fs${resolve(POWERRP, "render_gpu/skia/browser_surface.js")}`,
    paint: `/@fs${resolve(POWERRP, "render_gpu/skia/paint_skia.js")}`,
    glass: `/@fs${resolve(POWERRP, "render_gpu/skia/glass_shader.js")}`,
    ir: `/@fs${resolve(POWERRP, "render_gpu/ir.js")}`,
    plugin: `/@fs${resolve(POWERRP, "plugins/demo/glass.js")}`,
  };

  const out = await page.evaluate(async (u, SIZE, PANEL, TENSIONS) => {
    const ck = await (await import(u.ck)).ensureCanvasKit();
    const { SkiaSurface } = await import(u.surf);
    const { paintIR } = await import(u.paint);
    const { glassOutlinePoints } = await import(u.glass);
    const { rect, ellipse, pushTransform, popTransform } = await import(u.ir);
    const { glassPlugin } = await import(u.plugin);

    const host = document.createElement("canvas");
    host.width = SIZE.w; host.height = SIZE.h;
    const skia = await SkiaSurface.create(host);
    if (!skia.grContext) return { backend: "NO-GRCONTEXT" };
    const makeSurface = skia._makeSurface;

    // A backdrop with real detail beneath the panel, so refraction and blur have
    // something to act on and a blank frame cannot pass for a rendered one.
    const backdrop = [rect({ x: 0, y: 0, w: SIZE.w, h: SIZE.h, fill: "#141852" })];
    const cols = ["#50dcc8", "#ff5a78", "#ffd246", "#78a0ff"];
    let seed = 5;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 18; i++)
      backdrop.push(ellipse({ cx: rnd() * SIZE.w, cy: rnd() * SIZE.h, rx: 8 + rnd() * 20, ry: 8 + rnd() * 20, fill: cols[i % cols.length] }));

    // No stroke and no shadow: the panel's ALPHA is then the shader's own coverage,
    // which is what the contour check reads.
    const frame = (surfaceTension) => {
      const s = { ...glassPlugin.defaults, w: PANEL.w, h: PANEL.h, surfaceTension, strokeWidth: 0, shadowStrength: 0 };
      const commands = [
        ...backdrop,
        pushTransform({ x: (SIZE.w - PANEL.w) / 2, y: (SIZE.h - PANEL.h) / 2, rotation: 0, scale: 1 }),
        ...glassPlugin.emit(s),
        popTransform(),
      ];
      const target = makeSurface(SIZE.w, SIZE.h);
      if (!target) throw new Error("probe: MakeRenderTarget returned null");
      paintIR(ck, target.getCanvas(), commands, { zoom: 1, panX: 0, panY: 0, dpr: 1 },
        { fontCollection: skia.fontCollection, background: "#05060c", makeSurface });
      target.flush();
      const bytes = target.getCanvas().readPixels(0, 0, {
        width: SIZE.w, height: SIZE.h,
        colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB,
      });
      const copy = Array.from(bytes);
      target.dispose ? target.dispose() : target.delete?.();
      return copy;
    };

    // Coverage cannot be read off an opaque composite, so the contour check paints the
    // panel ALONE on a cleared surface and reads the alpha channel.
    const coverage = (surfaceTension) => {
      const s = { ...glassPlugin.defaults, w: PANEL.w, h: PANEL.h, surfaceTension, strokeWidth: 0, shadowStrength: 0 };
      const commands = [
        pushTransform({ x: (SIZE.w - PANEL.w) / 2, y: (SIZE.h - PANEL.h) / 2, rotation: 0, scale: 1 }),
        ...glassPlugin.emit(s),
        popTransform(),
      ];
      const target = makeSurface(SIZE.w, SIZE.h);
      paintIR(ck, target.getCanvas(), commands, { zoom: 1, panX: 0, panY: 0, dpr: 1 },
        { fontCollection: skia.fontCollection, background: "rgba(0,0,0,0)", makeSurface });
      target.flush();
      const bytes = target.getCanvas().readPixels(0, 0, {
        width: SIZE.w, height: SIZE.h,
        colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB,
      });
      const alpha = new Float32Array(SIZE.w * SIZE.h);
      for (let i = 0; i < alpha.length; i++) alpha[i] = bytes[i * 4 + 3] / 255;
      target.dispose ? target.dispose() : target.delete?.();
      const cx = SIZE.w / 2, cy = SIZE.h / 2;
      const at = (x, y) => (x < 0 || y < 0 || x >= SIZE.w || y >= SIZE.h ? 0 : alpha[y * SIZE.w + x]);
      const sample = (lx, ly) => {
        const fx = cx + lx - 0.5, fy = cy + ly - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        return (1 - tx) * (1 - ty) * at(x0, y0) + tx * (1 - ty) * at(x0 + 1, y0)
          + (1 - tx) * ty * at(x0, y0 + 1) + tx * ty * at(x0 + 1, y0 + 1);
      };
      let worst = 0, atPoint = null;
      const pts = glassOutlinePoints(PANEL.w / 2, PANEL.h / 2, s.cornerRadius, s.squircle, surfaceTension, 1);
      for (let i = 0; i < pts.length; i += 5) {
        const [x, y] = pts[i];
        const d = Math.abs(sample(x, y) - 0.5);
        if (d > worst) { worst = d; atPoint = [x, y]; }
      }
      return { worst, atPoint, painted: alpha.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) };
    };

    const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
    const frames = TENSIONS.map(frame);
    const bare = frame(0).length; // sanity: readPixels returned something
    const result = {
      backend: "webgl2-grcontext",
      byteLength: bare,
      nonBackground: frames.map((f) => { let n = 0; for (let i = 0; i < f.length; i += 4) if (f[i] !== 5) n++; return n; }),
      pairDiffs: [diff(frames[0], frames[1]), diff(frames[1], frames[2]), diff(frames[0], frames[2])],
      coverage: TENSIONS.map(coverage),
    };
    skia.dispose();
    return result;
  }, urls, SIZE, PANEL, TENSIONS);

  console.log(`── Liquid Glass on a REAL GL context (${out.backend}) ──`);
  check(out.backend === "webgl2-grcontext", "the probe ran on a real WebGL2 grContext");
  check(out.nonBackground?.every((n) => n > 1000), `the glass SkSL compiled and painted on GL at every tension (${out.nonBackground?.join(", ")} non-background px)`);
  check(out.pairDiffs?.every((n) => n > 500), `tension 0 / 0.5 / 1 are three DIFFERENT GL pictures (${out.pairDiffs?.join(", ")} bytes differ pairwise)`);
  for (const [i, cov] of (out.coverage ?? []).entries()) {
    check(cov.painted > 1000, `tension ${TENSIONS[i]}: the panel painted coverage (${cov.painted} px)`);
    check(cov.worst <= EDGE_COVERAGE_TOLERANCE,
      `tension ${TENSIONS[i]}: GL coverage on the JS outline is 1/2 to within ${cov.worst.toFixed(3)} (~${(cov.worst / 0.75).toFixed(2)} device px)`);
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`\nFAILED ${fails.length}:\n - ${fails.join("\n - ")}`); process.exit(1); }
console.log("\nOK glass_gl_probe — the surface-tension shader compiles and agrees with the JS outline on a real GL context");
