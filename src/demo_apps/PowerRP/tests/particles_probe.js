/**
 * PARTICLE DETERMINISM PROBE (manifest 13.5) — the end-to-end byte-identity
 * proof, through the REAL WebGPU compositor, headless (Vite + puppeteer, the
 * effects_probe / filmstrip_cli_render harness).
 *
 * THE CLAIM: the sparkler renders DETERMINISTICALLY. Because a particle emitter's
 * picture is a pure closed-form function of (params, t, seed), rendering the SAME
 * (doc, t) twice must produce BYTE-IDENTICAL pixels (the CLI-reproduces-the-editor
 * requirement), and rendering at t1 vs t2 must produce DIFFERENT pixels (the
 * animation is real). This is the pipeline analogue of the manifest's
 * "render the same doc+time twice → byte-identical PNGs; t1≠t2 differ".
 *
 * We build the particle IR in NODE at an EXPLICIT time (simulateParticles +
 * particleOps + the sceneIR node wrap — no ambient clock, no plugins/index.js),
 * then render it through the actual GpuCompositor in the page and read back the
 * raw pixel buffer. Comparing raw buffers (not encoded PNGs) is a STRICTER
 * byte-identity test than comparing PNG files and needs no image decode.
 *
 * Run (exit-code gated):
 *   node src/demo_apps/PowerRP/tests/particles_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

// ── IR built in NODE through the REAL pure sim + plugin op path ──────────────
const { simulateParticles } = await import("../core/particles.js");
const { particleOps } = await import("../plugins/particles.js");
const { pushTransform, popTransform, rect } = await import("../render_gpu/ir.js");

const W = 320, H = 320;
const VIEW = { zoom: 1, panX: 0, panY: 0, dpr: 1 };

// A lively emitter centered at world (160,160): a full radial burst under
// gravity so particles spread across the frame (many pixels differ frame to
// frame — a strong signal for the t1≠t2 check).
const EMITTER = {
  rate: 60, lifetime: 2.5, originX: 0, originY: 0,
  angle: 270, spread: 360, speedMin: 40, speedMax: 130,
  gravityX: 0, gravityY: 60, sizeMin: 3, sizeMax: 7,
  fade: 1, shrink: 0.3, seed: 9,
};

/** Build the full-frame IR for the emitter at time `t`: a white background rect
 * + the particles (as ellipse ops) wrapped in a world transform placing the
 * origin at frame center. A pure function of `t` — the whole determinism story
 * in one builder. */
function frameIR(t) {
  const parts = simulateParticles(EMITTER, t);
  const ops = particleOps(parts, "#ff3366", 1); // opaque-ish red on white → high contrast
  return [
    rect({ x: 0, y: 0, w: W, h: H, fill: "#ffffff" }),
    pushTransform({ x: W / 2, y: H / 2 }),
    ...ops,
    popTransform(),
  ];
}

const T1 = 1.5, T2 = 1.9;
const irT1 = frameIR(T1);
const irT1_again = frameIR(T1); // built independently → tests build-determinism too
const irT2 = frameIR(T2);
// A dead emitter (rate 0) → no particle ops at all (a ghost renders nothing).
const irDead = [rect({ x: 0, y: 0, w: W, h: H, fill: "#ffffff" }),
  pushTransform({ x: W / 2, y: H / 2 }), ...particleOps(simulateParticles({ ...EMITTER, rate: 0 }, T1), "#ff3366", 1), popTransform()];

// Sanity in NODE before touching the GPU: the two same-t IRs are structurally
// identical; the t1/t2 IRs differ; the dead IR has only the background rect.
assert.equal(JSON.stringify(irT1), JSON.stringify(irT1_again), "same-t IR must be byte-identical");
assert.notEqual(JSON.stringify(irT1), JSON.stringify(irT2), "t1 vs t2 IR must differ");
assert.equal(irDead.length, 3, "dead emitter IR = [bgRect, push, pop] only (no particle ops)");

