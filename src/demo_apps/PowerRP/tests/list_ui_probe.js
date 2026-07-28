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

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
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
    ok(/minimum of 2/.test(tip), `and names the declared floor as the reason: ${JSON.stringify(tip.slice(0, 120))}`);
  }

  // ── PIXEL PROOF: a HIDDEN stop == never having authored it ──────────────────
  // Deselect first, so no selection overlay lands inside the compared clip.
  const canvasClip = { x: 760, y: 0, width: 0, height: 0 };
  const clipOf = () => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(760, 260);
    const e = app.canvasActions.worldToScreen(760 + 320, 260 + 200);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    // Inset by a pixel on every side so an antialiased edge cannot decide the compare.
    return {
      x: Math.round(rect.left + s.x) + 2, y: Math.round(rect.top + s.y) + 2,
      width: Math.round(e.x - s.x) - 4, height: Math.round(e.y - s.y) - 4,
    };
  }, rectId);
  const shoot = async (name) => {
    const clip = await clipOf();
    Object.assign(canvasClip, clip);
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

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  console.log(`\nscreenshots → ${shots}`);
  if (errors.length) { console.error(`\nFAILURES:\n${errors.join("\n")}`); process.exit(1); }
  console.log(`\n${checks.length} list-UI checks passed`);
} finally {
  await browser.close();
  await server.close();
}
