/**
 * GOD RAYS — BROWSER PROBE on a REAL FIXTURE DECK (sky + sun + clouds + an occluding
 * rect), following the brightness_contrast_browser_probe.js boot pattern.
 *
 * ── WHY A BROWSER PASS, AND WHY A WHOLE DECK ──────────────────────────────────
 * Two claims this widget makes cannot be checked anywhere else.
 *
 * FIRST, THE SkSL MUST COMPILE ON THE DRIVER. tests/god_rays_test.js runs in bare
 * node and never touches a GPU. The editor runs this shader through a WebGL2
 * on-screen surface (render_gpu/skia/browser_surface.js), whose SkSL compiler is a
 * DIFFERENT compiler with different limits — and this material has the most
 * demanding body of the family: a 128-iteration unrolled loop with a texture fetch
 * inside it. That is exactly the shape a driver rejects, and the failure shows up as
 * a page error rather than a wrong pixel, so only a real boot can see it.
 *
 * SECOND, AND THE POINT OF THE FEATURE: OCCLUSION IS A PIXEL CLAIM. The user asked
 * for beams that a square in front of the sun would BLOCK. There is no way to assert
 * that from state — it is a statement about light accumulated along screen rays
 * through the composite-so-far. So this probe builds the deck the user described,
 * renders it, and MEASURES: the sector of sky shadowed by the occluder must come out
 * darker than the matching unoccluded sector on the other side of the sun. That
 * asymmetry IS the occlusion, and nothing but a real render produces it.
 *
 * The deck is deliberately the user's own example: a sky, a sun the rays' light is
 * BOUND to by equation, a cloud band, and one dark rectangle sitting between the sun
 * and the lower-left of the frame.
 *
 * Run from the SvelteLib root: node src/demo_apps/PowerRP/tests/god_rays_probe.js
 * PNGs land in .claude_logs/godrays/.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const outDir = resolve(here, "..", ".claude_logs", "godrays");

// A software GL stack, so the probe runs the real WebGL2 path with no GPU present.
const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
const VIEWPORT = { width: 1440, height: 900 };
const BOOT_SETTLE_MS = 1200;   // CanvasKit WASM init + first paint
const PAINT_SETTLE_MS = 1400;  // one document change → derive → repaint. Longer than the tone probe's: this shader marches 64 taps per pixel on swiftshader.

// The deck's world geometry, named once so the probe's sampling boxes below are
// derived from it rather than from magic pixel numbers.
const SLIDE = { w: 1280, h: 720 };
const SUN = { cx: 640, cy: 150, r: 90 };          // the sun disc's world centre + radius
// The dark square between the sun and the lower LEFT — the user's "square in front
// that blocks the Sun". It is held CLEAR OF THE HORIZON on purpose: the sky widget
// paints a near-black GROUND band below its horizon line, and when the square's bottom
// edge reached it the two became one connected dark region, so the calibration's flood
// fill escaped into the ground and measured the whole band (3.43x by 2.21x, which the
// aspect guard rejected). Ending well above the horizon keeps the landmark isolated.
const OCCLUDER = { x: 250, y: 250, w: 260, h: 130 };

// KNOWN, UNRELATED BOOT NOISE (the brightness_contrast probe's list, same reasons):
// swiftshader exposes no WebGPU adapter and the videoV8/V7 cohort say so at boot.
// Printed, never hidden; simply not a finding about a light-scattering shader.
// Plus the BACKEND-ABSENT noise (the demo_widget_probe rule, and the reason the gate
// script spins its own backend): this probe is FRONTEND-ONLY — it spawns Vite alone,
// so /api/projects/ has nothing listening and the proxy answers 500. A missing project
// server says nothing about a shader; the deck here is built in memory and never saved.
const KNOWN_BOOT_NOISE = [/no WebGPU adapter/, /WebGPU init failed/, /Failed to load resource.*500/, /\/api\/(projects|assets)/];

/** Pure function. Splits errors into the ones this probe must fail on and the known
 * unrelated ones it only reports.
 * @example partitionErrors(["console.error: VideoV7: no WebGPU adapter"]).relevant // []
 * @example partitionErrors(["pageerror: SkSL failed to compile"]).relevant.length // 1 */
function partitionErrors(all) {
  const ignored = all.filter((e) => KNOWN_BOOT_NOISE.some((re) => re.test(e)));
  return { relevant: all.filter((e) => !ignored.includes(e)), ignored };
}

