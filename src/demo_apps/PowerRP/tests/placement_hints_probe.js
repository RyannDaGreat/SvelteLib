/**
 * PLACEMENT HINTS probe — the chips a crosshair placement puts on the bar, checked
 * against what the SAME gesture actually draws and commits, in a real browser.
 *
 * tests/placement_grammar_test.js pins the grammar↔declaration agreement in bare
 * node. What only a browser can prove is that the declaration REACHES THE BAR the
 * user reads, per grammar, at each moment of the gesture — armed, mid-drag, and
 * after the release — and that the shape drawn under the cursor is the one the
 * chip just described.
 *
 * THE DEFECT IT GUARDS. Both single-gesture placement grammars ran under one drag
 * kind, so an arrow/line placement announced "Uniform scale" for a Shift that
 * AXIS-LOCKS. Measured before the fix: the mid-drag bar for an `add-line` drag read
 * `Shift = Uniform scale` while the previewed segment snapped to the horizontal.
 *
 * page.mouse, not dispatchEvent: CanvasView's handlers call setPointerCapture, so a
 * synthetic event never routes through them (the crosshair_probe.js technique).
 *
 * WHAT IT PROVES
 *   ARMED     — the placement crosshair is up, the bar says so, and Escape cancels
 *               it leaving NOTHING (no item, no crosshair, no undo entry).
 *   SEGMENT   — an `endpoints` placement runs dragKind "placesegment", the bar says
 *               "Axis lock" and NOT "Uniform scale", and Shift really does collapse
 *               the drawn segment onto one axis. The committed item matches.
 *   BOX       — a `bbox` placement runs dragKind "place", the bar says "Uniform
 *               scale", and Shift really does square the drawn rect.
 *   SYMMETRIC — Cmd is announced identically for both because both really do
 *               centre on the start point (measured, not assumed).
 *   ESCAPE    — what a mid-DRAG Escape does today, recorded as the measurement it
 *               is. See the ESCAPE section for why this is an observation and not
 *               an assertion of intended behaviour.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/placement_hints_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shots = process.argv[2] ?? resolve(HERE, "../.claude_vlm_checks/placement_hints");
await mkdir(shots, { recursive: true });

const SETTLE_MS = 160; // one reactive paint + Skia frame
// The probe drag, in WORLD units: a clean rectangle well inside the default camera
// whose two extents are NONZERO and UNEQUAL. Both properties are load-bearing — a
// square drag satisfies "uniform" by accident and an axis-aligned one satisfies
// "axis lock" by accident, so neither could distinguish the two readings.
const DRAG_FROM = { x: 240, y: 240 };
const DRAG_TO = { x: 540, y: 340 };

// HMR + the file watcher are OFF: many agents edit this tree concurrently and a
// stray reload mid-probe drops window.__powerrp_app for unrelated reasons.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// Documented boot/runtime noise from OTHER lanes (the crosshair_probe.js treatment).
const IGNORE = [
  /PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/,
  /Failed to load resource/, /failed to load/,
];
const isNoise = (s) => IGNORE.some((re) => re.test(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  const liveErrors = [];
  const phase = { live: false };
  page.on("pageerror", (e) => (phase.live ? liveErrors : bootErrors).push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" || isNoise(m.text())) return;
    (phase.live ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });

  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(900);
  ok(bootErrors.length === 0, `no boot errors (${JSON.stringify(bootErrors)})`);
  phase.live = true;

  const worldToPage = (w) => page.evaluate((w) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(w.x, w.y);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, w);
  const moveTo = async (w) => {
    const p = await worldToPage(w);
    await page.mouse.move(p.x, p.y);
    await sleep(40);
  };
  /** Query. The visible HintBar LABELS — the words the user actually reads. Labels,
   *  not key tokens: most tokens render as an mdi glyph with no text
   *  (lib/KeyCombo.svelte), and which key carries which label is already pinned in
   *  bare node by tests/shortcut_registry_test.js. */
  const chips = () => page.evaluate(() =>
    [...document.querySelectorAll(".hintbar .hint .label")].map((l) => l.textContent.trim()));
  const dragKind = () => page.evaluate(() => window.__powerrp_app.dragKind);
  const crosshairKind = () => page.evaluate(() => window.__powerrp_app.crosshair?.kind ?? null);
  const itemIds = () => page.evaluate(() => Object.keys(window.__powerrp_app.rawState().items));
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const state = (id) => page.evaluate((id) => JSON.parse(JSON.stringify(window.__powerrp_app.rawState().items[id])), id);
  /** Query. The live placement overlay, in SCREEN units: whichever of the two
   *  placement primitives is drawn right now. Exactly one is ever present — they
   *  are the two halves of the grammar union. */
  const placeOverlay = () => page.evaluate(() => {
    const svg = document.querySelector(".overlay");
    const r = svg.querySelector("rect.place-rect");
    const l = svg.querySelector("line.place-rect");
    return {
      rect: r ? { w: +r.getAttribute("width"), h: +r.getAttribute("height") } : null,
      seg: l ? { dx: +l.getAttribute("x2") - +l.getAttribute("x1"), dy: +l.getAttribute("y2") - +l.getAttribute("y1") } : null,
    };
  });
  // Armed through the REAL command entry (what the palette and the toolbar both do),
  // so what this probe exercises is the shipped entry point, not a hand-rolled arm.
  const arm = async (commandId) => {
    await page.evaluate((id) => window.__powerrp_app.commands.get(id).run(window.__powerrp_app), commandId);
    await sleep(SETTLE_MS);
  };
  const purge = (ids) => page.evaluate((ids) => {
    const app = window.__powerrp_app;
    for (const id of ids) { app.selection = id; app.purgeSelection(); }
    app.deselectAll();
  }, ids);

  const baseIds = await itemIds();
  const newIds = async () => (await itemIds()).filter((id) => !baseIds.includes(id));

  // ── ARMED: the bar names the gesture, and Escape leaves nothing ────────────
  const docBefore = await docJson();
  await arm("add-line");
  const armedChips = await chips();
  ok(await crosshairKind() === "place", `arming add-line raises the placement crosshair (got ${await crosshairKind()})`);
  ok(armedChips.includes("Click or drag to place"), `the ARMED bar names the placement gesture. Got ${JSON.stringify(armedChips)}`);
  ok(armedChips.includes("Cancel"), `the ARMED bar offers Cancel. Got ${JSON.stringify(armedChips)}`);
  await page.screenshot({ path: `${shots}/01-armed.png` });

  // CANCEL AT STEP 1 — the arm, before any press.
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);
  ok(await crosshairKind() === null, "Escape while ARMED disarms the crosshair");
  ok((await newIds()).length === 0, "Escape while ARMED created no item");
  ok(await docJson() === docBefore, "Escape while ARMED left the committed document byte-identical");
  ok(!(await chips()).includes("Click or drag to place"), "the placement hint leaves the bar with the arm");

  // ── SEGMENT GRAMMAR: Shift is an AXIS LOCK, and the bar says so ────────────
  await arm("add-line");
  await moveTo(DRAG_FROM);
  await page.mouse.down();
  await sleep(SETTLE_MS);
  await page.keyboard.down("Shift");
  await moveTo(DRAG_TO);
  await sleep(SETTLE_MS);
  const segKind = await dragKind();
  const segChips = await chips();
  const segOverlay = await placeOverlay();
  await page.screenshot({ path: `${shots}/02-segment-shift.png` });
  ok(segKind === "placesegment", `an endpoints placement runs dragKind "placesegment" (got ${JSON.stringify(segKind)})`);
  ok(segChips.includes("Axis lock"), `the bar announces Shift as "Axis lock" during a segment placement. Got ${JSON.stringify(segChips)}`);
  ok(!segChips.includes("Uniform scale"),
    `THE REGRESSION: the bar must NOT announce "Uniform scale" during a segment placement — Shift axis-locks there, it does not scale. Got ${JSON.stringify(segChips)}`);
  ok(segChips.includes("Symmetric resize"), `Cmd is still announced during a segment placement. Got ${JSON.stringify(segChips)}`);
  ok(segOverlay.seg !== null && segOverlay.rect === null, `a segment placement draws the LINE primitive, not the rect (got ${JSON.stringify(segOverlay)})`);
  // THE CHIP AND THE PIXELS AGREE: the drawn segment really is axis-locked. The
  // drag spans 300x100 world units, so an unconstrained segment would have a
  // clearly nonzero dy; the lock collapses it (screen units, hence the tolerance).
  ok(segOverlay.seg && Math.abs(segOverlay.seg.dy) < 1 && Math.abs(segOverlay.seg.dx) > 10,
    `Shift really axis-locks the drawn segment (got ${JSON.stringify(segOverlay.seg)})`);
  await page.keyboard.up("Shift");
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const [lineId] = await newIds();
  ok(!!lineId, "the segment placement committed one item");
  if (lineId) {
    const s = await state(lineId);
    ok(Math.abs(s.to.y - s.from.y) < 1e-6, `the COMMITTED segment is the axis-locked one the bar described (from ${JSON.stringify(s.from)} to ${JSON.stringify(s.to)})`);
  }
  await purge(await newIds());

  // ── BOX GRAMMAR: the same key is a UNIFORM SCALE, and the bar says that ────
  await arm("add-number");
  await moveTo(DRAG_FROM);
  await page.mouse.down();
  await sleep(SETTLE_MS);
  await page.keyboard.down("Shift");
  await moveTo(DRAG_TO);
  await sleep(SETTLE_MS);
  const boxKind = await dragKind();
  const boxChips = await chips();
  const boxOverlay = await placeOverlay();
  await page.screenshot({ path: `${shots}/03-box-shift.png` });
  ok(boxKind === "place", `a bbox placement still runs dragKind "place" (got ${JSON.stringify(boxKind)})`);
  ok(boxChips.includes("Uniform scale"), `the bar announces Shift as "Uniform scale" during a box placement. Got ${JSON.stringify(boxChips)}`);
  ok(!boxChips.includes("Axis lock"), `a box placement must NOT announce "Axis lock" — Shift scales there. Got ${JSON.stringify(boxChips)}`);
  ok(boxOverlay.rect !== null && boxOverlay.seg === null, `a box placement draws the RECT primitive (got ${JSON.stringify(boxOverlay)})`);
  ok(boxOverlay.rect && Math.abs(boxOverlay.rect.w - boxOverlay.rect.h) < 1,
    `Shift really squares the drawn rect (got ${JSON.stringify(boxOverlay.rect)})`);
  await page.keyboard.up("Shift");
  await page.mouse.up();
  await sleep(SETTLE_MS);
  await purge(await newIds());

  // ── ESCAPE MID-DRAG: A MEASUREMENT, NOT AN ASSERTION OF INTENT ─────────────
  // ESC_CANCELABLE_DRAG_KINDS (core/shortcut_entries.js) lists only the two
  // single-point handle grabs, so CanvasView's capture-phase listener does NOT
  // claim Escape during a placement — and CanvasView documents that fall-through
  // as deliberate. Whether it SHOULD is a behaviour question filed separately; what
  // this block does is record the answer so the report is measured rather than
  // reasoned, and so a future change to it is visible here rather than silent.
  await arm("add-line");
  await moveTo(DRAG_FROM);
  await page.mouse.down();
  await sleep(SETTLE_MS);
  await moveTo(DRAG_TO);
  const escChips = await chips();
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);
  const afterEscape = { dragKind: await dragKind(), overlay: await placeOverlay() };
  await page.screenshot({ path: `${shots}/04-escape-mid-drag.png` });
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const escapeCreated = await newIds();
  console.log("\n── MEASURED: Escape during a live placement drag");
  console.log(`   chips mid-drag before Escape : ${JSON.stringify(escChips)}`);
  console.log(`   dragKind after Escape        : ${JSON.stringify(afterEscape.dragKind)}`);
  console.log(`   placement overlay after Esc  : ${JSON.stringify(afterEscape.overlay)}`);
  console.log(`   items created after release  : ${escapeCreated.length}`);
  // The ONE thing that is a defect under any reading of the intended behaviour: the
  // bar must not advertise a cancel it will not perform. Whatever Escape does here,
  // the chips must agree with it.
  ok(!escChips.includes("Cancel") || escapeCreated.length === 0,
    `the bar showed a Cancel chip during the placement drag but the release still created ${escapeCreated.length} item(s) — an advertised cancel that does not cancel`);
  await purge(escapeCreated);

  ok(liveErrors.length === 0, `no console errors during the interactions (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
console.log(`\nplacement_hints_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks, shots in ${shots}`);
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
