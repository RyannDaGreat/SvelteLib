/**
 * PLAINTEXT INLINE-EDIT PROBE — proves the plaintext widget's NEW double-click
 * WYSIWYG in-place editing (it previously could only be edited via the Inspector).
 * It REUSES the rich text widget's Skia-owned in-place editor (TextEditController)
 * in PLAIN-STRING mode, opted into declaratively by the plaintext plugin's
 * `inlineTextEdit` descriptor.
 *
 * Verifies:
 *   1. plaintextPlugin declares `inlineTextEdit: {property:"text", plain:true}`.
 *   2. A REAL double-click on the box (dispatched at an on-glyph client point)
 *      enters edit mode in plain mode (app.textEditing = {plain:true, ...}).
 *   3. The in-place editor mounts (the shared `.text-edit-sink`) with NO rich
 *      format toolbar (plain string → no per-run styling UI).
 *   4. Typing updates the widget's stored `text` as a PLAIN STRING (never a
 *      {runs,paras} value) live; Escape commits it as one doc undo unit.
 *   5. An `=` equation-bound `text` is NOT opened in place (would overwrite the
 *      equation with its value) — the double-click is a no-op; the equation
 *      stays intact.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), same pattern as
 * text_undo_probe.js. Run from POWERRP or the SvelteLib root (cwd-independent).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Ignore backend-absent noise: this probe self-spins a FRONTEND-ONLY Vite (no
  // server.py), so best-effort thumbnail-persist POSTs and the project-asset
  // listing 404/500. All orthogonal to in-place text editing.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7|listAssets|could not list project assets|\/api\/assets/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // (1) The declarative opt-in exists.
  const descriptor = await page.evaluate(() => window.__powerrp_app.registry.get("plaintext")?.inlineTextEdit ?? null);
  assert(descriptor && descriptor.plain === true && descriptor.property === "text",
    `plaintextPlugin declares inlineTextEdit {property:"text", plain:true} (got ${JSON.stringify(descriptor)})`);

  // A single plaintext box with a known literal string.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const pt = { ...def("plaintext"), name: "Caption", x: 60, y: 120, w: 700, h: 140, z: 1, active: true, text: "Hello", size: 48, fill: "#ffffff", font: "inter", align: "left", valign: "top" };
    const doc = { meta: { name: "plaintext-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, pt } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await sleep(400);

  const ptId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "plaintext");
  });

  // The RAW stored `text` (string in the committed doc, or the live preview).
  const stored = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    return app.previewDelta?.items?.[id]?.text ?? app.doc.slides[0].delta.items[id].text;
  }, ptId);

  // (2) REAL double-click routing. Get a guaranteed on-glyph client point by
  // briefly entering edit (to read caretScreen through the render-area frame),
  // then cancel and dispatch a genuine dblclick at that point.
  await page.evaluate((id) => window.__powerrp_app.beginTextEdit(id, { property: "text", plain: true }), ptId);
  await sleep(300);
  const pt2 = await page.evaluate(() => {
    const c = window.__powerrp_textEdit?.caretScreen(0);       // render-area-frame coords at glyph start
    const r = document.querySelector(".overlay").getBoundingClientRect();
    if (!c) return null;
    return { x: r.left + c.x + 12, y: r.top + (c.y + c.y2) / 2 }; // nudge right, into "Hello"
  });
  assert(!!pt2, "got an on-glyph screen point via the mounted editor");
  await page.evaluate(() => window.__powerrp_app.cancelTextEdit());
  await sleep(200);
  assert(!(await page.evaluate(() => !!window.__powerrp_app.textEditing)), "edit cancelled (clean slate before the real double-click)");

  await page.evaluate(({ x, y }) => {
    const el = document.querySelector(".overlay");
    el.dispatchEvent(new MouseEvent("dblclick", { clientX: x, clientY: y, bubbles: true }));
  }, pt2);
  await sleep(300);
  // Read fields explicitly: textEditing is a Svelte $state proxy that serializes
  // to {} through puppeteer's returnByValue — copy the primitives in-page.
  const editing = await page.evaluate(() => {
    const t = window.__powerrp_app.textEditing;
    return t ? { itemId: t.itemId, plain: t.plain, property: t.property } : null;
  });
  assert(editing && editing.itemId === ptId && editing.plain === true,
    `double-click ENTERED plain in-place edit (textEditing=${JSON.stringify(editing)})`);

  // (3) editor mounted + NO rich format toolbar.
  await page.evaluate(() => document.querySelector(".text-edit-sink")?.focus());
  await sleep(100);
  assert(await page.evaluate(() => !!document.querySelector(".text-edit-sink")), "in-place editor mounted (.text-edit-sink present)");
  assert(await page.evaluate(() => !document.querySelector(".text-format-toolbar")),
    "NO rich format toolbar in plain mode (.text-format-toolbar absent)");

  // (4) typing updates the stored `text` as a PLAIN STRING, live.
  await page.keyboard.type(" World"); // caret seeded at end on mount
  await sleep(120);
  const live = await stored();
  assert(typeof live === "string", `live value is a PLAIN STRING, not {runs,paras} (typeof=${typeof live})`);
  assert(live === "Hello World", `typing appended live → "Hello World" (got ${JSON.stringify(live)})`);

  await page.keyboard.press("Escape");
  await sleep(200);
  assert(!(await page.evaluate(() => !!window.__powerrp_app.textEditing)), "Escape exits edit mode");
  const committed = await stored();
  assert(committed === "Hello World", `committed text is the plain string "Hello World" (got ${JSON.stringify(committed)})`);
  assert(typeof committed === "string", "committed value stays a plain string (widget model unchanged)");

  // (5) equation-bound `text` is NOT opened in place — no clobber. Use a
  // STRING-valued equation (a `text` slot demands a string result) so it
  // evaluates cleanly; the guard only cares that the RAW value starts with "=".
  const EQ = '="edited"';
  await page.evaluate((id, eq) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "text"], eq]]);
    app.commitPreview();
    app.selection = null;
  }, ptId, EQ);
  await sleep(200);
  assert((await stored()) === EQ, "text set to an = equation for the guard test");
  await page.evaluate((id) => window.__powerrp_app.beginTextEdit(id, { property: "text", plain: true }), ptId);
  await sleep(200);
  assert(!(await page.evaluate(() => !!window.__powerrp_app.textEditing)), "equation-bound text is a NO-OP for in-place edit (routed to Inspector)");
  assert((await stored()) === EQ, "the equation is INTACT (never flattened to its value)");

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error(`\nPLAINTEXT INLINE-EDIT PROBE FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log("\nPLAINTEXT INLINE-EDIT PROBE PASSED — double-click → type → commit edits the plain string in place; equations are left untouched.");
} finally {
  await browser.close();
  await server.close();
}
