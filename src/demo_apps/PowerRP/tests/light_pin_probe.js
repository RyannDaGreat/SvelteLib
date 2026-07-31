/**
 * LIGHT-POSITION EYEDROPPER probe (web/lightPositionPin.js) — the feature in the
 * REAL editor, driven with REAL pointer gestures (page.mouse — CanvasView's
 * handlers call setPointerCapture, so a synthetic dispatchEvent would not route
 * through them; the bento_bind_probe.js technique).
 *
 * THE ONE ASSERTION THE FEATURE IS: insert a rect (the "sun") and a lens flare,
 * click the eyedropper, click the rect — both fields become equations and the
 * flare's light jumps to the rect's center — then DRAG THE RECT and the light
 * TRACKS (the live-pin proof, not a snapshot). Everything else here is the
 * boundary around it:
 *
 *   - the eyedropper button exists on the Light X row (only once an item with
 *     the pinLight aspect is selected);
 *   - clicking it enters the mode: the HintBar narrates the click gesture, the
 *     cursor changes, Escape (and a second eyedropper click) cancels with the
 *     document byte-identical;
 *   - hovering an object highlights it before any click, and clicking empty
 *     canvas cancels quietly (no write, mode exits);
 *   - the write is ONE undo unit and ONE undo reverts BOTH fields;
 *   - self-pick is refused with a sentence, nothing written;
 *   - the same flow works on god_rays (smoke-checked, not the full sequence).
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/light_pin_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const shots = process.argv[2] ?? "/tmp/light_pin_probe";
await mkdir(shots, { recursive: true });

// World coordinates stay INSIDE the default 1280x720 camera frame — the canvas
// viewport at default zoom/pan reliably shows this whole rect, so every click
// below lands on the canvas rather than drifting onto the Inspector/Tools
// panels either side of it (measured: a world point past ~x=950 at default zoom
// maps onto the Inspector, not the overlay).
const SUN = { x: 550, y: 420, w: 60, h: 40, name: "Sun" }; // the pin target
const SUN_CENTRE = { x: SUN.x + SUN.w / 2, y: SUN.y + SUN.h / 2 };
const FLARE = { x: 60, y: 40, w: 260, h: 160 };
const DRAG_TO = { x: 780, y: 220 }; // where the sun is dragged AFTER pinning — still inside frame
const EMPTY_CANVAS = { x: 40, y: 620 }; // clear of every widget above
const SETTLE_MS = 220;
const EPS = 0.5;

const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// reportAction (core/report.js) is console.error BY DESIGN for a refusal/cancel
// the probe itself deliberately triggers (self-pick, empty-canvas) — not a bug,
// so it is noise here exactly like the other lanes' documented boot chatter.
const IGNORE = [
  /PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/, /preserveAspect/,
  /Pin light to object cancelled/, /Pin light to object refused/,
];
const isNoise = (s) => IGNORE.some((re) => re.test(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => Math.abs(a - b) <= EPS;

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

  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);
  const clickAt = async (wx, wy, opts = {}) => {
    const p = await worldToPage(wx, wy);
    await page.mouse.click(p.x, p.y, opts);
    await sleep(SETTLE_MS);
  };
  const moveTo = async (wx, wy) => {
    const p = await worldToPage(wx, wy);
    await page.mouse.move(p.x, p.y);
    await sleep(SETTLE_MS);
  };
  const dragFromTo = async (fromWx, fromWy, toWx, toWy) => {
    const a = await worldToPage(fromWx, fromWy);
    const b = await worldToPage(toWx, toWy);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    await sleep(SETTLE_MS);
  };
  const hintLabels = () => page.evaluate(() => [...document.querySelectorAll(".hintbar .hint .label")].map((n) => n.textContent.trim()));
  const modeId = () => page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId ?? null);
  const stored = (id, key) => page.evaluate((id, key) => window.__powerrp_app.storedItemValue(id, [key]), id, key);
  const evaluated = (id, key) => page.evaluate((id, key) => {
    const n = window.__powerrp_app.nodes().find((x) => x.itemId === id);
    return n ? n.state[key] : null;
  }, id, key);
  const countCommits = () => page.evaluate(() => {
    if (window.__probeCommits !== undefined) return;
    window.__probeCommits = 0;
    const app = window.__powerrp_app;
    const real = app.commit.bind(app);
    app.commit = (d) => { window.__probeCommits += 1; return real(d); };
  });
  const commits = () => page.evaluate(() => window.__probeCommits);
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const canvasCursor = () => page.evaluate(() => getComputedStyle(document.querySelector(".overlay")).cursor);
  const spawn = (type, extra) => page.evaluate((type, extra) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get(type).defaults, ...extra });
    return app.selection;
  }, type, extra);
  // The lens_flare/god_rays types live under the "Add Demo Widget" submenu — added
  // directly through app.addItem (as spawn() already does for "rect"), which is the
  // same entry point that submenu uses; the type string is the plugin's own.
  const select = (id) => page.evaluate((id) => { window.__powerrp_app.selection = id; }, id);
  const pinButtonSelector = () => page.evaluate(() => {
    const btn = document.querySelector(".inspector .pin-light-btn");
    if (!btn) return null;
    btn.scrollIntoView({ block: "center" });
    const r = btn.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const clickPinButton = async () => {
    const r = await pinButtonSelector();
    if (!r) return false;
    // The button is HOVER-ONLY revealed (opacity 0 / pointer-events none at rest,
    // app.css .inspector .row:hover .pin-light-btn) — the same chrome copy-path/help
    // use. A real pointer must hover the ROW first, exactly as a person would, or the
    // synthetic click lands on a zero-opacity, unclickable target.
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(SETTLE_MS);
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(SETTLE_MS);
    return true;
  };

  // ── Set the scene ─────────────────────────────────────────────────────────
  const sunId = await spawn("rect", SUN);
  const flareId = await spawn("demo_lens_flare", FLARE);
  await select(flareId);
  await sleep(SETTLE_MS);
  ok(sunId && flareId, `sun ${sunId} + lens flare ${flareId} created`);

  // ── DISCOVERABILITY: the eyedropper exists on the Light X row ─────────────
  const buttonRect = await pinButtonSelector();
  ok(buttonRect !== null, "the eyedropper button renders on the Light X row for a selected lens flare");
  await page.screenshot({ path: `${shots}/1_button_visible.png` });

  // ── ENTER: click the eyedropper ────────────────────────────────────────────
  ok(await clickPinButton(), "clicking the eyedropper is possible");
  ok(await modeId() === "pin_light_position", `the mode is entered (got ${await modeId()})`);
  const modeLabels = await hintLabels();
  ok(modeLabels.some((l) => /click the object/i.test(l)), `the bar narrates the click gesture (got ${JSON.stringify(modeLabels)})`);
  ok(modeLabels.some((l) => l.startsWith("Exit pin light to object")), "…plus the generated Escape entry");
  ok(await canvasCursor() === "cell", `entering the mode sets its cursor (got ${await canvasCursor()})`);

  // ── ESCAPE PATH: cancels, document untouched ───────────────────────────────
  const preEscapeDoc = await docJson();
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);
  ok(await modeId() === null, "Escape leaves the mode");
  ok(await docJson() === preEscapeDoc, "…with the document byte-identical (nothing written)");

  // ── SECOND-CLICK CANCEL: entering then clicking the eyedropper again exits ──
  await clickPinButton();
  ok(await modeId() === "pin_light_position", "re-entered for the second-click test");
  await clickPinButton();
  ok(await modeId() === null, "a second eyedropper click cancels the mode");
  ok(await docJson() === preEscapeDoc, "…and writes nothing");

  // ── EMPTY-CANVAS CANCEL: a quiet hint, no write ────────────────────────────
  await clickPinButton();
  ok(await modeId() === "pin_light_position", "re-entered for the empty-canvas test");
  await clickAt(EMPTY_CANVAS.x, EMPTY_CANVAS.y);
  ok(await modeId() === null, "clicking empty canvas exits the mode");
  ok(await docJson() === preEscapeDoc, "…quietly: no write");

  // ── SELF-PICK REFUSAL: clicking the flare itself is refused ────────────────
  await clickPinButton();
  await clickAt(FLARE.x + 10, FLARE.y + 10); // inside the flare's own box
  ok(await modeId() === null, "self-pick exits the mode (refused, not a silent no-op)");
  ok(await docJson() === preEscapeDoc, "…and writes nothing");
  ok(typeof await stored(flareId, "lightWorldX") === "string" && (await stored(flareId, "lightWorldX")).startsWith("self."),
    "…the light position's own default equation is untouched");

  // ── HOVER previews the target before the click ─────────────────────────────
  await clickPinButton();
  await moveTo(SUN_CENTRE.x, SUN_CENTRE.y);
  const hoverChains = await page.evaluate(() => document.querySelectorAll("polyline.place-rect").length);
  ok(hoverChains >= 1, `hovering the sun highlights it before any click (got ${hoverChains} outline(s))`);
  await page.screenshot({ path: `${shots}/2_hovering_sun.png` });

  // ── THE PICK: click the sun ─────────────────────────────────────────────────
  await countCommits();
  await sleep(400);
  const commitBase = await commits();
  await clickAt(SUN_CENTRE.x, SUN_CENTRE.y);
  ok(await modeId() === null, "a completed pick exits the mode");
  const xExpr = await stored(flareId, "lightWorldX");
  const yExpr = await stored(flareId, "lightWorldY");
  ok(typeof xExpr === "string" && xExpr.includes(`@${sunId}.cx`), `lightWorldX became "= sun.cx" in @id form (got ${JSON.stringify(xExpr)})`);
  ok(typeof yExpr === "string" && yExpr.includes(`@${sunId}.cy`), `…and lightWorldY "= sun.cy" (got ${JSON.stringify(yExpr)})`);
  const pinCommits = await commits() - commitBase;
  ok(pinCommits === 1, `BOTH fields land as ONE undo unit (got ${pinCommits} commits)`);
  const lightAfterPin = { x: await evaluated(flareId, "lightWorldX"), y: await evaluated(flareId, "lightWorldY") };
  ok(near(lightAfterPin.x, SUN_CENTRE.x) && near(lightAfterPin.y, SUN_CENTRE.y),
    `the flare's light JUMPED to the sun's center ${JSON.stringify(SUN_CENTRE)} (got ${JSON.stringify(lightAfterPin)})`);
  await page.screenshot({ path: `${shots}/3_pinned.png` });

  // ── THE LIVE-PIN PROOF: drag the sun, and the light must TRACK ─────────────
  await select(sunId);
  await sleep(SETTLE_MS);
  await dragFromTo(SUN_CENTRE.x, SUN_CENTRE.y, DRAG_TO.x, DRAG_TO.y);
  const sunCentreAfterDrag = await page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((x) => x.itemId === id);
    return { x: n.state.x + n.state.w / 2, y: n.state.y + n.state.h / 2 };
  }, sunId);
  const lightAfterDrag = { x: await evaluated(flareId, "lightWorldX"), y: await evaluated(flareId, "lightWorldY") };
  ok(near(lightAfterDrag.x, sunCentreAfterDrag.x) && near(lightAfterDrag.y, sunCentreAfterDrag.y),
    `THE LIVE-PIN PROOF: dragging the sun to ${JSON.stringify(sunCentreAfterDrag)} moved the flare's light to ${JSON.stringify(lightAfterDrag)} — it TRACKED, not a stale snapshot`);
  await page.screenshot({ path: `${shots}/4_dragged_light_tracked.png` });

  // ── UNDO reverts BOTH fields in one step ───────────────────────────────────
  // Undo the drag first (its own unit), then the pin.
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  const undoneX = await stored(flareId, "lightWorldX");
  const undoneY = await stored(flareId, "lightWorldY");
  ok(typeof undoneX === "string" && undoneX.startsWith("self."), `ONE undo reverts lightWorldX to its pre-pin default (got ${JSON.stringify(undoneX)})`);
  ok(typeof undoneY === "string" && undoneY.startsWith("self."), `…and lightWorldY too, in the SAME undo (got ${JSON.stringify(undoneY)})`);
  await page.evaluate(() => window.__powerrp_app.redo());
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(SETTLE_MS);

  // ── SMOKE-CHECK: the same flow on god_rays ─────────────────────────────────
  const godRaysId = await spawn("demo_god_rays", { x: 60, y: 40, w: 260, h: 160 });
  await select(godRaysId);
  await sleep(SETTLE_MS);
  ok(await clickPinButton(), "the eyedropper also renders for god_rays");
  ok(await modeId() === "pin_light_position", "…and enters the same mode");
  await clickAt(sunCentreAfterDrag.x, sunCentreAfterDrag.y);
  const godRaysX = await stored(godRaysId, "lightWorldX");
  ok(typeof godRaysX === "string" && godRaysX.includes(`@${sunId}.cx`), `god_rays pins identically (got ${JSON.stringify(godRaysX)})`);

  ok(liveErrors.length === 0, `no runtime errors during the whole session (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "  ok " : "FAIL"}  ${label}`);
if (errors.length) {
  console.error(`\n${errors.length} check(s) failed:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\n${checks.length}/${checks.length} light-pin eyedropper checks passed. Shots in ${shots}`);
