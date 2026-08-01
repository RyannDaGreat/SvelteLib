/**
 * INSPECTOR ROW UNIFORMITY probe (R6-6.2/6.4/6.5/6.6, R6-8.3/8.4).
 *
 * ONE CLAIM, MEASURED SIX WAYS: every row in the Property Panel — at every
 * nesting depth, whatever kind of editor it mounts — shares ONE label x, ONE
 * value track and ONE corner radius. Every defect this probe pins was a row that
 * had quietly opted out of one of those three, and each was invisible to the
 * whole suite because nothing was comparing rows to each other:
 *
 *   A. LABEL x (R6-6.5). Measured before the fix: 37 property labels at
 *      x=1161.2 and the Name row's alone at 1131.2 — 30px, exactly the two
 *      `--a-row-label-gutter` slots the row-label chrome reserves, which the
 *      Name row skipped by rendering a bare <span class="label"> outside the
 *      shared row markup.
 *   B. VALUE track (R6-6.4). The widget-type control was 296.8×30.4 (the whole
 *      panel, and 4.4px taller than a control) where every property editor is
 *      163.6×26 — "no bigger or smaller than any other property".
 *   C. VALUE track, nested (R6-8.3). A material knob's bare DraggableNumber
 *      shrink-wrapped inside its flex cell: measured 44.7 / 58.2 / 66.3px in one
 *      122px column on the atmosphere material — the user's "just tiny numbers,
 *      mismatched widths" — while the ColorField and Dropdown beside it filled it.
 *   D. RADIUS, nested (R6-8.4). The same knobs rendered a 4px radius against 0px
 *      everywhere else: `.paint-material-control .dn` was (0,2,0), which only
 *      TIES DraggableNumber's later-injected `.dn.svelte-hash`, so --dn-radius
 *      kept the library's `var(--radius, 4px)`. App chrome is square.
 *   E. STRUCTURE (R6-6.6/6.3). Widget type / Name / Visible are three ordinary
 *      rows in ONE section, in that order, and it is the panel's first.
 *   F. SEARCH (R6-6.1/6.2). Both unbounded pickers — the item list and the
 *      widget-type roster — are the SAME src/lib/SearchableDropdown, so both
 *      open with a filter box. The roster is 90+ entries; a plain Dropdown over
 *      it is unusable, and R6-26's "morph from widget" makes it larger still.
 *
 * Every threshold here is a COMPARISON BETWEEN ROWS, never a hard-coded pixel:
 * the panel is user-resizable and the label boundary is a draggable fraction, so
 * an absolute number would be a false gate. The reference is always another row
 * measured in the same frame.
 *
 * The doc is a Svelte 5 $state proxy, so everything read out of page.evaluate is
 * JSON.stringify'd IN PAGE and parsed here (the material_paint_ui_probe trap).
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/inspector_row_uniformity_probe.js [shot_dir]
 */
import { mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { getMaterial, fillCapableMaterialIds } from "../render_gpu/skia/materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";
await mkdir(shots, { recursive: true });

// THE FIXTURE MATERIAL, and it is the user's own example: "the properties under
// Atmosphere". Eight knobs across three control kinds (colour, number, angle) is
// exactly the mix that made C and D visible — a list of one kind would have
// looked internally consistent while disagreeing with the rest of the panel.
const FIXTURE_MATERIAL = "atmosphere";
// Its knob rows, read from the registry rather than counted by hand, so the
// probe grows with the schema instead of drifting from it (R6-24.7).
const FIXTURE_KNOBS = (getMaterial(FIXTURE_MATERIAL).fillParams ?? []).filter((r) => !r.hidden && r.kind !== "stops");
// The three rows the Universal section holds, in the ruled order (R6-6.6), by
// their labels — "Widget type" is R6-6.3's dictated rename.
const UNIVERSAL_LABELS = ["Widget type", "Name", "Visible"];
// A sub-pixel slack for comparing two independently laid-out boxes. Browser
// layout resolves to 1/64px, and two elements sized from the same grid track can
// land a rounding step apart; a real defect here is tens of pixels (the measured
// ones were 30, 44.7 and 133.2), so this is three orders of magnitude clear of
// anything worth catching.
const EPS = 0.5;
const SETTLE_MS = 250;
// How many items the deck must hold before the ITEM picker's filter box is
// expected. Not the component's own `minItemsForSearch` mirrored by hand — this
// app's OWN judgement of "a list long enough to need search", read off the
// fill-material registry, which is a shipped SearchableDropdown whose box does
// appear. If either the default or the registry moves, this moves with them.
const LONG_LIST_LEN = fillCapableMaterialIds().length;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const failures = [];
const errors = [];
const ok = (name, cond, detail = "") => { if (!cond) failures.push(`${name}: ${detail}`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  const bootErrors = errors.length; // other agents' in-flight WIP; the house baseline
  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  const ids = JSON.parse(await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    return JSON.stringify({
      rect: Object.keys(items).find((k) => items[k].type === "rect"),
      camera: Object.keys(items).find((k) => items[k].type === "camera"),
    });
  }));
  ok("fixture-deck-has-a-rect-and-a-camera", !!ids.rect && !!ids.camera, JSON.stringify(ids));

  const select = async (id) => { await page.evaluate((i) => { window.__powerrp_app.selection = i; }, id); await settle(); };
  await select(ids.rect);

  // Put Fill into the fixture material so the nested knob rows exist to measure.
  await page.evaluate((id, mat) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill"], { type: "material", material: { id: mat, params: {} } }]]);
    app.commitPreview();
  }, ids.rect, FIXTURE_MATERIAL);
  await settle();

  // ── ONE READ of the whole panel's geometry, so every comparison below is
  //    between boxes measured in the SAME frame at the SAME label fraction.
  const panel = JSON.parse(await page.evaluate(() => {
    const px = (n) => Math.round(n * 100) / 100;
    const box = (el) => { const b = el.getBoundingClientRect(); return { l: px(b.left), r: px(b.right), w: px(b.width), h: px(b.height) }; };
    const radius = (el) => getComputedStyle(el).borderRadius;
    const rows = [...document.querySelectorAll(".inspector .row")];
    const labelled = rows.filter((r) => r.querySelector(".label"));
    const rowOf = (lbl) => labelled.find((r) => r.querySelector(".label").textContent.trim() === lbl) ?? null;
    /** The row's VALUE cell content — the second grid child, whatever editor it is. */
    const valueOf = (lbl) => { const r = rowOf(lbl); const el = r?.children?.[1]; return el ? { ...box(el), tag: el.className } : null; };
    const sections = [...document.querySelectorAll(".inspector .prop-category")];
    const titleOf = (s) => s.querySelector(".cat-header .cat-title")?.textContent?.trim() ?? null;
    const universal = sections.find((s) => titleOf(s) === "Universal") ?? null;
    return JSON.stringify({
      sectionTitles: sections.map(titleOf),
      universalRows: universal ? [...universal.querySelectorAll(".row .label")].map((e) => e.textContent.trim()) : null,
      labels: labelled.map((r) => ({ label: r.querySelector(".label").textContent.trim(), x: px(r.querySelector(".label").getBoundingClientRect().left) })),
      typeControl: (() => { const r = rowOf("Widget type"); const dd = r?.querySelector(".dd"); return dd ? box(dd) : null; })(),
      values: Object.fromEntries(["Widget type", "Name", "Visible", "Opacity"].map((l) => [l, valueOf(l)])),
      purgeOnNameRow: !!rowOf("Name")?.querySelector(".kf-controls .btn-icon.danger"),
      keyframesOnVisible: !!rowOf("Visible")?.querySelector(".kf-controls .kf-diamond, .kf-controls button"),
      // The nested material knobs: each control against the cell it sits in.
      knobs: [...document.querySelectorAll(".inspector .paint-material-row")].map((row) => {
        const cell = row.querySelector(".paint-material-control");
        const ctl = cell?.firstElementChild ?? null;
        return {
          label: row.querySelector(".paint-material-label")?.textContent?.trim() ?? null,
          cell: cell ? box(cell) : null,
          ctl: ctl ? { ...box(ctl), tag: ctl.className, radius: radius(ctl) } : null,
        };
      }),
      // The panel's OWN radius reference: a top-level number field's scrubber.
      topScrubberRadius: (() => { const e = document.querySelector(".inspector .row .numfield .dn"); return e ? radius(e) : null; })(),
      itemPickerIsSearchable: !!document.querySelector(".inspector-head .dd"),
    });
  }));

  // ── E. STRUCTURE — one section, three rows, in the ruled order, FIRST ──────
  ok("universal-section-exists", panel.universalRows !== null,
    `no section titled "Universal"; the panel has [${panel.sectionTitles.join(", ")}]`);
  ok("universal-section-is-first", panel.sectionTitles[0] === "Universal",
    `first section is ${JSON.stringify(panel.sectionTitles[0])} — the properties every widget has come before the ones its plugin adds`);
  ok("universal-holds-type-name-visible-in-order",
    JSON.stringify(panel.universalRows) === JSON.stringify(UNIVERSAL_LABELS),
    `section holds ${JSON.stringify(panel.universalRows)}, expected ${JSON.stringify(UNIVERSAL_LABELS)}`);
  // The two affordances that must SURVIVE the move into the row grid, or this
  // refactor traded a defect for a regression.
  ok("name-row-keeps-the-purge-trash", panel.purgeOnNameRow,
    "the Name row lost its Purge trash-can (manifest Round 12: same row as the name)");
  ok("visible-row-keeps-its-keyframes", panel.keyframesOnVisible,
    "the Visible row lost its keyframe controls — it is a keyframeable boolean like any other property");

  // ── A. LABEL x — ONE boundary for every labelled row in the panel ──────────
  const xs = [...new Set(panel.labels.map((l) => l.x))];
  const spread = Math.max(...xs) - Math.min(...xs);
  ok("every-row-label-starts-at-one-x", spread <= EPS,
    `labels sit at ${xs.length} different x (spread ${spread.toFixed(1)}px): ` +
    JSON.stringify(panel.labels.filter((l) => l.x !== panel.labels[0].x).slice(0, 6)));

  // ── B. VALUE track — the widget-type control is exactly a property editor ──
  const ref = panel.values.Opacity;
  ok("found-a-reference-property-editor", ref != null, "no Opacity row to measure the panel's value track against");
  for (const label of UNIVERSAL_LABELS) {
    const v = panel.values[label];
    ok(`universal-row-value-track-${label.replace(/\s+/g, "-").toLowerCase()}`,
      v != null && ref != null && Math.abs(v.l - ref.l) <= EPS && Math.abs(v.r - ref.r) <= EPS,
      `"${label}" value cell is ${JSON.stringify(v)}, the panel's track is [${ref?.l}, ${ref?.r}]`);
  }
  ok("widget-type-control-is-a-control-height",
    panel.typeControl != null && ref != null && Math.abs(panel.typeControl.h - ref.h) <= EPS,
    `the widget-type dropdown is ${panel.typeControl?.h}px tall against the panel's ${ref?.h}px — Dropdown's own trigger height is 30.4px and only the row grid's override brings it to --a-control-h`);

  // ── C+D. NESTED rows: fill the track, square like everything else ─────────
  ok("fixture-material-rendered-its-knob-rows", panel.knobs.length === FIXTURE_KNOBS.length,
    `"${FIXTURE_MATERIAL}" declares ${FIXTURE_KNOBS.length} visible knobs; the panel rendered ${panel.knobs.length}`);
  const narrow = panel.knobs.filter((k) => k.ctl && k.cell && k.cell.r - k.ctl.r > EPS);
  ok("every-material-knob-fills-its-value-track", narrow.length === 0,
    `${narrow.length} of ${panel.knobs.length} knobs stop short of the track's right edge: ` +
    JSON.stringify(narrow.slice(0, 4).map((k) => ({ label: k.label, ctl: k.ctl.w, cell: k.cell.w }))));
  const round = panel.knobs.filter((k) => k.ctl && k.ctl.radius !== panel.topScrubberRadius);
  ok("every-material-knob-is-as-square-as-the-panel", round.length === 0,
    `the panel's scrubbers are ${panel.topScrubberRadius}; ${round.length} knobs render ` +
    JSON.stringify([...new Set(round.map((k) => k.ctl.radius))]) + ` — e.g. ` +
    JSON.stringify(round.slice(0, 3).map((k) => k.label)));

  // ── F. SEARCH — both unbounded pickers are the SAME SearchableDropdown ────
  // `.sd-search` is that component's own filter box, so its presence IS the
  // evidence: nobody wrote a second search implementation, they consumed this one.
  //
  // THE ITEM PICKER NEEDS A LONGER LIST FIRST, and that is correct behaviour, not
  // a defect: SearchableDropdown hides the box below `minItemsForSearch` so short
  // enums stay plain, and the demo deck holds fewer items than that. So grow the
  // deck to a length this app ALREADY treats as needing search — the fill-material
  // registry, a shipped SearchableDropdown whose box does show. Deriving the bound
  // from a live registry rather than mirroring the component's default keeps this
  // out of the hand-maintained-mirror class (R6-24.7): if the default moves, the
  // yardstick moves with the app's own judgement of "long".
  ok("item-picker-is-a-dropdown", panel.itemPickerIsSearchable, "no .dd in the Inspector head");
  await page.evaluate((n) => {
    const app = window.__powerrp_app;
    const base = app.registry.get("rect").defaults;
    while (Object.keys(app.state().items).length < n) app.addItem({ ...base, type: "rect", x: 10, y: 10, w: 20, h: 20 });
  }, LONG_LIST_LEN);
  await settle();

  /** Query. Opens one dropdown — the panel head's, or the row carrying `label` —
   *  reports what its menu contains, and closes it again through the real Escape
   *  key (the component's own close path; a synthetic event dispatched on
   *  `document` never reaches its handler). */
  const menuOf = async (label) => {
    const found = await page.evaluate((lbl) => {
      const t = lbl == null
        ? document.querySelector(".inspector-head .dd .dd-trigger")
        : [...document.querySelectorAll(".inspector .row")]
            .find((r) => r.querySelector(".label")?.textContent?.trim() === lbl)
            ?.querySelector(".dd .dd-trigger");
      if (!t) return false;
      t.click();
      return true;
    }, label);
    if (!found) return null;
    await settle();
    const seen = JSON.parse(await page.evaluate(() => {
      const menu = document.querySelector(".dd-menu");
      return JSON.stringify(menu ? { search: !!menu.querySelector(".sd-search"), rows: menu.querySelectorAll(".dd-item").length } : null);
    }));
    await page.keyboard.press("Escape");
    await settle();
    return seen;
  };

  const headMenu = await menuOf(null);
  ok("item-picker-types-to-filter", headMenu?.search === true,
    `the item picker opened over ${headMenu?.rows} items without a .sd-search box: ${JSON.stringify(headMenu)}`);

  await select(ids.rect);
  const typeMenu = await menuOf(UNIVERSAL_LABELS[0]);
  ok("widget-type-picker-types-to-filter", typeMenu?.search === true,
    `the widget-type menu opened without a .sd-search box: ${JSON.stringify(typeMenu)} — the roster is the whole registry and a plain Dropdown over it is unusable`);
  ok("widget-type-menu-lists-the-roster", (typeMenu?.rows ?? 0) > LONG_LIST_LEN,
    `the widget-type menu listed ${typeMenu?.rows} rows — the roster is every type this widget can become`);

  await page.screenshot({ path: `${shots}/inspector_row_uniformity.png`, clip: { x: 1120, y: 0, width: 320, height: 900 } });

  // ── The NOT-RETYPEABLE form: an inert value, never an empty menu ───────────
  await select(ids.camera);
  const cam = JSON.parse(await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const type = rows.find((r) => r.querySelector(".label")?.textContent?.trim() === "Widget type");
    return JSON.stringify({
      labels: rows.map((r) => r.querySelector(".label")?.textContent?.trim() ?? null),
      inertText: type?.querySelector(".disabled-val")?.value ?? null,
      hasMenu: !!type?.querySelector(".dd"),
    });
  }));
  ok("camera-still-has-a-widget-type-row", cam.labels.includes("Widget type"), JSON.stringify(cam.labels));
  ok("camera-type-row-offers-no-menu", cam.hasMenu === false,
    "the camera offered a retype dropdown — it is purgeable:false and retypeChoices() is empty for it");
  ok("camera-type-row-names-its-type", (cam.inertText ?? "").length > 0,
    `the camera's inert type read ${JSON.stringify(cam.inertText)} — an empty menu and a blank field are the same lie`);
  ok("camera-has-no-visible-row", !cam.labels.includes("Visible"),
    "the camera is mandatory (purgeable:false) and must not offer a visibility toggle");

  const newErrors = errors.slice(bootErrors);
  if (newErrors.length) failures.push(`console errors during the run:\n  ${newErrors.join("\n  ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`inspector_row_uniformity_probe FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("inspector_row_uniformity_probe: OK");
