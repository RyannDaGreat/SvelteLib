/**
 * FADE STARVATION PROBE (diagnostic — OpusJ / Round 14.7 REOPENED).
 *
 * Tests the SCALE hypothesis: fade_appear_probe crossfades beautifully at
 * 400x400@dpr1, but paintFade re-renders BOTH endpoint snapshots + does two
 * GPU readbacks PER EMITTED FRAME through gpuService's serialized queue. At the
 * user's realistic present size (fullscreen retina) each crossfade frame costs
 * two multi-megapixel renders + readbacks; if that latency approaches the fade
 * duration, few/zero mid frames land on screen — the fade IS computed but the
 * user SEES a flick.
 *
 * Same appear/disappear deck, realistic viewport (1470x956 @ dpr 2 — a 14"
 * retina laptop, the user's hardware class), the DEFAULT 0.5s fade (what a
 * fresh transition has).
 *
 * HISTORY: as a diagnostic this probe CONFIRMED the root cause — 0 distinct
 * blend levels on screen (pure A until ~420ms, then pure B: the user's flick)
 * before transitionRender.js memoized the alpha-independent endpoint snapshots
 * (fadeSnapshots). NOW A REGRESSION GATE: asserts >=3 distinct blend levels
 * land on screen at this scale, so un-memoizing the snapshots (or any change
 * that re-introduces per-frame double render+readback) fails loudly.
 *
 *   node src/demo_apps/PowerRP/tests/fade_starvation_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

const strip = (x, fill) => ({ type: "rect", x, y: 0, w: 50, h: 200, z: 1, rotation: 0, scale: 1, active: true, fill, stroke: null, strokeWidth: 0, cornerRadius: 0, opacity: 1, rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" } });
const doc = {
  meta: { name: "fade-starvation-probe", slideW: 200, slideH: 200 },
  slides: [
    {
      id: "sA",
      name: "Slide A",
      transition: { type: "tween", seconds: 0.5, curve: "smooth", sound: null },
      delta: {
        items: {
          cam: { type: "camera", name: "Camera", x: 0, y: 0, w: 200, h: 200, z: 1000, rotation: 0, scale: 1, active: true, background: "#000000" },
          only_a: { ...strip(10, "#ff0000"), name: "OnlyA" },
          stay: { ...strip(75, "#808080"), name: "Stay" },
        },
      },
    },
    {
      id: "sB",
      name: "Slide B",
      transition: { type: "fade", seconds: 0.5, curve: "linear", sound: null }, // the DEFAULT duration
      delta: { items: { only_a: { active: false }, only_b: { ...strip(140, "#0000ff"), name: "OnlyB" } } },
    },
  ],
};

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1470, height: 956, deviceScaleFactor: 2 }); // 14" retina class
  const ignore = (t) => /zero-sized canvas/.test(t) || /PowerRP repair: item .* was missing/.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !ignore(m.text())) errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), JSON.stringify(doc));
  await page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));

  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; window.__powerrp_app.mode = "present"; });
  await new Promise((r) => setTimeout(r, 1000)); // GPU init at full size

  // Letterboxed camera fit: 200x200 world in 1470x956 → zoom = 956/200 = 4.78,
  // cam width 956 centered at x (1470-956)/2 = 257. Strip centers (world x
  // 35/100/165) → screen 257 + 4.78*x: a≈424, stay≈735, b≈1046; y 478.
  const zoom = 956 / 200, offX = (1470 - 956) / 2;
  const S = { a: [offX + 35 * zoom, 478], stay: [offX + 100 * zoom, 478], b: [offX + 165 * zoom, 478] };

  const sampleAt = async () => {
    const b64 = await page.screenshot({ encoding: "base64" });
    return page.evaluate(async (dataUrl, S) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = (x, y) => [...ctx.getImageData(Math.round(x * (c.width / innerWidth)), Math.round(y * (c.height / innerHeight)), 1, 1).data];
      return { a: px(S.a[0], S.a[1]), stay: px(S.stay[0], S.stay[1]), b: px(S.b[0], S.b[1]) };
    }, `data:image/png;base64,${b64}`, S);
  };

  const before = await sampleAt();
  await page.keyboard.press("ArrowRight"); // the 0.5s fade
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1400) samples.push({ t: Date.now() - t0, ...(await sampleAt()) }); // sample as fast as screenshots allow
  const after = await sampleAt();

  const partial = (v) => v > 40 && v < 215;
  const crossfades = samples.filter((s) => partial(s.a[0]) && partial(s.b[2]));
  const distinctBlends = new Set(crossfades.map((s) => `${s.a[0]}|${s.b[2]}`)).size;

  console.log(`STARVATION DIAG @1470x956 dpr2, 0.5s fade:`);
  console.log(`  samples in 1.4s: ${samples.length}; genuine crossfade samples: ${crossfades.length}; DISTINCT blend levels: ${distinctBlends}`);
  console.log(`  before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  console.log(`  series (t, redA, blueB): ${JSON.stringify(samples.map((s) => [s.t, s.a[0], s.b[2]]))}`);

  const near = (v, t, tol = 24) => Math.abs(v - t) <= tol;
  if (!(near(before.a[0], 255) && near(after.b[2], 255))) throw new Error(`STARVATION PROBE FAIL: endpoints wrong — before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  if (errors.length) throw new Error(`Console errors:\n${errors.join("\n")}`);
  // THE GATE: a fullscreen-retina 0.5s fade must actually blend on screen.
  // Pre-memo this was 0 (the flick); the memoized path lands a fresh blend per
  // screenshot sample. 3 = several visibly distinct steps, tolerant of headless
  // screenshot latency eating samples.
  if (distinctBlends < 3) throw new Error(`STARVATION PROBE FAIL: only ${distinctBlends} distinct on-screen blend levels at realistic scale — the fade is flicking again (endpoint-snapshot memo regressed?)`);
  console.log(`FINDING: ${distinctBlends} distinct blend levels landed — fade genuinely blends at realistic scale.`);
} finally {
  await browser.close();
  await server.close();
}
