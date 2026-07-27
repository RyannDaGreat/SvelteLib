/**
 * BROWSER PROBE for the BRIGHTNESS / CONTRAST region filter (the editor_smoke.js boot
 * pattern + the comic_glitch_probe.js "PNGs for a VLM" purpose).
 *
 * WHY A BROWSER PASS AT ALL, when tests/brightness_contrast_test.js already renders and
 * measures pixels: those run on CanvasKit's SOFTWARE surface (CanvasKit.MakeSurface). The
 * editor runs the SAME SkSL through a WebGL2 ON-SCREEN surface
 * (render_gpu/skia/browser_surface.js MakeOnScreenGLSurface), whose driver-side SkSL
 * compiler is a DIFFERENT compiler with different limits. A material that compiles and
 * runs perfectly headless can still be rejected there, and the failure surfaces as a
 * page error rather than a bad pixel — so this probe boots the real editor, inserts real
 * widgets over a gradient-rich scene, screenshots the canvas, and FAILS LOUDLY on any
 * page error or console error.
 *
 * Run from the SvelteLib root: node src/demo_apps/PowerRP/tests/brightness_contrast_browser_probe.js
 * PNGs land in .claude_vlm_checks/.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

// Paths resolve from THIS FILE, never the shell's working directory.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const outDir = resolve(here, "..", ".claude_vlm_checks");

// A software GL stack, so the probe runs the real WebGL2 path in a container with no GPU.
const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const VIEWPORT = { width: 1440, height: 900 };
const BOOT_SETTLE_MS = 1200;   // CanvasKit WASM init + first paint
const PAINT_SETTLE_MS = 700;   // one document change → derive → repaint

// KNOWN, UNRELATED BOOT NOISE — messages this environment always produces that say
// nothing about this material. swiftshader exposes no WebGPU adapter, and the videoV8/V7
// cohort widgets report that on their own fallback path at boot. They are still PRINTED
// below (nothing is hidden); they simply do not fail a tone-shader probe. Anything else
// on the console error channel DOES fail it.
const KNOWN_BOOT_NOISE = [/no WebGPU adapter/, /WebGPU init failed/];
/** Pure function. Splits console/page errors into the ones this probe must fail on and
 * the known-unrelated ones it only reports.
 * @example partitionErrors(["console.error: VideoV7: no WebGPU adapter"]).relevant // []
 * @example partitionErrors(["pageerror: SkSL failed to compile"]).relevant.length // 1 */
function partitionErrors(all) {
  const ignored = all.filter((e) => KNOWN_BOOT_NOISE.some((re) => re.test(e)));
  return { relevant: all.filter((e) => !ignored.includes(e)), ignored };
}
/** Command (throws on a relevant error; prints the ignored ones). The single gate every
 * checkpoint in this probe goes through. */
function assertNoErrors(all, where) {
  const { relevant, ignored } = partitionErrors(all);
  for (const e of ignored) console.log(`  (ignored, known-unrelated) ${e}`);
  all.length = 0; // each checkpoint reports its OWN window, so a later shot is not blamed for an earlier line
  // JSON-quoted, so an EMPTY or whitespace-only console line is visible as one rather
  // than producing a blank, undiagnosable failure message.
  if (relevant.length) throw new Error(`PAGE ERRORS ${where}:\n${relevant.map((e) => JSON.stringify(e)).join("\n")}`);
}

// The looks to shoot, as flat knob maps applied to ONE widget in sequence. EVERY entry
// writes EVERY knob: applyPreset only writes the keys it is given, so a partial map would
// silently inherit whatever the previous shot left behind (a hue lock leaking two looks
// forward, say) and the contact sheet would be quietly lying about what it shows. The
// plugin's own PRESETS hold to the same rule for the same reason.
const PUNCH = 1.7;   // the contrast used by every "punch" comparison, so they differ only in mode / hue lock
const DIM_STOPS = -1.2; // the presentation dim: enough that overlaid text reads
const LOOKS = [
  ["neutral_emits_nothing", { mode: "smooth", brightness: 0, contrast: 1, preserveHue: false, cornerRadius: 0 }],
  ["smooth_punch", { mode: "smooth", brightness: 0, contrast: PUNCH, preserveHue: false, cornerRadius: 0 }],
  ["srgb_punch_clips", { mode: "srgb", brightness: 0.04, contrast: PUNCH, preserveHue: false, cornerRadius: 0 }],
  ["smooth_punch_hue_locked", { mode: "smooth", brightness: 0, contrast: PUNCH, preserveHue: true, cornerRadius: 0 }],
  ["dim_for_overlay", { mode: "linear", brightness: DIM_STOPS, contrast: 1, preserveHue: false, cornerRadius: 0 }],
  ["exposure_plus_1_stop", { mode: "linear", brightness: 1, contrast: 1, preserveHue: false, cornerRadius: 0 }],
  ["wash_out", { mode: "smooth", brightness: 0.4, contrast: 0.45, preserveHue: false, cornerRadius: 0 }],
  // The corner radius is shot over a DIM, because a rounded corner is only visible where
  // the toned region differs from the page outside it — and the smooth curve leaves the
  // white page exactly white, so a punch would have no visible edge to round.
  ["rounded_corners", { mode: "linear", brightness: DIM_STOPS, contrast: 1, preserveHue: false, cornerRadius: 64 }],
];

