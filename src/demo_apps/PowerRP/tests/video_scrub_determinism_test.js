/**
 * VIDEO SCRUBBER determinism + sync test (headless Chromium via the browser
 * render hook — the path that AWAITS scrub seeks: gpuService.rasterizeIrPng →
 * prepareSceneScrubFrames). Self-spins a frontend-only Vite (like boot_probe),
 * loads "/?cli=1" (no editor mount, just window.__powerrp_render), and renders
 * documents built around the RGB-per-second fixture (tests/fixtures/
 * scrub_video.mp4: red 0–1s, green 1–2s, blue 2–3s).
 *
 * Asserts:
 *   (1) CORRECT + DISTINCT — a scrubber whose scrubTime tweens 0.5→2.5 across a
 *       slide shows red @alpha0, green @alpha0.5, blue @alpha1 (frame matches the
 *       evaluated time; the three are distinct).
 *   (2) DETERMINISTIC — rendering the SAME (slide, alpha) twice yields the
 *       byte-identical decoded frame (pure(document, slide, alpha)).
 *   (3) SYNC — two scrubbers on one source both bound to `= t` (a shared doc
 *       variable) show the SAME frame (frame-lockstep, no sync mechanism).
 *
 * Also writes the rendered frames to .claude_vlm_checks/ for VLM inspection.
 * Run: node src/demo_apps/PowerRP/tests/video_scrub_determinism_test.js
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const vlmDir = resolve(HERE, "../.claude_vlm_checks");
const SETTLE_MS = 5000; // Skia wasm + fonts + first video decode

const mp4 = await readFile(resolve(HERE, "fixtures/scrub_video.mp4"));
const SRC = `data:video/mp4;base64,${mp4.toString("base64")}`;
const W = 480, H = 360;

/** Pure function. One camera item filling the frame (dark bg so a missing frame
 * reads as NOT the clip's red/green/blue). */
const camera = () => ({ type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: "#222222" });

/** Pure function. A video_scrub item spanning [y, y+h] of the frame. */
const scrub = (extra) => ({ type: "video_scrub", src: SRC, x: 0, y: 0, w: W, h: H, z: 1, rotation: 0, scale: 1, active: true, scrubWrap: "clamp", ...extra });

// DOC 1 — one full-frame scrubber whose scrubTime tweens 0.5 (slide 0) → 2.5
// (slide 1 delta), so folding slide 1 at alpha 0/0.5/1 gives 0.5/1.5/2.5.
const tweenDoc = {
  meta: { name: "scrub-tween", slideW: W, slideH: H },
  slides: [
    { id: "s0", name: "A", transition: { type: "fade", seconds: 1 }, delta: { items: { cam: camera(), vs: scrub({ scrubTime: 0.5 }) }, vars: {} } },
    { id: "s1", name: "B", transition: { type: "fade", seconds: 1 }, delta: { items: { vs: { scrubTime: 2.5 } }, vars: {} } },
  ],
};

// DOC 2 — TWO scrubbers, top + bottom halves, BOTH scrubTime bound to `= t`
// (shared doc var t=1.5 → green). Frame-lockstep by construction.
const syncDoc = {
  meta: { name: "scrub-sync", slideW: W, slideH: H },
  slides: [{
    id: "s0", name: "A", transition: { type: "fade", seconds: 1 },
    delta: {
      items: {
        cam: camera(),
        top: scrub({ y: 0, h: H / 2, scrubTime: "= t", z: 1 }),
        bot: scrub({ y: H / 2, h: H / 2, scrubTime: "= t", z: 2 }),
      },
      vars: { t: 1.5 },
    },
  }],
};

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });

