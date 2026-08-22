/**
 * WHERE DOES A BROWSER-BACKEND RENDER FRAME ACTUALLY SPEND ITS TIME?
 *
 * Nobody had measured this. The browser backend does, per output frame:
 *     GPU render → GPU→CPU readback → PNG encode → HTTP POST → server disk
 * and it is SERIALIZED: frame N+1 does not start rendering until frame N has
 * finished uploading. The plan to replace the PNG+POST with an in-page WASM H.264
 * encoder is only worth anything if PNG+POST is where the time goes, so this
 * probe measures the stages instead of assuming them, and prints the numbers that
 * decide it. If the WASM encode turns out to be slower than the PNG+upload it
 * replaces, this is the file that says so.
 *
 * WHAT IS MEASURED (all on a REAL plain-HTTP LAN origin — see
 * tests/browser_render_harness.js for why loopback would be a lie):
 *   render      createLetterboxFrameRenderer(index, alpha) end to end. This is
 *               Skia paint + readPixels + putImageData + the letterbox drawImage;
 *               it cannot be split further without instrumenting the shared
 *               gpuService, and it is COMMON TO BOTH paths, so it does not affect
 *               the comparison.
 *   readback    an ISOLATED measurement of the same-size Skia readPixels, so the
 *               readback's share of `render` is a fact rather than a guess.
 *   getImageData the cost of getting RGBA out of the finished canvas — what the
 *               WASM encoder needs INSTEAD of a PNG.
 *   png         canvasToPngBlob — the exact function serverMp4Encoder calls.
 *   post        postRenderJobFrame to a REAL backend accepting a REAL job.
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/browser_encode_measure_probe.js
 */

import { bootProbe } from "./browser_render_harness.js";
import { PROBE_WIDTH, PROBE_HEIGHT, PROBE_FPS, probeParams } from "./browser_render_fixture.js";

/** Output sizes to measure. The pipeline's stage mix is resolution-dependent
 *  (PNG and readback scale with pixels; the POST's fixed overhead does not), so
 *  one size would not answer the question. */
const SIZES = [
  { width: 320, height: 240, label: "320x240" },
  { width: 1280, height: 720, label: "1280x720" },
  { width: 1920, height: 1080, label: "1920x1080" },
];
/** Frames timed per size. Enough for a median; the first is discarded as warm-up. */
const FRAMES_PER_SIZE = 8;
/** Frames per encoder in the A/B wall-clock section (plus one warm-up outside it). */
const AB_FRAMES = 20;
/** Isolated-readback repetitions per size. */
const READBACK_REPS = 6;
const PROJECT = "EncodeMeasure";

/** Pure function. The median of `xs` (numbers). Empty → NaN.
 *  @example median([3, 1, 2]) // 2
 *  @example median([4, 1, 3, 2]) // 2.5 */
function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Pure function. `n` fixed to 2 decimals, right-padded into `w` columns.
 *  @example cell(1.5, 8) // "1.50    " */
function cell(n, w) {
  return (Number.isFinite(n) ? n.toFixed(2) : "—").padEnd(w);
}

const probe = await bootProbe();
console.log(`Probe origin: ${probe.baseUrl}  (isSecureContext = false, asserted)`);