await mkdir(outDir, { recursive: true });
// HMR OFF, deliberately. A hot update REMOUNTS the app and throws away
// window.__powerrp_app, so any file saved anywhere in the tree while this probe is
// running would kill it mid-run with "Cannot read properties of undefined (reading
// 'addItem')" — a collision with whoever else is editing, not a finding about the
// shader. The probe wants ONE stable page for its whole life.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({ headless: "new", args: CHROME_ARGS });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle0" });
  // Wait on the REAL condition (the app hook exists) rather than only a sleep, then
  // still settle for the CanvasKit init + first paint.
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  assertNoErrors(errors, "AT BOOT");

  // The scene beneath: a gradient-rich, saturated, full-range target — the content a
  // tone curve is easiest to get visibly wrong on. addItem() assigns z itself (max+1)
  // and reports the new id through app.selection, so insertion ORDER is the z order and
  // the widget, added last, sits above everything it samples.
  const sceneCount = await page.evaluate(() => {
    const app = window.__powerrp_app;
    if (!app) throw new Error("probe: window.__powerrp_app is gone — the page remounted mid-probe");
    const add = (o) => { app.addItem({ ...app.registry.get("rect").defaults, strokeWidth: 0, ...o }); return app.selection; };
    let n = 0;
    add({
      x: 60, y: 70, w: 640, h: 190,
      fill: { type: "linearGradient", linear: { stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } } },
    });
    n++;
    ["#cc3311", "#2266dd", "#22aa55", "#ddaa22", "#aa44cc", "#11bbbb"].forEach((fill, i) => { add({ x: 60 + i * 108, y: 280, w: 104, h: 120, fill }); n++; });
    ["#000000", "#767676", "#808080", "#c0c0c0", "#ffffff"].forEach((fill, i) => { add({ x: 60 + i * 130, y: 420, w: 126, h: 80, fill }); n++; });
    return n;
  });
  if (sceneCount !== 12) throw new Error(`probe: expected 12 scene items, created ${sceneCount}`);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));

  /** Command (writes a PNG). Shoots the canvas region, RE-QUERYING the element each
   * time: Svelte re-creates the canvas wrapper on some document changes, and a handle
   * held across one goes stale ("Node is detached from document"). */
  const shootCanvas = async (name) => {
    const canvas = await page.$(".canvas-wrap");
    if (!canvas) throw new Error("probe: .canvas-wrap not found");
    const out = resolve(outDir, `bc_browser_${name}.png`);
    await canvas.screenshot({ path: out });
    console.log(`  ok  ${name} → ${out}`);
  };
  await shootCanvas("00_source");

  // ONE widget, re-tuned per look through app.applyPreset — the SAME seam the Tools
  // pane's preset cards use (setPreview → commitPreview, one undo unit), so every shot
  // differs only in the tone knobs and nothing about the probe is a private back door.
  const widgetId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    if (!app) throw new Error("probe: window.__powerrp_app is gone — the page remounted mid-probe");
    app.addItem({ ...app.registry.get("demo_brightness_contrast").defaults, x: 40, y: 50, w: 690, h: 470 });
    return app.selection;
  });
  if (!widgetId) throw new Error("probe: the brightness/contrast widget was not created");
  for (const [name, props] of LOOKS) {
    await page.evaluate((id, p) => {
      const app = window.__powerrp_app;
      if (!app) throw new Error("probe: window.__powerrp_app is gone — the page remounted mid-probe");
      app.applyPreset(id, { props: p });
    }, widgetId, props);
    await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
    await shootCanvas(name);
    assertNoErrors(errors, `while rendering "${name}"`);
  }

  assertNoErrors(errors, "at the end of the probe");
  console.log("\nOK brightness_contrast_browser_probe — the material compiles and paints on the real WebGL2 Skia surface with no page errors");
} finally {
  await browser.close();
  await server.close();
}
