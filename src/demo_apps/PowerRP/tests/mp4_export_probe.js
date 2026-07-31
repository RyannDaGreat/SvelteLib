/**
 * MP4 EXPORT PROBE — self-spins a FRONTEND-ONLY Vite over http://127.0.0.1 (a
 * SECURE CONTEXT, so WebCodecs VideoEncoder is available), loads the editor,
 * builds a tiny 2-slide deck with a numeric tween (a rect that slides), and runs
 * a REAL client-side MP4 export end to end. Verifies:
 *   - it produces a valid, playable .mp4 (ftyp/moov/mdat boxes; correct sample
 *     count = timeline frame count; correct width/height; ~expected duration);
 *   - first/middle/last frames DECODE and are saved to .claude_vlm_checks/ for a
 *     VLM to confirm the rect is left / middle / right (deterministic tween);
 *   - MOTION BLUR (samples>1) also yields a valid .mp4, and its mid-transition
 *     frame is saved so a VLM can confirm the moving rect is smeared vs the crisp
 *     single-sample frame;
 *   - OFFLINE: there is NO backend at all (frontend-only Vite), so a successful
 *     export proves the encode needs no server round-trip.
 * cwd-independent. Exits non-zero on any failure.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const OUT_DIR = resolve(HERE, "../.claude_vlm_checks");
const SETTLE_MS = 4000; // Skia wasm + fonts + first paint

// ── Node-side MP4 box helpers (verify container structure without decoding) ──
/** Pure. Top-level box types present in an ISO-BMFF buffer (size+type walk). */
function topLevelBoxes(buf) {
  const types = [];
  let p = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (p + 8 <= buf.length) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    types.push(type);
    if (size === 0) break; // to EOF
    if (size === 1) size = Number(dv.getBigUint64(p + 8)); // 64-bit size
    if (size < 8) break;
    p += size;
  }
  return types;
}
/** Pure. The H.264 sample count from the FIRST 'stsz' box (recursive byte scan);
 *  null if none. stsz: [size(4) 'stsz' version+flags(4) sample_size(4) count(4)]. */
function sampleCount(buf) {
  for (let p = 0; p + 12 <= buf.length; p++) {
    if (buf[p] === 0x73 && buf[p + 1] === 0x74 && buf[p + 2] === 0x73 && buf[p + 3] === 0x7a) {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      return dv.getUint32(p + 12); // 'stsz' at p; count is 12 bytes past the type
    }
  }
  return null;
}

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

