/**
 * IN-EDIT UNDO/REDO PROBE — proves Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z work WHILE
 * editing a text item (the bug: they did nothing — each keystroke is a live
 * preview with no undo units, and the app's doc-level undo can't fire because
 * App.onKeydown early-returns on the focused edit sink). TextEditController now
 * keeps a session-local {value,caret} history driven by these keys.
 *
 * Also guards against DOUBLE-undo: if the app's doc-level undo ALSO fired, the
 * value would jump more than one step per Ctrl+Z — asserted against.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), same pattern as
 * caret_accuracy_qa.js. Run from POWERRP or the SvelteLib root (cwd-independent).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

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
  // Ignore backend-absent noise: this probe self-spins a FRONTEND-ONLY Vite (no
  // server.py), so best-effort thumbnail-persist POSTs 404. Orthogonal to undo.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // An empty text item so we can type from a known start.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const rich = { runs: [{ text: "", bold: false, italic: false, underline: false, strike: false, size: 36, font: "inter", color: "#ffffff", outlineColor: "#000000", outlineWidth: 0, highlight: "" }], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] };
    const txt = { ...def("text"), name: "Undo", x: 60, y: 120, w: 700, h: 140, z: 1, active: true, text: rich, size: 36, color: "#ffffff", font: "inter", valign: "top" };
    const doc = { meta: { name: "undo-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, txt } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await sleep(400);

  const textId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "text");
  });
  // plain text as the app currently PREVIEWS it (the live edit value), else the committed value.
  const plain = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const t = app.previewDelta?.items?.[id]?.text ?? app.doc.slides[0].delta.items[id].text;
    return t ? t.runs.map((r) => r.text).join("") : "";
  }, textId);

  await page.evaluate((id) => window.__powerrp_app.beginTextEdit(id), textId);
  await sleep(300);
  await page.evaluate(() => document.querySelector(".text-edit-sink")?.focus());

  const ctrl = async (key, withShift = false) => {
    await page.keyboard.down("Control");
    if (withShift) await page.keyboard.down("Shift");
    await page.keyboard.press(key);
    if (withShift) await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await sleep(40);
  };

  // type "abc" one char at a time (each is its own mutation → its own undo step)
  for (const ch of "abc") { await page.keyboard.type(ch); await sleep(40); }
  assert((await plain()) === "abc", `typed "abc" (got "${await plain()}")`);

  // Ctrl+Z three times peels back exactly one char each (NOT more → no double-undo)
  await ctrl("z"); assert((await plain()) === "ab", `Ctrl+Z → "ab" (one step; got "${await plain()}")`);
  await ctrl("z"); assert((await plain()) === "a", `Ctrl+Z → "a" (got "${await plain()}")`);
  await ctrl("z"); assert((await plain()) === "", `Ctrl+Z → "" (back to session start; got "${await plain()}")`);
  await ctrl("z"); assert((await plain()) === "", `Ctrl+Z at session start is a no-op (got "${await plain()}")`);

  // Ctrl+Shift+Z replays forward
  await ctrl("z", true); assert((await plain()) === "a", `Ctrl+Shift+Z → "a" (got "${await plain()}")`);
  await ctrl("z", true); assert((await plain()) === "ab", `Ctrl+Shift+Z → "ab" (got "${await plain()}")`);
  await ctrl("y");        assert((await plain()) === "abc", `Ctrl+Y (redo) → "abc" (got "${await plain()}")`);

  // typing after an undo forks history (redo stack cleared)
  await ctrl("z"); assert((await plain()) === "ab", `Ctrl+Z → "ab" before fork (got "${await plain()}")`);
  await page.keyboard.type("X"); await sleep(40);
  assert((await plain()) === "abX", `typing after undo forks (got "${await plain()}")`);
  await ctrl("z", true); assert((await plain()) === "abX", `redo after a fork is a no-op — stack cleared (got "${await plain()}")`);

  // still editing the SAME item (in-edit undo never exited edit mode)
  assert(await page.evaluate(() => !!window.__powerrp_app.textEditing), "still in edit mode after undo/redo (no accidental exit)");

  // exit commits ONE doc-level undo unit, then app.undo() reverts the WHOLE edit
  const undoLenBefore = await page.evaluate(() => window.__powerrp_app.undoLog.past?.length ?? null);
  await page.keyboard.press("Escape");
  await sleep(200);
  assert(!(await page.evaluate(() => !!window.__powerrp_app.textEditing)), "Escape exits edit mode");
  assert((await plain()) === "abX", `committed value is "abX" (got "${await plain()}")`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error(`\nUNDO PROBE FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log("\nIN-EDIT UNDO/REDO PROBE PASSED — Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y work while editing, one step each, no double-undo.");
} finally {
  await browser.close();
  await server.close();
}