let failed = false;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { console.error("pageerror:", e.message); failed = true; });
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|\/api\/|ECONNREFUSED|crypto\.randomUUID|Credentials API/.test(m.text())) console.error("console.error:", m.text()); });
  await page.goto(`${baseUrl}/?cli=1`, { waitUntil: "networkidle0" });
  await page.waitForFunction("typeof window.__powerrp_render === 'function'", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // The in-page renderer: __powerrp_render → PNG data URL → decode → ImageData.
  // Returns {samples:[{name,rgb}], hash} for the requested sample points.
  await page.exposeFunction("noop", () => {});
  const renderSamples = async (doc, opts, points) =>
    page.evaluate(async (doc, opts, points) => {
      const url = await window.__powerrp_render(doc, opts);
      const img = await createImageBitmap(await (await fetch(url)).blob());
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const all = ctx.getImageData(0, 0, c.width, c.height);
      let hash = 2166136261 >>> 0; // FNV-1a over the full decoded frame
      for (let i = 0; i < all.data.length; i++) { hash ^= all.data[i]; hash = Math.imul(hash, 16777619) >>> 0; }
      const samples = points.map(({ name, x, y }) => {
        const p = ctx.getImageData(x, y, 1, 1).data;
        return { name, rgb: [p[0], p[1], p[2]] };
      });
      return { samples, hash, dataUrl: url };
    }, doc, opts, points);

  const dominant = ([r, g, b]) => (r > g && r > b ? "red" : g > r && g > b ? "green" : "blue");
  const center = { name: "center", x: Math.floor(W / 2), y: Math.floor(H / 2) };
  await mkdir(vlmDir, { recursive: true });
  const savePng = async (file, dataUrl) => writeFile(resolve(vlmDir, file), Buffer.from(dataUrl.split(",")[1], "base64"));

  // (1) CORRECT + DISTINCT across the tween.
  const t0 = await renderSamples(tweenDoc, { slide: 1, alpha: 0, width: W, height: H }, [center]);
  const t1 = await renderSamples(tweenDoc, { slide: 1, alpha: 0.5, width: W, height: H }, [center]);
  const t2 = await renderSamples(tweenDoc, { slide: 1, alpha: 1, width: W, height: H }, [center]);
  await savePng("scrub_t0.5_red.png", t0.dataUrl);
  await savePng("scrub_t1.5_green.png", t1.dataUrl);
  await savePng("scrub_t2.5_blue.png", t2.dataUrl);
  const c0 = dominant(t0.samples[0].rgb), c1 = dominant(t1.samples[0].rgb), c2 = dominant(t2.samples[0].rgb);
  console.log(`(1) tween: alpha0→${c0} ${t0.samples[0].rgb}  alpha0.5→${c1} ${t1.samples[0].rgb}  alpha1→${c2} ${t2.samples[0].rgb}`);
  assert.equal(c0, "red", "scrubTime 0.5 should decode the red segment");
  assert.equal(c1, "green", "scrubTime 1.5 should decode the green segment");
  assert.equal(c2, "blue", "scrubTime 2.5 should decode the blue segment");
  assert.ok(c0 !== c1 && c1 !== c2, "the three times must be distinct frames");

  // (2) DETERMINISTIC — same (slide, alpha) twice → identical decoded frame.
  const d1 = await renderSamples(tweenDoc, { slide: 1, alpha: 0.5, width: W, height: H }, [center]);
  const d2 = await renderSamples(tweenDoc, { slide: 1, alpha: 0.5, width: W, height: H }, [center]);
  console.log(`(2) determinism: hashA=${d1.hash} hashB=${d2.hash} equal=${d1.hash === d2.hash}`);
  assert.equal(d1.hash, d2.hash, "same (slide, alpha) must render an identical frame");

  // (3) SYNC — two scrubbers bound to `= t` show the SAME frame.
  const sync = await renderSamples(syncDoc, { slide: 0, alpha: 1, width: W, height: H }, [
    { name: "top", x: Math.floor(W / 2), y: Math.floor(H / 4) },
    { name: "bot", x: Math.floor(W / 2), y: Math.floor((3 * H) / 4) },
  ]);
  await savePng("scrub_sync_two_green.png", sync.dataUrl);
  const [top, bot] = sync.samples;
  console.log(`(3) sync: top→${dominant(top.rgb)} ${top.rgb}  bot→${dominant(bot.rgb)} ${bot.rgb}`);
  assert.deepEqual(top.rgb, bot.rgb, "two scrubbers bound to = t must show the identical frame");
  assert.equal(dominant(top.rgb), "green", "= t (t=1.5) should decode the green segment");

  console.log("\nOK video_scrub_determinism_test — correct/distinct, deterministic, and synced. VLM frames in .claude_vlm_checks/");
} catch (e) {
  console.error("\nFAIL video_scrub_determinism_test:", e?.message ?? e);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
