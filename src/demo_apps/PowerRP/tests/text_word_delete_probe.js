/**
 * WORD/LINE DELETE PROBE — proves the WYSIWYG text editor honors the macOS
 * deletion modifiers (user ruling 2026-07-30: Alt+Backspace deleted nothing):
 *
 *   Alt+Backspace   deletes the previous WORD (same boundary Alt+Left walks to)
 *   Cmd+Backspace   deletes to the start of the visual LINE
 *   Alt+Delete      deletes the next word (forward mirror)
 *   plain Backspace still deletes exactly one character
 *   a SELECTION wins over any modifier (deletes the selection, nothing more)
 *
 * Word/line targets come from the SAME layout helpers the arrow keys use
 * (wordStartBefore/lineStart in TextEditController), so caret navigation and
 * deletion can never disagree about where a word begins.
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), same pattern
 * as text_undo_probe.js. Run from POWERRP or the SvelteLib root.
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
  // Frontend-only Vite (no server.py): best-effort thumbnail POSTs 404 — noise.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // One text item with KNOWN content spanning two lines (explicit \n).
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const rich = { runs: [{ text: "", bold: false, italic: false, underline: false, strike: false, size: 36, font: "inter", color: "#ffffff", outlineColor: "#000000", outlineWidth: 0, highlight: "" }], paras: [{ align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 }] };
    const txt = { ...def("text"), name: "WordDel", x: 60, y: 120, w: 700, h: 200, z: 1, active: true, text: rich, size: 36, color: "#ffffff", font: "inter", valign: "top" };
    const doc = { meta: { name: "worddel-qa", slideW: 1000, slideH: 500 }, slides: [
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
  // Plain text as the app currently PREVIEWS it (live edit value), else committed.
  const plain = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const t = app.previewDelta?.items?.[id]?.text ?? app.doc.slides[0].delta.items[id].text;
    return t ? t.runs.map((r) => r.text).join("") : "";
  }, textId);

  /** Command. One keypress with held modifiers driven through real keyboard events. */
  const press = async (key, ...mods) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.keyboard.press(key);
    for (const m of mods.reverse()) await page.keyboard.up(m);
    await sleep(60);
  };
  /** Command. Fresh edit session on known text, caret at the very end. */
  const startEdit = async (content) => {
    await page.evaluate((id, content) => {
      const app = window.__powerrp_app;
      if (app.textEditing) app.commitTextEdit();
      const t = app.doc.slides[0].delta.items[id].text;
      app.commit({ ...app.doc, slides: app.doc.slides.map((s, i) => i !== 0 ? s : ({ ...s, delta: { ...s.delta, items: { ...s.delta.items, [id]: { ...s.delta.items[id], text: { ...t, runs: [{ ...t.runs[0], text: content }] } } } } })) });
      app.beginTextEdit(id);
    }, textId, content);
    await sleep(250);
    await page.evaluate(() => document.querySelector(".text-edit-sink")?.focus());
    await press("a", "Meta"); // select all…
    await press("ArrowRight"); // …then collapse: caret at DOC END, deterministically
  };

  // ── 1. Alt+Backspace deletes the previous word ────────────────────────────
  await startEdit("hello brave new world");
  await press("ArrowRight", "Meta"); // caret to line end
  await press("Backspace", "Alt");
  assert((await plain()) === "hello brave new ", `Alt+Backspace deletes "world" -> "hello brave new " (got ${JSON.stringify(await plain())})`);
  await press("Backspace", "Alt");
  assert((await plain()) === "hello brave ", `second Alt+Backspace deletes "new " -> "hello brave " (got ${JSON.stringify(await plain())})`);

  // ── 2. Cmd+Backspace deletes to line start; line 2 unharmed by line 1 ─────
  await startEdit("first line\nsecond line");
  await press("ArrowRight", "Meta"); // end of the LAST line (caret starts at doc end anyway)
  await press("Backspace", "Meta");
  assert((await plain()) === "first line\n", `Cmd+Backspace at end of line 2 clears only line 2 (got ${JSON.stringify(await plain())})`);
  await press("Backspace", "Meta");
  assert((await plain()) === "first line\n", `Cmd+Backspace AT line start is a no-op, does not eat the newline (got ${JSON.stringify(await plain())})`);

  // ── 3. Alt+Delete deletes the next word (forward mirror) ──────────────────
  await startEdit("alpha beta gamma");
  await press("ArrowLeft", "Meta"); // caret to line start
  await press("Delete", "Alt");
  const afterFwd = await plain();
  assert(afterFwd === " beta gamma", `Alt+Delete at start deletes "alpha" -> " beta gamma" (got ${JSON.stringify(afterFwd)})`);

  // ── 4. plain Backspace still deletes exactly one character ────────────────
  await startEdit("ab");
  await press("ArrowRight", "Meta");
  await press("Backspace");
  assert((await plain()) === "a", `plain Backspace deletes one char (got ${JSON.stringify(await plain())})`);

  // ── 5. a selection beats the modifier: Alt+Backspace removes ONLY it ──────
  await startEdit("one two three");
  await press("ArrowLeft", "Meta"); // line start
  await press("ArrowRight", "Alt", "Shift"); // select "one"
  await press("Backspace", "Alt");
  assert((await plain()) === " two three", `Alt+Backspace with a selection deletes just the selection (got ${JSON.stringify(await plain())})`);

  await page.keyboard.press("Escape"); // commit, leave the app clean
  await sleep(150);

  if (errors.length) { console.error("LIVE ERRORS:\n" + errors.join("\n")); fails.push("console/page errors during probe"); }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`text_word_delete_probe: ${fails.length} FAILED`); process.exit(1); }
console.log("text_word_delete_probe: all checks passed");
