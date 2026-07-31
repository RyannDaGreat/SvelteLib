/**
 * TEXT EDIT-MODE DISMISSAL probe (Round 15.2, verification — ephemeral).
 *
 * The user's complaint (with a screenshot of a stuck toolbar): "the editor for
 * text looks good now! but like, how do i make the editing bar go away". The
 * WYSIWYG toolbar/overlay (Round 13.4) had no obvious/reliable exit besides a
 * real Esc keydown. This probe drives EVERY dismissal path with real puppeteer
 * gestures (mouse clicks, real keydown, real DOM state writes the same UI
 * buttons trigger) and asserts each one commits (or cancels, if the edited
 * item no longer exists) + exits edit mode, never stranding the overlay:
 *
 *  D1 — real Esc keydown (page.keyboard.press, not a unit call) commits + exits.
 *  D2 — click-away on EMPTY canvas commits + exits.
 *  D3 — click on ANOTHER item commits the first edit AND selects that item,
 *       in the SAME gesture (the "click continues to its target" ordering
 *       choice — see App.svelte's onPointerDownCapture doc).
 *  D4 — click on a TOOLBAR button (bold) does NOT dismiss (still editing).
 *  D5 — switching slides (SlideNav-style direct app.slideIndex write) commits
 *       + exits.
 *  D6 — deleteSelection() (Delete/Backspace) on the edited item commits (item
 *       still exists, just deactivated) + exits.
 *  D7 — purgeSelection() on the edited item CANCELS (item is gone — nothing
 *       to commit) + exits, doc has no dangling preview.
 *
 * Spawns its OWN vite (editor_smoke/text_wysiwyg_probe pattern). Run from
 * SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/text_dismissal_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) fails.push(msg); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/WebGPU|VideoV7/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 700));
  if (errors.length) { console.error("PAGE ERRORS AT BOOT:\n" + errors.join("\n")); process.exit(1); }

  // Two text items on slide 1 (so click-away has an unambiguous "other item"
  // target) + a second slide (so slide-switch is a real navigation).
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const richText = (text) => ({ runs: [{ text, bold: false, italic: false, underline: false, strike: false, size: 28, font: "system", color: "#ffffff", outlineColor: "#000000", outlineWidth: 0, highlight: "" }], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 300, z: 1000, active: true, background: "#101014" };
    const txtA = { ...def("text"), name: "TextA", x: 20, y: 20, w: 150, h: 50, z: 1, active: true, text: richText("Alpha"), size: 28, color: "#ffffff", font: "system" };
    const txtB = { ...def("text"), name: "TextB", x: 220, y: 200, w: 150, h: 50, z: 2, active: true, text: richText("Beta"), size: 28, color: "#ffffff", font: "system" };
    const doc = { meta: { name: "dismissal-probe", slideW: 400, slideH: 300 }, slides: [
      { id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, txtA, txtB } } },
      { id: "s1", name: "Slide 2", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: {} },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await new Promise((r) => setTimeout(r, 400));
  if (errors.length) { console.error("PAGE ERRORS AFTER DOC LOAD:\n" + errors.join("\n")); process.exit(1); }

  const ids = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return {
      a: Object.keys(items).find((id) => items[id].name === "TextA"),
      b: Object.keys(items).find((id) => items[id].name === "TextB"),
    };
  });

  async function screenCenterOf(id) {
    return await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const n = app.nodes().find((nn) => nn.itemId === id);
      const T = { apply: (t, px, py) => { const c = Math.cos(t.rotation), s = Math.sin(t.rotation); return { x: t.x + t.scale * (c * px - s * py), y: t.y + t.scale * (s * px + c * py) }; } };
      const w = n.state.w ?? 0, h = n.state.h ?? 0;
      const wp = T.apply(n.world, w / 2, h / 2);
      const s = app.canvasActions.worldToScreen(wp.x, wp.y);
      const rect = document.querySelector(".render-area").getBoundingClientRect();
      return { x: rect.left + s.x, y: rect.top + s.y };
    }, id);
  }
  async function emptyCanvasScreenPoint() {
    // A point inside the render-area but outside both text boxes and the camera
    // border (bottom-right corner region of the camera, away from either item).
    return await page.evaluate(() => {
      const rect = document.querySelector(".render-area").getBoundingClientRect();
      return { x: rect.left + rect.width * 0.85, y: rect.top + rect.height * 0.15 };
    });
  }
  const isEditing = () => page.evaluate(() => !!window.__powerrp_app.textEditing?.itemId);
  const editingId = () => page.evaluate(() => window.__powerrp_app.textEditing?.itemId ?? null);
  const selection = () => page.evaluate(() => window.__powerrp_app.selection);
  const overlayMounted = () => page.evaluate(() => !!document.querySelector(".text-edit-overlay-root"));
  const storedText = (id) => page.evaluate((id) => {
    const t = window.__powerrp_app.doc.slides[0].delta.items[id]?.text;
    return t ? t.runs.map((r) => r.text).join("") : null;
  }, id);
  const itemExists = (id) => page.evaluate((id) => !!window.__powerrp_app.state().items?.[id], id);
  const itemActive = (id) => page.evaluate((id) => window.__powerrp_app.state().items?.[id]?.active ?? null, id);

  async function enterEdit(id) {
    const c = await screenCenterOf(id);
    await page.mouse.click(c.x, c.y, { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 200));
  }
  async function typeAppend(text) {
    // Place the caret at the end and type — mirrors a real user typing more
    // text before trying to leave edit mode (dismissal must not drop this).
    await page.keyboard.press("End");
    await page.keyboard.type(text);
    await new Promise((r) => setTimeout(r, 150));
  }

  // ── D1: real Esc keydown commits + exits ──────────────────────────────────
  await enterEdit(ids.a);
  assert(await isEditing(), "D1 setup: dblclick should enter edit mode");
  await typeAppend("!");
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 200));
  assert(!(await isEditing()), "D1: real Esc keydown should exit edit mode");
  assert(!(await overlayMounted()), "D1: the overlay should unmount after Esc");
  assert((await storedText(ids.a)) === "Alpha!", `D1: Esc should COMMIT the typed text (got "${await storedText(ids.a)}")`);

  // ── D2: click-away on EMPTY canvas commits + exits ────────────────────────
  await enterEdit(ids.a);
  await typeAppend(" more");
  const empty = await emptyCanvasScreenPoint();
  await page.mouse.click(empty.x, empty.y);
  await new Promise((r) => setTimeout(r, 200));
  assert(!(await isEditing()), "D2: click-away on empty canvas should exit edit mode");
  assert(!(await overlayMounted()), "D2: the overlay should unmount after click-away");
  assert((await storedText(ids.a)) === "Alpha! more", `D2: click-away should COMMIT the typed text (got "${await storedText(ids.a)}")`);

  // ── D3: click on ANOTHER item commits the first edit AND selects it ──────
  await enterEdit(ids.a);
  await typeAppend("X");
  const bCenter = await screenCenterOf(ids.b);
  await page.mouse.click(bCenter.x, bCenter.y);
  await new Promise((r) => setTimeout(r, 200));
  assert(!(await isEditing()), "D3: clicking another item should exit edit mode on the first");
  assert((await storedText(ids.a)) === "Alpha! moreX", `D3: the first item's edit should COMMIT (got "${await storedText(ids.a)}")`);
  assert((await selection()) === ids.b, "D3: the SAME click should select the clicked-on item (commit-then-continue ordering)");

  // ── D4: click on a TOOLBAR button (Bold) does NOT dismiss ─────────────────
  await enterEdit(ids.b);
  const boldBtn = await page.evaluate(() => {
    const btn = document.querySelector('.text-format-toolbar button[aria-label="Bold"]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  assert(boldBtn, "D4 setup: the floating format toolbar's Bold button should be in the DOM while editing");
  if (boldBtn) {
    await page.mouse.click(boldBtn.x, boldBtn.y);
    await new Promise((r) => setTimeout(r, 200));
    assert(await isEditing(), "D4: clicking a toolbar button (Bold) must NOT dismiss edit mode");
  }
  await page.keyboard.press("Escape"); // clean up back to not-editing for the next case
  await new Promise((r) => setTimeout(r, 200));

  // ── D5: switching slides commits + exits ──────────────────────────────────
  await enterEdit(ids.a);
  await typeAppend("Y");
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 1; }); // SlideNav's exact write (app.slideIndex = i)
  await new Promise((r) => setTimeout(r, 200));
  assert(!(await isEditing()), "D5: switching slides should exit edit mode");
  assert(!(await overlayMounted()), "D5: the overlay should unmount after a slide switch");
  assert((await storedText(ids.a)) === "Alpha! moreXY", `D5: slide switch should COMMIT the typed text (got "${await storedText(ids.a)}")`);
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; });
  await new Promise((r) => setTimeout(r, 200));

  // ── D6: deleteSelection() (deactivate) on the EDITED item commits + exits ─
  await enterEdit(ids.a);
  await typeAppend("Z");
  await page.evaluate(() => window.__powerrp_app.deleteSelection());
  await new Promise((r) => setTimeout(r, 200));
  assert(!(await isEditing()), "D6: deleteSelection (deactivate) on the edited item should exit edit mode");
  assert((await storedText(ids.a)) === "Alpha! moreXYZ", `D6: deactivate should still COMMIT the pending text first (got "${await storedText(ids.a)}")`);
  assert((await itemExists(ids.a)) === true, "D6 sanity: deactivate keeps the item OBJECT alive (unlike purge)");
  assert((await itemActive(ids.a)) === false, "D6 sanity: the item should be deactivated (active:false)");
  await page.evaluate(() => window.__powerrp_app.showSelection()); // restore visibility for the next case
  await new Promise((r) => setTimeout(r, 150));

  // ── D7: purgeSelection() on the EDITED item CANCELS (nothing to commit) ──
  await enterEdit(ids.b);
  await typeAppend("W");
  const preEditText = "Beta"; // unchanged in storage — never committed
  await page.evaluate(() => window.__powerrp_app.purgeSelection());
  await new Promise((r) => setTimeout(r, 200));
  assert(!(await isEditing()), "D7: purgeSelection on the edited item should exit edit mode");
  assert(!(await overlayMounted()), "D7: the overlay should unmount after a purge");
  const bGoneCheck = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items?.[id], ids.b);
  // After a purge every keyframe of the item is stripped document-wide — there
  // is nothing left to read "committed text" from; the assertion that matters
  // is that no crash/stray preview occurred and edit mode is cleanly exited.
  assert(bGoneCheck === undefined || bGoneCheck === null, "D7: purge should remove the item's slide-0 keyframes entirely (no half-committed leftovers)");

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));

  if (fails.length) {
    console.error("TEXT DISMISSAL PROBE FAILURES:\n" + fails.join("\n"));
    process.exit(1);
  }
  console.log("  D1 Esc (real keydown): commits + exits.");
  console.log("  D2 click-away (empty canvas): commits + exits.");
  console.log("  D3 click another item: commits first edit + selects the new item, one gesture.");
  console.log("  D4 toolbar click (Bold): does NOT dismiss.");
  console.log("  D5 slide switch: commits + exits.");
  console.log("  D6 deleteSelection (deactivate) on edited item: commits + exits.");
  console.log("  D7 purgeSelection on edited item: cancels (nothing to commit) + exits.");
  console.log("\nText edit-mode dismissal probe passed.");
} finally {
  await browser.close();
  await server.close();
}
