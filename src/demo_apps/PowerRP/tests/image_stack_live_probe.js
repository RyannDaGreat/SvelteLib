/**
 * IMAGE STACK live probe — the evidence tests/image_stack_test.js cannot give, because
 * the questions are about PIXELS.
 *
 * The node suite can prove the display list is right; it cannot prove the picture is.
 * Three things about this widget are only answerable in a running browser:
 *
 *   (1) THE CARDS ARE REAL DECODED VIDEO, AND THE FRONT CARD IS FRAME 0. Each card is
 *       a `videoV5Frame` op at its own time, so a wrong paint ORDER or a wrong time
 *       shows up as the wrong colour in the wrong place and nowhere else. The
 *       RGB-per-second fixture (red 0-1 s, green 1-2 s, blue 2-3 s) makes it readable:
 *       with the fade OFF, the three cards must read red / green / blue from the front.
 *   (2) THE FADE LADDER IS REAL. stackAlphas is checked algebraically in the node
 *       suite; that it reaches the SCREEN is a pixel fact. Measured by re-rendering the
 *       SAME sample points with the fade off and on — comparing a point against itself
 *       across two renders, so nothing depends on what the clip happens to show there.
 *   (3) THE CARD SHADOWS ARE DRAWN OUTSIDE THE WIDGET'S BOX. That is why the widget's
 *       localBounds is inflated, and a pixel past the bottom-right corner is the only
 *       thing that can show the shadow is really there.
 *
 * Frontend-only Vite (HMR + watch OFF — a sibling agent's edit must not reload the page
 * mid-probe) + headless Chromium: the tests/filmstrip_live_probe.js pattern, which is
 * the sibling widget's probe and shares this one's whole media path. No project server
 * is started; the clip rides in as a data URI.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/image_stack_live_probe.js
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PNG } from "pngjs";
import { stackLayout } from "../plugins/image_stack.js";

// puppeteer >= 23 returns screenshot bytes as a Uint8Array; pngjs demands a real Buffer.
const readPng = (bytes) => PNG.sync.read(Buffer.from(bytes));

const HERE = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(HERE, "..");
const webRoot = resolve(appDir, "web");
const SHOTS = resolve(appDir, ".claude_vlm_checks");

const W = 480, H = 360;             // camera (slide) size in world units
const STACK = { x: 60, y: 30, w: 300, h: 300 };
const FRAME_COUNT = 3;              // one card per fixture colour band
const SHIFT = 0.45;                 // fraction of the box; leaves each card 2/3 of it
const CLIP_SECONDS = 3;
const BOOT_MS = 4000;               // Skia wasm + fonts + first paint
const DECODE_TIMEOUT_MS = 25000;    // every card decoded (one seek per card, serialized)
const POLL_MS = 200;
const SETTLE_MS = 1200;
const BACKDROP = "#222222";
const BACKDROP_RGB = [0x22, 0x22, 0x22];
const BACKDROP_TOLERANCE = 6;
const SATURATION_MIN = 40;          // channel spread separating the fixture's bands from any grey
// THE SHADOW PHASE RUNS ITS OWN DOCUMENT, deliberately loud. At the SHIPPED defaults
// the pixel this samples really is only ~1/255 darker than the backdrop, and that is
// CORRECT rather than a bug: the shadow that reaches outside the box belongs to the
// DEEPEST card, so it is multiplied by that card's own place in the fade and then
// spread by a blur wider than the offset. A gate on a one-level difference would be a
// coin flip. So the question "is the shadow drawn outside the box at all" is asked with
// the fade off, the shadow opaque, and the blur small against the offset — where the
// answer is unambiguous — and the shipped-default value is PRINTED beside it rather
// than asserted.
const SHADOW_PROBE_OUT = 4;      // world units past the box's bottom-right corner
const SHADOW_TEST_OPACITY = 1;   // no fade, no translucency: the shadow is the only ink there
const SHADOW_TEST_SHIFT = 0.06;  // offset ≈ 12.6 units — the probe point sits well inside it
const SHADOW_TEST_BLUR = 0.02;   // ≈ 4.2 units, so the offset dominates the spread
const SHADOW_LUMA_DROP = 20;     // measured ≈ 30 at these settings; a shadow that vanished would drop 0

const mp4 = await readFile(resolve(HERE, "fixtures/scrub_video.mp4"));
const SRC = `data:video/mp4;base64,${mp4.toString("base64")}`;

/** Pure function. The probe document: THE camera + one image stack whose three cards
 *  default-equation their way across the whole clip.
 *  @example doc(0).slides[0].delta.items.st.type // "image_stack" */