let viteServer, browser;
try {
  const { createServer } = await import("vite");
  viteServer = await createServer({
    configFile: join(REPO_ROOT, "vite.config.js"),
    root: REPO_ROOT,
    server: { port: 0, open: false, host: "127.0.0.1" },
  });
  await viteServer.listen();
  const pageBase = `http://127.0.0.1:${viteServer.httpServer.address().port}`;

  const { default: puppeteer } = await import("puppeteer");
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => { throw e; });
  const pageErrors = [];
  const IGNORE = [/Failed to load resource: the server responded with a status of 404/]; // bare index favicon 404 (effects_probe precedent)
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE.some((re) => re.test(m.text()))) pageErrors.push(m.text());
  });
  await page.goto(`${pageBase}/index.html`, { waitUntil: "domcontentloaded" });

  // Render each IR through the REAL GpuCompositor and return the raw pixel
  // buffer as a plain array (puppeteer-serializable). Rendering the SAME ir
  // twice on the SAME device also tests renderer stability, not just IR
  // stability — a genuine byte-identity render pair.
  const buffers = await page.evaluate(async (irs, w, h, view) => {
    const { GpuCompositor } = await import("/src/demo_apps/PowerRP/render_gpu/gpu/compositor.js");
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const gpu = await GpuCompositor.create(canvas);
    const out = {};
    for (const [name, ir] of Object.entries(irs)) {
      gpu.render(ir, view, { background: [1, 1, 1, 1] });
      const px = await gpu.readPixels(0, 0, w, h);
      out[name] = Array.from(px); // Uint8ClampedArray → plain array for transfer
    }
    return out;
  }, { t1a: irT1, t1b: irT1_again, t2: irT2, dead: irDead }, W, H, VIEW);

  let checks = 0;
  const ok = (name, cond, detail = "") => { assert.ok(cond, `${name}: ${detail}`); checks++; console.log(`  ok  ${name}`); };

  const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const diffCount = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

  // 1. SAME (doc, t) rendered twice → BYTE-IDENTICAL pixels (the core claim).
  ok("determinism: same (doc, t) → byte-identical pixels",
    eqBytes(buffers.t1a, buffers.t1b),
    `${diffCount(buffers.t1a, buffers.t1b)} bytes differed (must be 0)`);

  // 2. Different t → the picture actually MOVES (many pixels differ).
  const moved = diffCount(buffers.t1a, buffers.t2);
  ok("animation: t1 ≠ t2 → pixels differ", moved > 0, "t1 and t2 produced identical pixels (no animation)");
  ok("animation: the change is substantial (not a stray pixel)", moved > 200, `only ${moved} bytes differed`);

  // 3. Particles were actually drawn at t1 (not a blank white frame): some
  //    non-white pixel exists (the red spark color).
  let nonWhite = 0;
  for (let i = 0; i < buffers.t1a.length; i += 4) {
    if (buffers.t1a[i] < 250 || buffers.t1a[i + 1] < 250 || buffers.t1a[i + 2] < 250) nonWhite++;
  }
  ok("render: particles are visibly drawn at t1", nonWhite > 50, `only ${nonWhite} non-white pixels`);

  // 4. Dead emitter (rate 0) → a PURE WHITE frame (a ghost renders nothing).
  let deadNonWhite = 0;
  for (let i = 0; i < buffers.dead.length; i += 4) {
    if (buffers.dead[i] < 250 || buffers.dead[i + 1] < 250 || buffers.dead[i + 2] < 250) deadNonWhite++;
  }
  ok("ghost: a rate-0 emitter draws nothing (blank frame)", deadNonWhite === 0, `${deadNonWhite} non-white pixels leaked`);

  // 5. Clean render (no shader/pipeline errors).
  ok("zero page console errors", pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);

  console.log(`\nPARTICLE DETERMINISM PROBE: ${checks} checks passed`);
} finally {
  browser && await browser.close();
  viteServer && await viteServer.close();
}
