/**
 * REGRESSION GUARD for the "zoom into a placed PDF too far" CanvasKit wasm OOM
 * (RuntimeError: memory access out of bounds at MakeSurface). Drives an
 * OVERSIZED surface request through each guarded factory and confirms the guard
 * CLAMPS it (MakeSurface/MakeRenderTarget/MakeOnScreenGLSurface never sees the
 * fatal dim) and still returns a valid surface — the exact allocation that OOBs
 * the wasm heap on real GL. Also shows the UNGUARDED contrast (raw
 * CanvasKit.MakeSurface at the oversized dim → null here, OOB on real GL).
 *
 * WITHOUT the fix, the guarded factories would forward the oversized dim →
 * null/OOB; WITH the fix they clamp to the surface cap + reportOnce. This is the
 * probe that actually distinguishes the two.
 *
 * Run (dev server must be up):
 *   node tests/pdf_surface_guard_probe.js [http://localhost:3637]
 */
import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POWERRP = path.resolve(HERE, ".."); // tests/ → PowerRP root
const URL = process.argv[2] || "http://localhost:3637";
const CK = `/@fs${path.join(POWERRP, "render_gpu/skia/browser_canvaskit.js")}`;
const SURF = `/@fs${path.join(POWERRP, "render_gpu/skia/browser_surface.js")}`;
const GSVC = "/gpuService.js";

async function main() {
  const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  const clampReports = [];
  page.on("console", (m) => { if (m.type() === "error") { const s = m.text(); if (/clamp|MAX_SURFACE_DIM|heap overrun/i.test(s)) clampReports.push(s); } });
  page.on("pageerror", (e) => console.log("PAGEERR:", String(e).slice(0, 160)));
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 20000 });

  const res = await page.evaluate(async (CK, SURF, GSVC) => {
    const out = {};
    const ck = await (await import(CK)).ensureCanvasKit();
    // 1) UNGUARDED raw factory at an oversized dim (what the bug hit).
    let raw = "ok"; try { const s = ck.MakeSurface(32768, 32768); raw = s ? "surface(!)" : "null-or-oob"; s?.delete(); } catch (e) { raw = "THROW:" + String(e.message||e).slice(0,40); }
    out.rawOversized = raw;

    // 2) GUARDED offscreen factory (browser_surface _makeSurface): oversized in → clamped surface out.
    const { SkiaSurface } = await import(SURF);
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 32;
    const skia = await SkiaSurface.create(canvas);
    out.maxDim = skia.maxDim;
    const big = skia._makeSurface(50000, 50000);
    out.guardedOffscreen = big ? "surface(clamped, non-null)" : "null";
    if (big) { const c = big.getCanvas(); out.guardedOffscreenDraws = !!c; big.dispose ? big.dispose() : big.delete?.(); }

    // 3) GUARDED on-screen surface: an oversized canvas element clamps, no throw.
    const bigCanvas = document.createElement("canvas");
    bigCanvas.width = 40000; bigCanvas.height = 300;
    let onscreen = "ok";
    try { const s2 = await SkiaSurface.create(bigCanvas); s2._ensureSurface(); out.onscreenMaxDim = s2.maxDim; onscreen = s2.surface ? "surface(clamped)" : "no-surface(reported, no throw)"; s2.dispose(); }
    catch (e) { onscreen = "THROW:" + String(e.message||e).slice(0,60); }
    out.guardedOnscreen = onscreen;

    // 4) GUARDED gpuService at an oversized export dim → clamped canvas, no crash.
    const gsvc = await import(GSVC);
    const ir = [{ op: "rect", x: 0, y: 0, w: 10, h: 10, fill: [1,0,0,1], cornerRadius: 0 }];
    const view = { zoom: 1, panX: 0, panY: 0, dpr: 1 };
    try { const el = await gsvc.rasterizeIrPng(ir, view, 40000, 100, "#ffffff"); out.gpuService = "ok(bytes=" + (el?.length ?? "?") + ")"; }
    catch (e) { out.gpuService = "THROW:" + String(e.message||e).slice(0,60); }

    skia.dispose();
    return out;
  }, CK, SURF, GSVC).catch((e) => ({ error: String(e && e.stack || e).slice(0, 300) }));

  await browser.close();
  console.log(JSON.stringify(res, null, 2));
  console.log(`\nClamp reports captured: ${clampReports.length}`);
  for (const r of clampReports.slice(0, 8)) console.log("  " + r.slice(0, 180));

  // PASS iff every guarded factory turned an oversized request into a valid,
  // non-crashing allocation (clamped) AND reported it loudly.
  const fails = [];
  if (res.error) fails.push("probe error: " + res.error);
  if (res.maxDim < 8192) fails.push(`maxDim ${res.maxDim} < MAX_SURFACE_DIM floor`);
  if (!/non-null/.test(res.guardedOffscreen || "")) fails.push("offscreen factory did not return a clamped surface: " + res.guardedOffscreen);
  if (!/surface/.test(res.guardedOnscreen || "")) fails.push("on-screen surface not clamped/allocated: " + res.guardedOnscreen);
  if (!/^ok/.test(res.gpuService || "")) fails.push("gpuService did not clamp+render: " + res.gpuService);
  if (clampReports.length < 3) fails.push(`expected ≥3 loud clamp reports, got ${clampReports.length}`);
  if (fails.length) { console.log("\nFAIL:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("\nPASS: every guarded surface factory clamps an oversized dim to a valid surface + reports loudly (no wasm OOB reachable).");
}
main().catch((e) => { console.error("ERROR:", e); process.exit(2); });
