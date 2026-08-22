/**
 * LIST-ELEMENT ƒ / LABEL OVERLAP PROBE.
 *
 * The bug, user verbatim: "When I'm hovering over the elements that are for
 * gradient stops, the function [ƒ] goes on top of it. It goes on top of the
 * label — I can't read the label anymore because there's a function thing going
 * in front of it." The screenshot showed a stop's `offset` row reading `offs⨍x`.
 *
 * Mechanism: `.numfield .eq-open` is 16px (--a-row-chrome-w) positioned
 * `right:100%` off the numeric field, i.e. hanging into whatever sits left of it.
 * In a `.listfield .list-field` the only clearance was the 2px --a-sp-1 flex gap,
 * so ~14px of the glyph landed on the label's trailing characters. The top-level
 * `.inspector .row` and the nested `.paint-sub-row` both already reserve that
 * landing space in the label; the list-element row did not.
 *
 * THE STANDING RULING this asserts (commit 4b8da20): affordances may TRUNCATE a
 * label, never MOVE it, and never paint over its glyphs. So:
 *
 *   1. DISJOINT — the ƒ's rect and the label's VISIBLE-GLYPH rect must not
 *      intersect. Getting that rect right is the subtle part, because two
 *      obvious measurements both lie, in the same direction:
 *        - the SPAN's border box overstates: it now carries the reserved
 *          padding-right gutter the ƒ deliberately sits inside, so the box
 *          legitimately overlaps the glyph while the glyphs do not. (Padding lies.)
 *        - a bare Range over the text node ALSO overstates, and by more: with
 *          `overflow:hidden`, Range.getBoundingClientRect reports the text's
 *          UNCLIPPED layout extent, straight through the clip edge. On this row
 *          that is 1179.86 against a content box ending at 1165.31 — 14.55px of
 *          text that is never painted. Asserting on it reports a 14.55px overlap
 *          for a row where nothing overlaps.
 *      The honest rect is the Range INTERSECTED WITH the span's content box.
 *   2. STILL — the label text's rect during hover is identical to at rest. The
 *      reveal is opacity-only; nothing may reflow.
 *   3. CLICKABLE — the ƒ still hit-tests to itself (elementFromPoint at its
 *      centre) and opens the equation editor.
 *
 * THREE templates are covered, which is every NumericField mount site that was
 * missing the gutter (the sweep also found PaintField's rows already fixed by
 * .paint-sub-label, and the Inspector's own rows fixed by 4b8da20):
 *   - a gradient STOP's offset (.listfield .list-field) — the user's repro,
 *     14.55px of overlap before, 0.00px after;
 *   - a GLOBAL VARIABLES row's identifier, an <input> that cannot ellipsize —
 *     7px of overlap before, -1px after. THAT CELL HAS SINCE BEEN REBUILT: the
 *     kind picker moved in beside the name (15a7d333), so the label cell is now
 *     the `.var-ident` wrapper and the gutter is reserved on IT, not on
 *     `.var-name` (app.css:7804-7812). The disjointness check was re-aimed at the
 *     cell and JOINED BY TWO CONTAINMENT CHECKS, which are RED against a real
 *     product defect — the 84px non-shrinkable picker overflows a 55.16px cell
 *     and displaces the name input out of the label column entirely. The full
 *     measurement and the offending CSS lines are recorded at the checks
 *     themselves; nothing is fixed here, because product CSS is outside this
 *     file's lease;
 *   - the varspanel ADD row, asserted to reserve NO gutter, since it mounts no
 *     ƒ and paying for one would only shrink its text box.
 *
 * Spawns its OWN isolated Vite + headless Chromium, same pattern as
 * text_undo_probe.js. Run from POWERRP or the SvelteLib root (cwd-independent).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

// HMR OFF, watcher muted: this tree has concurrent agents editing it, and a
// reload mid-measurement destroys the execution context (observed). Same
// reasoning cli/render_job.js states for its own dev server.
const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: { ignored: ["**/*"] } } });
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
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A plain rect, selected. Its fill is a colour string at this point.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const rect = { ...def("rect"), name: "Grad", x: 100, y: 100, w: 400, h: 200, z: 1, active: true };
    const doc = { meta: { name: "fx-overlap-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, rect } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
  });
  await sleep(400);

  const rectId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "rect");
  });
  // `selection` is a bare item id, not a {ids:[…]} record.
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
  await sleep(700);

  // Switch the FILL paint to Linear THROUGH THE UI. Authoring it by hand as a
  // legacy inline {type,stops,…} is NOT the current schema — PaintField stores a
  // multi-sub-state wrapper — and a hand-written one renders no stops list at all.
  // Clicking the tab is also the honest repro: it is what the user did.
  const modeClicked = await page.evaluate(() => {
    const pf = document.querySelector(".paintfield");
    if (!pf) return "no paintfield";
    const tab = [...pf.querySelectorAll(".paint-type-tab")].find((b) => /^linear$/i.test(b.textContent.trim()));
    if (!tab) return "no linear tab";
    tab.click();
    return "clicked";
  });
  await sleep(800);
  assert(modeClicked === "clicked", `switched the fill paint to Linear via its mode strip (${modeClicked})`);

  // The stops list renders through web/ListField.svelte. Expand it if collapsed.
  const expanded = await page.evaluate(() => {
    if (document.querySelector(".listfield .list-el")) return "already";
    const h = document.querySelector(".listfield .cat-header");
    if (!h) return "none";
    h.click();
    return "clicked";
  });
  await sleep(500);
  assert(expanded !== "none", `stops list is present in the Inspector (${expanded})`);

  // Locate the OFFSET field of a middle stop — the exact row from the screenshot.
  const found = await page.evaluate(() => {
    const fields = [...document.querySelectorAll(".listfield .list-field")];
    const hit = fields.find((f) => f.querySelector(".list-field-label")?.textContent.trim() === "offset" && f.querySelector(".numfield .eq-open"));
    if (!hit) return null;
    hit.setAttribute("data-probe", "target");
    // Scroll it into the Inspector's viewport: a real mouse.move can only hover
    // what is actually on screen, and an off-screen row would report opacity 0
    // for a reveal that works fine.
    hit.scrollIntoView({ block: "center" });
    return { label: hit.querySelector(".list-field-label").textContent.trim(), fieldCount: fields.length };
  });
  await sleep(400);
  assert(found !== null, "found a stop's `offset` .list-field carrying a ƒ affordance");
  if (!found) throw new Error("no offset field with an eq-open; cannot measure");
  console.log(`  .. ${found.fieldCount} list-field(s); target label "${found.label}"`);

  /**
   * Measure the label's VISIBLE-GLYPH rect and the ƒ's rect.
   *
   * TWO measurements lie here, in opposite directions, and the honest number is
   * neither of them:
   *   - the SPAN's border box overstates, because the span now carries the
   *     reserved padding-right gutter the ƒ deliberately sits inside. (This is
   *     the "padding lies" trap.)
   *   - a bare Range over the text node ALSO overstates, and by more: with
   *     `overflow:hidden` on the span, Range.getBoundingClientRect reports the
   *     text's UNCLIPPED layout extent, straight through the clip edge. Measured
   *     on this row: range.right 1179.86 vs a content box ending at 1165.31 —
   *     14.55px of text that is not painted. Asserting on that raw number would
   *     report a 14.55px overlap for a row where nothing overlaps at all.
   *
   * So: intersect the Range with the span's CONTENT box. That is what the user
   * can actually read, which is what the ruling is about.
   */
  const measure = () => page.evaluate(() => {
    const field = document.querySelector('[data-probe="target"]');
    const span = field.querySelector(".list-field-label");
    const fx = field.querySelector(".numfield .eq-open");
    const cs = getComputedStyle(span);
    const s = span.getBoundingClientRect();
    const contentLeft = s.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const contentRight = s.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    const r = document.createRange();
    r.selectNodeContents(span);
    const raw = r.getBoundingClientRect();
    const x = Math.max(raw.left, contentLeft);
    const right = Math.min(raw.right, contentRight);
    const f = fx.getBoundingClientRect();
    return {
      text: { x, right, w: right - x, y: raw.y, h: raw.height },
      rawText: { x: raw.x, right: raw.right, w: raw.width },
      clipped: raw.right > contentRight + 0.01,
      span: { x: s.x, w: s.width, right: s.right },
      fx: { x: f.x, y: f.y, w: f.width, h: f.height, right: f.right },
      fxOpacity: Number(getComputedStyle(fx).opacity),
    };
  });

  const rest = await measure();
  console.log(`  .. AT REST  text x=${rest.text.x.toFixed(2)} w=${rest.text.w.toFixed(2)} right=${rest.text.right.toFixed(2)} | fx x=${rest.fx.x.toFixed(2)} w=${rest.fx.w.toFixed(2)} opacity=${rest.fxOpacity}`);

  // HOVER the target row. The reveal is driven by `.inspector .row:hover`, so the
  // pointer goes to the label's own centre — the very text the user was reaching
  // for, which is exactly the case that used to be covered by the glyph.
  await page.mouse.move(rest.text.x + rest.text.w / 2, rest.text.y + rest.text.h / 2);
  await sleep(350); // --a-row-chrome-fade

  const hov = await measure();
  console.log(`  .. ON HOVER text x=${hov.text.x.toFixed(2)} w=${hov.text.w.toFixed(2)} right=${hov.text.right.toFixed(2)} | fx x=${hov.fx.x.toFixed(2)} w=${hov.fx.w.toFixed(2)} opacity=${hov.fxOpacity}`);

  assert(hov.fxOpacity > 0.9, `the ƒ is actually REVEALED on hover (opacity ${hov.fxOpacity}) — otherwise disjointness is vacuous`);

  // (1) DISJOINT — the whole point.
  const overlap = Math.min(hov.text.right, hov.fx.right) - Math.max(hov.text.x, hov.fx.x);
  const gap = hov.fx.x - hov.text.right;
  console.log(`  .. horizontal overlap = ${overlap.toFixed(2)}px (negative = disjoint); gap text→fx = ${gap.toFixed(2)}px`);
  assert(overlap <= 0, `label TEXT and ƒ rects are DISJOINT on hover (overlap ${overlap.toFixed(2)}px <= 0)`);
  assert(hov.fx.x >= hov.text.right, `the ƒ starts at or after the label text ends (fx.x ${hov.fx.x.toFixed(2)} >= text.right ${hov.text.right.toFixed(2)})`);

  // (2) STILL — hover may not move one pixel of text.
  assert(Math.abs(hov.text.x - rest.text.x) < 0.01, `label text LEFT edge unchanged by hover (${rest.text.x.toFixed(4)} → ${hov.text.x.toFixed(4)})`);
  assert(Math.abs(hov.text.w - rest.text.w) < 0.01, `label text WIDTH unchanged by hover (${rest.text.w.toFixed(4)} → ${hov.text.w.toFixed(4)})`);
  assert(Math.abs(hov.text.right - rest.text.right) < 0.01, `label text RIGHT edge unchanged by hover (${rest.text.right.toFixed(4)} → ${hov.text.right.toFixed(4)})`);
  assert(Math.abs(hov.fx.x - rest.fx.x) < 0.01, `the ƒ does not MOVE between rest and hover (${rest.fx.x.toFixed(4)} → ${hov.fx.x.toFixed(4)}) — it was always there, only transparent`);

  // (3) CLICKABLE — a reserved gutter is worthless if something else eats the click.
  const topmost = await page.evaluate(() => {
    const fx = document.querySelector('[data-probe="target"] .numfield .eq-open');
    const r = fx.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { isFx: el === fx || fx.contains(el), tag: el?.tagName, cls: el?.className?.toString?.().slice(0, 60) };
  });
  assert(topmost.isFx, `the ƒ is the topmost element at its own centre (hit ${topmost.tag}.${topmost.cls})`);

  await page.click('[data-probe="target"] .numfield .eq-open');
  await sleep(350);
  const opened = await page.evaluate(() => {
    const f = document.querySelector('[data-probe="target"]');
    return Boolean(f.querySelector("math-field, input.eq-input, .eq-editing, [contenteditable]")) || f.querySelector(".numfield")?.matches(":focus-within");
  });
  assert(opened, "clicking the ƒ opens the equation entry path");

  // ── THE THIRD TEMPLATE: a Global Variables row ────────────────────────────
  // Found by sweeping every NumericField mount site. Its label cell is an
  // editable <input class="var-name">, which the label-gutter rule did not list
  // among the label-cell children — so the ƒ hung over the identifier's trailing
  // edge exactly as it did over a stop's. Measured on this row before the fix:
  // content edge 1162.16 vs ƒ at 1155.16, i.e. 7px of overlap; after: -1px.
  // An input cannot ellipsize, so the gutter is the only thing keeping the caret
  // and the last typed characters out from under the glyph.
  //
  // API DRIFT, REPAIRED HERE — the probe was wrong, the app was not.
  // OLD SPELLING: `app.addVariable("myvariable", 1)`. Under the pre-kinds
  // signature `addVariable(name)` (web/app.svelte.js) the second argument was
  // simply IGNORED, so that `1` read like an initial value and cost nothing.
  // NEW SPELLING: `app.addVariable("myvariable", "number")`. Commit 15a7d333
  // ("Compound property rows…", which shipped core/var_kinds.js) made the second
  // parameter the KIND — `addVariable(name, kind = "number")` — validated against
  // VAR_KIND_ZEROS. So `1` became a REJECTED kind: the app console.errors
  // `"1" is not a variable kind`, returns false, and creates NOTHING. That
  // reddened this probe twice over — no row to measure, AND the console.error
  // tripping the page-error filter — while the gutter under test was fine.
  // WHY "number" IS STATED AND NOT DEFAULTED: this row is asserted to carry a
  // `.numfield .eq-open`, and only the number kind mounts a NumericField
  // (VariablesPanel.svelte's `{:else}` branch). The other five kinds mount
  // Vector2Field/ColorField/BooleanField/Dropdown/<input>, none of which has one
  // — so the kind is part of the requirement, not an incidental default.
  const varAdded = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const cmds = app.commands?.all?.() ?? app.commands?.list?.() ?? [];
    const c = cmds.find((c) => c.id === "toggle-panel-globalVariables");
    if (c) (app.commands.run ? app.commands.run(c.id) : c.run(app));
    return app.addVariable("myvariable", "number");
  });
  await sleep(1200);
  // Asserted rather than assumed: addVariable reports success/failure by RETURN
  // VALUE and refuses loudly on the console. Without this the next check reports
  // the absence as a missing gutter — which is how the drift above read for a
  // whole round, as a layout regression rather than a bad argument.
  assert(varAdded === true, "addVariable created the number variable to measure (2nd arg is the KIND since 15a7d333, not a value)");

  //
  // WHERE THE GUTTER LIVES MOVED, AND SO DID WHAT HAS TO BE MEASURED.
  // When this probe was written the label cell WAS the bare <input class=
  // "var-name">, so measuring the input's content box measured the cell. Commit
  // 15a7d333 put the KIND PICKER in that cell, so the cell is now a flex wrapper
  // `.var-ident` holding `.var-kind` + `.var-name`, and app.css:7804-7812 moved
  // the reserved gutter onto the WRAPPER ("left on the input it would reserve the
  // strip in the middle of the cell, where nothing hangs"). The ƒ therefore lands
  // against `.var-ident`'s content edge, not the input's — so the CELL is what
  // the disjointness ruling is about, and the input is one occupant of it.
  const varRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".varspanel .row")];
    const r = rows.find((x) => x.querySelector(".var-name") && x.querySelector(".numfield .eq-open"));
    if (!r) return null;
    const inp = r.querySelector(".var-name");
    const fx = r.querySelector(".numfield .eq-open");
    const cell = r.querySelector(".var-ident");
    const kind = r.querySelector(".var-kind");
    const a = inp.getBoundingClientRect();
    const b = fx.getBoundingClientRect();
    const cs = getComputedStyle(inp);
    const contentRight = a.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    let cellContentRight = null;
    if (cell) {
      const c = cell.getBoundingClientRect();
      const ccs = getComputedStyle(cell);
      cellContentRight = c.right - parseFloat(ccs.paddingRight) - parseFloat(ccs.borderRightWidth);
    }
    return {
      contentRight, fxX: b.x, fxRight: b.right,
      nameX: a.x, nameRight: a.right, nameW: a.width,
      cellContentRight,
      kindRight: kind ? kind.getBoundingClientRect().right : null,
      kindW: kind ? kind.getBoundingClientRect().width : null,
      // A TRUE INTERVAL INTERSECTION, replacing the one-sided `contentRight - fxX`
      // this line used to compute. That subtraction silently ASSUMED the name sits
      // to the LEFT of the ƒ; when the cell overflows and shoves the input to the
      // RIGHT of it (which is what happens today, see the containment checks below)
      // it reports a large positive "overlap" for two boxes that never touch —
      // 35.84px on a pair that are in fact 14.84px apart. A test that can report an
      // overlap in the wrong direction cannot be used to certify the right one.
      overlap: Math.min(contentRight, b.right) - Math.max(a.x, b.x),
      isAddRow: r.classList.contains("add-row"),
    };
  });
  assert(varRow !== null, "a Global Variables row with a ƒ is present to measure");
  if (varRow) {
    console.log(`  .. VARSPANEL name input x=${varRow.nameX.toFixed(2)} right=${varRow.nameRight.toFixed(2)} w=${varRow.nameW.toFixed(2)} (content ends ${varRow.contentRight.toFixed(2)})`);
    console.log(`  .. VARSPANEL ƒ ${varRow.fxX.toFixed(2)}..${varRow.fxRight.toFixed(2)} | .var-ident content ends ${varRow.cellContentRight?.toFixed(2)} | .var-kind w=${varRow.kindW?.toFixed(2)} right=${varRow.kindRight?.toFixed(2)}`);
    console.log(`  .. true intersection = ${varRow.overlap.toFixed(2)}px (negative = disjoint)`);
    assert(varRow.overlap <= 0, `a variable NAME input and its ƒ are DISJOINT (intersection ${varRow.overlap.toFixed(2)}px <= 0)`);
    assert(!varRow.isAddRow, "the measured row is a real value row, not the add-row (which reserves no gutter)");

    // ── THE GUTTER IS ONLY WORTH ANYTHING IF THE CELL STAYS INSIDE IT ─────────
    // The two checks below are the disjointness ruling stated at the level the
    // design now lives at: "affordances may TRUNCATE a label, never MOVE it".
    // Disjointness alone stopped being sufficient the moment the cell gained a
    // second occupant — the ƒ can be perfectly clear of the NAME while the cell's
    // contents have been pushed clean through the reserved gutter and out the
    // other side, which is a worse failure than the one this file was opened for
    // and which the old one-sided subtraction could not tell apart from success.
    //
    // BOTH ARE RED TODAY, AND THE DEFECT IS IN PRODUCT CSS, NOT IN THIS FILE.
    // Measured at the probe's own 1400x900 viewport, default divider position:
    //   .var-ident  1100.00 .. 1167.16  (67.16px, padding-right 12px)
    //               => content box is 55.16px wide, ending 1155.16
    //   .var-kind      84.00px wide, 1100.00 .. 1184.00   — 28.84px PAST the
    //               content edge, straight over the ƒ (1155.16..1171.16) and on
    //               into .numfield, which starts at 1171.16
    //   .var-name    10.00px wide, 1186.00 .. 1196.00     — crushed to 10px and
    //               displaced ENTIRELY outside its own cell
    // Root cause: web/app.css:7833-7836 gives .varspanel .var-kind
    // `flex: none` (= 0 0 auto, cannot shrink) at a fixed
    // `width: var(--a-var-kind-w)` = 84px (web/app.css:403), while the label
    // column is sized by the shared `app.labelFrac` divider, which knows nothing
    // about that 84px minimum. At the default fraction the column is 67.16px, so
    // the picker cannot fit and the name input is what pays for it.
    // NOT FIXED HERE: this probe's lease is tests/list_field_fx_overlap_probe.js
    // only. Left RED deliberately — a green here would certify a row whose name
    // field is 10px wide and sitting in the value column.
    const EDGE_EPS = 0.5; // sub-pixel layout tolerance; the real misses are tens of px
    assert(varRow.cellContentRight !== null, "the row's identifier cell `.var-ident` exists to measure containment against");
    assert(varRow.kindRight !== null && varRow.kindRight <= varRow.cellContentRight + EDGE_EPS,
      `the KIND PICKER stays inside its label cell (right ${varRow.kindRight?.toFixed(2)} <= cell content ${varRow.cellContentRight?.toFixed(2)})`);
    assert(varRow.nameRight <= varRow.cellContentRight + EDGE_EPS,
      `the variable NAME input stays inside its label cell (right ${varRow.nameRight.toFixed(2)} <= cell content ${varRow.cellContentRight?.toFixed(2)})`);
  }

  // The ADD row must NOT have paid for a gutter it never fills: it mounts no
  // NumericField, so reserving 12px there would only shrink its text box.
  const addRowPad = await page.evaluate(() => {
    const a = document.querySelector(".varspanel .add-row .var-name");
    return a ? getComputedStyle(a).paddingRight : null;
  });
  assert(addRowPad === null || parseFloat(addRowPad) < 12, `the add-row's name input reserves NO ƒ gutter (padding-right ${addRowPad})`);

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push(`${errors.length} page error(s)`); }
} finally {
  await browser.close();
  await server.close();
}

// One per assert() call site above — kept in step by hand, and it was already
// off by one (16 asserts against 17) before the containment checks landed.
const total = 20;
console.log(fails.length ? `\nFAILED ${fails.length}/${total}:\n - ${fails.join("\n - ")}` : `\nlist_field_fx_overlap_probe: all checks passed`);
process.exit(fails.length ? 1 : 0);
