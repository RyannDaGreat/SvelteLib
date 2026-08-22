/**
 * SEARCHABLE SELECT ROW probe (workstream DROPDOWN_, R7-40) — the seam driven in
 * a real browser, end to end, on the row that reported the defect.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/select_search_probe.js [shot_dir]
 *
 * WHY A BROWSER PROBE WHEN THE LOGIC IS ALREADY PINNED IN NODE.
 * tests/select_search_default_test.js proves the RANKER filters and that the
 * source mounts a SearchableDropdown. Neither fact is the user's claim. The
 * claim is that an author who opens the Shape row can TYPE and get the shape,
 * and every link in that chain is invisible to node: whether the search box
 * actually renders at 187 options, whether the keystroke reaches the filter,
 * whether the filtered row is the one Enter commits, and whether the commit
 * lands in the document as ONE undo unit. A missing named import would satisfy
 * every node check in this repo and produce a dead panel here (CLAUDE.md: a
 * green build is NOT evidence the module graph is sound).
 *
 * IT ALSO PINS THE SMALL-LIST HALF, which is the half a "make it searchable"
 * change breaks silently. A short enum must come up with NO search box — the
 * threshold is a real decision (Inspector's SELECT_SEARCH_THRESHOLD, derived
 * from the measured option-count distribution) and a probe that only checked the
 * big list would go green on a change that put a text field over `curve`'s four
 * options.
 *
 * TYPING IS REAL KEYBOARD INPUT, never a direct value write: `page.keyboard`
 * through the focused search box, then ArrowDown/Enter. Setting the input's
 * value in JS would bypass the exact machinery under test (focus-on-open, the
 * filter binding, Dropdown's active-row tracking) and pass on a control nobody
 * could use — the WebSurge trap this codebase records for the signal probe.
 */
import { mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";
await mkdir(shots, { recursive: true });

// THE POSTER ROW (the user's own example): pptx_preset's `preset`, 187 AutoShape
// names. The query and the shape it must reach are chosen to be unambiguous —
// "arrow" narrows to the arrow family, and `bentArrow` is a member no other
// query in this file could land on by accident.
const BIG_ROW_LABEL = "Shape";
const BIG_ROW_QUERY = "arrow";
// THE THRESHOLD IS READ OUT OF THE SOURCE, not mirrored here. Copying the number
// would let this probe keep passing against a constant that had moved — the
// small-list half would silently start testing a list the app now searches.
const inspectorSrc = await readFile(resolve(HERE, "../web/Inspector.svelte"), "utf8");
const thresholdMatch = inspectorSrc.match(/const SELECT_SEARCH_THRESHOLD = (\d+);/);
if (!thresholdMatch) throw new Error("select_search_probe: SELECT_SEARCH_THRESHOLD is not declared in web/Inspector.svelte");
const SELECT_SEARCH_THRESHOLD = Number(thresholdMatch[1]);
const SETTLE_MS = 250;

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

  // ── FIXTURE: one pptx_preset widget, selected. Created through the app's own
  //    insert path so its defaults are the real ones.
  // addItem takes a defaults object and SELECTS what it made (it returns
  // nothing), so the new id is read back off app.selection.
  const made = JSON.parse(await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    app.addItem(app.registry.get("pptxPreset").defaults);
    return JSON.stringify({ id: app.selection, preset: app.state().items[app.selection]?.preset });
  }));
  ok("fixture-pptx-widget-created", !!made.id && !!made.preset,
    `addItem left selection=${JSON.stringify(made)}`);

  // THE BASELINE IS THE COMMITTED DOCUMENT, NOT `app.state()`, and getting this
  // wrong is instructive enough to record: `state()` is the LIVE render state,
  // which by design already carries the hover/active-row PREVIEW. Filtering
  // re-points the active row, so by the time the query is typed `state()` reads
  // the previewed shape and a "did the value change" check compares the pick
  // against a preview instead of against the document. MEASURED: after typing
  // "arrow", state() said "upArrow" while the document still said "roundRect".
  // Taken HERE, before anything opens, so it is the untouched starting value.
  const before = JSON.parse(await page.evaluate((id) => {
    const app = window.__powerrp_app;
    return JSON.stringify({ preset: app.doc.slides[app.slideIndex].delta.items?.[id]?.preset });
  }, made.id));
  await settle();

  /** The named row's DOM facts: whether its dropdown has a search box, and its trigger. */
  const rowFacts = (label) => page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === lbl);
    if (!row) return JSON.stringify({ found: false });
    const trigger = row.querySelector(".dd-trigger");
    return JSON.stringify({
      found: true,
      hasTrigger: !!trigger,
      triggerText: trigger?.textContent?.trim() ?? null,
    });
  }, label).then(JSON.parse);

  /** Command. Opens the named row's dropdown by clicking its trigger. */
  const openRow = async (label) => {
    const handle = await page.evaluateHandle((lbl) => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === lbl);
      return row?.querySelector(".dd-trigger") ?? null;
    }, label);
    const el = handle.asElement();
    if (el) await el.click();
    await settle();
  };

  /** The OPEN menu's facts: search box presence, and the rows it is showing. */
  const menuFacts = () => page.evaluate(() => {
    const menu = document.querySelector(".dd-menu");
    if (!menu) return JSON.stringify({ open: false });
    const search = menu.querySelector(".sd-search");
    return JSON.stringify({
      open: true,
      hasSearch: !!search,
      searchFocused: !!search && document.activeElement === search,
      rowCount: menu.querySelectorAll("li[role='option']").length,
      firstRows: [...menu.querySelectorAll("li[role='option']")].slice(0, 6).map((li) => li.textContent.trim()),
    });
  }).then(JSON.parse);

  // ── 1. THE BIG LIST OPENS WITH A SEARCH BOX, FOCUSED ──────────────────────
  const shapeRow = await rowFacts(BIG_ROW_LABEL);
  ok("shape-row-exists", shapeRow.found, `no row labelled "${BIG_ROW_LABEL}" in the panel`);
  ok("shape-row-has-a-dropdown-trigger", shapeRow.hasTrigger, JSON.stringify(shapeRow));

  await openRow(BIG_ROW_LABEL);
  const opened = await menuFacts();
  ok("shape-menu-opens", opened.open, "clicking the Shape trigger opened no .dd-menu");
  ok("shape-menu-has-a-search-box", opened.hasSearch,
    `187 options and no .sd-search — the reported defect. Menu showed ${opened.rowCount} rows.`);
  // Focused on open, or the author must click a second time before typing works —
  // which is the difference between "searchable" and "searchable if you know".
  ok("shape-search-box-is-focused-on-open", opened.searchFocused,
    "the search box rendered but did not take focus; typing would go nowhere");
  ok("shape-menu-lists-the-whole-roster", opened.rowCount > 100,
    `expected the full 187-preset roster before filtering, saw ${opened.rowCount}`);
  const unfilteredCount = opened.rowCount;

  // ── 2. TYPING FILTERS — real keystrokes into the focused box ───────────────
  await page.keyboard.type(BIG_ROW_QUERY, { delay: 20 });
  await settle();
  const filtered = await menuFacts();
  ok("typing-narrows-the-list", filtered.rowCount > 0 && filtered.rowCount < unfilteredCount,
    `"${BIG_ROW_QUERY}" left ${filtered.rowCount} of ${unfilteredCount} rows`);
  ok("every-surviving-row-matches-the-query",
    filtered.firstRows.every((t) => /a.*r.*r.*o.*w/i.test(t)),
    `non-matching rows survived: ${JSON.stringify(filtered.firstRows)}`);
  await page.screenshot({ path: resolve(shots, "select_search_filtered.png") });

  // FILTERING PREVIEWS BUT DOES NOT WRITE. Narrowing the list re-points the
  // active row, which fires the row's live preview — the same contract every
  // select row already had on hover. The preview must reach the VIEWPORT and
  // never the document: an author who types and then Escapes must be exactly
  // where they started. (This is also the contract the `before` snapshot above
  // had to be taken against the document to see at all.)
  const whileFiltering = JSON.parse(await page.evaluate((id) => {
    const app = window.__powerrp_app;
    return JSON.stringify({
      live: app.state().items[id]?.preset,
      doc: app.doc.slides[app.slideIndex].delta.items?.[id]?.preset,
    });
  }, made.id));
  ok("filtering-does-not-write-the-document", whileFiltering.doc === before.preset,
    `the document moved to ${JSON.stringify(whileFiltering.doc)} while merely FILTERING — ` +
    "a preview committed itself");

  // ── 3. PICKING COMMITS — and the DOCUMENT is what proves it ───────────────
  // ArrowDown then Enter: the keyboard path, so this also pins that the arrow
  // keys navigate the FILTERED list rather than the original 187.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await settle();

  const after = JSON.parse(await page.evaluate((id) => {
    const app = window.__powerrp_app;
    return JSON.stringify({
      preset: app.doc.slides[app.slideIndex].delta.items?.[id]?.preset,
      menuOpen: !!document.querySelector(".dd-menu"),
    });
  }, made.id));

  ok("picking-writes-the-document", after.preset && after.preset !== before.preset,
    `preset went ${JSON.stringify(before.preset)} -> ${JSON.stringify(after.preset)}`);
  ok("the-committed-value-is-what-was-searched-for", /arrow/i.test(after.preset ?? ""),
    `committed ${JSON.stringify(after.preset)}, which is not an "${BIG_ROW_QUERY}" match — the row Enter\n` +
    "    took was not the row the filter was showing");
  ok("picking-closes-the-menu", !after.menuOpen, "the menu stayed open after Enter");

  // ONE UNDO UNIT, measured by UNDOING IT. The undo log exposes no depth (its
  // stack is closed over), and a depth counter would be the weaker claim anyway:
  // what the contract promises is that ONE undo restores the previous value, not
  // that some number incremented. If the searchable control had introduced a
  // second write (a preview committed alongside the pick), one undo would leave
  // the item on an intermediate preset instead of the original.
  const undone = JSON.parse(await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.undo();
    return JSON.stringify({ preset: app.doc.slides[app.slideIndex].delta.items?.[id]?.preset });
  }, made.id));
  ok("the-pick-is-one-undo-unit", undone.preset === before.preset,
    `one undo left the preset at ${JSON.stringify(undone.preset)}, expected the pre-pick ` +
    `${JSON.stringify(before.preset)} — the pick wrote more than one undo entry`);
  // Put it back, so the small-list case below runs against the picked state.
  await page.evaluate(() => window.__powerrp_app.redo());
  await settle();

  // ── 4. SMALL LISTS DID NOT GET WORSE ──────────────────────────────────────
  // The other half of the threshold. A short enum must open with NO search box.
  // WHICH ROW IS "SHORT" IS ASKED OF THE REGISTRY, never named by hand: the
  // widget's own declarations are walked for a select row whose option count
  // falls at or under the threshold, and its LABEL is what the panel is then
  // searched for. A hardcoded row name is a guess that goes stale silently the
  // day a plugin renames or drops it (the first draft of this probe named six
  // and hit none of them).
  const shortRow = JSON.parse(await page.evaluate((threshold) => {
    const app = window.__powerrp_app;
    const plugin = app.registry.get("pptxPreset");
    const rows = typeof plugin.inspector === "function" ? plugin.inspector({}) : plugin.inspector;
    const short = (rows ?? []).filter(
      (r) => r?.kind === "select" && !r.optionsFrom && (r.options ?? []).length > 1 && (r.options ?? []).length <= threshold);
    const labels = [...document.querySelectorAll(".inspector .row")]
      .map((r) => r.querySelector(".label")?.textContent.trim()).filter(Boolean);
    const onPanel = short.filter((r) => labels.includes(r.label));
    return JSON.stringify({
      candidates: short.map((r) => `${r.label}=${(r.options ?? []).length}`),
      chosen: onPanel[0]?.label ?? null,
      chosenCount: (onPanel[0]?.options ?? []).length,
      labels,
    });
  }, SELECT_SEARCH_THRESHOLD));
  const shortLabel = shortRow.chosen;
  if (!shortLabel) {
    failures.push("small-list-case-not-exercised: this widget declares no select row at or under the " +
      `threshold that is also on the panel. Candidates: ${JSON.stringify(shortRow.candidates)}. ` +
      "A silently skipped half is not a pass.");
  } else {
    await openRow(shortLabel);
    const small = await menuFacts();
    ok("short-enum-menu-opens", small.open, `clicking "${shortLabel}" opened no menu`);
    ok("short-enum-has-NO-search-box", small.open && !small.hasSearch,
      `"${shortLabel}" shows ${small.rowCount} options and still rendered a search box — the box would be\n` +
      "    taller than the list it filters (Inspector's SELECT_SEARCH_THRESHOLD)");
    await page.keyboard.press("Escape");
    await settle();
  }

  // ── 5. NO NEW CONSOLE NOISE ───────────────────────────────────────────────
  ok("no-new-page-errors", errors.length === bootErrors,
    `new errors after boot: ${JSON.stringify(errors.slice(bootErrors))}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.log(`select search probe: ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log("select search probe: OK");