try {
  // ── The capability matrix, re-measured here rather than trusted ─────────────
  const caps = await probe.page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    WebAssembly: typeof WebAssembly !== "undefined",
    OffscreenCanvas: typeof OffscreenCanvas !== "undefined",
    SharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    indexedDB: typeof indexedDB !== "undefined" && indexedDB !== null,
    VideoEncoder: typeof VideoEncoder !== "undefined",
    opfs: typeof navigator.storage?.getDirectory === "function",
    webLocks: typeof navigator.locks !== "undefined",
    randomUUID: typeof crypto?.randomUUID === "function",
  }));
  console.log("\nCAPABILITIES on this plain-HTTP LAN origin");
  for (const [k, v] of Object.entries(caps)) console.log(`  ${String(v).toUpperCase().padEnd(6)} ${k}`);

  // A real project + a real client-backend job, so the POST is a real POST.
  const put = await fetch(`http://127.0.0.1:${probe.backend.port}/api/project/${PROJECT}/`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: { name: PROJECT }, slides: [] }),
  });
  if (!put.ok) throw new Error(`probe: could not create the project: ${put.status}`);

  const rows = [];
  for (const size of SIZES) {
    const submit = await fetch(`http://127.0.0.1:${probe.backend.port}/api/render-jobs/${PROJECT}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Measure ${size.label}`,
        backend: "client",
        framesTotal: FRAMES_PER_SIZE,
        params: probeParams(size),
        doc: { meta: { name: PROJECT }, slides: [] },
      }),
    });
    const { job, error } = await submit.json();
    if (!submit.ok) throw new Error(`probe: job submit failed: ${error}`);

    const out = await probe.page.evaluate(async (u, size, frames, reps, project, jobId) => {
      const { createRegistry } = await import(u.registry);
      const { createCommands } = await import(u.commands);
      const { registerAll } = await import(u.plugins);
      const { repairedDocument } = await import(u.document);
      const { loadFonts } = await import(u.fonts);
      const { probeDoc } = await import(u.fixture);
      const { createLetterboxFrameRenderer } = await import(u.transitionRender);
      const { canvasToPngBlob } = await import(u.serverEncoder);
      const { postRenderJobFrame } = await import(u.projectApi);
      const { setParticleTimeOverride } = await import(u.particleClock);
      const { SkiaSurface } = await import(u.surface);
      const { ensureCanvasKit } = await import(u.canvaskit);

      await loadFonts();
      const registry = createRegistry();
      registerAll(registry, createCommands());
      const { doc, reports } = repairedDocument(probeDoc(registry), registry);
      if (reports.length) throw new Error(`probe fixture needed ${reports.length} repair(s): ${JSON.stringify(reports)}`);

      const renderFrame = createLetterboxFrameRenderer({
        doc, registry, width: size.width, height: size.height, background: "#000000",
      });

      // ── ISOLATED READBACK: the same pixel count off a real GL surface. ───────
      const ck = await ensureCanvasKit();
      const host = document.createElement("canvas");
      host.width = size.width;
      host.height = size.height;
      const skia = await SkiaSurface.create(host);
      if (!skia.grContext) throw new Error("probe: no grContext — the readback measurement would not be a GPU readback");
      const readbackMs = [];
      const target = skia._makeSurface(size.width, size.height);
      if (!target) throw new Error("probe: MakeRenderTarget returned null");
      for (let i = 0; i < reps; i++) {
        const canvas = target.getCanvas();
        canvas.clear(ck.Color4f(0.1, 0.2, 0.3, 1));
        target.flush();
        const t0 = performance.now();
        const px = canvas.readPixels(0, 0, {
          width: size.width, height: size.height,
          colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB,
        });
        readbackMs.push(performance.now() - t0);
        if (!px) throw new Error("probe: readPixels returned null");
      }
      target.delete();
      skia.dispose?.();

      // ── THE PIPELINE, stage by stage ────────────────────────────────────────
      const stages = { render: [], getImageData: [], png: [], post: [] };
      let pngBytes = 0;
      for (let i = 0; i < frames; i++) {
        setParticleTimeOverride(i / size.fps);
        const t0 = performance.now();
        const canvas = await renderFrame(i % 2, 1);
        const t1 = performance.now();
        canvas.getContext("2d").getImageData(0, 0, size.width, size.height);
        const t2 = performance.now();
        const blob = await canvasToPngBlob(canvas);
        const t3 = performance.now();
        await postRenderJobFrame(project, jobId, i, blob);
        const t4 = performance.now();
        if (i > 0) { // discard the warm-up frame
          stages.render.push(t1 - t0);
          stages.getImageData.push(t2 - t1);
          stages.png.push(t3 - t2);
          stages.post.push(t4 - t3);
          pngBytes += blob.size;
        }
      }
      setParticleTimeOverride(null);
      return { stages, readbackMs, pngBytes, timedFrames: frames - 1 };
    }, {
      registry: probe.fsUrl("core/registry.js"),
      commands: probe.fsUrl("core/commands.js"),
      document: probe.fsUrl("core/document.js"),
      plugins: probe.fsUrl("plugins/index.js"),
      fonts: probe.fsUrl("web/fontLoader.js"),
      fixture: probe.fsUrl("tests/browser_render_fixture.js"),
      transitionRender: probe.fsUrl("web/transitionRender.js"),
      serverEncoder: probe.fsUrl("web/serverMp4Encoder.js"),
      projectApi: probe.fsUrl("web/projectApi.js"),
      particleClock: probe.fsUrl("render_gpu/particle_clock.js"),
      surface: probe.fsUrl("render_gpu/skia/browser_surface.js"),
      canvaskit: probe.fsUrl("render_gpu/skia/browser_canvaskit.js"),
    }, { ...size, fps: PROBE_FPS }, FRAMES_PER_SIZE, READBACK_REPS, PROJECT, job.id);

    rows.push({ size, out });
  }

  // ── The table ───────────────────────────────────────────────────────────────
  console.log(`\nPER-FRAME MEDIANS (ms), ${FRAMES_PER_SIZE - 1} timed frames per size, plain-HTTP LAN origin`);
  console.log("  size           render   readback  getImgData  PNGenc    POST     PNG+POST  avg PNG KiB");
  for (const { size, out } of rows) {
    const s = out.stages;
    const png = median(s.png);
    const post = median(s.post);
    console.log(
      `  ${size.label.padEnd(14)} ${cell(median(s.render), 8)} ${cell(median(out.readbackMs), 9)} ` +
      `${cell(median(s.getImageData), 11)} ${cell(png, 9)} ${cell(post, 8)} ${cell(png + post, 9)} ` +
      `${(out.pngBytes / out.timedFrames / 1024).toFixed(0)}`,
    );
  }

  console.log("\nSHARE OF THE SERIALIZED PER-FRAME COST");
  for (const { size, out } of rows) {
    const s = out.stages;
    const r = median(s.render), png = median(s.png), post = median(s.post);
    const total = r + png + post;
    console.log(`  ${size.label.padEnd(14)} total ${total.toFixed(1)} ms  =  render ${(100 * r / total).toFixed(0)}%  +  PNG ${(100 * png / total).toFixed(0)}%  +  POST ${(100 * post / total).toFixed(0)}%`);
  }
  console.log("  (Caveat, stated rather than hidden: the loop above also calls getImageData");
  console.log("   between the render and the PNG, which forces the GPU sync early and can");
  console.log("   flatter the PNG stage. The A/B below has no such instrumentation inside a");
  console.log("   frame and is the number to trust for the comparison.)");

  // ── THE A/B: both real pipelines, wall clock, nothing measured in between ────
  console.log(`\nA/B WALL CLOCK — the two browser encoders on the same deck, ${AB_FRAMES} frames each`);
  console.log("  size           upload (PNG+POST)   wasm (in-page)      winner");
  for (const size of SIZES) {
    const submit = await fetch(`http://127.0.0.1:${probe.backend.port}/api/render-jobs/${PROJECT}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `AB ${size.label}`, backend: "client", framesTotal: AB_FRAMES,
        params: probeParams(size), doc: { meta: { name: PROJECT }, slides: [] },
      }),
    });
    const { job, error } = await submit.json();
    if (!submit.ok) throw new Error(`probe: A/B job submit failed: ${error}`);

    const ab = await probe.page.evaluate(async (u, size, frames, project, jobId, fps) => {
      const { createRegistry } = await import(u.registry);
      const { createCommands } = await import(u.commands);
      const { registerAll } = await import(u.plugins);
      const { repairedDocument } = await import(u.document);
      const { loadFonts } = await import(u.fonts);
      const { probeDoc } = await import(u.fixture);
      const { createLetterboxFrameRenderer } = await import(u.transitionRender);
      const { createJobFrameEncoder } = await import(u.serverEncoder);
      const { createWasmMp4Encoder } = await import(u.mp4Encoder);
      const { setParticleTimeOverride } = await import(u.particleClock);

      await loadFonts();
      const registry = createRegistry();
      registerAll(registry, createCommands());
      const { doc } = repairedDocument(probeDoc(registry), registry);
      const renderFrame = createLetterboxFrameRenderer({
        doc, registry, width: size.width, height: size.height, background: "#000000",
      });

      /** Command. Walk `frames` frames into `encoder`, exactly as exportVideo does. */
      const run = async (encoder) => {
        // One warm-up frame outside the timing: the first render of a size compiles
        // shaders and allocates surfaces, which is a startup cost, not a per-frame one.
        setParticleTimeOverride(0);
        await encoder.addFrame(await renderFrame(0, 1), { timestamp: 0, duration: 0 });
        const t0 = performance.now();
        for (let i = 1; i <= frames; i++) {
          setParticleTimeOverride(i / fps);
          await encoder.addFrame(await renderFrame(i % 2, 1), { timestamp: 0, duration: 0 });
        }
        const ms = performance.now() - t0;
        setParticleTimeOverride(null);
        return ms / frames;
      };

      const uploadMs = await run(await createJobFrameEncoder({ project, jobId }));
      const wasm = await createWasmMp4Encoder({
        width: size.width, height: size.height, fps, quality: "medium",
      });
      const wasmMs = await run(wasm);
      wasm.abort(); // no movie needed — this measures throughput, not output
      return { uploadMs, wasmMs };
    }, {
      registry: probe.fsUrl("core/registry.js"),
      commands: probe.fsUrl("core/commands.js"),
      document: probe.fsUrl("core/document.js"),
      plugins: probe.fsUrl("plugins/index.js"),
      fonts: probe.fsUrl("web/fontLoader.js"),
      fixture: probe.fsUrl("tests/browser_render_fixture.js"),
      transitionRender: probe.fsUrl("web/transitionRender.js"),
      serverEncoder: probe.fsUrl("web/serverMp4Encoder.js"),
      mp4Encoder: probe.fsUrl("web/mp4Encoder.js"),
      particleClock: probe.fsUrl("render_gpu/particle_clock.js"),
    }, size, AB_FRAMES, PROJECT, job.id, PROBE_FPS);

    const ratio = ab.wasmMs / ab.uploadMs;
    const winner = ratio < 1
      ? `wasm by ${(1 / ratio).toFixed(2)}x`
      : `upload by ${ratio.toFixed(2)}x`;
    console.log(`  ${size.label.padEnd(14)} ${`${ab.uploadMs.toFixed(2)} ms/frame`.padEnd(19)} ${`${ab.wasmMs.toFixed(2)} ms/frame`.padEnd(19)} ${winner}`);
  }

  if (probe.errors.length) {
    console.log("\nPAGE ERRORS");
    for (const e of probe.errors) console.log(`  ${e}`);
  }
  console.log(`\nNote: PROBE_WIDTH/HEIGHT of the fixture deck are ${PROBE_WIDTH}x${PROBE_HEIGHT}; the deck is rendered at each measured size through the same letterbox composite the real job uses.`);
} finally {
  await probe.stop();
}