// `no.*adapter|adapters` is this container's headless graphics reality (the
// tests/escape_propagation_probe.js allowlist precedent): the fixture's video widgets
// probe for an adapter the software renderer does not expose and fall back. Named
// specifically — the gate still fails on anything else.
const IGNORE = /Failed to load resource|thumbnail|\/api\/|listAssets|could not list|500 Internal|ECONNREFUSED|crypto\.randomUUID|Credentials API|preserveAspect|autosave|no.*adapter|adapters/i;
const errors = [];
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !IGNORE.test(m.text())) errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.goto(baseUrl, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  const result = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    if (!app) throw new Error("app not initialized");

    // ── Build a 2-slide deck: a rect that slides left→right across a 1s tween ──
    app.addItem({ type: "rect", x: 120, y: 300, w: 280, h: 220, fill: "#e0245e" });
    const rectId = app.selection;
    app.addSlide();          // new slide after slide 0
    app.slideIndex = 1;      // go to it
    app.setPreview([[["items", rectId, "x"], 900]]);
    app.commitPreview();     // keyframe x=900 on slide 1 → tween slides the rect
    const slide1Id = app.doc.slides[1].id;
    app.setTransitionType(slide1Id, "tween");
    app.setTransitionProp(slide1Id, "seconds", 1);
    app.slideIndex = 0;

    const W = 320, H = 180, FPS = 10, HOLD = 0.5, BITRATE = 900000;
    // Timeline: hold 0.5s (5f) + transition 1s (10f) + hold 0.5s (5f) = 2s → 20f.
    const opts = { width: W, height: H, fps: FPS, bitrate: BITRATE, holdSeconds: HOLD, includeTransitions: true, background: "#101018", download: false };

    /** Decode `times` (seconds) of an mp4 blob to PNG dataURLs via <video>. */
    async function decode(blob, times) {
      const url = URL.createObjectURL(blob);
      const v = document.createElement("video");
      v.muted = true;
      v.src = url;
      await new Promise((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error("video load error (H.264 decode unsupported?)")); setTimeout(() => rej(new Error("video load timeout")), 8000); });
      const meta = { w: v.videoWidth, h: v.videoHeight, duration: v.duration };
      const c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext("2d");
      const pngs = [];
      for (const t of times) {
        await new Promise((res, rej) => { v.onseeked = () => res(); v.onerror = () => rej(new Error("seek error")); setTimeout(() => rej(new Error("seek timeout")), 8000); v.currentTime = t; });
        ctx.drawImage(v, 0, 0);
        pngs.push(c.toDataURL("image/png"));
      }
      URL.revokeObjectURL(url);
      return { meta, pngs };
    }

    // CRISP export (samples = 1).
    const crisp = await app.exportMp4({ ...opts, samples: 1 });
    const crispBuf = new Uint8Array(await crisp.arrayBuffer());
    const crispDec = await decode(crisp, [0.05, 1.0, 1.9]); // first / mid-transition / last

    // MOTION-BLUR export (samples = 6) — same deck; grab the mid-transition frame.
    const blur = await app.exportMp4({ ...opts, samples: 6 });
    const blurBuf = new Uint8Array(await blur.arrayBuffer());
    const blurDec = await decode(blur, [1.0]);

    return {
      isSecureContext: window.isSecureContext,
      mime: crisp.type,
      crispB64: btoa(String.fromCharCode(...crispBuf)),
      blurB64: btoa(String.fromCharCode(...blurBuf)),
      decodeMeta: crispDec.meta,
      pngs: { first: crispDec.pngs[0], mid: crispDec.pngs[1], last: crispDec.pngs[2], midBlur: blurDec.pngs[0] },
      expect: { W, H, frames: Math.round((HOLD + 1 + HOLD) * FPS), durationSec: (HOLD + 1 + HOLD) },
    };
  });

  // ── Node-side assertions ──
  await mkdir(OUT_DIR, { recursive: true });
  const crisp = Buffer.from(result.crispB64, "base64");
  const blur = Buffer.from(result.blurB64, "base64");
  const boxes = topLevelBoxes(crisp);
  const samplesCrisp = sampleCount(crisp);
  const samplesBlur = sampleCount(blur);

  for (const [name, dataUrl] of Object.entries(result.pngs)) {
    await writeFile(resolve(OUT_DIR, `mp4_${name}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
  }

  const checks = [];
  const need = (cond, msg) => { checks.push([cond, msg]); if (!cond) exitCode = 1; };
  need(result.isSecureContext === true, "secure context (WebCodecs available)");
  need(result.mime === "video/mp4", `blob mime is video/mp4 (got ${result.mime})`);
  need(boxes.includes("ftyp") && boxes.includes("moov") && boxes.includes("mdat"), `MP4 boxes present (got ${boxes.join(",")})`);
  need(boxes.indexOf("moov") < boxes.indexOf("mdat"), "fastStart: moov BEFORE mdat (seekable)");
  need(samplesCrisp === result.expect.frames, `frame count = ${result.expect.frames} (stsz says ${samplesCrisp})`);
  need(samplesBlur === result.expect.frames, `motion-blur frame count = ${result.expect.frames} (stsz says ${samplesBlur})`);
  need(result.decodeMeta.w === result.expect.W && result.decodeMeta.h === result.expect.H, `decoded dims ${result.expect.W}×${result.expect.H} (got ${result.decodeMeta.w}×${result.decodeMeta.h})`);
  need(Math.abs(result.decodeMeta.duration - result.expect.durationSec) < 0.35, `duration ≈ ${result.expect.durationSec}s (got ${result.decodeMeta.duration?.toFixed?.(2)})`);
  need(crisp.length > 1000, `non-trivial crisp file (${crisp.length} bytes)`);
  need(blur.length > 1000, `non-trivial blur file (${blur.length} bytes)`);

  console.log("\nMP4 EXPORT PROBE");
  for (const [ok, msg] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
  console.log(`  crisp=${crisp.length}B  blur=${blur.length}B  boxes=[${boxes.join(",")}]`);
  console.log(`  VLM frames written to ${OUT_DIR}/mp4_{first,mid,last,midBlur}.png`);
  if (errors.length) { console.log("\nCAPTURED APP ERRORS:\n" + errors.join("\n")); exitCode = 1; }
  console.log(exitCode === 0 ? "\nMP4 EXPORT OK" : "\nMP4 EXPORT FAILED");
} catch (e) {
  console.error("PROBE ERROR:", e.stack || e.message);
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
  process.exit(exitCode);
}
