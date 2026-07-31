/**
 * MATERIAL PAINT UI probe: boot the PowerRP editor headless with the demo deck,
 * select a rect, and exercise PaintField's "Mat" mode on BOTH paint slots —
 * the seam every ?cli=1 render probe structurally cannot reach (they never
 * mount the Inspector), which is exactly how a broken PaintField (its stroke
 * imports and `strokeMaterials` prop lost to a mid-fleet git-stash reset while
 * the slot-aware code using them survived) once passed 88 node suites and both
 * material render probes. Asserts, per slot:
 *   - clicking "Mat" on the FILL row stores {type:"material"} with the FILL
 *     registry's default id and renders that entry's fillParams knob rows;
 *   - clicking "Mat" on the STROKE row stores the STROKE registry's default id
 *     (the setMode slot guard: a stroke slot must never store a fill id) and
 *     renders strokeParams rows;
 *   - a knob commit writes a SPARSE param at material.params.<name>;
 *   - each Mat commit is one undo unit; zero console errors throughout.
 * The registries are read NODE-SIDE (materials.js / stroke_materials.js), so
 * the probe grows automatically as materials — e.g. brushes — register.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/material_paint_ui_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { fillCapableMaterialIds, getMaterial } from "../render_gpu/skia/materials.js";
import { strokeMaterialIds, getStrokeMaterial } from "../render_gpu/skia/stroke_materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Known demo-fixture boot noise (the colorfield_probe allowlist, same reasoning:
// stale fixture migrations + the software renderer's absent video adapter are
// not this suite's to own). Anything else at boot, and ANYTHING after, fails.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

/** The node-side truth the UI must mirror: each slot's registry + default entry. */
const FILL_IDS = fillCapableMaterialIds();
const STROKE_IDS = strokeMaterialIds();
const FILL_DEFAULT = FILL_IDS[0];
const STROKE_DEFAULT = STROKE_IDS[0];
// The number of `.paint-material-row` knob rows PaintField renders = the schema rows
// that are neither HIDDEN (back-compat/companion knobs, resolved but not shown) nor a
// kind:"stops" LIST (which mounts a full-width ListField, not a knob row). Registry-
// driven, so it stays correct as materials add or hide knobs.
const visibleKnobRows = (schema) => (schema ?? []).filter((r) => !r.hidden && r.kind !== "stops");
const fillRowCount = visibleKnobRows(getMaterial(FILL_DEFAULT).fillParams).length;
const strokeRowCount = visibleKnobRows(getStrokeMaterial(STROKE_DEFAULT).strokeParams).length;
// Does the stroke default declare a kind:"stops" ramp list (alongGradient does)?
// Its Mat row must then mount the gradient stops editor + the ramp preset library.
const strokeHasStops = (getStrokeMaterial(STROKE_DEFAULT).strokeParams ?? []).some((r) => r.kind === "stops");

// ── Node-side truth for the SCRUB + LIVE-PREVIEW assertions (audit item 4) ─────
// A knob is numeric (drives a DraggableNumber) when its kind is number/angle or
// unset. The registry is the source of truth, so these grow with the schema.
const isNumericKnob = (r) => r.kind === "number" || r.kind === "angle" || !r.kind;
// The FILL default's bounded numeric knob with the SMALLEST range — the sharpest
// witness that the scrub is calibrated: at 1 unit/px a tiny-range knob clamps to a
// bound in ≤1px, so a partial mid-range landing PROVES resolveScrub is wired
// (crt's convergence, 0..0.2, is exactly the audit's example).
const fillKnobRows = visibleKnobRows(getMaterial(FILL_DEFAULT).fillParams);
const boundedKnobs = fillKnobRows.filter((r) => isNumericKnob(r) && Number.isFinite(r.min) && Number.isFinite(r.max));
const boundedKnob = boundedKnobs.reduce((a, b) => (b.max - b.min < a.max - a.min ? b : a), boundedKnobs[0]);
const boundedIdx = fillKnobRows.indexOf(boundedKnob);
// Drag TOWARD the bound with more headroom, so the calibrated landing stays
// interior (a default near a bound would otherwise clamp even when calibrated).
// Sign: +px increases the value (drag up), -px decreases (drag down).
const boundedDir = (boundedKnob.default - boundedKnob.min) > (boundedKnob.max - boundedKnob.default) ? -1 : 1;
// A fill material declaring a `scrub` on a numeric knob — the smallest scrub gives
// the clearest split from the 1-unit/px fallback. Proves a schema scrub SURVIVES
// into the control (the 13 dropped-scrub knobs the audit found).
let scrubMatId = null, scrubKnob = null, scrubIdx = -1;
for (const id of fillCapableMaterialIds())
  for (const r of getMaterial(id).fillParams ?? [])
    if (r.scrub != null && isNumericKnob(r) && (scrubKnob == null || r.scrub < scrubKnob.scrub)) {
      scrubMatId = id; scrubKnob = r; scrubIdx = (getMaterial(id).fillParams).indexOf(r);
    }
