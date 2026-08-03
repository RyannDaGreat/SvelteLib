/**
 * THE THREE FONT-SIZE VERBS, LIVE — the half tests/text_size_verbs_test.js cannot
 * see.
 *
 * The bare-node suite pins the three PRIMITIVES and greps the components for the
 * routing. Neither can answer the question the user actually asked: on a real
 * mixed-size selection, in the real editor, does TYPING normalize, does DRAGGING
 * scale proportionally, and do the +/- buttons still add? The routing runs on a
 * gesture argument that only a real pointer and a real keyboard produce, so a
 * source grep proves the branch EXISTS and nothing about whether the browser ever
 * takes it.
 *
 * Measured before the fix, on a 48+18 selection with everything selected, typing
 * 18 into the readout: the runs became 18 and MIN_RUN_SIZE — a -30px SHIFT, not a
 * normalization. The number the user typed appeared on the first run purely by
 * coincidence (48 - 30 = 18), which is exactly the kind of coincidence that lets a
 * bug survive a casual look.
 *
 * PROBES (headless, zero unexpected console errors):
 *  V1  TYPED → NORMALIZE. Clicking the readout and typing a number makes every
 *      selected run exactly that size, on a selection that started mixed.
 *  V2  DRAG → PROPORTIONAL. Dragging the readout multiplies every run, so the
 *      RATIO between them survives (asserted within float tolerance on the ratio,
 *      not on the sizes — the sizes depend on how far the drag got).
 *  V3  STEP → ADDITIVE. The +/- buttons still shift every run by the same px, and
 *      the ratio deliberately does NOT survive. The contrast the user drew, in
 *      one run of the real app.
 *  V4  UNDO GRANULARITY, measured on the session history's DEPTH: one drag is ONE
 *      snapshot however many frames it emitted, and N button clicks are N.
 *
 * Spawns its OWN vite (isolated). Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/text_size_verbs_probe.js [shotDir]
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

// THE FIXTURE. 48 and 18 are the sizes from the original divergence report, and
// their ratio 8:3 is deliberately not round: a scale that quietly flattened both
// to something tidy would still LOOK plausible against a 2:1 pair.
const BIG = 48, SMALL = 18, STEP = 2, BOX_SIZE = 36;
const SAMPLE_A = "Big ", SAMPLE_B = "small";
const TEXT_LEN = (SAMPLE_A + SAMPLE_B).length;
const START_RATIO = BIG / SMALL;

// The number V1 types. Chosen to be BETWEEN the two sizes, so a normalize (both
// become 30) and an additive shift (48→30 means 18→MIN_RUN_SIZE) and a scale
// (both × 0.625 = 30 and 11) all produce visibly different answers — no reading
// of the result is ambiguous about which verb ran.
const TYPED_SIZE = 30;

// The drag distance. Long enough that the proportional and additive answers cannot
// coincide: one unit per pixel means ~30px of drag takes 48 to ~78, i.e. a factor
// of ~1.6, which sends 18 to ~29 rather than to ~48. Both are well clear of each
// other and of the float noise.
const SCRUB_PX = 30;
// Ratio tolerance. The verb rounds each run to WHOLE px (a font size is authored
// in whole px everywhere in this editor), so a scaled pair cannot hold the ratio
// to more precision than that rounding allows: at these magnitudes one px of
// rounding on the smaller run moves the ratio by ~1/29 ≈ 0.03. This is the
// rounding budget, not a fudge factor — the RATIO is what must survive, and it
// survives as exactly as whole-px sizes permit.
const RATIO_TOL = 0.12;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(1200);
  if (errors.length) { console.error("PAGE ERRORS AT BOOT:\n" + errors.join("\n")); process.exit(1); }

  // Wait for the SEAM, not a fixed delay, and before every load — this probe
  // self-spins a Vite with HMR live and the dep optimizer can force a reload
  // seconds after boot (the text_size_step_probe precedent).
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
      const doc = { meta: { name: "size-verbs-probe", slideW: 400, slideH: 300 }, slides: [
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
  const sizesOf = (runs) => runs.map((r) => r.size);
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
  /** Query. The readout's page-frame centre and the number it currently reports. */
  const readScrubber = () => page.evaluate(() => {
    const el = document.querySelector(".text-format-size [role='spinbutton']");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, valuenow: Number(el.getAttribute("aria-valuenow")) };
  });
  /** Command. A fresh mixed fixture with everything selected, ready to gesture on
   *  the readout. Returns the item id and the readout's geometry. */
  async function freshMixedSelection() {
    const itemId = await loadText(mixedValue(), { size: BOX_SIZE });
    await enterEdit(itemId);
    await selectAll();
    const dn = await readScrubber();
    return { itemId, dn };
  }

  // ── V1: TYPED → NORMALIZE ────────────────────────────────────────────────────
  // A CLICK-WITHOUT-DRAG on the readout opens DraggableNumber's built-in text
  // entry (the readout passes no `onedit`, so the lib owns the surface). Typing a
  // number and pressing Enter is the gesture that must report source "typed".
  {
    const { itemId, dn } = await freshMixedSelection();
    assert(dn, "V1: the size readout is a real scrubber (role=spinbutton)");
    if (dn) {
      assert(dn.valuenow === BIG, `V1: a MIXED selection seeds the readout from the selection START size ${BIG} (got ${dn.valuenow})`);
      // Click WITHOUT moving: under CLICK_SLOP_PX, so it is a click, not a scrub.
      await page.mouse.click(dn.x, dn.y);
      await sleep(200);
      const typing = await page.evaluate(() => !!document.querySelector(".text-format-size input"));
      assert(typing, "V1: clicking the readout opens keyboard text entry");
      if (shotDir) await page.screenshot({ path: resolve(shotDir, "V1-typing-into-readout.png") });
      if (typing) {
        // select-all is already done by the lib's openTextEntry; type over it.
        await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
        await page.keyboard.type(String(TYPED_SIZE));
        await page.keyboard.press("Enter");
        await sleep(220);
      }
      await commitEdit();
      const after = sizesOf(await storedRuns(itemId));
      assert(
        after.every((s) => s === TYPED_SIZE),
        `V1: TYPING ${TYPED_SIZE} must NORMALIZE every run to ${TYPED_SIZE} (got ${JSON.stringify(after)}). ` +
        `A result of [${TYPED_SIZE},1] would be the OLD additive behaviour: 48-30 applied to 18 and floored.`,
      );
    }
  }

  // ── V2: DRAG → PROPORTIONAL ──────────────────────────────────────────────────
  {
    const { itemId, dn } = await freshMixedSelection();
    if (dn) {
      await page.mouse.move(dn.x, dn.y);
      await page.mouse.down();
      // Small steps so the gesture crosses the click-slop and then scrubs, exactly
      // as a hand does — one jump would look like a teleport, not a drag. This is
      // also what makes the test meaningful: MANY frames, each of which must have
      // computed its factor from the DRAG START rather than from its predecessor.
      for (let dy = 2; dy <= SCRUB_PX; dy += 2) await page.mouse.move(dn.x, dn.y - dy);
      if (shotDir) await page.screenshot({ path: resolve(shotDir, "V2-drag-in-flight.png") });
      await page.mouse.up();
      await sleep(220);
      await commitEdit();
      const after = sizesOf(await storedRuns(itemId));
      assert(after.length === 2, `V2: a drag must not flatten the runs (got ${JSON.stringify(after)})`);
      if (after.length === 2) {
        const [big, small] = after;
        assert(big > BIG, `V2: dragging UP grows the size (${BIG} → ${big})`);
        assert(small > SMALL, `V2: …and grows the SMALLER run too (${SMALL} → ${small})`);
        const ratio = big / small;
        assert(
          Math.abs(ratio - START_RATIO) <= RATIO_TOL,
          `V2: the RATIO must survive a drag — ${BIG}/${SMALL} = ${START_RATIO.toFixed(3)}, after = ${big}/${small} = ${ratio.toFixed(3)} ` +
          `(tolerance ${RATIO_TOL}, the whole-px rounding budget)`,
        );
        // …and state the CONTRAST explicitly, so this cannot pass by accident on a
        // result that happens to be additive. An additive shift of the same first
        // run would put the second at SMALL + (big - BIG).
        const additiveWouldBe = SMALL + (big - BIG);
        assert(
          small !== additiveWouldBe,
          `V2: the drag must SCALE, not ADD — an additive shift reaching ${big} would have put the second run at ${additiveWouldBe}, and it did`,
        );
      }
    }
  }

  // ── V3: STEP → ADDITIVE (the contrast the user drew) ─────────────────────────
  {
    const { itemId } = await freshMixedSelection();
    const plusBox = await page.evaluate(() => {
      const b = document.querySelector('[aria-label="Increase size"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    assert(plusBox, "V3: the toolbar's Increase size button exists");
    if (plusBox) {
      await page.mouse.click(plusBox.x, plusBox.y);
      await sleep(200);
      if (shotDir) await page.screenshot({ path: resolve(shotDir, "V3-after-step.png") });
    }
    await commitEdit();
    const after = sizesOf(await storedRuns(itemId));
    assert(
      JSON.stringify(after) === JSON.stringify([BIG + STEP, SMALL + STEP]),
      `V3: a + click must ADD ${STEP} to every run (expected [${BIG + STEP},${SMALL + STEP}], got ${JSON.stringify(after)})`,
    );
    if (after.length === 2) {
      // The ratio deliberately does NOT survive — this is the user's stated
      // contrast, and asserting it is what makes V2 mean something.
      assert(
        Math.abs(after[0] / after[1] - START_RATIO) > 0.01,
        `V3: an additive step CHANGES the ratio (that is the point) — ${after[0]}/${after[1]} must differ from ${START_RATIO.toFixed(3)}`,
      );
    }
  }

  // ── V4: ONE GESTURE = ONE UNDO UNIT ──────────────────────────────────────────
  // A drag emits a frame per two pixels — fifteen of them at SCRUB_PX — and each
  // frame really does rewrite every covered run. "One gesture, one undo unit" is
  // the claim that the SESSION HISTORY grows by exactly ONE across all of them:
  // the frames go through the preview path (stageValue, no history) and only the
  // settle calls preview(), which pushes.
  //
  // MEASURED ON THE HISTORY DEPTH, not by pressing Cmd+Z and comparing sizes. The
  // in-session undo has an off-by-one of its own — measured on the ADDITIVE
  // stepper, which is unchanged by this workstream: after a + click the document
  // still reads [48,18] (the commit is staged, not yet folded) and one Cmd+Z
  // ADVANCES it to [50,20]. That is a real pre-existing defect and it is recorded
  // as one, but it is not this workstream's, and an assertion phrased through it
  // would fail for a reason that has nothing to do with the three verbs. Depth is
  // the quantity the granularity claim is actually about.
  {
    const { dn } = await freshMixedSelection();
    if (dn) {
      const before = await page.evaluate(() => window.__powerrp_textEdit.historyDepth());
      await page.mouse.move(dn.x, dn.y);
      await page.mouse.down();
      let frames = 0;
      for (let dy = 2; dy <= SCRUB_PX; dy += 2) { await page.mouse.move(dn.x, dn.y - dy); frames++; }
      const midDrag = await page.evaluate(() => window.__powerrp_textEdit.historyDepth());
      await page.mouse.up();
      await sleep(220);
      const after = await page.evaluate(() => window.__powerrp_textEdit.historyDepth());
      assert(
        midDrag === before,
        `V4: a drag IN FLIGHT must push NO history (${frames} frames moved the depth ${before} → ${midDrag})`,
      );
      assert(
        after - before === 1,
        `V4: the whole drag must be ONE undo unit (${frames} frames pushed ${after - before} snapshots, expected 1)`,
      );
    }
  }

  // …and each BUTTON CLICK is its own unit, which is the other half of the
  // granularity contract: three clicks must be three undos, not one and not six.
  {
    const { dn } = await freshMixedSelection();
    if (dn) {
      const before = await page.evaluate(() => window.__powerrp_textEdit.historyDepth());
      const plusBox = await page.evaluate(() => {
        const b = document.querySelector('[aria-label="Increase size"]');
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const CLICKS = 3;
      for (let i = 0; i < CLICKS; i++) { await page.mouse.click(plusBox.x, plusBox.y); await sleep(140); }
      const after = await page.evaluate(() => window.__powerrp_textEdit.historyDepth());
      assert(
        after - before === CLICKS,
        `V4: ${CLICKS} + clicks must be ${CLICKS} undo units (got ${after - before})`,
      );
    }
    await commitEdit();
  }

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error("SIZE-VERBS PROBE FAILURES:\n" + fails.join("\n")); process.exit(1); }
  console.log(`  V1 typed: typing ${TYPED_SIZE} over a ${BIG}/${SMALL} selection NORMALIZES every run to ${TYPED_SIZE} (was a -30px shift).`);
  console.log(`  V2 drag: dragging the readout SCALES — the ${BIG}:${SMALL} ratio survives, and the result is provably not an additive shift.`);
  console.log(`  V3 step: the + button still ADDS ${STEP} to each run, and the ratio changes — the user's stated contrast.`);
  console.log("  V4 undo: a drag in flight pushes NO history; the whole gesture is ONE snapshot; N clicks are N.");
  console.log("\nThree font-size verbs probe passed.");
} finally {
  await browser.close();
  await server.close();
}
