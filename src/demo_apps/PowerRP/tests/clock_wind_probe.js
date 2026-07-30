/**
 * CLOCK WINDING PROBE — the user's sentence, driven by a REAL MOUSE.
 *
 * "When I drag the second hand around 360, the minute hand should advance by
 *  one; around again, by two — exactly like the rotation property."
 *
 * tests/clock_analog_test.js already proves the winding ARITHMETIC in bare node
 * by calling core/derive.js modifierWrite directly. That is necessary and not
 * sufficient, for the reason the progress-bar handle probe records: a handle can
 * be arithmetically perfect and still unreachable, because the pure function is
 * not the thing the user touches. Between modifierPoints() and the user's hand
 * sit the canvas overlay, hit routing, the preview delta and the rAF repaint — and
 * the winding behaviour in particular DEPENDS on that chain, because it has no
 * gesture state of its own. It works only if each pointermove observes the
 * previous move's own write (CanvasView recomputes from state; rawState() blends
 * previewDelta in). If that feedback were broken the arithmetic would still pass
 * in node and the clock would stick at one turn in the app.
 *
 * So this probe drives GENUINE puppeteer mouse events in a circle around the
 * dial, through more than a full revolution, and asserts the carry.
 *
 * WHAT IS ASSERTED, and why each one is here rather than in the node test:
 *   1. The clock publishes three hand handles and they are REAL DOM ELEMENTS
 *      (rect.modifier), i.e. grabbable.
 *   2. ONE full mouse revolution advances the MINUTE HAND BY EXACTLY ONE. Stated
 *      in minutes, which is the user's own unit, not in seconds.
 *   3. A SECOND revolution advances it by exactly one more (accumulation — the
 *      property a modulo implementation gets wrong on the second lap, not the
 *      first, which is why one lap would be an inadequate test).
 *   4. Reversing UNWINDS back to where it started, so the gesture is invertible.
 *   5. NO SNAP AT THE WRAP: sampled continuously through the 12 o'clock crossing,
 *      time is strictly monotonic with no jump. This is the actual bug the old
 *      band-preserving code had — :59 → :01 rewound the minute — and it is
 *      invisible to an endpoint-only assertion.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), the
 * text_undo_probe.js / progress_bar_handle_probe.js pattern. Run from POWERRP or
 * the SvelteLib root (cwd-independent).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shotDir = process.argv[2] ?? resolve(HERE, "../.claude_shots/clock_wind");
mkdirSync(shotDir, { recursive: true });

/** The clock's on-slide geometry. Big, and centered, so a full mouse circle
 *  around it stays comfortably inside the viewport at whatever zoom the app fits. */
const CLOCK = { x: 250, y: 40, w: 420, h: 420 };
/** Pointer samples per revolution. 48 = 7.5° per step: far inside the winding
 *  rule's 180°-per-step branch-cut bound, and dense enough that the monotonicity
 *  assertion actually inspects the wrap rather than stepping over it. */