/** Command (throws on a relevant error; prints the ignored ones). */
function assertNoErrors(all, where) {
  const { relevant, ignored } = partitionErrors(all);
  for (const e of ignored) console.log(`  (ignored, known-unrelated) ${e}`);
  all.length = 0;
  if (relevant.length) throw new Error(`PAGE ERRORS ${where}:\n${relevant.map((e) => JSON.stringify(e)).join("\n")}`);
}

/**
 * Pure function. Mean Rec.709 luminance of an RGBA byte run, 0..255. The measure the
 * occlusion assertion is made in: god rays ADD light, so "were the rays blocked here"
 * is exactly "is this patch dimmer".
 *
 * @param {number[]|Uint8ClampedArray} rgba - packed RGBA bytes, length a multiple of 4
 * @returns {number} mean luminance in 0..255
 *
 * @example meanLuma([255, 255, 255, 255]) // 255
 * @example meanLuma([0, 0, 0, 255, 255, 255, 255, 255]) // 127.5
 * @example Math.round(meanLuma([255, 0, 0, 255])) // 54  (Rec.709 red)
 */
/** Query (reads a file). Decodes a PNG to {width, height, data} RGBA bytes.
 *  @example // await decodePng("shot.png") // {width: 893, height: 841, data: Uint8Array}
 */
async function decodePng(path) {
  return PNG.sync.read(await readFile(path));
}

export function meanLuma(rgba) {
  let sum = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4)
    sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
  return sum / n;
}

// The occluder is filled #050507 and everything else on the slide is sky, cloud or
// ground; nothing else in the frame is anywhere near this dark, so a luminance floor
// isolates it cleanly. Generous enough to survive the canvas's own resampling.
const OCCLUDER_LUMA_MAX = 24;
// A run of dark pixels this long is the occluder rather than a stray dark cloud edge
// or a UI hairline — the occluder is 260 world units wide, hundreds of shot px.
const OCCLUDER_MIN_SPAN_PX = 40;

/**
 * Query (reads a PNG). THE SLIDE→SHOT CALIBRATION, measured rather than assumed.
 * Finds the near-black occluder's bounding box in the screenshot and, knowing that
 * rect's WORLD geometry, solves for the affine map from world units to shot pixels:
 * a uniform scale plus the slide's origin within the shot.
 *
 * It exists because the screenshot is the CANVAS, not the slide: the slide is fitted
 * inside it with letterbox, so the two frames differ by an offset AND a scale that
 * depend on the viewport, the zoom the editor settled on, and the device pixel ratio.
 * Deriving them from a landmark the probe itself placed is exact and needs nothing
 * from the app; assuming them would silently measure the wrong patch of sky and make
 * the occlusion assertion meaningless.
 *
 * @param {string} png - path to a screenshot containing the occluder
 * @param {{x: number, y: number, w: number, h: number}} rect - the occluder's WORLD rect
 * @returns {Promise<{originX: number, originY: number, scale: number, width: number, height: number}>}
 *
 * @example // await calibrate("01_rays_on.png", {x: 250, y: 300, w: 260, h: 190})
 * @example // → {originX: 0.5, originY: 0.6, scale: 0.6975, width: 893, height: 841}
 */
