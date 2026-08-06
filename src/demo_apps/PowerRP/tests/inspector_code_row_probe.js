/**
 * INSPECTOR CODE-ROW AFFORDANCE probe — the `{}` button on a code-valued row.
 *
 * core/properties.js's `code: {language}` row aspect (user request, 2026-08-02:
 * "you just have a bracket thing, like a double bracket at the end of it, which
 * would let you edit in the code editor") replaced the four full-width "Edit in
 * code editor…" action rows that used to sit UNDER the property they edited.
 * tests/code_row_aspect_test.js owns the declaration half; this file owns the
 * half that is DOM and can only be measured in the real editor.
 *
 * The failure mode it exists for is silent in both directions. Declare the
 * aspect and forget the render, and the property is still editable inline — it
 * has simply lost its only route to the full-screen editor, with nothing to see.
 * Render it in the wrong place, and it lands on the keyframe diamonds or shoves
 * the value field (the standing ruling: affordances may TRUNCATE a label, never
 * MOVE the value — "that actually pushes the bar a little bit to the right, and
 * that's kind of disturbing").
 *
 * Asserts, on the REAL editor, with a mermaid widget (a literal-language row)
 * and a codeblock (the STATE-derived language, the aspect's second form):
 *   1. the code row carries a `{}` button, and a plain text row does NOT
 *   2. no full-width "Edit in code editor…" row remains anywhere in the panel
 *   3. the button sits INSIDE the row's value cell, at its trailing edge —
 *      right of the field, left of the keyframe diamonds
 *   4. the value field is NOT pushed off the shared value-column left edge
 *      (it lines up with a plain row's field)
 *   5. hovering NAMES THE LANGUAGE (the reason the aspect carries one)
 *   6. clicking opens the shared code modal ON THAT PROPERTY, seeded with the
 *      property's RAW stored source
 *   7. saving writes that property, and ONE undo restores it — one undo unit
 *   8. codeblock's button reports the language the WIDGET is set to, following
 *      its `language` property rather than a hardcoded id
 *   9. an EQUATION-bound code row withholds the button (the ƒ field is already
 *      that value's editor — ColorField's eyedropper discipline)
 *
 * Frontend-only Vite on an EPHEMERAL port (never 3637/3638).
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/inspector_code_row_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const assert = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails.push(m); };

/** The mermaid source this probe authors, so assertion 6 can prove the modal was
 *  seeded from the DOCUMENT rather than from a default or a stale buffer. */
