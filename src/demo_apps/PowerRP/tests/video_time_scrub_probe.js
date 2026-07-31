/**
 * VIDEO TIME SCRUBBER probe (manifest item 72) — proves the clock-driven demo
 * scrubber works through the REAL editor, end to end:
 *
 *   (1) MOUNT — a demo_video_time_scrub widget with a real video asset (the
 *       committed 3 s RGB-per-second fixture, as a data: URI like every video
 *       probe) paints its decoded frame in the live viewport (scrubTime 0 → red);
 *   (2) LOOP PRESET — with the particle clock pinned (setParticleTimeOverride
 *       through the SAME module instance the app uses, via the /@fs import the
 *       flicker probe established), applying the Loop preset makes
 *       currentTime = time % self.length: clock 4.2, length 3 → scrubTime 1.2,
 *       and the viewport shows the GREEN second of the clip;
 *   (3) PRESET SWITCHING — Double Speed / Ping-Pong / Freeze Frame each commit
 *       their equation SOURCE string and evaluate to the right value at the same
 *       pinned clock (Double Speed lands in the BLUE second — a visibly
 *       different frame, so switching provably re-decodes);
 *   (4) GRAMMAR THROUGH THE REAL INSPECTOR — typing "= time % 2" into the
 *       widget's "Time (s)" numeric field commits (stored "time % 2") and
 *       evaluates against the pinned clock — the manifest-72 grammar fixes
 *       (`%` operator + `time` keyword) proven in the shipped UI, where they
 *       used to throw `Unexpected character "%"` / `Unknown variable "time"`.
 *
 * Spawns its OWN isolated Vite (HMR/watch OFF — siblings may be editing) +
 * headless Chromium on swiftshader.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/video_time_scrub_probe.js
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POWERRP_DIR = resolve(HERE, "..");
const vlmDir = resolve(HERE, "../.claude_vlm_checks");
const W = 480, H = 360;
const CLIP_SECONDS = 3; // the committed fixture: 0-1s red, 1-2s green, 2-3s blue
const CLOCK = 4.2;      // pinned presentation time — one full loop plus 1.2s

// The committed RGB-per-second fixture, inlined as a data: URI (the established
// video-probe media pattern — no backend needed to serve it).
const mp4 = await readFile(resolve(HERE, "fixtures/scrub_video.mp4"));
const SRC = `data:video/mp4;base64,${mp4.toString("base64")}`;

// The item OVERRIDES riding on top of each plugin's full registry defaults —
// built in-page (buildDoc below), so the committed doc carries every default
// key and the repair pass has NOTHING to fill (its loud console.error would
// otherwise fail the probe's zero-console-errors gate).
const CAM = { name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, active: true, background: "#222222" };
const TS = { name: "TimeScrub", src: SRC, x: 0, y: 0, w: W, h: H, z: 1, active: true, scrubTime: 0, scrubWrap: "loop", length: CLIP_SECONDS };

const server = await createServer({ configFile: resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /no.*adapter|adapters/i];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction("!!window.__powerrp_app", { timeout: 20000 });
  await page.waitForSelector("canvas.scene", { timeout: 20000 });
  await sleep(3000); // Skia init + first paint
  const boot = errors.filter((e) => !IGNORE_BOOT.some((re) => re.test(e)));
  if (boot.length) { console.error("BOOT ERRORS:\n" + boot.join("\n")); process.exit(1); }
  errors.length = 0;

  // Pin the presentation clock BEFORE the doc commits, through the SAME
  // particle_clock module instance the app evaluates `time` with (the /@fs URL
  // is what Vite rewrites the app's own relative import to — module identity,
  // per the flicker probe's video_registry precedent).
  await page.evaluate(async (dir) => {
    window.__clock = await import(`${location.origin}/@fs${dir}/render_gpu/particle_clock.js`);
  }, POWERRP_DIR);

  // ── (1) MOUNT: commit the doc; scrubTime 0 must paint the RED first frame ──
  await page.evaluate((cam, ts, W, H) => {
    const app = window.__powerrp_app;
    const full = (type, overrides) => ({ ...app.registry.get(type).defaults, ...overrides });
    const doc = {
      meta: { name: "time-scrub-probe", slideW: W, slideH: H },
      slides: [{ id: "s0", name: "A", transition: { type: "fade", seconds: 1 }, delta: { items: {
        cam: full("camera", cam),
        ts: full("demo_video_time_scrub", ts),
      }, vars: {} } }],
    };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.runCommand("reset-view"); // zoom-to-fit THE camera so the clip fills the viewport
  }, CAM, TS, W, H);

  await mkdir(vlmDir, { recursive: true });
  const dominant = ([r, g, b]) => (r > g && r > b ? "red" : g > r && g > b ? "green" : "blue");
  const saturated = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 40; // a colored frame vs any gray backdrop

  /** Command (async). Poll the on-screen scene canvas center pixel until it is a
   * SATURATED color (the async seek landed + the reactive repaint drew the frame;
   * gray = the camera backdrop, i.e. no frame yet). Saves a VLM screenshot. */
  async function liveCenter(label) {
    const el = await page.$("canvas.scene");
    const box = await el.boundingBox();
    let rgb = [0, 0, 0];
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      const clip = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), width: 1, height: 1 };
      const b64 = await page.screenshot({ clip, encoding: "base64" });
      rgb = await page.evaluate(async (b64) => {
        const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
        const c = document.createElement("canvas"); c.width = 1; c.height = 1;
        const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
        const p = ctx.getImageData(0, 0, 1, 1).data; return [p[0], p[1], p[2]];
      }, b64);
      if (saturated(rgb)) break;
    }
    const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    await writeFile(resolve(vlmDir, `time_scrub_${label}.png`), shot);
    return rgb;
  }

  const mountRgb = await liveCenter("mount_red");
  ok(dominant(mountRgb) === "red", `widget mounts with the video asset and paints scrubTime 0 (red first second); got ${dominant(mountRgb)} ${mountRgb}`);

  // ── (2) LOOP PRESET: currentTime = time % self.length at a pinned clock ────
  // Set the override BEFORE applying the preset: applyPreset commits, which is
  // what re-evaluates the (memoized-on-state-identity) equation pass.
  const presetNames = await page.evaluate(() => window.__powerrp_app.registry.get("demo_video_time_scrub").presets.map((p) => p.name));
  ok(presetNames.includes("Loop") && presetNames.length >= 10, `the registered plugin carries the preset roster (${presetNames.length} presets)`);

  /** Command (async). Pin the clock to `t` and apply the named preset to the widget. */
  async function applyPresetAt(name, t) {
    return page.evaluate((name, t) => {
      const app = window.__powerrp_app;
      window.__clock.setParticleTimeOverride(t);
      const preset = app.registry.get("demo_video_time_scrub").presets.find((p) => p.name === name);
      app.applyPreset("ts", preset);
      return {
        stored: app.doc.slides[0].delta.items.ts.scrubTime,
        evaluated: app.state().items.ts.scrubTime,
      };
    }, name, t);
  }

  const loop = await applyPresetAt("Loop", CLOCK);
  ok(loop.stored === "time % self.length", `Loop preset commits the equation SOURCE string; got ${JSON.stringify(loop.stored)}`);
  ok(Math.abs(loop.evaluated - (CLOCK % CLIP_SECONDS)) < 1e-9, `Loop evaluates currentTime = time % self.length = ${CLOCK} % ${CLIP_SECONDS} = ${CLOCK % CLIP_SECONDS}; got ${loop.evaluated}`);
  const loopRgb = await liveCenter("loop_green");
  ok(dominant(loopRgb) === "green", `Loop at clock ${CLOCK} decodes the ${CLOCK % CLIP_SECONDS}s frame (green second); got ${dominant(loopRgb)} ${loopRgb}`);

  // ── (3) PRESET SWITCHING: each preset commits + evaluates at the same clock ─
  const dbl = await applyPresetAt("Double Speed", CLOCK); // (4.2*2) % 3 = 2.4 → BLUE second
  ok(Math.abs(dbl.evaluated - ((CLOCK * 2) % CLIP_SECONDS)) < 1e-9, `Double Speed evaluates (time*2) %% length = ${(CLOCK * 2) % CLIP_SECONDS}; got ${dbl.evaluated}`);
  const dblRgb = await liveCenter("double_speed_blue");
  ok(dominant(dblRgb) === "blue", `switching Loop → Double Speed re-decodes a visibly different frame (blue third second); got ${dominant(dblRgb)} ${dblRgb}`);

  const pp = await applyPresetAt("Ping-Pong", CLOCK); // 3 - |4.2 % 6 - 3| = 1.8
  const ppWant = CLIP_SECONDS - Math.abs((CLOCK % (2 * CLIP_SECONDS)) - CLIP_SECONDS);
  ok(Math.abs(pp.evaluated - ppWant) < 1e-9, `Ping-Pong evaluates the triangle wave = ${ppWant}; got ${pp.evaluated}`);

  const frz = await applyPresetAt("Freeze Frame", CLOCK); // length / 2 = 1.5, constant
  ok(Math.abs(frz.evaluated - CLIP_SECONDS / 2) < 1e-9, `Freeze Frame evaluates length/2 = ${CLIP_SECONDS / 2}; got ${frz.evaluated}`);
  // Δt = 0 law spot-check: re-pin the SAME clock, force a fresh eval via a no-op
  // preset re-apply — the value must not move (recordable state).
  const frz2 = await applyPresetAt("Freeze Frame", CLOCK);
  ok(frz2.evaluated === frz.evaluated, "Δt = 0 ⟹ scrubTime unchanged on re-evaluation");

  // ── (4) GRAMMAR THROUGH THE REAL INSPECTOR: type "= time % 2" and commit ───
  const INSPECTOR_CLOCK = 7; // 7 % 2 = 1 — distinct from every preset value above
  await page.evaluate((t) => {
    window.__clock.setParticleTimeOverride(t);
    window.__powerrp_app.selection = "ts"; // Inspector shows the widget's rows
  }, INSPECTOR_CLOCK);
  await sleep(300);

  const findRow = (label) => `[...document.querySelectorAll(".inspector .row")].find(r => r.querySelector(".label")?.textContent === ${JSON.stringify(label)})`;
  // Reach equation text entry on the Time (s) row. The field is ALREADY in text
  // mode here: scrubTime holds the Freeze Frame preset's stored GENERAL equation,
  // and classifyEquation("general") renders the .eq-input directly (no opener).
  // Fallbacks cover the other two resting states anyway: `.eq-open` (number mode's
  // hover affordance) and a click-without-drag on the DraggableNumber (a zero-
  // movement pointer pair stays under CLICK_SLOP_PX → beginTextEntry).
  const opened = await page.evaluate((expr) => {
    const row = eval(expr);
    if (row?.querySelector(".eq-input")) return "already-text";
    const eqOpen = row?.querySelector(".eq-open");
    if (eqOpen) { eqOpen.click(); return "eq-open"; }
    const dn = row?.querySelector(".numfield .dn");
    if (!dn) return false;
    const r = dn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    dn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: cx, clientY: cy }));
    dn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: cx, clientY: cy }));
    return "dn-click";
  }, findRow("Time (s)"));
  await sleep(200);
  if (!opened) {
    // Diagnostic on failure: what rows IS the Inspector showing?
    const labels = await page.evaluate(() => [...document.querySelectorAll(".inspector .row")].map((r) => r.querySelector(".label")?.textContent));
    console.error(`Time (s) row not openable. Inspector rows: ${JSON.stringify(labels)}`);
  }
  ok(opened, `equation text entry reachable on the Time (s) row (via ${opened})`);

  // One-shot value set (native setter + one input event — the discoverability
  // probe's pattern; char-by-char typing would flash transient partial refs).
  const eqInput = () => `(${findRow("Time (s)")})?.querySelector(".eq-input")`;
  ok(await page.evaluate((expr) => !!eval(expr), eqInput()), "Time (s) field is in equation text-entry mode");
  await page.evaluate((expr) => {
    const el = eval(expr);
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "= time % 2");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, eqInput());
  await sleep(200);
  // The syntax overlay must not paint `time` or `%` as an error span.
  const errSpans = await page.evaluate((expr) => {
    const row = eval(expr);
    return [...(row?.querySelectorAll(".eq-tok-error") ?? [])].map((s) => s.textContent);
  }, findRow("Time (s)"));
  ok(errSpans.length === 0, `no error spans while typing "= time % 2" (the old Unknown-variable/Unexpected-%% throws); got ${JSON.stringify(errSpans)}`);
  await page.keyboard.press("Enter");
  await sleep(250);

  const storedEq = await page.evaluate(() => window.__powerrp_app.doc.slides[0].delta.items.ts.scrubTime);
  ok(storedEq === "time % 2", `"= time %% 2" COMMITS through the real Inspector (stored marker-stripped); got ${JSON.stringify(storedEq)}`);
  const evaluatedEq = await page.evaluate(() => window.__powerrp_app.state().items.ts.scrubTime);
  ok(evaluatedEq === INSPECTOR_CLOCK % 2, `the committed equation evaluates against the pinned clock: ${INSPECTOR_CLOCK} % 2 = ${INSPECTOR_CLOCK % 2}; got ${evaluatedEq}`);

  await page.evaluate(() => window.__clock.setParticleTimeOverride(null)); // never leak the override

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log(`Video time scrub probe passed: ${checks.length}/${checks.length} checks, zero console errors. VLM shots in .claude_vlm_checks/`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} catch (e) {
  console.error("\nFAIL video_time_scrub_probe:", e?.message ?? e);
  if (errors.length) console.error("PROBE ERRORS:\n" + errors.join("\n"));
  process.exit(1);
} finally {
  await browser.close();
  await server.close();
}