async function calibrate(png, rect) {
  const { width, height, data } = await decodePng(png);
  const dark = (x, y) => {
    const i = (y * width + x) * 4;
    return data[i + 3] > 200 && meanLuma([data[i], data[i + 1], data[i + 2], 255]) <= OCCLUDER_LUMA_MAX;
  };

  // FLOOD-FILL FROM THE OCCLUDER'S OWN CENTRE, rather than scanning the whole shot for
  // dark pixels. The sky widget paints a dark GROUND band below its horizon which is
  // also near-black and much larger; a global scan merges the rect and the band into
  // one region whose aspect matches neither, and clipping the scan to the upper half
  // instead truncates the rect's own bottom edge. Both were measured (3.41x/0.63x and
  // 1.00x/0.64x — the aspect guard below caught each). A connected-component fill has
  // neither failure: the rect does not touch the ground band, so the fill stops at the
  // rect's real edges wherever they are.
  //
  // THE SEED IS FOUND, NOT ASSUMED. Guessing it from a first-guess fit does not work
  // — the shot is the canvas, whose scale and offset are exactly the unknowns being
  // solved for, so a guess good enough to seed already presupposes the answer (a
  // fit-to-width guess landed 200 px off, in open sky). Instead scan the shot ROW BY
  // ROW for the FIRST long horizontal run of dark pixels: the occluder's top edge is
  // the first thing in the frame that qualifies, because everything above it is sky,
  // cloud or sun, and the dark ground band lies strictly BELOW it.
  let seedX = -1, seedY = -1;
  for (let y = 0; y < height && seedY < 0; y++) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      run = dark(x, y) ? run + 1 : 0;
      if (run >= OCCLUDER_MIN_SPAN_PX) { seedX = x - Math.floor(run / 2); seedY = y; break; }
    }
  }
  if (seedY < 0)
    throw new Error(`probe: found no dark run of ${OCCLUDER_MIN_SPAN_PX}px anywhere in ${png} — the calibration landmark is missing, so no measurement here would mean anything`);

  const seen = new Uint8Array(width * height);
  const stack = [[seedX, seedY]];
  seen[seedY * width + seedX] = 1;
  let minX = seedX, minY = seedY, maxX = seedX, maxY = seedY;
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const k = ny * width + nx;
      if (seen[k] || !dark(nx, ny)) continue;
      seen[k] = 1;
      stack.push([nx, ny]);
    }
  }

  const scaleX = (maxX - minX + 1) / rect.w, scaleY = (maxY - minY + 1) / rect.h;
  // The fit is uniform, so the two axes must agree. A disagreement means the filled
  // region is not the occluder after all, and the probe must say so rather than
  // measure the wrong patch of sky and report a confident wrong answer.
  if (Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY) > 0.08)
    throw new Error(`probe: the dark region found in ${png} is ${scaleX.toFixed(3)}x horizontally but ${scaleY.toFixed(3)}x vertically — that is not the occluder, so the calibration is not trustworthy`);
  const scale = (scaleX + scaleY) / 2;
  return { originX: minX - rect.x * scale, originY: minY - rect.y * scale, scale, width, height };
}