const AUTHORED_DEFINITION = "flowchart TD\n  Probe-->Seeded";

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("PAGEERROR " + e.message));
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  // ── A mermaid diagram: `definition` declares code: {language: "mermaid"} ────
  const mermaidId = await page.evaluate((definition) => {
    const app = window.__powerrp_app;
    app.clearDoc();
    app.addItem({ type: "mermaid", x: 200, y: 200, w: 360, h: 260, rotation: 0, scale: 1, definition });
    return app.selection;
  }, AUTHORED_DEFINITION);
  assert(typeof mermaidId === "string", `a mermaid diagram was created and selected (id=${mermaidId})`);
  await sleep(1200);

  /** Reads one Inspector row's geometry + affordances by its visible label. */
  const readRow = (label) => page.evaluate((wanted) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === wanted);
    if (!row) return { found: false, labels: rows.map((r) => r.querySelector(".label")?.textContent.trim()) };
    const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
    const button = row.querySelector(".code-open");
    const field = row.querySelector('input[type="text"]');
    return {
      found: true,
      hasCodeButton: !!button,
      ariaLabel: button?.getAttribute("aria-label") ?? null,
      button: box(button),
      field: box(field),
      keyframes: box(row.querySelector(".kf-controls")),
      row: box(row),
    };
  }, label);

  const definitionRow = await readRow("Definition");
  assert(definitionRow.found, `the mermaid Definition row is rendered${definitionRow.found ? "" : " — labels seen: " + JSON.stringify(definitionRow.labels)}`);
  assert(definitionRow.hasCodeButton, "the code-aspect row carries a {} button");

  // A row on the SAME widget whose value is not code — the control group proving
  // the button is per-ROW and not per-widget chrome.
  const themeRow = await readRow("Theme");
  assert(themeRow.found && !themeRow.hasCodeButton, "a non-code row on the same widget has NO {} button");

  // (2) the full-width button rows are gone from the rendered panel, not just
  // from the source — a stale row would still render if any plugin kept one.
  const legacyRows = await page.evaluate(() =>
    [...document.querySelectorAll(".inspector .row button")].filter((b) => /Edit in code editor/i.test(b.textContent)).length);
  assert(legacyRows === 0, `no full-width "Edit in code editor…" row remains in the panel (found ${legacyRows})`);

  // (3) placement: inside the row, right of the field, left of the diamonds.
  const b = definitionRow.button, f = definitionRow.field, kf = definitionRow.keyframes;
  assert(b && f && b.left >= f.right - 1, `the {} button sits AFTER the value field (field.right=${f?.right}, button.left=${b?.left})`);
  assert(b && kf && b.right <= kf.left + 1, `the {} button sits BEFORE the keyframe diamonds (button.right=${b?.right}, kf.left=${kf?.left})`);
  assert(b && b.top >= definitionRow.row.top - 1 && b.bottom <= definitionRow.row.bottom + 1, "the {} button is vertically inside its own row (it is not overflowing)");

  // (4) the value column's left edge is SACRED: the code row's field starts at
  // the same x as a plain text row's. The button costs the field WIDTH, never
  // POSITION — the "pushes the bar to the right" ruling.
  const plainField = (await readRow("Name")).field;
  assert(plainField && Math.abs(plainField.left - f.left) <= 1,
    `the code row's field keeps the shared value-column left edge (code=${f?.left}, plain=${plainField?.left})`);

  // (5) the tooltip names the language. THE BOX IS RE-READ HERE rather than
  // reusing `b`: every readRow() above walked the panel, and a geometry captured
  // before those reads is a claim about a layout that may since have settled
  // differently — a stale point sends the pointer into empty air, which reads as
  // "the button does nothing" and is not.
  const hover = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector .row")]
      .find((r) => r.querySelector(".label")?.textContent.trim() === "Definition");
    const btn = row?.querySelector(".code-open");
    if (!btn) return null;
    btn.scrollIntoView({ block: "center" });
    const bb = btn.getBoundingClientRect();
    return { x: bb.left + bb.width / 2, y: bb.top + bb.height / 2 };
  });
  assert(hover != null, "the {} button is reachable for a real pointer gesture");
  await page.mouse.move(20, 950);
  await sleep(150);
  await page.mouse.move(hover.x, hover.y);
  await page.mouse.move(hover.x + 1, hover.y);
  await sleep(700);
  const tip = await page.evaluate(() => document.querySelector(".tt-tip")?.textContent.trim().replace(/\s+/g, " ") ?? null);
  assert(tip != null && /mermaid/i.test(tip), `hovering the {} button NAMES THE LANGUAGE -> ${JSON.stringify(tip)}`);

  // (6) clicking opens the shared modal on THAT property, seeded from the document.
  await page.mouse.down();
  await page.mouse.up();
  await sleep(900);
  const opened = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return {
      target: app.codeModal ? { scope: app.codeModal.scope, itemId: app.codeModal.itemId, property: app.codeModal.property, language: app.codeModal.language } : null,
      seed: app.codeModalValue(),
    };
  });
  assert(opened.target?.property === "definition" && opened.target?.itemId === mermaidId,
    `the modal opened on THIS item's "definition" (target=${JSON.stringify(opened.target)})`);
  assert(opened.target?.language === "mermaid", `the modal was told the row's language (${opened.target?.language})`);
  assert(opened.seed === AUTHORED_DEFINITION, `the modal is seeded with the RAW stored source (${JSON.stringify(opened.seed)})`);

  // SAVING WRITES THAT PROPERTY AS ONE UNDO UNIT. The commit path is the shared
  // one (app.commitCodeModal → setPreview → commitPreview), but the row aspect
  // is what NAMES the target, so a wrong name would land the source on a
  // different property — silently, since every write here succeeds. Undo is the
  // check that it was ONE unit and not several: a single Cmd+Z must restore the
  // original source exactly.
  const EDITED = "flowchart LR\n  Saved-->Once";
  const saved = await page.evaluate((text) => {
    const app = window.__powerrp_app;
    app.commitCodeModal(text);
    const id = app.selection;
    return { stored: app.rawState().items[id].definition, stillOpen: app.codeModal != null };
  }, EDITED);
  assert(saved.stored === EDITED, `saving writes the edited source to THAT property (${JSON.stringify(saved.stored)})`);
  assert(!saved.stillOpen, "saving closes the modal");
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(500);
  const afterUndo = await page.evaluate((id) => window.__powerrp_app.rawState().items[id].definition, mermaidId);
  assert(afterUndo === AUTHORED_DEFINITION,
    `ONE undo restores the original source — the save was ONE undo unit (${JSON.stringify(afterUndo)})`);
  await page.evaluate(() => window.__powerrp_app.closeCodeModal());
  await sleep(400);

  // ── (7) codeblock: the STATE-DERIVED language ──────────────────────────────
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.clearDoc();
    app.addItem({ type: "codeblock", x: 200, y: 200, w: 360, h: 200, rotation: 0, scale: 1, code: "x = 1", language: "python" });
  });
  await sleep(1200);
  const codeRow = await readRow("Code");
  assert(codeRow.found && codeRow.hasCodeButton, "the codeblock Code row carries a {} button");
  assert(/python/i.test(codeRow.ariaLabel ?? ""),
    `the button reports the language the WIDGET is set to, not a hardcoded id -> ${JSON.stringify(codeRow.ariaLabel)}`);

  // ── (8) an equation-bound code row STILL offers {} — reversed by user ruling ─
  // THIS CHECK USED TO ASSERT THE OPPOSITE, and the reversal is a user ruling, not a
  // convenience. It read "an EQUATION-bound code row withholds the {} button (the ƒ
  // field is already that value's editor)" — sound reasoning at the time, and overruled
  // on 2026-08-06: "Equations should ALWAYS have that option too - a code editing
  // modal, with correct autocomplete/highlighting pops up so u can edit the equation
  // multiline." The premise that failed is the parenthesis: a one-line <input> is NOT
  // already that value's editor once the value can be an expression spanning lines and
  // calling into meta.script.
  //
  // The {} it offers is a DIFFERENT one and that is why both can be true at once: the
  // `code` row's {} edits the property's literal source in the WIDGET's language
  // (python, mermaid…), while an equation-bound row's comes from
  // web/EquationCodeButton.svelte and edits the EXPRESSION in the equation language.
  // Same slot, same glyph, same job — "open this value in a real editor" — so the
  // language reported below is the thing that distinguishes them.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", app.selection, "code"], "=\"y = 2\""]]);
    app.commitPreview();
  });
  await sleep(900);
  const boundRow = await readRow("Code");
  assert(boundRow.found && boundRow.hasCodeButton,
    "an EQUATION-bound code row STILL offers {} (user 2026-08-06: equations should ALWAYS have it)");
  assert(/equation/i.test(boundRow.ariaLabel ?? ""),
    `and it is the EQUATION editor, not the widget-language one -> ${JSON.stringify(boundRow.ariaLabel)}`);

  console.log(fails.length ? `\nFAILED: ${fails.length}` : "\nPASS — Inspector code-row affordance");
  process.exitCode = fails.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
