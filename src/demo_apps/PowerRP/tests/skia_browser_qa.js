/**
 * Browser QA smoke — the "always test every render surface" gate.
 *
 * Exercises the WHOLE editor over a served origin in headless Chromium: loads,
 * adds EVERY widget type (rect/circle/text/arrow + the backdrop/effect ones:
 * magnifier/blur/crop), then ENTERS PRESENT MODE — and fails on ANY uncaught
 * exception or WebGPU/renderer console error at ANY step. This is the test that
 * would have caught the PresentMode WebGPU crash (it never entered present mode
 * before). Screenshots each phase for a VLM look.
 *
 * Run (dev server must be up):
 *   node tests/skia_browser_qa.js [http://localhost:PORT]
 * URL defaults to the localhost URL in .claude_logs/devserver.log.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import { STILL_VIDEO_MP4_DATA_URI } from "./fixtures/still_video.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, "..", "..", "..", "..", "..", ".claude_logs", "devserver.log");
const SHOTS = path.join(HERE, "..", "..", "..", "..", "..", ".claude_vlm_checks");
const URL = process.argv[2] || fs.readFileSync(LOG, "utf8").match(/https?:\/\/localhost:\d+/)[0];

// A console.error/pageerror matching this is a HARD failure (a pageerror always is).
const DANGER = /webgpu|navigator\.gpu|no adapter|requestadapter|not implemented|uncaught|paintir|skia.*(null|failed)|is not a function|cannot read/i;

const errors = [];
function since(mark) { return errors.slice(mark); }

async function clickByTitle(page, title) {
  const ok = await page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((el) => (el.title || el.getAttribute("aria-label")) === t);
    if (b) { b.click(); return true; }
    return false;
  }, title);
  if (!ok) throw new Error(`QA: toolbar button "${title}" not found`);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  const steps = [];
  const step = async (name, fn) => {
    const mark = errors.length;
    await fn();
    await new Promise((r) => setTimeout(r, 900));
    const dangerous = since(mark).filter((e) => e.startsWith("pageerror:") || DANGER.test(e));
    steps.push({ name, newErrors: since(mark).length, dangerous });
  };

  // Hard pixel assertions (the media-render gate): distinct from the console
  // error tracking, these FAIL the run if a placed image never shows up.
  const asserts = [];
  const assertRenders = (name, ok, detail) => asserts.push({ name, ok, detail });

  await step("load", () => page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 }));
  await new Promise((r) => setTimeout(r, 3500)); // Skia wasm + fonts + first paint
  for (const tool of ["Add Rectangle", "Add Circle", "Add Text", "Add Arrow", "Add Magnifier", "Add Blur Layer", "Add Crop Box"]) {
    await step(tool, () => clickByTitle(page, tool));
  }

  // ── MEDIA: place an IMAGE + a VIDEO and PROVE the image renders ──────────────
  // This is the regression gate for the "media doesn't render in Skia" defect:
  // the media map (ref → CanvasKit.Image) must be built and passed to paint_skia.
  // A distinctive magenta image is inserted via the asset API (centered on the
  // camera by #viewCenter, so it is deterministically on-screen and in-frame),
  // plus a real still MP4 (exercises the video current-frame grab path). We then
  // read the MAIN WebGL canvas (element screenshot decoded in-page — a headless
  // WebGL canvas will not read back via toDataURL) AND the slide THUMBNAIL
  // (gpuService pixel path) and assert the magenta pixels are present in both.
  await step("Add Image + Video (media)", async () => {
    await page.evaluate(async (videoUri) => {
      const app = window.__powerrp_app;
      if (!app) throw new Error("QA: window.__powerrp_app missing (cannot place media)");
      const gen = document.createElement("canvas");
      gen.width = 400; gen.height = 300;
      const gc = gen.getContext("2d");
      gc.fillStyle = "rgb(255,0,255)"; gc.fillRect(0, 0, 400, 300); // distinctive magenta
      await app.insertImageAsset(gen.toDataURL("image/png"));
      await app.insertVideoAsset(videoUri); // real still MP4 → current-frame grab path
    }, STILL_VIDEO_MP4_DATA_URI);
    await new Promise((r) => setTimeout(r, 2000)); // async decode + reactive repaint
  });

  const sceneShot = await (await page.$("canvas.scene")).screenshot({ encoding: "base64" });
  const media = await page.evaluate(async (sceneShot) => {
    const countMagenta = (d) => { let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200) n++; return n; };
    const readImg = async (src) => {
      const im = new Image(); im.src = src; await im.decode();
      const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const cx = c.getContext("2d"); cx.drawImage(im, 0, 0);
      return { magenta: countMagenta(cx.getImageData(0, 0, c.width, c.height).data), px: c.width * c.height };
    };
    const canvas = await readImg("data:image/png;base64," + sceneShot);
    const thumbEl = document.querySelector(".thumb img");
    const thumb = thumbEl && thumbEl.src ? await readImg(thumbEl.src) : { magenta: -1, px: 0 };
    return { canvas, thumb };
  }, sceneShot);
  assertRenders("image on editor canvas", media.canvas.magenta > 1000, `magenta ${media.canvas.magenta}/${media.canvas.px} px`);
  assertRenders("image in slide thumbnail", media.thumb.magenta > 50, `magenta ${media.thumb.magenta}/${media.thumb.px} px`);

  await page.screenshot({ path: path.join(SHOTS, "qa_editor_all_widgets.png") });
  await step("Present (fullscreen)", () => clickByTitle(page, "Present (fullscreen)"));
  await page.screenshot({ path: path.join(SHOTS, "qa_present_mode.png") });
  await page.keyboard.press("Escape"); // exit present mode
  await new Promise((r) => setTimeout(r, 600));

  await browser.close();

  const dangerousTotal = steps.reduce((n, s) => n + s.dangerous.length, 0);
  console.log("QA steps:");
  for (const s of steps) console.log(`  ${s.dangerous.length ? "FAIL" : "ok  "} ${s.name}  (+${s.newErrors} console msgs)` + (s.dangerous.length ? "\n      " + s.dangerous.join("\n      ") : ""));
  console.log("QA media assertions:");
  for (const a of asserts) console.log(`  ${a.ok ? "ok  " : "FAIL"} ${a.name}  (${a.detail})`);
  const failedAsserts = asserts.filter((a) => !a.ok);
  console.log(`\nscreenshots: ${SHOTS}/qa_editor_all_widgets.png, qa_present_mode.png`);
  if (dangerousTotal || failedAsserts.length) {
    console.log(`\nRESULT: FAIL — ${dangerousTotal} dangerous error(s), ${failedAsserts.length} media assertion(s) failed`);
    process.exit(2);
  }
  console.log("\nRESULT: PASS — every widget + media (image renders on canvas + thumbnail) + present mode, zero dangerous errors");
})().catch((e) => { console.error("QA ERROR:", e.message); process.exit(1); });