await mkdir(outDir, { recursive: true });
// HMR OFF: a hot update remounts the app and throws away window.__powerrp_app, so a
// file saved anywhere in the tree mid-run would kill the probe with a collision, not
// a finding. This probe wants ONE stable page for its whole life.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser({ args: CHROME_ARGS });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  assertNoErrors(errors, "AT BOOT");

  // ── THE FIXTURE DECK ────────────────────────────────────────────────────────
  // Built in z-order, because z-order IS what the rays read: everything added
  // BEFORE the god-rays widget is in its backdrop (so it can be a light source or an
  // occluder); the widget itself goes last so it sits above all of it.
  const built = await page.evaluate((SLIDE, SUN, OCCLUDER) => {
    const app = window.__powerrp_app;
    if (!app) throw new Error("probe: window.__powerrp_app is gone — the page remounted mid-probe");
    const ids = {};
    const add = (type, o) => { app.addItem({ ...app.registry.get(type).defaults, ...o }); return app.selection; };

    // 1. THE SKY — the bright field the rays scatter through.
    ids.sky = add("sky", { x: 0, y: 0, w: SLIDE.w, h: SLIDE.h, timeOfDay: 0.5, turbidity: 3, exposure: 1.6 });
    // 2. THE SUN — the light source, high and centred. Its disc is the brightest
    //    thing on the slide, which is what makes the luminance key find it.
    ids.sun = add("skySun", {
      x: SUN.cx - SUN.r, y: SUN.cy - SUN.r, w: SUN.r * 2, h: SUN.r * 2,
      intensity: 1.4, size: 0.30, glow: 1.2, glowRadius: 0.35, color: "#fff4e2",
    });
    // 3. CLOUDS — they must ATTENUATE the beams, not stop them: a lit edge is bright
    //    (contributes) while the body is mid-grey (does not), which is the dappling.
    ids.clouds = add("skyClouds", { x: 0, y: 40, w: SLIDE.w, h: 420, coverage: 0.52 });
    // 4. THE OCCLUDER — the user's "square in front that blocks the Sun". Deliberately
    //    near-black and fully opaque: a hard occluder is the unambiguous test.
    ids.rect = add("rect", { x: OCCLUDER.x, y: OCCLUDER.y, w: OCCLUDER.w, h: OCCLUDER.h, fill: "#050507", strokeWidth: 0 });

    // 5. THE RAYS — last, so it samples all four above. The light is BOUND BY EQUATION
    //    to the sun widget's own centre anchor: this is the coupling the whole
    //    world-coordinate design exists for, and the probe exercises it rather than
    //    hard-coding a number that would pass even if the binding were broken.
    const sunName = app.itemSlug ? app.itemSlug(ids.sun) : null;
    ids.rays = add("demo_god_rays", {
      x: 0, y: 0, w: SLIDE.w, h: SLIDE.h,
      lightWorldX: sunName ? `= ${sunName}.anchors.center.x` : SUN.cx,
      lightWorldY: sunName ? `= ${sunName}.anchors.center.y` : SUN.cy,
      // Tuned for THIS deck, not copied from the defaults: a real sky widget is far
      // brighter and fills far more of the frame than the flat fixture the CPU suite
      // uses, so the same knobs over-accumulate and clip to white. A higher threshold
      // keeps the mid-sky out of the sum and lets the sun and its aureole drive the
      // beams, which is also what makes the occluder's shadow legible rather than
      // washed out.
      samples: 96, density: 0.9, decay: 0.982, weight: 0.05, exposure: 0.05,
      threshold: 0.80, maskSoftness: 0.12, maskStrength: 1, dither: 1, tint: "#ffffff",
    });
    return { ids, boundByEquation: !!sunName };
  }, SLIDE, SUN, OCCLUDER);
  console.log(`  deck built: ${Object.keys(built.ids).length} items; light ${built.boundByEquation ? "BOUND BY EQUATION to the sun" : "set to the sun's literal position"}`);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  assertNoErrors(errors, "after building the deck");

  /** Command (writes a PNG). Re-queries the canvas each time: Svelte re-creates the
   * wrapper on some document changes and a held handle goes stale. */
  const shoot = async (name) => {
    const canvas = await page.$(".canvas-wrap");
    if (!canvas) throw new Error("probe: .canvas-wrap not found");
    const out = resolve(outDir, `${name}.png`);
    await canvas.screenshot({ path: out });
    console.log(`  shot  ${name} → ${out}`);
    return out;
  };

  /**
   * Query (reads a written PNG). Mean luminance of a box given as FRACTIONS OF THE
   * SHOT, decoded from the screenshot this probe already takes.
   *
   * WHY THE PNG AND NOT THE LIVE CANVAS: the editor's canvas is a WebGL context
   * created WITHOUT preserveDrawingBuffer, so its backbuffer is undefined after the
   * frame is presented — `drawImage(canvas, …)` into a 2D scratch returns fully
   * transparent black, which reads as luminance 0.00 for every box and would make
   * this assertion vacuously "fail" no matter what rendered. Puppeteer's own
   * screenshot goes through the compositor and captures the presented pixels, so it
   * is the only readback available here that is true. (Confirmed the hard way: the
   * first run of this probe reported 0.00 for every sector while the very shots it
   * had just written plainly showed the scene.)
   *
   * Fractions of the SHOT, not the slide: the shot is the canvas region, which is the
   * fitted slide plus whatever letterbox the aspect leaves. Every box compared here
   * is measured the same way and mirrored about the same axis, so the common factor
   * cancels out of the comparison.
   */
  const lumaOfShotFrac = async (png, frac) => {
    const { width, height, data } = await decodePng(png);
    const x0 = Math.max(0, Math.round(frac.x * width));
    const y0 = Math.max(0, Math.round(frac.y * height));
    const x1 = Math.min(width, Math.round((frac.x + frac.w) * width));
    const y1 = Math.min(height, Math.round((frac.y + frac.h) * height));
    if (x1 <= x0 || y1 <= y0) throw new Error(`probe: fraction box ${JSON.stringify(frac)} maps to an empty region of ${png}`);
    const out = [];
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        out.push(data[i], data[i + 1], data[i + 2], data[i + 3]);
      }
    return meanLuma(out);
  };

  const shotOn = await shoot("01_rays_on");

  // ── THE OCCLUSION ASSERTION ─────────────────────────────────────────────────
  // Two sampling boxes, MIRRORED about the sun's vertical axis so they see the same
  // sky gradient, the same distance from the sun, and the same ray length. The only
  // difference between them is that the LEFT one's line to the sun passes through the
  // occluder and the RIGHT one's does not. Any luminance gap between them is
  // therefore the shadow, and nothing else.
  const SAMPLE = { w: 150, h: 120 };
  const shadowedWorld = { x: OCCLUDER.x + OCCLUDER.w / 2 - SAMPLE.w / 2, y: OCCLUDER.y + OCCLUDER.h + 90, w: SAMPLE.w, h: SAMPLE.h };
  const clearWorld = { x: 2 * SUN.cx - (shadowedWorld.x + SAMPLE.w), y: shadowedWorld.y, w: SAMPLE.w, h: SAMPLE.h };
  // THE SHOT IS CALIBRATED AGAINST THE OCCLUDER, not assumed. The screenshot is the
  // CANVAS region — the fitted slide plus whatever letterbox/chrome the aspect leaves
  // — so a fraction of the slide is NOT a fraction of the shot, and guessing the
  // offset would silently sample the wrong sky. Instead the probe FINDS the one item
  // whose world rect it already knows exactly and whose colour is unmistakable: the
  // near-black occluder. Its bounding box in the shot plus its bounding box in the
  // world give the affine slide→shot map directly, with no app internals involved.
  const cal = await calibrate(shotOn, OCCLUDER);
  console.log(`  calibration: slide origin (${cal.originX.toFixed(1)}, ${cal.originY.toFixed(1)}) px, scale ${cal.scale.toFixed(4)} shot-px per world unit`);
  /** Pure. World box → fraction of the SHOT, through the measured calibration.
   * @example // toFrac({x: 250, y: 300, w: 260, h: 190}) // the occluder, back onto itself */
  const toFrac = (b) => ({
    x: (cal.originX + b.x * cal.scale) / cal.width,
    y: (cal.originY + b.y * cal.scale) / cal.height,
    w: (b.w * cal.scale) / cal.width,
    h: (b.h * cal.scale) / cal.height,
  });
  const shadowed = toFrac(shadowedWorld), clear = toFrac(clearWorld);

  const lumShadowed = await lumaOfShotFrac(shotOn, shadowed);
  const lumClear = await lumaOfShotFrac(shotOn, clear);
  console.log(`  luminance behind the occluder: ${lumShadowed.toFixed(2)}   mirrored clear sector: ${lumClear.toFixed(2)}`);

  // Also measure with the rays OFF, so the gap is attributed to the RAYS rather than
  // to any pre-existing left/right asymmetry of the sky or clouds. This is the control
  // the assertion needs to be honest: the deck is not perfectly symmetric on its own.
  // applyPreset(itemId, {props}) is the app's ONE item-mutation seam (the Presets
  // pane's own path, one undo unit) — there is no updateItem, and a probe must not
  // invent a private back door into the document.
  await page.evaluate((id) => window.__powerrp_app.applyPreset(id, { props: { exposure: 0 } }), built.ids.rays);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
  const shotOff = await shoot("02_rays_off_control");
  const offShadowed = await lumaOfShotFrac(shotOff, shadowed);
  const offClear = await lumaOfShotFrac(shotOff, clear);
  console.log(`  rays OFF control — shadowed: ${offShadowed.toFixed(2)}   clear: ${offClear.toFixed(2)}`);

  // What the rays CONTRIBUTED to each sector: the on-minus-off difference.
  const gainShadowed = lumShadowed - offShadowed;
  const gainClear = lumClear - offClear;
  console.log(`  ray contribution — shadowed: ${gainShadowed.toFixed(2)}   clear: ${gainClear.toFixed(2)}`);

  // Restore, and shoot the two extra looks worth LOOKING at.
  await page.evaluate((id) => window.__powerrp_app.applyPreset(id, { props: { exposure: 0.5 } }), built.ids.rays);
  await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));

  if (!(gainClear > 0))
    throw new Error(`the rays added no light at all in the clear sector (contribution ${gainClear.toFixed(2)}) — the effect is not rendering`);
  if (!(gainShadowed < gainClear))
    throw new Error(`OCCLUSION FAILED: the occluder's shadow sector gained ${gainShadowed.toFixed(2)} but the mirrored clear sector gained ${gainClear.toFixed(2)} — a dark rect between the sun and a patch of sky must reduce the light that patch accumulates`);
  console.log(`  ok  OCCLUSION: the shadowed sector gained ${gainShadowed.toFixed(2)} vs ${gainClear.toFixed(2)} clear — the rect blocks the beams`);

  // A look at the preset the user's word "cinematic" names, and at the light dragged
  // off the top of the frame (the off-screen-sun fade, which must not go NaN/black).
  for (const [name, patch] of [
    ["03_subtle_morning", { samples: 48, density: 0.55, decay: 0.955, weight: 0.03, exposure: 0.03, threshold: 0.82, maskSoftness: 0.16, tint: "#fff3df" }],
    ["04_light_offscreen_above", { lightWorldX: SUN.cx, lightWorldY: -900 }],
  ]) {
    await page.evaluate((id, p) => window.__powerrp_app.applyPreset(id, { props: p }), built.ids.rays, patch);
    await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
    await shoot(name);
    assertNoErrors(errors, `while rendering "${name}"`);
  }

  assertNoErrors(errors, "at the end of the probe");
  console.log("\nOK god_rays_probe — the shader compiles and paints on the real WebGL2 Skia surface, and the occluder demonstrably shadows the beams");
} finally {
  await browser.close();
  await server.close();
}