// Pixels of the synthetic vertical drag used to exercise a knob's live preview +
// calibrated coefficient. 10px is comfortably past DraggableNumber's 4px click
// slop, and small enough that a bounded knob at 1 unit/px would clamp hard while a
// calibrated one lands mid-range.
const KNOB_DRAG_PX = 10;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  const realBootErrors = errors.filter((e) => !isBootNoise(e));
  if (realBootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBootErrors.join("\n")); process.exit(1); }
  errors.length = 0; // from here, ANY console error fails the probe

  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    const id = Object.keys(items).find((k) => items[k].type === "rect");
    app.selection = id;
    return id;
  });
  ok(rectId, "found a rect item in the demo deck");
  await new Promise((r) => setTimeout(r, 250));

  // ── Round 2 #26 — Fill/Stroke Material are TOP-LEVEL Inspector sections ──────
  // (peers of Positioning), NOT rows inside Formatting. The user rejected the
  // first shipped version; this pins the corrected structure permanently.
  const sections = await page.evaluate(() => {
    const cats = [...document.querySelectorAll(".inspector .prop-category")];
    const titleOf = (c) => c.querySelector(".cat-header .cat-title")?.textContent?.trim();
    const holding = (label) => titleOf(cats.find((c) =>
      [...c.querySelectorAll(".cat-rows > .row .label")].some((l) => l.textContent === label)));
    return { titles: cats.map(titleOf), fillIn: holding("Fill"), strokeIn: holding("Stroke") };
  });
  ok(sections.titles.includes("Fill Material") && sections.titles.includes("Stroke Material"),
    `top-level sections "Fill Material" + "Stroke Material" exist; got [${sections.titles.join(", ")}]`);
  ok(sections.fillIn === "Fill Material", `the Fill row lives IN "Fill Material", not Formatting; got ${JSON.stringify(sections.fillIn)}`);
  ok(sections.strokeIn === "Stroke Material", `the Stroke row lives IN "Stroke Material", not Formatting; got ${JSON.stringify(sections.strokeIn)}`);

  /** Click the "Mat" mode button inside the Inspector row labelled `rowLabel`. */
  const clickMat = (rowLabel) => page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent === lbl);
    const btn = row && [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Mat");
    if (!btn) return false;
    btn.click();
    return true;
  }, rowLabel);

  /** The Inspector row's rendered material knob rows + the stored doc paint.
   * The paint is JSON.stringify'd IN PAGE and parsed here: the doc is a Svelte 5
   * $state deep proxy, and puppeteer's return-by-value serialization silently
   * mangles it (plain numbers survive; the nested object came back empty). */
  const slotState = async (rowLabel, key) => {
    const r = await page.evaluate((lbl, k, id) => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((el) => el.querySelector(".label")?.textContent === lbl);
      return {
        knobRows: row ? row.querySelectorAll(".paint-material-row").length : -1,
        storedJson: JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id][k] ?? null),
      };
    }, rowLabel, key, rectId);
    return { knobRows: r.knobRows, stored: JSON.parse(r.storedJson) };
  };

  // ── FILL slot → Mat: fill registry's default id + its fillParams rows ───────
  ok(await clickMat("Fill"), "Fill row shows a Mat mode button; clicked");
  await new Promise((r) => setTimeout(r, 200));
  const fill = await slotState("Fill", "fill");
  ok(fill.stored?.type === "material", `Mat on Fill stores type:"material"; got ${JSON.stringify(fill.stored?.type)}`);
  ok(fill.stored?.material?.id === FILL_DEFAULT, `fill slot stores the FILL registry default "${FILL_DEFAULT}"; got ${JSON.stringify(fill.stored?.material?.id)}`);
  ok(FILL_IDS.includes(fill.stored?.material?.id), "fill slot's id is fill-capable (never a stroke id)");
  ok(fill.knobRows === fillRowCount, `fill row renders "${FILL_DEFAULT}"'s ${fillRowCount} fillParams knob rows; got ${fill.knobRows}`);

  // A knob commit writes a SPARSE param. The first number knob's DraggableNumber
  // commits via onchange; drive the app seam directly (the control's own gesture
  // path is DraggableNumber's suite's to own) with a value inside the knob's range.
  const numKnob = (getMaterial(FILL_DEFAULT).fillParams ?? []).find((r) => r.kind === "number" || r.kind === "angle" || !r.kind);
  if (numKnob) {
    const knobValue = (numKnob.default ?? 0) + ((numKnob.max ?? Infinity) > (numKnob.default ?? 0) ? 0 : -0.1) || 0.1;
    await page.evaluate((id, name, v) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, "fill", "material", "params", name], v]]);
      app.commitPreview();
    }, rectId, numKnob.name, knobValue);
    await new Promise((r) => setTimeout(r, 120));
    const afterKnob = await slotState("Fill", "fill");
    ok(afterKnob.stored?.material?.params?.[numKnob.name] === knobValue,
      `knob "${numKnob.name}" committed SPARSELY at material.params (${knobValue})`);
  }

  // ── STROKE slot → Mat: the slot guard picks the STROKE registry default ─────
  ok(await clickMat("Stroke"), "Stroke row shows a Mat mode button; clicked");
  await new Promise((r) => setTimeout(r, 200));
  const stroke = await slotState("Stroke", "stroke");
  ok(stroke.stored?.type === "material", `Mat on Stroke stores type:"material"; got ${JSON.stringify(stroke.stored?.type)}`);
  ok(stroke.stored?.material?.id === STROKE_DEFAULT, `stroke slot stores the STROKE registry default "${STROKE_DEFAULT}"; got ${JSON.stringify(stroke.stored?.material?.id)}`);
  ok(STROKE_IDS.includes(stroke.stored?.material?.id) && !FILL_IDS.includes(stroke.stored?.material?.id),
    "stroke slot's id is stroke-registry-only (the setMode slot guard held)");
  ok(stroke.knobRows === strokeRowCount, `stroke row renders "${STROKE_DEFAULT}"'s ${strokeRowCount} strokeParams knob rows (hidden + stops-list rows excluded); got ${stroke.knobRows}`);

  // ── ROUND 3 #47 — the alongGradient colour ramp IS the real gradient editor ──
  // Its Mat row mounts the SAME stops ListField + ramp preset library a gradient
  // PAINT uses (not bespoke start/end colour knobs), at real state paths under
  // material.params.stops. Picking the material SEEDED a concrete ramp so the editor
  // is never empty; a stop insert is ONE undo unit.
  if (strokeHasStops) {
    ok(Array.isArray(stroke.stored?.material?.params?.stops) && stroke.stored.material.params.stops.length >= 2,
      `choosing alongGradient SEEDED a concrete stops list (${stroke.stored?.material?.params?.stops?.length} stops); got ${JSON.stringify(stroke.stored?.material?.params?.stops)?.slice(0, 80)}`);
    // The stops editor's own chrome, read from the Stroke row: the shared ListField
    // (.listfield) and the ramp preset library toggle (.gradient-presets) — the exact
    // controls the gradient paint's stops editor renders, now inside Stroke Material.
    const stopsUi = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((el) => el.querySelector(".label")?.textContent === "Stroke");
      return {
        listfields: row ? row.querySelectorAll(".listfield").length : -1,
        presetToggles: row ? row.querySelectorAll(".gradient-presets-toggle").length : -1,
        insertSlices: row ? row.querySelectorAll(".listfield .list-insert").length : -1,
      };
    });
    ok(stopsUi.listfields >= 1, `stroke Mat mounts the shared stops ListField (.listfield ×${stopsUi.listfields})`);
    ok(stopsUi.presetToggles >= 1, `stroke Mat mounts the ramp PRESET LIBRARY affordance (.gradient-presets-toggle ×${stopsUi.presetToggles})`);
    ok(stopsUi.insertSlices >= 1, `the stops editor offers insert-between/-at-ends seams (.list-insert ×${stopsUi.insertSlices})`);

    // ADDING A STOP IS ONE UNDO UNIT. Click the first insert seam; the stored list
    // grows by one; a single undo restores it.
    const stopsCount = () => page.evaluate((id) => (window.__powerrp_app.doc.slides[0].delta.items[id].stroke?.material?.params?.stops ?? []).length, rectId);
    const before = await stopsCount();
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((el) => el.querySelector(".label")?.textContent === "Stroke");
      row.querySelector(".listfield .list-insert").click();
    });
    await sleep(150);
    const afterInsert = await stopsCount();
    ok(afterInsert === before + 1, `inserting a stop grew the ramp ${before} → ${afterInsert}`);
    await page.evaluate(() => window.__powerrp_app.undo());
    await sleep(120);
    ok(await stopsCount() === before, `the stop insert was ONE undo unit (back to ${before})`);
  }

  // ── Undo unwinds the Mat commits (each was ONE unit) ────────────────────────
  await page.evaluate(() => { window.__powerrp_app.undo(); window.__powerrp_app.undo(); });
  await new Promise((r) => setTimeout(r, 150));
  const afterUndo = JSON.parse(await page.evaluate((id) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].stroke ?? null), rectId));
  ok(afterUndo?.type !== "material", "two undos unwind the stroke Mat commit (one unit each)");

  // The two undos above left FILL in Mat mode (its type commit was not unwound),
  // with no knob params written — a clean base for the section/preview/hover tests.
  await clickMat("Fill"); // idempotent (setMode returns early when already material)
  await sleep(150);

  // Reads the Fill row's material-section chrome + committed/preview knob values.
  // Everything is JSON.stringify'd IN PAGE and parsed here (the doc is a Svelte 5
  // $state proxy — the PROBE-AUTHOR TRAP the header warns about).
  const fillMat = (name) => page.evaluate((n, id) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const header = row?.querySelector(".cat-header");
    const app = window.__powerrp_app;
    return {
      hasHeader: !!header,
      expanded: header?.getAttribute("aria-expanded") === "true",
      knobRows: row ? row.querySelectorAll(".paint-material-row").length : -1,
      committedJson: JSON.stringify(app.doc.slides[0].delta.items[id].fill?.material?.params?.[n] ?? null),
      previewJson: JSON.stringify(app.previewDelta?.items?.[id]?.fill?.material?.params?.[n] ?? null),
      matIdJson: JSON.stringify(app.doc.slides[0].delta.items[id].fill?.material?.id ?? null),
      previewIdJson: JSON.stringify(app.previewDelta?.items?.[id]?.fill?.material?.id ?? null),
    };
  }, name, rectId);

  // ── A.1 — the material knobs live in a DEDICATED COLLAPSIBLE section ─────────
  const secOpen = await fillMat(boundedKnob.name);
  ok(secOpen.hasHeader, "Fill Mat renders a collapsible section header (.cat-header)");
  ok(secOpen.expanded && secOpen.knobRows === fillKnobRows.length,
    `section starts expanded showing all ${fillKnobRows.length} knobs; got expanded=${secOpen.expanded} rows=${secOpen.knobRows}`);
  const clickMatHeader = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    row.querySelector(".cat-header").click();
  });
  await clickMatHeader(); await sleep(120);
  const secFolded = await fillMat(boundedKnob.name);
  ok(!secFolded.expanded && secFolded.knobRows === 0,
    `clicking the header FOLDS the knob list (23-knob CRT problem); got expanded=${secFolded.expanded} rows=${secFolded.knobRows}`);
  await clickMatHeader(); await sleep(120); // reopen — the drags below need it expanded
  const secReopened = await fillMat(boundedKnob.name);
  ok(secReopened.expanded && secReopened.knobRows === fillKnobRows.length, "clicking again REOPENS it");

  /** Synthetic vertical drag of the Nth material-row's DraggableNumber, up (=
   *  increase) by `dy` px. Dispatched WITHOUT pointerup so the caller can read the
   *  live preview mid-gesture (the ColorField-probe idiom for a captured pointer:
   *  headless page.mouse does not route DraggableNumber's pointer-lock scrub). */
  const knobDown = (idx, dy) => page.evaluate((i, d) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const dn = [...row.querySelectorAll(".paint-material-row")][i]?.querySelector(".dn");
    if (!dn) return false;
    const r = dn.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const mk = (type, cy) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: cy });
    dn.dispatchEvent(mk("pointerdown", y));
    dn.dispatchEvent(mk("pointermove", y - d)); // up → value increases
    return true;
  }, idx, dy);
  const knobUp = (idx, dy) => page.evaluate((i, d) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const dn = [...row.querySelectorAll(".paint-material-row")][i]?.querySelector(".dn");
    const r = dn.getBoundingClientRect();
    dn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 - d }));
  }, idx, dy);

  // ── B.4 — LIVE PREVIEW mid-drag + ONE undo unit on settle (ColorField contract),
  //          on the bounded knob, which ALSO witnesses the calibrated scrub ──────
  ok(await knobDown(boundedIdx, boundedDir * KNOB_DRAG_PX), `found the "${boundedKnob.name}" knob's DraggableNumber`);
  await sleep(80);
  const mid = await fillMat(boundedKnob.name);
  const midPreview = JSON.parse(mid.previewJson);
  const midCommitted = JSON.parse(mid.committedJson);
  ok(typeof midPreview === "number" && midPreview !== boundedKnob.default,
    `mid-drag: previewDelta carries the knob change (got ${JSON.stringify(midPreview)}, default ${boundedKnob.default})`);
  ok(midCommitted === null, `mid-drag: committed DOC knob UNCHANGED (sparse/null); got ${mid.committedJson}`);
  await knobUp(boundedIdx, boundedDir * KNOB_DRAG_PX);
  await sleep(120);
  const settled = await fillMat(boundedKnob.name);
  const committed = JSON.parse(settled.committedJson);
  ok(JSON.parse(settled.previewJson) === null, "settle: live preview cleared");
  ok(committed === midPreview, `settle: committed == last preview (no drift); ${committed} vs ${midPreview}`);
  // Calibrated: a KNOB_DRAG_PX drag moves ~ (max-min)/dragPx per px — a SMALL slice
  // of the range — NOT 1 unit/px, which would have clamped straight to a bound.
  const range = boundedKnob.max - boundedKnob.min;
  const expected = boundedKnob.default + boundedDir * KNOB_DRAG_PX * (range / 100);
  ok(Math.abs(committed - expected) < range * 0.05,
    `bounded knob scrub is CALIBRATED (~range/dragPx per px): ${committed} ≈ ${expected} (range ${range})`);
  ok(committed > boundedKnob.min + range * 0.02 && committed < boundedKnob.max - range * 0.02,
    `calibrated knob landed INTERIOR, NOT clamped to the bound a 1-unit/px drag hits (${boundedKnob.min} < ${committed} < ${boundedKnob.max})`);
  await page.evaluate(() => window.__powerrp_app.undo()); await sleep(100);
  const afterKnobUndo = await fillMat(boundedKnob.name);
  ok(JSON.parse(afterKnobUndo.committedJson) === null, "the knob drag was ONE undo unit (undo removes the sparse param)");

  // ── B.5 — HOVER PREVIEW on the material dropdown: sets, then reverts ─────────
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    row.querySelector(".dd-trigger").click(); // open the material picker
  });
  await sleep(120);
  const hovered = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const items = [...row.querySelectorAll(".dd-item")];
    const target = items.find((li) => !li.classList.contains("dd-selected")) ?? items[0];
    target.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerId: 1 }));
    return target.querySelector(".dd-item-body")?.textContent?.trim() ?? null;
  });
  await sleep(80);
  const onHover = await fillMat(boundedKnob.name);
  const hoverPreviewId = JSON.parse(onHover.previewIdJson);
  ok(typeof hoverPreviewId === "string" && hoverPreviewId !== FILL_DEFAULT,
    `hover: previewDelta carries the POINTED material id (got ${JSON.stringify(hoverPreviewId)}, current ${FILL_DEFAULT})`);
  ok(JSON.parse(onHover.matIdJson) === FILL_DEFAULT,
    `hover: committed DOC material id UNCHANGED (still ${FILL_DEFAULT}); got ${onHover.matIdJson}`);
  // Close the picker → the Dropdown's guarded preview effect fires oncancelpreview,
  // which reverts (matHover.cancel). The document was never touched by hovering.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    row.querySelector(".dd-trigger").click();
  });
  await sleep(120);
  const afterHover = await page.evaluate(() => window.__powerrp_app.previewDelta);
  ok(afterHover === null, "hover leave/close: previewDelta REVERTED (hovering never mutates the doc)");

  // ── B.4/item-4 — a schema-declared `scrub` SURVIVES into the knob control ────
  if (scrubMatId) {
    await page.evaluate((id, mid) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, "fill", "material", "id"], mid]]);
      app.commitPreview();
    }, rectId, scrubMatId);
    await sleep(150);
    ok(await knobDown(scrubIdx, KNOB_DRAG_PX), `switched Fill to "${scrubMatId}"; found its "${scrubKnob.name}" scrub knob`);
    await knobUp(scrubIdx, KNOB_DRAG_PX);
    await sleep(120);
    const scrubbed = JSON.parse(await page.evaluate((id, n) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].fill?.material?.params?.[n] ?? null), rectId, scrubKnob.name));
    const moved = Math.abs(scrubbed - scrubKnob.default);
    const expectMoved = KNOB_DRAG_PX * scrubKnob.scrub;
    ok(Math.abs(moved - expectMoved) < Math.max(expectMoved * 0.5, 1e-6),
      `declared scrub ${scrubKnob.scrub} SURVIVES into the control: ${KNOB_DRAG_PX}px moved "${scrubKnob.name}" by ${moved} ≈ ${expectMoved}`);
    ok(moved < KNOB_DRAG_PX * 0.5,
      `scrub knob did NOT drag at the 1-unit/px fallback (${moved} ≪ ${KNOB_DRAG_PX})`);
  }

  // ── C.7 — the TEXTURE BRUSH's thumbnail PALETTE + preset-expand contract ─────
  // Entry contracts on TEXTURE_BRUSH (`texturePalette`, `presetExpand`) drive
  // PaintField: the stroke slot on textureBrush must mount BrushPalette (a swatch
  // grid), a swatch pick must commit the texture knob, and picking a non-neutral
  // preset must EXPAND to continuous knobs and reset itself to neutral.
  {
    const tb = getStrokeMaterial("textureBrush");
    // PRE-WARM the textures (async decode → sync render): without this the FIRST
    // repaint after switching the stroke fires the brush's DESIGNED loud
    // not-ready report (correct in the live editor — it repaints on decode), and
    // this probe's zero-console-error rule would read the loudness as a failure.
    await page.evaluate(async (regUrl, manUrl) => {
      const { ensureImage } = await import(regUrl);
      const man = await import(manUrl);
      await Promise.all(man.textureIds().map((id) => ensureImage(man.textureUrl(id))));
    }, "/@fs" + resolve(HERE, "../render_gpu/gpu/image_registry.js"), "/@fs" + resolve(HERE, "../render_gpu/skia/brush_textures/manifest.js"));
    await page.evaluate((id) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, "stroke"], { type: "material", material: { id: "textureBrush", params: {} } }]]);
      app.commitPreview();
    }, rectId);
    await sleep(200);
    const pal = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((el) => el.querySelector(".label")?.textContent === "Stroke");
      const swatches = [...(row?.querySelectorAll(".brush-swatch") ?? [])];
      if (swatches.length > 1) swatches[1].click(); // pick a non-default texture
      return { swatches: swatches.length };
    });
    ok(pal.swatches >= 20, `textureBrush stroke slot mounts the BrushPalette (${pal.swatches} swatches >= 20)`);
    await sleep(120);
    const strokeParams = () => page.evaluate((id) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].stroke?.material?.params ?? null), rectId);
    const afterPick = JSON.parse(await strokeParams());
    ok(typeof afterPick?.texture === "string", `palette pick COMMITTED the texture knob; got ${JSON.stringify(afterPick?.texture)}`);
    // Preset-expand: drive the same seam commitSelectKnob writes through, exactly
    // as the Dropdown's onchange does — via the app; then assert expansion shape.
    const pe = tb.presetExpand;
    const presetId = tb.strokeParams.find((r) => r.name === pe.knob).options.find((o) => o !== pe.neutral);
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((el) => el.querySelector(".label")?.textContent === "Stroke");
      // open the preset dropdown (2nd select row: texture is 1st) and click an entry
      const dds = [...row.querySelectorAll(".paint-material-row .dd-trigger")];
      dds[1]?.click();
    });
    await sleep(120);
    const pickedPreset = await page.evaluate((neutralLabel) => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((el) => el.querySelector(".label")?.textContent === "Stroke");
      const items = [...row.querySelectorAll(".dd-item")];
      const target = items.find((li) => !li.classList.contains("dd-selected"));
      if (!target) return null;
      target.click();
      return target.textContent.trim();
    }, pe.neutral);
    await sleep(150);
    const expanded = JSON.parse(await strokeParams());
    ok(pickedPreset && expanded?.[pe.knob] === pe.neutral,
      `preset pick "${pickedPreset}" EXPANDED and reset the select to "${pe.neutral}" (got ${JSON.stringify(expanded?.[pe.knob])})`);
    ok(typeof expanded?.sizeStart === "number" && typeof expanded?.blend === "string",
      `preset expansion WROTE the continuous knobs (sizeStart ${JSON.stringify(expanded?.sizeStart)}, blend ${JSON.stringify(expanded?.blend)})`);
  }

  // ── REGRESSION: RE-ENTERING Mat must not crash (the DataCloneError) ─────────
  // setMode's material branch re-materializes the STORED params, which after a
  // first commit are a Svelte 5 deep proxy out of the reactive doc — and
  // structuredClone throws DataCloneError on proxies. The first Mat click cloned
  // a fresh literal and worked; the SECOND crashed (user-reported live). Drive
  // the exact sequence: Mat → Solid → Mat again on the SAME slot.
  {
    const before = errors.length;
    const clickMode = (rowLabel, mode) => page.evaluate((lbl, m) => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((el) => el.querySelector(".label")?.textContent === lbl);
      const btn = row && [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === m);
      if (!btn) return false;
      btn.click();
      return true;
    }, rowLabel, mode);
    ok(await clickMode("Stroke", "Mat"), "re-entry: Mat clicked on Stroke (params now stored/reactive)");
    await sleep(150);
    ok(await clickMode("Stroke", "Solid"), "re-entry: switched back to Solid");
    await sleep(150);
    ok(await clickMode("Stroke", "Mat"), "re-entry: Mat clicked AGAIN (clones the stored reactive params)");
    await sleep(200);
    const reStroke = JSON.parse(await page.evaluate((id) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].stroke ?? null), rectId));
    ok(reStroke?.type === "material", `re-entered Mat stored a material paint; got ${JSON.stringify(reStroke?.type)}`);
    ok(errors.length === before, `re-entering Mat threw NO page errors (the structuredClone-on-proxy crash); got: ${errors.slice(before).join(" | ") || "none"}`);
  }

  // ── REGRESSION: a MATERIAL paint on the CAMERA BACKGROUND must render ────────
  // The background rect is hand-assembled OUTSIDE sceneIR (cameraFrame /
  // CanvasView), so it was the one paint slot resolution never reached: setting
  // Mat on the camera background threw UNRESOLVED on EVERY paint — the editor
  // froze, and stayed frozen across reloads because the paint is stored in the
  // doc (user-reported live, twice). This drives the exact gesture: Mat on the
  // camera's Background row, then asserts the canvas and thumbnails keep
  // painting with zero page errors, and that undo restores.
  {
    const before = errors.length;
    await page.evaluate(() => {
      const app = window.__powerrp_app;
      const items = app.doc.slides[0].delta.items;
      const camId = Object.keys(items).find((k) => items[k].type === "camera");
      app.setPreview([[["items", camId, "background"], { type: "material", material: { id: "glass", params: {} } }]]);
      app.commitPreview();
      window.__camId = camId;
    });
    await sleep(1200); // let CanvasView + slide-nav thumbnails repaint
    ok(errors.length === before,
      `MATERIAL camera background renders without page errors (the camera-background freeze); new errors: ${errors.slice(before).join(" | ") || "none"}`);
    await page.evaluate(() => window.__powerrp_app.undo());
    await sleep(300);
    const bgAfterUndo = JSON.parse(await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[window.__camId].background ?? null)));
    ok(typeof bgAfterUndo !== "object" || bgAfterUndo?.type !== "material", "undo restores the pre-material background (one unit)");
  }

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Material paint UI probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
