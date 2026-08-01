/**
 * THE FONT-SIZE STEPPER, LIVE — the half tests/text_size_step_test.js cannot see.
 *
 * The bare-node suite pins the pure primitive and greps the two components for a
 * second declaration. Neither can answer the question the user actually asked
 * (R6-13.1): does pressing the toolbar's + do the SAME THING as Cmd+Plus, on a
 * real mixed selection, through the real controller? Measured before the fix on a
 * 48+18 selection with everything selected, one step up: the TOOLBAR produced ONE
 * run at 38 and the KEYBOARD ONE run at 50. Two wrong answers, disagreeing.
 *
 * PROBES (headless, zero unexpected console errors):
 *  P1  the toolbar's + and Cmd+Plus produce BYTE-IDENTICAL stored runs on the same
 *      mixed selection, and both preserve the 48/18 boundary at 50/20.
 *  P2  the readout is a real scrubber (role=spinbutton) and a DRAG on it commits a
 *      RELATIVE shift: the mixed run pair moves together, differences intact.
 *  P3  the readout stays live on a MIXED selection and marks itself mixed; on a
 *      uniform one it shows the plain number (the shape text_wysiwyg_probe reads).
 *  P4  the eight box-level Inspector rows are GONE on a fully-stamped value and
 *      PRESENT on a bare one — R6-13.4 through the real panel, not the registry.
 *
 * Spawns its OWN vite (isolated). Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/text_size_step_probe.js [shotDir]
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shotDir = process.argv[2] ? resolve(process.argv[2]) : null;
if (shotDir) mkdirSync(shotDir, { recursive: true });

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The measured fixture: two runs whose sizes differ, in a box that says something
// else again — so a step that reads the BOX instead of each run is visible.
const BIG = 48, SMALL = 18, STEP = 2, BOX_SIZE = 36;
const SAMPLE_A = "Big ", SAMPLE_B = "small";
const TEXT_LEN = (SAMPLE_A + SAMPLE_B).length;
// TWO drag distances, both LONGER THAN THE TOOLBAR IS TALL (32px), and the
// assertion is on their DIFFERENCE. Measuring one drag against its own length
// would need a tolerance: DraggableNumber promotes a gesture to a scrub only after
// CLICK_SLOP_PX, and when pointer LOCK then engages the accumulator restarts, so a
// fixed few pixels of pre-lock travel are dropped (measured: 6 of 40). That loss
// is CONSTANT, so differencing two drags cancels it exactly and states the real
// property with no tolerance at all: ONE UNIT PER PIXEL. It also pins the two
// hazards a tolerance would hide — the toolbar reverts a staged preview on
// pointerleave, so a drag this long would collapse if capture were not holding the
// events at the scrubber; and the value must not pick up the toolbar's 1/boxScale
// counter-transform (pointer-lock movementY is in screen px, immune to a CSS
// scale, which is what lets the readout live in a scaled bar at all).
const SCRUB_SHORT_PX = 40;
const SCRUB_LONG_PX = 60;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(1200);
  if (errors.length) { console.error("PAGE ERRORS AT BOOT:\n" + errors.join("\n")); process.exit(1); }

  // This probe self-spins a Vite with HMR live, and the dep optimizer can force a
  // full page reload seconds after boot — which drops window.__powerrp_app and made
  // the FIRST evaluate throw "cannot read properties of undefined". Waiting for the
  // seam rather than for a fixed delay is the fix, and it must happen before EVERY
  // load, not just the first: a reload can land at any point in the run.
  const APP_READY_TIMEOUT_MS = 30000;
  const waitForApp = () => page.waitForFunction(() => !!window.__powerrp_app?.registry, { timeout: APP_READY_TIMEOUT_MS, polling: 200 });
  await waitForApp();

  /** Command (in page). Loads a one-slide deck holding ONE text item with `text`,
   *  at the given box-level style. Returns the item id. */
  async function loadText(text, boxStyle = {}) {
    await waitForApp();
    const id = await page.evaluate(({ text, boxStyle }) => {
      const app = window.__powerrp_app;
      const def = (type) => ({ ...app.registry.get(type).defaults, type });
      const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 300, z: 1000, active: true, background: "#101014" };
      const txt = { ...def("text"), name: "Title", x: 40, y: 40, w: 320, h: 140, z: 1, active: true, text, ...boxStyle };
      const doc = { meta: { name: "size-step-probe", slideW: 400, slideH: 300 }, slides: [
        { id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, txt } } },
      ] };
      app.commit(app.repaired(doc));
      app.slideIndex = 0;
      app.selection = null;
      const items = app.doc.slides[0].delta.items;
      return Object.keys(items).find((k) => items[k].type === "text");
    }, { text, boxStyle });
    await sleep(400);
    return id;
  }

  const mixedValue = () => ({ runs: [{ text: SAMPLE_A, size: BIG }, { text: SAMPLE_B, size: SMALL }], paras: [{}] });
  const storedRuns = (id) => page.evaluate((i) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[i].text.runs), id).then(JSON.parse);
  const isEditing = () => page.evaluate(() => !!window.__powerrp_app.textEditing?.itemId);
  const focusSink = () => page.evaluate(() => document.querySelector(".text-edit-sink")?.focus());

  async function itemCenter(id) {
    return page.evaluate((i) => {
      const app = window.__powerrp_app;
      const n = app.nodes().find((nn) => nn.itemId === i);
      const c = Math.cos(n.world.rotation), s = Math.sin(n.world.rotation);
      const px = (n.state.w ?? 0) / 2, py = (n.state.h ?? 0) / 2;
      const wp = { x: n.world.x + n.world.scale * (c * px - s * py), y: n.world.y + n.world.scale * (s * px + c * py) };
      const sc = app.canvasActions.worldToScreen(wp.x, wp.y);
      const rect = document.querySelector(".render-area").getBoundingClientRect();
      return { x: rect.left + sc.x, y: rect.top + sc.y };
    }, id);
  }
  async function enterEdit(id) {
    const c = await itemCenter(id);
    await page.mouse.click(c.x, c.y, { clickCount: 2 });
    await sleep(280);
  }
  async function commitEdit() {
    await focusSink();
    await page.keyboard.press("Escape");
    await sleep(240);
  }
  async function selectAll() {
    await page.evaluate((n) => window.__powerrp_textEdit.setSelection(0, n), TEXT_LEN);
    await sleep(140);
  }

  // ── P1: the two entry points must produce the SAME stored runs ───────────────
  // TOOLBAR: a real click on the real "Increase size" button.
  let id = await loadText(mixedValue(), { size: BOX_SIZE });
  await enterEdit(id);
  await selectAll();
  if (shotDir) await page.screenshot({ path: resolve(shotDir, "P1-mixed-selection-before.png") });
  const plusBox = await page.evaluate(() => {
    const b = document.querySelector('[aria-label="Increase size"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  assert(plusBox, "P1: the toolbar's Increase size button exists");
  if (plusBox) await page.mouse.click(plusBox.x, plusBox.y);
  await sleep(180);
  await commitEdit();
  const afterToolbar = await storedRuns(id);

  // KEYBOARD: the same gesture through Cmd+Plus on the sink.
  id = await loadText(mixedValue(), { size: BOX_SIZE });
  await enterEdit(id);
  await selectAll();
  await focusSink();
  await page.keyboard.down("Control");
  await page.keyboard.press("=");
  await page.keyboard.up("Control");
  await sleep(180);
  await commitEdit();
  const afterKeyboard = await storedRuns(id);

  const sizes = (runs) => runs.map((r) => r.size);
  assert(JSON.stringify(afterToolbar) === JSON.stringify(afterKeyboard),
    `P1: the toolbar and the keyboard must store the SAME runs (toolbar=${JSON.stringify(afterToolbar)} keyboard=${JSON.stringify(afterKeyboard)})`);
  assert(afterToolbar.length === 2, `P1: the 48/18 boundary must survive the step (got ${afterToolbar.length} run(s): ${JSON.stringify(afterToolbar)})`);
  assert(JSON.stringify(sizes(afterToolbar)) === JSON.stringify([BIG + STEP, SMALL + STEP]),
    `P1: every run shifts by ${STEP} (expected [${BIG + STEP},${SMALL + STEP}], got ${JSON.stringify(sizes(afterToolbar))})`);

  // ── P2: the readout SCRUBS, and the scrub is RELATIVE ────────────────────────
  /** Query. The scrubber's page-frame centre + the value it currently reports. */
  const readScrubber = () => page.evaluate(() => {
    const el = document.querySelector(".text-format-size [role='spinbutton']");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, valuenow: Number(el.getAttribute("aria-valuenow")) };
  });
  /** Command. A fresh mixed fixture, everything selected, dragged UP `px` on the
   *  readout and committed. Returns the stored run sizes afterwards. */
  async function scrubBy(px, shot) {
    const itemId = await loadText(mixedValue(), { size: BOX_SIZE });
    await enterEdit(itemId);
    await selectAll();
    const dn = await readScrubber();
    if (!dn) return null;
    await page.mouse.move(dn.x, dn.y);
    await page.mouse.down();
    // Small steps so the gesture crosses the click-slop and then scrubs, exactly
    // as a hand does — one jump would look like a teleport, not a drag.
    for (let dy = 2; dy <= px; dy += 2) await page.mouse.move(dn.x, dn.y - dy);
    if (shot && shotDir) await page.screenshot({ path: resolve(shotDir, shot) });
    await page.mouse.up();
    await sleep(200);
    await commitEdit();
    return { sizes: (await storedRuns(itemId)).map((r) => r.size), seed: dn.valuenow };
  }

  const shortDrag = await scrubBy(SCRUB_SHORT_PX, "P2-scrub-in-flight.png");
  assert(shortDrag, "P2: the size readout is a real scrubber (role=spinbutton), not inert text");
  if (shortDrag) {
    assert(shortDrag.seed === BIG, `P2: a MIXED selection seeds the scrubber from the selection START size ${BIG} (got ${shortDrag.seed})`);
    assert(shortDrag.sizes.length === 2, `P2: a scrub must not flatten the runs (got ${JSON.stringify(shortDrag.sizes)})`);
    const dBig = shortDrag.sizes[0] - BIG, dSmall = shortDrag.sizes[1] - SMALL;
    assert(dBig > 0, `P2: dragging UP grows the size (${BIG} → ${shortDrag.sizes[0]})`);
    assert(dSmall === dBig, `P2: BOTH runs shift by the SAME amount — the scrub is RELATIVE (first +${dBig}, second +${dSmall})`);

    const longDrag = await scrubBy(SCRUB_LONG_PX);
    const dLong = longDrag.sizes[0] - BIG;
    assert(dLong - dBig === SCRUB_LONG_PX - SCRUB_SHORT_PX,
      `P2: ${SCRUB_LONG_PX - SCRUB_SHORT_PX} more pixels of drag must be ${SCRUB_LONG_PX - SCRUB_SHORT_PX} more units — one unit per pixel, unscaled and uninterrupted (short +${dBig}, long +${dLong})`);
  }

  // ── P3: the readout's two states ─────────────────────────────────────────────
  id = await loadText(mixedValue(), { size: BOX_SIZE });
  await enterEdit(id);
  await selectAll();
  const mixedRead = await page.evaluate(() => document.querySelector(".text-format-size")?.textContent?.trim() ?? null);
  assert(mixedRead != null && /\D$/.test(mixedRead), `P3: a MIXED readout marks itself mixed rather than claiming one size (got ${JSON.stringify(mixedRead)})`);
  await page.evaluate((n) => window.__powerrp_textEdit.setSelection(0, n), SAMPLE_A.length);
  await sleep(150);
  const uniformRead = await page.evaluate(() => document.querySelector(".text-format-size")?.textContent?.trim() ?? null);
  assert(uniformRead === String(BIG), `P3: a UNIFORM selection shows the plain number ${BIG} (got ${JSON.stringify(uniformRead)})`);
  if (shotDir) await page.screenshot({ path: resolve(shotDir, "P3-uniform-readout.png") });
  await page.evaluate(() => window.__powerrp_app.cancelTextEdit());
  await sleep(180);

  // ── P4: the dead box rows are GONE, and the live ones are not ────────────────
  // The user's real shape: one run carrying all ten style keys, one paragraph
  // carrying all four. Every box-level typography row falls back to nothing.
  const STAMPED = {
    runs: [{ text: "Here's the equation:", bold: false, italic: false, underline: false, strike: false, size: 76, font: "futura", color: "#000000", outlineColor: "#000000", outlineWidth: 0, highlight: "" }],
    paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }],
  };
  const BOX_ROWS = ["Font", "Size", "Bold", "Align", "Line spacing", "Char spacing", "Word spacing", "Color"];
  /** Query (in page). The Inspector row LABELS visible for the selected item. */
  const visibleRowLabels = () => page.evaluate(() =>
    JSON.stringify([...document.querySelectorAll(".inspector .row")].map((r) => r.querySelector(".label")?.textContent?.trim() ?? ""))).then(JSON.parse);
  async function selectAndReadRows(id, shot) {
    await page.evaluate((i) => { window.__powerrp_app.selection = i; }, id);
    await sleep(400);
    // Every collapsible category must be OPEN, or "the row is absent" would just
    // mean "its accordion is folded" — the boolean_uniformity_probe idiom.
    await page.evaluate(() => { for (const h of document.querySelectorAll(".inspector .cat-head[aria-expanded='false']")) h.click(); });
    await sleep(250);
    if (shot && shotDir) await page.screenshot({ path: resolve(shotDir, shot) });
    return visibleRowLabels();
  }

  const bareId = await loadText({ runs: [{ text: "Here's the equation:" }], paras: [{}] }, { size: BOX_SIZE });
  const bareLabels = await selectAndReadRows(bareId, "P4-bare-rows-present.png");
  const missingOnBare = BOX_ROWS.filter((l) => !bareLabels.includes(l));
  assert(missingOnBare.length === 0, `P4: a BARE value keeps all eight box rows (missing: ${missingOnBare.join(", ")})`);

  const stampedId = await loadText(STAMPED, { size: BOX_SIZE });
  const stampedLabels = await selectAndReadRows(stampedId, "P4-stamped-rows-hidden.png");
  const stillThere = BOX_ROWS.filter((l) => stampedLabels.includes(l));
  assert(stillThere.length === 0, `P4: a FULLY STAMPED value hides all eight (still showing: ${stillThere.join(", ")})`);
  // …and the rows that have no run/paragraph twin must survive the same value.
  for (const label of ["V-Align", "Opacity", "X", "Y"])
    assert(stampedLabels.includes(label), `P4: "${label}" has no per-run/per-paragraph twin and must NOT hide`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error("SIZE-STEP PROBE FAILURES:\n" + fails.join("\n")); process.exit(1); }
  console.log(`  P1 agreement: toolbar + and Cmd+Plus store IDENTICAL runs — ${JSON.stringify(sizes(afterToolbar))}, boundary intact (was 38 vs 50, one run).`);
  console.log("  P2 scrubber: the readout is a spinbutton; dragging it shifts BOTH runs by the same amount.");
  console.log("  P3 readout: mixed marks itself mixed, uniform shows the plain number.");
  console.log("  P4 rows: eight box rows present on a bare value, all eight gone on the user's stamped shape;");
  console.log("     V-Align / Opacity / X / Y (no run or paragraph twin) stay put.");
  console.log("\nText size-step probe passed.");
} finally {
  await browser.close();
  await server.close();
}