const doc = (alphaExponent, shadowOpacity, shadow = {}) => ({
  meta: { name: "image-stack-live", slideW: W, slideH: H },
  slides: [{
    id: "s0", name: "A", transition: { type: "fade", seconds: 1 },
    delta: {
      items: {
        cam: { type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: BACKDROP },
        st: {
          type: "image_stack", name: "Stack", src: SRC,
          ...STACK, z: 1, rotation: 0, scale: 1, active: true,
          videoStart: 0, videoEnd: CLIP_SECONDS,
          // The DEFAULT equations, verbatim — part of what this probe checks is that
          // they resolve to three DIFFERENT times.
          frames: [
            ["self.video_start"],
            ["self.video_start + 1 / 3 * (self.video_end - self.video_start)"],
            ["self.video_start + 2 / 3 * (self.video_end - self.video_start)"],
          ],
          shiftX: SHIFT, shiftY: SHIFT, alphaExponent,
          cardRadius: 0.04, shadowShift: 0.026, shadowBlur: 0.12, ...shadow, shadowColor: "#000000", shadowOpacity,
          preserveAspect: false, // the fixture is 4:3 and so are the cards here; a stretch keeps every sample inside picture
          scrubWrap: "clamp", opacity: 1,
        },
      },
      vars: {},
    },
  }],
});

/** Pure function. Is this pixel a decoded video frame (a saturated colour)?
 *  @example saturated([226, 56, 57]) // true
 *  @example saturated([34, 34, 34]) // false */
const saturation = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);

/** Pure function. The fixture's colour band for a pixel.
 *  @example band([226, 56, 57]) // "red"
 *  @example band([34, 34, 34]) // "none" */
const band = ([r, g, b]) => (saturation([r, g, b]) <= SATURATION_MIN ? "none" : r > g && r > b ? "red" : g > r && g > b ? "green" : "blue");

/** Pure function. Is this the camera backdrop (within the PNG round-trip's slack)?
 *  @example isBackdrop([34, 34, 34]) // true */
const isBackdrop = (rgb) => rgb.every((c, i) => Math.abs(c - BACKDROP_RGB[i]) <= BACKDROP_TOLERANCE);

