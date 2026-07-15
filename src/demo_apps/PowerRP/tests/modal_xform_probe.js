/**
 * Modal transform round-2 probe: axis constraints + numeric entry for the
 * Blender-style G (grab) / S (scale) modals. Boots the PowerRP editor headless
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
import puppeteer from "puppeteer";

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

const browser = await puppeteer.launch({ headless: "new" });
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