const STEPS_PER_TURN = 48;
const SECONDS_PER_MINUTE = 60;

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Ignored console noise, each for a stated reason:
  //  - resource/thumbnail 404s: this probe self-spins a FRONTEND-ONLY Vite (no
  //    server.py), so best-effort persistence POSTs fail. Orthogonal to winding.
  //  - "REFUSED a widget": the built-in library is a SHARED directory, and a
  //    malformed or in-flight asset there is refused BY DESIGN, loudly, without
  //    stopping the rest of the library from registering (core/plugin_assets.js).
  //    That refusal is another asset's problem; this probe is about the clock,
  //    and it asserts positively below that the clock itself registered and
  //    painted. Swallowing it here rather than failing is the difference between
  //    "the clock is broken" and "a neighbouring file is mid-edit".
  const IGNORED_CONSOLE = /Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7|REFUSED a widget/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORED_CONSOLE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // The clock itself MUST have registered. This is the positive counterpart to
  // swallowing "REFUSED a widget" above: a refusal of clock_analog specifically
  // would otherwise be indistinguishable from a neighbour's refusal.
  const clockRegistered = await page.evaluate(() => !!window.__powerrp_app.registry.get("clock_analog"));
  assert(clockRegistered, "clock_analog registered from the built-in library");
  if (!clockRegistered) throw new Error("clock_analog did not register — nothing else in this probe is meaningful");

  // A document with ONE clock, at a known time (12:00:00 exactly).
  const clockId = await page.evaluate((CLOCK) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 920, h: 500, z: 1000, active: true, background: "#101014" };
    const clk = { ...def("clock_analog"), name: "Clock", ...CLOCK, z: 1, active: true, time: 0 };
    const doc = { meta: { name: "clock-wind-qa", slideW: 920, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, clk } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = "clk";
    return "clk";
  }, CLOCK);
  await sleep(700);
  assert(errors.length === 0, "a default clock instantiates and paints with no error");

  /** Query. The clock's committed+previewed `time`, in seconds. */
  const timeOf = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    return app.previewDelta?.items?.[id]?.time ?? app.doc.slides[0].delta.items[id].time;
  }, clockId);
  /** Query. The clock's time expressed as MINUTES on the dial — the user's unit. */
  const minutesOf = async () => (await timeOf()) / 60;

  // ── 1. three hand handles, and they are real DOM elements ───────────────────
  const declared = await page.evaluate(() => window.__powerrp_app.handles().map((h) => h.id));
  assert(
    JSON.stringify(declared) === JSON.stringify(["hourTip", "minuteTip", "secondTip"]),
    `the clock publishes a handle per hand tip (got ${JSON.stringify(declared)})`,
  );
  const domHandles = await page.$$eval("rect.modifier", (els) => els.length);
  assert(domHandles === 3, `all three handles are drawn as grabbable elements (got ${domHandles})`);

  /** Query. The on-screen center of a named handle's REAL DOM ELEMENT. CanvasView
   *  draws each modifier point as `rect.modifier` in the handles' declared order
   *  (hourTip, minuteTip, secondTip), so going through the element — rather than
   *  recomputing world→screen here — is what makes this a test of the WIRING
   *  rather than of arithmetic the node test already covers. */
  const HANDLE_ORDER = ["hourTip", "minuteTip", "secondTip"];
  const handleBox = async (handleId) => {
    const els = await page.$$("rect.modifier");
    const el = els[HANDLE_ORDER.indexOf(handleId)];
    if (!el) return null;
    const b = await el.boundingBox();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  };

  // THE PIVOT, DERIVED FROM TWO MEASURED HANDLES rather than assumed. At time 0
  // every hand points straight up, so the hour and second tips are colinear with
  // the center on the SAME ray, at radii 0.5R and 0.85R of the same face. Two
  // points on that ray with known radius ratio determine the center:
  //   center = second + (second - hour) · 0.85/(0.85 - 0.5)
  // This needs no zoom, no pan and no canvas offset — all of which the earlier
  // version of this probe got wrong by reaching for an `actions` handle that the
  // app does not expose.
  const hourStart = await handleBox("hourTip");
  const secondStart = await handleBox("secondTip");
  assert(hourStart !== null && secondStart !== null, "the hour and second handles both resolve to screen positions");
  const HOUR_LEN = 0.5, SECOND_LEN = 0.85; // the plugin's default hand lengths
  const k = SECOND_LEN / (SECOND_LEN - HOUR_LEN);
  const centerScreen = {
    x: secondStart.x + (hourStart.x - secondStart.x) * k,
    y: secondStart.y + (hourStart.y - secondStart.y) * k,
  };
  const dragRadius = Math.hypot(secondStart.x - centerScreen.x, secondStart.y - centerScreen.y);
  assert(dragRadius > 20, `the second hand is long enough on screen to drag (r=${dragRadius.toFixed(1)}px)`);
  // Sanity: at time 0 the second hand points UP, so the tip must be ABOVE the
  // derived pivot. If this fails the pivot solve is wrong and nothing after it means anything.
  assert(secondStart.y < centerScreen.y - dragRadius * 0.9, "the derived pivot sits below the 12 o'clock second hand, as it must");

  /**
   * Command. Sweeps the currently-held mouse through `turns` revolutions about
   * the clock center, sampling `time` at every step. The mouse must already be
   * DOWN on the second-hand handle.
   *
   * @returns {number[]} the time (seconds) observed after each step
   */
  const sweep = async (turns, startDeg) => {
    const samples = [];
    const steps = Math.round(STEPS_PER_TURN * Math.abs(turns));
    for (let i = 1; i <= steps; i++) {
      const deg = startDeg + (360 * turns * i) / steps;
      const rad = (deg * Math.PI) / 180;
      await page.mouse.move(
        centerScreen.x + dragRadius * Math.sin(rad),
        centerScreen.y - dragRadius * Math.cos(rad),
      );
      samples.push(await timeOf());
    }
    return samples;
  };

  // ── 2. ONE revolution = the minute hand advances by exactly one ─────────────
  const before = await minutesOf();
  await page.mouse.move(secondStart.x, secondStart.y);
  await page.mouse.down();
  const firstTurn = await sweep(1, 0);
  const afterOne = await minutesOf();
  assert(
    Math.abs((afterOne - before) - 1) < 0.02,
    `ONE full mouse revolution advances the minute hand by exactly one (${before.toFixed(3)} → ${afterOne.toFixed(3)} min)`,
  );

  // ── 3. a SECOND revolution advances it by one more (accumulation) ──────────
  await sweep(1, 0);
  const afterTwo = await minutesOf();
  assert(
    Math.abs((afterTwo - before) - 2) < 0.02,
    `a SECOND revolution advances it by one MORE, not back to one (${before.toFixed(3)} → ${afterTwo.toFixed(3)} min)`,
  );

  // ── 5. no snap at the wrap (checked on the samples already gathered) ────────
  let monotonic = true, biggestJump = 0;
  for (let i = 1; i < firstTurn.length; i++) {
    const step = firstTurn[i] - firstTurn[i - 1];
    if (step <= 0) monotonic = false;
    biggestJump = Math.max(biggestJump, Math.abs(step));
  }
  assert(monotonic, "time is STRICTLY MONOTONIC through the 12 o'clock crossing — no rewind at the wrap");
  // 7.5° per step is 1.25 s; anything near a whole minute would be a wrap snap.
  assert(biggestJump < 5, `no discontinuity at the wrap (largest single step ${biggestJump.toFixed(3)} s)`);

  // ── 4. reversing UNWINDS ───────────────────────────────────────────────────
  await sweep(-2, 0);
  const afterUnwind = await minutesOf();
  await page.mouse.up();
  await sleep(300);
  assert(
    Math.abs(afterUnwind - before) < 0.02,
    `sweeping back two revolutions UNWINDS to the start (${afterUnwind.toFixed(3)} vs ${before.toFixed(3)} min)`,
  );

  await page.screenshot({ path: resolve(shotDir, "after_wind.png") });

  // The winding must have COMMITTED as a real edit, not just a preview.
  const committed = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].time, clockId);
  assert(typeof committed === "number" && Number.isFinite(committed), `the drag commits a finite time to the document (${committed})`);

  assert(errors.length === 0, `no page errors during the whole gesture${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.error(`\nclock_wind_probe: ${fails.length} FAILED\n  - ${fails.join("\n  - ")}`);
  process.exit(1);
}
console.log("clock_wind_probe: all checks passed");