/** Pure function. The RGB triple at (x, y) of a decoded PNG. */
function pixelAt(png, x, y) {
  const i = (png.width * Math.round(y) + Math.round(x)) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

/**
 * Pure function. The WORLD point inside card `j`'s EXPOSED sliver — the band along its
 * right edge that no card in FRONT of it covers. Cards step down-and-right and are
 * drawn back to front, so card j-1 sits up-left of card j and its right edge stops one
 * step short of card j's: the outer half-step of card j is always visible. Card 0's
 * band is simply inside card 0.
 *
 * The layout comes from the plugin's OWN stackLayout, so this reads the widget's
 * geometry rather than restating it.
 */
function exposedPoint(j, n) {
  const cards = stackLayout(n, STACK.w, STACK.h, SHIFT, SHIFT);
  const step = n > 1 ? cards[1].x - cards[0].x : cards[0].w;
  const c = cards[j];
  return { wx: STACK.x + c.x + c.w - step / 2, wy: STACK.y + c.y + c.h / 2 };
}

await mkdir(SHOTS, { recursive: true });

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // The project-server calls the app shell makes on boot are IGNORED — no server runs
  // here on purpose, and this widget must not need one.
  const IGNORE = /Failed to load resource|thumbnail|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|WebGPU|repair:|clipboard|\/api\//i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(BOOT_MS);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  /** Command (async). Loads a doc, fits the camera, returns the scene-canvas box. */
  async function load(d) {
    await page.evaluate((doc_) => {
      const app = window.__powerrp_app;
      app.commit(app.repaired(doc_));
      app.slideIndex = 0;
      app.runCommand("reset-view"); // zoom-to-fit THE camera, so world→canvas is known
    }, d);
    await sleep(500);
    return await page.evaluate(() => {
      const r = document.querySelector("canvas.scene").getBoundingClientRect();
      return { cx: r.x, cy: r.y, w: r.width, h: r.height };
    });
  }

  /** Query (async). The world→canvas mapping the current view uses, read from the app
   *  so this probe never re-derives the camera math. */
  const viewOf = () => page.evaluate(() => {
    const v = window.__powerrp_app.lastViewport;
    if (!v) throw new Error("app.lastViewport is not set — the canvas has not reported a viewport yet");
    return { zoom: v.zoom, panX: v.panX, panY: v.panY };
  });

  /** Pure function. World point → canvas-local CSS pixel, the app's own convention
   *  (core/view.js worldViewRect inverts exactly this). */
  const toCanvas = (view, wx, wy) => ({ x: wx * view.zoom + view.panX, y: wy * view.zoom + view.panY });

  /** Query (async). A screenshot of the scene canvas, decoded. */
  const shoot = async (box) => readPng(await page.screenshot({ clip: { x: box.cx, y: box.cy, width: box.w, height: box.h } }));

  /** Query (async). The RGB at each card's exposed sliver. */
  async function cardPixels(box) {
    const view = await viewOf();
    const png = await shoot(box);
    return Array.from({ length: FRAME_COUNT }, (_, j) => {
      const p = exposedPoint(j, FRAME_COUNT);
      const at = toCanvas(view, p.wx, p.wy);
      return { j, rgb: pixelAt(png, at.x, at.y) };
    });
  }

  // ── PHASE 1: real decoded video, front card = FRAME 0, fade OFF ────────────
  console.log("\n══ the cards are decoded video, front to back = frame 0 to frame N-1 ══");
  let box = await load(doc(0, 0)); // fade off, shadows off: pure content evidence
  let flat = null;
  for (let i = 0; i * POLL_MS < DECODE_TIMEOUT_MS; i++) {
    const cards = await cardPixels(box);
    if (cards.every((c) => !isBackdrop(c.rgb) && band(c.rgb) !== "none")) { flat = cards; break; }
    await sleep(POLL_MS);
  }
  const flatCards = flat ?? await cardPixels(box);
  await writeFile(resolve(SHOTS, "image_stack_fade_off.png"), PNG.sync.write(await shoot(box)));
  console.log(`  cards (front → back): ${flatCards.map((c) => `${c.j}=${band(c.rgb)}(${c.rgb})`).join("  ")}`);
  assert(flat !== null, `every card shows decoded video (${flatCards.filter((c) => isBackdrop(c.rgb)).length} still blank)`);
  const bands = flatCards.map((c) => band(c.rgb));
  assert(new Set(bands).size === FRAME_COUNT,
    `the three cards show three DIFFERENT frames — the per-element equations resolved to 0 s / 1 s / 2 s (got ${bands.join(",")})`);
  assert(bands[0] === "red" && bands[FRAME_COUNT - 1] === "blue",
    `the FRONT card is frame 0 (videoStart) and the deepest is the last — the pile recedes into the page, not out of it (got ${bands.join(",")})`);

  // ── PHASE 2: THE FADE LADDER, in pixels ────────────────────────────────────
  console.log("\n══ the fade ladder reaches the screen ══");
  box = await load(doc(0.5, 0)); // the reference's alphas_exponent, shadows still off
  let faded = null;
  for (let i = 0; i * POLL_MS < DECODE_TIMEOUT_MS; i++) {
    const cards = await cardPixels(box);
    if (!isBackdrop(cards[0].rgb) && band(cards[0].rgb) !== "none") { faded = cards; break; }
    await sleep(POLL_MS);
  }
  const fadedCards = faded ?? await cardPixels(box);
  await writeFile(resolve(SHOTS, "image_stack_fade_on.png"), PNG.sync.write(await shoot(box)));
  const sats = fadedCards.map((c) => saturation(c.rgb));
  const flatSats = flatCards.map((c) => saturation(c.rgb));
  console.log(`  saturation, fade OFF: ${flatSats.join(", ")}`);
  console.log(`  saturation, fade ON : ${sats.join(", ")}`);
  // The SAME point, in two renders — so nothing depends on what the clip shows there.
  assert(Math.abs(sats[0] - flatSats[0]) <= BACKDROP_TOLERANCE,
    `the FRONT card is untouched by the fade (alpha_0 = 1 exactly): ${flatSats[0]} → ${sats[0]}`);
  for (let j = 1; j < FRAME_COUNT; j++)
    assert(sats[j] < flatSats[j] - BACKDROP_TOLERANCE,
      `card ${j} is visibly faded against the same card with the fade off (${flatSats[j]} → ${sats[j]})`);
  assert(sats.every((s, j) => j === 0 || s < sats[j - 1]),
    `the ladder is monotone on screen — each card behind is fainter than the one in front (${sats.join(", ")})`);

  // ── PHASE 3: THE CARD SHADOWS FALL OUTSIDE THE WIDGET'S BOX ────────────────
  console.log("\n══ the card shadows are ink OUTSIDE the box (which is why localBounds inflates) ══");
  const cornerProbe = async (bx) => {
    const view = await viewOf();
    const png = await shoot(bx);
    const at = toCanvas(view, STACK.x + STACK.w + SHADOW_PROBE_OUT, STACK.y + STACK.h + SHADOW_PROBE_OUT);
    return pixelAt(png, at.x, at.y);
  };
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const noShadow = await cornerProbe(box); // still the shadowOpacity-0 document
  // FIRST, on the record and not asserted: what the SHIPPED defaults put there.
  box = await load(doc(0.5, 0.35));
  await sleep(SETTLE_MS);
  const atDefaults = await cornerProbe(box);
  await writeFile(resolve(SHOTS, "image_stack_shadows.png"), PNG.sync.write(await shoot(box)));
  console.log(`  at the shipped look: ${noShadow} → ${atDefaults} (a faint edge, by design — see SHADOW_PROBE_OUT)`);
  // THEN the gate, with the shadow made unambiguous.
  const strong = { shadowShift: SHADOW_TEST_SHIFT, shadowBlur: SHADOW_TEST_BLUR };
  box = await load(doc(0, SHADOW_TEST_OPACITY, strong));
  await sleep(SETTLE_MS);
  const withShadow = await cornerProbe(box);
  console.log(`  ${SHADOW_PROBE_OUT} units past the box's bottom-right corner: no shadow ${noShadow} → opaque shadow ${withShadow}`);
  assert(isBackdrop(noShadow), `with shadows off that pixel is the bare backdrop (${noShadow})`);
  assert(luma(withShadow) < luma(noShadow) - SHADOW_LUMA_DROP,
    `with an opaque shadow it is far DARKER — the card's shadow really is drawn outside the widget's box, which is why localBounds inflates (${luma(noShadow).toFixed(1)} → ${luma(withShadow).toFixed(1)})`);

  if (errors.length) { console.error("\nPAGE ERRORS:\n" + errors.join("\n")); process.exit(1); }
} finally {
  await browser.close();
  await server.close();
}

console.log(fails.length === 0 ? "\nimage stack live probe: ALL PASS" : `\nimage stack live probe: ${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
