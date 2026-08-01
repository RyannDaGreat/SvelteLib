/**
 * Modal transform probe: axis constraints + numeric entry for the Blender-style
 * G (grab) / S (scale) / R (rotate) modals, plus the cursor->pivot line. Boots the PowerRP editor headless
 * with the demo deck, selects the demo rect, and drives G/S with X/Y axis keys
 * and typed digit buffers — asserting the COMMITTED document matches the exact
 * arithmetic, and that Escape reverts with no undo unit. Fails loudly on any
 * console error during the modal interactions.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/modal_xform_probe.js <shot_dir>
 *
 * Demo rect (id c5c2bed3): x=120 y=160 w=260 h=160 → center (250, 240).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";

const RECT = "c5c2bed3";
const EPS = 1e-6;
const approx = (a, b) => Math.abs(a - b) < EPS;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const failures = [];
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));

  const canvas = await page.$(".canvas-wrap");
  const box = await canvas.boundingBox();
  const rectScreen = { x: box.x + 250, y: box.y + 240 }; // over the rect body (world≈screen at zoom 1)

  // Boot errors from OTHER agents' in-flight fixture work are not ours — record
  // the baseline, then require ZERO NEW errors during the modal interactions.
  const bootErrors = errors.length;

  // Helpers ------------------------------------------------------------------
  const rectState = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((n) => n.itemId === id);
    return { x: n.state.x, y: n.state.y, w: n.state.w, h: n.state.h };
  }, RECT);
  const undoDepth = () => page.evaluate(() => window.__powerrp_app.undoLog.canUndo);
  const modalState = () => page.evaluate(() => {
    const m = window.__powerrp_app.modalXform;
    return m ? { kind: m.kind, axis: m.axis, buffer: m.buffer } : null;
  });
  const previewNull = () => page.evaluate(() => window.__powerrp_app.previewDelta === null);
  const rectRotation = () => page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((n) => n.itemId === id);
    return n.state.rotation ?? 0;
  }, RECT);
  /** The stored (raw) keys the CURRENT preview writes for the rect — what the
   *  minimal-delta discipline is actually about, and invisible to rectState(). */
  const previewKeys = () => page.evaluate((id) =>
    Object.keys(window.__powerrp_app.previewDelta?.items?.[id] ?? {}).sort(), RECT);
  /** How many cursor->pivot lines the overlay is drawing (R6-2.2). */
  const pivotLines = () => page.evaluate(() => document.querySelectorAll(".overlay line.guide-dashed").length);
  /** The one cursor->pivot line's endpoints, or null. */
  const pivotLine = () => page.evaluate(() => {
    const l = document.querySelector(".overlay line.guide-dashed");
    return l && { x1: +l.getAttribute("x1"), y1: +l.getAttribute("y1"), x2: +l.getAttribute("x2"), y2: +l.getAttribute("y2") };
  });
  const check = (name, cond, detail = "") => { if (!cond) failures.push(`${name}: ${detail}`); };

  // Select the rect and park the pointer over it (so a grab starts at ~0 delta).
  await page.mouse.click(rectScreen.x, rectScreen.y);
  await new Promise((r) => setTimeout(r, 200));
  await page.mouse.move(rectScreen.x, rectScreen.y);
  const base = await rectState(); // {120,160,260,160}
  const before = await undoDepth();
  check("select-rect", base.x === 120 && base.y === 160 && base.w === 260 && base.h === 160,
    `base=${JSON.stringify(base)} (expected 120,160,260,160)`);
  const center = { x: base.x + base.w / 2, y: base.y + base.h / 2 }; // (250,240)

  // ── Scenario 1: S 2 — uniform factor 2 about the rect center ──────────────
  await page.keyboard.press("KeyS");
  await new Promise((r) => setTimeout(r, 50));
  check("S-modal-live", (await modalState())?.kind === "scale", `modal=${JSON.stringify(await modalState())}`);
  await page.keyboard.press("Digit2");
  await new Promise((r) => setTimeout(r, 50));
  check("S2-buffer", (await modalState())?.buffer === "2", `modal=${JSON.stringify(await modalState())}`);
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 100));
  {
    const s = await rectState();
    const want = { x: center.x + 2 * (base.x - center.x), y: center.y + 2 * (base.y - center.y), w: base.w * 2, h: base.h * 2 };
    check("S2-commit", approx(s.x, want.x) && approx(s.y, want.y) && approx(s.w, want.w) && approx(s.h, want.h),
      `got=${JSON.stringify(s)} want=${JSON.stringify(want)}`);
    // canUndo is a boolean flag (not a count) — a commit makes undo available.
    check("S2-one-undo", (await undoDepth()) === true, `canUndo=${await undoDepth()} expected true`);
    check("S2-modal-cleared", (await modalState()) === null && (await previewNull()));
  }
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 80));
  check("S2-undo-restores", JSON.stringify(await rectState()) === JSON.stringify(base));

  // ── Scenario 2: G X 2 — move +2 world units along X only ──────────────────
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyG");
  await new Promise((r) => setTimeout(r, 50));
  await page.keyboard.press("KeyX");
  await new Promise((r) => setTimeout(r, 50));
  check("GX-axis", (await modalState())?.axis === "x", `modal=${JSON.stringify(await modalState())}`);
  await page.keyboard.press("Digit2");
  await new Promise((r) => setTimeout(r, 50));
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 100));
  {
    const s = await rectState();
    check("GX2-commit", approx(s.x, base.x + 2) && approx(s.y, base.y) && s.w === base.w && s.h === base.h,
      `got=${JSON.stringify(s)} want x=${base.x + 2} y=${base.y} (w,h unchanged)`);
  }
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 80));

  // ── Scenario 3: S Y 2 — height doubles about center; width/x untouched ─────
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyS");
  await new Promise((r) => setTimeout(r, 50));
  await page.keyboard.press("KeyY");
  await new Promise((r) => setTimeout(r, 50));
  await page.keyboard.press("Digit2");
  await new Promise((r) => setTimeout(r, 50));
  await page.screenshot({ path: `${shots}/modal_SY2.png` });
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 100));
  {
    const s = await rectState();
    const wantY = center.y + 2 * (base.y - center.y);
    check("SY2-commit", s.x === base.x && s.w === base.w && approx(s.h, base.h * 2) && approx(s.y, wantY),
      `got=${JSON.stringify(s)} want y=${wantY} h=${base.h * 2} (x,w unchanged)`);
  }
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 80));

  // ── Scenario 4: same-key clears the constraint (S X X → uniform) ──────────
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyS");
  await page.keyboard.press("KeyX");
  await new Promise((r) => setTimeout(r, 40));
  check("SXclear-set", (await modalState())?.axis === "x");
  await page.keyboard.press("KeyX"); // same key → clears
  await new Promise((r) => setTimeout(r, 40));
  check("SXclear-cleared", (await modalState())?.axis === null, `axis=${(await modalState())?.axis}`);
  await page.keyboard.press("KeyY"); // switch to Y
  await new Promise((r) => setTimeout(r, 40));
  check("SXclear-switch", (await modalState())?.axis === "y");
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));

  // ── Scenario 5: buffer Backspace editing ──────────────────────────────────
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyS");
  await page.keyboard.press("Digit1");
  await page.keyboard.press("Digit5"); // "15"
  await new Promise((r) => setTimeout(r, 40));
  check("bksp-buffer15", (await modalState())?.buffer === "15", `buffer=${(await modalState())?.buffer}`);
  await page.keyboard.press("Backspace"); // → "1"
  await new Promise((r) => setTimeout(r, 40));
  check("bksp-buffer1", (await modalState())?.buffer === "1", `buffer=${(await modalState())?.buffer}`);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));

  // ── Scenario 6: Esc reverts cleanly (no doc change, no undo unit) ─────────
  const undoPreEsc = await undoDepth();
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyS");
  await page.keyboard.press("Digit3"); // factor 3 preview
  await new Promise((r) => setTimeout(r, 40));
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 80));
  check("esc-revert-doc", JSON.stringify(await rectState()) === JSON.stringify(base),
    `after=${JSON.stringify(await rectState())}`);
  check("esc-no-undo", (await undoDepth()) === undoPreEsc, `undo=${await undoDepth()} expected ${undoPreEsc}`);
  check("esc-preview-clear", await previewNull());
  check("esc-modal-clear", (await modalState()) === null);

  // ── Scenario 7: plain S pointer-driven still works (no axis/buffer) ────────
  // Park the pointer OFFSET from the center before S so the reference distance
  // d0 > 0 (S at the exact center is the degenerate factor-1 case by design).
  await page.mouse.move(box.x + 320, box.y + 240); // 70px right of center (250)
  await page.keyboard.press("KeyS");
  await new Promise((r) => setTimeout(r, 40));
  // Move the pointer FARTHER from the center to grow the rect (d1 > d0).
  await page.mouse.move(box.x + 460, box.y + 240, { steps: 6 });
  await new Promise((r) => setTimeout(r, 40));
  const grewPreview = await page.evaluate((id) => {
    const w = window.__powerrp_app.previewDelta?.items?.[id]?.w;
    return typeof w === "number" ? w : null;
  }, RECT);
  check("plainS-pointer-preview", grewPreview !== null && grewPreview > base.w,
    `preview w=${grewPreview} (expected > ${base.w})`);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));

  // ── Scenario 8: G-numeric-requires-axis ruling — digit with no axis no-ops ─
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyG");
  await page.keyboard.press("Digit5"); // no axis yet → ignored
  await new Promise((r) => setTimeout(r, 40));
  check("G-numeric-needs-axis", (await modalState())?.buffer === "", `buffer=${(await modalState())?.buffer}`);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));

  // ── Scenario 9: R 90 — the ROTATE modal (R6-2.1) ──────────────────────────
  // A single selection's collective centre IS its own centre, so a 90-degree turn
  // must write `rotation` and NOTHING ELSE: the box does not move. That is the
  // minimal-delta discipline at the one place it is easiest to break — the stored
  // x/y come out of a back-solve, and computing them the obvious way lands ~1e-13
  // off, which `diffState` (an EXACT comparison) reads as a change and writes,
  // silently replacing any equation on x with a literal.
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyR");
  await new Promise((r) => setTimeout(r, 50));
  check("R-modal-live", (await modalState())?.kind === "rotate", `modal=${JSON.stringify(await modalState())}`);
  await page.keyboard.press("Digit9");
  await page.keyboard.press("Digit0");
  await new Promise((r) => setTimeout(r, 50));
  check("R-buffer90", (await modalState())?.buffer === "90", `buffer=${(await modalState())?.buffer}`);
  const rKeys = await previewKeys();
  check("R-writes-rotation-alone", JSON.stringify(rKeys) === JSON.stringify(["rotation"]),
    `preview keys=${JSON.stringify(rKeys)} (a self-centre turn must not move x/y)`);
  await page.screenshot({ path: `${shots}/modal_R90.png` });
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 100));
  // The number is typed in DEGREES; `rotation` stores RADIANS (web/displayUnits.js).
  check("R90-rotation", approx(await rectRotation(), Math.PI / 2), `rotation=${await rectRotation()} (expected ${Math.PI / 2})`);
  const afterR = await rectState();
  check("R90-box-unmoved", JSON.stringify(afterR) === JSON.stringify(base), `after=${JSON.stringify(afterR)}`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 80));
  check("R90-undone", approx(await rectRotation(), 0), `rotation=${await rectRotation()}`);

  // ── Scenario 10: ROTATE HAS NO AXIS (R6-2.4) ──────────────────────────────
  // The plane has ONE rotation axis, so X/Y have nothing to choose between. The
  // registry withholds the chips (MODAL_TRANSFORM_KINDS.rotate.axisConstrainable
  // is false) and CanvasView refuses the command, so the key cannot act by any
  // route. Asserting the STATE, because a chip that is hidden while the key still
  // works is the same lie one way round.
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyR");
  await page.keyboard.press("KeyX");
  await new Promise((r) => setTimeout(r, 50));
  check("R-no-axis", (await modalState())?.axis === null, `axis=${(await modalState())?.axis}`);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));

  // ── Scenario 11: THE CURSOR→PIVOT LINE, on R and S but not G (R6-2.2) ─────
  // Blender's visual proof of what the gesture measures against. A grab has no
  // pivot — the selection just follows the cursor — so drawing one there would be
  // a line about a fiction.
  check("no-pivot-line-idle", (await pivotLines()) === 0, `idle lines=${await pivotLines()}`);
  for (const [key, kind] of [["KeyR", "rotate"], ["KeyS", "scale"]]) {
    await page.mouse.move(box.x + 340, box.y + 300);
    await page.keyboard.press(key);
    await new Promise((r) => setTimeout(r, 60));
    check(`pivot-line-${kind}`, (await pivotLines()) === 1, `${kind} lines=${await pivotLines()}`);
    await page.screenshot({ path: `${shots}/modal_pivotline_${kind}.png` });
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 60));
    check(`pivot-line-${kind}-cleared`, (await pivotLines()) === 0, `after Escape lines=${await pivotLines()}`);
  }
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyG");
  await new Promise((r) => setTimeout(r, 60));
  check("no-pivot-line-grab", (await pivotLines()) === 0, `grab lines=${await pivotLines()}`);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));

  // It is a CURSOR→PIVOT line, not merely "a line": one END follows the pointer
  // and the other stays pinned. Asserted as a DIFFERENCE between two cursor
  // positions, so it holds whatever the overlay's coordinate frame is — a probe
  // that recomputed the mapping itself would be testing its own arithmetic.
  await page.mouse.move(box.x + 340, box.y + 300);
  await page.keyboard.press("KeyR");
  await new Promise((r) => setTimeout(r, 60));
  const segA = await pivotLine();
  const CURSOR_STEP = 60;
  await page.mouse.move(box.x + 340 + CURSOR_STEP, box.y + 300, { steps: 4 });
  await new Promise((r) => setTimeout(r, 60));
  const segB = await pivotLine();
  check("pivot-line-endpoint-pinned", segA && segB && approx(segA.x2, segB.x2) && approx(segA.y2, segB.y2),
    `pivot moved: ${JSON.stringify(segA)} → ${JSON.stringify(segB)}`);
  check("pivot-line-tracks-cursor", segA && segB && Math.abs((segB.x1 - segA.x1) - CURSOR_STEP) < 1 && Math.abs(segB.y1 - segA.y1) < 1,
    `cursor end moved ${segB ? segB.x1 - segA.x1 : "?"},${segB ? segB.y1 - segA.y1 : "?"} (expected ${CURSOR_STEP},0)`);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));

  // ── Scenario 12: R is REGISTERED, so the HintBar announces it ─────────────
  // "A shortcut that isn't in the registry does not exist" — and one that
  // dispatches without a chip is the same defect wearing the other face.
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyR");
  await new Promise((r) => setTimeout(r, 80));
  const hintText = await page.evaluate(() => document.querySelector(".hintbar, .hint-bar")?.textContent ?? "");
  check("R-announced", /Rotate/.test(hintText), `HintBar text did not mention the mode: ${hintText.slice(0, 200)}`);
  check("R-no-axis-chips", !/X axis|Y axis/.test(hintText), `HintBar offered an axis chip during rotate: ${hintText.slice(0, 200)}`);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));
  // …and the SCALE modal still offers them, so the gate is scoped, not blanket.
  await page.keyboard.press("KeyS");
  await new Promise((r) => setTimeout(r, 80));
  const scaleHint = await page.evaluate(() => document.querySelector(".hintbar, .hint-bar")?.textContent ?? "");
  check("S-has-axis-chips", /X axis/.test(scaleHint), `scale lost its axis chips: ${scaleHint.slice(0, 200)}`);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));

  const newErrors = errors.slice(bootErrors);
  if (newErrors.length) failures.push(`console errors during modal: ${newErrors.join(" | ")}`);

  if (failures.length) {
    console.error("MODAL XFORM PROBE FAILURES:\n" + failures.join("\n"));
    if (bootErrors) console.error(`(ignored ${bootErrors} pre-existing boot error(s) from other agents' fixture work)`);
    process.exit(1);
  }
  console.log(`Modal transform probe passed: all axis/numeric scenarios green (ignored ${bootErrors} boot error(s)).`);
} finally {
  await browser.close();
  await server.close();
}
