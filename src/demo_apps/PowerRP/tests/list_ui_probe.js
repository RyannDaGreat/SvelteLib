/**
 * LIST-PROPERTY UI probe — boot the PowerRP editor headless and drive the REAL
 * Inspector list control (web/ListField.svelte) with real clicks, on BOTH shipped
 * list declarations: a polygon's `points` (a SEQUENCE of TUPLE elements, reached
 * through the Inspector's own row) and a gradient's `stops` (a SORTED list of
 * RECORD elements, reached through web/PaintField.svelte).
 *
 * Proves, against the REAL app:
 *   - the LIST ROW RENDERS AT ALL — the branch whose absence was the hazard: a
 *     `kind: "list"` row used to fall through the Inspector's catch-all TEXT
 *     input, which would commit a string over the element array;
 *   - INSERT BETWEEN yields the INTERPOLATED value (the midpoint of the two
 *     neighbours it splits — a vertex on the edge, a stop at the average offset
 *     with the blended colour), and insert AT AN END extrapolates;
 *   - HIDE writes ONLY the visibility companion: the element list is byte-
 *     identical (nothing renumbered), the companion is a full ARRAY (the same
 *     shape the canvas handle toolbar writes — one hide mechanism), the polygon's
 *     outline CLOSES OVER the gap and the gradient ramps between the SURVIVING
 *     neighbours;
 *   - PIXEL PROOF for that last claim: a 3-stop gradient with its middle stop
 *     HIDDEN renders PIXEL-IDENTICAL to the hand-authored 2-stop gradient, and
 *     both differ from the unhidden 3-stop one (so the comparison is not vacuous);
 *   - PURGE splices and RENUMBERS, and refuses LOUDLY at the declaration's
 *     minLength (the gradient's two-stop floor disables the button, where the old
 *     bespoke "×" silently no-oped);
 *   - a PER-ELEMENT `=` EQUATION is accepted through the element's own field and
 *     is EVALUATED (raw stores the expression, state holds the result);
 *   - EVERY one of those actions is EXACTLY ONE UNDO UNIT — measured by JSON
 *     COMPARE of the document before and after undo(), never by reference
 *     identity, because undo() restores an EQUAL document through a fresh
 *     reactive proxy.
 *   - COLLAPSE: the list folds behind the app's accordion header, the header
 *     STATES what is inside it ("5 stops", "3 stops, 1 hidden"), the choice
 *     PERSISTS as a browser setting keyed by the PROPERTY (so it survives
 *     selecting another item), and it is keyed per property (folding `points`
 *     does not fold `stops`).
 *   - THE PRESET FLICKER, COUNTED: sweeping the gradient preset library used to
 *     rewrite every stop row under the cursor on each pointerenter (measured on
 *     the pre-fix build: 768 DOM mutations and 13 list-height changes over 14
 *     swatches, the list swinging between 2 and 12 rows). Opening the library
 *     now folds the list, so the sweep is counted here and the row churn must be
 *     ZERO — while every swatch still PREVIEWS, which is what the fold exists to
 *     make watchable. The preset library also sits ABOVE the stops now, so a
 *     swatch cannot move even when the list below it resizes.
 *   - SUPPRESSION AND THE USER'S OWN CHOICE ARE SEPARATE STATE: a list the user
 *     had OPEN is open again after the library closes, and one the user had
 *     FOLDED stays folded.
 *
 * Writes screenshots to POWERRP/.claude_vlm_checks/list_ui/.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/list_ui_probe.js
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

// Paths resolve off THIS file, never process.cwd() — the suite convention
// (enforced by tests/probe_artifact_path_test.js), so the probe runs identically
// from the repo root or from its own directory and its output has ONE home.
const HERE = dirname(fileURLToPath(import.meta.url));
const powerrp = resolve(HERE, "..");
const webRoot = resolve(powerrp, "web");
const shots = resolve(powerrp, ".claude_vlm_checks/list_ui");
await mkdir(shots, { recursive: true });
const demoJson = await readFile(resolve(powerrp, "examples/demo.powerrp.json"), "utf8");

// hmr: false — the probe drives the app through a long stateful sequence, and a
// hot update (any editor save anywhere in the tree) reloads the page mid-run and
// throws away the widget the checks are measuring. Nothing here needs live reload.
// (tests/field_key_ownership_probe.js's own reason, for the same shape of probe;
// measured here as "Execution context was destroyed" while siblings were saving.)
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// The same stale-fixture boot-noise allowance tests/handle_selection_probe.js
// documents: other agents' in-flight migrations of the shared demo fixture, plus
// this container's headless graphics reality (the fixture's video widgets probe
// for an adapter the software renderer does not expose). Named specifically —
// anything else still fails the probe.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  const liveErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || isBootNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await settle(700);
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  // ── Page helpers ───────────────────────────────────────────────────────────
  // EVERY array read out of the page goes through JSON: a Svelte $state proxy
  // array serializes over CDP as a plain OBJECT ({"0": …}), silently losing
  // .length and Array.isArray (the concerns.md proxy gotcha).
  const jsonEval = (fn, ...args) => page.evaluate(fn, ...args).then((s) => JSON.parse(s));
  /** The EVALUATED value at an item state path (equations resolved). */
  const stateAt = (id, keys) => jsonEval((id, keys) => {
    let v = window.__powerrp_app.state().items?.[id];
    for (const k of keys) v = v?.[k];
    return JSON.stringify(v ?? null);
  }, id, keys);
  /** The RAW stored value at an item state path (an `=` expression stays one). */
  const rawAt = (id, keys) => jsonEval((id, keys) => {
    let v = window.__powerrp_app.rawState().items?.[id];
    for (const k of keys) v = v?.[k];
    return JSON.stringify(v ?? null);
  }, id, keys);
  /** A stable JSON snapshot of the whole document — what "exactly one undo unit"
   *  is measured against (reference identity is useless: undo() restores an EQUAL
   *  document through a fresh reactive proxy). */
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  /** Clicks something inside the Nth `.list-el` row of the Inspector's list. */
  const clickInRow = (index, selector) => page.evaluate((index, selector) => {
    const row = document.querySelectorAll(".listfield .list-el")[index];
    if (!row) throw new Error(`no .list-el at index ${index}`);
    const el = row.querySelector(selector);
    if (!el) throw new Error(`no "${selector}" in .list-el ${index}`);
    el.click();
  }, index, selector);
  /** Clicks the Nth INSERT seam (0 = before the first element, n = after the last). */
  const clickInsert = (index) => page.evaluate((index) => {
    const seams = document.querySelectorAll(".listfield .list-insert");
    if (!seams[index]) throw new Error(`no .list-insert at index ${index} (have ${seams.length})`);
    seams[index].click();
  }, index);
  const rowCount = () => page.evaluate(() => document.querySelectorAll(".listfield .list-el").length);
  /** The collapse header's own summary text ("4 points", "5 stops, 1 hidden"), or
   *  null when the list renders no header at all (an EMPTY list has nothing to
   *  fold, so it deliberately gets none). Scoped INSIDE .listfield: the Inspector's
   *  own category accordions use the very same shared classes. */
  const headerText = () => page.evaluate(() => document.querySelector(".listfield .cat-title")?.textContent ?? null);
  const headerState = () => page.evaluate(() => {
    const h = document.querySelector(".listfield .cat-header");
    return h && JSON.stringify({ expanded: h.getAttribute("aria-expanded"), disabled: h.disabled, icon: h.querySelector("iconify-icon")?.getAttribute("icon") });
  }).then((s) => (s ? JSON.parse(s) : null));
  const clickHeader = () => page.evaluate(() => document.querySelector(".listfield .cat-header").click());
  /** The persisted collapse map — the BROWSER setting the fold is remembered in. */
  const collapseSetting = () => jsonEval(() => localStorage.getItem("powerrp.listCollapsed") ?? "null");
  /** Scrolls the list control into the Inspector's viewport and shoots IT (padded),
   *  not the whole panel — the panel's own rect is taller than its scroller, so a
   *  full-panel clip photographs whatever else is behind the fold. */
  const shotOfList = async (name) => {
    const clip = await page.evaluate(() => {
      const list = document.querySelector(".listfield");
      list.scrollIntoView({ block: "center" });
      const PAD = 10;
      const r = list.closest(".row").getBoundingClientRect();
      return {
        x: Math.max(0, Math.round(r.x) - PAD), y: Math.max(0, Math.round(r.y) - PAD),
        width: Math.round(r.width) + 2 * PAD, height: Math.round(r.height) + 2 * PAD,
      };
    });
    await settle(150);
    await page.screenshot({ path: resolve(shots, `${name}.png`), clip });
  };
  /** Runs `action`, then proves the document takes EXACTLY ONE undo to restore. */
  const oneUndoUnit = async (label, action) => {
    const before = await docJson();
    await action();
    await settle();
    const after = await docJson();
    ok(after !== before, `${label}: really changed the document (the undo check is not vacuous)`);
    await page.evaluate(() => window.__powerrp_app.undo());
    await settle(80);
    ok(await docJson() === before, `${label}: EXACTLY ONE undo unit (JSON compare)`);
    await page.evaluate(() => window.__powerrp_app.redo());
    await settle(80);
    ok(await docJson() === after, `${label}: redo restores it (the action is a single unit both ways)`);
  };

  // ── Scenario 1: THE POLYGON'S `points` ROW (sequence / tuple) ───────────────
  const polyId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get("polygon").defaults);
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], 300], [["items", id, "y"], 260],
      [["items", id, "w"], 300], [["items", id, "h"], 300],
      // A SQUARE: every midpoint is a round number, so an interpolated insert is
      // checkable exactly rather than approximately.
      [["items", id, "points"], [[0, 0], [1, 0], [1, 1], [0, 1]]],
      [["items", id, "closed"], true],
    ]);
    app.commitPreview();
    return id;
  });
  await settle(250);

  // THE HAZARD FIX ITSELF: the row exists, and it is the list control — NOT the
  // catch-all text input a `kind:"list"` row used to fall through to.
  ok(await page.evaluate(() => !!document.querySelector(".inspector .row.row-list .listfield")),
    "the polygon declares a POINTS row and it renders the LIST control");
  ok(await page.evaluate(() => document.querySelectorAll(".inspector .row.row-list input[type=text]").length === 0),
    "the list row renders NO bare text input over the array (the hazard the missing branch was)");
  ok(await rowCount() === 4, `one element row per vertex (${await rowCount()})`);
  ok(await page.evaluate(() => JSON.stringify([...document.querySelectorAll(".listfield .list-index")].map((e) => e.textContent))) === '["1","2","3","4"]',
    "element rows are numbered 1..n (the address a user reads)");
  ok(await page.evaluate(() => document.querySelectorAll(".listfield .list-insert").length) === 5,
    "there are n+1 INSERT seams: between every pair, plus one at each end");
  ok(await page.evaluate(() => JSON.stringify([...document.querySelectorAll(".listfield .list-el")[0].querySelectorAll(".list-field-label")].map((e) => e.textContent))) === '["x","y"]',
    "each element shows its DECLARED fields (x, y), by name");
  await shotOfList("polygon_points_list");

  // ── COLLAPSE (the user's "plural properties should be collapsible") ──────────
  // The header is the app's shared accordion (.cat-header/.cat-title), and it
  // SAYS what it is hiding, so a folded row is not a mystery box.
  ok(await headerText() === "4 points", `the collapse header states the count (got ${JSON.stringify(await headerText())})`);
  ok(JSON.stringify(await headerState()) === '{"expanded":"true","disabled":false,"icon":"mdi:chevron-down"}',
    `a list starts OPEN, with the accordion's own down-chevron (${JSON.stringify(await headerState())})`);
  {
    const before = await docJson();
    await clickHeader();
    await settle(120);
    ok(await rowCount() === 0, `folding renders NO element rows (${await rowCount()})`);
    ok(await page.evaluate(() => document.querySelectorAll(".listfield .list-insert").length) === 0,
      "and no insert seams — the whole body is folded, not just the rows");
    ok(await headerText() === "4 points", "the folded header still states the count");
    ok(JSON.stringify(await headerState()) === '{"expanded":"false","disabled":false,"icon":"mdi:chevron-right"}',
      `folded: aria-expanded false and the right-chevron (${JSON.stringify(await headerState())})`);
    ok(await docJson() === before,
      "COLLAPSE IS VIEW STATE: the document is byte-identical (it neither keyframes nor makes an undo entry)");
    ok((await collapseSetting()).points === true,
      `the fold persists as a BROWSER setting keyed by the PROPERTY, not the item (${JSON.stringify(await collapseSetting())})`);
    await shotOfList("polygon_points_folded");
  }
  // Keyed by the property, so it survives selecting something else and coming back
  // — the Inspector accordion's own "stays collapsed as you switch selections".
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await settle(150);
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, polyId);
  await settle(250);
  ok(await rowCount() === 0, "the fold survives deselecting and reselecting the item");
  await clickHeader();
  await settle(150);
  ok(await rowCount() === 4, `unfolding brings every row back (${await rowCount()})`);
  ok((await collapseSetting()).points === false, "unfolding persists too");

  // ── THE SHARED SEAM, tested WITHOUT any picker ──────────────────────────────
  // A staged WHOLE-LIST preview folds the list whoever staged it — which is how a
  // ToolsPane plugin preset carrying a list-valued prop gets this for free (its
  // previewPreset stages exactly this shape: [["items", id, key], value]). No
  // shipped preset declares one today, so the flicker does not exist there yet;
  // this proves it cannot appear when one does.
  await page.evaluate((id) => {
    window.__powerrp_app.setPreview([[["items", id, "points"], [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]]]);
  }, polyId);
  await settle(200);
  ok(await rowCount() === 0, `a WHOLE-LIST preview staged by anything folds the list (${await rowCount()} rows)`);
  ok(await headerText() === "5 points", "and the folded header reports the PREVIEWED list, like every other control does");
  await page.evaluate(() => window.__powerrp_app.cancelPreview());
  await settle(200);
  ok(await rowCount() === 4, "cancelling the preview restores the user's own open list");

  // THE CONVERSE, which matters more: the user's OWN per-element edit must NOT
  // fold the row being dragged. A field scrub stages a sparse numeric-keyed
  // OBJECT under the list path, not an array — that is the whole basis of the
  // distinction, so it is measured rather than assumed.
  await page.evaluate((id) => {
    window.__powerrp_app.setPreview([[["items", id, "points", 1, 0], 0.75]]);
  }, polyId);
  await settle(200);
  ok(await rowCount() === 4, `scrubbing ONE element's field leaves the list OPEN (${await rowCount()} rows) — folding the row under the pointer would be worse than the flicker`);
  ok(await page.evaluate((id) => !Array.isArray(window.__powerrp_app.previewDelta.items[id].points), polyId),
    "…because that preview stages a sparse per-index patch, not a whole-list array");
  await page.evaluate(() => window.__powerrp_app.cancelPreview());
  await settle(150);

  // INSERT BETWEEN vertices 1 and 2 → the midpoint of the edge it splits.
  await oneUndoUnit("polygon insert-between", () => clickInsert(1));
  {
    const pts = await stateAt(polyId, ["points"]);
    ok(pts.length === 5, `insert-between added one vertex (4 → ${pts.length})`);
    ok(JSON.stringify(pts[1]) === "[0.5,0]", `the new vertex is the INTERPOLATED midpoint of [0,0] and [1,0] (got ${JSON.stringify(pts[1])})`);
    ok(JSON.stringify(pts[2]) === "[1,0]", "the displaced vertex is intact, one index later");
    ok(await stateAt(polyId, ["pointsActive"]) === null, "an insert into a list that never hid anything mints NO visibility companion");
  }

  // HIDE the inserted vertex: the list must not move, and the outline must close
  // straight over it.
  await oneUndoUnit("polygon hide", () => clickInRow(1, ".boolfield .boolbtn"));
  {
    const pts = await stateAt(polyId, ["points"]);
    ok(JSON.stringify(pts[1]) === "[0.5,0]" && pts.length === 5, "HIDE: the element LIST is byte-identical — nothing was renumbered");
    const active = await stateAt(polyId, ["pointsActive"]);
    ok(Array.isArray(active) && active.length === 5 && active[1] === false && active[0] === true,
      `HIDE wrote the FULL companion ARRAY, the same shape the canvas handle toolbar writes (${JSON.stringify(active)})`);
    const drawn = await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const node = app.nodes().find((n) => n.itemId === id);
      return JSON.stringify(node.plugin.emit(node.state));
    }, polyId);
    ok((drawn.match(/L/g) ?? []).length === 3, `HIDE: the emitted outline has 4 vertices (M + 3 L) — the chain closed over the hidden one (${drawn.slice(0, 110)})`);
    ok(await page.evaluate(() => !!document.querySelectorAll(".listfield .list-el")[1].className.match(/list-el-hidden/)),
      "the hidden element's row reads as hidden");
    ok(await page.evaluate((id) => window.__powerrp_app.nodes().find((n) => n.itemId === id).plugin.modifierPoints(window.__powerrp_app.nodes().find((n) => n.itemId === id).state).length, polyId) === 5,
      "every STORED vertex still has a canvas handle — a hidden vertex must be showable again");
    // The eyes are invisible once folded, so the summary must carry the hidden
    // count — otherwise folding would hide a real state.
    ok(await headerText() === "5 points, 1 hidden", `the header counts the HIDDEN elements too (got ${JSON.stringify(await headerText())})`);
  }

  // PER-ELEMENT `=`: type an equation into vertex 3's x through its OWN field.
  // It must REFERENCE something (self.w, the polygon's own 300-unit width): the
  // field's documented symmetric rule is that a reference-FREE expression commits
  // as a plain number ("6*7" → 42), so only a referencing one proves the slot
  // really stores and evaluates an equation.
  {
    const before = await docJson();
    await page.evaluate(() => {
      const row = document.querySelectorAll(".listfield .list-el")[2];
      row.querySelectorAll(".list-field")[0].querySelector(".numfield .eq-open").click();
    });
    await settle(80);
    await page.evaluate(() => document.querySelector(".listfield .list-el .numfield .eq-input")?.focus());
    await page.keyboard.type("self.w / 1200");
    await page.keyboard.press("Enter");
    await settle(250);
    // NO leading "=" is expected in storage: a NUMERIC slot's equation IS a string
    // (the pre-any-type engine's form, which NumericField still writes — its header:
    // "a leading '=' is tolerated and stripped"). core accepts both spellings
    // (isEquationValue recognizes the marker too), so what proves the slot is an
    // equation is that it stores a STRING expression and core resolved it.
    const raw = await rawAt(polyId, ["points", 2, 0]);
    ok(typeof raw === "string" && /1200/.test(raw), `per-element \`=\`: the RAW slot stores the expression (got ${JSON.stringify(raw)})`);
    ok(await stateAt(polyId, ["points", 2, 0]) === 0.25, `per-element \`=\`: it is EVALUATED (300 / 1200; got ${await stateAt(polyId, ["points", 2, 0])})`);
    const after = await docJson();
    await page.evaluate(() => window.__powerrp_app.undo());
    await settle(80);
    ok(await docJson() === before, "per-element `=`: EXACTLY ONE undo unit (JSON compare)");
    await page.evaluate(() => window.__powerrp_app.redo());
    await settle(80);
    ok(await docJson() === after, "per-element `=`: redo restores it");
  }

  // PURGE: the destructive half — it splices AND renumbers (which is why it is a
  // different button from hide, in the danger colour, saying so in its tooltip).
  {
    const before = await stateAt(polyId, ["points"]);
    await oneUndoUnit("polygon purge", () => clickInRow(1, ".list-purge"));
    const after = await stateAt(polyId, ["points"]);
    ok(after.length === before.length - 1, `PURGE spliced the element out (${before.length} → ${after.length})`);
    ok(JSON.stringify(after[1]) === JSON.stringify(before[2]), "PURGE RENUMBERS: what was element 3 is now element 2");
    const active = await stateAt(polyId, ["pointsActive"]);
    ok(Array.isArray(active) && active.length === after.length && active.every((a) => a !== false),
      `PURGE spliced the companion in step with the list (${JSON.stringify(active)})`);
  }

  // ── Scenario 2: THE GRADIENT'S `stops` (sorted / record) through PaintField ─
  const THREE = [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 1, color: "#0000ff" }];
  const TWO = [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }];
  const setStops = (id, stops) => page.evaluate((id, stops) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill"], { type: "linearGradient", solid: "#ff0000", linear: { stops, angle: 0 }, radial: { stops, center: { x: 0.5, y: 0.5 }, r: 0.5 } }]]);
    app.commitPreview();
  }, id, stops);

  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get("rect").defaults);
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], 760], [["items", id, "y"], 260],
      [["items", id, "w"], 320], [["items", id, "h"], 200],
      [["items", id, "strokeWidth"], 0],
    ]);
    app.commitPreview();
    return id;
  });
  await setStops(rectId, THREE);
  await settle(300);

  ok(await rowCount() === 3, `the gradient's stops render through the SAME list control (${await rowCount()} rows)`);
  ok(await page.evaluate(() => JSON.stringify([...document.querySelectorAll(".listfield .list-el")[0].querySelectorAll(".list-field-label")].map((e) => e.textContent))) === '["offset","color"]',
    "a stop shows its declared fields (offset, color) — the record element's own names");
  ok(await page.evaluate(() => document.querySelectorAll(".listfield .list-el .colorfield").length) === 3,
    "each stop's colour is the app's standard ColorField (no bespoke hex input)");
  ok(await page.evaluate(() => !document.querySelectorAll(".listfield .list-el")[0].querySelector(".list-purge").disabled),
    "with 3 stops (above the declared minimum of 2) purge is available");
  await shotOfList("gradient_stops_list");

  // INSERT BETWEEN two stops → the average position and the BLENDED colour.
  await oneUndoUnit("gradient insert-between", () => clickInsert(1));
  {
    const stops = await stateAt(rectId, ["fill", "linear", "stops"]);
    ok(stops.length === 4, `insert-between added one stop (3 → ${stops.length})`);
    ok(stops[1].offset === 0.25, `the new stop takes the AVERAGE position of its neighbours (got ${stops[1].offset})`);
    ok(stops[1].color === "#808000", `and their BLENDED colour (red→green midpoint; got ${stops[1].color})`);
    ok(stops.map((s) => s.offset).every((o, i, a) => i === 0 || a[i - 1] <= o), `the list stayed CANONICALLY ORDERED (${JSON.stringify(stops.map((s) => s.offset))})`);
    await page.evaluate(() => window.__powerrp_app.undo());
    await settle(120);
  }

  // PURGE honours the declared minLength LOUDLY: at two stops every X is disabled
  // and says why, where the old bespoke "×" silently did nothing.
  await setStops(rectId, TWO);
  await settle(250);
  ok(await rowCount() === 2, "two stops");
  ok(await page.evaluate(() => [...document.querySelectorAll(".listfield .list-purge")].every((b) => b.disabled)),
    "at the declared minLength every PURGE button is DISABLED (never a silent no-op)");
  // HIDE carries the SAME floor, for the same reason: the consumer reads the
  // VISIBLE elements, so hiding one of two stops would hand the renderer one stop,
  // which normalizeStops rejects — a thrown paint every frame. Gated, with the
  // reason in the tooltip, rather than allowed and then crashing.
  ok(await page.evaluate(() => [...document.querySelectorAll(".listfield .list-el .boolfield .boolbtn")].every((b) => b.disabled)),
    "at the declared minLength HIDE is gated too (hiding below the floor would starve the renderer)");
  ok(await page.evaluate(() => {
    const b = document.querySelector(".listfield .list-purge");
    const anchor = b.closest(".tt-anchor");
    b.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    anchor?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    return true;
  }), "hover the disabled purge to read its reason");
  await settle(150);
  {
    const tip = await page.evaluate(() => document.querySelector(".tt-tip")?.textContent ?? "");
    ok(/^Purge/.test(tip), `the purge tooltip LEADS WITH THE WORD "Purge" (the item-level register): ${JSON.stringify(tip.slice(0, 80))}`);
    // Matches the NUMBER, not the phrasing around it. This used to require the
    // literal "minimum of 2", which pinned prose rather than the assertion's
    // actual subject — the tooltip brevity sweep reworded it to "needs at least
    // 2 entries", identical in meaning, and the check failed on style alone.
    ok(/at least 2 entr/.test(tip), `and names the declared floor as the reason: ${JSON.stringify(tip.slice(0, 120))}`);
  }

  // ── PIXEL PROOF: a HIDDEN stop == never having authored it ──────────────────
  // Deselect first, so no selection overlay lands inside the compared clip.
  const clipOf = () => page.evaluate(() => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(760, 260);
    const e = app.canvasActions.worldToScreen(760 + 320, 260 + 200);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    // Inset by two pixels on every side so an antialiased edge cannot decide the
    // compare, then INTERSECT with the canvas itself: part of the widget may sit
    // outside the viewport, and a clip that spilled onto the panel chrome would
    // photograph static pixels that dilute what the compare is about.
    const box = { x0: Math.round(rect.left + s.x) + 2, y0: Math.round(rect.top + s.y) + 2, x1: Math.round(rect.left + e.x) - 2, y1: Math.round(rect.top + e.y) - 2 };
    const c = document.querySelector("canvas").getBoundingClientRect();
    const x0 = Math.max(box.x0, Math.ceil(c.left)), y0 = Math.max(box.y0, Math.ceil(c.top));
    const x1 = Math.min(box.x1, Math.floor(c.right)), y1 = Math.min(box.y1, Math.floor(c.bottom));
    if (!(x1 > x0 && y1 > y0)) throw new Error("the gradient rect is not visible on the canvas — nothing to compare");
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  });
  const shoot = async (name) => {
    const clip = await clipOf();
    const buf = await page.screenshot({ clip });
    await writeFile(resolve(shots, `${name}.png`), buf);
    return buf;
  };
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await settle(250);
  const twoStopShot = await shoot("gradient_two_stops_authored");
  await setStops(rectId, THREE);
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await settle(300);
  const threeStopShot = await shoot("gradient_three_stops");
  // Hide the middle stop THROUGH THE UI (select → the row's eye), then deselect.
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
  await settle(250);
  ok(await rowCount() === 3, "three stops are listed again before hiding one");
  await clickInRow(1, ".boolfield .boolbtn");
  await settle(200);
  {
    const active = await stateAt(rectId, ["fill", "linear", "stopsActive"]);
    ok(Array.isArray(active) && active[1] === false && active.length === 3,
      `HIDE wrote the gradient's own companion, in full-array form (${JSON.stringify(active)})`);
    const stops = await stateAt(rectId, ["fill", "linear", "stops"]);
    ok(stops.length === 3 && stops[1].offset === 0.5, "HIDE: the stop is still STORED (it can come back on another slide)");
    const rendered = await jsonEval((id) => {
      const app = window.__powerrp_app;
      const node = app.nodes().find((n) => n.itemId === id);
      return JSON.stringify(node.plugin.emit(node.state)[0].fill.stops.map((s) => s.offset));
    }, rectId);
    ok(JSON.stringify(rendered) === "[0,1]", `the RAMP the renderer sees spans only the SURVIVING neighbours (${JSON.stringify(rendered)})`);
  }
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await settle(300);
  const hiddenShot = await shoot("gradient_three_stops_middle_hidden");
  ok(!threeStopShot.equals(twoStopShot), "the compare is NOT vacuous: 3 stops and 2 stops render DIFFERENTLY");
  ok(hiddenShot.equals(twoStopShot), `PIXEL PROOF: hiding the middle stop renders EXACTLY the hand-authored 2-stop gradient (${hiddenShot.length} vs ${twoStopShot.length} bytes)`);

  // ── Scenario 3: THE PRESET-LIBRARY FLICKER, COUNTED ────────────────────────
  // Hovering a preset swatch live-previews it, which REWRITES THE WHOLE STOP LIST.
  // Pre-fix that re-rendered every row on every pointerenter, and a preset with a
  // different stop count resized the list under the cursor: 768 DOM mutations and
  // 13 height changes over 14 swatches (2 rows ⇄ 12), which is the user's
  // "otherwise it flickers like crazy". Opening the library now folds the list, so
  // the same sweep must produce ZERO row churn — while every swatch still previews.
  const FIVE = [
    { offset: 0, color: "#ff0000" }, { offset: 0.25, color: "#ffff00" }, { offset: 0.5, color: "#00ff00" },
    { offset: 0.75, color: "#00ffff" }, { offset: 1, color: "#0000ff" },
  ];
  /** How many swatches the counted sweep visits. Matched to the pre-fix
   *  measurement so the before/after numbers are comparable. */
  const SWEEP_COUNT = 14;
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
  await settle(250);
  await page.evaluate((id, stops) => {
    const app = window.__powerrp_app;
    app.setPreview([
      [["items", id, "fill"], { type: "linearGradient", solid: "#ff0000", linear: { stops, angle: 0 }, radial: { stops, center: { x: 0.5, y: 0.5 }, r: 0.5 } }],
      // Clear the hide from the pixel proof above, so the sweep starts from a list
      // with nothing hidden and the summary is about the count alone.
      [["items", id, "fill", "linear", "stopsActive"], stops.map(() => true)],
    ]);
    app.commitPreview();
  }, rectId, FIVE);
  await settle(350);
  ok(await rowCount() === 5 && await headerText() === "5 stops", `a five-stop gradient lists five rows (${await headerText()})`);

  // PRESETS ON TOP (the user's third ask): the library precedes the stop list in
  // document order, so a swatch cannot move when the list below it resizes.
  ok(await page.evaluate(() => {
    const presets = document.querySelector(".gradient-presets");
    const list = document.querySelector(".listfield");
    // DOCUMENT_POSITION_FOLLOWING (4) = the list comes AFTER the preset library.
    return !!(presets.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), "the PRESET LIBRARY sits ABOVE the stop list, not below it");
  await shotOfList("gradient_presets_above_stops");

  // Opening the library folds the list — on the CLICK, not on the first hover.
  await page.evaluate(() => {
    document.querySelector(".gradient-presets-toggle").scrollIntoView({ block: "center" });
    document.querySelector(".gradient-presets-toggle").click();
  });
  await settle(400);
  ok(await rowCount() === 0, `opening the preset library FOLDS the stop list (${await rowCount()} rows)`);
  ok(await headerText() === "5 stops", "and the folded header still says what is in it");
  {
    const h = await headerState();
    ok(h.disabled === true && h.expanded === "false",
      `while the library holds it folded the header REFUSES rather than lying about a toggle it does not own (${JSON.stringify(h)})`);
  }
  ok(await page.evaluate(() => {
    const h = document.querySelector(".listfield .cat-header");
    h.closest(".tt-anchor")?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    return true;
  }), "hover the refusing header to read its reason");
  await settle(150);
  {
    const tip = await page.evaluate(() => document.querySelector(".tt-tip")?.textContent ?? "");
    ok(/previews the whole list/.test(tip) && /reopens to your own setting/.test(tip),
      `the refusing header NAMES the reason and promises the user's own setting back: ${JSON.stringify(tip.slice(0, 140))}`);
  }
  await shotOfList("gradient_library_open_list_folded");
  // Dismiss that tooltip before measuring. Tooltip renders .tt-tip as a SIBLING of
  // its anchor, so an open bubble sits inside .listfield and its text tracks the
  // summary — real churn, but churn this probe caused by parking a synthetic
  // pointer on the header. A user sweeping the grid has no tip open.
  await page.evaluate(() => {
    document.querySelector(".listfield .cat-header").closest(".tt-anchor")
      ?.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
  });
  await settle(200);
  ok(await page.evaluate(() => !document.querySelector(".listfield .tt-tip")), "the header's tooltip is dismissed before the sweep is counted");

  // THE SWEEP. Alternating few-stop and many-stop presets, so every hover would
  // have changed the list's height pre-fix; the library's first tiles are all
  // 2-stop gradients and would measure almost nothing. A stop count is readable
  // off the tile: `data-ramp-stops` states the preset's REAL stop count (its CSS
  // gradient does NOT, for a looping or OKLab preset — see cssRampSwatch).
  const sweepOrder = await jsonEval((n) => {
    const counted = [...document.querySelectorAll(".gradient-swatch")].map((s, i) => ({
      i, stops: Number(s.dataset.rampStops),
    }));
    const few = counted.filter((c) => c.stops <= 2).map((c) => c.i);
    const many = counted.filter((c) => c.stops >= 4).map((c) => c.i);
    const out = [];
    for (let k = 0; out.length < n && (k < few.length || k < many.length); k++) {
      if (k < few.length) out.push(few[k]);
      if (out.length < n && k < many.length) out.push(many[k]);
    }
    return JSON.stringify(out);
  }, SWEEP_COUNT);
  ok(sweepOrder.length === SWEEP_COUNT, `the sweep visits ${SWEEP_COUNT} presets of alternating stop counts (${sweepOrder.length})`);
  // Mutations are classified by WHERE they land. The list's BODY (rows + insert
  // seams) is what flickered and must go completely still; the folded HEADER's own
  // count text is expected to keep tracking the preview, because this control
  // renders from app.state() — which blends it — exactly as the viewport and every
  // other field do. That is feedback ("this preset has 12 stops"), not flicker, and
  // it cannot move anything: .cat-header's height is a fixed token, asserted below.
  await page.evaluate(() => {
    window.__listChurn = { body: 0, header: 0, bodyLog: [], rowCounts: [], heights: [], headerHeights: [], previews: 0, swatchMoves: 0 };
    const list = document.querySelector(".listfield");
    // The HEADER ROW is the collapse button plus the Tooltip anchor wrapped around
    // it (whose own tip text tracks the summary): one region, so its churn is
    // counted as the header's rather than leaking into the body's tally.
    const headerRow = list.querySelector(".cat-header").closest(".tt-anchor") ?? list.querySelector(".cat-header");
    window.__listObs = new MutationObserver((recs) => {
      const c = window.__listChurn;
      for (const r of recs) {
        const el = r.target.nodeType === Node.ELEMENT_NODE ? r.target : r.target.parentElement;
        if (el && headerRow.contains(el)) c.header++;
        else {
          c.body++;
          if (c.bodyLog.length < 4) c.bodyLog.push(`${r.type} on ${el?.tagName}.${el?.className} (${r.attributeName ?? ""})`);
        }
      }
    });
    window.__listObs.observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  for (const index of sweepOrder) {
    // Scroll the tile into view and read its position AFTER that scroll, so the
    // before/after pair brackets the HOVER alone — the probe's own scrolling must
    // not be counted as the app moving the tile.
    const t = await jsonEval((i) => {
      const s = document.querySelectorAll(".gradient-swatch")[i];
      s.scrollIntoView({ block: "nearest" });
      const r = s.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: Math.round(r.top) });
    }, index);
    await page.mouse.move(t.x, t.y);
    await settle(140);
    await page.evaluate((i, id, before) => {
      const app = window.__powerrp_app;
      const c = window.__listChurn;
      const s = document.querySelectorAll(".gradient-swatch")[i];
      const list = document.querySelector(".listfield");
      c.rowCounts.push(document.querySelectorAll(".listfield .list-el").length);
      c.heights.push(Math.round(list.getBoundingClientRect().height));
      c.headerHeights.push(Math.round(list.querySelector(".cat-header").getBoundingClientRect().height));
      if (Math.round(s.getBoundingClientRect().top) !== before.top) c.swatchMoves++;
      // THE PREVIEW MUST STILL HAPPEN: folding the list must not break the very
      // thing the fold exists to make watchable. A staged whole-list ARRAY at the
      // stops path with the SWATCH's own stop count is the proof.
      const staged = app.previewDelta?.items?.[id]?.fill?.linear?.stops;
      // The swatch's OWN stop count, read from data-ramp-stops rather than counted
      // off its CSS gradient: for a looping or OKLab preset the swatch is a
      // RESAMPLE of the colours the ramp produces, not its authored stops, so the
      // CSS count is the sample count (web/GradientPresetPicker.svelte
      // cssRampSwatch). The attribute is the honest source.
      const want = Number(s.dataset.rampStops);
      if (staged && Object.keys(staged).length === want) c.previews++;
    }, index, rectId, t);
  }
  {
    const churn = await jsonEval(() => {
      const c = window.__listChurn;
      window.__listObs.disconnect();
      const steps = (a) => a.filter((v, i) => i > 0 && v !== a[i - 1]).length;
      return JSON.stringify({
        body: c.body, header: c.header, bodyLog: c.bodyLog, previews: c.previews, swatchMoves: c.swatchMoves,
        rowSteps: steps(c.rowCounts), heightSteps: steps(c.heights), headerHeightSteps: steps(c.headerHeights),
        rows: [...new Set(c.rowCounts)],
      });
    });
    console.log(`  sweep of ${SWEEP_COUNT} presets → ${JSON.stringify(churn)}`);
    ok(churn.previews === SWEEP_COUNT,
      `HOVER-PREVIEW STILL WORKS FOR EVERY PRESET while the list is folded (${churn.previews}/${SWEEP_COUNT} staged the swatch's own stop list)`);
    ok(churn.rowSteps === 0 && churn.rows.length === 1 && churn.rows[0] === 0,
      `ZERO row churn across the sweep — pre-fix the row count swung 2⇄12 on every hover (rowSteps ${churn.rowSteps}, counts ${JSON.stringify(churn.rows)})`);
    ok(churn.heightSteps === 0,
      `ZERO list-height changes across the sweep — pre-fix there were 13 of 13 (got ${churn.heightSteps})`);
    ok(churn.swatchMoves === 0,
      `the swatch being hovered never MOVED during its own hover (${churn.swatchMoves} of ${SWEEP_COUNT} moved)`);
    ok(churn.body === 0,
      `ZERO DOM mutations in the list's BODY across the sweep — pre-fix 768 (got ${churn.body}${churn.body ? `: ${JSON.stringify(churn.bodyLog)}` : ""})`);
    ok(churn.header > 0 && churn.headerHeightSteps === 0,
      `the folded header's count still TRACKS the preview (${churn.header} text updates) at a fixed height, so it informs without moving anything (${churn.headerHeightSteps} height changes)`);
  }

  // THE USER'S OWN CHOICE IS SEPARATE STATE: this list was OPEN before the library
  // opened, so closing the library must open it again.
  await page.keyboard.press("Escape");
  await settle(300);
  ok(await rowCount() === 5, `closing the library restores the list the user had OPEN (${await rowCount()} rows)`);
  ok((await headerState()).disabled === false, "and the header takes clicks again");

  // …and a list the user had FOLDED stays folded, rather than being reopened by
  // the library's own fold ending. Two states, never merged.
  await clickHeader();
  await settle(150);
  ok(await rowCount() === 0, "the user folds the stop list themselves");
  await page.evaluate(() => document.querySelector(".gradient-presets-toggle").click());
  await settle(300);
  ok(await rowCount() === 0, "opening the library over an already-folded list changes nothing visible");
  await page.keyboard.press("Escape");
  await settle(300);
  ok(await rowCount() === 0, "closing it leaves the user's OWN fold intact (suppression did not eat the preference)");
  ok((await collapseSetting())["fill.linear.stops"] === true,
    `the stop list's fold is keyed separately from the polygon's (${JSON.stringify(await collapseSetting())})`);
  await clickHeader();
  await settle(150);

  // PICKING a preset: one undo unit, and the list comes back showing the new stops.
  await page.evaluate(() => document.querySelector(".gradient-presets-toggle").click());
  await settle(300);
  await oneUndoUnit("gradient preset pick", async () => {
    await page.evaluate(() => document.querySelectorAll(".gradient-swatch")[0].click());
  });
  await settle(250);
  ok(await page.evaluate(() => !document.querySelector(".gradient-presets-body")), "picking a preset closes the library");
  ok(await rowCount() > 0, `and the stop list is showing the picked preset's stops again (${await rowCount()} rows)`);
  await shotOfList("gradient_after_preset_pick");

  // SINGULAR: a one-element list reads "1 point", not "1 points". Last, because it
  // leaves the polygon a ghost — nothing is rendered or compared after this.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.selection = id;
    app.setPreview([[["items", id, "points"], [[0, 0]]], [["items", id, "pointsActive"], [true]]]);
    app.commitPreview();
  }, polyId);
  await settle(300);
  ok(await headerText() === "1 point", `a one-element list is singular (got ${JSON.stringify(await headerText())})`);

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  console.log(`\nscreenshots → ${shots}`);
  if (errors.length) { console.error(`\nFAILURES:\n${errors.join("\n")}`); process.exit(1); }
  console.log(`\n${checks.length} list-UI checks passed`);
} finally {
  await browser.close();
  await server.close();
}
